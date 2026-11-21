// @ts-check

/**
 * @file Stage 6 contract tests for the workspace lifecycle: attempt order,
 * `afterRun` coverage, terminal cleanup, startup cleanup, and the snapshot
 * `threadId`/`workspacePath` row.
 * @version 0.12.0
 *
 * @description
 * Drives `WorkScheduler` with a recording fake workspace manager, an
 * in-memory work source, a fake workflow, a capturing emitter, and a manual
 * clock. Every fake call keeps its input object, so a test can assert the
 * arguments (including signal presence), not just the call count. The
 * assertions pin AC13/AC15/AC17 and §3.9/§5.6; a real `WorkspaceManager` is
 * exercised in `scheduler-workspace-integration.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkScheduler, createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/**
 * @typedef {Object} WorkflowInput
 * @property {WorkItem} item
 * @property {number} attempt
 * @property {Record<string, unknown>|null} workspace
 * @property {AbortSignal} signal
 * @property {() => void} reportProgress
 */

/**
 * @typedef {Object} WorkspaceCall
 * @property {string} method
 * @property {Record<string, unknown>} args
 */

/**
 * A capturing emitter with an `emitSafe` seam; `emit` is the fallback
 * `emitEvent` swallows.
 * @typedef {Object} CapturingEmitter
 * @property {Array<{event: string, [key: string]: unknown}>} events
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
    return {
        events,
        emitSafe: (name, envelope) => { events.push(/** @type {{event: string, [key: string]: unknown}} */ (envelope)); },
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {}
    };
}

/**
 * A manual clock: timers fire only inside `advance`.
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
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 10 } = {}) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * @param {{overrides?: Record<string, unknown>}} [arg0] -
 * @returns {Record<string, unknown>}
 */
function rawItem({ overrides = {} } = {}) {
    return {
        id: 'id-1',
        identifier: 'MER-1',
        title: 'One',
        state: 'Todo',
        dispatchable: true,
        ...overrides
    };
}

/**
 * @param {Record<string, unknown>} [overrides] -
 * @returns {Record<string, unknown>}
 */
function completedResult(overrides = {}) {
    return { status: 'completed', ...overrides };
}

/**
 * @param {{name?: string}} [arg0] -
 * @returns {Error}
 */
function namedError({ name = 'BoomError' } = {}) {
    const error = new Error('synthetic failure');
    error.name = name;
    return error;
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
 * @param {{order?: string[]}} [arg0] -
 * @returns {{calls: WorkflowInput[], run: (arg0: WorkflowInput) => Promise<unknown>}}
 */
function createWorkflow({ order = [] } = {}) {
    /** @type {WorkflowInput[]} */
    const calls = [];
    return {
        calls,
        run: async (input) => {
            calls.push(input);
            order.push('run');
            return completedResult();
        }
    };
}

/**
 * Options for {@link createFakeWorkspace}. `errorFor` narrows a throwing
 * `handleFor`/`remove` to one work item so "continues with the next item" is
 * observable.
 * @typedef {Object} FakeWorkspaceOptions
 * @property {unknown} [ensureError]
 * @property {unknown} [beforeRunError]
 * @property {unknown} [afterRunError]
 * @property {unknown} [removeError]
 * @property {{removed?: boolean, reason?: string}|null|undefined} [removeResult]
 * @property {unknown} [handleForError]
 * @property {string|null} [errorFor]
 */

/**
 * A fake manager that records every call with its arguments. Handles are
 * frozen and stable per `workItemId`, like the real manager's.
 * @param {FakeWorkspaceOptions} [arg0] -
 * @returns {{
 *   calls: WorkspaceCall[],
 *   order: string[],
 *   ensure: (arg0: {workItemId: string, signal?: AbortSignal}) => Promise<Record<string, unknown>>,
 *   beforeRun: (arg0: {workspace: Record<string, unknown>, signal?: AbortSignal}) => Promise<void>,
 *   afterRun: (arg0: {workspace: Record<string, unknown>, outcome: string, signal?: AbortSignal}) => Promise<void>,
 *   remove: (arg0: {workspace: Record<string, unknown>, force?: boolean}) => Promise<{removed?: boolean, reason?: string}|null|undefined>,
 *   handleFor: (arg0: {workItemId: string}) => Record<string, unknown>
 * }}
 */
function createFakeWorkspace({
    ensureError = null,
    beforeRunError = null,
    afterRunError = null,
    removeError = null,
    removeResult = undefined,
    handleForError = null,
    errorFor = null
} = {}) {
    /** @type {WorkspaceCall[]} */
    const calls = [];
    /** @type {string[]} */
    const order = [];
    /** @type {Map<string, Record<string, unknown>>} */
    const handles = new Map();

    /**
     * @param {{method: string, args: Record<string, unknown>}} arg0 -
     * @returns {void}
     */
    const record = ({ method, args }) => {
        calls.push({ method, args });
        order.push(method);
    };

    /**
     * @param {{workItemId: string}} arg0 -
     * @returns {Record<string, unknown>}
     */
    const handle = ({ workItemId }) => {
        const key = `key:${workItemId}`;
        const existing = handles.get(key);
        if (existing) return existing;
        const created = Object.freeze({ workItemId, key, path: `/tmp/workspaces/${key}` });
        handles.set(key, created);
        return created;
    };

    /**
     * @param {{workItemId: unknown}} arg0 -
     * @returns {boolean}
     */
    const targeted = ({ workItemId }) => errorFor === null || String(workItemId) === errorFor;

    return {
        calls,
        order,
        ensure: async (args) => {
            record({ method: 'ensure', args: /** @type {Record<string, unknown>} */ (args) });
            if (ensureError !== null) throw ensureError;
            return handle({ workItemId: args.workItemId });
        },
        beforeRun: async (args) => {
            record({ method: 'beforeRun', args: /** @type {Record<string, unknown>} */ (args) });
            if (beforeRunError !== null) throw beforeRunError;
        },
        afterRun: async (args) => {
            record({ method: 'afterRun', args: /** @type {Record<string, unknown>} */ (args) });
            if (afterRunError !== null) throw afterRunError;
        },
        remove: async (args) => {
            record({ method: 'remove', args: /** @type {Record<string, unknown>} */ (args) });
            if (removeError !== null && targeted({ workItemId: args.workspace.workItemId })) throw removeError;
            return removeResult === undefined ? { removed: true } : removeResult;
        },
        handleFor: (args) => {
            record({ method: 'handleFor', args: /** @type {Record<string, unknown>} */ (args) });
            if (handleForError !== null && targeted({ workItemId: args.workItemId })) throw handleForError;
            return handle({ workItemId: args.workItemId });
        }
    };
}

/**
 * A memory source that records the states it was asked for, so a test can
 * assert that startup cleanup fetched (or skipped) the terminal states.
 * @param {{items: unknown[], emitter: CapturingEmitter}} arg0 -
 * @returns {{
 *   stateFetches: string[][],
 *   fetchByStates: (arg0: {states: string[], signal?: AbortSignal}) => ReadonlyArray<WorkItem>,
 *   fetchByIds: (arg0: {ids: string[], signal?: AbortSignal}) => ReadonlyArray<WorkItem>
 * }}
 */
function createRecordingSource({ items, emitter }) {
    const inner = createMemoryWorkSource({ items, eventEmitter: emitter });
    /** @type {string[][]} */
    const stateFetches = [];
    return {
        stateFetches,
        fetchByStates: (args) => {
            stateFetches.push([...args.states]);
            return inner.fetchByStates(args);
        },
        fetchByIds: (args) => inner.fetchByIds(args)
    };
}

/**
 * Resolve with a `canceled` result as soon as the scheduler aborts the signal.
 * @param {{signal: AbortSignal}} arg0 -
 * @returns {Promise<Record<string, unknown>>}
 */
function abortResult({ signal }) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve({ status: 'canceled' });
            return;
        }
        signal.addEventListener('abort', () => resolve({ status: 'canceled' }), { once: true });
    });
}

/**
 * Build (but do not start) a scheduler over the shared fixtures. `workspace`
 * is omitted entirely when null, so the "no manager" path is real.
 * @param {{
 *   items?: unknown[],
 *   options?: Record<string, unknown>,
 *   workflow?: ReturnType<typeof createWorkflow>,
 *   workspace?: ReturnType<typeof createFakeWorkspace>|null,
 *   emitter?: CapturingEmitter,
 *   clock?: ReturnType<typeof createClock>
 * }} [arg0] -
 */
function buildScheduler({
    items = [],
    options = {},
    workflow = createWorkflow(),
    workspace = null,
    emitter = createEmitter(),
    clock = createClock()
} = {}) {
    const source = createRecordingSource({ items, emitter });
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow,
        ...(workspace === null ? {} : { workspace }),
        eventEmitter: emitter,
        clock,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Canceled'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        ...options
    });
    return { scheduler, workflow, workspace, source, emitter, clock, items };
}

/**
 * Dispatch one item, then let the attempt run and settle.
 * @param {{
 *   workspace?: ReturnType<typeof createFakeWorkspace>,
 *   workflow?: ReturnType<typeof createWorkflow>,
 *   options?: Record<string, unknown>,
 *   items?: unknown[]
 * }} [arg0] -
 */
async function startedAttempt({ workspace, workflow, options = {}, items } = {}) {
    const ctx = buildScheduler({ items: items ?? [rawItem()], workflow, workspace, options });
    await ctx.scheduler.start();
    await flush();
    return ctx;
}

/**
 * @param {ReturnType<typeof createFakeWorkspace>} workspace -
 * @param {string} method -
 * @returns {WorkspaceCall[]}
 */
function callsOf(workspace, method) {
    return workspace.calls.filter((call) => call.method === method);
}

/**
 * Mark every item terminal and run one reconcile tick.
 * @param {{ctx: ReturnType<typeof buildScheduler>}} arg0 -
 * @returns {Promise<void>}
 */
async function moveToDoneAndTick({ ctx }) {
    for (const item of ctx.items) /** @type {Record<string, unknown>} */ (item).state = 'Done';
    await ctx.scheduler.tick();
    await flush();
}

test('an attempt runs ensure -> beforeRun -> workflow.run -> afterRun with the same handle', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace();
    const workflow = createWorkflow({ order: workspace.order });
    const ctx = await startedAttempt({ workspace, workflow });

    assert.deepEqual(workspace.order, ['ensure', 'beforeRun', 'run', 'afterRun']);
    assert.deepEqual(workspace.calls.map((call) => call.method), ['ensure', 'beforeRun', 'afterRun']);

    const ensureCall = callsOf(workspace, 'ensure')[0];
    const beforeCall = callsOf(workspace, 'beforeRun')[0];
    const afterCall = callsOf(workspace, 'afterRun')[0];
    assert.equal(ensureCall.args.workItemId, 'MER-1');
    assert.ok(ensureCall.args.signal instanceof AbortSignal, 'ensure receives the attempt signal');
    assert.ok(beforeCall.args.signal instanceof AbortSignal, 'beforeRun receives the attempt signal');

    const runCall = workflow.calls[0];
    assert.equal(typeof /** @type {Record<string, unknown>} */ (runCall.workspace).path, 'string');
    assert.deepEqual(afterCall.args.workspace, runCall.workspace, 'afterRun receives the same handle as run');
    assert.equal(afterCall.args.outcome, 'completed');
    assert.ok(afterCall.args.signal instanceof AbortSignal, 'afterRun receives the attempt signal');
    assert.deepEqual(ctx.scheduler.snapshot().running, []);
});

test('a throwing workflow still runs afterRun with outcome failed', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace();
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        throw namedError({ name: 'WorkflowBoom' });
    };
    await startedAttempt({ workspace, workflow });

    assert.deepEqual(workspace.order, ['ensure', 'beforeRun', 'run', 'afterRun']);
    assert.equal(callsOf(workspace, 'ensure').length, 1);
    assert.equal(callsOf(workspace, 'beforeRun').length, 1);
    assert.equal(callsOf(workspace, 'afterRun')[0].args.outcome, 'failed');
});

test('a throwing beforeRun fails the attempt, skips afterRun, retries, and re-ensures', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ beforeRunError: namedError({ name: 'HookBoom' }) });
    const ctx = await startedAttempt({
        workspace,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 3 } }
    });

    assert.equal(callsOf(workspace, 'ensure').length, 1);
    assert.equal(callsOf(workspace, 'beforeRun').length, 1);
    assert.equal(callsOf(workspace, 'afterRun').length, 0, 'afterRun never runs when beforeRun failed');
    assert.equal(ctx.workflow.calls.length, 0);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 1);
    assert.deepEqual(ctx.scheduler.snapshot().claimed, ['MER-1'], 'a retryable failure keeps the claim');

    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();

    const ensures = callsOf(workspace, 'ensure');
    assert.equal(ensures.length, 2, 'the retry ensures again');
    assert.deepEqual(ensures.map((call) => call.args.workItemId), ['MER-1', 'MER-1']);
    assert.equal(callsOf(workspace, 'afterRun').length, 0);
});

test('a throwing ensure fails the attempt without calling beforeRun or afterRun', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ ensureError: namedError({ name: 'EnsureBoom' }) });
    const ctx = await startedAttempt({
        workspace,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 3 } }
    });

    assert.equal(callsOf(workspace, 'ensure').length, 1);
    assert.equal(callsOf(workspace, 'beforeRun').length, 0);
    assert.equal(callsOf(workspace, 'afterRun').length, 0);
    assert.equal(ctx.workflow.calls.length, 0);
    const retries = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED });
    assert.equal(retries.length, 1);
    assert.deepEqual(ctx.scheduler.snapshot().claimed, ['MER-1']);

    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();
    assert.equal(callsOf(workspace, 'ensure').length, 2);
    assert.equal(callsOf(workspace, 'beforeRun').length, 0);
});

test('a throwing afterRun is swallowed: the settle still parks and no internal_error is emitted', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ afterRunError: namedError({ name: 'AfterRunBoom' }) });
    const ctx = await startedAttempt({ workspace });

    assert.equal(callsOf(workspace, 'afterRun').length, 1);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR }).length, 0);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.COMPLETED }).length, 1);
    const parked = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.PARKED });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'continuations_disabled');
    assert.deepEqual(ctx.scheduler.snapshot().claimed, ['MER-1'], 'the claim is handled normally');
});

test('terminal reconciliation removes the workspace once with force false, then releases', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace();
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        return abortResult({ signal: input.signal });
    };
    const ctx = await startedAttempt({ workspace, workflow });
    const running = ctx.scheduler.snapshot().running;
    assert.equal(running.length, 1);
    assert.equal(running[0].threadId, 'work:MER-1');
    assert.equal(running[0].workspacePath, '/tmp/workspaces/key:MER-1', 'the running row shows the handle path');

    await moveToDoneAndTick({ ctx });

    const removes = callsOf(workspace, 'remove');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].args.force, false);
    assert.equal(/** @type {Record<string, unknown>} */ (removes[0].args.workspace).key, 'key:MER-1');
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED }).length, 0);

    await ctx.scheduler.tick();
    await flush();
    assert.equal(callsOf(workspace, 'remove').length, 1, 'cleanup is never retried on a later tick');
});

test('a refused cleanup emits workspace_cleanup_refused and still releases the claim', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeResult: { removed: false, reason: 'dirty' } });
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        return abortResult({ signal: input.signal });
    };
    const ctx = await startedAttempt({ workspace, workflow });

    await moveToDoneAndTick({ ctx });

    const refusals = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED });
    assert.equal(refusals.length, 1);
    assert.deepEqual(Object.keys(refusals[0]).sort(), ['identifier', 'reason', 'workItemId']);
    assert.deepEqual(refusals[0], { workItemId: 'id-1', identifier: 'MER-1', reason: 'dirty' });
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');

    await ctx.scheduler.tick();
    await flush();
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED }).length, 1);
});

test('a missing removal result is not a refusal', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeResult: { removed: false, reason: 'missing' } });
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        return abortResult({ signal: input.signal });
    };
    const ctx = await startedAttempt({ workspace, workflow });

    await moveToDoneAndTick({ ctx });

    assert.equal(callsOf(workspace, 'remove').length, 1);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED }).length, 0);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED })[0].reason, 'terminal');
});

test('a retry fired for a terminal item cleans its workspace through handleFor, then releases', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeResult: { removed: false, reason: 'dirty' } });
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        return { status: 'failed' };
    };
    const ctx = await startedAttempt({
        workspace,
        workflow,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 3 } }
    });
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 1);
    assert.equal(callsOf(workspace, 'handleFor').length, 0, 'the failed attempt leaves a retry, not a cleanup');

    const item = /** @type {Record<string, unknown>} */ (ctx.items[0]);
    item.state = 'Done';
    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();

    const handleFors = callsOf(workspace, 'handleFor');
    assert.equal(handleFors.length, 1);
    assert.equal(handleFors[0].args.workItemId, 'MER-1');
    const removes = callsOf(workspace, 'remove');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].args.force, false);
    assert.equal(/** @type {Record<string, unknown>} */ (removes[0].args.workspace).key, 'key:MER-1');
    const refusals = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED });
    assert.deepEqual(refusals, [{ workItemId: 'id-1', identifier: 'MER-1', reason: 'dirty' }]);
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
    const names = ctx.emitter.events.map((entry) => entry.event);
    assert.ok(
        names.indexOf(EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED) < names.indexOf(EVENTS.WORK_ITEM.RELEASED),
        'cleanup runs before the release'
    );
});

test('a parked re-check that finds the item terminal cleans its workspace through handleFor, then releases', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeResult: { removed: false, reason: 'dirty' } });
    const ctx = await startedAttempt({
        workspace,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 } }
    });
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.PARKED }).length, 1);
    assert.equal(callsOf(workspace, 'handleFor').length, 0, 'parking does not clean the workspace');

    const item = /** @type {Record<string, unknown>} */ (ctx.items[0]);
    item.state = 'Done';
    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();

    const handleFors = callsOf(workspace, 'handleFor');
    assert.equal(handleFors.length, 1);
    assert.equal(handleFors[0].args.workItemId, 'MER-1');
    const removes = callsOf(workspace, 'remove');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].args.force, false);
    assert.deepEqual(
        payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED }),
        [{ workItemId: 'id-1', identifier: 'MER-1', reason: 'dirty' }]
    );
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
    const names = ctx.emitter.events.map((entry) => entry.event);
    assert.ok(
        names.indexOf(EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED) < names.indexOf(EVENTS.WORK_ITEM.RELEASED),
        'cleanup runs before the release'
    );
});

test('inactive, unroutable, and missing items at a retry fire never remove a workspace', { timeout: 5000 }, async () => {
    /** @type {Array<{change: 'inactive'|'unroutable'|'missing', expect: string}>} */
    const cases = [
        { change: 'inactive', expect: 'inactive' },
        { change: 'unroutable', expect: 'unroutable' },
        { change: 'missing', expect: 'missing' }
    ];
    for (const entry of cases) {
        const workspace = createFakeWorkspace();
        const workflow = createWorkflow({ order: workspace.order });
        workflow.run = async (input) => {
            workflow.calls.push(input);
            workspace.order.push('run');
            return { status: 'failed' };
        };
        const ctx = await startedAttempt({
            workspace,
            workflow,
            options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 3 } }
        });
        assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 1);

        if (entry.change === 'inactive') /** @type {Record<string, unknown>} */ (ctx.items[0]).state = 'Backlog';
        if (entry.change === 'unroutable') /** @type {Record<string, unknown>} */ (ctx.items[0]).dispatchable = false;
        if (entry.change === 'missing') ctx.items.length = 0;
        ctx.clock.advance(1_000);
        await ctx.scheduler.tick();
        await flush();

        assert.equal(callsOf(workspace, 'handleFor').length, 0, `retry/${entry.change} makes no handleFor call`);
        assert.equal(callsOf(workspace, 'remove').length, 0, `retry/${entry.change} makes no remove call`);
        const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1);
        assert.equal(released[0].reason, entry.expect);
    }
});

test('inactive and missing items release from a parked check, while an unroutable item stays parked', { timeout: 5000 }, async () => {
    /** @type {Array<{change: 'inactive'|'missing', expect: string}>} */
    const cases = [
        { change: 'inactive', expect: 'inactive' },
        { change: 'missing', expect: 'missing' }
    ];
    for (const entry of cases) {
        const workspace = createFakeWorkspace();
        const ctx = await startedAttempt({
            workspace,
            options: { retry: { baseMs: 1_000, maxMs: 1_000 } }
        });
        assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.PARKED }).length, 1);

        if (entry.change === 'inactive') /** @type {Record<string, unknown>} */ (ctx.items[0]).state = 'Backlog';
        if (entry.change === 'missing') ctx.items.length = 0;
        ctx.clock.advance(1_000);
        await ctx.scheduler.tick();
        await flush();

        assert.equal(callsOf(workspace, 'handleFor').length, 0, `parked/${entry.change} makes no handleFor call`);
        assert.equal(callsOf(workspace, 'remove').length, 0, `parked/${entry.change} makes no remove call`);
        const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1);
        assert.equal(released[0].reason, entry.expect);
    }

    // `dispatchable: false` is still active: the parked row survives and its
    // backoff extends (AC20); only a retry fire releases it as unroutable.
    const workspace = createFakeWorkspace();
    const ctx = await startedAttempt({
        workspace,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 } }
    });
    const before = /** @type {number} */ (ctx.scheduler.snapshot().parked[0].nextCheckAt);
    /** @type {Record<string, unknown>} */ (ctx.items[0]).dispatchable = false;
    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();

    assert.equal(callsOf(workspace, 'handleFor').length, 0, 'a parked unroutable item makes no handleFor call');
    assert.equal(callsOf(workspace, 'remove').length, 0, 'a parked unroutable item makes no remove call');
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED }).length, 0);
    const parked = ctx.scheduler.snapshot().parked;
    assert.equal(parked.length, 1, 'the unroutable item stays parked');
    assert.ok(/** @type {number} */ (parked[0].nextCheckAt) > before, 'the backoff extends');
    assert.deepEqual(ctx.scheduler.snapshot().claimed, ['MER-1'], 'the claim is kept');
});

test('inactive, unroutable, and missing reconciliation never remove a workspace', { timeout: 5000 }, async () => {
    /** @type {Array<{change: string, expect: string}>} */
    const cases = [
        { change: 'inactive', expect: 'inactive' },
        { change: 'unroutable', expect: 'unroutable' },
        { change: 'missing', expect: 'missing' }
    ];
    for (const entry of cases) {
        const workspace = createFakeWorkspace();
        const workflow = createWorkflow({ order: workspace.order });
        workflow.run = async (input) => {
            workflow.calls.push(input);
            workspace.order.push('run');
            return abortResult({ signal: input.signal });
        };
        const ctx = await startedAttempt({ workspace, workflow });

        const item = /** @type {Record<string, unknown>} */ (ctx.items[0]);
        if (entry.change === 'inactive') item.state = 'Backlog';
        if (entry.change === 'unroutable') item.dispatchable = false;
        if (entry.change === 'missing') ctx.items.length = 0;
        await ctx.scheduler.tick();
        await flush();

        assert.equal(callsOf(workspace, 'remove').length, 0, `${entry.change} reconciliation makes no remove call`);
        const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(released.length, 1);
        assert.equal(released[0].reason, entry.expect);
    }
});

test('a throwing remove emits internal_error cleanup and still releases the claim', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeError: namedError({ name: 'EACCES' }) });
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        return abortResult({ signal: input.signal });
    };
    const ctx = await startedAttempt({ workspace, workflow });

    await moveToDoneAndTick({ ctx });

    const errors = payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].op, 'cleanup');
    assert.equal(errors[0].errorName, 'EACCES');
    assert.deepEqual(ctx.scheduler.snapshot().claimed, []);
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'terminal');
});

test('a throwing handleFor on the settle cleanup path emits internal_error and still releases', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ handleForError: namedError({ name: 'HandleBoom' }) });
    workspace.ensure = async (args) => {
        workspace.calls.push({ method: 'ensure', args: /** @type {Record<string, unknown>} */ (args) });
        return new Promise((_resolve, reject) => {
            const signal = /** @type {AbortSignal} */ (args.signal);
            signal.addEventListener('abort', () => {
                const error = new Error('ensure aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    };
    const ctx = buildScheduler({ items: [rawItem()], workspace });
    await ctx.scheduler.start();
    await flush();
    assert.equal(ctx.scheduler.snapshot().running.length, 1);
    assert.equal(ctx.scheduler.snapshot().running[0].workspacePath, null, 'ensure never produced a handle');

    await moveToDoneAndTick({ ctx });

    const cleanupErrors = payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR })
        .filter((entry) => entry.op === 'cleanup');
    assert.equal(cleanupErrors.length, 1);
    assert.equal(cleanupErrors[0].errorName, 'HandleBoom');
    assert.deepEqual(ctx.scheduler.snapshot().claimed, [], 'the claim is released');
    assert.deepEqual(ctx.scheduler.snapshot().running, [], 'the settle resolves');
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED })[0].reason, 'terminal');
});

test('cleanup refusal reasons are reported exactly, and missing/null/undefined are not refusals', { timeout: 5000 }, async () => {
    /** @type {Array<{result: {removed?: boolean, reason?: string}|null|undefined, refusal: string|null}>} */
    const cases = [
        { result: { removed: false, reason: 'dirty' }, refusal: 'dirty' },
        { result: { removed: false, reason: 'not_empty' }, refusal: 'not_empty' },
        { result: { removed: false, reason: 'in_use' }, refusal: 'in_use' },
        { result: { removed: false, reason: 'unreachable_head' }, refusal: 'unreachable_head' },
        { result: { removed: false, reason: 'missing' }, refusal: null },
        { result: null, refusal: null },
        { result: undefined, refusal: null }
    ];
    for (const entry of cases) {
        const workspace = createFakeWorkspace({ removeResult: entry.result });
        const workflow = createWorkflow({ order: workspace.order });
        workflow.run = async (input) => {
            workflow.calls.push(input);
            workspace.order.push('run');
            return abortResult({ signal: input.signal });
        };
        const ctx = await startedAttempt({ workspace, workflow });

        await moveToDoneAndTick({ ctx });

        const refusals = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED });
        if (entry.refusal === null) {
            assert.equal(refusals.length, 0, `${String(entry.result)} is not a refusal`);
        } else {
            assert.deepEqual(refusals, [{ workItemId: 'id-1', identifier: 'MER-1', reason: entry.refusal }]);
        }
        assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED })[0].reason, 'terminal');
    }
});

test('startup cleanup fetches terminal states and removes through handleFor, containing failures', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeResult: { removed: false, reason: 'in_use' } });
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace
    });
    await ctx.scheduler.start();

    assert.ok(ctx.source.stateFetches.some((states) => states.includes('Done')), 'terminal states were fetched');
    const handleFors = callsOf(workspace, 'handleFor');
    assert.equal(handleFors.length, 1);
    assert.equal(handleFors[0].args.workItemId, 'MER-T');
    const removes = callsOf(workspace, 'remove');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].args.force, false);
    assert.equal(/** @type {Record<string, unknown>} */ (removes[0].args.workspace).key, 'key:MER-T');
    const refusals = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED });
    assert.deepEqual(refusals, [{ workItemId: 'id-T', identifier: 'MER-T', reason: 'in_use' }]);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.CLAIMED }).length, 0);
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 0);
    assert.deepEqual(ctx.scheduler.snapshot().claimed, []);
});

test('startup cleanup continues past a throwing handleFor and a throwing remove', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({
        handleForError: namedError({ name: 'HandleBoom' }),
        errorFor: 'MER-T1'
    });
    const ctx = buildScheduler({
        items: [
            rawItem({ overrides: { id: 'id-T1', identifier: 'MER-T1', title: 'T1', state: 'Done' } }),
            rawItem({ overrides: { id: 'id-T2', identifier: 'MER-T2', title: 'T2', state: 'Done' } }),
            rawItem({ overrides: { id: 'id-T3', identifier: 'MER-T3', title: 'T3', state: 'Done' } })
        ],
        workspace
    });
    // Only T1's handleFor and only T2's remove throw, so T3 proves the loop continued.
    workspace.remove = async (args) => {
        workspace.calls.push({ method: 'remove', args: /** @type {Record<string, unknown>} */ (args) });
        workspace.order.push('remove');
        if (/** @type {{workItemId: string}} */ (args.workspace).workItemId === 'MER-T2') {
            throw namedError({ name: 'RemoveBoom' });
        }
        return { removed: true };
    };
    await ctx.scheduler.start();

    assert.deepEqual(callsOf(workspace, 'handleFor').map((call) => call.args.workItemId), ['MER-T1', 'MER-T2', 'MER-T3']);
    assert.deepEqual(
        callsOf(workspace, 'remove').map((call) => /** @type {{workItemId: string}} */ (call.args.workspace).workItemId),
        ['MER-T2', 'MER-T3']
    );
    const errors = payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR });
    assert.equal(errors.length, 2);
    for (const entry of errors) assert.equal(entry.op, 'startup_cleanup');
    assert.equal(ctx.scheduler.snapshot().started, true);
});

test('startupCleanup false skips the terminal fetch and every workspace call', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace();
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace,
        options: { startupCleanup: false }
    });
    await ctx.scheduler.start();

    assert.equal(ctx.source.stateFetches.some((states) => states.includes('Done')), false);
    assert.equal(workspace.calls.length, 0);
});

test('a throwing fetchByStates during startup cleanup is contained and the first tick still runs', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace();
    const ctx = buildScheduler({ items: [rawItem()], workspace });
    ctx.source.fetchByStates = () => { throw namedError({ name: 'SourceBoom' }); };

    await ctx.scheduler.start();

    const errors = payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.INTERNAL_ERROR });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].op, 'startup_cleanup');
    assert.equal(errors[0].errorName, 'SourceBoom');
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.TICK }).length, 1, 'the first tick still runs');
    assert.equal(ctx.scheduler.snapshot().started, true);
    assert.equal(callsOf(workspace, 'handleFor').length, 0);
});

test('startup cleanup runs before scheduler:start, which runs before the first tick', { timeout: 5000 }, async () => {
    /** @type {string[]} */
    const sequence = [];
    const workspace = createFakeWorkspace();
    const handleFor = workspace.handleFor;
    workspace.handleFor = (args) => {
        sequence.push('handleFor');
        return handleFor(args);
    };
    const remove = workspace.remove;
    workspace.remove = async (args) => {
        sequence.push('remove');
        return remove(args);
    };
    const emitter = createEmitter();
    const emitSafe = emitter.emitSafe;
    emitter.emitSafe = (name, envelope) => {
        sequence.push(name);
        emitSafe(name, envelope);
    };
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace,
        emitter
    });

    await ctx.scheduler.start();

    assert.deepEqual(sequence.slice(0, 4), [
        'handleFor',
        'remove',
        EVENTS.SCHEDULER.START,
        EVENTS.SCHEDULER.TICK
    ]);
});

test('a second start while startup cleanup is in flight throws already_started', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workspace = createFakeWorkspace();
    workspace.remove = async (args) => {
        workspace.calls.push({ method: 'remove', args: /** @type {Record<string, unknown>} */ (args) });
        await gate.promise;
        return { removed: true };
    };
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace
    });

    const first = ctx.scheduler.start();
    await flush();
    assert.equal(callsOf(workspace, 'remove').length, 1, 'startup cleanup is in flight');
    await assert.rejects(
        ctx.scheduler.start(),
        (error) => /** @type {{reason?: string}} */ (error).reason === 'already_started'
    );

    gate.resolve(undefined);
    await first;
    assert.equal(ctx.scheduler.snapshot().started, true);
    assert.deepEqual(callsOf(workspace, 'remove').length, 1, 'the second start did not repeat cleanup');
});

test('a stop during startup cleanup emits no scheduler:start and runs no first tick', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workspace = createFakeWorkspace();
    workspace.remove = async (args) => {
        workspace.calls.push({ method: 'remove', args: /** @type {Record<string, unknown>} */ (args) });
        await gate.promise;
        return { removed: true };
    };
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace
    });

    const started = ctx.scheduler.start();
    await flush();
    assert.equal(callsOf(workspace, 'remove').length, 1, 'startup cleanup is in flight');
    await ctx.scheduler.stop({ timeoutMs: 1000 });

    gate.resolve(undefined);
    await started;

    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.START }).length, 0, 'no start event after a stop');
    assert.equal(payloads({ emitter: ctx.emitter, name: EVENTS.SCHEDULER.TICK }).length, 0, 'no first tick after a stop');
    assert.deepEqual(
        { started: ctx.scheduler.snapshot().started, stopped: ctx.scheduler.snapshot().stopped },
        { started: true, stopped: true }
    );
});

test('tick() during startup cleanup rejects not_started and emits no tick', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workspace = createFakeWorkspace();
    workspace.remove = async (args) => {
        workspace.calls.push({ method: 'remove', args: /** @type {Record<string, unknown>} */ (args) });
        await gate.promise;
        return { removed: true };
    };
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace
    });

    const first = ctx.scheduler.start();
    await flush();
    assert.equal(callsOf(workspace, 'remove').length, 1, 'startup cleanup is in flight');
    await assert.rejects(
        ctx.scheduler.tick(),
        (error) => /** @type {{reason?: string}} */ (error).reason === 'not_started'
    );
    assert.equal(eventsNamed({ value: ctx.emitter, name: EVENTS.SCHEDULER.TICK }).length, 0, 'no tick event during startup');

    gate.resolve(undefined);
    await first;
    assert.equal(ctx.scheduler.snapshot().started, true);
    await ctx.scheduler.tick();
    assert.equal(eventsNamed({ value: ctx.emitter, name: EVENTS.SCHEDULER.TICK }).length, 2, 'the startup tick and the explicit tick both ran');
});

test('startup cleanup over a dirty leftover is refused and not retried', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace({ removeResult: { removed: false, reason: 'dirty' } });
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workspace
    });

    await ctx.scheduler.start();

    const removes = callsOf(workspace, 'remove');
    assert.equal(removes.length, 1, 'the dirty workspace is not force-removed');
    assert.equal(removes[0].args.force, false);
    assert.deepEqual(
        payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED }),
        [{ workItemId: 'id-T', identifier: 'MER-T', reason: 'dirty' }]
    );
    await ctx.scheduler.tick();
    await flush();
    assert.equal(callsOf(workspace, 'remove').length, 1, 'the refusal is not retried on the next tick');
});

test('no workspace manager means no startup cleanup and a null workspacePath', { timeout: 5000 }, async () => {
    const gate = deferred();
    const workflow = createWorkflow();
    workflow.run = async (input) => {
        workflow.calls.push(input);
        return gate.promise;
    };
    const ctx = buildScheduler({
        items: [rawItem({ overrides: { id: 'id-T', identifier: 'MER-T', title: 'Terminal', state: 'Done' } })],
        workflow
    });
    await ctx.scheduler.start();
    assert.equal(ctx.source.stateFetches.some((states) => states.includes('Done')), false);

    ctx.items.push(rawItem());
    await ctx.scheduler.tick();
    const running = ctx.scheduler.snapshot().running;
    assert.equal(running.length, 1);
    assert.equal(running[0].threadId, 'work:MER-1');
    assert.equal(running[0].workspacePath, null);

    gate.resolve(completedResult());
    await flush();
    assert.deepEqual(ctx.scheduler.snapshot().running, []);
});

test('stop during a run calls afterRun with canceled and never removes', { timeout: 5000 }, async () => {
    const workspace = createFakeWorkspace();
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        return abortResult({ signal: input.signal });
    };
    const ctx = await startedAttempt({ workspace, workflow });

    const result = await ctx.scheduler.stop({ reason: 'test' });
    assert.equal(result.drained, true);
    const afterRun = callsOf(workspace, 'afterRun');
    assert.equal(afterRun.length, 1);
    assert.equal(afterRun[0].args.outcome, 'canceled');
    assert.equal(callsOf(workspace, 'remove').length, 0);

    // Let the settle's release finish.
    await flush();
    const released = payloads({ emitter: ctx.emitter, name: EVENTS.WORK_ITEM.RELEASED });
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'stopped');
});

test('a retry reuses the same workItemId and the same handle key', { timeout: 5000 }, async () => {
    let attempts = 0;
    const workspace = createFakeWorkspace();
    const workflow = createWorkflow({ order: workspace.order });
    workflow.run = async (input) => {
        workflow.calls.push(input);
        workspace.order.push('run');
        attempts += 1;
        return attempts === 1 ? { status: 'failed' } : completedResult();
    };
    const ctx = await startedAttempt({
        workspace,
        workflow,
        options: { retry: { baseMs: 1_000, maxMs: 1_000 }, limits: { maxAttemptsPerItem: 3 } }
    });

    ctx.clock.advance(1_000);
    await ctx.scheduler.tick();
    await flush();

    const ensures = callsOf(workspace, 'ensure');
    assert.equal(ensures.length, 2);
    assert.deepEqual(ensures.map((call) => call.args.workItemId), ['MER-1', 'MER-1']);
    assert.deepEqual(workflow.calls.map((call) => call.attempt), [1, 2]);
    const firstHandle = /** @type {Record<string, unknown>} */ (workflow.calls[0].workspace);
    const secondHandle = /** @type {Record<string, unknown>} */ (workflow.calls[1].workspace);
    assert.equal(firstHandle.key, secondHandle.key);
});
