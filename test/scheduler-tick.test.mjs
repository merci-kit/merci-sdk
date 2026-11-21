// @ts-check

/**
 * @file Stage 4 contract tests for scheduler state, tick, dispatch, and caps.
 * @version 0.12.0
 *
 * @description
 * Drives `WorkScheduler` with an in-memory work source, a fake workflow, a
 * capturing emitter, and a manual clock. The tests pin the eligibility matrix,
 * SCH-09/SCH-11 cap behavior, single-flight ticks, claim failure paths, tick
 * validation/source/stopped outcomes, preflight containment, applyConfig patch
 * semantics, lifecycle order, the snapshot shape, and the pure helpers in
 * `retry.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    WorkScheduler,
    CLAIM_STATES,
    SCHEDULER_DEFAULTS,
    createMemoryClaimStore,
    createMemoryWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ConfigurationError, SchedulerError } from '../lib/core/errors.mjs';
import {
    buildSnapshot,
    accumulateUsage,
    createTotals
} from '../lib/agentic/scheduler/state.mjs';
import {
    collectDuplicateIdentifiers,
    validateSchedulerConfig
} from '../lib/agentic/scheduler/validate.mjs';
import {
    failureEvidence,
    normalizeRunResult,
    retryDelayMs
} from '../lib/agentic/scheduler/retry.mjs';

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** @typedef {ConstructorParameters<typeof WorkScheduler>[0]} SchedulerOptions */
/** @typedef {import('../lib/agentic/scheduler/claims.mjs').ClaimStore} ClaimStore */

/**
 * @typedef {Object} CapturingEmitter
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/**
 * @returns {CapturingEmitter}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    return {
        events,
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {}
    };
}

/**
 * A manual clock: timers are recorded and only fire inside `advance`.
 * @param {{now?: number}} [arg0] -
 * @returns {{
 *   now: () => number,
 *   setTimeout: (fn: () => void, ms: number) => number,
 *   clearTimeout: (handle: unknown) => void,
 *   advance: (ms: number) => void,
 *   delays: number[],
 *   timers: Map<number, {at: number, fn: () => void}>
 * }}
 */
function createClock({ now = 1_000 } = {}) {
    let current = now;
    let nextHandle = 1;
    /** @type {number[]} */
    const delays = [];
    /** @type {Map<number, {at: number, fn: () => void}>} */
    const timers = new Map();
    return {
        now: () => current,
        setTimeout: (fn, ms) => {
            const handle = nextHandle++;
            delays.push(ms);
            timers.set(handle, { at: current + ms, fn });
            return handle;
        },
        clearTimeout: (handle) => { if (typeof handle === 'number') timers.delete(handle); },
        advance: (ms) => {
            current += ms;
            for (const [handle, timer] of [...timers.entries()]) {
                if (timer.at <= current) {
                    timers.delete(handle);
                    timer.fn();
                }
            }
        },
        delays,
        timers
    };
}

/**
 * @param {{value: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<{event: string, [key: string]: unknown}>}
 */
function eventsNamed({ value, name }) {
    return value.events.filter((entry) => entry.event === name);
}

/**
 * @param {{event: string, [key: string]: unknown}} entry -
 * @returns {Record<string, unknown>}
 */
function payloadOf(entry) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
        if (!ENVELOPE_KEYS.has(key)) out[key] = value;
    }
    return out;
}

/**
 * Let queued microtasks and `onSettled` continuations run.
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 5 } = {}) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * @param {{overrides?: Record<string, unknown>, url?: string|null}} [arg0] -
 * @returns {Record<string, unknown>}
 */
function rawItem({ overrides = {}, url = null } = {}) {
    return {
        id: 'id-1',
        identifier: 'MER-1',
        title: 'One',
        state: 'Todo',
        dispatchable: true,
        ...(url ? { url } : {}),
        ...overrides
    };
}

/**
 * The usage object every completed attempt reports.
 * @returns {{total_tokens: number, input_tokens: number, output_tokens: number, cost_usd: number}}
 */
function usage() {
    return { total_tokens: 10, input_tokens: 6, output_tokens: 4, cost_usd: 0.01 };
}

/**
 * @param {Record<string, unknown>} [overrides] -
 * @returns {Record<string, unknown>}
 */
function completedResult(overrides = {}) {
    return { status: 'completed', usage: usage(), ...overrides };
}

/**
 * @param {{run?: (arg0: {item: unknown, attempt: number, signal: AbortSignal, reportProgress: () => void}) => Promise<unknown>}} [arg0] -
 * @returns {{calls: Array<{item: unknown, attempt: number, signal: AbortSignal, reportProgress: () => void}>, run: (arg0: {item: unknown, attempt: number, signal: AbortSignal, reportProgress: () => void}) => Promise<unknown>}}
 */
function createWorkflow({ run } = {}) {
    /** @type {Array<{item: unknown, attempt: number, signal: AbortSignal, reportProgress: () => void}>} */
    const calls = [];
    return {
        calls,
        run: async (input) => {
            calls.push(input);
            return run ? run(input) : completedResult();
        }
    };
}

/**
 * @returns {{promise: Promise<unknown>, resolve: (value: unknown) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * A scheduler whose first tick already ran over an empty board; push items into
 * `items` afterwards and drive `tick()` yourself.
 * @param {{
 *   items?: unknown[],
 *   options?: SchedulerOptions,
 *   workflow?: ReturnType<typeof createWorkflow>,
 *   claims?: ClaimStore|null,
 *   clock?: ReturnType<typeof createClock>
 * }} [arg0] -
 * @returns {Promise<{
 *   scheduler: WorkScheduler,
 *   emitter: CapturingEmitter,
 *   clock: ReturnType<typeof createClock>,
 *   source: { fetchByStates: Function, fetchByIds: Function },
 *   workflow: ReturnType<typeof createWorkflow>,
 *   items: unknown[]
 * }>}
 */
async function setup({ items = [], options = {}, workflow, claims, clock: injectedClock } = {}) {
    const emitter = createEmitter();
    const clock = injectedClock ?? createClock();
    const source = createMemoryWorkSource({ items, eventEmitter: emitter });
    const wf = workflow ?? createWorkflow();
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow: wf,
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        // B5 settle: a single attempt settles to a terminal state under these
        // defaults, so a B4 test that is not about retries keeps its intent.
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        ...(claims ? { claims } : {}),
        ...options
    });
    await scheduler.start();
    emitter.events.length = 0;
    return { scheduler, emitter, clock, source, workflow: wf, items };
}

test('exports the stage-4 surface and the 13 event leaves', async () => {
    assert.ok(Object.isFrozen(CLAIM_STATES));
    assert.deepEqual(Object.values(CLAIM_STATES), ['unclaimed', 'claimed', 'running', 'retry_queued', 'parked', 'released']);
    assert.ok(Object.isFrozen(SCHEDULER_DEFAULTS));
    assert.equal(SCHEDULER_DEFAULTS.pollIntervalMs, 30_000);
    assert.equal(SCHEDULER_DEFAULTS.stallTimeoutMs, 900_000);
    assert.deepEqual({ ...SCHEDULER_DEFAULTS.retry }, { baseMs: 10_000, maxMs: 300_000 });
    assert.deepEqual({ ...SCHEDULER_DEFAULTS.continuation }, { delayMs: 1_000, max: 3 });
    assert.deepEqual({ ...SCHEDULER_DEFAULTS.concurrency }, { global: 1 });
    assert.deepEqual({ ...SCHEDULER_DEFAULTS.limits }, { maxAttemptsPerItem: 5 });

    assert.deepEqual(
        Object.values(EVENTS.SCHEDULER),
        [
            'scheduler:start',
            'scheduler:stop',
            'scheduler:tick',
            'scheduler:validation_error',
            'scheduler:work_source_error',
            'scheduler:budget_exhausted',
            'scheduler:internal_error',
            'scheduler:configured'
        ]
    );
    assert.equal(EVENTS.WORK_ITEM.SKIPPED, 'work_item:skipped');
    assert.equal(EVENTS.WORK_ITEM.CLAIMED, 'work_item:claimed');
    assert.equal(EVENTS.WORK_ITEM.CLAIM_FAILED, 'work_item:claim_failed');
    assert.equal(EVENTS.WORK_ITEM.DISPATCHED, 'work_item:dispatched');
    assert.equal(EVENTS.WORK_ITEM.COMPLETED, 'work_item:completed');
    assert.equal(EVENTS.WORK_ITEM.FAILED, 'work_item:failed');
    assert.equal(EVENTS.WORK_ITEM.RELEASED, 'work_item:released');
});

test('priority order and the global cap: the highest priority dispatches first, the rest wait', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items, workflow: wf } = await setup({
        workflow,
        options: { concurrency: { global: 1 } }
    });
    items.push(
        rawItem({ overrides: { id: 'id-2', identifier: 'MER-2', priority: 2 } }),
        rawItem({ overrides: { id: 'id-1', identifier: 'MER-1', priority: 1 } })
    );

    await scheduler.tick();

    assert.equal(wf.calls.length, 1);
    assert.equal(/** @type {{item: {identifier: string}}} */ (wf.calls[0]).item.identifier, 'MER-1');
    const dispatched = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.DISPATCHED });
    assert.equal(dispatched.length, 1);

    gate.resolve(completedResult());
    await flush();
    assert.equal(scheduler.snapshot().running.length, 0);
});

test('a full lane skips the item and continues the scan; an unlisted lane uses the global pool', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, items, workflow: wf } = await setup({
        workflow,
        options: { concurrency: { global: 3, byLane: { review: 1 } }, allowSharedWorkspace: true }
    });
    items.push(
        rawItem({ overrides: { id: 'id-r1', identifier: 'R1', lane: 'review', priority: 1 } }),
        rawItem({ overrides: { id: 'id-r2', identifier: 'R2', lane: 'review', priority: 2 } }),
        rawItem({ overrides: { id: 'id-d1', identifier: 'D1', lane: 'default', priority: 3 } })
    );

    await scheduler.tick();

    // R2 hits the full review lane before D1 is scanned: only `continue` reaches
    // D1, a `break` would stop the scan at R2.
    const identifiers = wf.calls.map((call) => /** @type {{identifier: string}} */ (call.item).identifier);
    assert.deepEqual(identifiers, ['R1', 'D1'], 'the lane-full item is skipped, not a full stop');

    gate.resolve(completedResult());
    await flush();
});

test('eligibility: inactive/terminal state, dispatchable, labels, filter, and already-running items are skipped', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const accepted = [];
    const { scheduler, emitter, items, workflow: wf } = await setup({
        workflow,
        options: {
            requiredLabels: ['agent'],
            filter: (/** @type {{item: {identifier: string}}} */ arg0) => arg0.item.identifier !== 'FILTERED'
        }
    });
    items.push(
        rawItem({ overrides: { id: 'i1', identifier: 'DONE', state: 'Done' } }),
        rawItem({ overrides: { id: 'i2', identifier: 'OTHER', state: 'Backlog' } }),
        rawItem({ overrides: { id: 'i3', identifier: 'NODISPATCH', dispatchable: false, labels: ['agent'] } }),
        rawItem({ overrides: { id: 'i4', identifier: 'NOLABEL', labels: ['other'] } }),
        rawItem({ overrides: { id: 'i5', identifier: 'FILTERED', labels: ['agent'] } }),
        rawItem({ overrides: { id: 'i6', identifier: 'OK', labels: ['agent'] } })
    );

    await scheduler.tick();
    for (const call of wf.calls) {
        accepted.push(/** @type {{identifier: string}} */ (call.item).identifier);
    }
    assert.deepEqual(accepted, ['OK']);

    // Still running: a second tick must not dispatch it again.
    emitter.events.length = 0;
    await scheduler.tick();
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 0);
    assert.equal(wf.calls.length, 1);

    gate.resolve(completedResult());
    await flush();
});

test('duplicate identifiers fail closed for the tick; other items still dispatch', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items, workflow: wf } = await setup({
        workflow,
        // Two slots: without the exclusion both duplicates fill them and MER-10
        // never dispatches, so the cap cannot hide a missing exclusion.
        options: { concurrency: { global: 2 }, allowSharedWorkspace: true }
    });
    items.push(
        rawItem({ overrides: { id: 'd1', identifier: 'MER-9', priority: 1 } }),
        rawItem({ overrides: { id: 'd2', identifier: ' mer-9 ', priority: 1 } }),
        rawItem({ overrides: { id: 'd3', identifier: 'MER-10', priority: 2 } })
    );

    await scheduler.tick();

    assert.deepEqual(
        wf.calls.map((call) => /** @type {{identifier: string}} */ (call.item).identifier),
        ['MER-10']
    );
    const validation = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.VALIDATION_ERROR });
    assert.equal(validation.length, 1);
    const errors = /** @type {string[]} */ (payloadOf(validation[0]).errors);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^duplicate_identifier: MER-9$/);

    gate.resolve(completedResult());
    await flush();
});

test('claim acquisition failure and a throwing claim store skip the item without failing the tick', async () => {
    const refused = createWorkflow();
    let deniedReleases = 0;
    const denyStore = {
        acquire: async () => false,
        release: async () => { deniedReleases += 1; return true; },
        isClaimed: async () => false,
        list: async () => []
    };
    const first = await setup({ workflow: refused, claims: /** @type {ClaimStore} */ (denyStore) });
    first.items.push(rawItem());
    await first.scheduler.tick();

    assert.equal(refused.calls.length, 0);
    const failedEvents = eventsNamed({ value: first.emitter, name: EVENTS.WORK_ITEM.CLAIM_FAILED });
    assert.equal(failedEvents.length, 1);
    assert.equal(payloadOf(failedEvents[0]).reason, 'not_acquired');
    assert.equal(deniedReleases, 0, 'a claim that was never acquired is never released');
    assert.equal(eventsNamed({ value: first.emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0);
    const tickEvent = eventsNamed({ value: first.emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(payloadOf(/** @type {{event: string, [key: string]: unknown}} */ (tickEvent)).outcome, 'ok');

    const throwing = createWorkflow();
    let throwingReleases = 0;
    const throwStore = {
        acquire: async () => { throw new Error('provider payload secret'); },
        release: async () => { throwingReleases += 1; return true; },
        isClaimed: async () => false,
        list: async () => []
    };
    const second = await setup({ workflow: throwing, claims: /** @type {ClaimStore} */ (throwStore) });
    second.items.push(rawItem());
    await second.scheduler.tick();

    assert.equal(throwing.calls.length, 0);
    const throwEvents = eventsNamed({ value: second.emitter, name: EVENTS.WORK_ITEM.CLAIM_FAILED });
    assert.equal(throwEvents.length, 1);
    assert.equal(payloadOf(throwEvents[0]).reason, 'error');
    assert.equal(throwingReleases, 0, 'a throwing acquire released nothing');
    assert.equal(eventsNamed({ value: second.emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0);
    assert.equal(JSON.stringify(throwEvents[0]).includes('provider payload secret'), false);
});

test('work_item:claimed is emitted only on the transition into the claimed set', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());

    await scheduler.tick();
    await scheduler.tick();

    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.CLAIMED }).length, 1);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 1);

    gate.resolve(completedResult());
    await flush();
});

test('single-flight: a second tick while the first awaits the claim emits in_flight and dispatches nothing', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow();
    const slowStore = {
        acquire: async () => { await gate.promise; return true; },
        release: async () => true,
        isClaimed: async () => false,
        list: async () => []
    };
    const { scheduler, emitter, items } = await setup({
        workflow,
        claims: /** @type {ClaimStore} */ (slowStore),
        options: { concurrency: { global: 2 }, allowSharedWorkspace: true }
    });
    items.push(
        rawItem({ overrides: { id: 's1', identifier: 'S1' } }),
        rawItem({ overrides: { id: 's2', identifier: 'S2' } })
    );

    const firstTick = scheduler.tick();
    await flush();
    emitter.events.length = 0;

    await scheduler.tick();
    const inFlight = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK });
    assert.equal(inFlight.length, 1);
    assert.equal(payloadOf(inFlight[0]).outcome, 'in_flight');

    gate.resolve(undefined);
    await firstTick;
    assert.equal(workflow.calls.length, 2);
    await flush();
    assert.equal(workflow.calls.length, 2);
});

test('a concurrent tick cannot overshoot the global cap (SCH-09)', { timeout: 5000 }, async () => {
    const claimGate = deferred();
    const runGate = deferred();
    const workflow = createWorkflow({ run: async () => runGate.promise });
    const slowStore = {
        acquire: async () => { await claimGate.promise; return true; },
        release: async () => true,
        isClaimed: async () => false,
        list: async () => []
    };
    const { scheduler, items, workflow: wf } = await setup({
        workflow,
        claims: /** @type {ClaimStore} */ (slowStore),
        options: { concurrency: { global: 2 }, allowSharedWorkspace: true }
    });
    items.push(
        rawItem({ overrides: { id: 'c1', identifier: 'C1', priority: 1 } }),
        rawItem({ overrides: { id: 'c2', identifier: 'C2', priority: 2 } }),
        rawItem({ overrides: { id: 'c3', identifier: 'C3', priority: 3 } })
    );

    const firstTick = scheduler.tick();
    await flush();
    await scheduler.tick();
    claimGate.resolve(undefined);
    await firstTick;

    assert.equal(wf.calls.length, 2);
    runGate.resolve(completedResult());
    await flush();
    assert.equal(scheduler.snapshot().running.length, 0);
});

test('tick-time validation failures and source failures end the tick with a typed outcome', async () => {
    const activeStates = ['Todo'];
    const { scheduler, emitter, source, items } = await setup({ options: { activeStates } });
    items.push(rawItem());
    activeStates.length = 0;

    await scheduler.tick();
    const validationTicks = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK });
    assert.equal(validationTicks.length, 1, 'exactly one tick event on the validation-error path');
    assert.equal(payloadOf(/** @type {{event: string, [key: string]: unknown}} */ (validationTicks[0])).outcome, 'validation_error');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.VALIDATION_ERROR }).length, 1);

    activeStates.push('Todo');
    source.fetchByStates = () => {
        throw Object.assign(new Error('tracker down'), { category: 'tracker_request' });
    };
    await scheduler.tick();
    const sourceTick = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(payloadOf(/** @type {{event: string, [key: string]: unknown}} */ (sourceTick)).outcome, 'source_error');
    const sourceErrors = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR });
    assert.equal(sourceErrors.length, 1);
    assert.deepEqual(payloadOf(sourceErrors[0]), { op: 'fetchByStates', category: 'tracker_request' });
});

test('a non-ok tick still reports the live running and claimed counts', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const activeStates = ['Todo'];
    const { scheduler, emitter, items } = await setup({ workflow, options: { activeStates } });
    items.push(rawItem());

    await scheduler.tick();
    assert.equal(scheduler.snapshot().running.length, 1);
    emitter.events.length = 0;

    activeStates.length = 0;
    await scheduler.tick();

    const ticks = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK });
    assert.equal(ticks.length, 1);
    const payload = payloadOf(ticks[0]);
    assert.equal(payload.outcome, 'validation_error');
    assert.equal(payload.fetched, 0);
    assert.equal(payload.dispatched, 0);
    assert.equal(payload.running, 1);
    assert.equal(payload.claimed, 1);

    gate.resolve(completedResult());
    await flush();
});

test('a stopped scheduler only emits a stopped tick', async () => {
    const { scheduler, emitter } = await setup();
    await scheduler.stop({ reason: 'test' });
    emitter.events.length = 0;

    await scheduler.tick();
    const ticks = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK });
    assert.equal(ticks.length, 1);
    assert.equal(payloadOf(ticks[0]).outcome, 'stopped');
    assert.equal(payloadOf(ticks[0]).fetched, 0);
});

test('concurrency above 1 without a workspace refuses to start unless allowSharedWorkspace is set', async () => {
    const emitter = createEmitter();
    const clock = createClock();
    const source = createMemoryWorkSource({ items: [], eventEmitter: emitter });
    const base = {
        workSource: source,
        workflow: createWorkflow(),
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done']
    };

    await assert.rejects(
        new WorkScheduler({ ...base, concurrency: { global: 2 } }).start(),
        (err) => err instanceof ConfigurationError
    );

    const shared = new WorkScheduler({ ...base, concurrency: { global: 2 }, allowSharedWorkspace: true });
    await shared.start();
    await shared.stop();
});

test('preflight blocks dispatch without rejecting the tick, and a cleared result resumes', async () => {
    /** @type {string[]} */ let blocked = [];
    const workflow = createWorkflow();
    const { scheduler, emitter, items } = await setup({
        workflow,
        options: { preflight: () => blocked }
    });
    items.push(rawItem());
    blocked = ['policy is stale'];

    await scheduler.tick();
    assert.equal(workflow.calls.length, 0);
    const validation = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.VALIDATION_ERROR });
    assert.equal(validation.length, 1);
    assert.deepEqual(payloadOf(validation[0]).errors, ['policy is stale']);
    const blockedTick = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(payloadOf(/** @type {{event: string, [key: string]: unknown}} */ (blockedTick)).outcome, 'validation_error');

    blocked = [];
    await scheduler.tick();
    assert.equal(workflow.calls.length, 1);
    await flush();
});

test('W1-9 a due retry refused by preflight keeps its attempt and its budget', async () => {
    /** @type {string[]} */
    let blocked = [];
    let breakOnNextRetryFetch = false;
    /** @type {Array<number|null>} */
    const attempts = [];
    const emitter = createEmitter();
    const clock = createClock();
    /** @type {Array<Record<string, unknown>>} */
    const items = [];
    const baseSource = createMemoryWorkSource({ items, eventEmitter: emitter });
    /**
     * The scheduler's work-source contract, narrowed to what this fake reads:
     * each call forwards to the memory source and returns its records as-is.
     * @type {{
     *   fetchByStates: (arg0: {states: Array<string>, signal?: AbortSignal}) => ReturnType<typeof baseSource.fetchByStates>,
     *   fetchByIds: (arg0: {ids: Array<string>, signal?: AbortSignal}) => ReturnType<typeof baseSource.fetchByIds>
     * }}
     */
    const source = {
        fetchByStates: (/** @type {{states: Array<string>, signal?: AbortSignal}} */ arg0) => baseSource.fetchByStates(arg0),
        fetchByIds: (/** @type {{ids: Array<string>, signal?: AbortSignal}} */ arg0) => {
            // The contract breaks inside the host call: after this tick's
            // preflight and before the retry's claim.
            if (breakOnNextRetryFetch) {
                breakOnNextRetryFetch = false;
                blocked = ['the contract broke mid-tick'];
            }
            return baseSource.fetchByIds(arg0);
        }
    };
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow: {
            run: async (/** @type {{attempt: number|null}} */ input) => {
                attempts.push(input.attempt);
                return attempts.length === 1
                    ? { status: 'failed', error: new Error('transient') }
                    : completedResult();
            }
        },
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        retry: { baseMs: 0, maxMs: 0 },
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 3 },
        preflight: () => blocked,
        pollIntervalMs: 60_000
    });
    await scheduler.start();
    emitter.events.length = 0;
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    assert.deepEqual(attempts, [1], 'the first attempt failed');
    assert.deepEqual(scheduler.snapshot().retrying.map((entry) => entry.attempt), [2]);

    breakOnNextRetryFetch = true;
    await scheduler.tick();
    await flush();
    assert.deepEqual(scheduler.snapshot().retrying.map((entry) => entry.attempt), [2],
        'the refused retry is put back with its attempt, not refunded');
    const claimFailed = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.CLAIM_FAILED })
        .map((entry) => payloadOf(entry).reason);
    assert.deepEqual(claimFailed, ['preflight'], 'the refusal is its own honest signal');
    const released = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED })
        .map((entry) => payloadOf(entry).reason);
    assert.deepEqual(released, [], 'no claim was taken, so none was lost');

    blocked = [];
    await scheduler.tick();
    await flush();
    assert.deepEqual(attempts, [1, 2], 'the retry keeps its number instead of restarting at 1');
    assert.ok(attempts.length <= 3, 'the attempt budget was not exceeded');
});

test('a throwing preflight is contained as scheduler:internal_error and never rejects tick()', async () => {
    let throwNow = false;
    const { scheduler, emitter, items } = await setup({
        options: {
            preflight: () => {
                if (throwNow) throw new Error('preflight secret');
                return [];
            }
        }
    });
    items.push(rawItem());
    throwNow = true;

    await scheduler.tick();
    const internal = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR });
    assert.equal(internal.length, 1);
    const payload = payloadOf(internal[0]);
    assert.equal(payload.op, 'preflight');
    assert.equal(JSON.stringify(internal[0]).includes('preflight secret'), false);
    const tickEvent = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(payloadOf(/** @type {{event: string, [key: string]: unknown}} */ (tickEvent)).outcome, 'validation_error');

    throwNow = false;
    await scheduler.tick();
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 1);
    await flush();
});

test('start() fails with the preflight errors and with a throwing preflight', async () => {
    const emitter = createEmitter();
    const clock = createClock();
    const source = createMemoryWorkSource({ items: [], eventEmitter: emitter });
    const base = {
        workSource: source,
        workflow: createWorkflow(),
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done']
    };

    const refusing = new WorkScheduler({ ...base, preflight: () => ['blocked by host'] });
    await assert.rejects(refusing.start(), (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(/** @type {Error} */ (err).message, /blocked by host/);
        return true;
    });
    assert.equal(refusing.snapshot().started, false, '#starting was cleared');

    const throwing = new WorkScheduler({ ...base, preflight: () => { throw new Error('nope'); } });
    await assert.rejects(throwing.start(), (err) => err instanceof ConfigurationError);
});

test('applyConfig changes a live poll interval, reports sorted changed keys, and reschedules', async () => {
    const { scheduler, emitter, clock } = await setup({ options: { allowSharedWorkspace: true } });

    const result = await scheduler.applyConfig({
        options: { pollIntervalMs: 1_000, concurrency: { global: 2 } }
    });
    assert.deepEqual(result, { applied: true, deferred: false, changed: ['concurrency', 'pollIntervalMs'] });
    assert.equal(clock.delays.at(-1), 1_000);
    assert.equal(scheduler.snapshot().pollIntervalMs, 1_000);

    const configured = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.CONFIGURED });
    assert.equal(configured.length, 1);
    assert.deepEqual(payloadOf(configured[0]), { source: 'reload', changed: ['concurrency', 'pollIntervalMs'] });

    emitter.events.length = 0;
    const empty = await scheduler.applyConfig({ options: { pollIntervalMs: 1_000 } });
    assert.deepEqual(empty, { applied: false, deferred: false, changed: [] });
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.CONFIGURED }).length, 0);
});

test('applyConfig rejects bound options and leaves the current config and timer untouched when invalid', async () => {
    const { scheduler, clock } = await setup();
    const timerCount = clock.timers.size;

    await assert.rejects(
        scheduler.applyConfig({ options: { workSource: createMemoryWorkSource({ items: [] }) } }),
        (err) => err instanceof SchedulerError && err.reason === 'bound_option'
    );
    assert.equal(clock.timers.size, timerCount);

    await assert.rejects(
        scheduler.applyConfig({ options: { pollIntervalMs: 0 } }),
        (err) => err instanceof ConfigurationError
    );
    assert.equal(clock.timers.size, timerCount);
    assert.equal(scheduler.snapshot().pollIntervalMs, SCHEDULER_DEFAULTS.pollIntervalMs);
});

test('applyConfig during a tick is deferred and applied once at the next tick start', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow();
    const slowStore = {
        acquire: async () => { await gate.promise; return true; },
        release: async () => true,
        isClaimed: async () => false,
        list: async () => []
    };
    const { scheduler, emitter, clock, items } = await setup({
        workflow,
        claims: /** @type {ClaimStore} */ (slowStore)
    });
    items.push(rawItem());

    const tickPromise = scheduler.tick();
    await flush();
    emitter.events.length = 0;

    const deferredResult = await scheduler.applyConfig({ options: { pollIntervalMs: 2_000 } });
    assert.deepEqual(deferredResult, { applied: false, deferred: true, changed: ['pollIntervalMs'] });
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.CONFIGURED }).length, 0);

    gate.resolve(undefined);
    await tickPromise;
    assert.equal(scheduler.snapshot().pollIntervalMs, SCHEDULER_DEFAULTS.pollIntervalMs);

    await scheduler.tick();
    assert.equal(scheduler.snapshot().pollIntervalMs, 2_000);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.CONFIGURED }).length, 1);
    assert.equal(clock.delays.at(-1), 2_000);
    await flush();
});

test('a deferred patch that would merge invalid is refused and leaves the queue untouched', { timeout: 5000 }, async () => {
    const gate = deferred();
    const slowStore = {
        acquire: async () => { await gate.promise; return true; },
        release: async () => true,
        isClaimed: async () => false,
        list: async () => []
    };
    const { scheduler, items } = await setup({
        claims: /** @type {ClaimStore} */ (slowStore),
        options: { terminalStates: ['Canceled'] }
    });
    items.push(rawItem());

    const tickPromise = scheduler.tick();
    await flush();

    const first = await scheduler.applyConfig({ options: { activeStates: ['Done'] } });
    assert.deepEqual(first, { applied: false, deferred: true, changed: ['activeStates'] });

    // Individually valid, but `activeStates` and `terminalStates` would overlap.
    await assert.rejects(
        scheduler.applyConfig({ options: { terminalStates: ['Done'] } }),
        (err) => err instanceof ConfigurationError
    );

    gate.resolve(undefined);
    await tickPromise;
    await flush();

    // The rejected patch was never queued: the first patch still applies alone.
    await scheduler.tick();
    const snapshot = scheduler.snapshot();
    assert.deepEqual(snapshot.activeStates, ['Done']);
    assert.deepEqual(snapshot.terminalStates, ['Canceled']);
    await scheduler.stop();
});

test('applyConfig requires start and refuses after stop; refresh requires start', async () => {
    const emitter = createEmitter();
    const clock = createClock();
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items: [], eventEmitter: emitter }),
        workflow: createWorkflow(),
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done']
    });

    await assert.rejects(scheduler.tick(), (err) => err instanceof SchedulerError && err.reason === 'not_started');
    await assert.rejects(scheduler.refresh(), (err) => err instanceof SchedulerError && err.reason === 'not_started');
    await assert.rejects(
        scheduler.applyConfig({ options: { pollIntervalMs: 1_000 } }),
        (err) => err instanceof SchedulerError && err.reason === 'not_started'
    );

    await scheduler.start();
    await scheduler.stop();
    await assert.rejects(
        scheduler.applyConfig({ options: { pollIntervalMs: 1_000 } }),
        (err) => err instanceof SchedulerError && err.reason === 'stopped'
    );
});

test('a second start throws already_started', async () => {
    const { scheduler } = await setup();
    await assert.rejects(scheduler.start(), (err) => err instanceof SchedulerError && err.reason === 'already_started');
});

test('stop drains a running attempt, clears the timer, and reports the counts', async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        })
    });
    const { scheduler, clock, emitter, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    assert.equal(scheduler.snapshot().running.length, 1);

    const result = await scheduler.stop({ reason: 'test' });
    assert.deepEqual(result, { drained: true, running: 0, retrying: 0, parked: 0 });
    assert.equal(clock.timers.size, 0);

    const stopEvent = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.STOP });
    assert.equal(stopEvent.length, 1);
    assert.deepEqual(payloadOf(stopEvent[0]), { reason: 'test', running: 0, retrying: 0, parked: 0, drained: true });
});

test('a stop that makes the engine reject with an AbortError is not a failure', async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        })
    });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    assert.equal(scheduler.snapshot().running.length, 1);

    await scheduler.stop({ reason: 'test' });

    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.stopped, true, 'the operator-visible snapshot shows the stop');
    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.totals.attempts, 1);
    assert.equal(snapshot.totals.failures, 0, 'a host stop is not a failure');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.FAILED }).length, 0);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.STOP }).length, 1);
});

test('cancelItem during a run that rejects with an AbortError is not a failure', async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('canceled'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        })
    });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    assert.equal(scheduler.snapshot().running.length, 1);

    const cancel = await scheduler.cancelItem({ identifier: 'MER-1' });
    assert.deepEqual(cancel, { canceled: true, status: 'running' });
    await flush();

    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.totals.attempts, 1);
    assert.equal(snapshot.totals.failures, 0, 'a host cancel is not a failure');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.FAILED }).length, 0);
    assert.equal(snapshot.running.length, 0);
    assert.deepEqual(snapshot.claimed, ['MER-1'], 'the cancel keeps the claim, per the existing contract');
    assert.equal(snapshot.parked.length, 1);
    assert.equal(snapshot.parked[0].reason, 'canceled');
});

test('stop during the first tick resolves with the counts and clears the timer', async () => {
    const gate = deferred();
    const workflow = createWorkflow();
    const slowStore = {
        acquire: async () => { await gate.promise; return true; },
        release: async () => true,
        isClaimed: async () => false,
        list: async () => []
    };
    const emitter = createEmitter();
    const clock = createClock();
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items: [rawItem()], eventEmitter: emitter }),
        workflow,
        claims: /** @type {ClaimStore} */ (slowStore),
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done']
    });

    const startPromise = scheduler.start();
    await flush();
    const result = await scheduler.stop({ timeoutMs: 1_000 });
    assert.deepEqual(result, { drained: true, running: 0, retrying: 0, parked: 0 });
    assert.equal(clock.timers.size, 0);

    gate.resolve(undefined);
    await startPromise;
    await flush();
});

test('a parked claim is released exactly once, by stop, inside the store gate', { timeout: 5000 }, async () => {
    const releaseGate = deferred();
    let releaseCalls = 0;
    const gatedStore = {
        acquire: async () => true,
        release: async () => { releaseCalls += 1; await releaseGate.promise; return true; },
        isClaimed: async () => false,
        list: async () => []
    };
    const workflow = createWorkflow({ run: async () => completedResult() });
    const { scheduler, emitter, items } = await setup({ workflow, claims: /** @type {ClaimStore} */ (gatedStore) });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    assert.equal(releaseCalls, 0, 'a completed attempt parks and keeps its claim; settle does not release');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);

    const stopping = scheduler.stop({ timeoutMs: 1_000 });
    await flush();
    assert.equal(releaseCalls, 1, 'stop owns the only release and is inside the store gate');
    releaseGate.resolve(true);
    await stopping;
    await flush();

    assert.equal(releaseCalls, 1, 'the release is never repeated');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 1);
    assert.deepEqual(scheduler.snapshot().claimed, []);
});

test('snapshot matches the documented shape, running row fields, totals, and claimed cleanup', async () => {
    const gate = deferred();
    const clock = createClock();
    const workflow = createWorkflow({
        run: async () => {
            clock.advance(2_000);
            return gate.promise;
        }
    });
    const { scheduler, items } = await setup({ workflow, clock });
    items.push(rawItem({ url: 'https://tracker.example/MER-1' }));

    await scheduler.tick();
    const runningSnapshot = scheduler.snapshot();
    assert.deepEqual(Object.keys(runningSnapshot).sort(), [
        'activeStates', 'claimed', 'completed', 'lastOutcome', 'lastTickAt', 'limits', 'parked',
        'pollIntervalMs', 'retrying', 'running', 'started', 'stopped', 'terminalStates',
        'tickCount', 'totals'
    ]);
    assert.equal(runningSnapshot.lastOutcome, 'ok', 'the outcome is on the snapshot the operator reads');
    assert.equal(runningSnapshot.running.length, 1);
    assert.deepEqual(Object.keys(runningSnapshot.running[0]).sort(), [
        'attempt', 'identifier', 'lane', 'lastProgressAt', 'priority', 'startedAt',
        'state', 'threadId', 'url', 'workItemId', 'workspacePath'
    ]);
    assert.equal(runningSnapshot.running[0].url, 'https://tracker.example/MER-1');
    assert.equal(runningSnapshot.running[0].threadId, 'work:MER-1');
    assert.equal(runningSnapshot.running[0].workspacePath, null);

    gate.resolve(completedResult());
    await flush();

    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.running.length, 0);
    assert.deepEqual(snapshot.claimed, ['MER-1'], 'a completed item keeps its claim while parked');
    assert.equal(snapshot.parked.length, 1);
    assert.equal(snapshot.parked[0].reason, 'continuations_disabled');
    assert.deepEqual(snapshot.completed, ['MER-1']);
    assert.equal(snapshot.totals.dispatches, 1);
    assert.equal(snapshot.totals.attempts, 1);
    assert.equal(snapshot.totals.failures, 0);
    assert.equal(snapshot.totals.inputTokens, 6);
    assert.equal(snapshot.totals.outputTokens, 4);
    assert.equal(snapshot.totals.totalTokens, 10);
    assert.equal(snapshot.totals.costUsd, 0.01);
    assert.equal(snapshot.totals.usageComplete, true);
    assert.equal(snapshot.totals.costComplete, true);
    assert.ok(snapshot.totals.secondsRunning >= 0);
});

test('a settled attempt that reports prompt_tokens fills inputTokens and totalTokens', async () => {
    const workflow = createWorkflow({
        run: async () => ({ status: 'completed', usage: { prompt_tokens: 6, completion_tokens: 4 } })
    });
    const { scheduler, items } = await setup({ workflow });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const totals = scheduler.snapshot().totals;
    assert.equal(totals.inputTokens, 6, 'inputTokens fills from the engine spelling');
    assert.equal(totals.outputTokens, 4);
    assert.equal(totals.totalTokens, 10, 'totalTokens derives when the engine omits it');
    assert.equal(totals.costComplete, false, 'an unreported cost stays unknown');
});

test('a missing url is null on the running row and a completed attempt parks its claim', async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());

    await scheduler.tick();
    assert.equal(scheduler.snapshot().running[0].url, null);

    gate.resolve(completedResult());
    await flush();

    const completed = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.COMPLETED });
    const released = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED });
    const parked = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(completed.length, 1);
    assert.equal(released.length, 0, 'completion keeps the claim; it is not released');
    assert.equal(parked.length, 1);
    assert.equal(payloadOf(parked[0]).reason, 'continuations_disabled');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
    assert.equal(JSON.stringify(completed[0]).includes('"title"'), false);
    assert.equal(JSON.stringify(completed[0]).includes('One'), false);
});

test('a non-retryable failure emits work_item:failed then work_item:parked, never released', async () => {
    const workflow = createWorkflow({
        run: async () => {
            throw Object.assign(new Error('boom secret'), { code: 'PERMISSION_DENIED' });
        }
    });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const failed = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(payloadOf(failed[0]).failureClass, 'permission_block');
    assert.equal(payloadOf(failed[0]).errorName, 'Error');
    assert.equal(payloadOf(failed[0]).errorCode, 'PERMISSION_DENIED');
    assert.equal(JSON.stringify(failed[0]).includes('boom secret'), false);
    assert.deepEqual(
        emitter.events
            .map((entry) => entry.event)
            .filter((name) => name === EVENTS.WORK_ITEM.FAILED || name === EVENTS.WORK_ITEM.PARKED || name === EVENTS.WORK_ITEM.RELEASED),
        [EVENTS.WORK_ITEM.FAILED, EVENTS.WORK_ITEM.PARKED]
    );
    const parked = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(payloadOf(parked[0]).reason, 'non_retryable');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'the claim is held while parked');
    assert.equal(scheduler.snapshot().totals.failures, 1);
});

test('a canceled attempt that carries an error counts in totals.failures without changing its disposition', async () => {
    const workflow = createWorkflow({
        run: async () => {
            throw Object.assign(new Error('caller canceled'), { name: 'CanceledError' });
        }
    });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.totals.attempts, 1);
    assert.equal(snapshot.totals.failures, 1, 'a canceled attempt with error evidence is a host-visible failure');
    assert.equal(snapshot.retrying.length, 0, 'no retry is queued');
    assert.equal(snapshot.parked.length, 1);
    assert.equal(snapshot.parked[0].reason, 'attempts_exhausted', 'the disposition is the same as any unknown failure');
    assert.equal(workflow.calls.length, 1);
    const failed = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(payloadOf(failed[0]).failureClass, 'unknown');
});

test('a hostile usage getter cannot abort settle or leak the claim', async () => {
    const hostileUsage = { get total_tokens() { throw new Error('boom'); } };
    const workflow = createWorkflow({
        run: async () => ({ status: 'completed', usage: hostileUsage })
    });
    const claims = createMemoryClaimStore();
    const { scheduler, emitter, items, workflow: wf } = await setup({ workflow, claims });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const completed = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.COMPLETED });
    assert.equal(completed.length, 1);
    assert.equal(payloadOf(completed[0]).usage, null, 'only numeric usage reaches the payload');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR }).length, 0);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0);
    // B5: a completed attempt parks and keeps the claim. `resetItem` is the
    // host's explicit release, and only then may the item dispatch again.
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
    assert.equal(scheduler.snapshot().parked.length, 1);
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), true);

    await scheduler.resetItem({ identifier: 'MER-1' });
    assert.deepEqual(scheduler.snapshot().claimed, []);
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), false);

    await scheduler.tick();
    assert.equal(wf.calls.length, 2);
    await flush();
});

test('state helpers: totals, usage accumulation, and the snapshot seconds math', () => {
    const totals = createTotals();
    assert.deepEqual(totals, {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        secondsRunning: 0,
        dispatches: 0,
        attempts: 0,
        failures: 0,
        usageComplete: true,
        costComplete: true
    });

    accumulateUsage({ totals, usage: usage() });
    assert.equal(totals.inputTokens, 6);
    assert.equal(totals.outputTokens, 4);
    assert.equal(totals.totalTokens, 10);
    assert.equal(totals.costUsd, 0.01);
    assert.equal(totals.usageComplete, true);
    assert.equal(totals.costComplete, true);

    accumulateUsage({ totals, usage: null });
    assert.equal(totals.usageComplete, false);
    assert.equal(totals.costComplete, false);

    const noCost = createTotals();
    accumulateUsage({ totals: noCost, usage: { total_tokens: 2, input_tokens: 1, output_tokens: 1 } });
    assert.equal(noCost.totalTokens, 2);
    assert.equal(noCost.usageComplete, true);
    assert.equal(noCost.costComplete, false);

    // P2: one usage vocabulary. The engine's spelling and the scheduler's fold
    // into identical totals, and both fields of one pair never double count.
    const engineSpelling = createTotals();
    accumulateUsage({ totals: engineSpelling, usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10, cost_usd: 0.01 } });
    const schedulerSpelling = createTotals();
    accumulateUsage({ totals: schedulerSpelling, usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10, cost_usd: 0.01 } });
    assert.deepEqual(engineSpelling, schedulerSpelling, 'both spellings produce identical totals');

    const derivedTotal = createTotals();
    accumulateUsage({ totals: derivedTotal, usage: { prompt_tokens: 6, completion_tokens: 4 } });
    assert.equal(derivedTotal.totalTokens, 10, 'total derives from input plus output when absent');

    const clampedTotal = createTotals();
    accumulateUsage({ totals: clampedTotal, usage: { input_tokens: 6, output_tokens: 4, total_tokens: 3 } });
    assert.equal(clampedTotal.totalTokens, 10, 'a total below its parts is clamped, never trusted');

    const negativeTotal = createTotals();
    accumulateUsage({ totals: negativeTotal, usage: { total_tokens: -5 } });
    assert.equal(negativeTotal.totalTokens, 0, 'a negative total cannot subtract spend');

    const negativeParts = createTotals();
    accumulateUsage({ totals: negativeParts, usage: { input_tokens: -6, output_tokens: -4 } });
    assert.deepEqual(
        { input: negativeParts.inputTokens, output: negativeParts.outputTokens, total: negativeParts.totalTokens },
        { input: 0, output: 0, total: 0 },
        'negative parts floor at zero instead of shrinking the totals'
    );

    // The engine's own camelCase run usage carries no recognized token field:
    // usage is incomplete, but a finite cost still folds.
    const camelCase = createTotals();
    accumulateUsage({ totals: camelCase, usage: { promptTokens: 6, completionTokens: 4, cost_usd: 0.02 } });
    assert.deepEqual(
        {
            usageComplete: camelCase.usageComplete,
            total: camelCase.totalTokens,
            costUsd: camelCase.costUsd,
            costComplete: camelCase.costComplete
        },
        { usageComplete: false, total: 0, costUsd: 0.02, costComplete: true },
        'no recognized token field is incomplete, and the cost still folds'
    );

    const bothSpellings = createTotals();
    accumulateUsage({ totals: bothSpellings, usage: { input_tokens: 6, prompt_tokens: 6, output_tokens: 4, completion_tokens: 4 } });
    assert.deepEqual(
        { input: bothSpellings.inputTokens, output: bothSpellings.outputTokens, total: bothSpellings.totalTokens },
        { input: 6, output: 4, total: 10 },
        'input_tokens and prompt_tokens together do not double count'
    );

    // A runner's tree delta reports the scheduler spelling and a nullable cost.
    const delta = createTotals();
    accumulateUsage({ totals: delta, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, cost_usd: null } });
    assert.deepEqual(
        { input: delta.inputTokens, output: delta.outputTokens, total: delta.totalTokens, costComplete: delta.costComplete },
        { input: 2, output: 1, total: 3, costComplete: false },
        'a delta fills the totals and a null cost flips only costComplete'
    );

    const hostile = new Proxy({}, { get: () => { throw new Error('hostile'); } });
    assert.doesNotThrow(() => accumulateUsage({ totals: createTotals(), usage: hostile }));

    // A non-plain-object usage is "not reported": no numbers, both flags false.
    for (const notUsage of [[1, 2], 'usage', () => {}]) {
        const unreported = createTotals();
        accumulateUsage({ totals: unreported, usage: notUsage });
        assert.deepEqual(
            { usageComplete: unreported.usageComplete, costComplete: unreported.costComplete, totalTokens: unreported.totalTokens },
            { usageComplete: false, costComplete: false, totalTokens: 0 }
        );
    }

    const snapshot = buildSnapshot({
        started: true,
        stopped: false,
        tickCount: 3,
        lastTickAt: 1_500,
        pollIntervalMs: 1_000,
        running: new Map([['MER-1', {
            id: 'MER-1',
            identifier: 'MER-1',
            item: { id: 'id-1', identifier: 'MER-1', state: 'Todo', priority: 2, url: null },
            attempt: 1,
            lane: 'default',
            startedAt: 1_400,
            lastProgressAt: 1_450
        }]]),
        retrying: [],
        parked: [],
        claimed: ['MER-1'],
        completed: [],
        totals: { ...createTotals(), secondsRunning: 2 },
        limits: { maxAttemptsPerItem: 5 },
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        now: 1_700
    });
    assert.equal(snapshot.totals.secondsRunning, 2.3);
    assert.equal(snapshot.running[0].url, null);
    assert.equal(snapshot.retrying.length, 0);
    assert.equal(snapshot.parked.length, 0);
    assert.deepEqual(snapshot.activeStates, ['Todo']);
});

test('validateSchedulerConfig reports every documented check as strings', () => {
    const valid = {
        workSource: { fetchByStates: () => [], fetchByIds: () => [] },
        workflow: { run: () => {} },
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        pollIntervalMs: 1_000,
        stallTimeoutMs: 0,
        retry: { baseMs: 10, maxMs: 10 },
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        requiredLabels: [],
        claims: 'memory',
        clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }
    };
    assert.deepEqual(validateSchedulerConfig({ options: valid }), []);

    const invalid = {
        ...valid,
        workSource: {},
        workflow: {},
        activeStates: [],
        terminalStates: ['todo'],
        concurrency: { global: 0, byLane: { review: 0 } },
        pollIntervalMs: 0,
        stallTimeoutMs: -1,
        retry: { baseMs: -1, maxMs: -2 },
        continuation: { delayMs: -1, max: 0.5 },
        limits: { maxAttemptsPerItem: 0, maxDispatches: 0, maxTotalTokens: -1, maxTotalUsd: 0 },
        requiredLabels: [1],
        filter: 1,
        workspace: {},
        claims: {},
        signal: {},
        clock: {},
        preflight: 1
    };
    const errors = validateSchedulerConfig({ options: invalid });
    assert.ok(errors.length >= 13, `expected many errors, got ${errors.length}`);
    assert.ok(errors.every((entry) => typeof entry === 'string' && entry.length > 0));

    assert.deepEqual(
        collectDuplicateIdentifiers({ items: [{ identifier: 'A' }, { identifier: ' B ' }, { identifier: 'a' }, { identifier: 'b' }, { identifier: 'A' }] }),
        ['A', 'B']
    );
});

test('concurrency above 1 without a workspace is a validation error', () => {
    const options = {
        workSource: { fetchByStates: () => [], fetchByIds: () => [] },
        workflow: { run: () => {} },
        activeStates: ['Todo'],
        terminalStates: [],
        concurrency: { global: 2 },
        pollIntervalMs: 1_000,
        stallTimeoutMs: 0,
        retry: { baseMs: 0, maxMs: 0 },
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        requiredLabels: [],
        claims: 'memory',
        clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }
    };
    assert.ok(validateSchedulerConfig({ options }).some((entry) => entry.includes('concurrency.global')));
    assert.deepEqual(validateSchedulerConfig({ options: { ...options, allowSharedWorkspace: true } }), []);
});

test('retryDelayMs doubles until the cap and treats an invalid attempt as 1', () => {
    assert.equal(retryDelayMs({ attempt: 1, baseMs: 10_000, maxMs: 300_000 }), 10_000);
    assert.equal(retryDelayMs({ attempt: 2, baseMs: 10_000, maxMs: 300_000 }), 20_000);
    assert.equal(retryDelayMs({ attempt: 3, baseMs: 10_000, maxMs: 300_000 }), 40_000);
    assert.equal(retryDelayMs({ attempt: 10, baseMs: 10_000, maxMs: 300_000 }), 300_000);
    assert.equal(retryDelayMs({ attempt: 0, baseMs: 10_000, maxMs: 300_000 }), 10_000);
    assert.equal(retryDelayMs({ attempt: Number.NaN, baseMs: 10_000, maxMs: 300_000 }), 10_000);
});

test('normalizeRunResult maps results, errors, usage, cost, progress, and never exposes a message', () => {
    const completed = normalizeRunResult({
        result: { status: 'completed', usage: usage(), costUsd: 0.02 }
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, true);
    assert.deepEqual(completed.usage, usage());
    assert.equal(completed.costUsd, 0.02);
    assert.equal(completed.errorName, null);
    assert.equal(completed.errorCode, null);
    assert.equal(
        normalizeRunResult({ result: { status: 'completed', usage: { total_tokens: 3, costUsd: 0.04 } } }).costUsd,
        0.04,
        'the camelCase cost spelling agrees with cost_usd'
    );

    const noProgress = normalizeRunResult({ result: { status: 'failed', progress: false } });
    assert.equal(noProgress.status, 'failed');
    assert.equal(noProgress.progress, false);
    assert.equal(noProgress.costUsd, null);
    assert.equal(noProgress.usage, null);

    // §3.10/AC16: an unknown or missing status fails closed, never a silent success.
    assert.equal(normalizeRunResult({ result: {} }).status, 'failed');
    assert.equal(normalizeRunResult({ result: null }).status, 'failed');
    assert.equal(normalizeRunResult({ result: { status: 'completed' } }).status, 'completed');

    const error = Object.assign(new Error('secret message'), { name: 'AccessError', code: 'PERMISSION_DENIED' });
    const failed = normalizeRunResult({ error });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorName, 'AccessError');
    assert.equal(failed.errorCode, 'PERMISSION_DENIED');
    assert.equal(JSON.stringify(failed).includes('secret message'), false);

    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelController = new AbortController();
    cancelController.abort();
    const canceled = normalizeRunResult({ error: abortError, signal: cancelController.signal });
    assert.equal(canceled.status, 'canceled');

    const controller = new AbortController();
    controller.abort();
    assert.equal(normalizeRunResult({ error: new Error('x'), signal: controller.signal }).status, 'canceled');
});

test('failureEvidence maps timeout, permission, environment, and plain failures', () => {
    assert.deepEqual(
        failureEvidence({ result: { errorCode: 'ETIMEDOUT', timedOut: false } }),
        { errorCode: 'ETIMEDOUT', timedOut: true, permissionBlocked: false, environmentMissing: false, source: 'scheduler' }
    );
    assert.equal(failureEvidence({ result: { errorCode: 'PERMISSION_DENIED' } }).permissionBlocked, true);
    assert.equal(failureEvidence({ result: { errorCode: 'MERCI-GUARDRAIL-ERR' } }).permissionBlocked, true);
    assert.equal(failureEvidence({ result: { errorCode: 'ENOENT' } }).environmentMissing, true);
    assert.equal(failureEvidence({ result: { errorCode: 'ENOTDIR' } }).environmentMissing, true);
    assert.equal(failureEvidence({ result: { errorName: 'TimeoutError' } }).timedOut, true, 'a throw named TimeoutError agrees with a code');
    const plain = failureEvidence({ result: { errorName: 'Error', errorCode: null } });
    assert.equal(plain.timedOut, false);
    assert.equal(plain.permissionBlocked, false);
    assert.equal(plain.environmentMissing, false);
    assert.equal(plain.source, 'scheduler');
});

test('a hostile source item that makes the tick body throw is contained as internal_error', async () => {
    const emitter = createEmitter();
    const clock = createClock();
    /** @type {{throwing: boolean}} */
    const control = { throwing: true };
    const hostile = {
        id: 'id-1',
        identifier: 'MER-1',
        title: 'One',
        dispatchable: true,
        get state() {
            if (control.throwing) throw new Error('state boom');
            return 'Todo';
        }
    };
    const source = {
        fetchByStates: () => (control.throwing ? [hostile] : []),
        fetchByIds: () => []
    };
    const scheduler = new WorkScheduler(/** @type {SchedulerOptions} */ (/** @type {unknown} */ ({
        workSource: source,
        workflow: createWorkflow(),
        eventEmitter: emitter,
        clock,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo'],
        terminalStates: ['Done']
    })));

    await scheduler.start();
    emitter.events.length = 0;

    await scheduler.tick();

    const ticks = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK });
    assert.equal(ticks.length, 1, 'the tick still emits despite the thrown body');
    assert.equal(payloadOf(ticks[0]).outcome, 'internal_error');
    const internal = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR });
    assert.equal(internal.length, 1);
    assert.equal(payloadOf(internal[0]).op, 'tick');
    assert.equal(JSON.stringify(emitter.events).includes('state boom'), false);

    // The next tick still runs, and a healthy source reports ok.
    control.throwing = false;
    await scheduler.tick();
    const after = eventsNamed({ value: emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(payloadOf(/** @type {{event: string, [key: string]: unknown}} */ (after)).outcome, 'ok');

    await scheduler.stop();
});
