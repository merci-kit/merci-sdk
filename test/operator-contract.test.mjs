// @ts-check

/**
 * @file Stage 3 contract tests: the producer shape and the fake-provider mount (AC1, §5.5).
 * @version 0.12.0
 *
 * @description
 * The fixture comes from the real producer, `buildSnapshot()` in
 * `lib/agentic/scheduler/state.mjs`, and asserts every key the operator view
 * consumes — so a producer that drops a key fails here, not silently in the
 * API. A second alarm drives the real `WorkScheduler` (a test-only import),
 * one tick each for a retrying row and a parked row, because the wire shape is
 * the producer's and a hand-written fixture cannot speak for it. A fake
 * `{ snapshot, refresh }` then runs the whole handler with no scheduler object
 * at all. A source check proves the operator modules never import the
 * scheduler and `http.mjs` never imports `node:http`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';

import { buildSnapshot, createTotals } from '../lib/agentic/scheduler/state.mjs';
import { WorkScheduler, createMemoryClaimStore, createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { createOperatorHttpHandler } from '../lib/agentic/operator/http.mjs';
import { toStateResponse } from '../lib/agentic/operator/view.mjs';

const NOW = Date.parse('2026-11-09T18:00:00.000Z');

/** @returns {Map<string, Record<string, unknown>>} */
function createRunning() {
    return new Map([['MER-1', {
        id: 'wi-1',
        identifier: 'MER-1',
        item: {
            id: 'wi-1',
            identifier: 'MER-1',
            state: 'In Progress',
            priority: 1,
            url: 'https://tracker.example/MER-1'
        },
        attempt: 2,
        lane: 'main',
        startedAt: NOW - 252000,
        lastProgressAt: NOW - 500,
        threadId: 'work:MER-1',
        workspace: { path: '/tmp/ws/MER-1' }
    }]]);
}

/** @returns {Record<string, unknown>} */
function createFixture() {
    return /** @type {Record<string, unknown>} */ (buildSnapshot(/** @type {never} */ ({
        started: true,
        stopped: false,
        tickCount: 12,
        lastTickAt: NOW - 1000,
        pollIntervalMs: 30000,
        running: createRunning(),
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
            url: 'https://tracker.example/MER-3',
            reason: 'attempts_exhausted',
            since: NOW,
            nextCheckAt: NOW + 60000,
            attempts: 5,
            continuations: 2
        }],
        claimed: ['MER-1'],
        completed: ['MER-0'],
        totals: {
            ...createTotals(),
            inputTokens: 1000,
            outputTokens: 6400,
            totalTokens: 7400,
            costUsd: 0.42,
            secondsRunning: 1834,
            dispatches: 12,
            attempts: 13,
            failures: 2
        },
        limits: {
            maxAttemptsPerItem: 5,
            maxDispatches: 20,
            maxTotalTokens: 100000,
            maxTotalUsd: 5
        },
        activeStates: ['In Progress'],
        terminalStates: ['Done'],
        now: NOW
    })));
}

/** Top-level fields the view consumes. */
const SNAPSHOT_KEYS = [
    'started', 'stopped', 'tickCount', 'lastTickAt', 'pollIntervalMs',
    'running', 'retrying', 'parked', 'claimed', 'completed', 'totals',
    'limits', 'activeStates', 'terminalStates'
];

const RUNNING_KEYS = [
    'workItemId', 'identifier', 'url', 'state', 'lane', 'attempt',
    'startedAt', 'lastProgressAt', 'threadId', 'workspacePath'
];

const RETRYING_KEYS = [
    'workItemId', 'identifier', 'url', 'attempt', 'kind', 'dueAtMs',
    'delayMs', 'errorName', 'errorCode'
];

const PARKED_KEYS = [
    'workItemId', 'identifier', 'url', 'reason', 'since', 'nextCheckAt',
    'attempts', 'continuations'
];

const TOTALS_KEYS = [
    'inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'secondsRunning',
    'dispatches', 'attempts', 'failures', 'usageComplete', 'costComplete'
];

const LIMITS_KEYS = ['maxAttemptsPerItem', 'maxDispatches', 'maxTotalTokens', 'maxTotalUsd'];

/** The retrying row after `toStateResponse` projects it. */
const STATE_RETRYING_KEYS = [
    'workItemId', 'identifier', 'url', 'attempt', 'kind', 'dueAt',
    'delayMs', 'errorName', 'errorCode'
];

/** The parked row after `toStateResponse` projects it. */
const STATE_PARKED_KEYS = [
    'workItemId', 'identifier', 'url', 'reason', 'since', 'nextCheckAt',
    'attempts', 'continuations'
];

/**
 * Drive one real scheduler over a single failing item and return its snapshot,
 * so the contract test reads the producer's rows instead of a fixture.
 * @param {{limits: Record<string, unknown>}} arg0
 * @returns {Promise<Record<string, unknown>>}
 */
async function produceSnapshot({ limits }) {
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({
            items: [{ id: 'wi-9', identifier: 'MER-9', title: 'One', state: 'Todo', dispatchable: true }]
        }),
        workflow: { run: async () => ({ status: 'failed' }) },
        claims: createMemoryClaimStore(),
        clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} },
        pollIntervalMs: 3_600_000,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        continuation: { delayMs: 0, max: 0 },
        limits
    });
    await scheduler.start();
    // The settle runs after the tick resolves; give the microtask queue room.
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
    return /** @type {Record<string, unknown>} */ (scheduler.snapshot());
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function firstRow(value) {
    return /** @type {Record<string, unknown>} */ (/** @type {Array<unknown>} */ (value)[0]);
}

/**
 * @param {{value: unknown, keys: Array<string>, label: string}} arg0
 */
function assertKeys({ value, keys, label }) {
    assert.ok(value && typeof value === 'object', `${label} must be an object`);
    for (const key of keys) {
        assert.ok(key in /** @type {Record<string, unknown>} */ (value), `${label} is missing "${key}"`);
    }
}

test('the real producer carries every snapshot key the operator view consumes', () => {
    const fixture = createFixture();
    assertKeys({ value: fixture, keys: SNAPSHOT_KEYS, label: 'snapshot' });
    assertKeys({ value: /** @type {Array<unknown>} */ (fixture.running)[0], keys: RUNNING_KEYS, label: 'running row' });
    assertKeys({ value: /** @type {Array<unknown>} */ (fixture.retrying)[0], keys: RETRYING_KEYS, label: 'retrying row' });
    assertKeys({ value: /** @type {Array<unknown>} */ (fixture.parked)[0], keys: PARKED_KEYS, label: 'parked row' });
    assertKeys({ value: fixture.totals, keys: TOTALS_KEYS, label: 'totals' });
    assertKeys({ value: fixture.limits, keys: LIMITS_KEYS, label: 'limits' });

    // The producer's timestamps are epoch ms; the view is responsible for ISO.
    const running = /** @type {Record<string, unknown>} */ (/** @type {Array<unknown>} */ (fixture.running)[0]);
    assert.equal(typeof running.startedAt, 'number');
    assert.equal(running.url, 'https://tracker.example/MER-1');
});

test('the live scheduler carries exactly the retrying, parked, and limits keys the view consumes', { timeout: 10000 }, async () => {
    const retryingSnapshot = await produceSnapshot({
        limits: { maxAttemptsPerItem: 5, maxDispatches: 20, maxTotalTokens: 100000, maxTotalUsd: 5 }
    });
    assert.equal(/** @type {Array<unknown>} */ (retryingSnapshot.retrying).length, 1, 'the failed first attempt is retrying');
    assert.deepEqual(Object.keys(firstRow(retryingSnapshot.retrying)).sort(), [...RETRYING_KEYS].sort());
    assertKeys({ value: retryingSnapshot.limits, keys: LIMITS_KEYS, label: 'live limits' });

    const parkedSnapshot = await produceSnapshot({ limits: { maxAttemptsPerItem: 1 } });
    assert.equal(/** @type {Array<unknown>} */ (parkedSnapshot.parked).length, 1, 'the exhausted item is parked');
    assert.deepEqual(Object.keys(firstRow(parkedSnapshot.parked)).sort(), [...PARKED_KEYS].sort());

    const retryingState = toStateResponse({ snapshot: retryingSnapshot, now: NOW });
    assert.deepEqual(Object.keys(firstRow(retryingState.retrying)).sort(), [...STATE_RETRYING_KEYS].sort());
    const parkedState = toStateResponse({ snapshot: parkedSnapshot, now: NOW });
    assert.deepEqual(Object.keys(firstRow(parkedState.parked)).sort(), [...STATE_PARKED_KEYS].sort());
    for (const row of [...retryingState.retrying, ...parkedState.parked, retryingState.limits]) {
        for (const [key, value] of Object.entries(row)) {
            assert.notEqual(value, undefined, `${key} must be projected`);
        }
    }
});

test('a fake { snapshot, refresh } runs the handler end to end with no scheduler', { timeout: 5000 }, async () => {
    const snapshot = createFixture();
    let refreshCalls = 0;
    const handler = createOperatorHttpHandler({
        getSnapshot: () => snapshot,
        refresh: async () => { refreshCalls += 1; },
        statusPath: null,
        now: () => NOW
    });
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {{port: number}} */ (server.address()).port;

    /**
     * @param {{method: string, path: string, headers?: Record<string,string>, body?: string}} arg0
     * @returns {Promise<{status: number|undefined, body: string}>}
     */
    const send = ({ method, path, headers = {}, body = '' }) => new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1', port, method, path, agent: false,
            headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
        }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        // A regression that leaves the handler silent must fail here, not hang.
        req.setTimeout(2000, () => req.destroy(new Error('response timeout')));
        req.end(body);
    });

    try {
        const state = await send({ method: 'GET', path: '/api/v1/state' });
        assert.equal(state.status, 200);
        const body = JSON.parse(state.body);
        assert.equal(body.counts.running, 1);
        assert.equal(body.running[0].url, 'https://tracker.example/MER-1');
        assert.equal(body.generatedAt, new Date(NOW).toISOString());

        const detail = await send({ method: 'GET', path: '/api/v1/items/MER-3' });
        assert.equal(detail.status, 200);
        assert.equal(JSON.parse(detail.body).status, 'parked');

        const refresh = await send({
            method: 'POST',
            path: '/api/v1/refresh',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(refresh.status, 202);
        assert.equal(refreshCalls, 1);
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});

test('the operator modules never import the scheduler and http.mjs never imports node:http', () => {
    const dir = new URL('../lib/agentic/operator/', import.meta.url);
    for (const name of ['http.mjs', 'index.mjs', 'ring.mjs', 'status.mjs', 'view.mjs']) {
        const source = readFileSync(new URL(name, dir), 'utf8');
        assert.ok(!/from\s+['"][^'"]*scheduler/.test(source), `${name} must not import the scheduler`);
        assert.ok(!/from\s+['"]node:http['"]/.test(source), `${name} must not import node:http`);
    }
    const httpSource = readFileSync(new URL('http.mjs', dir), 'utf8');
    assert.ok(!/createServer\s*\(/.test(httpSource), 'the handler must not create a server');
});
