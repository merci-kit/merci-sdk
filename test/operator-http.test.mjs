// @ts-check

/**
 * @file Stage 3 HTTP handler tests: security, routing, projections (AC1–AC3, AC6, AC8, §5.4).
 * @version 0.12.0
 *
 * @description
 * Mounts the handler on a host-created `node:http` server over an ephemeral
 * loopback port, exactly like the other HTTP tests. The handler must never
 * create a server, never throw to the host, and never leak a provider message
 * or a stack. The Host allowlist, the exact route set (including the alias),
 * the `Allow` values, identifier decoding, and every snapshot failure mode are
 * pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { ConfigurationError } from '../lib/core/errors.mjs';
import { createOperatorHttpHandler } from '../lib/agentic/operator/http.mjs';

const NOW = Date.parse('2026-11-09T18:00:00.000Z');
const NOW_ISO = '2026-11-09T18:00:00.000Z';

/** @returns {Record<string, unknown>} */
function createSnapshot() {
    return {
        started: true,
        stopped: false,
        tickCount: 12,
        lastTickAt: NOW - 1000,
        pollIntervalMs: 30000,
        running: [{
            workItemId: 'wi-1',
            identifier: 'MER-1',
            url: 'https://tracker.example/MER-1',
            state: 'In Progress',
            lane: 'main',
            attempt: 2,
            startedAt: NOW - 252000,
            lastProgressAt: NOW - 500,
            threadId: 'work:MER-1',
            workspacePath: '/tmp/ws/MER-1'
        }],
        retrying: [{
            workItemId: 'wi-2',
            identifier: 'MER-2',
            url: null,
            attempt: 3,
            kind: 'failure',
            dueAtMs: NOW + 5000,
            delayMs: 10000,
            errorName: 'Error',
            errorCode: 'E1'
        }],
        parked: [{
            workItemId: 'wi-3',
            identifier: 'MER-3',
            url: null,
            reason: 'attempts_exhausted',
            since: NOW,
            nextCheckAt: NOW + 60000,
            attempts: 5,
            continuations: 2
        }],
        claimed: ['MER-1'],
        completed: ['MER-0'],
        totals: {
            inputTokens: 1000,
            outputTokens: 6400,
            totalTokens: 7400,
            costUsd: 0.42,
            secondsRunning: 1834,
            dispatches: 12,
            attempts: 13,
            failures: 2,
            usageComplete: true,
            costComplete: true
        },
        limits: {
            maxAttemptsPerItem: 5,
            maxDispatches: 20,
            maxTotalTokens: 100000,
            maxTotalUsd: 5
        },
        activeStates: ['In Progress'],
        terminalStates: ['Done']
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
function send({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
    /** @type {import('node:http').ClientRequest|null} */
    let request = null;
    // A regression that never answers must fail the test in ~2 s, not hang it.
    return new Promise((resolve, reject) => {
        request = httpRequest({
            host: '127.0.0.1',
            port,
            method,
            path,
            agent: false,
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
 * @param {Record<string, unknown>} [overrides]
 * @returns {ReturnType<typeof createOperatorHttpHandler>}
 */
function handlerWith(overrides = {}) {
    return createOperatorHttpHandler(/** @type {never} */ ({
        getSnapshot: () => createSnapshot(),
        statusPath: null,
        now: () => NOW,
        ...overrides
    }));
}

/**
 * @param {unknown} options
 * @param {string} option
 */
function expectConfigError(options, option) {
    assert.throws(
        () => createOperatorHttpHandler(/** @type {never} */ (options)),
        (error) => error instanceof ConfigurationError && error.option === option
    );
}

test('a foreign Host is 403 forbidden_host while loopback hosts are served', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: handlerWith() });
    try {
        const evil = await send({ port: srv.port, path: '/api/v1/state', headers: { Host: 'evil.com' } });
        assert.equal(evil.status, 403);
        assert.deepEqual(JSON.parse(evil.body), { error: { code: 'forbidden_host', message: 'Forbidden host.' } });
        assert.equal(evil.headers['cache-control'], 'no-store');
        assert.equal(evil.headers['access-control-allow-origin'], undefined);

        for (const host of [`localhost:${srv.port}`, `127.0.0.1:${srv.port}`, `[::1]:${srv.port}`]) {
            const ok = await send({ port: srv.port, path: '/api/v1/state', headers: { Host: host } });
            assert.equal(ok.status, 200, `${host} must be served`);
            assert.equal(ok.headers['access-control-allow-origin'], undefined);
        }
    } finally { await srv.close(); }
});

test('allowAnyHost bypasses the Host allowlist only when true and never adds CORS', { timeout: 5000 }, async () => {
    const cases = [{ allowAnyHost: true, status: 200 }, { allowAnyHost: false, status: 403 }];
    for (const entry of cases) {
        const srv = await listen({ handler: handlerWith({ allowAnyHost: entry.allowAnyHost }) });
        try {
            const res = await send({ port: srv.port, path: '/api/v1/state', headers: { Host: 'evil.com' } });
            assert.equal(res.status, entry.status, String(entry.allowAnyHost));
            assert.equal(res.headers['access-control-allow-origin'], undefined);
        } finally { await srv.close(); }
    }
});

test('allowAnyHost rejects every non-boolean value at construction', () => {
    const base = { getSnapshot: () => ({}) };
    for (const allowAnyHost of ['yes', 1, {}, [], 'false']) {
        expectConfigError({ ...base, allowAnyHost }, 'invalid_allow_any_host');
    }
    assert.doesNotThrow(() => createOperatorHttpHandler({ ...base, allowAnyHost: true }));
    assert.doesNotThrow(() => createOperatorHttpHandler({ ...base, allowAnyHost: false }));
});

test('every route answers its happy path', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: createOperatorHttpHandler({ getSnapshot: () => createSnapshot(), refresh: async () => {}, now: () => NOW }) });
    try {
        const status = await send({ port: srv.port, path: '/' });
        assert.equal(status.status, 200);
        assert.equal(status.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(status.headers['cache-control'], 'no-store');
        assert.match(status.body, /^MerciSDK operator \| running/m);
        assert.match(status.body, /Running \(1\)/);

        const state = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(state.status, 200);
        assert.equal(state.headers['content-type'], 'application/json; charset=utf-8');
        const stateBody = JSON.parse(state.body);
        assert.equal(stateBody.generatedAt, NOW_ISO);
        assert.equal(stateBody.counts.running, 1);
        assert.equal(stateBody.running[0].identifier, 'MER-1');

        for (const path of ['/api/v1/items/MER-1', '/api/v1/MER-1']) {
            const item = await send({ port: srv.port, path });
            assert.equal(item.status, 200, path);
            const itemBody = JSON.parse(item.body);
            assert.equal(itemBody.identifier, 'MER-1');
            assert.equal(itemBody.status, 'running');
            assert.equal(itemBody.generatedAt, NOW_ISO);
        }

        const refresh = await send({
            port: srv.port,
            method: 'POST',
            path: '/api/v1/refresh',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(refresh.status, 202);
        assert.deepEqual(JSON.parse(refresh.body), {
            queued: true,
            coalesced: false,
            requestedAt: NOW_ISO,
            operations: ['poll', 'reconcile']
        });
    } finally { await srv.close(); }
});

test('the alias never shadows state, refresh, or items', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: createOperatorHttpHandler({ getSnapshot: () => createSnapshot(), refresh: async () => {}, now: () => NOW }) });
    try {
        const state = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(state.status, 200);
        assert.ok('counts' in JSON.parse(state.body), 'the state route wins over the alias');

        const refresh = await send({ port: srv.port, path: '/api/v1/refresh' });
        assert.equal(refresh.status, 405);
        assert.equal(refresh.headers.allow, 'POST');

        const items = await send({ port: srv.port, path: '/api/v1/items' });
        assert.equal(items.status, 404);
        assert.equal(JSON.parse(items.body).error.code, 'not_found');
    } finally { await srv.close(); }
});

test('an unknown path is 404 not_found', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: handlerWith() });
    try {
        for (const path of ['/nope', '/api/v1/unknown/deeper', '/api']) {
            const res = await send({ port: srv.port, path });
            assert.equal(res.status, 404, path);
            assert.deepEqual(JSON.parse(res.body), { error: { code: 'not_found', message: 'Not found.' } });
        }
    } finally { await srv.close(); }
});

test('a known path with the wrong method is 405 with the exact Allow', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: createOperatorHttpHandler({ getSnapshot: () => createSnapshot(), refresh: async () => {}, now: () => NOW }) });
    try {
        /** @type {Array<{method: string, path: string, allow: string}>} */
        const cases = [
            { method: 'POST', path: '/', allow: 'GET' },
            { method: 'POST', path: '/api/v1/state', allow: 'GET' },
            { method: 'POST', path: '/api/v1/items/MER-1', allow: 'GET' },
            { method: 'POST', path: '/api/v1/MER-1', allow: 'GET' },
            { method: 'GET', path: '/api/v1/refresh', allow: 'POST' },
            { method: 'HEAD', path: '/api/v1/state', allow: 'GET' }
        ];
        for (const entry of cases) {
            const res = await send({ port: srv.port, method: entry.method, path: entry.path });
            assert.equal(res.status, 405, `${entry.method} ${entry.path}`);
            assert.equal(res.headers.allow, entry.allow, `${entry.method} ${entry.path}`);
            // A HEAD response carries no body by protocol, only the headers.
            if (entry.method !== 'HEAD') assert.equal(JSON.parse(res.body).error.code, 'method_not_allowed');
        }
    } finally { await srv.close(); }
});

test('basePath mounts under a prefix and is normalized', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: createOperatorHttpHandler({ getSnapshot: () => createSnapshot(), basePath: '/ops/v1///', statusPath: null, now: () => NOW }) });
    try {
        const state = await send({ port: srv.port, path: '/ops/v1/state' });
        assert.equal(state.status, 200);
        const legacy = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(legacy.status, 404);
    } finally { await srv.close(); }
});

test('construction rejects every invalid option with its option name', () => {
    expectConfigError(undefined, 'invalid_get_snapshot');
    expectConfigError({ getSnapshot: () => ({}), refresh: 'yes' }, 'invalid_refresh');
    expectConfigError({ getSnapshot: () => ({}), recentEvents: 'yes' }, 'invalid_recent_events');

    const base = { getSnapshot: () => ({}) };
    for (const basePath of ['', 'api/v1', '/', '/api v1', '/api?v1', '/api#v1', '//', true]) {
        expectConfigError({ ...base, basePath }, 'invalid_base_path');
    }
    for (const statusPath of [42, 'status', false]) {
        expectConfigError({ ...base, statusPath }, 'invalid_status_path');
    }
    for (const statusPath of ['/api/v1', '/api/v1/state', '/api/v1/refresh', '/api/v1/items']) {
        expectConfigError({ ...base, statusPath }, 'status_path_collision');
    }
    for (const statusPath of [
        '/api/v1/items/MER-1',
        '/api/v1/MER-1',
        // Reserved only as an alias segment: below `/items/` this is still an item.
        '/api/v1/items/state',
        '/api/v1/items/items'
    ]) {
        expectConfigError({ ...base, statusPath }, 'status_path_collision');
    }
    for (const allowedHosts of [[], ['ok', ''], 'localhost', [1]]) {
        expectConfigError({ ...base, allowedHosts }, 'invalid_allowed_hosts');
    }
    for (const maxBodyBytes of [0, -1, 1.5, '1024']) {
        expectConfigError({ ...base, maxBodyBytes }, 'invalid_max_body_bytes');
    }
    for (const recentEventsLimit of [0, 1.5]) {
        expectConfigError({ ...base, recentEventsLimit }, 'invalid_recent_events_limit');
    }
    for (const statusMaxRows of [0, 1.5]) {
        expectConfigError({ ...base, statusMaxRows }, 'invalid_status_max_rows');
    }
    expectConfigError({ ...base, now: 123 }, 'invalid_now');
    expectConfigError({ getSnapshot: () => ({}), statusPath: 42 }, 'invalid_status_path');
});

test('statusPath: null disables the text route', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: handlerWith() });
    try {
        const res = await send({ port: srv.port, path: '/' });
        assert.equal(res.status, 404);
    } finally { await srv.close(); }
});

test('identifiers decode once and malformed segments are 400 invalid_identifier', { timeout: 5000 }, async () => {
    const srv = await listen({ handler: handlerWith() });
    try {
        const encoded = await send({ port: srv.port, path: '/api/v1/items/MER%2D1' });
        assert.equal(encoded.status, 200);
        assert.equal(JSON.parse(encoded.body).identifier, 'MER-1');

        for (const path of ['/api/v1/items/%2F', '/api/v1/items/%ZZ', '/api/v1/items/', '/api/v1/items/MER-1/']) {
            const res = await send({ port: srv.port, path });
            assert.equal(res.status, 400, path);
            assert.deepEqual(JSON.parse(res.body), { error: { code: 'invalid_identifier', message: 'Invalid work item identifier.' } });
        }

        const aliasEncoded = await send({ port: srv.port, path: '/api/v1/MER%2D1' });
        assert.equal(aliasEncoded.status, 200);

        const unknown = await send({ port: srv.port, path: '/api/v1/items/MER-9' });
        assert.equal(unknown.status, 404);
        assert.deepEqual(JSON.parse(unknown.body), { error: { code: 'item_not_found', message: 'Work item not found.' } });
    } finally { await srv.close(); }
});

test('every snapshot failure mode is 503 snapshot_unavailable and keeps serving', { timeout: 5000 }, async () => {
    /** @type {Array<() => unknown>} */
    const providers = [
        () => { throw new Error('provider-secret'); },
        () => null,
        () => 'not-a-snapshot',
        () => [1, 2, 3],
        () => Promise.resolve({ started: true }),
        () => Promise.reject(new Error('reject-secret'))
    ];
    /** @type {Array<unknown>} */
    const unhandled = [];
    /** @param {unknown} reason */
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let index = 0;
    const handler = createOperatorHttpHandler({
        getSnapshot: () => (index < providers.length
            ? /** @type {Record<string, unknown>} */ (providers[index]())
            : createSnapshot()),
        statusPath: '/',
        now: () => NOW
    });
    const srv = await listen({ handler });
    try {
        for (index = 0; index < providers.length; index += 1) {
            const state = await send({ port: srv.port, path: '/api/v1/state' });
            assert.equal(state.status, 503);
            assert.deepEqual(JSON.parse(state.body), { error: { code: 'snapshot_unavailable', message: 'Snapshot unavailable.' } });

            const status = await send({ port: srv.port, path: '/' });
            assert.equal(status.status, 503);
            assert.equal(status.headers['content-type'], 'text/plain; charset=utf-8');
            assert.equal(status.body, 'snapshot unavailable');

            const item = await send({ port: srv.port, path: '/api/v1/items/MER-1' });
            assert.equal(item.status, 503);
            assert.equal(JSON.parse(item.body).error.code, 'snapshot_unavailable');

            assert.ok(!state.body.includes('secret'));
            assert.ok(!state.body.includes('at '));
        }
        // Let any unhandled rejection surface before asserting.
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(unhandled, []);

        index = providers.length;
        const recovered = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(recovered.status, 200, 'the handler keeps serving');
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await srv.close();
    }
});

test('a hostile snapshot getter is 500 internal_error without a stack', { timeout: 5000 }, async () => {
    const hostile = /** @type {Record<string, unknown>} */ ({ started: true, stopped: false });
    Object.defineProperty(hostile, 'running', { get() { throw new Error('getter-secret'); } });
    const srv = await listen({ handler: createOperatorHttpHandler({ getSnapshot: () => hostile, statusPath: null }) });
    try {
        const res = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(res.status, 500);
        assert.deepEqual(JSON.parse(res.body), { error: { code: 'internal_error', message: 'Internal error.' } });
        assert.ok(!res.body.includes('getter-secret'));
        assert.ok(!res.body.includes('at '));
    } finally { await srv.close(); }
});

test('a hostile status getter is 500 text/plain without a JSON envelope or a stack', { timeout: 5000 }, async () => {
    const hostile = /** @type {Record<string, unknown>} */ ({ started: true, stopped: false });
    Object.defineProperty(hostile, 'running', { get() { throw new Error('getter-secret'); } });
    const srv = await listen({ handler: createOperatorHttpHandler({ getSnapshot: () => hostile, now: () => NOW }) });
    try {
        const res = await send({ port: srv.port, path: '/' });
        assert.equal(res.status, 500);
        assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(res.body, 'internal error');
        assert.ok(!res.body.includes('getter-secret'));
        assert.ok(!res.body.includes('at '));
    } finally { await srv.close(); }
});

test('every response is no-store and carries the documented content type', { timeout: 5000 }, async () => {
    const handler = handlerWith({ refresh: async () => {} });
    const srv = await listen({ handler });
    try {
        /** @type {Array<{method?: string, path: string, type: string, headers?: Record<string,string>, body?: string}>} */
        const cases = [
            { path: '/api/v1/state', type: 'application/json; charset=utf-8' },
            { path: '/api/v1/items/MER-1', type: 'application/json; charset=utf-8' },
            { path: '/missing', type: 'application/json; charset=utf-8' },
            { method: 'POST', path: '/api/v1/items/MER-1', type: 'application/json; charset=utf-8' },
            { method: 'POST', path: '/api/v1/refresh', headers: { 'Content-Type': 'application/json' }, body: '{}', type: 'application/json; charset=utf-8' }
        ];
        for (const entry of cases) {
            const res = await send({ port: srv.port, method: entry.method, path: entry.path, headers: entry.headers, body: entry.body });
            assert.equal(res.headers['cache-control'], 'no-store', entry.path);
            assert.equal(res.headers['content-type'], entry.type, entry.path);
            assert.equal(res.headers['access-control-allow-origin'], undefined, entry.path);
        }
    } finally { await srv.close(); }
});

test('the handler is a function that mounts on a host-created server', { timeout: 5000 }, async () => {
    const handler = handlerWith();
    assert.equal(typeof handler, 'function');
    const srv = await listen({ handler });
    try {
        const res = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(res.status, 200);
    } finally { await srv.close(); }
});
