// @ts-check

/**
 * @file Stage 4 refresh tests: order, media type, body cap, prechecks, coalescing (AC7, §5.6).
 * @version 0.12.0
 *
 * @description
 * `POST <base>/refresh` checks the provider before any snapshot read, accepts
 * exactly `application/json`, caps the body, then checks the scheduler state.
 * A second request while one refresh is in flight coalesces without calling
 * the provider twice; the flag is cleared on success and on throw. A refresh
 * error maps its `reason` to 409 and anything else to 503 without its message.
 * A client abort during the drain never writes to a destroyed response and
 * never rejects out of the handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';

import { createOperatorHttpHandler } from '../lib/agentic/operator/http.mjs';

const NOW = Date.parse('2026-11-09T18:00:00.000Z');
const NOW_ISO = '2026-11-09T18:00:00.000Z';

/** @returns {Record<string, unknown>} */
function createSnapshot() {
    return {
        started: true,
        stopped: false,
        tickCount: 1,
        running: [],
        retrying: [],
        parked: [],
        claimed: [],
        completed: [],
        totals: {},
        limits: {},
        activeStates: [],
        terminalStates: []
    };
}

/**
 * @param {{handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}} arg0
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {{port: number}} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

/**
 * @param {{
 *   port: number,
 *   method?: string,
 *   path?: string,
 *   headers?: Record<string, string>,
 *   body?: string
 * }} arg0
 * @returns {Promise<{status: number|undefined, body: string, headers: import('node:http').IncomingHttpHeaders}>}
 */
function send({ port, method = 'POST', path = '/api/v1/refresh', headers = {}, body = '' }) {
    /** @type {import('node:http').ClientRequest|null} */
    let request = null;
    // A regression that never answers must fail the test in ~2 s, not hang it.
    return new Promise((resolve, reject) => {
        request = httpRequest({
            host: '127.0.0.1', port, method, path, agent: false,
            headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
        }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
                headers: res.headers
            }));
        });
        request.setTimeout(2000, () => {
            request?.destroy(new Error('response timeout'));
        });
        request.on('error', reject);
        request.end(body);
    }).finally(() => {
        request?.destroy();
    });
}

/**
 * @param {{port: number, chunks: Array<string>, headers?: Record<string,string>}} arg0
 * @returns {Promise<{status: number|undefined, body: string}>}
 */
function sendChunked({ port, chunks, headers = {} }) {
    /** @type {import('node:http').ClientRequest|null} */
    let request = null;
    return new Promise((resolve, reject) => {
        request = httpRequest({
            host: '127.0.0.1', port, method: 'POST', path: '/api/v1/refresh', agent: false,
            headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', ...headers }
        }, (res) => {
            /** @type {Buffer[]} */
            const collected = [];
            res.on('data', (chunk) => collected.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(collected).toString('utf8') }));
        });
        request.setTimeout(2000, () => {
            request?.destroy(new Error('response timeout'));
        });
        request.on('error', reject);
        for (const chunk of chunks) request.write(chunk);
        request.end();
    }).finally(() => {
        request?.destroy();
    });
}

/**
 * Send a request head that declares a body and then send no body at all,
 * returning the response status line. A handler that drains before answering
 * never responds, so the 2 s timeout is the assertion.
 * @param {{port: number}} arg0
 * @returns {Promise<string>}
 */
function sendHeadOnly({ port }) {
    /** @type {import('node:net').Socket|null} */
    let socket = null;
    return new Promise((resolve, reject) => {
        socket = netConnect({ host: '127.0.0.1', port });
        let received = '';
        socket.setTimeout(2000, () => {
            socket?.destroy(new Error('response timeout'));
        });
        socket.on('error', reject);
        socket.on('data', (chunk) => {
            received += chunk.toString('utf8');
            const end = received.indexOf('\r\n');
            if (end !== -1) resolve(received.slice(0, end));
        });
        socket.on('connect', () => {
            socket?.write([
                'POST /api/v1/refresh HTTP/1.1',
                'Host: 127.0.0.1',
                'Content-Type: application/json',
                'Content-Length: 100000',
                '',
                ''
            ].join('\r\n'));
        });
    }).finally(() => {
        socket?.destroy();
    });
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {ReturnType<typeof createOperatorHttpHandler>}
 */
function handlerWith(overrides = {}) {
    return createOperatorHttpHandler(/** @type {never} */ ({
        getSnapshot: () => createSnapshot(),
        refresh: async () => {},
        statusPath: null,
        now: () => NOW,
        ...overrides
    }));
}

test('no refresh provider is 501 before any snapshot read', { timeout: 5000 }, async () => {
    let snapshotCalls = 0;
    const handler = createOperatorHttpHandler({
        getSnapshot: () => { snapshotCalls += 1; throw new Error('broken'); },
        statusPath: null,
        now: () => NOW
    });
    const srv = await listen({ handler });
    try {
        const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 501);
        assert.deepEqual(JSON.parse(res.body), { error: { code: 'refresh_not_supported', message: 'Refresh is not supported.' } });
        assert.equal(snapshotCalls, 0);
    } finally { await srv.close(); }
});

test('refresh requires exactly application/json', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ refresh: async () => { refreshCalls += 1; } }) });
    try {
        const rejected = [
            undefined,
            'text/plain',
            'application/json-patch+json',
            'application/jsonp',
            'application/x-www-form-urlencoded'
        ];
        for (const type of rejected) {
            /** @type {Record<string, string>} */
            const headers = type === undefined ? {} : { 'Content-Type': type };
            const res = await send({ port: srv.port, headers, body: '{}' });
            assert.equal(res.status, 415, String(type));
            assert.equal(JSON.parse(res.body).error.code, 'unsupported_media_type');
        }
        assert.equal(refreshCalls, 0, 'no body is read for a rejected media type');

        for (const type of ['application/json', 'Application/JSON; charset=utf-8', 'application/json;foo=bar']) {
            const res = await send({ port: srv.port, headers: { 'Content-Type': type }, body: '{}' });
            assert.equal(res.status, 202, type);
        }
        assert.equal(refreshCalls, 3);
    } finally { await srv.close(); }
});

test('a declared Content-Length over the cap is 413 without reading or refreshing', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ maxBodyBytes: 8, refresh: async () => { refreshCalls += 1; } }) });
    try {
        const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(9) });
        assert.equal(res.status, 413);
        assert.deepEqual(JSON.parse(res.body), { error: { code: 'payload_too_large', message: 'Payload too large.' } });
        assert.equal(refreshCalls, 0);

        // The handler still serves after the oversized request.
        const state = await send({ port: srv.port, method: 'GET', path: '/api/v1/state' });
        assert.equal(state.status, 200);
    } finally { await srv.close(); }
});

test('a declared Content-Length over the cap is 413 before the body is read', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ refresh: async () => { refreshCalls += 1; } }) });
    try {
        const statusLine = await sendHeadOnly({ port: srv.port });
        assert.match(statusLine, /^HTTP\/1\.1 413 /);
        assert.equal(refreshCalls, 0);
    } finally { await srv.close(); }
});

test('a chunked body over the cap is 413 without refreshing', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ maxBodyBytes: 8, refresh: async () => { refreshCalls += 1; } }) });
    try {
        const res = await sendChunked({ port: srv.port, chunks: ['12345', '6789'], headers: {} });
        assert.equal(res.status, 413);
        assert.equal(JSON.parse(res.body).error.code, 'payload_too_large');
        assert.equal(refreshCalls, 0);
    } finally { await srv.close(); }
});

test('a null snapshot is 503 snapshot_unavailable without refreshing', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ getSnapshot: () => null, refresh: async () => { refreshCalls += 1; } }) });
    try {
        const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 503);
        assert.deepEqual(JSON.parse(res.body), { error: { code: 'snapshot_unavailable', message: 'Snapshot unavailable.' } });
        assert.equal(refreshCalls, 0);
    } finally { await srv.close(); }
});

test('prechecks: stopped is 409 stopped and unstarted is 409 not_started, before refresh', { timeout: 5000 }, async () => {
    const cases = [
        { snapshot: { ...createSnapshot(), stopped: true }, code: 'stopped', message: 'Scheduler is stopped.' },
        { snapshot: { ...createSnapshot(), started: false }, code: 'not_started', message: 'Scheduler is not started.' }
    ];
    for (const entry of cases) {
        let refreshCalls = 0;
        const handler = createOperatorHttpHandler({
            getSnapshot: () => entry.snapshot,
            refresh: async () => { refreshCalls += 1; },
            statusPath: null,
            now: () => NOW
        });
        const srv = await listen({ handler });
        try {
            const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(res.status, 409);
            assert.deepEqual(JSON.parse(res.body), { error: { code: entry.code, message: entry.message } });
            assert.equal(res.headers['cache-control'], 'no-store', entry.code);
            assert.equal(refreshCalls, 0);
        } finally { await srv.close(); }
    }
});

test('success is 202 queued with operations and the injected clock', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ refresh: async () => { refreshCalls += 1; } }) });
    try {
        const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"anything":true}' });
        assert.equal(res.status, 202);
        assert.deepEqual(JSON.parse(res.body), {
            queued: true,
            coalesced: false,
            requestedAt: NOW_ISO,
            operations: ['poll', 'reconcile']
        });
        assert.equal(refreshCalls, 1);
    } finally { await srv.close(); }
});

test('a second request coalesces while one refresh is in flight', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    /** @type {() => void} */
    let started = () => {};
    const startedPromise = new Promise((resolve) => { started = () => resolve(undefined); });
    const refresh = async () => {
        refreshCalls += 1;
        started();
        await gate;
    };
    const srv = await listen({ handler: handlerWith({ refresh }) });
    try {
        const first = send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await startedPromise;

        const second = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(second.status, 202);
        assert.deepEqual(JSON.parse(second.body), {
            queued: false,
            coalesced: true,
            requestedAt: NOW_ISO,
            operations: ['poll', 'reconcile']
        });
        assert.equal(refreshCalls, 1, 'the coalesced request does not call refresh again');

        release();
        const firstResult = await first;
        assert.equal(firstResult.status, 202);
        assert.equal(JSON.parse(firstResult.body).queued, true);

        const third = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(third.status, 202);
        assert.equal(JSON.parse(third.body).coalesced, false);
        assert.equal(refreshCalls, 2, 'the flag is cleared once the first refresh resolves');
    } finally {
        release();
        await srv.close();
    }
});

test('a refresh throw maps reason to 409 and anything else to 503 without the message', { timeout: 5000 }, async () => {
    /**
     * @param {unknown} error
     * @returns {ReturnType<typeof createOperatorHttpHandler>}
     */
    const handlerFor = (error) => createOperatorHttpHandler(/** @type {never} */ ({
        getSnapshot: () => createSnapshot(),
        refresh: async () => { throw error; },
        statusPath: null,
        now: () => NOW
    }));

    /** @type {Array<{options?: {reason?: string}, reason?: string, label: string}>} */
    const cases = [
        { options: { reason: 'stopped' }, label: 'stopped via options' },
        { reason: 'not_started', label: 'not_started via the error' }
    ];
    for (const entry of cases) {
        const error = /** @type {Error & {options?: {reason?: string}, reason?: string}} */ (new Error('refresh-secret'));
        if (entry.options) error.options = entry.options;
        if (entry.reason) error.reason = entry.reason;
        const srv = await listen({ handler: handlerFor(error) });
        try {
            const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(res.status, 409, entry.label);
            assert.equal(JSON.parse(res.body).error.code, entry.options?.reason ?? entry.reason);
            assert.ok(!res.body.includes('refresh-secret'));
        } finally { await srv.close(); }
    }

    const srv = await listen({ handler: handlerFor(new Error('refresh-secret')) });
    try {
        const res = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 503);
        assert.equal(JSON.parse(res.body).error.code, 'refresh_failed');
        assert.ok(!res.body.includes('refresh-secret'));
    } finally { await srv.close(); }
});

test('the in-flight flag is cleared after a throw so a later request can try again', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const refresh = async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) throw new Error('boom');
    };
    const srv = await listen({ handler: handlerWith({ refresh }) });
    try {
        const first = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(first.status, 503);
        const second = await send({ port: srv.port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(second.status, 202);
        assert.equal(refreshCalls, 2);
    } finally { await srv.close(); }
});

test('a client abort during the body drain is contained and writes nothing', { timeout: 5000 }, async () => {
    let refreshCalls = 0;
    const srv = await listen({ handler: handlerWith({ refresh: async () => { refreshCalls += 1; } }) });
    /** @type {Array<unknown>} */
    const unhandled = [];
    /** @param {unknown} reason */
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        await new Promise((resolve) => {
            const req = httpRequest({
                host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/v1/refresh', agent: false,
                headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }
            });
            req.on('error', () => resolve(undefined));
            req.write('{"partial":');
            setTimeout(() => { req.destroy(); resolve(undefined); }, 10);
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(unhandled, []);
        assert.equal(refreshCalls, 0, 'an aborted request does not refresh');

        const state = await send({ port: srv.port, method: 'GET', path: '/api/v1/state' });
        assert.equal(state.status, 200, 'the handler keeps serving');
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await srv.close();
    }
});
