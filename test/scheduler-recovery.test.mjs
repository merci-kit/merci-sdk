// @ts-check

/**
 * @file Stage 5 contract tests for settle dispositions: failure retries,
 * continuation retries, parking, reconciliation, the stall watchdog, and stop
 * recovery.
 * @version 0.12.0
 *
 * @description
 * Drives `WorkScheduler` with an in-memory work source, a fake workflow, a
 * capturing emitter, and a manual clock. The fixtures keep `item.id` different
 * from `identifier` so a refresh addressed by `identifier` instead of the
 * opaque record id fails loudly. Every assertion pins an AC (AC7/AC9/AC10/
 * AC11/AC12/AC13/AC19/AC20/AC21/AC22) or an SCH mitigation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    WorkScheduler,
    createMemoryClaimStore,
    createMemoryWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { SchedulerError } from '../lib/core/errors.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */
/** @typedef {import('../lib/agentic/scheduler/claims.mjs').ClaimStore} ClaimStore */
/** @typedef {ConstructorParameters<typeof WorkScheduler>[0]} SchedulerOptions */

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/**
 * @typedef {Object} WorkflowInput
 * @property {unknown} item
 * @property {number} attempt
 * @property {AbortSignal} signal
 * @property {() => void} reportProgress
 */

/**
 * A capturing emitter with an `emitSafe` seam. `emitEvent` contains a throwing
 * `emitSafe` and reports it as `event:listener_error`, so a hostile host cannot
 * fail the scheduler's settle; the plain `emit` fallback is kept for shape.
 * @typedef {Object} CapturingEmitter
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {Set<string>} throwing
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emitSafe
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/**
 * @returns {CapturingEmitter}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    /** @type {Set<string>} */
    const throwing = new Set();
    return {
        events,
        throwing,
        emitSafe: (name, envelope) => {
            if (throwing.has(name)) throw new Error('emitter failure');
            events.push(/** @type {{event: string, [key: string]: unknown}} */ (envelope));
        },
        emit: (name, payload) => {
            if (throwing.has(name)) throw new Error('emitter failure');
            events.push({ event: name, ...payload });
        },
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
 * @param {{emitter: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<Record<string, unknown>>}
 */
function payloads({ emitter, name }) {
    return eventsNamed({ value: emitter, name }).map((entry) => payloadOf(entry));
}

/**
 * Let queued microtasks and `onSettled` continuations run.
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 10 } = {}) {
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
 * @param {{item: unknown}} arg0 -
 * @returns {string}
 */
function identifierOf({ item }) {
    return /** @type {{identifier: string}} */ (item).identifier;
}

/**
 * @param {Record<string, unknown>} [overrides] -
 * @returns {Record<string, unknown>}
 */
function completedResult(overrides = {}) {
    return {
        status: 'completed',
        usage: { total_tokens: 10, input_tokens: 6, output_tokens: 4, cost_usd: 0.01 },
        ...overrides
    };
}

/**
 * @param {{run?: (arg0: WorkflowInput) => Promise<unknown>}} [arg0] -
 * @returns {{calls: WorkflowInput[], run: (arg0: WorkflowInput) => Promise<unknown>}}
 */
function createWorkflow({ run } = {}) {
    /** @type {WorkflowInput[]} */
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
 * A scheduler whose first tick ran over an empty board. The poll interval is
 * huge so a clock advance for backoff cannot fire a second, unawaited tick.
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
 *   source: {fetchByStates: Function, fetchByIds: Function},
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
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        ...(claims ? { claims } : {}),
        ...options
    });
    await scheduler.start();
    emitter.events.length = 0;
    return { scheduler, emitter, clock, source, workflow: wf, items };
}

/**
 * Dispatch one item, let the attempt fail, and leave the first failure retry
 * queued (due after the retry base).
 * @param {{options?: Record<string, unknown>}} [arg0] -
 */
async function firstFailure({ options = {} } = {}) {
    const ctx = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'failed' }) }),
        options: {
            retry: { baseMs: 1_000, maxMs: 1_000 },
            limits: { maxAttemptsPerItem: 5 },
            ...options
        }
    });
    ctx.items.push(rawItem());
    await ctx.scheduler.tick();
    await flush();
    return ctx;
}

/**
 * Park one item immediately by exhausting a single-attempt budget.
 * @param {{options?: Record<string, unknown>}} [arg0] -
 */
async function parkedItem({ options = {} } = {}) {
    const ctx = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'failed' }) }),
        options: {
            retry: { baseMs: 1_000, maxMs: 1_000 },
            limits: { maxAttemptsPerItem: 1 },
            ...options
        }
    });
    ctx.items.push(rawItem());
    await ctx.scheduler.tick();
    await flush();
    return ctx;
}

/**
 * @param {unknown} item -
 * @returns {Record<string, unknown>}
 */
function asRecord(item) {
    return /** @type {Record<string, unknown>} */ (item);
}

test('failure retries back off 10s, 20s, 40s, cap at maxMs, and are due only when the clock advances', async () => {
    const workflow = createWorkflow({ run: async () => ({ status: 'failed' }) });
    const { scheduler, emitter, clock, items } = await setup({
        workflow,
        options: {
            retry: { baseMs: 10_000, maxMs: 40_000 },
            limits: { maxAttemptsPerItem: 10 }
        }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 1);
    assert.equal(workflow.calls[0].attempt, 1);

    const delays = [10_000, 20_000, 40_000];
    for (let index = 0; index < delays.length; index += 1) {
        const retries = payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
        const latest = retries.at(-1);
        assert.ok(latest, `retry ${index + 1} was scheduled`);
        assert.equal(latest.delayMs, delays[index]);
        assert.equal(latest.attempt, index + 2);
        assert.equal(latest.dueAtMs, clock.now() + delays[index]);
        assert.equal(latest.failureClass, 'unknown');

        // Not due one millisecond early: no new dispatch.
        clock.advance(delays[index] - 1);
        /** @type {number} */
        const callsBefore = workflow.calls.length;
        await scheduler.tick();
        await flush();
        assert.equal(workflow.calls.length, callsBefore, 'a retry fires only once its due time is reached');

        clock.advance(1);
        await scheduler.tick();
        await flush();
        assert.equal(workflow.calls.length, callsBefore + 1);
        const lastCall = workflow.calls.at(-1);
        assert.ok(lastCall);
        assert.equal(lastCall.attempt, index + 2);
    }

    // The fourth failure keeps the capped 40s delay.
    const capped = payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).at(-1);
    assert.ok(capped);
    assert.equal(capped.delayMs, 40_000);
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'the claim is held across every retry');
});

test('maxAttemptsPerItem: the first failure retries, the second parks with the claim held', async () => {
    const workflow = createWorkflow({ run: async () => ({ status: 'failed' }) });
    const { scheduler, emitter, clock, items } = await setup({
        workflow,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 2 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const firstRetry = payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(firstRetry.length, 1);
    assert.equal(firstRetry[0].attempt, 2, 'the retried attempt is number 2');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.FAILED }).length, 0, 'a retrying item has not failed');

    clock.advance(1_000);
    await scheduler.tick();
    await flush();

    assert.equal(workflow.calls.length, 2);
    assert.equal(workflow.calls[1].attempt, 2);
    const failed = payloads({ emitter, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].attempt, 2);
    const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'attempts_exhausted');
    assert.equal(parked[0].attempts, 2);

    // Parked: a later tick never re-dispatches it.
    clock.advance(10_000_000);
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 2);
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'parking keeps the claim');
    assert.equal(scheduler.snapshot().parked.length, 1);
});

test('permission_block, environment_mismatch, and invalid_workflow park immediately with no retry', async () => {
    /** @type {ReadonlyArray<{code: string, failureClass: string}>} */
    const cases = [
        { code: 'PERMISSION_DENIED', failureClass: 'permission_block' },
        { code: 'ENOENT', failureClass: 'environment_mismatch' },
        { code: 'MERCI-WORKFLOW-POLICY-ERR', failureClass: 'invalid_workflow' }
    ];
    for (const { code, failureClass } of cases) {
        const workflow = createWorkflow({
            run: async () => { throw Object.assign(new Error('secret detail'), { code }); }
        });
        const { scheduler, emitter, items } = await setup({
            workflow,
            options: { limits: { maxAttemptsPerItem: 5 } }
        });
        items.push(rawItem());

        await scheduler.tick();
        await flush();

        assert.equal(workflow.calls.length, 1, `${code} is not retried`);
        assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
        const failed = payloads({ emitter, name: EVENTS.WORK_ITEM.FAILED });
        assert.equal(failed.length, 1);
        assert.equal(failed[0].failureClass, failureClass);
        assert.equal(failed[0].errorCode, code);
        const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
        assert.equal(parked.length, 1);
        assert.equal(parked[0].reason, 'non_retryable');
        assert.equal(parked[0].attempts, 1);
        assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
        assert.equal(JSON.stringify(emitter.events).includes('secret detail'), false);
    }
});

test('a due retry re-fetches by item.id and dispatches attempt 2 without a second claimed event', async () => {
    const ctx = await firstFailure();
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED })[0].attempt, 2);

    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();

    assert.equal(ctx.workflow.calls.length, 2);
    assert.equal(ctx.workflow.calls[1].attempt, 2);
    assert.deepEqual(
        payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).map((payload) => payload.attempt),
        [1, 2]
    );
    assert.equal(eventsNamed({ value: ctx.emitter, name: EVENTS.WORK_ITEM.CLAIMED }).length, 1,
        'a retry reuses the claim and never re-emits work_item:claimed');
});

test('a due retry that sees a terminal, inactive, unroutable, or missing item releases it and does not dispatch', async () => {
    /** @type {ReadonlyArray<{mutate: (items: unknown[]) => void, reason: string}>} */
    const cases = [
        {
            mutate: (items) => { asRecord(items[0]).state = 'Done'; },
            reason: 'terminal'
        },
        {
            mutate: (items) => { asRecord(items[0]).state = 'Backlog'; },
            reason: 'inactive'
        },
        {
            mutate: (items) => { asRecord(items[0]).dispatchable = false; },
            reason: 'unroutable'
        },
        {
            mutate: (items) => { items.length = 0; },
            reason: 'missing'
        }
    ];
    for (const { mutate, reason } of cases) {
        const ctx = await firstFailure();
        mutate(ctx.items);
        ctx.clock.advance(1_000);
        ctx.emitter.events.length = 0;

        await ctx.scheduler.tick();
        await flush();

        assert.equal(ctx.workflow.calls.length, 1, `${reason}: the retry must not dispatch`);
        const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1, `${reason}: the claim is released`);
        assert.equal(released[0].reason, reason);
        assert.deepEqual(ctx.scheduler.snapshot().claimed, []);
    }
});

test('a source failure during the retry fetch re-queues the same attempt and leaves the budget unchanged', async () => {
    const ctx = await firstFailure();
    const originalFetchByIds = ctx.source.fetchByIds;
    ctx.source.fetchByIds = () => {
        throw Object.assign(new Error('tracker down'), { category: 'tracker_request' });
    };
    ctx.clock.advance(1_000);
    ctx.emitter.events.length = 0;

    await ctx.scheduler.tick();
    await flush();

    const retried = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(retried.length, 1);
    assert.equal(retried[0].attempt, 2, 'the same attempt is re-queued');
    assert.equal(retried[0].delayMs, 1_000);
    assert.equal(retried[0].failureClass, null, 'a source error is not a classified workflow failure');
    assert.equal(ctx.workflow.calls.length, 1);
    const sourceError = payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR });
    assert.equal(sourceError.length, 1);
    assert.deepEqual(sourceError[0], { op: 'processRetries', category: 'tracker_request' });
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.TICK }).at(-1)?.outcome, 'ok');

    // The budget did not move: the retried run is still attempt 2.
    ctx.source.fetchByIds = originalFetchByIds;
    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();
    assert.equal(ctx.workflow.calls.length, 2);
    assert.equal(ctx.workflow.calls[1].attempt, 2);
});

test('a due retry with no free global slot re-queues at the same attempt', async () => {
    const gate = deferred();
    const workflow = createWorkflow({
        run: async ({ item }) => (identifierOf({ item }) === 'MER-1' ? gate.promise : { status: 'failed' })
    });
    const ctx = await setup({
        workflow,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 5 } }
    });
    ctx.items.push(rawItem({ overrides: { id: 'id-2', identifier: 'MER-2', priority: 1 } }));
    await ctx.scheduler.tick();
    await flush();
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED })[0].attempt, 2);

    // A second item now holds the only slot.
    ctx.items.push(rawItem({ overrides: { id: 'id-1', identifier: 'MER-1', priority: 2 } }));
    await ctx.scheduler.tick();
    await flush();
    assert.equal(ctx.workflow.calls.length, 2);

    ctx.clock.advance(1_000);
    ctx.emitter.events.length = 0;
    await ctx.scheduler.tick();
    await flush();

    assert.equal(ctx.workflow.calls.length, 2, 'no slot: the retry is not dispatched');
    const requeued = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].attempt, 2, 'the attempt budget is unchanged');
    assert.equal(requeued[0].failureClass, null);

    gate.resolve(completedResult());
    await flush();
});

test('a continuation honors delayMs and dispatches attempt 1 only after it', async () => {
    const { scheduler, emitter, clock, items, workflow } = await setup({
        options: { continuation: { delayMs: 5_000, max: 2 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const continued = payloads({ emitter, name: EVENTS.WORK_ITEM.CONTINUED });
    assert.equal(continued.length, 1);
    assert.deepEqual(continued[0], { workItemId: 'id-1', identifier: 'MER-1', attempt: 1, delayMs: 5_000 });
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.COMPLETED }).length, 0);
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'a continuation keeps the claim');
    const retrying = scheduler.snapshot().retrying;
    assert.equal(retrying.length, 1);
    assert.equal(retrying[0].kind, 'continuation');

    clock.advance(4_999);
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 1);

    clock.advance(1);
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 2);
    assert.equal(workflow.calls[1].attempt, 1);
});

test('progress:false suppresses the continuation and parks with no_progress', async () => {
    const workflow = createWorkflow({ run: async () => ({ status: 'completed', progress: false }) });
    const { scheduler, emitter, items } = await setup({
        workflow,
        options: { continuation: { delayMs: 1_000, max: 2 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.CONTINUED }).length, 0);
    const completed = payloads({ emitter, name: EVENTS.WORK_ITEM.COMPLETED });
    assert.equal(completed.length, 1);
    const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'no_progress');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
});

test('a continuation whose item went terminal or inactive before the fire is released', async () => {
    /** @type {ReadonlyArray<{state: string, reason: string}>} */
    const cases = [
        { state: 'Done', reason: 'terminal' },
        { state: 'Backlog', reason: 'inactive' }
    ];
    for (const { state, reason } of cases) {
        const { scheduler, emitter, clock, items, workflow } = await setup({
            options: { continuation: { delayMs: 1_000, max: 2 } }
        });
        items.push(rawItem());
        await scheduler.tick();
        await flush();
        asRecord(items[0]).state = state;
        clock.advance(1_000);
        emitter.events.length = 0;

        await scheduler.tick();
        await flush();

        assert.equal(workflow.calls.length, 1, `${reason}: no continuation dispatch`);
        const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1);
        assert.equal(released[0].reason, reason);
        assert.deepEqual(scheduler.snapshot().claimed, []);
    }
});

test('continuation.max bounds the number of continuations and then parks', async () => {
    const { scheduler, emitter, items, workflow } = await setup({
        options: { continuation: { delayMs: 0, max: 2 } }
    });
    items.push(rawItem());

    for (let index = 0; index < 3; index += 1) {
        await scheduler.tick();
        await flush();
    }

    assert.equal(workflow.calls.length, 3, 'the first attempt plus exactly two continuations');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.CONTINUED }).length, 2);
    const completed = payloads({ emitter, name: EVENTS.WORK_ITEM.COMPLETED });
    assert.equal(completed.length, 1);
    const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'continuations_exhausted');
    assert.equal(parked[0].continuations, 2, 'two continuation retries were scheduled; the third completion parks');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);

    // A parked item is not dispatched again.
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 3);
});

test('continuation.max 0 disables continuations and parks after one completion', async () => {
    const { scheduler, emitter, items } = await setup({ options: { continuation: { delayMs: 0, max: 0 } } });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.CONTINUED }).length, 0);
    const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'continuations_disabled');
    assert.equal(parked[0].continuations, 0, 'disabled continuations are never counted');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
});

test('a parked item extends its backoff while still active and releases on terminal/inactive/missing', async () => {
    const active = await parkedItem();
    assert.equal(active.scheduler.snapshot().parked.length, 1);
    const firstCheck = active.scheduler.snapshot().parked[0].nextCheckAt;
    assert.equal(firstCheck, active.clock.now() + 1_000);
    active.clock.advance(1_000);
    await active.scheduler.tick();
    await flush();
    const extended = active.scheduler.snapshot().parked[0];
    assert.equal(extended.nextCheckAt, active.clock.now() + 2_000);
    assert.deepEqual(active.scheduler.snapshot().claimed, ['MER-1'], 'still parked, claim kept');
    assert.equal(eventsNamed({ value: active.emitter, name: EVENTS.WORK_ITEM.PARKED }).length, 1,
        'extending the backoff emits no new parked event');

    /** @type {ReadonlyArray<{mutate: (items: unknown[]) => void, reason: string}>} */
    const cases = [
        { mutate: (items) => { asRecord(items[0]).state = 'Done'; }, reason: 'terminal' },
        { mutate: (items) => { asRecord(items[0]).state = 'Backlog'; }, reason: 'inactive' },
        { mutate: (items) => { items.length = 0; }, reason: 'missing' }
    ];
    for (const { mutate, reason } of cases) {
        const ctx = await parkedItem();
        mutate(ctx.items);
        ctx.clock.advance(1_000);
        ctx.emitter.events.length = 0;
        await ctx.scheduler.tick();
        await flush();
        const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1, `${reason}: a parked item is released`);
        assert.equal(released[0].reason, reason);
        assert.deepEqual(ctx.scheduler.snapshot().claimed, []);
        assert.equal(ctx.scheduler.snapshot().parked.length, 0);
    }
});

test('a throwing parked re-check keeps the item parked and extends its backoff', async () => {
    const ctx = await parkedItem();
    ctx.source.fetchByIds = () => {
        throw Object.assign(new Error('tracker down'), { category: 'tracker_request' });
    };
    ctx.clock.advance(1_000);
    ctx.emitter.events.length = 0;

    await ctx.scheduler.tick();
    await flush();

    const sourceError = payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR });
    assert.equal(sourceError.length, 1);
    assert.deepEqual(sourceError[0], { op: 'checkParked', category: 'tracker_request' });
    assert.equal(ctx.scheduler.snapshot().parked.length, 1);
    assert.equal(ctx.scheduler.snapshot().parked[0].nextCheckAt, ctx.clock.now() + 2_000);
    assert.deepEqual(ctx.scheduler.snapshot().claimed, ['MER-1']);
});

test('resetItem requires start, refuses a running item, un-parks, and is allowed after stop', async () => {
    const emitter = createEmitter();
    const clock = createClock();
    const unstarted = new WorkScheduler({
        workSource: createMemoryWorkSource({ items: [], eventEmitter: emitter }),
        workflow: createWorkflow(),
        eventEmitter: emitter,
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done']
    });
    await assert.rejects(
        unstarted.resetItem({ identifier: 'MER-1' }),
        (err) => err instanceof SchedulerError && err.reason === 'not_started'
    );

    const gate = deferred();
    const running = await setup({ workflow: createWorkflow({ run: async () => gate.promise }) });
    running.items.push(rawItem());
    await running.scheduler.tick();
    await assert.rejects(
        running.scheduler.resetItem({ identifier: 'MER-1' }),
        (err) => err instanceof SchedulerError && err.reason === 'invalid_attempt'
    );
    gate.resolve(completedResult());
    await flush();

    const parked = await parkedItem();
    assert.deepEqual(parked.scheduler.snapshot().claimed, ['MER-1']);
    assert.equal(parked.scheduler.snapshot().parked.length, 1);
    const reset = await parked.scheduler.resetItem({ identifier: 'MER-1' });
    assert.equal(reset, undefined);
    assert.deepEqual(parked.scheduler.snapshot().claimed, []);
    assert.equal(parked.scheduler.snapshot().parked.length, 0);

    await parked.scheduler.tick();
    await flush();
    assert.equal(parked.workflow.calls.length, 2, 'reset makes the item dispatchable again');

    await parked.scheduler.stop();
    await assert.doesNotReject(parked.scheduler.resetItem({ identifier: 'MER-1' }));
});

test('reconciliation releases a terminal item with cleanup reported and never retries', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    asRecord(items[0]).state = 'Done';

    await scheduler.tick();

    const reconciled = payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED });
    assert.equal(reconciled.length, 1);
    assert.deepEqual(reconciled[0], { workItemId: 'id-1', identifier: 'MER-1', reason: 'terminal', cleanup: true });
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0,
        'the attempt is still draining when the disposition is written');

    gate.resolve(completedResult());
    await flush();

    const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.COMPLETED }).length, 0);
    const order = emitter.events.map((entry) => entry.event);
    assert.ok(order.indexOf(EVENTS.WORK_ITEM.RECONCILED) < order.indexOf(EVENTS.WORK_ITEM.RELEASED));
});

test('reconciliation releases inactive, unroutable, and missing items without cleanup', { timeout: 5000 }, async () => {
    /** @type {ReadonlyArray<{mutate: (items: unknown[]) => void, reason: string}>} */
    const cases = [
        { mutate: (items) => { asRecord(items[0]).state = 'Backlog'; }, reason: 'inactive' },
        { mutate: (items) => { asRecord(items[0]).dispatchable = false; }, reason: 'unroutable' },
        { mutate: (items) => { items.length = 0; }, reason: 'missing' }
    ];
    for (const { mutate, reason } of cases) {
        const gate = deferred();
        const workflow = createWorkflow({ run: async () => gate.promise });
        const { scheduler, emitter, items } = await setup({ workflow });
        items.push(rawItem());
        await scheduler.tick();
        mutate(items);

        await scheduler.tick();
        gate.resolve(completedResult());
        await flush();

        const reconciled = payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED });
        assert.equal(reconciled.length, 1, reason);
        assert.deepEqual(reconciled[0], { workItemId: 'id-1', identifier: 'MER-1', reason, cleanup: false });
        const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1);
        assert.equal(released[0].reason, reason);
        assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
    }
});

test('a failing refresh emits a typed source error and keeps the worker running', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const claims = createMemoryClaimStore();
    const { scheduler, emitter, source, items } = await setup({ workflow, claims });
    items.push(rawItem());
    await scheduler.tick();
    source.fetchByIds = () => {
        throw Object.assign(new Error('tracker down'), { category: 'tracker_request' });
    };
    emitter.events.length = 0;

    await scheduler.tick();

    const sourceError = payloads({ emitter, name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR });
    assert.equal(sourceError.length, 1);
    assert.deepEqual(sourceError[0], { op: 'fetchByIds', category: 'tracker_request' });
    assert.equal(scheduler.snapshot().running.length, 1);
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'a refresh throw keeps the in-process claim');
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), true, 'the real claim store is untouched');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 0);

    gate.resolve(completedResult());
    await flush();
});

test('reconciliation updates the running snapshot while the item stays active and routable', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    assert.equal(scheduler.snapshot().running[0].state, 'Todo');

    asRecord(items[0]).state = 'In Progress';
    asRecord(items[0]).priority = 7;
    await scheduler.tick();

    const row = scheduler.snapshot().running[0];
    assert.equal(row.state, 'In Progress');
    assert.equal(row.priority, 7);

    gate.resolve(completedResult());
    await flush();
});

test('the stall watchdog aborts and schedules a transient_infrastructure retry, not a failure', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        })
    });
    const { scheduler, emitter, clock, items } = await setup({
        workflow,
        options: {
            stallTimeoutMs: 1_000,
            retry: { baseMs: 1_000, maxMs: 1_000 },
            limits: { maxAttemptsPerItem: 5 }
        }
    });
    items.push(rawItem());
    await scheduler.tick();

    clock.advance(1_001);
    await scheduler.tick();

    const stalled = payloads({ emitter, name: EVENTS.WORK_ITEM.STALLED });
    assert.equal(stalled.length, 1);
    assert.deepEqual(stalled[0], { workItemId: 'id-1', identifier: 'MER-1', attempt: 1, idleMs: 1_001 });

    await flush();
    const retried = payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(retried.length, 1);
    assert.equal(retried[0].failureClass, 'transient_infrastructure');
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.FAILED }).length, 0);
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);

    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 2);
    assert.equal(workflow.calls[1].attempt, 2);

    await scheduler.stop();
});

test('stallTimeoutMs 0 disables the watchdog and reportProgress resets the idle clock', { timeout: 5000 }, async () => {
    const disabledGate = deferred();
    const disabled = await setup({
        workflow: createWorkflow({ run: async () => disabledGate.promise }),
        options: { stallTimeoutMs: 0 }
    });
    disabled.items.push(rawItem());
    await disabled.scheduler.tick();
    disabled.clock.advance(5_000);
    await disabled.scheduler.tick();
    assert.equal(eventsNamed({ value: disabled.emitter, name: EVENTS.WORK_ITEM.STALLED }).length, 0);
    assert.equal(disabled.scheduler.snapshot().running.length, 1);
    disabledGate.resolve(completedResult());
    await flush();

    const gate = deferred();
    /** @type {(() => void)|null} */
    let reportProgress = null;
    const liveness = createWorkflow({
        run: async ({ reportProgress: report }) => {
            reportProgress = report;
            return gate.promise;
        }
    });
    const live = await setup({ workflow: liveness, options: { stallTimeoutMs: 1_000 } });
    live.items.push(rawItem());
    await live.scheduler.tick();
    live.clock.advance(900);
    assert.ok(reportProgress);
    /** @type {() => void} */ (reportProgress)();
    live.clock.advance(900);
    await live.scheduler.tick();
    assert.equal(eventsNamed({ value: live.emitter, name: EVENTS.WORK_ITEM.STALLED }).length, 0);
    assert.equal(live.scheduler.snapshot().running.length, 1);
    gate.resolve(completedResult());
    await flush();
});

test('stop releases retrying and parked claims and reports how many it released', async () => {
    const claims = createMemoryClaimStore();
    const retrying = await setup({
        claims,
        workflow: createWorkflow({ run: async () => ({ status: 'failed' }) }),
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 5 } }
    });
    retrying.items.push(rawItem());
    await retrying.scheduler.tick();
    await flush();
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), true);

    const result = await retrying.scheduler.stop({ reason: 'test' });
    assert.deepEqual(result, { drained: true, running: 0, retrying: 1, parked: 0 },
        'the released retry is reported, not the now-empty map');
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), false);
    const released = payloads({ emitter: retrying.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'test');

    const parked = await parkedItem();
    assert.deepEqual(parked.scheduler.snapshot().claimed, ['MER-1']);
    const parkedResult = await parked.scheduler.stop({ reason: 'parked-stop' });
    assert.deepEqual(parkedResult, { drained: true, running: 0, retrying: 0, parked: 1 });
    assert.deepEqual(parked.scheduler.snapshot().claimed, []);
    assert.equal(parked.scheduler.snapshot().parked.length, 0);
    assert.equal(payloads({ emitter: parked.emitter, name: EVENTS.WORK_ITEM.RELEASED }).at(-1)?.reason, 'parked-stop');
});

test('stop reports drained:false for an attempt that ignores the abort and leaves its claim held', { timeout: 5000 }, async () => {
    const gate = deferred();
    const claims = createMemoryClaimStore();
    const { scheduler, emitter, clock, items, workflow } = await setup({
        claims,
        workflow: createWorkflow({ run: async () => gate.promise })
    });
    items.push(rawItem());
    await scheduler.tick();
    emitter.events.length = 0;

    const stopping = scheduler.stop({ reason: 'test', timeoutMs: 10 });
    await flush();
    clock.advance(10);
    const result = await stopping;

    assert.deepEqual(result, { drained: false, running: 1, retrying: 0, parked: 0 });
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'a still-running claim is not released (SCH-08)');
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), true);
    assert.equal(clock.timers.size, 0);
    const stopEvent = payloads({ emitter, name: EVENTS.SCHEDULER.STOP });
    assert.deepEqual(stopEvent[0], { reason: 'test', running: 1, retrying: 0, parked: 0, drained: false });

    gate.resolve(completedResult());
    await flush();
    assert.deepEqual(scheduler.snapshot().claimed, [], 'the later settle releases the claim');
    assert.equal(await claims.isClaimed({ workItemId: 'MER-1' }), false);

    await scheduler.tick();
    assert.equal(workflow.calls.length, 1, 'no dispatch after stop');
});

test('a throwing host emitter is contained as a listener error and never fails the settle', { timeout: 5000 }, async () => {
    /** @type {unknown[]} */
    const rejections = [];
    /** @param {unknown} reason */
    const onRejection = (reason) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
        const { scheduler, emitter, items } = await setup();
        emitter.throwing.add(EVENTS.WORK_ITEM.COMPLETED);
        items.push(rawItem());

        await scheduler.tick();
        await flush({ rounds: 20 });

        const internal = payloads({ emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR });
        assert.equal(internal.length, 0, 'a listener failure is not a settle failure');
        const listenerError = payloads({ emitter, name: EVENTS.ERRORS.LISTENER_ERROR });
        assert.equal(listenerError.length, 1);
        assert.equal(listenerError[0].sourceEvent, EVENTS.WORK_ITEM.COMPLETED);
        assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.COMPLETED }).length, 0);
        assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'the settle finishes and parks the claim');
        assert.equal(scheduler.snapshot().parked.length, 1);
        assert.equal(rejections.length, 0, 'onSettled never rejects');
    } finally {
        process.off('unhandledRejection', onRejection);
    }
});

test('the five new event leaves carry exact key sets and the tick reports live retrying/parked counts', async () => {
    // retry_scheduled
    const retryingCtx = await firstFailure();
    const retryPayload = payloads({ emitter: retryingCtx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED })[0];
    assert.deepEqual(Object.keys(retryPayload).sort(), [
        'attempt', 'delayMs', 'dueAtMs', 'failureClass', 'identifier', 'workItemId'
    ]);
    assert.equal(JSON.stringify(retryPayload).includes('title'), false);
    assert.equal(JSON.stringify(retryPayload).includes('description'), false);
    assert.equal(JSON.stringify(retryPayload).includes('message'), false);

    // Live retrying count on a later tick.
    retryingCtx.emitter.events.length = 0;
    await retryingCtx.scheduler.tick();
    const retryingTick = payloads({ emitter: retryingCtx.emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(retryingTick?.retrying, 1);
    assert.equal(retryingTick?.parked, 0);

    // parked
    const parkedCtx = await parkedItem();
    const parkedPayload = payloads({ emitter: parkedCtx.emitter, name: EVENTS.WORK_ITEM.PARKED })[0];
    assert.deepEqual(Object.keys(parkedPayload).sort(), [
        'attempts', 'continuations', 'identifier', 'nextCheckAt', 'reason', 'workItemId'
    ]);
    parkedCtx.emitter.events.length = 0;
    await parkedCtx.scheduler.tick();
    const parkedTick = payloads({ emitter: parkedCtx.emitter, name: EVENTS.SCHEDULER.TICK }).at(-1);
    assert.equal(parkedTick?.parked, 1);
    assert.equal(parkedTick?.retrying, 0);

    // continued
    const continuation = await setup({ options: { continuation: { delayMs: 1_000, max: 1 } } });
    continuation.items.push(rawItem());
    await continuation.scheduler.tick();
    await flush();
    const continuedPayload = payloads({ emitter: continuation.emitter, name: EVENTS.WORK_ITEM.CONTINUED })[0];
    assert.deepEqual(Object.keys(continuedPayload).sort(), ['attempt', 'delayMs', 'identifier', 'workItemId']);

    // stalled
    const stalledWorkflow = createWorkflow({
        run: async ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        })
    });
    const stalled = await setup({ workflow: stalledWorkflow, options: { stallTimeoutMs: 1_000 } });
    stalled.items.push(rawItem());
    await stalled.scheduler.tick();
    stalled.clock.advance(1_001);
    await stalled.scheduler.tick();
    const stalledPayload = payloads({ emitter: stalled.emitter, name: EVENTS.WORK_ITEM.STALLED })[0];
    assert.deepEqual(Object.keys(stalledPayload).sort(), ['attempt', 'identifier', 'idleMs', 'workItemId']);
    await stalled.scheduler.stop();

    // reconciled
    const gate = deferred();
    const reconcile = await setup({ workflow: createWorkflow({ run: async () => gate.promise }) });
    reconcile.items.push(rawItem());
    await reconcile.scheduler.tick();
    asRecord(reconcile.items[0]).state = 'Done';
    await reconcile.scheduler.tick();
    const reconciledPayload = payloads({ emitter: reconcile.emitter, name: EVENTS.WORK_ITEM.RECONCILED })[0];
    assert.deepEqual(Object.keys(reconciledPayload).sort(), ['cleanup', 'identifier', 'reason', 'workItemId']);
    gate.resolve(completedResult());
    await flush();
});

test('AC19: a duplicate identifier that appears while one is running is blocked and keeps the running attempt', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items, workflow: wf } = await setup({ workflow });
    items.push(rawItem({ overrides: { id: 'id-1', identifier: 'MER-1' } }));
    await scheduler.tick();
    assert.equal(scheduler.snapshot().running.length, 1);

    items.push(rawItem({ overrides: { id: 'id-2', identifier: 'MER-1', priority: 1 } }));
    emitter.events.length = 0;
    await scheduler.tick();

    assert.equal(wf.calls.length, 1, 'the running attempt is untouched');
    assert.equal(scheduler.snapshot().running.length, 1);
    const validation = payloads({ emitter, name: EVENTS.SCHEDULER.VALIDATION_ERROR });
    assert.equal(validation.length, 1);
    const errors = /** @type {string[]} */ (validation[0].errors);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^duplicate_identifier: MER-1$/);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 0);

    gate.resolve(completedResult());
    await flush();
});

/**
 * A claim store that fails exactly one acquire call, then delegates to the
 * in-memory store. `acquire` call 1 is the initial dispatch; call 2 is the
 * retry/continuation fire that the test wants to fail.
 * @param {{failAt: number, mode: 'false'|'throw'}} arg0 -
 * @returns {{store: ClaimStore, inner: ClaimStore, acquires: () => number}}
 */
function createFlakyClaimStore({ failAt, mode }) {
    const inner = createMemoryClaimStore();
    let acquires = 0;
    /** @type {ClaimStore} */
    const store = {
        acquire: async (args) => {
            acquires += 1;
            if (acquires === failAt) {
                if (mode === 'throw') throw new Error('claim store secret');
                return false;
            }
            return inner.acquire(args);
        },
        release: (args) => inner.release(args),
        isClaimed: (args) => inner.isClaimed(args),
        list: () => inner.list()
    };
    return { store, inner, acquires: () => acquires };
}

test('a stall retries as transient_infrastructure until maxAttemptsPerItem then parks', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        })
    });
    const { scheduler, emitter, clock, items } = await setup({
        workflow,
        options: {
            stallTimeoutMs: 1_000,
            retry: { baseMs: 1_000, maxMs: 1_000 },
            limits: { maxAttemptsPerItem: 3 }
        }
    });
    items.push(rawItem());
    await scheduler.tick();

    for (let run = 1; run <= 3; run += 1) {
        clock.advance(1_001);
        await scheduler.tick();
        await flush();
        assert.equal(workflow.calls.length, run, `run ${run}: no extra stall retry slips past the cap`);
        assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.STALLED }).length, run);
        if (run < 3) {
            assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.FAILED }).length, 0,
                'a stall below the cap has not failed');
            assert.equal(scheduler.snapshot().retrying.length, 1);
            clock.advance(1_000);
            await scheduler.tick();
            await flush();
            assert.equal(workflow.calls.length, run + 1);
        }
    }

    const failed = payloads({ emitter, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].attempt, 3);
    assert.equal(failed[0].failureClass, 'transient_infrastructure');
    const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'attempts_exhausted');
    assert.equal(parked[0].attempts, 3);
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 2,
        'exactly two retries were ever scheduled');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1'], 'parking keeps the claim');

    clock.advance(10_000_000);
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 3, 'a parked stall is never retried');
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 2);

    await scheduler.stop();
});

test('a stall whose result carries a workflow-policy code parks non_retryable with no retry', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(
                new Error('policy detail'),
                { code: 'MERCI-WORKFLOW-POLICY-ERR' }
            )), { once: true });
        })
    });
    const { scheduler, emitter, clock, items } = await setup({
        workflow,
        options: {
            stallTimeoutMs: 1_000,
            retry: { baseMs: 1_000, maxMs: 1_000 },
            limits: { maxAttemptsPerItem: 5 }
        }
    });
    items.push(rawItem());
    await scheduler.tick();
    clock.advance(1_001);
    await scheduler.tick();
    await flush();

    assert.equal(workflow.calls.length, 1);
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
    const failed = payloads({ emitter, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].failureClass, 'invalid_workflow');
    assert.equal(failed[0].errorCode, 'MERCI-WORKFLOW-POLICY-ERR');
    const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'non_retryable');
    assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
    assert.equal(JSON.stringify(emitter.events).includes('policy detail'), false);

    await scheduler.stop();
});

test('a stall whose base evidence is ENOENT or ENOTDIR parks non_retryable on the first attempt', { timeout: 5000 }, async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
        const workflow = createWorkflow({
            run: async ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(Object.assign(
                    new Error('workspace detail'),
                    { code }
                )), { once: true });
            })
        });
        const { scheduler, emitter, clock, items } = await setup({
            workflow,
            options: {
                stallTimeoutMs: 1_000,
                retry: { baseMs: 1_000, maxMs: 1_000 },
                limits: { maxAttemptsPerItem: 5 }
            }
        });
        items.push(rawItem());
        await scheduler.tick();
        clock.advance(1_001);
        await scheduler.tick();
        await flush();

        assert.equal(workflow.calls.length, 1, `${code}: no retry`);
        assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0, code);
        const failed = payloads({ emitter, name: EVENTS.WORK_ITEM.FAILED });
        assert.equal(failed.length, 1, code);
        assert.equal(failed[0].failureClass, 'environment_mismatch', code);
        assert.equal(failed[0].errorCode, code, code);
        const parked = payloads({ emitter, name: EVENTS.WORK_ITEM.PARKED });
        assert.equal(parked.length, 1, code);
        assert.equal(parked[0].reason, 'non_retryable', code);
        assert.equal(parked[0].attempts, 1, code);
        assert.equal(JSON.stringify(emitter.events).includes('workspace detail'), false, code);

        await scheduler.stop();
    }
});

test('a failed claim at a retry or continuation fire releases and re-claims on the next list fetch', async () => {
    /** @type {ReadonlyArray<'failure'|'continuation'>} */
    const kinds = ['failure', 'continuation'];
    /** @type {ReadonlyArray<'false'|'throw'>} */
    const modes = ['false', 'throw'];
    for (const kind of kinds) {
        for (const mode of modes) {
            const label = `${kind}/${mode}`;
            const flaky = createFlakyClaimStore({ failAt: 2, mode });
            const workflow = createWorkflow({
                run: async () => (kind === 'failure' ? { status: 'failed' } : completedResult())
            });
            const options = kind === 'failure'
                ? { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 5 } }
                : { continuation: { delayMs: 1_000, max: 2 } };
            const ctx = await setup({ workflow, claims: flaky.store, options });
            ctx.items.push(rawItem());
            await ctx.scheduler.tick();
            await flush();
            assert.equal(flaky.acquires(), 1, label);

            ctx.clock.advance(1_000);
            // Isolate the retry-fire path: suppress the same-tick list scan so
            // the re-claim is observed on the next fetch.
            const originalFetchByStates = ctx.source.fetchByStates;
            ctx.source.fetchByStates = () => [];
            ctx.emitter.events.length = 0;

            await ctx.scheduler.tick();
            await flush();

            const claimFailed = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.CLAIM_FAILED });
            assert.equal(claimFailed.length, 1, label);
            assert.equal(claimFailed[0].reason, mode === 'throw' ? 'error' : 'not_acquired', label);
            const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
            assert.equal(released.length, 1, label);
            assert.equal(released[0].reason, 'claim_failed', label);
            assert.deepEqual(ctx.scheduler.snapshot().claimed, [], label);
            assert.equal(await flaky.inner.isClaimed({ workItemId: 'MER-1' }), false, label);

            ctx.source.fetchByStates = originalFetchByStates;
            ctx.emitter.events.length = 0;
            await ctx.scheduler.tick();
            await flush();

            assert.equal(workflow.calls.length, 2, `${label}: the next tick dispatches a fresh attempt`);
            assert.equal(workflow.calls[1].attempt, 1, `${label}: a fresh attempt is attempt 1`);
            assert.deepEqual(
                payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).map((payload) => payload.attempt),
                [1],
                label
            );
            await ctx.scheduler.stop();
        }
    }
});

test('snapshot retrying and parked rows carry exactly the documented keys, without checks', async () => {
    const retryingCtx = await firstFailure();
    const retryRow = retryingCtx.scheduler.snapshot().retrying[0];
    assert.deepEqual(Object.keys(retryRow).sort(), [
        'attempt', 'delayMs', 'dueAtMs', 'errorCode', 'errorName', 'identifier', 'kind', 'url', 'workItemId'
    ]);

    const parkedCtx = await parkedItem();
    const parkedRow = parkedCtx.scheduler.snapshot().parked[0];
    assert.deepEqual(Object.keys(parkedRow).sort(), [
        'attempts', 'continuations', 'identifier', 'nextCheckAt', 'reason', 'since', 'url', 'workItemId'
    ]);
    assert.equal('checks' in parkedRow, false, 'checks is internal bookkeeping, not a snapshot key');

    await retryingCtx.scheduler.stop();
    await parkedCtx.scheduler.stop();
});

test('a settle owns the single release while a stop races it', { timeout: 5000 }, async () => {
    const releaseGate = deferred();
    let releaseCalls = 0;
    /** @type {ClaimStore} */
    const gatedStore = {
        acquire: async () => true,
        release: async () => { releaseCalls += 1; await releaseGate.promise; return true; },
        isClaimed: async () => false,
        list: async () => []
    };
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(completedResult()), { once: true });
        })
    });
    const { scheduler, emitter, items } = await setup({ workflow, claims: gatedStore });
    items.push(rawItem());
    await scheduler.tick();
    asRecord(items[0]).state = 'Done';

    const tickPromise = scheduler.tick();
    await flush();
    assert.equal(releaseCalls, 1, 'the settle reached the gated store release');
    emitter.events.length = 0;

    const stopping = scheduler.stop({ timeoutMs: 1_000 });
    await flush();
    assert.equal(releaseCalls, 1, 'stop must not start a second store release');

    releaseGate.resolve(true);
    await tickPromise;
    const result = await stopping;
    await flush();

    assert.equal(releaseCalls, 1);
    const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal', 'the settle reason wins over the stop reason');
    assert.deepEqual(scheduler.snapshot().claimed, []);
    assert.equal(result.drained, true);
});

test('a terminal item that ignores the abort reconciles exactly once across ticks', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    asRecord(items[0]).state = 'Done';

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 1,
        'a release disposition is never re-emitted');

    gate.resolve(completedResult());
    await flush();
});

test('a release disposition upgrades once and a terminal release is never downgraded', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({ run: async () => gate.promise });
    const { scheduler, emitter, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    asRecord(items[0]).state = 'Backlog';

    await scheduler.tick();
    asRecord(items[0]).state = 'Done';
    await scheduler.tick();
    await scheduler.tick();

    const reconciled = payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED });
    assert.deepEqual(
        reconciled.map(({ reason, cleanup }) => ({ reason, cleanup })),
        [
            { reason: 'inactive', cleanup: false },
            { reason: 'terminal', cleanup: true }
        ],
        'a new, more final fact upgrades the release once; a repeated terminal emits nothing'
    );

    // A terminal release is final: an item that flickers back to an inactive
    // state must not downgrade it and lose `cleanup`.
    asRecord(items[0]).state = 'Backlog';
    await scheduler.tick();
    const afterDowngrade = payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED });
    assert.equal(afterDowngrade.length, 2, 'no new reconciled event after a terminal release');
    assert.equal(afterDowngrade.filter(({ reason }) => reason === 'terminal').length, 1);
    assert.equal(afterDowngrade.filter(({ reason }) => reason === 'inactive').length, 1,
        'the inactive reason is not re-emitted');

    gate.resolve(completedResult());
    await flush();
    const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);

    await scheduler.tick();
    await flush();
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 2,
        'a settled release emits nothing further');

    await scheduler.stop();
});

test('AC21: a validation error still reconciles a terminal running item and dispatches nothing', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(completedResult()), { once: true });
        })
    });
    /** @type {string[]} */
    let blocked = [];
    const { scheduler, emitter, items } = await setup({
        workflow,
        options: { preflight: () => blocked }
    });
    items.push(rawItem());
    await scheduler.tick();
    asRecord(items[0]).state = 'Done';
    blocked = ['policy is stale'];
    emitter.events.length = 0;

    await scheduler.tick();
    await flush();

    assert.equal(payloads({ emitter, name: EVENTS.SCHEDULER.VALIDATION_ERROR }).length, 1);
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 1);
    const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 0);
    assert.equal(payloads({ emitter, name: EVENTS.SCHEDULER.TICK }).at(-1)?.outcome, 'validation_error');
});

test('AC8: stop during the reconcile fetch ends the tick with a single stopped outcome', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        })
    });
    const { scheduler, emitter, source, items } = await setup({ workflow });
    items.push(rawItem());
    await scheduler.tick();
    const fetchGate = deferred();
    source.fetchByIds = () => fetchGate.promise;
    emitter.events.length = 0;

    const tickPromise = scheduler.tick();
    await flush();
    const stopping = scheduler.stop({ timeoutMs: 1_000 });
    await flush();
    fetchGate.resolve([]);
    await tickPromise;
    await stopping;
    await flush();

    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 0);
    assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 0);
    const ticks = payloads({ emitter, name: EVENTS.SCHEDULER.TICK });
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].outcome, 'stopped');
});

test('a parked re-check caps the exponential backoff at six hours', async () => {
    // A poll interval far beyond every advance keeps the assertions tied to the
    // explicit tick; otherwise the poll timer fires an unawaited tick.
    const ctx = await parkedItem({
        options: {
            pollIntervalMs: 1_000_000_000,
            retry: { baseMs: 1_000, maxMs: 10_000_000 }
        }
    });
    assert.equal(ctx.scheduler.snapshot().parked.length, 1);

    ctx.clock.advance(10_000_000);
    await ctx.scheduler.tick();
    await flush();
    assert.equal(
        /** @type {number} */ (ctx.scheduler.snapshot().parked[0].nextCheckAt) - ctx.clock.now(),
        20_000_000
    );

    ctx.clock.advance(20_000_000);
    await ctx.scheduler.tick();
    await flush();
    assert.equal(
        /** @type {number} */ (ctx.scheduler.snapshot().parked[0].nextCheckAt) - ctx.clock.now(),
        21_600_000,
        'the parked backoff is capped at six hours'
    );

    await ctx.scheduler.stop();
});

test('#completed excludes a still-continuing item until its final completion', async () => {
    const { scheduler, items } = await setup({ options: { continuation: { delayMs: 0, max: 2 } } });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    assert.deepEqual(scheduler.snapshot().completed, [], 'a scheduled continuation is not a completion');
    assert.equal(scheduler.snapshot().retrying[0].kind, 'continuation');

    await scheduler.tick();
    await flush();
    assert.deepEqual(scheduler.snapshot().completed, []);

    await scheduler.tick();
    await flush();
    assert.deepEqual(scheduler.snapshot().completed, ['MER-1'], 'only the final completion is recorded');

    await scheduler.stop();
});

test('AC10: a continuation whose item is missing or unroutable is released at the fire', async () => {
    /** @type {ReadonlyArray<{mutate: (items: unknown[]) => void, reason: string}>} */
    const cases = [
        { mutate: (items) => { items.length = 0; }, reason: 'missing' },
        { mutate: (items) => { asRecord(items[0]).dispatchable = false; }, reason: 'unroutable' }
    ];
    for (const { mutate, reason } of cases) {
        const { scheduler, emitter, clock, items, workflow } = await setup({
            options: { continuation: { delayMs: 1_000, max: 2 } }
        });
        items.push(rawItem());
        await scheduler.tick();
        await flush();
        mutate(items);
        clock.advance(1_000);
        emitter.events.length = 0;

        await scheduler.tick();
        await flush();

        assert.equal(workflow.calls.length, 1, `${reason}: no continuation dispatch`);
        const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1);
        assert.equal(released[0].reason, reason);
        assert.deepEqual(scheduler.snapshot().claimed, []);
    }
});

test('AC20: resetItem releases a retrying item and clears its queued retry', async () => {
    const ctx = await firstFailure();
    assert.deepEqual(ctx.scheduler.snapshot().claimed, ['MER-1']);
    assert.equal(ctx.scheduler.snapshot().retrying.length, 1);

    await ctx.scheduler.resetItem({ identifier: 'MER-1' });

    const snapshot = ctx.scheduler.snapshot();
    assert.deepEqual(snapshot.claimed, []);
    assert.equal(snapshot.retrying.length, 0);
    assert.equal(snapshot.parked.length, 0);
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'reset');

    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();
    assert.equal(ctx.workflow.calls.length, 2, 'the item is dispatchable again');
    assert.equal(ctx.workflow.calls[1].attempt, 1, 'the reset starts a fresh attempt');
});

test('a second stop releases nothing after the first stop already owned the release', async () => {
    const ctx = await parkedItem();
    const first = await ctx.scheduler.stop({ reason: 'first' });
    assert.deepEqual(first, { drained: true, running: 0, retrying: 0, parked: 1 });
    ctx.emitter.events.length = 0;

    const second = await ctx.scheduler.stop({ reason: 'second' });
    assert.deepEqual(second, { drained: true, running: 0, retrying: 0, parked: 0 });
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0,
        'the release is single-shot');
    assert.deepEqual(ctx.scheduler.snapshot().claimed, []);
});

test('the completed history is bounded to the most recent 100 identifiers', { timeout: 5000 }, async () => {
    /** @type {unknown[]} */
    const items = [];
    const workflow = createWorkflow({
        run: async ({ item }) => {
            const identifier = /** @type {{identifier: string}} */ (item).identifier;
            const raw = items.find((candidate) => asRecord(candidate).identifier === identifier);
            asRecord(raw).state = 'Done';
            return completedResult();
        }
    });
    const { scheduler } = await setup({ items, workflow });

    for (let index = 1; index <= 101; index += 1) {
        items.push(rawItem({ overrides: { id: `id-${index}`, identifier: `MER-${index}`, title: `Item ${index}` } }));
    }
    for (let index = 0; index < 101; index += 1) {
        await scheduler.tick();
        await flush();
    }

    const completed = scheduler.snapshot().completed;
    assert.equal(completed.length, 100, 'the set is capped at 100');
    assert.equal(completed.includes('MER-1'), false, 'the oldest identifier is dropped');
    assert.equal(completed.includes('MER-101'), true, 'the newest identifier is kept');
});
