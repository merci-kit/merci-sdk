// @ts-check

/**
 * @file Stage 8 contract tests for the aggregate budget guard (AC14).
 * @version 0.12.0
 *
 * @description
 * Drives `WorkScheduler` with an in-memory work source, a fake workflow, a
 * capturing emitter, and a manual clock. Every test pins one §3.11 rule: the
 * guard runs only for an otherwise dispatchable item with a free slot, a
 * blocked retry is re-queued at the same attempt instead of dropped, running
 * attempts finish (the limit is a stop-new-work threshold, so in-flight spend
 * overshoots), `maxTotalUsd` is inert until `costComplete`, and
 * `scheduler:budget_exhausted` is emitted once per scheduler lifetime even
 * across two different limits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkScheduler, createEngineRunner, createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** @typedef {ConstructorParameters<typeof WorkScheduler>[0]} SchedulerOptions */

/**
 * @typedef {Object} WorkflowInput
 * @property {{identifier: string}} item
 * @property {number} attempt
 * @property {AbortSignal} signal
 * @property {() => void} reportProgress
 */

/**
 * @typedef {Object} Recorder
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/** @returns {Recorder} */
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
 * A manual clock: timers only fire inside `advance`.
 * @param {{now?: number}} [arg0] -
 * @returns {{
 *   now: () => number,
 *   setTimeout: (fn: () => void, ms: number) => number,
 *   clearTimeout: (handle: unknown) => void,
 *   advance: (ms: number) => void
 * }}
 */
function createClock({ now = 1_000 } = {}) {
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
        advance: (ms) => {
            current += ms;
            for (const [handle, timer] of [...timers.entries()]) {
                if (timer.at <= current) {
                    timers.delete(handle);
                    timer.fn();
                }
            }
        }
    };
}

/**
 * @param {{recorder: Recorder, name: string}} arg0 -
 * @returns {Array<{event: string, [key: string]: unknown}>}
 */
function eventsNamed({ recorder, name }) {
    return recorder.events.filter((entry) => entry.event === name);
}

/**
 * @param {{recorder: Recorder, name: string}} arg0 -
 * @returns {Array<Record<string, unknown>>}
 */
function payloads({ recorder, name }) {
    return eventsNamed({ recorder, name }).map((entry) => {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [key, value] of Object.entries(entry)) {
            if (!ENVELOPE_KEYS.has(key)) out[key] = value;
        }
        return out;
    });
}

/**
 * Let queued microtasks and `onSettled` continuations run.
 * @returns {Promise<void>}
 */
async function flush() {
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {{id?: string, identifier?: string, [key: string]: unknown}} [arg0] -
 * @returns {Record<string, unknown>}
 */
function rawItem({ id = 'id-1', identifier = 'MER-1', ...overrides } = {}) {
    return { id, identifier, title: 'One', state: 'Todo', dispatchable: true, ...overrides };
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
 * @returns {{promise: Promise<unknown>, resolve: (value?: unknown) => void}}
 */
function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

/**
 * A scheduler whose first tick ran over an empty board; push items afterwards.
 * @param {{
 *   items?: unknown[],
 *   options?: SchedulerOptions,
 *   workflow?: ReturnType<typeof createWorkflow>,
 *   clock?: ReturnType<typeof createClock>
 * }} [arg0] -
 * @returns {Promise<{
 *   scheduler: WorkScheduler,
 *   recorder: Recorder,
 *   clock: ReturnType<typeof createClock>,
 *   workflow: ReturnType<typeof createWorkflow>,
 *   items: unknown[]
 * }>}
 */
async function setup({ items = [], options = {}, workflow, clock: injectedClock } = {}) {
    const recorder = createEmitter();
    const clock = injectedClock ?? createClock();
    const source = createMemoryWorkSource({ items, eventEmitter: recorder });
    const wf = workflow ?? createWorkflow();
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow: wf,
        eventEmitter: recorder,
        clock,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        ...options
    });
    await scheduler.start();
    recorder.events.length = 0;
    return { scheduler, recorder, clock, workflow: wf, items };
}

/**
 * @param {{recorder: Recorder, limit: string}} arg0 -
 * @returns {Array<Record<string, unknown>>}
 */
function budgetPayloads({ recorder, limit }) {
    return payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED })
        .filter((payload) => payload.limit === limit);
}

test('maxAttemptsPerItem parks the item end to end without a budget event', { timeout: 5000 }, async () => {
    const { scheduler, recorder, clock, items, workflow } = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'failed' }) }),
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 2 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 1);

    clock.advance(1_000);
    await scheduler.tick();
    await flush();

    assert.equal(workflow.calls.length, 2, 'the parked item is not dispatched a third time');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.FAILED }).length, 1);
    const parked = payloads({ recorder, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'attempts_exhausted');
    assert.equal(parked[0].attempts, 2);
    assert.equal(scheduler.snapshot().parked.length, 1);

    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 2);
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);
});

test('maxDispatches: 2 with three items and concurrency 1 stops the third, once', { timeout: 5000 }, async () => {
    const gate1 = deferred();
    const gate2 = deferred();
    const workflow = createWorkflow({
        run: async ({ item }) => (item.identifier === 'MER-1' ? gate1.promise : gate2.promise)
    });
    const { scheduler, recorder, items, workflow: wf } = await setup({
        workflow,
        options: {
            concurrency: { global: 1 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxDispatches: 2 }
        }
    });
    items.push(
        rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }),
        rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }),
        rawItem({ id: 'id-3', identifier: 'MER-3', priority: 3 })
    );

    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 1);
    // A full global pool stops the scan before the guard: no budget event.
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);

    gate1.resolve(completedResult());
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.COMPLETED }).length, 1);

    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 2);

    // The second a gated attempt settles normally, even though the budget is
    // already spent: the limit never aborts a running attempt.
    gate2.resolve(completedResult());
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.COMPLETED }).length, 2);

    await scheduler.tick();
    const hits = payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].limit, 'maxDispatches');
    assert.deepEqual(Object.keys(hits[0]).sort(), ['limit', 'totals']);
    assert.equal(/** @type {{dispatches: number}} */ (hits[0].totals).dispatches, 2);
    assert.equal(/** @type {{secondsRunning?: number}} */ (hits[0].totals).secondsRunning, undefined);

    await scheduler.tick();
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1, 'once per lifetime');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 2);
    assert.deepEqual(
        wf.calls.map((call) => call.item.identifier),
        ['MER-1', 'MER-2'],
        'the third item is never dispatched'
    );
    assert.equal(scheduler.snapshot().totals.dispatches, 2);
});

test('maxTotalTokens blocks the next dispatch while a running attempt finishes', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({
        run: async ({ item }) => {
            if (item.identifier === 'MER-1') return { status: 'completed', usage: { total_tokens: 10 } };
            return gate.promise;
        }
    });
    const { scheduler, recorder, items, workflow: wf } = await setup({
        workflow,
        options: {
            concurrency: { global: 2 },
            allowSharedWorkspace: true,
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalTokens: 10 }
        }
    });
    items.push(
        rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }),
        rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }),
        rawItem({ id: 'id-3', identifier: 'MER-3', priority: 3 })
    );

    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().totals.totalTokens, 10);
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 2);
    assert.equal(scheduler.snapshot().running.length, 1, 'MER-2 is still running when the limit is hit');

    await scheduler.tick();
    const hits = budgetPayloads({ recorder, limit: 'maxTotalTokens' });
    assert.equal(hits.length, 1);
    assert.equal(/** @type {{totalTokens: number}} */ (hits[0].totals).totalTokens, 10);

    gate.resolve(completedResult({ usage: { total_tokens: 5 } }));
    await flush();
    assert.equal(scheduler.snapshot().totals.totalTokens, 15, 'in-flight spend overshoots the threshold');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.COMPLETED }).length, 2);
    assert.deepEqual(wf.calls.map((call) => call.item.identifier), ['MER-1', 'MER-2']);

    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1);
});

test('maxTotalUsd is enforced when every settled attempt reported cost', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({
            run: async () => ({ status: 'completed', usage: { total_tokens: 10, cost_usd: 0.05 } })
        }),
        options: {
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalUsd: 0.05 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    const totals = scheduler.snapshot().totals;
    assert.equal(totals.costUsd, 0.05);
    assert.equal(totals.costComplete, true);

    await scheduler.tick();
    assert.equal(workflow.calls.length, 1, 'the second item is blocked');
    const hits = budgetPayloads({ recorder, limit: 'maxTotalUsd' });
    assert.equal(hits.length, 1);
    assert.equal(/** @type {{costUsd: number}} */ (hits[0].totals).costUsd, 0.05);
});

test('a runner tree delta reports the first attempt cost, so maxTotalUsd still fires', { timeout: 5000 }, async () => {
    // The pool starts with cost_usd null; a delta that treats that as "unknown"
    // permanently disables the aggregate USD guard after attempt 1.
    const client = {
        /**
         * @param {string} model
         * @returns {Record<string, any>}
         */
        session(model) {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'openai',
                model,
                _budget: null,
                _budgetPool: null,
                withBudget(/** @type {{budget: unknown}} */ args) {
                    session._budget = args.budget;
                    return session;
                },
                async run() {
                    const pool = session._budgetPool;
                    pool.usage.prompt_tokens += 6;
                    pool.usage.completion_tokens += 4;
                    pool.usage.total_tokens += 10;
                    pool.usage.cost_usd = (pool.usage.cost_usd ?? 0) + 0.05;
                    return 'done';
                }
            };
            return session;
        }
    };
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } });
    const { scheduler, recorder, items } = await setup({
        workflow: /** @type {ReturnType<typeof createWorkflow>} */ (/** @type {unknown} */ (runner)),
        options: { limits: { maxAttemptsPerItem: 1, maxTotalUsd: 0.05 } }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    const totals = scheduler.snapshot().totals;
    assert.equal(totals.costUsd, 0.05, 'the first attempt cost is reported');
    assert.equal(totals.costComplete, true, 'a pool that started with no cost does not make the attempt costless');
    assert.equal(totals.inputTokens, 6);
    assert.equal(totals.totalTokens, 10);

    await scheduler.tick();
    assert.equal(budgetPayloads({ recorder, limit: 'maxTotalUsd' }).length, 1, 'the USD guard fires instead of staying inert');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 1, 'the second item is never dispatched');
});

/**
 * A client whose one session keeps its tree pool across attempts — the shape a
 * scheduler that reuses a builder produces. `spends` is consumed one entry per
 * run; an entry with `fail` charges the pool, then throws.
 * @param {{spends: Array<{prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, cost_usd?: number, fail?: boolean}>}} arg0 -
 * @returns {{client: {session: (model: string) => Record<string, any>}, session: Record<string, any>}}
 */
function createSharedSessionClient({ spends }) {
    let index = 0;
    /** @type {Record<string, any>} */
    const session = {
        provider: 'openai',
        model: 'm',
        _budget: null,
        _budgetPool: null,
        withBudget(/** @type {{budget: unknown}} */ args) {
            session._budget = args.budget;
            return session;
        },
        async run() {
            /** @type {Record<string, any>} */
            const spend = spends[Math.min(index, spends.length - 1)] ?? {};
            index += 1;
            const pool = session._budgetPool;
            const prompt = spend.prompt_tokens ?? 0;
            const completion = spend.completion_tokens ?? 0;
            pool.usage.prompt_tokens += prompt;
            pool.usage.completion_tokens += completion;
            pool.usage.total_tokens += spend.total_tokens ?? prompt + completion;
            if (typeof spend.cost_usd === 'number') pool.usage.cost_usd = (pool.usage.cost_usd ?? 0) + spend.cost_usd;
            if (spend.fail) throw new Error('attempt failed');
            return 'done';
        }
    };
    return { session, client: { session: () => session } };
}

/**
 * @param {ReturnType<typeof createEngineRunner>} runner -
 * @returns {ReturnType<typeof createWorkflow>}
 */
function runnerAsWorkflow(runner) {
    return /** @type {ReturnType<typeof createWorkflow>} */ (/** @type {unknown} */ (runner));
}

test('a failed attempt and its retry each fold their own delta, matching the pool ledger', { timeout: 5000 }, async () => {
    const { client, session } = createSharedSessionClient({
        spends: [
            { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10, cost_usd: 0.05, fail: true },
            { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: 0.05 }
        ]
    });
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } });
    const { scheduler, recorder, clock, items } = await setup({
        workflow: runnerAsWorkflow(runner),
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 2 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 1);
    assert.equal(scheduler.snapshot().totals.totalTokens, 10, 'the failed attempt spend still lands in the totals');

    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().totals.totalTokens, 15, 'the retry adds only its own delta');
    assert.equal(session._budgetPool.usage.total_tokens, 15, 'the totals equal the pool ledger');
});

test('a shared session reports each attempt delta, so the totals match the pool ledger', { timeout: 5000 }, async () => {
    const { client, session } = createSharedSessionClient({
        spends: [
            { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
        ]
    });
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } });
    const { scheduler, items } = await setup({ workflow: runnerAsWorkflow(runner) });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    await scheduler.tick();
    await flush();

    assert.equal(scheduler.snapshot().totals.totalTokens, 22, 'own 10 + child 5, then own 7');
    assert.equal(session._budgetPool.usage.total_tokens, 22, 'the totals equal the pool ledger');
});

test('a pooled attempt that reports no spend leaves the totals incomplete', { timeout: 5000 }, async () => {
    const { client } = createSharedSessionClient({ spends: [{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }] });
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } });
    const { scheduler, items } = await setup({ workflow: runnerAsWorkflow(runner) });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    const totals = scheduler.snapshot().totals;
    assert.equal(totals.totalTokens, 0);
    assert.equal(totals.usageComplete, false, 'an unobserved pool is not complete usage');
});

test('maxTotalUsd is inert when a settled attempt reported no cost', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'completed', usage: { total_tokens: 10 } }) }),
        options: {
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalUsd: 0.05 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    const totals = scheduler.snapshot().totals;
    assert.equal(totals.costUsd, 0);
    assert.equal(totals.costComplete, false);

    await scheduler.tick();
    assert.equal(workflow.calls.length, 2, 'a partial cost sum cannot prove the limit');
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);
});

test('a completed attempt with no usage flips both completeness flags', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'completed' }) }),
        options: {
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalUsd: 0.01, maxTotalTokens: 100 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    const totals = scheduler.snapshot().totals;
    assert.equal(totals.usageComplete, false);
    assert.equal(totals.costComplete, false);
    assert.equal(totals.totalTokens, 0);

    await scheduler.tick();
    assert.equal(workflow.calls.length, 2, 'missing usage does not disable maxTotalTokens');
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);
});

test('raising a limit resumes dispatch and never re-emits, across two limits', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items, workflow } = await setup({
        options: {
            concurrency: { global: 1 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxDispatches: 1 }
        }
    });
    items.push(
        rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }),
        rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }),
        rawItem({ id: 'id-3', identifier: 'MER-3', priority: 3 })
    );

    await scheduler.tick();
    await flush();
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1);

    await scheduler.applyConfig({ options: { limits: { maxAttemptsPerItem: 1, maxDispatches: 5 } } });
    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 2, 'the raised dispatch limit resumes the scan');
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1);

    // The second limit is a different kind, and still must not emit again.
    await scheduler.applyConfig({ options: { limits: { maxAttemptsPerItem: 1, maxDispatches: 5, maxTotalTokens: 1 } } });
    await scheduler.tick();
    assert.equal(workflow.calls.length, 2, 'the token limit blocks the third item');
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1, 'once per lifetime');
});

test('a retry fire blocked by the budget is re-queued at the same attempt', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ attempt }) => (attempt === 1 ? { status: 'failed' } : completedResult())
    });
    const { scheduler, recorder, clock, items, workflow: wf } = await setup({
        workflow,
        options: {
            retry: { baseMs: 1_000, maxMs: 1_000 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 3, maxDispatches: 1 }
        }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    const firstRetry = payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(firstRetry.length, 1);
    assert.equal(firstRetry[0].attempt, 2);
    assert.notEqual(firstRetry[0].failureClass, null);

    clock.advance(1_000);
    await scheduler.tick();
    await flush();

    const retries = payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(retries.length, 2);
    assert.equal(retries[1].attempt, 2, 'the blocked fire keeps the same attempt number');
    assert.equal(retries[1].failureClass, null);
    assert.equal(retries[1].delayMs, 1_000);
    assert.equal(workflow.calls.length, 1, 'no attempt is consumed by the blocked fire');
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1);

    await scheduler.applyConfig({ options: { limits: { maxAttemptsPerItem: 3, maxDispatches: 5 } } });
    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    assert.deepEqual(wf.calls.map((call) => call.attempt), [1, 2]);
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.COMPLETED }).length, 1);
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1);
});

test('maxTotalTokens trips on the reported sum while usageComplete is false', { timeout: 5000 }, async () => {
    // The runner always reports tokens but not always usage: one settled
    // attempt reports none, so `usageComplete` is false. The token guard must
    // not consult that flag (§3.11: `maxTotalTokens` is the reliable guard).
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({
            run: async ({ item }) => {
                if (item.identifier === 'MER-1') return { status: 'completed', usage: { total_tokens: 20 } };
                if (item.identifier === 'MER-2') return { status: 'completed', usage: null };
                return completedResult();
            }
        }),
        options: {
            concurrency: { global: 2 },
            allowSharedWorkspace: true,
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalTokens: 20 }
        }
    });
    items.push(
        rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }),
        rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }),
        rawItem({ id: 'id-3', identifier: 'MER-3', priority: 3 }),
        rawItem({ id: 'id-4', identifier: 'MER-4', priority: 4 })
    );

    await scheduler.tick();
    await flush();
    const totals = scheduler.snapshot().totals;
    assert.equal(totals.totalTokens, 20);
    assert.equal(totals.usageComplete, false, 'one attempt reported no usage at all');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 2);

    await scheduler.tick();
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 2, 'the remaining items stay blocked');
    assert.equal(workflow.calls.length, 2);
    const hits = budgetPayloads({ recorder, limit: 'maxTotalTokens' });
    assert.equal(hits.length, 1);
    assert.equal(/** @type {{usageComplete: boolean}} */ (hits[0].totals).usageComplete, false);
});

test('no budget event while the global pool is full under an exhausted dispatch limit', { timeout: 5000 }, async () => {
    const gate = deferred();
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({ run: async ({ item }) => (item.identifier === 'MER-1' ? gate.promise : completedResult()) }),
        options: {
            concurrency: { global: 1 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxDispatches: 1 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    assert.equal(scheduler.snapshot().totals.dispatches, 1);
    // A full pool breaks the scan before the guard: the block is the slot, not the budget.
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);
    assert.equal(workflow.calls.length, 1);

    // Once the slot frees, the guard is reachable and fires exactly once.
    gate.resolve(completedResult());
    await flush();
    await scheduler.tick();
    const hits = budgetPayloads({ recorder, limit: 'maxDispatches' });
    assert.equal(hits.length, 1);
    assert.equal(workflow.calls.length, 1, 'the guard still blocks the second item');
});

test('no budget event while the lane is full under an exhausted dispatch limit', { timeout: 5000 }, async () => {
    const gate = deferred();
    const { scheduler, recorder, items } = await setup({
        workflow: createWorkflow({ run: async ({ item }) => (item.identifier === 'MER-1' ? gate.promise : completedResult()) }),
        options: {
            concurrency: { global: 2, byLane: { default: 1 } },
            allowSharedWorkspace: true,
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxDispatches: 1 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 1);
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0, 'the lane is the block');

    gate.resolve(completedResult());
    await flush();
    await scheduler.tick();
    assert.equal(budgetPayloads({ recorder, limit: 'maxDispatches' }).length, 1);
});

test('a dispatchable:false item never trips the guard; flipping it emits on the next tick', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items } = await setup({
        options: {
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxDispatches: 1 }
        }
    });
    const gated = rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2, dispatchable: false });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), gated);

    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().totals.dispatches, 1);
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0, 'eligibility is the block');

    gated.dispatchable = true;
    await scheduler.tick();
    assert.equal(budgetPayloads({ recorder, limit: 'maxDispatches' }).length, 1);
});

test('a parked item and a claimed idle item never trip the guard', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items } = await setup({
        workflow: createWorkflow({
            run: async ({ item }) => (item.identifier === 'MER-1' ? completedResult() : { status: 'failed' })
        }),
        options: {
            retry: { baseMs: 1_000, maxMs: 1_000 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 2, maxDispatches: 2 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().totals.dispatches, 2);
    const missing = budgetPayloads({ recorder, limit: 'maxDispatches' });
    assert.equal(missing.length, 0, 'the second dispatch only settles after that tick');

    // MER-1 is parked and MER-2 holds a claim with a retry that is not due:
    // both are ineligible, so neither reaches the guard.
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);
    assert.equal(scheduler.snapshot().parked.length, 1);
    assert.equal(scheduler.snapshot().retrying.length, 1);
});

test('a due retry behind a full lane re-queues without an event; freeing the lane emits once', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow({
        run: async ({ item, attempt }) => {
            if (item.identifier === 'MER-1' && attempt === 1) return { status: 'failed' };
            if (item.identifier === 'MER-2') return gate.promise;
            return completedResult();
        }
    });
    const { scheduler, recorder, clock, items, workflow: wf } = await setup({
        workflow,
        options: {
            concurrency: { global: 2, byLane: { default: 1 } },
            allowSharedWorkspace: true,
            retry: { baseMs: 1_000, maxMs: 1_000 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 3, maxDispatches: 2 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().retrying.length, 1);
    // The lane is free again once the failed attempt settles, so MER-2 takes it.
    await scheduler.tick();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 2);
    assert.equal(scheduler.snapshot().totals.dispatches, 2);

    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0, 'the lane is the block');
    const retries = payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(retries.at(-1)?.attempt, 2, 'the retry keeps its attempt');
    assert.equal(wf.calls.length, 2, 'no attempt is started behind a full lane');

    gate.resolve(completedResult());
    await flush();
    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    assert.equal(budgetPayloads({ recorder, limit: 'maxDispatches' }).length, 1);
    assert.equal(wf.calls.length, 2, 'the token-free guard blocks the retry dispatch too');
});

test('maxTotalUsd stays inert when a settled attempt reported no cost', { timeout: 5000 }, async () => {
    const workflow = createWorkflow({
        run: async ({ item }) => {
            if (item.identifier === 'MER-2') return { status: 'completed', usage: { total_tokens: 1, cost_usd: 0.10 } };
            return { status: 'completed', usage: { total_tokens: 1 } };
        }
    });
    const { scheduler, recorder, items, workflow: wf } = await setup({
        workflow,
        options: {
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalUsd: 0.05 }
        }
    });
    items.push(
        rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }),
        rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }),
        rawItem({ id: 'id-3', identifier: 'MER-3', priority: 3 })
    );

    await scheduler.tick();
    await flush();
    await scheduler.tick();
    await flush();
    const totals = scheduler.snapshot().totals;
    assert.equal(totals.costUsd, 0.10);
    assert.equal(totals.costComplete, false, 'one attempt never reported a cost');

    // The sum is over the limit but incomplete, so it cannot prove it.
    await scheduler.tick();
    await flush();
    assert.equal(wf.calls.length, 3);
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);

    // Same limit, complete cost reporting, sum at the limit: blocked, one event.
    const fresh = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'completed', usage: { total_tokens: 1, cost_usd: 0.05 } }) }),
        options: {
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalUsd: 0.05 }
        }
    });
    fresh.items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));
    await fresh.scheduler.tick();
    await flush();
    await fresh.scheduler.tick();
    assert.equal(fresh.workflow.calls.length, 1);
    assert.equal(budgetPayloads({ recorder: fresh.recorder, limit: 'maxTotalUsd' }).length, 1);
});

test('a throwing emitSafe on budget_exhausted keeps the due retry and its claim', { timeout: 5000 }, async () => {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    /** @type {Recorder & {emitSafe: (arg0: string, arg1: Record<string, unknown>) => void}} */
    const recorder = {
        events,
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {},
        emitSafe: (name, payload) => {
            if (name === EVENTS.SCHEDULER.BUDGET_EXHAUSTED) throw new Error('hostile emitSafe');
            events.push({ event: name, ...payload });
        }
    };
    const clock = createClock();
    const items = [rawItem()];
    const source = createMemoryWorkSource({ items });
    const workflow = createWorkflow({
        run: async ({ attempt }) => (attempt === 1 ? { status: 'failed' } : completedResult())
    });
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow,
        eventEmitter: recorder,
        clock,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 3, maxDispatches: 1 },
        retry: { baseMs: 1_000, maxMs: 1_000 }
    });
    await scheduler.start();
    recorder.events.length = 0;
    events.length = 0;

    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().retrying.length, 1);
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 0);

    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    // The failure is contained: the tick reports it and never rejects.
    const failure = events.find((entry) => entry.event === EVENTS.ERRORS.LISTENER_ERROR);
    assert.equal(failure !== undefined, true, 'the listener-error fallback names the failure');
    assert.equal(failure?.sourceEvent, EVENTS.SCHEDULER.BUDGET_EXHAUSTED);
    const tick = payloads({ recorder, name: EVENTS.SCHEDULER.TICK });
    assert.equal(tick.at(-1)?.outcome, 'ok');
    // The queued retry survived the throw, at the same attempt, with its claim.
    const retrying = scheduler.snapshot().retrying;
    assert.equal(retrying.length, 1);
    assert.equal(retrying[0].attempt, 2);
    assert.equal(scheduler.snapshot().claimed.includes('MER-1'), true);

    await scheduler.applyConfig({ options: { limits: { maxAttemptsPerItem: 3, maxDispatches: 5 } } });
    clock.advance(1_000);
    await scheduler.tick();
    await flush();
    assert.deepEqual(workflow.calls.map((call) => call.attempt), [1, 2]);
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.COMPLETED }).length, 1);
});

test('in-flight overshoot: an attempt that spends 50 against a limit of 10 settles', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items } = await setup({
        workflow: createWorkflow({ run: async () => ({ status: 'completed', usage: { total_tokens: 50 } }) }),
        options: {
            concurrency: { global: 1 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1, maxTotalTokens: 10 }
        }
    });
    items.push(rawItem({ id: 'id-1', identifier: 'MER-1', priority: 1 }), rawItem({ id: 'id-2', identifier: 'MER-2', priority: 2 }));

    await scheduler.tick();
    await flush();
    assert.equal(scheduler.snapshot().totals.totalTokens, 50);
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.COMPLETED }).length, 1);

    await scheduler.tick();
    const hits = budgetPayloads({ recorder, limit: 'maxTotalTokens' });
    assert.equal(hits.length, 1);
    assert.equal(/** @type {{totalTokens: number}} */ (hits[0].totals).totalTokens, 50);
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 1);
    assert.equal(payloads({ recorder, name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED }).length, 1);
});

test('a result flagged nonRetryable parks on its first failure', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({
            run: async () => ({ status: 'failed', errorCode: 'MY-APP-ERR', nonRetryable: true })
        }),
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 5 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    assert.equal(workflow.calls.length, 1, 'a non-retryable failure is not dispatched twice');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
    const failed = payloads({ recorder, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].errorCode, 'MY-APP-ERR');
    const parked = payloads({ recorder, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked[0].reason, 'non_retryable');
    assert.equal(scheduler.snapshot().parked.length, 1);
});

test('a failed result keeps its errorCode on the attempts-exhausted path', { timeout: 5000 }, async () => {
    const { scheduler, recorder, clock, items, workflow } = await setup({
        workflow: createWorkflow({
            run: async () => ({ status: 'failed', error: { name: 'AppError', code: 'MERCI-CONFIG-ERR' } })
        }),
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 2 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();
    clock.advance(1_000);
    await scheduler.tick();
    await flush();

    assert.equal(workflow.calls.length, 2);
    const failed = payloads({ recorder, name: EVENTS.WORK_ITEM.FAILED });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].errorCode, 'MERCI-CONFIG-ERR');
    assert.equal(failed[0].errorName, 'AppError');
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.PARKED })[0].reason, 'attempts_exhausted');
});

test('a stopped scheduler resumes on start()', { timeout: 5000 }, async () => {
    const { scheduler } = await setup({});

    await scheduler.stop({ timeoutMs: 1_000 });
    assert.equal(scheduler.snapshot().stopped, true);

    await scheduler.start();
    assert.equal(scheduler.snapshot().started, true);
    assert.equal(scheduler.snapshot().stopped, false);

    await scheduler.stop({ timeoutMs: 1_000 });
});

test('a failed resume leaves the scheduler stopped, not wedged', { timeout: 5000 }, async () => {
    let blocked = false;
    const { scheduler } = await setup({
        options: { preflight: () => (blocked ? ['the workflow is momentarily invalid'] : []) }
    });

    await scheduler.stop({ timeoutMs: 1_000 });
    blocked = true;
    await assert.rejects(() => scheduler.start(), /invalid scheduler configuration/);
    assert.equal(scheduler.snapshot().stopped, true, 'a failed resume must stay stopped, not report running');

    blocked = false;
    await scheduler.start();
    assert.equal(scheduler.snapshot().started, true);
    assert.equal(scheduler.snapshot().stopped, false);

    await scheduler.stop({ timeoutMs: 1_000 });
});

test('a canceled result keeps its error evidence and parks instead of retrying', { timeout: 5000 }, async () => {
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({
            run: async () => ({ status: 'canceled', error: { code: 'PERMISSION_DENIED' } })
        }),
        options: { limits: { maxAttemptsPerItem: 5 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    await flush();

    assert.equal(workflow.calls.length, 1);
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
    const parked = payloads({ recorder, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'non_retryable');
});

test('cancelItem parks one running attempt and does not redispatch it', { timeout: 5000 }, async () => {
    const gate = deferred();
    const { scheduler, recorder, items, workflow } = await setup({
        workflow: createWorkflow({
            run: async () => { await gate.promise; return completedResult(); }
        }),
        options: { concurrency: { global: 1 } }
    });
    items.push(rawItem());

    await scheduler.tick();
    assert.equal(workflow.calls.length, 1);

    const result = await scheduler.cancelItem({ identifier: 'MER-1' });
    assert.deepEqual(result, { canceled: true, status: 'running' });

    gate.resolve();
    await flush();

    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
    const parked = payloads({ recorder, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'canceled');
    assert.equal(scheduler.snapshot().parked.length, 1, 'the claim is kept');
    assert.equal(scheduler.snapshot().running.length, 0);

    await scheduler.tick();
    await flush();
    assert.equal(workflow.calls.length, 1, 'an active tracker item is not redispatched after a cancel');
});

test('cancelItem rejects an unknown item and a stopped scheduler', { timeout: 5000 }, async () => {
    const { scheduler } = await setup({});
    await assert.rejects(() => scheduler.cancelItem({ identifier: 'NOPE' }), /no running, retrying or parked item/);
    await scheduler.stop({ timeoutMs: 1_000 });
    await assert.rejects(() => scheduler.cancelItem({ identifier: 'X' }), /stopped/);
});

test('cancelItem during a retry refresh is deferred, then the attempt is parked', { timeout: 5000 }, async () => {
    const recorder = createEmitter();
    const clock = createClock();
    const entered = deferred();
    const release = deferred();
    const base = createMemoryWorkSource({ items: [rawItem()], eventEmitter: recorder });
    const source = {
        fetchByStates: (/** @type {any} */ arg) => base.fetchByStates(arg),
        fetchByIds: async (/** @type {any} */ arg) => {
            entered.resolve();
            await release.promise;
            return base.fetchByIds(arg);
        }
    };
    const scheduler = new WorkScheduler({
        workSource: /** @type {any} */ (source),
        workflow: createWorkflow({ run: async () => ({ status: 'failed' }) }),
        eventEmitter: recorder,
        clock,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        continuation: { delayMs: 0, max: 0 },
        retry: { baseMs: 1_000, maxMs: 1_000 },
        limits: { maxAttemptsPerItem: 5 }
    });
    await scheduler.start();
    await flush();
    recorder.events.length = 0;

    clock.advance(1_000);
    const tick = scheduler.tick();
    await entered.promise;

    const result = await scheduler.cancelItem({ identifier: 'MER-1' });
    assert.deepEqual(result, { canceled: true, status: 'pending' }, 'the request is deferred, not refused');

    release.resolve();
    await tick;
    await flush();

    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 0, 'the cancelled retry never runs');
    const parked = payloads({ recorder, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'canceled');

    await scheduler.tick();
    await flush();
    assert.equal(payloads({ recorder, name: EVENTS.WORK_ITEM.DISPATCHED }).length, 0, 'a later scan does not redispatch it');

    await scheduler.stop({ timeoutMs: 1_000 });
});
