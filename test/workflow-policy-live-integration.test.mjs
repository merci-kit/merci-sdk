// @ts-check

/**
 * @file IR-3: the live `WorkflowPolicy` → `WorkScheduler` seam (RC-04 B↔D).
 * @version 0.12.0
 *
 * @description
 * The real policy and the real scheduler, not a copied fixture. A temp
 * `WORKFLOW.md`, a manual clock, a memory work source, a memory claim store, a
 * fake workflow, and no workspace manager (`concurrency.global` starts at 1)
 * keep the loop deterministic: `watch: false`, an explicit `reload()`, and
 * explicit `tick()` calls, so no real `fs.watch` or wall-clock timer runs.
 *
 * Wiring order is proven first (RC-09): `policy.start()` → construct the
 * scheduler from `policyToSchedulerOptions()` → `scheduler.start()`. An
 * unstarted policy refuses both the mapping and `start()` with `not_started`.
 *
 * The live cycle then proves: an edit reaches the running scheduler through
 * `applyConfig()` (poll interval, concurrency, one `scheduler:configured`
 * with the exact `changed` keys, re-armed timer); a broken edit blocks both
 * fresh dispatch and a due retry through `preflight()`; a valid save resumes
 * dispatch on the same scheduler instance with no restart and no stopped
 * snapshot; and an in-flight attempt keeps running across a broken edit.
 *
 * The RC-07 defaults parity table is asserted as data against a minimal
 * `WORKFLOW.md`, not described in prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { policyToSchedulerOptions, WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import {
    WorkScheduler,
    createMemoryClaimStore,
    createMemoryWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

/** Envelope keys the SDK stamps on every event; the rest is the payload. */
const STAMP_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

const NOW = Date.parse('2026-11-10T18:00:00.000Z');

/** The RC-07 table: the documented defaults a minimal file must resolve to. */
const RC07_DEFAULTS = Object.freeze([
    Object.freeze({ path: 'pollIntervalMs', expected: 30_000 }),
    Object.freeze({ path: 'concurrency.global', expected: 1 }),
    Object.freeze({ path: 'retry', expected: Object.freeze({ baseMs: 10_000, maxMs: 300_000 }) }),
    Object.freeze({ path: 'continuation', expected: Object.freeze({ delayMs: 1_000, max: 3 }) }),
    Object.freeze({ path: 'limits.maxAttemptsPerItem', expected: 5 })
]);

/**
 * @typedef {Object} ManualClock
 * @property {() => number} now
 * @property {(fn: () => void, ms: number) => number} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 * @property {(arg0: {ms: number}) => void} advance
 * @property {() => Array<{at: number, fn: () => void}>} pending
 * @property {Map<number, {at: number, fn: () => void}>} timers
 */

/**
 * A manual clock: recorded timers never fire, so only an explicit `tick()`
 * advances the scheduler. Mirrors the sibling scheduler tests; no shared
 * helper exists.
 * @param {{now?: number}} [arg0] -
 * @returns {ManualClock}
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
        advance: ({ ms }) => { current += ms; },
        pending: () => [...timers.values()],
        timers
    };
}

/**
 * Let queued microtasks and settle continuations run.
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 8 } = {}) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * @param {{value: unknown, path: string}} arg0 -
 * @returns {unknown}
 */
function readPath({ value, path }) {
    /** @type {unknown} */
    let current = value;
    for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        current = /** @type {Record<string, unknown>} */ (current)[key];
    }
    return current;
}

/**
 * The payload of every captured event with this name.
 * @param {{events: Array<Record<string, unknown>>, name: string}} arg0 -
 * @returns {Array<Record<string, unknown>>}
 */
function payloads({ events, name }) {
    return events
        .filter((entry) => entry.event === name)
        .map((entry) => {
            /** @type {Record<string, unknown>} */
            const payload = {};
            for (const [key, value] of Object.entries(entry)) {
                if (!STAMP_KEYS.has(key)) payload[key] = value;
            }
            return payload;
        });
}

/**
 * How many attempts the scheduler dispatched for one identifier.
 * @param {{events: Array<Record<string, unknown>>, identifier: string}} arg0 -
 * @returns {number}
 */
function dispatchCount({ events, identifier }) {
    return payloads({ events, name: EVENTS.WORK_ITEM.DISPATCHED })
        .filter((payload) => payload.identifier === identifier).length;
}

/**
 * The delay of the single poll timer the scheduler armed.
 * @param {{clock: ManualClock}} arg0 -
 * @returns {number}
 */
function pendingDelay({ clock }) {
    const pending = clock.pending();
    assert.equal(pending.length, 1, 'the scheduler arms exactly one poll timer');
    return pending[0].at - clock.now();
}

/**
 * @param {{id: string, identifier: string, priority: number}} arg0 -
 * @returns {Record<string, unknown>}
 */
function rawItem({ id, identifier, priority }) {
    return {
        id,
        identifier,
        title: `Title for ${identifier}`,
        state: 'Todo',
        dispatchable: true,
        priority,
        url: `https://tracker.example/${identifier}`
    };
}

/**
 * A `WORKFLOW.md` the scheduler accepts without a workspace manager. Every
 * version keeps `continuation_max: 0` so a completed item parks instead of
 * re-running, which keeps the dispatch counts in this file exact.
 * @param {{intervalMs?: number, concurrency?: number, prompt?: string}} [arg0] -
 * @returns {string}
 */
function workflowFile({ intervalMs = 30_000, concurrency = 1, prompt = 'Work on {{ issue.identifier }}.' } = {}) {
    return [
        '---',
        'tracker:',
        '  kind: linear',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        'polling:',
        `  interval_ms: ${intervalMs}`,
        'agent:',
        `  max_concurrent_agents: ${concurrency}`,
        'merci:',
        '  scheduler:',
        '    continuation_max: 0',
        '---',
        prompt
    ].join('\n');
}

/** A YAML edit that fails to parse, so the policy keeps the last good state. */
const BROKEN_WORKFLOW = '---\ntracker:\n  kind: [broken\n---\n';

/**
 * @typedef {Object} Gate
 * @property {Promise<unknown>} promise
 * @property {() => void} release
 * @property {AbortSignal|null} signal
 * @property {boolean} finished
 */

/**
 * @returns {Gate}
 */
function createGate() {
    /** @type {() => void} */
    let release = () => {};
    const promise = new Promise((resolve) => {
        release = () => { resolve(undefined); };
    });
    return {
        promise,
        release: () => { release(); },
        signal: null,
        finished: false
    };
}

/**
 * The fake workflow: `MER-LIVE` completes, `MER-FLAKY` fails once with a
 * transient code and then completes, and `MER-GATED` waits for the gate.
 * @param {{gate: Gate}} arg0 -
 * @returns {{
 *   run: (arg0: {item: WorkItem, signal: AbortSignal}) => Promise<{status: string}>
 * }}
 */
function createWorkflow({ gate }) {
    /** @type {Map<string, number>} */
    const attempts = new Map();
    return {
        run: async ({ item, signal }) => {
            const attempt = (attempts.get(item.identifier) ?? 0) + 1;
            attempts.set(item.identifier, attempt);
            if (item.identifier === 'MER-FLAKY' && attempt === 1) {
                throw Object.assign(new Error('transient'), { name: 'Error', code: 'E_TRANSIENT' });
            }
            if (item.identifier === 'MER-GATED') {
                gate.signal = signal;
                await gate.promise;
                gate.finished = true;
            }
            return { status: 'completed' };
        }
    };
}

/**
 * @param {{error: unknown}} arg0 -
 * @returns {boolean}
 */
function isNotStartedPolicyError({ error }) {
    return error instanceof PolicyError && error.reason === 'not_started';
}

/**
 * @param {{error: unknown}} arg0 -
 * @returns {boolean}
 */
function isNotStartedStartError({ error }) {
    return error instanceof Error
        && error.name === 'ConfigurationError'
        && error.message.includes('not_started');
}

test('an unstarted policy throws not_started before a scheduler can start', { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-live-order-'));
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, workflowFile());
    const clock = createClock();
    const policy = new WorkflowPolicy({ path, watch: false, now: clock.now });
    // Built with the policy's live preflight, but the mapping is what a host
    // would use; it must refuse before the scheduler exists.
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items: [] }),
        workflow: { run: async () => ({ status: 'completed' }) },
        claims: createMemoryClaimStore(),
        clock,
        preflight: () => policy.preflight(),
        activeStates: ['Todo']
    });
    try {
        assert.throws(
            () => policyToSchedulerOptions({ policy }),
            (error) => isNotStartedPolicyError({ error }),
            'mapping an unstarted policy is not_started, never silent defaults'
        );
        await assert.rejects(
            () => scheduler.start(),
            (error) => isNotStartedStartError({ error }),
            'a scheduler built on an unstarted policy cannot start'
        );
        assert.equal(scheduler.snapshot().started, false);
        assert.equal(clock.timers.size, 0, 'a refused start arms no timer');
    } finally {
        await scheduler.stop();
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test('a live workflow edit reaches the running scheduler without a restart', { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-live-'));
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, workflowFile());
    const clock = createClock();
    const emitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    /** @param {Record<string, unknown>} envelope */
    const collect = (envelope) => { events.push(envelope); };
    emitter.onAny(collect);
    const policy = new WorkflowPolicy({ path, watch: false, now: clock.now, eventEmitter: emitter });
    const gate = createGate();
    const workflow = createWorkflow({ gate });

    // RC-09 wiring order: the policy starts first, then the scheduler is built
    // from its options, then the scheduler starts.
    await policy.start();
    const scheduler = new WorkScheduler({
        ...policyToSchedulerOptions({ policy }),
        // Construction-bound: a 1 → 2 edit later needs no workspace manager,
        // and applyConfig cannot change this flag.
        allowSharedWorkspace: true,
        workSource: createMemoryWorkSource({
            items: [
                rawItem({ id: 'wi-live', identifier: 'MER-LIVE', priority: 1 }),
                rawItem({ id: 'wi-flaky', identifier: 'MER-FLAKY', priority: 2 }),
                rawItem({ id: 'wi-gated', identifier: 'MER-GATED', priority: 3 })
            ]
        }),
        workflow,
        claims: createMemoryClaimStore(),
        clock,
        // The real MerciEventEmitter is the intended sink; the assertions
        // below prove it receives the scheduler's events.
        eventEmitter: emitter
    });
    const schedulerRef = scheduler;

    try {
        // 1. The first tick dispatches one item under the policy's global cap.
        await scheduler.start();
        await flush();
        const first = scheduler.snapshot();
        assert.equal(first.started, true);
        assert.equal(first.stopped, false);
        assert.equal(first.pollIntervalMs, 30_000);
        assert.equal(dispatchCount({ events, identifier: 'MER-LIVE' }), 1);
        assert.equal(dispatchCount({ events, identifier: 'MER-FLAKY' }), 0);
        assert.equal(dispatchCount({ events, identifier: 'MER-GATED' }), 0);
        assert.equal(pendingDelay({ clock }), 30_000, 'the initial poll timer uses the file value');

        // 2. A transient failure queues the due retry the broken edit must block.
        await scheduler.tick();
        await flush();
        assert.equal(dispatchCount({ events, identifier: 'MER-FLAKY' }), 1);
        const scheduled = payloads({ events, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED })
            .filter((payload) => payload.identifier === 'MER-FLAKY');
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].delayMs, 10_000);
        clock.advance({ ms: 10_001 });
        const dueRow = scheduler.snapshot().retrying.find((row) => row.identifier === 'MER-FLAKY');
        assert.ok(dueRow, 'the retry is queued');
        assert.ok(/** @type {number} */ (dueRow.dueAtMs) <= clock.now(), 'the retry is due before the edit');

        // 3. The live edit: poll interval and concurrency both change.
        await writeFile(path, workflowFile({ intervalMs: 60_000, concurrency: 2 }));
        const reloaded = await policy.reload();
        assert.deepEqual(reloaded, { changed: true, healthy: true, reasons: [] });
        const applied = await scheduler.applyConfig({ options: { ...policyToSchedulerOptions({ policy }) } });
        assert.deepEqual(applied, {
            applied: true,
            deferred: false,
            changed: ['concurrency', 'pollIntervalMs']
        });
        assert.equal(scheduler.snapshot().pollIntervalMs, 60_000);
        assert.equal(pendingDelay({ clock }), 60_000, 'the poll timer was re-armed with the new value');
        const configured = payloads({ events, name: EVENTS.SCHEDULER.CONFIGURED });
        assert.equal(configured.length, 1, 'scheduler:configured fired exactly once');
        assert.deepEqual(configured[0].changed, ['concurrency', 'pollIntervalMs']);
        assert.equal(configured[0].source, 'reload');
        assert.equal(dispatchCount({ events, identifier: 'MER-FLAKY' }), 1, 'applyConfig never ticks');

        // 4. A broken edit blocks fresh work and the due retry.
        await writeFile(path, BROKEN_WORKFLOW);
        const broken = await policy.reload();
        assert.equal(broken.changed, false);
        assert.equal(broken.healthy, false);
        assert.ok(broken.reasons.length > 0);
        const policyReasons = policy.preflight();
        assert.deepEqual(policyReasons, broken.reasons);
        await scheduler.tick();
        await flush();
        const validation = payloads({ events, name: EVENTS.SCHEDULER.VALIDATION_ERROR });
        assert.equal(validation.length, 1);
        assert.deepEqual(validation[0].errors, policyReasons, 'the policy reason is in errors');
        const blockedTick = payloads({ events, name: EVENTS.SCHEDULER.TICK }).at(-1);
        assert.equal(blockedTick?.outcome, 'validation_error');
        assert.equal(blockedTick?.dispatched, 0);
        assert.equal(dispatchCount({ events, identifier: 'MER-FLAKY' }), 1, 'the due retry did not dispatch');
        assert.equal(dispatchCount({ events, identifier: 'MER-GATED' }), 0, 'no fresh work dispatched');
        const stillDue = scheduler.snapshot().retrying.find((row) => row.identifier === 'MER-FLAKY');
        assert.ok(stillDue, 'the due retry stayed queued');
        assert.ok(/** @type {number} */ (stillDue.dueAtMs) <= clock.now(), 'it was due and stayed queued');

        // 5. A valid save resumes dispatch on the same instance, no restart.
        await writeFile(path, workflowFile({ intervalMs: 60_000, concurrency: 2, prompt: 'Resumed: {{ issue.identifier }}' }));
        const fixed = await policy.reload();
        assert.equal(fixed.changed, true);
        assert.equal(fixed.healthy, true);
        assert.deepEqual(fixed.reasons, []);
        await scheduler.tick();
        await flush();
        assert.equal(dispatchCount({ events, identifier: 'MER-FLAKY' }), 2, 'the due retry dispatched as attempt 2');
        assert.equal(dispatchCount({ events, identifier: 'MER-GATED' }), 1, 'fresh work dispatched under the raised cap');
        const resumed = scheduler.snapshot();
        assert.equal(resumed.started, true);
        assert.equal(resumed.stopped, false);
        assert.equal(scheduler, schedulerRef, 'the same scheduler instance served every phase');
        assert.equal(payloads({ events, name: EVENTS.SCHEDULER.START }).length, 1, 'the scheduler never restarted');
        assert.deepEqual(resumed.running.map((row) => row.identifier), ['MER-GATED']);
        assert.ok(gate.signal, 'the gated attempt received a signal');
        const gatedSignal = gate.signal;

        // 6. The in-flight attempt survives a broken edit and resolves normally.
        await writeFile(path, BROKEN_WORKFLOW);
        const brokenAgain = await policy.reload();
        assert.equal(brokenAgain.healthy, false);
        await scheduler.tick();
        await flush();
        assert.equal(gate.finished, false, 'the attempt is still in flight');
        assert.equal(gatedSignal.aborted, false, 'a broken edit does not abort running work');
        assert.deepEqual(scheduler.snapshot().running.map((row) => row.identifier), ['MER-GATED']);

        gate.release();
        await flush();
        assert.equal(gate.finished, true, 'the gate resolved normally');
        assert.equal(gatedSignal.aborted, false, 'the attempt was never aborted');
        assert.equal(
            payloads({ events, name: EVENTS.WORK_ITEM.COMPLETED })
                .filter((payload) => payload.identifier === 'MER-GATED').length,
            1,
            'the attempt completed'
        );
        for (const name of [EVENTS.WORK_ITEM.RECONCILED, EVENTS.WORK_ITEM.STALLED]) {
            assert.equal(
                payloads({ events, name }).filter((payload) => payload.identifier === 'MER-GATED').length,
                0,
                `${name} did not touch the running item`
            );
        }
    } finally {
        // Release the gate before stopping: if a regression let the broken
        // edit dispatch, the attempt must settle instead of stalling the
        // suite into its timeout, which would hide the real assertion.
        gate.release();
        await scheduler.stop();
        policy.stop();
        assert.equal(clock.timers.size, 0, 'no armed timer survives stop()');
        await rm(dir, { recursive: true, force: true });
    }
});

test('policyToSchedulerOptions resolves the RC-07 defaults from a minimal file', { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-live-defaults-'));
    const path = join(dir, 'WORKFLOW.md');
    // Nothing but the required envelope and a prompt: every mapped field is a
    // documented default.
    await writeFile(path, ['---', '---', 'Work on {{ issue.identifier }}.'].join('\n'));
    const policy = new WorkflowPolicy({ path, watch: false });
    try {
        await policy.start();
        const options = policyToSchedulerOptions({ policy });
        for (const { path: fieldPath, expected } of RC07_DEFAULTS) {
            assert.deepEqual(readPath({ value: options, path: fieldPath }), expected, `${fieldPath} is the documented default`);
        }
        assert.deepEqual(policy.preflight(), [], 'a minimal file is healthy');
    } finally {
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
