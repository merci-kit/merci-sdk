// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import { InternalHttpClient, retryDelayMs } from '../lib/backends/jai-vendor/http-client.mjs';
import { ChatSession as VendorChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { ChatSession as AgenticChatSession } from '../lib/backends/jai.mjs';
import { SSEParser, readSSELines } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { SSEError } from '../lib/backends/jai-vendor/types.mjs';
import { TaskAPI } from '../lib/backends/jai-vendor/api.mjs';
import { ProfileManager } from '../lib/backends/jai-vendor/profiles.mjs';
import { BackendError } from '../lib/core/errors.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { ExponentialBackoffPolicy, NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';

/**
 * @param {{lines: string[]}} arg0
 */
function feed({ lines }) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const line of lines) yield line;
        },
    };
}

/**
 * @param {{predicate: () => boolean, timeoutMs?: number}} arg0
 */
async function waitFor({ predicate, timeoutMs = 3000 }) {
    const start = Date.now();
    while (!predicate() && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 20));
    }
    return predicate();
}

/** A local SSE server that writes one event then stalls forever. */
function stallServer() {
    const sockets = new Set();
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'Content', content: 'hello' })}\n`);
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return { server, sockets };
}

/**
 * @param {{server: import('node:http').Server}} arg0
 */
async function listen({ server }) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return /** @type {number} */ (/** @type {import('node:net').AddressInfo} */ (server.address()).port);
}

/**
 * @param {{server: import('node:http').Server, sockets: Set<any>}} arg0
 */
async function closeServer({ server, sockets }) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
}

// ─── J1: socket lifecycle ───────────────────────────────────────────────────

test('J1: a caller abort mid-stream closes the HTTP connection', async () => {
    const { server, sockets } = stallServer();
    const port = await listen({ server });
    try {
        const httpClient = new InternalHttpClient({ options: { token: 't', endpoint: `http://127.0.0.1:${port}`, streamTimeout: 5000 }, eventEmitter: new EventEmitter() });
        const session = new VendorChatSession({ httpClient, profile: 'm', profileManager: null });
        const ac = new AbortController();
        const events = /** @type {any[]} */ ([]);
        const consume = (async () => {
            try {
                for await (const e of session.stream({ initialInput: [{ type: 'user_message', content: 'hi' }], options: { signal: ac.signal } })) events.push(e);
            } catch { /* the caller abort is the expected end */ }
        })();
        assert.ok(await waitFor({ predicate: () => events.length > 0 }), 'the first SSE event must arrive before the abort');
        ac.abort(new Error('caller cancelled'));
        await consume;
        assert.ok(await waitFor({ predicate: () => sockets.size === 0 }), `the server socket must close after the abort (open: ${sockets.size})`);
    } finally {
        await closeServer({ server, sockets });
    }
});

test('J1: a stream-inactivity timeout closes the HTTP connection', async () => {
    const { server, sockets } = stallServer();
    const port = await listen({ server });
    try {
        const httpClient = new InternalHttpClient({ options: { token: 't', endpoint: `http://127.0.0.1:${port}`, streamTimeout: 200 }, eventEmitter: new EventEmitter() });
        const session = new VendorChatSession({ httpClient, profile: 'm', profileManager: null });
        const events = /** @type {any[]} */ ([]);
        for await (const e of session.stream({ initialInput: [{ type: 'user_message', content: 'hi' }] })) events.push(e);
        assert.ok(events.some((e) => e.type === 'error' && e.error_type === 'timeout'), 'the inactivity timeout is surfaced');
        assert.ok(await waitFor({ predicate: () => sockets.size === 0 }), `the server socket must close after the timeout (open: ${sockets.size})`);
    } finally {
        await closeServer({ server, sockets });
    }
});

// ─── J3: typed errors ───────────────────────────────────────────────────────

test('J3: a transport HTTP error is a BackendError with status/vendorCode/backend', async () => {
    const real = globalThis.fetch;
    try {
        globalThis.fetch = /** @type {any} */ (async () => ({
            ok: false,
            status: 429,
            headers: { get: /** @type {(...args: any[]) => any} */ ((name) => (name.toLowerCase() === 'retry-after' ? '0' : null)) },
            text: async () => JSON.stringify({ code: 'RATE_LIMITED', message: 'slow down' }),
        }));
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } }),
            (/** @type {any} */ err) => {
                assert.ok(err instanceof BackendError, `expected BackendError, got ${err?.name}`);
                assert.equal(err.status, 429);
                assert.equal(err.vendorCode, 'RATE_LIMITED');
                assert.equal(err.provider, ProviderType.JAI);
                assert.equal(err.code, 'MERCI-BACKEND-ERR');
                return true;
            },
        );
    } finally { globalThis.fetch = real; }
});

test('J3: SSEError stays in the JAI family and is a BackendError', () => {
    const err = new SSEError({ message: 'bad frame' });
    assert.ok(err instanceof BackendError);
    assert.equal(err.provider, ProviderType.JAI);
    assert.equal(err.status, undefined);
});

// ─── J4: one retry owner for 429/5xx ────────────────────────────────────────

test('J4: a 503 through a step retry policy has one retry owner (4 fetches)', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    try {
        globalThis.fetch = /** @type {any} */ (async () => {
            calls++;
            return {
                ok: false,
                status: 503,
                headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
                text: async () => JSON.stringify({ message: 'upstream down' }),
            };
        });
        const httpClient = new InternalHttpClient({ options: { token: 't', streamTimeout: 1000 }, eventEmitter: new EventEmitter() });
        const session = new AgenticChatSession({ httpClient, profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        session.withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }) });
        await assert.rejects(
            (async () => {
                for await (const _ of session.step({ messages: [createUserMessage({ provider: ProviderType.JAI, content: 'hi' })], options: {} })) { /* drain */ }
            })(),
            /status 503/,
        );
        assert.equal(calls, 4, 'transport owns 429/5xx: 1 initial + 3 retries, no step-policy multiplication');
    } finally { globalThis.fetch = real; }
});

// ─── J4 residual: no attempts × attempts multiply for UNMARKED classes ──────

/** A plain Node fetch network reset (ECONNRESET on the cause chain, no status). */
const resetError = () => {
    const err = new Error('fetch failed');
    /** @type {any} */ (err).cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return /** @type {any} */ (err);
};

test('J4r: a plain network reset is retried by ONE owner (3 fetches, not 9)', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    try {
        globalThis.fetch = /** @type {any} */ (async () => { calls++; throw resetError(); });
        const httpClient = new InternalHttpClient({ options: { token: 't', streamTimeout: 1000 }, eventEmitter: new EventEmitter() });
        const session = new AgenticChatSession({ httpClient, profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        session.withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }) });
        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: ProviderType.JAI, content: 'hi' })], opts: {} }),
            /fetch failed/,
        );
        assert.equal(calls, 3, 'step pre-delivery owns the window: 1 + 2 retries; the run-level loop must not multiply');
    } finally { globalThis.fetch = real; }
});

test('J4r: the transport-marked 503 stays at 4 fetches through runAgenticLoop', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    try {
        globalThis.fetch = /** @type {any} */ (async () => {
            calls++;
            return { ok: false, status: 503, headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'retry-after' ? '0' : null) }, text: async () => JSON.stringify({ message: 'upstream down' }) };
        });
        const httpClient = new InternalHttpClient({ options: { token: 't', streamTimeout: 1000 }, eventEmitter: new EventEmitter() });
        const session = new AgenticChatSession({ httpClient, profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        session.withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }) });
        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: ProviderType.JAI, content: 'hi' })], opts: {} }),
            /status 503/,
        );
        assert.equal(calls, 4, 'the transport owns 429/5xx and both upper loops honor its nonRetryable');
    } finally { globalThis.fetch = real; }
});

test('J4r: run-level retry still owns the failure when the step loop does not retry', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    try {
        globalThis.fetch = /** @type {any} */ (async () => { calls++; throw resetError(); });
        const httpClient = new InternalHttpClient({ options: { token: 't', streamTimeout: 1000 }, eventEmitter: new EventEmitter() });
        const session = new AgenticChatSession({ httpClient, profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        session.withRetryPolicy({ policy: new NoRetryPolicy() });
        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: ProviderType.JAI, content: 'hi' })], opts: {
                retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }),
            } }),
            /fetch failed/,
        );
        assert.equal(calls, 2, 'run-level owns when the step loop did not retry: 1 + 1');
    } finally { globalThis.fetch = real; }
});

// ─── J5: SSE resilience ─────────────────────────────────────────────────────

test('J5: a malformed frame is skipped, the stream keeps going', async () => {
    const events = /** @type {any[]} */ ([]);
    for await (const e of readSSELines({ stream: feed({ lines: [
        'data: {not json}\n',
        'data: {"type":"Content","content":"still here"}\n',
    ] }), parser: new SSEParser() })) events.push(e);
    assert.ok(events.some((e) => e.type === 'text' && e.content === 'still here'), 'the valid frame after the malformed one is delivered');
});

test('J5: `data: [DONE]` is a clean end, not a fatal parse error', async () => {
    const parser = new SSEParser();
    const events = /** @type {any[]} */ ([]);
    for await (const e of readSSELines({ stream: feed({ lines: [
        'data: {"type":"Content","content":"before"}\n',
        'data: [DONE]\n',
    ] }), parser })) events.push(e);
    assert.deepEqual(events.map((e) => e.type), ['text']);
    assert.equal(parser.parseLine({ line: 'data: [DONE]' }), null);
});

test('J5: a spec-legal multi-line data: event is concatenated', async () => {
    const events = /** @type {any[]} */ ([]);
    for await (const e of readSSELines({ stream: feed({ lines: [
        'data: {"type":"Content",\n',
        'data: "content":"split"}\n',
    ] }), parser: new SSEParser() })) events.push(e);
    const text = events.find((e) => e.type === 'text');
    assert.ok(text, `expected a text event, got ${JSON.stringify(events)}`);
    assert.equal(text.content, 'split');
});

test('J5: CRLF frames are tolerated', async () => {
    const events = /** @type {any[]} */ ([]);
    for await (const e of readSSELines({ stream: feed({ lines: [
        'data: {"type":"Content","content":"crlf"}\r\n',
        'data: end\r\n',
    ] }), parser: new SSEParser() })) events.push(e);
    assert.deepEqual(events.map((e) => e.content), ['crlf']);
});

test('J5: a malformed frame never masks a real stream error (partial tail stays raw)', async () => {
    const boom = Object.assign(new Error('network drop'), { name: 'AbortError' });
    const bad = {
        async *[Symbol.asyncIterator]() {
            yield 'data: {"type":"Content","content":"partial';
            throw boom;
        },
    };
    await assert.rejects(
        async () => { for await (const _ of readSSELines({ stream: bad, parser: new SSEParser() })) { /* drain */ } },
        (err) => err === boom,
    );
});

// ─── J6: TaskAPI signal + id validation ─────────────────────────────────────

test('J6: invalid task ids are rejected before any request is sent', async () => {
    let calls = 0;
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 1000,
        _fetchWithRetry: async () => {
            calls++;
            return { body: new ReadableStream({ start(c) { c.close(); } }) };
        },
    } });
    await assert.rejects(
        async () => { for await (const _ of api.stream({ id: '../../admin', parameters: {} })) { /* drain */ } },
        /Invalid task id/,
    );
    await assert.rejects(() => api.executeJson({ taskId: 'web-search/../quota', parameters: {} }), /Invalid task id/);
    assert.equal(calls, 0, 'an invalid id never reaches the wire');
});

test('J6: a caller signal aborts the task stream request', async () => {
    const ac = new AbortController();
    /** @type {any} */
    let seenOpts = null;
    let seenPath = null;
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 5000,
        /** @param {{path: *, options: *}} arg0 */
        _fetchWithRetry: async (/** @type {{ path: string, options: any }} */ { path, options }) => {
            seenPath = path;
            seenOpts = options;
            return {
                body: new ReadableStream({
                    start(c) {
                        const timer = setTimeout(() => c.close(), 300);
                        options.signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            c.error(options.signal.reason);
                        });
                    },
                }),
            };
        },
    } });
    const iterator = api.stream({ id: 'task-1:tag', parameters: {}, options: { signal: ac.signal } })[Symbol.asyncIterator]();
    const pending = iterator.next().catch(() => ({ done: true, value: undefined }));
    assert.equal(seenPath, '/task/stream/v5/task-1');
    assert.equal(seenOpts.headers['Grazie-Task-Tag'], 'tag');
    ac.abort(new Error('caller cancelled'));
    await pending;
    assert.equal(seenOpts.signal.aborted, true, 'the caller signal must reach the request controller');
});

// ─── J7: request-build purity ───────────────────────────────────────────────

test('J7: stream() never mutates session._parameters', async () => {
    const session = new VendorChatSession({
        httpClient: /** @type {any} */ ({
            streamTimeout: 1000,
            getEventEmitter: () => new EventEmitter(),
            _fetchWithRetry: async () => ({ body: new ReadableStream({ start(c) { c.close(); } }) }),
        }),
        profile: 'm',
        profileManager: /** @type {any} */ ({
            getProfiles: async () => ({}),
            /** @param {{_id: *, key: *}} arg0 */
            isSupported: ({ _id, key }) => key === 'toolConfig',
        }),
    });
    session.withTools({ tools: [{ name: 'search', description: 'd', parameters: { type: 'object', properties: {} } }] });
    session._parameters = /** @type {any} */ ({
        toolConfig: {
            tools: [{ name: 'search', description: 'd', parameters: { type: 'object', properties: {} } }],
            toolChoice: { named: 'search' },
            parallelToolCalls: true,
        },
    });
    const before = JSON.parse(JSON.stringify(session._parameters));
    for await (const _ of session.stream({ initialInput: [{ type: 'user_message', content: 'hi' }] })) { /* drain */ }
    assert.deepEqual(session._parameters, before, 'the request build must not mutate the session parameter tree');
});

// ─── J8: refresh single-flight ──────────────────────────────────────────────

test('J8: one waiter aborting does not cancel the shared refresh; success emits once', async () => {
    const real = globalThis.fetch;
    let refreshFetches = 0;
    try {
        globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
            if (String(url).includes('/auth/jwt/refresh/v3')) {
                refreshFetches++;
                await new Promise((r) => setTimeout(r, 50));
                return { ok: true, status: 200, json: async () => ({ token: 'fresh-token' }) };
            }
            return { ok: true, status: 200, headers: {}, body: new ReadableStream({ start(c) { c.close(); } }) };
        });
        const emitter = new EventEmitter();
        let successes = 0;
        emitter.on('token_refresh_success', () => { successes++; });
        const c = new InternalHttpClient({ options: { token: 'expired-token' }, eventEmitter: emitter });
        const ac = new AbortController();
        const aborting = c.refreshToken({ signal: ac.signal }).then(
            () => /** @type {any} */ ({ value: 'resolved' }),
            (error) => /** @type {any} */ ({ error }),
        );
        const waiting = c.refreshToken({ signal: new AbortController().signal });
        ac.abort(new Error('waiter gone'));
        const [r1, r2] = await Promise.all([aborting, waiting]);
        assert.ok(r1.error, 'the aborted waiter rejects');
        assert.equal(r2, 'fresh-token', 'the other waiter still receives the refreshed token');
        assert.equal(c.token, 'fresh-token');
        assert.equal(refreshFetches, 1, 'single-flight: exactly one refresh fetch');
        assert.equal(successes, 1, 'token_refresh_success is emitted once per refresh');
    } finally { globalThis.fetch = real; }
});

test('J8b: a successful token refresh is observable as api_request/api_response', async () => {
    const real = globalThis.fetch;
    try {
        globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
            if (String(url).includes('/auth/jwt/refresh/v3')) {
                return { ok: true, status: 200, headers: {}, json: async () => ({ token: 'fresh-token' }) };
            }
            return { ok: true, status: 200, headers: {}, body: new ReadableStream({ start(c) { c.close(); } }) };
        });
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const requests = [];
        /** @type {any[]} */
        const responses = [];
        /** @type {string[]} */
        const refresh = [];
        emitter.on('api_request', (m) => requests.push(m));
        emitter.on('api_response', (m) => responses.push(m));
        emitter.on('token_refresh_start', () => refresh.push('start'));
        emitter.on('token_refresh_success', () => refresh.push('success'));
        const c = new InternalHttpClient({ options: { token: 'expired-token' }, eventEmitter: emitter });
        await c.refreshToken({});
        const req = requests.find((r) => String(r.url).includes('/auth/jwt/refresh/v3'));
        const res = responses.find((r) => String(r.url).includes('/auth/jwt/refresh/v3'));
        assert.ok(req, 'the refresh round-trip emits api_request');
        assert.equal(req.method, 'POST');
        assert.equal(req.headers['Grazie-Authenticate-JWT'], '[REDACTED]', 'the JWT is redacted in refresh request telemetry');
        assert.ok(res, 'the refresh round-trip emits api_response');
        assert.equal(res.status, 200);
        assert.equal(res.ok, true);
        assert.deepEqual(refresh, ['start', 'success'], 'the token_refresh_* events are preserved');
    } finally { globalThis.fetch = real; }
});

// ─── J9: bounded buffers ────────────────────────────────────────────────────

test('J9: an unbounded SSE line is capped instead of buffered forever', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const source = {
        async *[Symbol.asyncIterator]() {
            yield `data: ${huge}`;
        },
    };
    await assert.rejects(
        async () => { for await (const _ of readSSELines({ stream: source, parser: new SSEParser() })) { /* drain */ } },
        /SSE line exceeds/,
    );
});

test('J9: the error body is read with a cap', async () => {
    const real = globalThis.fetch;
    try {
        const chunk = new Uint8Array(64 * 1024).fill(65);
        globalThis.fetch = /** @type {any} */ (async () => new Response(
            new ReadableStream({
                start(c) {
                    for (let i = 0; i < 64; i++) c.enqueue(chunk);
                    c.close();
                },
            }),
            { status: 500, headers: { 'Retry-After': '0' } },
        ));
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } }),
            (/** @type {any} */ err) => {
                const text = String(err?.details?.responseText ?? '');
                assert.ok(text.length <= 1024 * 1024 + 16, `error body must be capped, got ${text.length} chars`);
                return true;
            },
        );
    } finally { globalThis.fetch = real; }
});

// ─── W2A-2: a gateway redirect never forwards the credential ────────────────

test('W2A-2: a 307 on a gateway call is refused and never reaches the target', async () => {
    const real = globalThis.fetch;
    let targetHits = 0;
    const ATTACKER = 'https://attacker.test/collect';
    const JWT = 'Grazie-JWT-SECRET-VALUE';
    try {
        globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
            if (init?.redirect !== 'manual') {
                targetHits += 1;
                return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(null, { status: 307, headers: { location: `${ATTACKER}?q=1` } });
        });
        const c = new InternalHttpClient({ options: { token: JWT, endpoint: 'https://jai.example' }, eventEmitter: new EventEmitter() });
        const prompt = 'PROMPT-ONLY-IN-THE-BODY';
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: JSON.stringify({ chat: { messages: [{ type: 'user_message', content: prompt }] } }) } }),
            (/** @type {any} */ error) => {
                assert.equal(error.nonRetryable, true, 'a redirect is refused, not retried');
                assert.ok(String(error.message).includes(new URL(ATTACKER).origin), `the message names the target origin: ${error.message}`);
                assert.ok(!String(error.message).includes('/collect'), 'no target path in the message');
                assert.ok(!String(error.message).includes(prompt), 'no request body in the message');
                assert.ok(!String(error.message).includes(JWT), 'no JWT in the message');
                return true;
            },
        );
        assert.equal(targetHits, 0, 'the redirect target is never contacted');
    } finally { globalThis.fetch = real; }
});

test('W2A-2: a 307 on the token refresh is refused and never reaches the target', async () => {
    const real = globalThis.fetch;
    let targetHits = 0;
    const ATTACKER = 'https://attacker.test/refresh';
    const JWT = 'Grazie-JWT-SECRET-VALUE';
    try {
        globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ _url, /** @type {any} */ init) => {
            if (init?.redirect !== 'manual') {
                targetHits += 1;
                return new Response(JSON.stringify({ token: 'stolen' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(null, { status: 307, headers: { location: `${ATTACKER}?q=1` } });
        });
        const c = new InternalHttpClient({ options: { token: JWT, endpoint: 'https://jai.example' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c.refreshToken({}),
            (/** @type {any} */ error) => {
                assert.equal(error.nonRetryable, true, 'a redirect is refused, not retried');
                assert.ok(String(error.message).includes(new URL(ATTACKER).origin), `the message names the target origin: ${error.message}`);
                assert.ok(!String(error.message).includes('/refresh'), 'no target path in the message');
                assert.ok(!String(error.message).includes(JWT), 'no JWT in the message');
                return true;
            },
        );
        assert.equal(targetHits, 0, 'the redirect target is never contacted');
    } finally { globalThis.fetch = real; }
});

// ─── J10: retry delay clamp ─────────────────────────────────────────────────

test('J10: negative retry delays are clamped to zero', () => {
    assert.equal(retryDelayMs({ retryAfter: '-3', fallbackMs: 1000 }), 0);
    assert.equal(retryDelayMs({ retryAfter: null, fallbackMs: -1000 }), 0);
    assert.equal(retryDelayMs({ retryAfter: 'not-a-date', fallbackMs: -5 }), 0);
    assert.equal(retryDelayMs({ retryAfter: '2', fallbackMs: 1000 }), 2000, 'positive values are unchanged');
});

// ─── J11: tool-name fragments ───────────────────────────────────────────────

test('J11: tool-name fragments append instead of overwriting', () => {
    const appended = new SSEParser();
    appended.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"get_"}' });
    appended.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"weather"}' });
    appended.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call"}' });
    assert.equal(/** @type {any} */ (appended.getFinalResult().toolCalls[0]).name, 'get_weather');

    const replay = new SSEParser();
    replay.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"get_"}' });
    replay.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"get_wea"}' });
    replay.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call"}' });
    assert.equal(/** @type {any} */ (replay.getFinalResult().toolCalls[0]).name, 'get_wea', 'a cumulative replay only appends the delta');
});

// ─── J14: profiles thundering herd ──────────────────────────────────────────

test('J14: concurrent getProfiles() calls share one in-flight fetch', async () => {
    let calls = 0;
    const manager = new ProfileManager({ httpClient: {
        streamTimeout: 1000,
        _fetchWithRetry: async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 20));
            return { json: async () => ({ profiles: [{ id: 'm1', parameters: [] }] }) };
        },
    }, cacheTTL: 60_000 });
    const [a, b] = await Promise.all([manager.getProfiles(), manager.getProfiles()]);
    assert.equal(calls, 1, 'two concurrent callers must trigger one fetch');
    assert.equal(a, b, 'both callers receive the same cache object');
    assert.ok(/** @type {any} */ (a).m1);
});

test('J14: a failed in-flight fetch clears so the next call retries', async () => {
    let calls = 0;
    const manager = new ProfileManager({ httpClient: {
        streamTimeout: 1000,
        _fetchWithRetry: async () => {
            calls++;
            if (calls === 1) throw new Error('roster down');
            return { json: async () => ({ profiles: [{ id: 'm1', parameters: [] }] }) };
        },
    }, cacheTTL: 60_000 });
    await assert.rejects(() => manager.getProfiles(), /roster down/);
    const profiles = await manager.getProfiles();
    assert.equal(calls, 2, 'the failed in-flight must not be cached');
    assert.ok(/** @type {any} */ (profiles).m1);
});
