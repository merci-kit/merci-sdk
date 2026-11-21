// @ts-check
/**
 * @file The native Anthropic connector's own contract.
 * @version 0.22.0
 *
 * @description
 * What the fixtures cannot show directly: the stream opens eagerly but reports
 * a failed open on the first `next()`, the caller's abort becomes the SDK's
 * abort error, the models list keeps the SDK's `PagePromise` pagination, the
 * event rules drop/keep the right frames, and the shared HTTP layer's
 * `errorFactory` seam carries the Anthropic error surface without changing the
 * OpenAI default.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { CASES } from './aai-parity/cases.mjs';
import { startServer } from './aai-parity/server.mjs';
import { createAaiTransport } from '../lib/backends/transport/aai-client.mjs';
import { getJson, postJson, postStream } from '../lib/backends/transport/http.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { buildParameterMapForAai } from '../lib/messaging/unified-parameter.mjs';

/** A valid message body for the loopback cases. */
const BODY = { model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true };

/** @param {string} id @returns {any} */
function caseById(id) {
    const caseDef = CASES.find((candidate) => candidate.id === id);
    assert.ok(caseDef, `case ${id} exists`);
    return caseDef;
}

/**
 * A fetch answering a fixed queue of responses and recording every call.
 * @param {Array<Response>} responses
 * @returns {{fetch: typeof fetch, calls: Array<{url: string, init: any}>}}
 */
function queuedFetch(responses) {
    /** @type {Array<{url: string, init: any}>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        return responses[Math.min(calls.length - 1, responses.length - 1)];
    };
    return { fetch: fetchImpl, calls };
}

/** @param {unknown} body */
function jsonResponse(body) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** @param {Array<string>} frames */
function sseResponse(frames) {
    return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Adds the HTTP surface the transport needs but the fixture server omits.
 * @param {import('node:http').RequestListener} handler
 * @returns {Promise<{baseURL: string, close: () => Promise<void>}>}
 */
async function listen(handler) {
    const server = createServer(handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    return {
        baseURL: `http://127.0.0.1:${address.port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => { server.close(() => resolve(undefined)); });
        },
    };
}

// ── deferred open error + eager start ────────────────────────────────────────
test('connector: a failed open rejects on the first next(), not on stream()', async () => {
    const server = await startServer({ case: caseById('messages-http-401') });
    try {
        const transport = createAaiTransport({ apiKey: 'test-key', baseURL: server.baseURL });
        const stream = transport.messages.stream(BODY);
        assert.equal(typeof stream[Symbol.asyncIterator], 'function', 'stream() returned an async iterable');
        await assert.rejects(stream[Symbol.asyncIterator]().next(), (/** @type {any} */ error) => {
            assert.equal(error.name, 'Error');
            assert.equal(error.message, '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
            assert.equal(error.status, 401);
            assert.equal(error.type, 'authentication_error');
            assert.equal(error.requestID, 'req_oracle_401');
            assert.equal(error.errorCode, null);
            assert.equal(error.details, null);
            return true;
        });
        assert.equal(server.requests.length, 1, 'exactly one request');
    } finally {
        await server.close();
    }
});

test('connector: no unhandled rejection when a failed stream is never consumed', async () => {
    /** @type {Array<Promise<unknown>>} */
    const unhandled = [];
    /** @param {Promise<unknown>} reason */
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
        const server = await startServer({ case: caseById('messages-http-401') });
        try {
            const transport = createAaiTransport({ apiKey: 'test-key', baseURL: server.baseURL });
            transport.messages.stream(BODY);
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            assert.deepEqual(unhandled, [], 'the pending open rejection is handled');
        } finally {
            await server.close();
        }
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('connector: the request starts on call, before iteration', async () => {
    const server = await startServer({ case: { id: 'eager', kind: 'messages', mode: 'stream', response: { status: 200, headers: { 'content-type': 'text/event-stream' }, chunks: [], hang: true } } });
    try {
        const transport = createAaiTransport({ apiKey: 'test-key', baseURL: server.baseURL });
        const stream = transport.messages.stream(BODY);
        const deadline = Date.now() + 2_000;
        while (server.requests.length === 0 && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 5); });
        assert.equal(server.requests.length, 1, 'the server saw the request before any next()');
        assert.equal(server.requests[0].method, 'POST');
        assert.equal(server.requests[0].url, '/v1/messages');
        assert.ok(stream, 'the iterable is returned');
    } finally {
        await server.close();
    }
});

// ── abort ───────────────────────────────────────────────────────────────────
test('connector: a caller abort throws the SDK abort error shape', async () => {
    const server = await startServer({ case: caseById('messages-stream-abort') });
    try {
        const transport = createAaiTransport({ apiKey: 'test-key', baseURL: server.baseURL });
        const controller = new AbortController();
        /** @type {Array<any>} */
        const events = [];
        await assert.rejects(async () => {
            for await (const event of transport.messages.stream(BODY, { signal: controller.signal })) {
                events.push(event);
                if (event.type === 'content_block_delta') controller.abort();
            }
        }, (/** @type {any} */ error) => {
            assert.equal(error.name, 'Error', 'the SDK abort error is not an AbortError');
            assert.equal(error.message, 'Request was aborted.');
            assert.equal(error.status, undefined, 'no status');
            assert.equal(error.type, null);
            assert.equal(error.errorCode, null);
            assert.equal(error.details, null);
            return true;
        });
        assert.deepEqual(events.map((event) => event.type), ['message_start', 'content_block_start', 'content_block_delta']);
    } finally {
        await server.close();
    }
});

// ── models pagination ───────────────────────────────────────────────────────
test('connector: models.list() awaits one page and pages with after_id', async () => {
    const { fetch, calls } = queuedFetch([
        jsonResponse({ data: [{ id: 'model_a' }], has_more: true, first_id: 'model_a', last_id: 'model_a' }),
        jsonResponse({ data: [{ id: 'model_b' }], has_more: false, first_id: 'model_b', last_id: 'model_b' }),
    ]);
    const transport = createAaiTransport({ apiKey: 'k', baseURL: 'https://example.test', fetch });

    const page = await transport.models.list();
    assert.deepEqual(page.data, [{ id: 'model_a' }]);
    assert.equal(page.has_more, true);
    assert.equal(page.first_id, 'model_a');
    assert.equal(page.last_id, 'model_a');
    assert.equal(page.hasNextPage(), true);
    assert.equal(calls.length, 1, 'await fetched one page');
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get('authorization'), 'Bearer k');
    assert.equal(headers.get('anthropic-version'), '2026-10-21');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), null, 'a GET sends no content type');

    const next = await page.getNextPage();
    assert.deepEqual(next.data, [{ id: 'model_b' }]);
    assert.equal(next.hasNextPage(), false);
    assert.equal(calls[1].url, 'https://example.test/v1/models?after_id=model_a');
});

test('connector: getNextPage without a last_id is refused', async () => {
    const { fetch } = queuedFetch([
        jsonResponse({ data: [{ id: 'model_a' }], has_more: false, first_id: 'model_a', last_id: null }),
    ]);
    const transport = createAaiTransport({ apiKey: 'k', baseURL: 'https://example.test', fetch });
    const page = await transport.models.list();
    await assert.rejects(page.getNextPage(), /No next page expected/);
});

test('connector: iterating the page promise auto-paginates', async () => {
    const { fetch, calls } = queuedFetch([
        jsonResponse({ data: [{ id: 'model_a' }, { id: 'model_b' }], has_more: true, first_id: 'model_a', last_id: 'model_b' }),
        jsonResponse({ data: [{ id: 'model_c' }], has_more: true, first_id: 'model_c', last_id: 'model_c' }),
        jsonResponse({ data: [{ id: 'model_d' }], has_more: false, first_id: 'model_d', last_id: 'model_d' }),
    ]);
    const transport = createAaiTransport({ apiKey: 'k', baseURL: 'https://example.test', fetch });
    /** @type {Array<string>} */
    const ids = [];
    for await (const model of transport.models.list()) ids.push(String(model.id));
    assert.deepEqual(ids, ['model_a', 'model_b', 'model_c', 'model_d']);
    assert.deepEqual(calls.map((call) => call.url), [
        'https://example.test/v1/models',
        'https://example.test/v1/models?after_id=model_b',
        'https://example.test/v1/models?after_id=model_c',
    ]);
});

test('connector: an empty page stops even when has_more is true', async () => {
    const { fetch, calls } = queuedFetch([
        jsonResponse({ data: [], has_more: true, first_id: null, last_id: 'cursor' }),
    ]);
    const transport = createAaiTransport({ apiKey: 'k', baseURL: 'https://example.test', fetch });
    const page = await transport.models.list();
    assert.equal(page.hasNextPage(), false, 'an empty page has no next page');
    /** @type {Array<string>} */
    const ids = [];
    for await (const model of page) ids.push(String(model.id));
    assert.deepEqual(ids, []);
    assert.equal(calls.length, 1, 'no request after the empty page');
});

test('connector: a missing last_id stops pagination', async () => {
    const { fetch, calls } = queuedFetch([
        jsonResponse({ data: [{ id: 'model_a' }], has_more: true, first_id: 'model_a', last_id: null }),
    ]);
    const transport = createAaiTransport({ apiKey: 'k', baseURL: 'https://example.test', fetch });
    const page = await transport.models.list();
    assert.equal(page.hasNextPage(), false);
    assert.equal(calls.length, 1);
});

// ── event rules ─────────────────────────────────────────────────────────────
test('connector: unknown events pass through and an event-less frame is dropped', async () => {
    const { fetch } = queuedFetch([sseResponse([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"drop me"}}\n\n',
        'event: future_thing\ndata: {"type":"future_thing","novel":true}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])]);
    const transport = createAaiTransport({ apiKey: 'k', baseURL: 'https://example.test', fetch });
    /** @type {Array<any>} */
    const events = [];
    for await (const event of transport.messages.stream(BODY)) events.push(event);
    assert.deepEqual(events, [
        { type: 'message_start' },
        { type: 'future_thing', novel: true },
        { type: 'message_stop' },
    ]);
});

// ── adapter → transport body ────────────────────────────────────────────────
/** One tool, so the adapter's `_tools` → `input_schema` branch runs. */
const TOOLS = [{
    name: 'lookup',
    description: 'Look up a record.',
    parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
    },
}];

/**
 * The conversation the adapter normalizes: a system row, a user turn, an
 * assistant tool call and its result.
 */
const PREPARED_MESSAGES = [
    { role: 'system', content: 'You are a careful engineer.' },
    { role: 'user', content: 'Look up merci.' },
    {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"merci"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'user', content: 'Thanks.' },
];

/**
 * The maximal unified spec: every parameter `buildParameterMapForAai` translates,
 * so the adapter's passthrough, thinking, cache, tool and tool_choice branches
 * all run.
 * @type {import('../lib/messaging/unified-parameter.mjs').UnifiedSpec}
 */
const MAXIMAL_SPEC = {
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    maxTokens: 2048,
    stop: ['END'],
    thinkingBudget: 1024,
    reasoningEffort: 'medium',
    metadata: { user_id: 'u1' },
    serviceTier: 'auto',
    cachePoints: 2,
    tools: TOOLS,
    toolChoice: 'auto',
    parallelToolCalls: false,
};

test('connector: the wire body is the adapter request byte for byte, and the session id is the only per-call header', async () => {
    const parameters = buildParameterMapForAai({ spec: structuredClone(MAXIMAL_SPEC) });
    // The session hands the adapter the last block of the cached prefix.
    parameters._cacheAnchor = { text: 'Look up merci.' };
    const { request } = aaiAdapter.buildVendorRequest({
        model: 'claude-sonnet-5-5',
        parameters,
        tools: structuredClone(TOOLS),
        preparedMessages: structuredClone(PREPARED_MESSAGES),
        session: {},
    });

    const server = await startServer({ case: {
        id: 'adapter-wire-body',
        kind: 'messages',
        mode: 'stream',
        response: {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            chunks: ['event: message_start\ndata: {"type":"message_start"}\n\n'],
        },
    } });
    try {
        const transport = createAaiTransport({ apiKey: 'test-key', baseURL: server.baseURL });
        /** @param {Record<string, string>|undefined} headers @returns {Promise<any>} */
        const send = async (headers) => {
            for await (const event of transport.messages.stream(request, headers ? { headers } : undefined)) {
                assert.equal(event.type, 'message_start', 'the fixed response yields its one event');
            }
            return server.requests.at(-1);
        };
        const plain = await send(undefined);
        const withSession = await send({ 'x-merci-session-id': 'run-1' });

        assert.equal(plain.url, '/v1/messages');
        assert.equal(plain.body, JSON.stringify(request), 'the wire body is the adapter request, byte for byte');
        assert.equal(withSession.body, JSON.stringify(request), 'and the per-call headers do not change it');
        // Self-calibrating: the only header the call options add is the session id,
        // so no other per-call header can ride along unnoticed.
        const added = Object.keys(withSession.headers).filter((name) => !(name in plain.headers));
        assert.deepEqual(added, ['x-merci-session-id']);
        assert.equal(withSession.headers['x-merci-session-id'], 'run-1');
    } finally {
        await server.close();
    }
});

// ── shared HTTP errorFactory ────────────────────────────────────────────────
test('http: a custom errorFactory sees status/headers/body/text and is thrown unchanged', async () => {
    const server = await listen((req, res) => {
        req.resume();
        if (req.headers['x-raw'] === '1') {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end('bad gateway');
            return;
        }
        res.writeHead(418, { 'content-type': 'application/json', 'request-id': 'req_custom' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'teapot', message: 'short and stout' } }));
    });
    try {
        const sentinel = new Error('sentinel');
        /** @type {Array<any>} */
        const seen = [];
        /** @param {any} args */
        const errorFactory = (args) => { seen.push(args); return sentinel; };

        await assert.rejects(getJson({ url: server.baseURL, errorFactory }), (error) => { assert.equal(error, sentinel); return true; });
        assert.equal(seen[0].status, 418);
        assert.equal(seen[0].headers.get('request-id'), 'req_custom');
        assert.deepEqual(seen[0].body, { type: 'error', error: { type: 'teapot', message: 'short and stout' } });
        assert.equal(seen[0].text, undefined, 'a parsed JSON body carries no text');

        await assert.rejects(getJson({ url: server.baseURL, headers: { 'x-raw': '1' }, errorFactory }), (error) => { assert.equal(error, sentinel); return true; });
        assert.equal(seen[1].status, 502);
        assert.equal(seen[1].body, undefined, 'an unparsed body carries no value');
        assert.equal(seen[1].text, 'bad gateway');

        await assert.rejects(postStream({ url: server.baseURL, body: {}, errorFactory }), (error) => { assert.equal(error, sentinel); return true; });
        assert.equal(seen[2].status, 418);
    } finally {
        await server.close();
    }
});

test('http: the default errorFactory stays the OpenAI surface', async () => {
    const server = await listen((req, res) => {
        req.resume();
        res.writeHead(418, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'teapot', message: 'short and stout' } }));
    });
    try {
        await assert.rejects(postJson({ url: server.baseURL, body: {} }), (/** @type {any} */ error) => {
            assert.equal(error.message, '418 short and stout');
            assert.equal(error.status, 418);
            assert.equal(error.type, 'teapot');
            assert.deepEqual(error.error, { type: 'teapot', message: 'short and stout' });
            return true;
        });
    } finally {
        await server.close();
    }
});
