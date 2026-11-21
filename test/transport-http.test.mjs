// @ts-check
/**
 * @file Native OAI HTTP transport tests.
 * @version 0.22.0
 *
 * @description
 * The SDK's response decoding and error mapping against a loopback
 * `node:http` server: content-type matrix, status handling, header
 * precedence, connection/abort/timeout failures and the streaming gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';

import { buildHeaders, defaultRequestTimeoutMs, getJson, joinUrl, postJson, postStream } from '../lib/backends/transport/http.mjs';
import { createOaiTransport } from '../lib/backends/transport/oai-client.mjs';
import { iterateSseJson } from '../lib/backends/transport/sse.mjs';
import { isStreamIterable, nonJsonStreamError, readBodyPrefix, singleUse } from '../lib/backends/transport/stream.mjs';
import { SDK_VERSION } from '../lib/core/constants/index.mjs';
import { ConfigurationError, isAbortError } from '../lib/core/errors.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import { isNonRetryable } from '../lib/support/retry-policy.mjs';
import { isEmbeddingUnsupportedStatus } from '../lib/support/utils.mjs';

const encoder = new TextEncoder();

/**
 * Runs `run` against a loopback server and always tears it down.
 * @param {import('node:http').RequestListener} handler
 * @param {(arg0: {baseURL: string}) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    try {
        await run({ baseURL: `http://127.0.0.1:${address.port}` });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => { server.close(() => resolve(undefined)); });
    }
}

/**
 * Responds with a fixed status, content type and body.
 * @param {number} status
 * @param {string|null} contentType
 * @param {string} body
 * @returns {import('node:http').RequestListener}
 */
function respondWith(status, contentType, body) {
    return (req, res) => {
        req.resume();
        res.writeHead(status, contentType ? { 'content-type': contentType } : {});
        res.end(body);
    };
}

test('http: joinUrl keeps exactly one slash', () => {
    assert.equal(joinUrl({ baseURL: 'https://x/v1/', path: '/models' }), 'https://x/v1/models');
    assert.equal(joinUrl({ baseURL: 'https://x/v1///', path: '/models' }), 'https://x/v1/models');
});

test('http: joinUrl moves a base URL query after the path', () => {
    assert.equal(
        joinUrl({ baseURL: 'https://gw/openai?api-version=2024-10-21', path: '/chat/completions' }),
        'https://gw/openai/chat/completions?api-version=2024-10-21',
    );
    assert.equal(
        joinUrl({ baseURL: 'https://gw/openai/?api-version=2024-10-21', path: '/chat/completions' }),
        'https://gw/openai/chat/completions?api-version=2024-10-21',
    );
    assert.equal(
        joinUrl({ baseURL: 'https://gw/openai?api-version=1', path: '/v1/models' }),
        'https://gw/openai/v1/models?api-version=1',
    );
    assert.equal(
        joinUrl({ baseURL: 'https://gw/openai?api-version=1', path: '/models?limit=2' }),
        'https://gw/openai/models?limit=2&api-version=1',
    );
    assert.equal(joinUrl({ baseURL: 'https://gw', path: '/models' }), 'https://gw/models');
    assert.equal(joinUrl({ baseURL: 'https://gw/openai', path: '/models' }), 'https://gw/openai/models');
});

test('http: joinUrl drops a base URL fragment instead of placing the path inside it', () => {
    assert.equal(joinUrl({ baseURL: 'https://gw/openai#frag', path: '/models' }), 'https://gw/openai/models');
    assert.equal(
        joinUrl({ baseURL: 'https://gw/openai?api-version=1#frag', path: '/models' }),
        'https://gw/openai/models?api-version=1',
    );
});

test('http: joinUrl rejects a base URL that is not absolute, naming baseURL', () => {
    for (const baseURL of ['gw/openai', '/openai', 'openai?api-version=1']) {
        assert.throws(() => joinUrl({ baseURL, path: '/models' }), (/** @type {any} */ error) => {
            assert.ok(error instanceof ConfigurationError, `${baseURL}: a ConfigurationError`);
            assert.equal(error.option, 'baseURL');
            assert.match(error.message, /baseURL/);
            return true;
        });
    }
});

test('http: buildHeaders deletes a header whose value is null or undefined', () => {
    const headers = buildHeaders({
        apiKey: 'k',
        defaultHeaders: { 'User-Agent': null, Accept: undefined, 'x-a': 'default' },
        headers: { 'x-a': null, 'x-b': 'call' },
    });
    assert.equal(headers.get('user-agent'), null);
    assert.equal(headers.get('accept'), null);
    assert.equal(headers.get('x-a'), null);
    assert.equal(headers.get('x-b'), 'call');
    assert.equal(headers.get('authorization'), 'Bearer k');
    assert.equal(headers.get('content-type'), 'application/json');
});

test('http: buildHeaders orders auth, content type, accept, defaults, then call headers', () => {
    const headers = buildHeaders({ apiKey: 'k', defaultHeaders: { 'x-a': 'default', 'x-b': 'default' }, headers: { 'x-b': 'call' } });
    assert.equal(headers.get('authorization'), 'Bearer k');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('x-a'), 'default');
    assert.equal(headers.get('x-b'), 'call');
    assert.equal(headers.get('user-agent'), `merci-sdk/${SDK_VERSION}`);
});

test('http: buildHeaders omits auth and content type where asked to', () => {
    const headers = buildHeaders({ apiKey: '', json: false });
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('content-type'), null);
    assert.equal(headers.get('accept'), 'application/json');
});

test('http: buildHeaders an auth header replaces the bearer token', () => {
    const headers = buildHeaders({ apiKey: 'k', auth: { name: 'x-api-key', value: 'a' } });
    assert.equal(headers.get('authorization'), null, 'the bearer token is not sent alongside the vendor header');
    assert.equal(headers.get('x-api-key'), 'a');
});

test('http: buildHeaders accept: null omits the accept header', () => {
    const headers = buildHeaders({ accept: null });
    assert.equal(headers.get('accept'), null);
});

test('http: buildHeaders userAgent overrides the SDK-shaped agent', () => {
    const headers = buildHeaders({ userAgent: 'anthropic-sdk/1.5.0' });
    assert.equal(headers.get('user-agent'), 'anthropic-sdk/1.5.0');
});

test('http: buildHeaders merges sdkHeaders under defaults and per-call headers', () => {
    const headers = buildHeaders({
        sdkHeaders: { 'x-sdk': 'sdk', 'x-over': 'sdk', 'x-kept': 'sdk' },
        defaultHeaders: { 'x-over': 'default', 'x-sdk': 'default', 'x-default': 'default' },
        headers: { 'x-over': 'call', 'x-kept': null },
    });
    assert.equal(headers.get('x-sdk'), 'default', 'a default header overrides an sdk header');
    assert.equal(headers.get('x-over'), 'call', 'a per-call header overrides both');
    assert.equal(headers.get('x-default'), 'default');
    assert.equal(headers.get('x-kept'), null, 'a per-call null deletes an sdk header');
});

test('http: auth, accept, userAgent and sdkHeaders reach the wire', async () => {
    /** @type {Record<string, any>} */
    let seen = {};
    await withServer((req, res) => {
        seen = { ...req.headers };
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    }, async ({ baseURL }) => {
        await postJson({
            url: `${baseURL}/x`,
            apiKey: 'unused',
            auth: { name: 'x-api-key', value: 'a' },
            accept: null,
            userAgent: 'anthropic-sdk/1.5.0',
            sdkHeaders: { 'anthropic-version': '2023-06-01' },
            body: {},
        });
    });
    assert.equal(seen['authorization'], undefined, 'no bearer token on the vendor path');
    assert.equal(seen['x-api-key'], 'a');
    assert.notEqual(seen['accept'], 'application/json', 'accept: null is not replaced by ours');
    assert.equal(seen['user-agent'], 'anthropic-sdk/1.5.0');
    assert.equal(seen['anthropic-version'], '2023-06-01');
});

test('http: the default request timeout is the SDK value', () => {
    assert.equal(defaultRequestTimeoutMs(), 600_000);
});

test('http: application/json is parsed', async () => {
    await withServer(respondWith(200, 'application/json', '{"a":1}'), async ({ baseURL }) => {
        assert.deepEqual(await postJson({ url: `${baseURL}/x`, body: {} }), { a: 1 });
    });
});

test('http: a structured +json media type is parsed', async () => {
    await withServer(respondWith(200, 'application/vnd.api+json', '{"a":2}'), async ({ baseURL }) => {
        assert.deepEqual(await postJson({ url: `${baseURL}/x`, body: {} }), { a: 2 });
    });
});

test('http: a charset parameter does not hide the JSON media type', async () => {
    await withServer(respondWith(200, 'application/json; charset=utf-8', '{"a":3}'), async ({ baseURL }) => {
        assert.deepEqual(await postJson({ url: `${baseURL}/x`, body: {} }), { a: 3 });
    });
});

test('http: a non-JSON media type is returned as raw text', async () => {
    await withServer(respondWith(200, 'text/plain', 'hello'), async ({ baseURL }) => {
        assert.equal(await postJson({ url: `${baseURL}/x`, body: {} }), 'hello');
    });
});

test('http: a JSON body carries a non-enumerable _request_id', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_123' });
        res.end('{"a":1}');
    }, async ({ baseURL }) => {
        const body = /** @type {Record<string, any>} */ (await postJson({ url: `${baseURL}/x`, body: {} }));
        assert.equal(body._request_id, 'req_123');
        assert.deepEqual(Object.keys(body), ['a']);
        assert.equal(Object.getOwnPropertyDescriptor(body, '_request_id')?.enumerable, false);
    });
});

test('http: a parsed JSON array carries no _request_id', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_123' });
        res.end('[{"a":1}]');
    }, async ({ baseURL }) => {
        const body = await postJson({ url: `${baseURL}/x`, body: {} });
        assert.deepEqual(body, [{ a: 1 }]);
        assert.equal(Object.hasOwn(/** @type {object} */ (body), '_request_id'), false);
    });
});

test('http: 204 is null', async () => {
    await withServer((req, res) => { req.resume(); res.writeHead(204); res.end(); }, async ({ baseURL }) => {
        assert.equal(await postJson({ url: `${baseURL}/x`, body: {} }), null);
    });
});

test('http: an empty JSON body is undefined', async () => {
    await withServer(respondWith(200, 'application/json', ''), async ({ baseURL }) => {
        assert.equal(await postJson({ url: `${baseURL}/x`, body: {} }), undefined);
    });
});

test('http: content-length 0 on a JSON media type is undefined', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '0' });
        res.end();
    }, async ({ baseURL }) => {
        assert.equal(await postJson({ url: `${baseURL}/x`, body: {} }), undefined);
    });
});

test('http: an empty non-JSON body is an empty string', async () => {
    await withServer(respondWith(200, 'text/html', ''), async ({ baseURL }) => {
        assert.equal(await postJson({ url: `${baseURL}/x`, body: {} }), '');
    });
});

test('http: malformed JSON on a 200 throws the raw SyntaxError', async () => {
    await withServer(respondWith(200, 'application/json', '{"a":'), async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            assert.ok(error instanceof SyntaxError);
            return true;
        });
    });
});

test('http: a JSON error body keeps status, message and wire fields', async () => {
    await withServer(respondWith(400, 'application/json', '{"error":{"message":"bad input","code":"bad","type":"invalid_request_error","param":"model"}}'), async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            assert.equal(error.message, '400 bad input');
            assert.equal(error.status, 400);
            assert.equal(error.code, 'bad');
            assert.equal(error.type, 'invalid_request_error');
            assert.equal(error.param, 'model');
            assert.deepEqual(error.error, { message: 'bad input', code: 'bad', type: 'invalid_request_error', param: 'model' });
            assert.equal(error.name, 'Error');
            return true;
        });
    });
});

test('http: an HTML error body is kept verbatim and retry-after stays readable', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(404, { 'content-type': 'text/html', 'retry-after': '3' });
        res.end('<html><body>nope</body></html>');
    }, async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            assert.equal(error.message, '404 <html><body>nope</body></html>');
            assert.equal(error.status, 404);
            assert.equal(error.headers.get('retry-after'), '3');
            return true;
        });
    });
});

test('http: an empty error body names the status only', async () => {
    await withServer(respondWith(500, null, ''), async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            assert.equal(error.message, '500 status code (no body)');
            assert.equal(error.status, 500);
            return true;
        });
    });
});

/**
 * Fires one request at a fixed error response and hands the error to `check`.
 * @param {{status: number, contentType: string, body: string, headers?: Record<string, string>}} reply
 * @param {(error: any) => void} check
 * @returns {Promise<void>}
 */
async function expectError(reply, check) {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(reply.status, { 'content-type': reply.contentType, ...reply.headers });
        res.end(reply.body);
    }, async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            check(error);
            return true;
        });
    });
}

test('http: an error field without a message is its JSON', async () => {
    await expectError({ status: 400, contentType: 'application/json', body: '{"error":{"code":"c1","type":"t1"}}' }, (error) => {
        assert.equal(error.message, '400 {"code":"c1","type":"t1"}');
        assert.equal(error.code, 'c1');
        assert.equal(error.type, 't1');
        assert.deepEqual(error.error, { code: 'c1', type: 't1' });
    });
});

test('http: a body with no error key is wrapped as the error', async () => {
    await expectError({ status: 400, contentType: 'application/json', body: '{"code":"c1"}' }, (error) => {
        assert.equal(error.message, '400 {"code":"c1"}');
        assert.equal(error.code, 'c1');
        assert.deepEqual(error.error, { code: 'c1' });
    });
    await expectError({ status: 400, contentType: 'application/json', body: '{"message":"plain"}' }, (error) => {
        assert.equal(error.message, '400 plain');
    });
});

test('http: a string error field is quoted', async () => {
    await expectError({ status: 400, contentType: 'application/json', body: '{"error":"str"}' }, (error) => {
        assert.equal(error.message, '400 "str"');
        assert.equal(error.error, 'str');
    });
});

test('http: a JSON null error body is null', async () => {
    await expectError({ status: 400, contentType: 'application/json', body: 'null' }, (error) => {
        assert.equal(error.message, '400 null');
        assert.equal(error.error, undefined);
    });
});

test('http: the API error owns requestID when the header is present', async () => {
    await expectError({
        status: 401, contentType: 'application/json', body: '{"error":{"message":"bad key"}}', headers: { 'x-request-id': 'req_9' },
    }, (error) => {
        assert.equal(error.requestID, 'req_9');
        assert.equal(error.headers.get('x-request-id'), 'req_9');
    });
});

test('http: a refused connection is a connection error with its cause', async () => {
    const server = createServer();
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    await new Promise((resolve) => { server.close(() => resolve(undefined)); });
    await assert.rejects(postJson({ url: `http://127.0.0.1:${address.port}/x`, body: {} }), (/** @type {any} */ error) => {
        assert.equal(error.message, 'Connection error.');
        assert.ok(error.cause, 'the fetch failure must be preserved as the cause');
        return true;
    });
});

test('http: a pre-header abort is an abort error with the signal reason', async () => {
    await withServer(() => { /* never responds */ }, async ({ baseURL }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20);
        try {
            await assert.rejects(postJson({ url: `${baseURL}/x`, body: {}, signal: controller.signal }), (/** @type {any} */ error) => {
                assert.equal(error.message, 'Request was aborted.');
                assert.equal(error.name, 'AbortError');
                assert.equal(error.cause, controller.signal.reason);
                assert.equal(isAbortError({ err: error }), true);
                return true;
            });
        } finally {
            clearTimeout(timer);
        }
    });
});

test('http: a non-abort failure keeps its identity while the caller signal is aborted', async () => {
    const controller = new AbortController();
    /** @type {typeof fetch} */
    const fetchImpl = async () => {
        controller.abort();
        throw new SyntaxError('malformed body');
    };
    await assert.rejects(
        postJson({ url: 'http://127.0.0.1:1/x', body: {}, signal: controller.signal, fetchImpl }),
        (error) => {
            assert.ok(error instanceof SyntaxError, 'a non-abort failure must not become an abort error');
            assert.equal(error.message, 'malformed body');
            return true;
        }
    );
});

test('http: a first-headers timeout is a timeout error', async () => {
    await withServer(() => { /* never responds */ }, async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {}, timeoutMs: 30 }), (/** @type {any} */ error) => {
            assert.equal(error.message, 'Request timed out.');
            assert.equal(error.code, 'HEADER_TIMEOUT', 'typed so the retry classifier retries our own deadline');
            return true;
        });
    });
});

test('http: a non-positive or non-finite timeout uses the default deadline', async () => {
    await withServer((req, res) => {
        req.resume();
        setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        }, 40);
    }, async ({ baseURL }) => {
        for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.deepEqual(await postJson({ url: `${baseURL}/x`, body: {}, timeoutMs }), { ok: true });
        }
    });
});

test('http: a body that stalls after the headers is a timeout, not a hang', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"a":');
    }, async ({ baseURL }) => {
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {}, timeoutMs: 50 }), (/** @type {any} */ error) => {
            assert.equal(error.message, 'Request timed out.');
            return true;
        });
    });
});

test('http: a streaming call releases the deadline at the headers', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"a":');
    }, async ({ baseURL }) => {
        const response = await postStream({ url: `${baseURL}/x`, body: {}, timeoutMs: 50 });
        assert.ok(response.body, 'the stream is handed over once the headers arrive');
        await response.body.cancel();
    });
});

test('http: the default deadline follows setLimits at call time', async () => {
    await withServer(() => { /* never responds */ }, async ({ baseURL }) => {
        setLimits({ values: { oai_request_timeout_ms: 1_000 } });
        try {
            assert.equal(defaultRequestTimeoutMs(), 1_000);
            await assert.rejects(postJson({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
                assert.equal(error.message, 'Request timed out.');
                return true;
            });
        } finally {
            resetLimits();
        }
        assert.equal(defaultRequestTimeoutMs(), 600_000);
    });
});

test('http: default headers yield to per-call headers and no Stainless header is sent', async () => {
    /** @type {Record<string, any>} */
    let seen = {};
    await withServer((req, res) => {
        seen = { ...req.headers };
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
    }, async ({ baseURL }) => {
        await postJson({
            url: `${baseURL}/x`,
            apiKey: 'test-key',
            body: { hello: 'world' },
            defaultHeaders: { 'x-a': 'default', 'x-b': 'default' },
            headers: { 'x-b': 'call' },
        });
    });
    assert.equal(seen['x-a'], 'default');
    assert.equal(seen['x-b'], 'call');
    assert.equal(seen.authorization, 'Bearer test-key');
    assert.equal(seen['content-type'], 'application/json');
    assert.equal(seen.accept, 'application/json');
    assert.equal(seen['user-agent'], `merci-sdk/${SDK_VERSION}`);
    assert.equal(Object.keys(seen).some((name) => name.startsWith('x-stainless')), false);
});

test('http: getJson sends no content type', async () => {
    /** @type {Record<string, any>} */
    let seen = {};
    await withServer((req, res) => {
        seen = { ...req.headers };
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
    }, async ({ baseURL }) => {
        assert.deepEqual(await getJson({ url: `${baseURL}/models`, apiKey: 'k' }), { data: [] });
    });
    assert.equal(seen['content-type'], undefined);
    assert.equal(seen.accept, 'application/json');
});

test('http: postStream returns the response body', async () => {
    await withServer(respondWith(200, 'text/event-stream', 'data: {"a":1}\n\n'), async ({ baseURL }) => {
        const response = await postStream({ url: `${baseURL}/x`, body: { stream: true } });
        assert.equal(await response.text(), 'data: {"a":1}\n\n');
    });
});

test('http: postStream throws before returning on a non-2xx status', async () => {
    await withServer(respondWith(400, 'application/json', '{"error":{"message":"bad"}}'), async ({ baseURL }) => {
        await assert.rejects(postStream({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            assert.equal(error.message, '400 bad');
            return true;
        });
    });
});

test('http: postStream rejects a response with no body', async () => {
    await withServer((req, res) => { req.resume(); res.writeHead(204); res.end(); }, async ({ baseURL }) => {
        await assert.rejects(postStream({ url: `${baseURL}/x`, body: {} }), (/** @type {any} */ error) => {
            assert.equal(error.message, 'Response body is null');
            return true;
        });
    });
});

test('http: a null or undefined header never reaches the wire as its name', async () => {
    /** @type {Record<string, any>} */
    let seen = {};
    await withServer((req, res) => {
        seen = { ...req.headers };
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    }, async ({ baseURL }) => {
        await postJson({
            url: `${baseURL}/x`,
            apiKey: 'k',
            body: {},
            defaultHeaders: { 'User-Agent': null, 'x-gone': undefined, 'x-drop': 'default', 'x-kept': 'default' },
            headers: { 'x-drop': null, 'x-kept': 'call' },
        });
    });
    assert.equal(seen['x-gone'], undefined);
    assert.equal(seen['x-drop'], undefined, 'a per-call null deletes a default');
    assert.equal(seen['x-kept'], 'call');
    assert.notEqual(seen['user-agent'], 'null', 'a deleted header is not sent by name');
    assert.equal(Object.values(seen).some((value) => value === 'null' || value === 'undefined'), false);
});

test('http: an error body is capped at max_error_body_bytes and the rest is cancelled', async () => {
    setLimits({ values: { max_error_body_bytes: 1_024 } });
    try {
        let cancelled = false;
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(`<!DOCTYPE html><html>${'x'.repeat(2 * 1024 * 1024)}`));
            },
            cancel() { cancelled = true; },
        });
        /** @type {typeof fetch} */
        const fetchImpl = async () => new Response(body, { status: 404, headers: { 'content-type': 'text/html' } });
        await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
            assert.equal(error.status, 404);
            assert.ok(error.message.length < 1_100, `the message stops at the cap, got ${error.message.length} chars`);
            assert.match(error.message, /^404 <!DOCTYPE html><html>/);
            assert.equal(isEmbeddingUnsupportedStatus({ status: error.status, message: error.message }), true, 'the first bytes stay verbatim');
            assert.equal(cancelled, true, 'the rest of the body is cancelled');
            return true;
        });
    } finally {
        resetLimits();
    }
});

test('http: a completed call leaves no abort listener on the caller signal', async () => {
    await withServer(respondWith(200, 'application/json', '{"ok":true}'), async ({ baseURL }) => {
        const controller = new AbortController();
        assert.deepEqual(await postJson({ url: `${baseURL}/x`, body: {}, signal: controller.signal }), { ok: true });
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('http: a failed call leaves no abort listener on the caller signal', async () => {
    await withServer(respondWith(400, 'application/json', '{"error":{"message":"bad"}}'), async ({ baseURL }) => {
        const controller = new AbortController();
        await assert.rejects(postJson({ url: `${baseURL}/x`, body: {}, signal: controller.signal }));
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('http: a stream release unlinks the caller signal once the reader is done', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"a":1}\n\n');
    }, async ({ baseURL }) => {
        const controller = new AbortController();
        const response = await postStream({ url: `${baseURL}/x`, body: {}, signal: controller.signal });
        assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'the body is still linked');
        /** @type {Array<any>} */
        const events = [];
        for await (const event of iterateSseJson({ stream: response.body, signal: controller.signal, cleanup: response._releaseSignal })) events.push(event);
        assert.deepEqual(events, [{ a: 1 }]);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('http: an early break out of a stream releases the caller signal', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"a":1}\n\n');
    }, async ({ baseURL }) => {
        const controller = new AbortController();
        const response = await postStream({ url: `${baseURL}/x`, body: {}, signal: controller.signal });
        for await (const event of iterateSseJson({ stream: response.body, signal: controller.signal, cleanup: response._releaseSignal })) {
            void event;
            break;
        }
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('http: an abort mid-stream still ends the read cleanly and releases the signal', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"a":1}\n\n');
    }, async ({ baseURL }) => {
        const controller = new AbortController();
        const response = await postStream({ url: `${baseURL}/x`, body: {}, signal: controller.signal });
        const iterator = iterateSseJson({ stream: response.body, signal: controller.signal, cleanup: response._releaseSignal });
        assert.deepEqual((await iterator.next()).value, { a: 1 });
        controller.abort();
        const ended = await iterator.next();
        assert.equal(ended.done, true);
        assert.equal(ended.value, undefined);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('http: the deadline is released at a stream handoff', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': headers out\n\n');
        setTimeout(() => { res.write('data: {"a":1}\n\n'); res.end(); }, 60);
    }, async ({ baseURL }) => {
        const response = await postStream({ url: `${baseURL}/x`, body: {}, timeoutMs: 20 });
        /** @type {Array<any>} */
        const events = [];
        for await (const event of iterateSseJson({ stream: response.body, cleanup: response._releaseSignal })) events.push(event);
        assert.deepEqual(events, [{ a: 1 }], 'the timer must not abort the body after the headers');
    });
});

test('http: an already-aborted signal never calls fetch and arms no timer', async () => {
    let called = false;
    /** @type {typeof fetch} */
    const fetchImpl = () => {
        called = true;
        return new Promise(() => { /* never settles */ });
    };
    const controller = new AbortController();
    const reason = new Error('too late');
    controller.abort(reason);
    const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    await assert.rejects(
        postJson({ url: 'http://127.0.0.1:1/x', body: {}, signal: controller.signal, fetchImpl }),
        (/** @type {any} */ error) => {
            assert.equal(error.name, 'AbortError');
            assert.equal(error.message, 'Request was aborted.');
            assert.equal(error.cause, reason);
            assert.equal(isAbortError({ err: error }), true, 'a plain Error reason is still an abort');
            return true;
        },
    );
    assert.equal(called, false, 'fetch is never called');
    assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, timersBefore, 'no deadline timer is armed');
});

test('stream: singleUse yields once and throws on a second iteration', async () => {
    const iterable = singleUse({ source: (async function* () { yield 1; yield 2; })(), state: { sawDone: false } });
    /** @type {Array<unknown>} */
    const seen = [];
    for await (const value of iterable) seen.push(value);
    assert.deepEqual(seen, [1, 2]);
    assert.equal(Object.keys(iterable).includes('streamState'), false, 'the state is not enumerable');
    await assert.rejects(
        async () => { for await (const value of iterable) void value; },
        /Cannot iterate over a consumed stream\./,
    );
});

test('stream: isStreamIterable recognises an async iterable only', () => {
    assert.equal(isStreamIterable({ value: singleUse({ source: (async function* () {})() }) }), true);
    assert.equal(isStreamIterable({ value: new Response('{}') }), false);
    assert.equal(isStreamIterable({ value: null }), false);
});

test('stream: readBodyPrefix caps the read and cancels the body', async () => {
    let cancelled = false;
    const body = new ReadableStream({
        pull(controller) { controller.enqueue(encoder.encode('abcdefghij')); },
        cancel() { cancelled = true; },
    });
    assert.equal(await readBodyPrefix({ response: new Response(body), width: 3 }), 'abc');
    assert.equal(cancelled, true, 'the rest of the body is cancelled');
    const bare = /** @type {Response} */ ({ body: null, text: async () => 'plain' });
    assert.equal(await readBodyPrefix({ response: bare, width: 3 }), 'pla');
});

test('stream: nonJsonStreamError keeps its non-retryable shape', () => {
    const error = nonJsonStreamError({ mediaType: 'text/html', prefix: '<html>' });
    assert.equal(error.code, 'NON_JSON_STREAM');
    assert.equal(error.nonRetryable, true);
    assert.match(error.message, /text\/html/);
    assert.match(error.message, /<html>/);
});

test('A-11: a 2xx stream answer with no frames is NON_JSON_STREAM, not an empty success', async () => {
    /** @type {Array<{label: string, contentType: string|null, body: string, hint: RegExp}>} */
    const cases = [
        { label: 'text/plain', contentType: 'text/plain', body: 'not an event stream', hint: /text\/plain/ },
        { label: 'missing content-type', contentType: null, body: '<html><body>Sign in</body></html>', hint: /no content-type/ },
        { label: 'application/json without an error field', contentType: 'application/json', body: '{"message":"quota exceeded"}', hint: /application\/json/ },
        { label: 'HTML mislabelled text/event-stream', contentType: 'text/event-stream', body: '<html><body>Sign in</body></html>', hint: /text\/event-stream/ },
    ];
    for (const { label, contentType, body, hint } of cases) {
        await withServer(respondWith(200, contentType, body), async ({ baseURL }) => {
            const transport = createOaiTransport({ apiKey: 'k', baseURL });
            await assert.rejects(async () => {
                const answer = await transport.chat.completions.create({ model: 'm', stream: true });
                for await (const chunk of /** @type {AsyncIterable<unknown>} */ (answer)) void chunk;
            }, (/** @type {any} */ error) => {
                assert.equal(error.code, 'NON_JSON_STREAM', label);
                assert.equal(error.nonRetryable, true, `${label}: non-retryable`);
                assert.match(error.message, hint, `${label}: the message carries a content-type hint`);
                assert.ok(error.message.length < 300, `${label}: the message stays bounded`);
                return true;
            });
        });
    }
});

test('A-11: a valid SSE stream carrying only [DONE] stays a clean empty answer', async () => {
    await withServer(respondWith(200, 'text/event-stream', 'data: [DONE]\n\n'), async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const answer = /** @type {AsyncIterable<unknown>} */ (await transport.chat.completions.create({ model: 'm', stream: true }));
        /** @type {Array<unknown>} */
        const chunks = [];
        for await (const chunk of answer) chunks.push(chunk);
        assert.deepEqual(chunks, [], 'the [DONE] sentinel is a valid terminal frame');
    });
});

test('A-1: a 307 is refused, the redirect target is never contacted, and the error names only its origin', async () => {
    let hits = 0;
    await withServer((req, res) => {
        req.resume();
        req.on('end', () => {
            hits += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"stolen":true}');
        });
    }, async ({ baseURL: targetURL }) => {
        await withServer((req, res) => {
            req.resume();
            res.writeHead(307, { location: `${targetURL}/stolen` });
            res.end();
        }, async ({ baseURL }) => {
            const prompt = 'PROMPT-ONLY-IN-THE-BODY';
            await assert.rejects(
                postJson({ url: `${baseURL}/v1/chat/completions`, apiKey: 'SECRET', body: { prompt } }),
                (/** @type {any} */ error) => {
                    assert.equal(error.nonRetryable, true);
                    assert.ok(error.message.includes(new URL(targetURL).origin), 'the message names the target origin');
                    assert.ok(!error.message.includes('/stolen'), 'no path from the Location');
                    assert.ok(!error.message.includes(prompt), 'no request body');
                    return true;
                },
            );
            assert.equal(hits, 0, 'the redirect target is never contacted');
        });
    });
});

test('A-1: the refused redirect body is cancelled instead of held open', async () => {
    let cancelled = false;
    const body = new ReadableStream({
        start() { /* headers only; the body is never read */ },
        cancel() { cancelled = true; },
    });
    /** @type {typeof fetch} */
    const fetchImpl = async () => new Response(body, { status: 307, headers: { location: 'https://target.test/x' } });
    await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
        assert.equal(error.nonRetryable, true);
        return true;
    });
    assert.equal(cancelled, true, 'the redirect body is cancelled, not parked in the keep-alive pool');
});

test('A-1: a redirect without a usable Location is refused without inventing an origin', async () => {
    /** @type {Array<{name: string, location?: string}>} */
    const cases = [
        { name: 'no Location header' },
        { name: 'unparsable Location', location: 'http://[' },
    ];
    for (const { name, location } of cases) {
        await withServer((req, res) => {
            req.resume();
            res.writeHead(302, location === undefined ? {} : { location });
            res.end();
        }, async ({ baseURL }) => {
            await assert.rejects(
                postJson({ url: `${baseURL}/v1/chat/completions`, body: { prompt: 'PROMPT-ONLY-IN-THE-BODY' } }),
                (/** @type {any} */ error) => {
                    assert.equal(error.nonRetryable, true, `${name}: own nonRetryable flag`);
                    assert.equal(isNonRetryable({ error }), true, `${name}: classified non-retryable`);
                    assert.ok(!error.message.includes('://'), `${name}: no origin is invented: ${error.message}`);
                    return true;
                },
            );
        });
    }
});
