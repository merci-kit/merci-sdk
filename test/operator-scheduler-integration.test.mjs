// @ts-check

/**
 * @file IR-2: the operator API boundary against the real `WorkScheduler`.
 * @version 0.12.0
 *
 * @description
 * Mounts the real `createOperatorHttpHandler` on a host `node:http` server and
 * reads the live state of a real `WorkScheduler` driven by a memory work
 * source, a memory claim store, a manual clock, a fake workspace manager, and a
 * fake workflow. One item stays running, one is queued for retry, and one is
 * parked, so `/state` must report counts that equal the live `snapshot()`
 * lengths and a running row that matches the live row field by field.
 *
 * The detail route is fed by a real `createEventRing` subscribed to the
 * scheduler's own emitter, so its `recentEvents` are the scheduler's records
 * for that identifier and carry no prose. The alias route answers the same
 * body, and a `workItemId` is not addressable (the identity rule). `POST
 * /refresh` must tick the real scheduler exactly once, and after `stop()` the
 * handler must answer `409 stopped` without a further tick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import {
    WorkScheduler,
    createMemoryClaimStore,
    createMemoryWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { createEventRing, createOperatorHttpHandler } from '../lib/agentic/operator/index.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';

const NOW = Date.parse('2026-11-09T18:00:00.000Z');
const NOW_ISO = '2026-11-09T18:00:00.000Z';
const RUNNING_IDENTIFIER = 'MER-RUN';
const RUNNING_WORK_ITEM_ID = 'wi-run';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

/**
 * A manual clock: timers are recorded and never fire on their own, so only an
 * explicit `tick()` or `refresh()` advances the scheduler.
 * @param {{now?: number}} [arg0] -
 * @returns {{
 *   now: () => number,
 *   setTimeout: (fn: () => void, ms: number) => number,
 *   clearTimeout: (handle: unknown) => void,
 *   timers: Map<number, {at: number, fn: () => void}>
 * }}
 */
function createClock({ now = NOW } = {}) {
    let current = now;
    let nextHandle = 1;
    /** @type {Map<number, {at: number, fn: () => void}>} */
    const timers = new Map();
    return {
        now: () => current,
        setTimeout: (fn, ms) => {
            const handle = nextHandle++;
            timers.set(handle, { at: current + ms, fn });
            return handle;
        },
        clearTimeout: (handle) => { if (typeof handle === 'number') timers.delete(handle); },
        timers
    };
}

/**
 * Let queued microtasks and `onSettled` continuations run.
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 8 } = {}) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * An in-memory stand-in for A's workspace manager: the scheduler's
 * `ensure`/`beforeRun`/`afterRun`/`remove`/`handleFor` seam is IR-1's and IR-4's
 * (real git); this file only needs a workspace path in the operator projection.
 * @returns {{
 *   ensure: (arg0: {workItemId: string, signal?: AbortSignal}) => Promise<Record<string, unknown>>,
 *   beforeRun: (arg0: {workspace: Record<string, unknown>, signal?: AbortSignal}) => Promise<void>,
 *   afterRun: (arg0: {workspace: Record<string, unknown>, outcome: string, signal?: AbortSignal}) => Promise<void>,
 *   remove: (arg0: {workspace: Record<string, unknown>, force?: boolean}) => Promise<{removed: boolean}>,
 *   handleFor: (arg0: {workItemId: string}) => Record<string, unknown>
 * }}
 */
function createWorkspaceManager() {
    /** @type {Map<string, Record<string, unknown>>} */
    const handles = new Map();
    /**
     * @param {{workItemId: string}} arg0 -
     * @returns {Record<string, unknown>}
     */
    function handleOrCreate({ workItemId }) {
        const existing = handles.get(workItemId);
        if (existing) return existing;
        const created = {
            workItemId,
            key: `ws-${workItemId}`,
            root: '/merci/workspaces',
            path: `/merci/workspaces/ws-${workItemId}`,
            strategy: 'directory',
            branch: null
        };
        handles.set(workItemId, created);
        return created;
    }
    return {
        ensure: async ({ workItemId }) => handleOrCreate({ workItemId }),
        beforeRun: async () => {},
        afterRun: async () => {},
        remove: async () => ({ removed: true }),
        handleFor: ({ workItemId }) => handleOrCreate({ workItemId })
    };
}

/**
 * @param {{id: string, identifier: string}} arg0 -
 * @returns {Record<string, unknown>}
 */
function rawItem({ id, identifier }) {
    return {
        id,
        identifier,
        title: `Title for ${identifier}`,
        description: 'LEAK-description-sentinel',
        state: 'Todo',
        dispatchable: true,
        url: `https://tracker.example/${identifier}`
    };
}

/**
 * The running item waits for its abort; the retry item fails once with a
 * transient code; the park item fails with the non-retryable workflow code.
 * @returns {{
 *   run: (arg0: {item: WorkItem, signal: AbortSignal}) => Promise<{status: string}>
 * }}
 */
function createWorkflow() {
    return {
        run: async ({ item, signal }) => {
            if (item.identifier === RUNNING_IDENTIFIER) {
                await new Promise((resolve) => {
                    if (signal.aborted) {
                        resolve(undefined);
                        return;
                    }
                    signal.addEventListener('abort', () => resolve(undefined), { once: true });
                });
                return { status: 'canceled' };
            }
            if (item.identifier === 'MER-PARK') {
                throw Object.assign(new Error('policy'), {
                    name: 'PolicyError',
                    code: 'MERCI-WORKFLOW-POLICY-ERR'
                });
            }
            throw Object.assign(new Error('transient'), { name: 'Error', code: 'E_TRANSIENT' });
        }
    };
}

/**
 * @param {{handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}} arg0 -
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
 * }} arg0 -
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

test('the operator API reads the live scheduler and ticks it once per refresh', { timeout: 5000 }, async () => {
    const clock = createClock();
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, now: () => clock.now() });
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({
            items: [
                rawItem({ id: RUNNING_WORK_ITEM_ID, identifier: RUNNING_IDENTIFIER }),
                rawItem({ id: 'wi-retry', identifier: 'MER-RETRY' }),
                rawItem({ id: 'wi-park', identifier: 'MER-PARK' })
            ]
        }),
        workflow: createWorkflow(),
        workspace: createWorkspaceManager(),
        claims: createMemoryClaimStore(),
        clock,
        // The real MerciEventEmitter is the intended sink; the ring assertions
        // below prove it received the scheduler's events.
        eventEmitter: emitter,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 3 },
        continuation: { delayMs: 0, max: 0 },
        pollIntervalMs: 60_000
    });
    const handler = createOperatorHttpHandler({
        getSnapshot: () => scheduler.snapshot(),
        // One macrotask of latency, so a handler that answers 202 without
        // awaiting the refresh fails the tick assertion below.
        refresh: async () => {
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            return scheduler.refresh();
        },
        recentEvents: ({ identifier = null, limit = null } = {}) => ring.list({
            identifier: typeof identifier === 'string' ? identifier : null,
            limit: typeof limit === 'number' ? limit : null
        }),
        now: () => clock.now()
    });
    const srv = await listen({ handler });
    try {
        await scheduler.start();
        await flush();
        const live = scheduler.snapshot();
        assert.equal(live.running.length, 1, 'one item is running');
        assert.equal(live.retrying.length, 1, 'one item is queued for retry');
        assert.equal(live.parked.length, 1, 'one item is parked');

        // GET /api/v1/state mirrors the live snapshot.
        const state = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(state.status, 200);
        const stateBody = JSON.parse(state.body);
        assert.equal(stateBody.counts.running, live.running.length);
        assert.equal(stateBody.counts.retrying, live.retrying.length);
        assert.equal(stateBody.counts.parked, live.parked.length);
        assert.equal(stateBody.generatedAt, NOW_ISO);
        assert.equal(new Date(stateBody.generatedAt).toISOString(), stateBody.generatedAt);
        assert.equal(stateBody.rateLimits, null);

        const liveRunning = live.running[0];
        const stateRunning = stateBody.running[0];
        assert.equal(stateRunning.identifier, liveRunning.identifier);
        assert.equal(stateRunning.workItemId, liveRunning.workItemId);
        assert.equal(stateRunning.url, liveRunning.url);
        assert.equal(stateRunning.threadId, liveRunning.threadId);
        assert.equal(stateRunning.identifier, RUNNING_IDENTIFIER);
        assert.equal(stateRunning.workItemId, RUNNING_WORK_ITEM_ID);
        assert.equal(stateRunning.url, `https://tracker.example/${RUNNING_IDENTIFIER}`);
        assert.equal(stateRunning.threadId, `work:${RUNNING_IDENTIFIER}`);
        assert.equal(stateRunning.workspacePath, liveRunning.workspacePath);
        assert.equal(stateRunning.workspacePath, `/merci/workspaces/ws-${RUNNING_IDENTIFIER}`);
        assert.equal(state.body.includes('LEAK'), false, 'no description in the state body');

        // GET /api/v1/items/<identifier> carries the live detail and the ring's events.
        const detail = await send({ port: srv.port, path: `/api/v1/items/${RUNNING_IDENTIFIER}` });
        assert.equal(detail.status, 200);
        const item = JSON.parse(detail.body);
        assert.equal(item.identifier, RUNNING_IDENTIFIER);
        assert.equal(item.workItemId, RUNNING_WORK_ITEM_ID);
        assert.equal(item.status, 'running');
        assert.equal(item.attempts.current, liveRunning.attempt);
        assert.ok(item.workspace, 'a workspace manager is present, so the path is projected');
        assert.equal(item.workspace.path, liveRunning.workspacePath);
        assert.ok(Array.isArray(item.recentEvents) && item.recentEvents.length > 0, 'the ring fed the detail');
        const recentEvents = /** @type {Array<Record<string, unknown>>} */ (item.recentEvents);
        for (const record of recentEvents) {
            assert.equal(record.identifier, RUNNING_IDENTIFIER, 'only this identifier\'s events');
            for (const prose of ['description', 'prompt', 'message', 'toolArgs']) {
                assert.equal(prose in record, false, `${prose} is never projected`);
            }
        }
        assert.ok(
            recentEvents.some((record) => record.event === 'work_item:dispatched'),
            'the dispatch this scheduler emitted is in the ring'
        );
        assert.equal(detail.body.includes('LEAK'), false, 'no description in the detail body');

        // The alias answers the same body.
        const alias = await send({ port: srv.port, path: `/api/v1/${RUNNING_IDENTIFIER}` });
        assert.equal(alias.status, 200);
        assert.deepEqual(JSON.parse(alias.body), item);

        // A provider id resolves too, so a UI built from the event feed can
        // open the row it just rendered.
        const byWorkItemId = await send({ port: srv.port, path: `/api/v1/items/${RUNNING_WORK_ITEM_ID}` });
        assert.equal(byWorkItemId.status, 200);
        assert.deepEqual(JSON.parse(byWorkItemId.body), item);

        // POST /refresh ticks the real scheduler exactly once.
        const ticksBefore = scheduler.snapshot().tickCount;
        const refresh = await send({
            port: srv.port,
            method: 'POST',
            path: '/api/v1/refresh',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(refresh.status, 202);
        const refreshed = JSON.parse(refresh.body);
        assert.equal(refreshed.queued, true);
        assert.equal(refreshed.coalesced, false);
        assert.deepEqual(refreshed.operations, ['poll', 'reconcile']);
        assert.equal(refreshed.requestedAt, NOW_ISO);
        assert.equal(scheduler.snapshot().tickCount, ticksBefore + 1, 'refresh() really ticked');

        // After stop: the state says stopped and a refresh is refused without a tick.
        await scheduler.stop({ timeoutMs: 2000 });
        const stoppedState = await send({ port: srv.port, path: '/api/v1/state' });
        assert.equal(stoppedState.status, 200);
        const stoppedBody = JSON.parse(stoppedState.body);
        assert.equal(stoppedBody.scheduler.stopped, true);
        assert.equal(stoppedBody.counts.running, 0);

        const ticksAtStop = scheduler.snapshot().tickCount;
        const refused = await send({
            port: srv.port,
            method: 'POST',
            path: '/api/v1/refresh',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(refused.status, 409);
        assert.equal(JSON.parse(refused.body).error.code, 'stopped');
        assert.equal(scheduler.snapshot().tickCount, ticksAtStop, 'a refused refresh never ticks');
    } finally {
        ring.stop();
        await scheduler.stop({ timeoutMs: 2000 });
        await srv.close();
    }
});
