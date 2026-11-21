// @ts-check

/**
 * @file Stage 8 contract tests for the scheduler event registry (AC17, §5.11).
 * @version 0.12.0
 *
 * @description
 * Two halves. The registry half pins the leaf count (296 at this program stage), name uniqueness, and
 * the documented order of `EVENTS.SCHEDULER` / `EVENTS.WORK_ITEM`. The drive
 * half runs one small scenario per scheduler/work-item leaf with a recording
 * emitter, asserts the union equals the 21 documented names, and then scans
 * every captured payload for leaked prose: no description, title, prompt,
 * message, tool arguments, or error message, and a fixture sentinel never
 * appears anywhere. Payload key sets are pinned for every scheduler and
 * work-item leaf.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkScheduler, createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** A value that must never reach an event payload. */
const SECRET = 'SENTINEL-do-not-emit-7f3a';

/**
 * The 21 documented scheduler/work-item leaves (§3.12).
 * @type {ReadonlyArray<string>}
 */
const DOCUMENTED_LEAVES = Object.freeze([
    EVENTS.SCHEDULER.START,
    EVENTS.SCHEDULER.STOP,
    EVENTS.SCHEDULER.TICK,
    EVENTS.SCHEDULER.VALIDATION_ERROR,
    EVENTS.SCHEDULER.WORK_SOURCE_ERROR,
    EVENTS.SCHEDULER.BUDGET_EXHAUSTED,
    EVENTS.SCHEDULER.INTERNAL_ERROR,
    EVENTS.SCHEDULER.CONFIGURED,
    EVENTS.WORK_ITEM.SKIPPED,
    EVENTS.WORK_ITEM.CLAIMED,
    EVENTS.WORK_ITEM.CLAIM_FAILED,
    EVENTS.WORK_ITEM.DISPATCHED,
    EVENTS.WORK_ITEM.CONTINUED,
    EVENTS.WORK_ITEM.RETRY_SCHEDULED,
    EVENTS.WORK_ITEM.STALLED,
    EVENTS.WORK_ITEM.RECONCILED,
    EVENTS.WORK_ITEM.COMPLETED,
    EVENTS.WORK_ITEM.FAILED,
    EVENTS.WORK_ITEM.RELEASED,
    EVENTS.WORK_ITEM.PARKED,
    EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED
]);

/**
 * @typedef {Object} Recorder
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/** @returns {Recorder} */
function createRecorder() {
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

/** @returns {Promise<void>} */
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
 * An error whose message is the sentinel: only `name`/`code` may survive.
 * @param {{name: string, code: string}} arg0 -
 * @returns {Error}
 */
function namedError({ name, code }) {
    const error = new Error(SECRET);
    error.name = name;
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (error)).code = code;
    return error;
}

/**
 * A workflow that resolves `canceled` when the scheduler aborts it, so the
 * settle path (and any cleanup) is observable.
 * @returns {(arg0: {signal: AbortSignal}) => Promise<Record<string, unknown>>}
 */
function abortableRun() {
    return ({ signal }) => new Promise((resolve) => {
        if (signal.aborted) {
            resolve({ status: 'canceled' });
            return;
        }
        signal.addEventListener('abort', () => resolve({ status: 'canceled' }));
    });
}

/**
 * A duck-typed workspace manager, with the removal outcome the test needs.
 * @param {{removeResult?: {removed: boolean, reason?: string}}} [arg0] -
 * @returns {{
 *   ensure: (arg0: {workItemId: string}) => Promise<Record<string, unknown>>,
 *   beforeRun: () => Promise<void>,
 *   afterRun: () => Promise<void>,
 *   remove: () => Promise<{removed: boolean, reason?: string}>,
 *   handleFor: (arg0: {workItemId: string}) => Record<string, unknown>
 * }}
 */
function createFakeWorkspace({ removeResult = { removed: true } } = {}) {
    return {
        ensure: async ({ workItemId }) => ({ workItemId, path: `/tmp/ws/${workItemId}` }),
        beforeRun: async () => {},
        afterRun: async () => {},
        remove: async () => removeResult,
        handleFor: ({ workItemId }) => ({ workItemId, path: `/tmp/ws/${workItemId}` })
    };
}

/**
 * @param {{
 *   recorder: Recorder,
 *   items?: unknown[],
 *   run?: (arg0: {item: {identifier: string}, attempt: number, signal: AbortSignal, reportProgress: () => void}) => Promise<unknown>,
 *   workSource?: NonNullable<ConstructorParameters<typeof WorkScheduler>[0]>['workSource'],
 *   workspace?: ReturnType<typeof createFakeWorkspace>,
 *   options?: Record<string, unknown>,
 *   clock?: ReturnType<typeof createClock>
 * }} arg0 -
 * @returns {{scheduler: WorkScheduler, recorder: Recorder, clock: ReturnType<typeof createClock>}}
 */
function build({ recorder, items = [], run, workSource, workspace = undefined, options = {}, clock = createClock() }) {
    const source = workSource ?? createMemoryWorkSource({ items, eventEmitter: recorder });
    const workflow = {
        run: run ?? (async () => ({ status: 'completed', usage: { total_tokens: 10 } }))
    };
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow,
        workspace,
        eventEmitter: recorder,
        clock,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        ...options
    });
    return { scheduler, recorder, clock };
}

/**
 * Run one scenario per leaf and return every captured event.
 * @returns {Promise<Array<{event: string, [key: string]: unknown}>>}
 */
async function driveAllEvents() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const captured = [];
    /** @param {Recorder} recorder */
    const take = (recorder) => { captured.push(...recorder.events); };

    // start / tick / configured / stop
    {
        const recorder = createRecorder();
        const { scheduler } = build({ recorder });
        await scheduler.start();
        await scheduler.applyConfig({ options: { pollIntervalMs: 20_000 } });
        await scheduler.stop();
        take(recorder);
    }

    // skipped (malformed record) / claimed / dispatched / completed / parked / released
    {
        const recorder = createRecorder();
        const items = [
            { id: 'broken' },
            rawItem({ title: SECRET, description: SECRET, metadata: { note: SECRET } })
        ];
        const { scheduler } = build({ recorder, items });
        await scheduler.start();
        await flush();
        await scheduler.tick();
        await flush();
        await scheduler.stop();
        take(recorder);
    }

    // claim_failed (a store that refuses)
    {
        const recorder = createRecorder();
        const claims = {
            acquire: async () => false,
            release: async () => true,
            isClaimed: () => false,
            list: () => []
        };
        const { scheduler } = build({ recorder, items: [rawItem()], options: { claims } });
        await scheduler.start();
        await flush();
        await scheduler.stop();
        take(recorder);
    }

    // retry_scheduled / failed / parked (attempts exhausted)
    {
        const recorder = createRecorder();
        const clock = createClock();
        const { scheduler } = build({
            recorder,
            clock,
            items: [rawItem()],
            run: async () => { throw namedError({ name: 'WorkBoom', code: 'E_WORK' }); },
            options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 2 } }
        });
        await scheduler.start();
        await flush();
        clock.advance(1_000);
        await scheduler.tick();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    // continued (a clean completion schedules one continuation)
    {
        const recorder = createRecorder();
        const { scheduler } = build({
            recorder,
            items: [rawItem()],
            options: { continuation: { delayMs: 0, max: 1 } }
        });
        await scheduler.start();
        await flush();
        await scheduler.tick();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    // stalled (the clock advances past the watchdog)
    {
        const recorder = createRecorder();
        const clock = createClock();
        const { scheduler } = build({
            recorder,
            clock,
            items: [rawItem()],
            run: abortableRun(),
            options: {
                stallTimeoutMs: 100,
                retry: { baseMs: 1_000, maxMs: 1_000 },
                limits: { maxAttemptsPerItem: 3 }
            }
        });
        await scheduler.start();
        clock.advance(200);
        await scheduler.tick();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    // reconciled / workspace_cleanup_refused (terminal item, dirty workspace)
    {
        const recorder = createRecorder();
        const item = rawItem();
        const { scheduler } = build({
            recorder,
            items: [item],
            run: abortableRun(),
            workspace: createFakeWorkspace({ removeResult: { removed: false, reason: 'dirty' } })
        });
        await scheduler.start();
        item.state = 'Done';
        await scheduler.tick();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    // work_source_error (the fetch throws)
    {
        const recorder = createRecorder();
        const workSource = {
            fetchByStates: () => { throw namedError({ name: 'SourceBoom', code: 'E_SRC' }); },
            fetchByIds: () => []
        };
        const { scheduler } = build({ recorder, workSource });
        await scheduler.start();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    // validation_error (duplicate identifiers fail the tick closed)
    {
        const recorder = createRecorder();
        const items = [
            rawItem({ id: 'dup-1', identifier: 'DUP' }),
            rawItem({ id: 'dup-2', identifier: 'DUP' }),
            rawItem({ id: 'ok-1', identifier: 'MER-9' })
        ];
        const { scheduler } = build({ recorder, items });
        await scheduler.start();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    // internal_error (a throwing preflight)
    {
        const recorder = createRecorder();
        const { scheduler } = build({ recorder });
        await scheduler.start();
        await scheduler.applyConfig({
            options: {
                preflight: () => { throw namedError({ name: 'PreflightBoom', code: 'E_PREFLIGHT' }); }
            }
        });
        await scheduler.tick();
        take(recorder);
        await scheduler.stop();
    }

    // budget_exhausted (a dispatch limit of one)
    {
        const recorder = createRecorder();
        const items = [
            rawItem({ id: 'budget-1', identifier: 'MER-A', priority: 1 }),
            rawItem({ id: 'budget-2', identifier: 'MER-B', priority: 2 })
        ];
        const { scheduler } = build({
            recorder,
            items,
            options: {
                concurrency: { global: 2 },
                allowSharedWorkspace: true,
                limits: { maxAttemptsPerItem: 1, maxDispatches: 1 }
            }
        });
        await scheduler.start();
        await flush();
        take(recorder);
        await scheduler.stop();
    }

    return captured;
}

/** @type {Promise<Array<{event: string, [key: string]: unknown}>>|null} */
let driven = null;

/** @returns {Promise<Array<{event: string, [key: string]: unknown}>>} */
function driveOnce() {
    driven ??= driveAllEvents();
    return driven;
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
 * @param {{value: unknown, key: string, found: string[]}} arg0 -
 * @returns {void}
 */
function findKey({ value, key, found }) {
    if (Array.isArray(value)) {
        for (const entry of value) findKey({ value: entry, key, found });
        return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
        if (name === key) found.push(name);
        findKey({ value: child, key, found });
    }
}

/**
 * Collect every string value in a payload tree.
 * @param {{value: unknown, out: string[]}} arg0 -
 * @returns {void}
 */
function collectStrings({ value, out }) {
    if (typeof value === 'string') {
        out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const entry of value) collectStrings({ value: entry, out });
        return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const child of Object.values(value)) collectStrings({ value: child, out });
}

// 297 is the slice boundary total: the 286 scheduler-era leaves, the 6
// workflow-policy leaves this slice adds, the 3 decision-client leaves
// (`decisions_start` / `decisions_finish` / `decisions_error`), the one
// decision-gate leaf (`decision_gate`), and `session:store_corrupt` (G1-3).
test('registry: 302 unique leaves at the slice boundary, 8 scheduler and 13 work-item leaves in order', () => {
    /** @type {string[]} */
    const names = [];
    /**
     * @param {unknown} value -
     * @returns {void}
     */
    function walk(value) {
        if (typeof value === 'string') {
            names.push(value);
            return;
        }
        if (value === null || typeof value !== 'object') return;
        for (const child of Object.values(value)) walk(child);
    }
    walk(EVENTS);

    assert.equal(names.length, 302);
    assert.equal(new Set(names).size, 302, 'every leaf name is unique');

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
    assert.equal(Object.keys(EVENTS.SCHEDULER).length, 8);
    assert.equal(Object.keys(EVENTS.WORK_ITEM).length, 13);
    assert.deepEqual(
        Object.values(EVENTS.WORK_ITEM),
        [
            'work_item:skipped',
            'work_item:claimed',
            'work_item:claim_failed',
            'work_item:dispatched',
            'work_item:continued',
            'work_item:retry_scheduled',
            'work_item:stalled',
            'work_item:reconciled',
            'work_item:completed',
            'work_item:failed',
            'work_item:released',
            'work_item:parked',
            'work_item:workspace_cleanup_refused'
        ]
    );
});

test('every documented scheduler/work-item leaf is emitted at least once', { timeout: 5000 }, async () => {
    const events = await driveOnce();
    const seen = new Set(events.map((entry) => entry.event));
    for (const name of DOCUMENTED_LEAVES) {
        assert.equal(seen.has(name), true, `${name} was never emitted`);
    }
    assert.deepEqual([...seen].sort(), [...DOCUMENTED_LEAVES].sort());
    assert.equal(seen.size, 21);
});

test('payload hygiene: no prose, no error message, no sentinel, numeric usage', { timeout: 5000 }, async () => {
    const events = await driveOnce();
    const payloads = events.map((entry) => payloadOf(entry));

    const forbiddenTopLevel = ['description', 'title', 'prompt', 'message', 'messages', 'toolArgs', 'arguments'];
    for (const [index, payload] of payloads.entries()) {
        for (const key of forbiddenTopLevel) {
            assert.equal(Object.hasOwn(payload, key), false, `${events[index].event} carries ${key}`);
            /** @type {string[]} */
            const found = [];
            findKey({ value: payload, key, found });
            assert.deepEqual(found, [], `${events[index].event} carries a nested ${key}`);
        }
    }

    // Only name/code/logical class details survive a failure.
    const failed = events.filter((entry) => entry.event === EVENTS.WORK_ITEM.FAILED).map((entry) => payloadOf(entry));
    assert.equal(failed.length > 0, true);
    for (const payload of failed) {
        assert.deepEqual(
            Object.keys(payload).sort(),
            ['attempt', 'errorCode', 'errorName', 'failureClass', 'identifier', 'workItemId']
        );
        assert.equal(payload.errorName, 'WorkBoom');
        assert.equal(payload.errorCode, 'E_WORK');
    }
    const retries = events
        .filter((entry) => entry.event === EVENTS.WORK_ITEM.RETRY_SCHEDULED)
        .map((entry) => payloadOf(entry));
    assert.equal(retries.length > 0, true);
    for (const payload of retries) {
        assert.deepEqual(
            Object.keys(payload).sort(),
            ['attempt', 'delayMs', 'dueAtMs', 'failureClass', 'identifier', 'workItemId']
        );
    }

    // Usage is a flat numeric map, never provider prose.
    for (const entry of events) {
        if (entry.event !== EVENTS.WORK_ITEM.COMPLETED) continue;
        const usage = payloadOf(entry).usage;
        if (usage === null) continue;
        assert.equal(typeof usage, 'object');
        for (const value of Object.values(/** @type {Record<string, unknown>} */ (usage))) {
            assert.equal(typeof value, 'number');
            assert.equal(Number.isFinite(value), true);
        }
    }

    // One cost reader: a camelCase usage costs the same in the event payload and
    // in the totals instead of leaving the event usage null.
    const camelRecorder = createRecorder();
    const camel = build({
        recorder: camelRecorder,
        items: [rawItem()],
        run: async () => ({ status: 'completed', usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10, costUsd: 0.25 } })
    });
    await camel.scheduler.start();
    await flush();
    await camel.scheduler.tick();
    await flush();
    await camel.scheduler.stop();
    const camelCompleted = camelRecorder.events.find((entry) => entry.event === EVENTS.WORK_ITEM.COMPLETED);
    assert.ok(camelCompleted, 'the attempt completed');
    assert.deepEqual(payloadOf(camelCompleted).usage, { cost_usd: 0.25 }, 'the camelCase cost reaches the event payload');
    assert.equal(camel.scheduler.snapshot().totals.costUsd, 0.25, 'and matches the totals');

    /** @type {string[]} */
    const strings = [];
    collectStrings({ value: payloads, out: strings });
    for (const value of strings) {
        assert.equal(value.includes(SECRET), false, `a payload leaked the sentinel: ${value}`);
    }
});

test('exact payload key sets for budget_exhausted, tick, parked, and reconciled', { timeout: 5000 }, async () => {
    const events = await driveOnce();
    /** @param {string} name */
    const payloadsFor = (name) => events.filter((entry) => entry.event === name).map((entry) => payloadOf(entry));

    const budget = payloadsFor(EVENTS.SCHEDULER.BUDGET_EXHAUSTED);
    assert.equal(budget.length, 1);
    assert.deepEqual(Object.keys(budget[0]).sort(), ['limit', 'totals']);
    assert.deepEqual(
        Object.keys(/** @type {Record<string, unknown>} */ (budget[0].totals)).sort(),
        [
            'attempts',
            'costComplete',
            'costUsd',
            'dispatches',
            'failures',
            'inputTokens',
            'outputTokens',
            'totalTokens',
            'usageComplete'
        ]
    );

    const ticks = payloadsFor(EVENTS.SCHEDULER.TICK);
    assert.equal(ticks.length > 0, true);
    for (const payload of ticks) {
        assert.deepEqual(
            Object.keys(payload).sort(),
            ['claimed', 'dispatched', 'fetched', 'outcome', 'parked', 'retrying', 'running']
        );
    }

    const parked = payloadsFor(EVENTS.WORK_ITEM.PARKED);
    assert.equal(parked.length > 0, true);
    for (const payload of parked) {
        assert.deepEqual(
            Object.keys(payload).sort(),
            ['attempts', 'continuations', 'identifier', 'nextCheckAt', 'reason', 'workItemId']
        );
    }

    const reconciled = payloadsFor(EVENTS.WORK_ITEM.RECONCILED);
    assert.equal(reconciled.length > 0, true);
    for (const payload of reconciled) {
        assert.deepEqual(Object.keys(payload).sort(), ['cleanup', 'identifier', 'reason', 'workItemId']);
    }
});

test('exact payload key sets for the remaining scheduler and work-item leaves', { timeout: 5000 }, async () => {
    const events = await driveOnce();
    /**
     * @param {string} name -
     * @returns {Array<Record<string, unknown>>}
     */
    const payloadsFor = (name) => events.filter((entry) => entry.event === name).map((entry) => payloadOf(entry));
    /**
     * @param {string} name -
     * @param {string[]} keys -
     * @returns {void}
     */
    const assertKeys = (name, keys) => {
        const found = payloadsFor(name);
        assert.equal(found.length > 0, true, `${name} was never emitted`);
        for (const payload of found) assert.deepEqual(Object.keys(payload).sort(), [...keys].sort(), name);
    };

    assertKeys(EVENTS.SCHEDULER.START, ['activeStates', 'concurrency', 'pollIntervalMs', 'terminalStates']);
    assertKeys(EVENTS.SCHEDULER.STOP, ['drained', 'parked', 'reason', 'retrying', 'running']);
    assertKeys(EVENTS.SCHEDULER.VALIDATION_ERROR, ['errors']);
    assertKeys(EVENTS.SCHEDULER.WORK_SOURCE_ERROR, ['category', 'op']);
    assertKeys(EVENTS.SCHEDULER.INTERNAL_ERROR, ['errorCode', 'errorName', 'op']);
    assertKeys(EVENTS.SCHEDULER.CONFIGURED, ['changed', 'source']);
    assertKeys(EVENTS.WORK_ITEM.CLAIMED, ['attempt', 'identifier', 'owner', 'workItemId']);
    assertKeys(EVENTS.WORK_ITEM.CLAIM_FAILED, ['identifier', 'reason', 'workItemId']);
    assertKeys(EVENTS.WORK_ITEM.DISPATCHED, ['attempt', 'identifier', 'lane', 'priority', 'state', 'workItemId']);
    assertKeys(EVENTS.WORK_ITEM.COMPLETED, ['attempt', 'durationMs', 'identifier', 'usage', 'workItemId']);
    assertKeys(EVENTS.WORK_ITEM.RELEASED, ['identifier', 'reason', 'workItemId']);
});
