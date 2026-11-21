// @ts-check

/**
 * @file Stage 2 contract tests for the bounded orchestration event ring (AC10, §5.3).
 * @version 0.12.0
 *
 * @description
 * The ring keeps at most `limit` records (FIFO eviction), filters by namespace
 * prefix, and stores one projected record per envelope through the shared
 * allowlist. A host-supplied `recentEvents` provider goes through the same
 * `projectEventRecord`, so `prompt`, `toolArgs`, and `description` cannot leak
 * into the detail route. The real `MerciEventEmitter` path is exercised; a tiny
 * fake covers bound/filter/stop counting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ConfigurationError } from '../lib/core/errors.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { createEventRing, DEFAULT_PREFIXES, projectEventRecord } from '../lib/agentic/operator/ring.mjs';
import { toItemResponse } from '../lib/agentic/operator/view.mjs';

/**
 * @param {{ event: string, [key: string]: unknown }} [arg0]
 * @returns {Record<string, unknown>}
 */
function envelope(arg0 = { event: 'scheduler:tick' }) {
    return { runId: 'run-1', parentRunId: null, ...arg0 };
}

test('the ring keeps the last limit records in chronological order', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, limit: 3 });
    for (let index = 0; index < 5; index += 1) {
        emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 1000 + index, index }));
    }
    const records = ring.list();
    assert.deepEqual(records.map((record) => record.index), [2, 3, 4]);
    assert.deepEqual(records.map((record) => record.at), [1002, 1003, 1004]);
});

test('the FIFO bound is observable through list()', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, limit: 3 });
    for (let index = 0; index < 5; index += 1) {
        emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: index }));
    }
    assert.equal(ring.list({ limit: 99 }).length, 3);
    assert.deepEqual(ring.list().map((record) => record.at), [2, 3, 4]);
});

test('the ring records the orchestrator namespaces and drops everything else', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 1 }));
    emitter.emitSafe('work_item:parked', envelope({ event: 'work_item:parked', ts: 2 }));
    emitter.emitSafe('workspace:created', envelope({ event: 'workspace:created', ts: 3 }));
    emitter.emitSafe('workflow_policy:reload_failed', envelope({ event: 'workflow_policy:reload_failed', ts: 4 }));
    emitter.emitSafe('run:start', envelope({ event: 'run:start', ts: 5 }));
    emitter.emitSafe('tool:call_start', envelope({ event: 'tool:call_start', ts: 6 }));

    assert.deepEqual(ring.list().map((record) => record.event), [
        'scheduler:tick', 'work_item:parked', 'workspace:created', 'workflow_policy:reload_failed'
    ], 'a policy that blocks dispatch must be visible to the operator');
});

test('a host prefix reaches the old layer and keeps only correlation scalars', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, prefixes: ['run:', 'tool:'] });
    emitter.emitSafe('run:end', envelope({
        event: 'run:end',
        ts: 1000,
        runId: 'run-7',
        sessionId: 'sess-1',
        durationMs: 12,
        success: true,
        name: 'read',
        prompt: 'LEAK-prompt',
        message: 'LEAK-message',
        toolArgs: { LEAK: true }
    }));
    emitter.emitSafe('tool:call_end', envelope({
        event: 'tool:call_end',
        ts: 1001,
        sessionId: 'sess-1',
        name: 'write_file',
        success: false,
        durationMs: 3,
        args: { token: 'LEAK-args' },
        error: { message: 'LEAK-error' }
    }));
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 1002 }));

    const [runEnd, toolEnd] = ring.list();
    assert.deepEqual(runEnd, {
        at: 1000,
        event: 'run:end',
        runId: 'run-7',
        parentRunId: null,
        sessionId: 'sess-1',
        durationMs: 12,
        success: true
    });
    assert.equal(Object.hasOwn(runEnd, 'name'), false, 'name is a tool field only');
    assert.deepEqual([toolEnd.name, toolEnd.success], ['write_file', false]);
    assert.equal(Object.hasOwn(toolEnd, 'args'), false);
    assert.equal(Object.hasOwn(toolEnd, 'error'), false);
    assert.equal(JSON.stringify(ring.list()).includes('LEAK'), false);
});

test('a child run record joins the dispatch through parentRunId', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, prefixes: ['work_item:', 'run:'] });
    emitter.emitSafe('work_item:dispatched', envelope({
        event: 'work_item:dispatched',
        ts: 1,
        identifier: 'MT-1',
        runId: 'run-attempt'
    }));
    emitter.emitSafe('run:start', envelope({
        event: 'run:start',
        ts: 2,
        runId: 'run-child',
        parentRunId: 'run-attempt'
    }));

    const [dispatch, child] = ring.list();
    assert.equal(child.parentRunId, dispatch.runId);
});

test('name is a bounded tool name and only for tool events', () => {
    const tooLongName = `${'n'.repeat(127)}LEAK`;
    const tooLongSession = `${'s'.repeat(127)}LEAK`;
    const tool = projectEventRecord({
        envelope: {
            event: 'tool:call_end',
            ts: 1,
            name: tooLongName,
            success: true,
            sessionId: tooLongSession
        },
        now: () => 1
    });
    assert.equal(String(tool.name).length, 128);
    assert.equal(String(tool.sessionId).length, 128);
    assert.equal(JSON.stringify(tool).includes('LEAK'), false);

    const artifact = projectEventRecord({
        envelope: { event: 'artifact:saved', ts: 2, name: 'file.txt' },
        now: () => 2
    });
    assert.equal(Object.hasOwn(artifact, 'name'), false, 'an artifact filename is not a tool name');

    const rejected = projectEventRecord({
        envelope: { event: 'tool:call_end', ts: 3, name: 7, success: 'yes', sessionId: '' },
        now: () => 3
    });
    assert.deepEqual(rejected, { at: 3, event: 'tool:call_end' });
});

test('sessionId is absent, not null, when the envelope carries none', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, prefixes: ['run:'] });
    emitter.emitSafe('run:end', envelope({ event: 'run:end', ts: 1 }));
    emitter.emitSafe('run:end', envelope({ event: 'run:end', ts: 2, sessionId: null }));
    emitter.emitSafe('run:end', envelope({ event: 'run:end', ts: 3, sessionId: '' }));
    emitter.emitSafe('run:end', envelope({ event: 'run:end', ts: 4, sessionId: `${'s'.repeat(127)}LEAK` }));

    const [missing, explicitNull, empty, bounded] = ring.list();
    assert.equal(Object.hasOwn(missing, 'sessionId'), false);
    assert.equal(Object.hasOwn(explicitNull, 'sessionId'), false);
    assert.equal(Object.hasOwn(empty, 'sessionId'), false);
    assert.equal(String(bounded.sessionId).length, 128);
    assert.equal(JSON.stringify(bounded).includes('LEAK'), false);
    assert.deepEqual(missing, { at: 1, event: 'run:end', runId: 'run-1', parentRunId: null });
});

test('a session record joins the ring only on an opt-in prefix and keeps no prose', () => {
    const emitter = new MerciEventEmitter();
    const plain = createEventRing({ emitter });
    const ring = createEventRing({ emitter, prefixes: [...DEFAULT_PREFIXES, 'session:'] });
    emitter.emitSafe('session:checkpoint_saved', envelope({
        event: 'session:checkpoint_saved',
        ts: 10,
        sessionId: 'sess-9',
        threadId: 'thread-1',
        prompt: 'LEAK-prompt',
        messages: ['LEAK-message']
    }));

    assert.deepEqual(plain.list(), [], 'session: is not in DEFAULT_PREFIXES');
    assert.deepEqual(ring.list(), [{
        at: 10,
        event: 'session:checkpoint_saved',
        sessionId: 'sess-9',
        runId: 'run-1',
        parentRunId: null
    }]);
    assert.equal(JSON.stringify(ring.list()).includes('LEAK'), false);
});

test('a workflow-policy record keeps its codes and never its prompt', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    emitter.emitSafe('workflow_policy:reload_failed', envelope({
        event: 'workflow_policy:reload_failed',
        ts: 1000,
        path: '/repo/WORKFLOW.md',
        reasons: ['invalid_config:agent.max_concurrent_agents', 'template_parse_error:line 4'],
        warnings: ['unknown_key'],
        prompt: 'LEAK-prompt',
        promptTemplate: 'LEAK-template',
        config: { LEAK: true }
    }));

    const [record] = ring.list();
    assert.deepEqual(Object.keys(record).sort(), ['at', 'event', 'parentRunId', 'path', 'reasons', 'runId', 'warnings']);
    assert.deepEqual(record.reasons, ['invalid_config:agent.max_concurrent_agents', 'template_parse_error:line 4']);
    assert.deepEqual(record.warnings, ['unknown_key']);
    assert.equal(JSON.stringify(record).includes('LEAK'), false);
});

test('a payload with description, prompt and toolArgs keeps only allowlisted fields', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    emitter.emitSafe('work_item:parked', envelope({
        event: 'work_item:parked',
        ts: 1000,
        identifier: 'MT-1',
        reason: 'attempts_exhausted',
        description: 'LEAK-description',
        prompt: 'LEAK-prompt',
        toolArgs: { LEAK: true },
        message: 'LEAK-message'
    }));

    const [record] = ring.list();
    assert.deepEqual(Object.keys(record), ['at', 'event', 'identifier', 'reason', 'runId', 'parentRunId']);
    assert.equal(Object.isFrozen(record), true);
    assert.equal(JSON.stringify(record).includes('LEAK'), false);
});

test('documented scheduler and work-item payload fields survive', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, limit: 10 });
    emitter.emitSafe('scheduler:tick', envelope({
        event: 'scheduler:tick',
        ts: 1000,
        outcome: 'ok',
        fetched: 3,
        dispatched: 1,
        running: 1,
        retrying: 0,
        parked: 0,
        claimed: 2
    }));
    emitter.emitSafe('work_item:parked', envelope({
        event: 'work_item:parked',
        ts: 1001,
        identifier: 'MT-2',
        reason: 'attempts_exhausted',
        attempts: 5,
        continuations: 2,
        nextCheckAt: 2000
    }));
    emitter.emitSafe('work_item:dispatched', envelope({
        event: 'work_item:dispatched',
        ts: 1002,
        identifier: 'MT-3',
        priority: 7,
        runId: 'run-9'
    }));

    const [tick, parked, dispatched] = ring.list();
    assert.deepEqual(
        [tick.outcome, tick.fetched, tick.dispatched, tick.running, tick.retrying, tick.parked, tick.claimed],
        ['ok', 3, 1, 1, 0, 0, 2]
    );
    assert.deepEqual(
        [parked.reason, parked.attempts, parked.continuations, parked.nextCheckAt],
        ['attempts_exhausted', 5, 2, 2000]
    );
    assert.deepEqual([dispatched.priority, dispatched.runId], [7, 'run-9']);
});

test('every workspace leaf kind keeps its documented payload fields', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, limit: 20 });
    emitter.emitSafe('workspace:created', envelope({
        event: 'workspace:created', ts: 1, workItemId: 'wi-1', key: 'k1',
        path: '/ws/k1', strategy: 'worktree', branch: 'merci/MT-1', createdNow: true
    }));
    emitter.emitSafe('workspace:reused', envelope({
        event: 'workspace:reused', ts: 2, workItemId: 'wi-1', key: 'k1',
        path: '/ws/k1', strategy: 'worktree', branch: 'merci/MT-1', createdNow: false
    }));
    emitter.emitSafe('workspace:removed', envelope({
        event: 'workspace:removed', ts: 3, workItemId: 'wi-1', key: 'k1',
        path: '/ws/k1', strategy: 'worktree', forced: true
    }));
    emitter.emitSafe('workspace:remove_refused', envelope({
        event: 'workspace:remove_refused', ts: 4, workItemId: 'wi-1',
        key: 'k1', path: '/ws/k1', reason: 'in_use'
    }));
    emitter.emitSafe('workspace:hook_started', envelope({
        event: 'workspace:hook_started', ts: 5, workItemId: 'wi-1',
        key: 'k1', path: '/ws/k1', hook: 'before_run'
    }));
    emitter.emitSafe('workspace:hook_finished', envelope({
        event: 'workspace:hook_finished', ts: 6, workItemId: 'wi-1',
        key: 'k1', hook: 'before_run', durationMs: 12, exitCode: 0
    }));
    emitter.emitSafe('workspace:hook_failed', envelope({
        event: 'workspace:hook_failed', ts: 7, workItemId: 'wi-1', key: 'k1',
        hook: 'before_run', durationMs: 12, exitCode: null, timedOut: false, fatal: true
    }));
    emitter.emitSafe('workspace:path_rejected', envelope({
        event: 'workspace:path_rejected', ts: 8, workItemId: 'wi-1',
        key: 'k1', path: '/ws/k1', reason: 'outside_root'
    }));

    const [created, reused, removed, refused, started, finished, failed, rejected] = ring.list();
    assert.deepEqual(
        [created.key, created.path, created.strategy, created.branch, created.createdNow],
        ['k1', '/ws/k1', 'worktree', 'merci/MT-1', true]
    );
    assert.equal(reused.createdNow, false);
    assert.deepEqual([removed.forced, removed.strategy], [true, 'worktree']);
    assert.deepEqual([refused.reason, refused.path], ['in_use', '/ws/k1']);
    assert.deepEqual([started.hook, started.path], ['before_run', '/ws/k1']);
    assert.deepEqual([finished.hook, finished.durationMs, finished.exitCode], ['before_run', 12, 0]);
    assert.deepEqual([failed.exitCode, failed.timedOut, failed.fatal], [null, false, true]);
    assert.deepEqual([rejected.reason, rejected.key], ['outside_root', 'k1']);
});

test('structured payload fields drop nested values at insert and at re-projection', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    emitter.emitSafe('scheduler:tick', envelope({
        event: 'scheduler:tick', ts: 1,
        usage: { total_tokens: 5, prompt: 'LEAK-usage' },
        totals: { dispatches: 2, note: { deep: 'LEAK-totals' } },
        errors: ['a', { message: 'LEAK-errors' }],
        changed: ['pollIntervalMs', { deep: 'LEAK-changed' }],
        concurrency: { global: 2, byLane: { main: 1 }, note: 'LEAK-concurrency' },
        activeStates: ['Todo', { deep: 'LEAK-active' }],
        terminalStates: ['Done', 3],
        claimed: 'LEAK-claimed'
    }));

    const [record] = ring.list();
    assert.deepEqual(record.usage, { total_tokens: 5 });
    assert.deepEqual(record.totals, { dispatches: 2 });
    assert.deepEqual(record.errors, ['a']);
    assert.deepEqual(record.changed, ['pollIntervalMs']);
    // `scheduler:start` really emits `{ global, byLane }`; the lane map is one
    // documented level down and survives, the hostile `note` does not.
    assert.deepEqual(record.concurrency, { global: 2, byLane: { main: 1 } });
    assert.deepEqual(record.activeStates, ['Todo']);
    assert.deepEqual(record.terminalStates, ['Done']);
    assert.equal(JSON.stringify(record).includes('LEAK'), false);

    // Non-object structured values are dropped, not passed through.
    const dropped = projectEventRecord({
        envelope: { event: 'scheduler:tick', ts: 1, usage: 'nope', totals: ['x'], concurrency: 2 },
        now: () => 1
    });
    for (const field of ['usage', 'totals', 'concurrency']) {
        assert.equal(Object.hasOwn(dropped, field), false, `${field} should be dropped`);
    }

    // The same hostile object through the detail re-projection leaks nothing.
    const snapshot = { parked: [{ identifier: 'MT-1', reason: 'attempts_exhausted' }] };
    const hostile = {
        event: 'scheduler:tick', ts: 1, identifier: 'MT-1',
        usage: { total_tokens: 5, prompt: 'LEAK-usage' },
        totals: { dispatches: 2, note: { deep: 'LEAK-totals' } },
        errors: ['a', { message: 'LEAK-errors' }]
    };
    const detail = toItemResponse({ snapshot, id: 'MT-1', now: () => 999, events: () => [hostile] });
    assert.ok(detail);
    assert.deepEqual(detail.recentEvents, [{
        at: 1,
        event: 'scheduler:tick',
        identifier: 'MT-1',
        usage: { total_tokens: 5 },
        totals: { dispatches: 2 },
        errors: ['a']
    }]);
    assert.equal(JSON.stringify(detail.recentEvents).includes('LEAK'), false);

    // A scalar field carrying an object is malformed provider data, not text.
    const nested = projectEventRecord({
        envelope: {
            event: { prompt: 'LEAK-event' },
            ts: 1,
            identifier: 'MT-1',
            reason: { prompt: 'LEAK-reason' },
            errorName: { provider: { prompt: 'LEAK-name' } }
        },
        now: () => 1
    });
    for (const field of ['event', 'reason', 'errorName']) {
        assert.equal(Object.hasOwn(nested, field), false, `${field} should be dropped`);
    }
    assert.equal(JSON.stringify(nested).includes('LEAK'), false);
});

test('list filters by identifier and a per-call limit', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    for (const [index, identifier] of ['MT-1', 'MT-2', 'MT-1', 'MT-1'].entries()) {
        emitter.emitSafe('work_item:parked', envelope({
            event: 'work_item:parked',
            ts: 1000 + index,
            identifier
        }));
    }

    assert.deepEqual(ring.list({ identifier: 'MT-1' }).map((record) => record.at), [1000, 1002, 1003]);
    assert.deepEqual(ring.list({ identifier: 'MT-2' }).map((record) => record.at), [1001]);
    assert.deepEqual(ring.list({ limit: 2 }).map((record) => record.at), [1002, 1003]);
    assert.deepEqual(ring.list().length, 4);
});

test('at comes from the envelope ts and falls back to now when ts is missing', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, now: () => 4242 });
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 999 }));
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick' }));
    assert.deepEqual(ring.list().map((record) => record.at), [999, 4242]);
});

test('the listener also accepts (eventName, envelope)', () => {
    /** @type {((...args: Array<unknown>) => void)|undefined} */
    let captured;
    const fake = {
        /** @param {(...args: Array<unknown>) => void} fn */
        onAny(fn) { captured = fn; return () => {}; }
    };
    const ring = createEventRing({ emitter: fake, now: () => 7 });
    const listener = captured;
    assert.ok(listener);
    listener('workspace:cleanup', { identifier: 'MT-1' });
    assert.deepEqual(ring.list(), [{ at: 7, event: 'workspace:cleanup', identifier: 'MT-1' }]);
});

test('clear empties the buffer without unsubscribing', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 1 }));
    ring.clear();
    assert.deepEqual(ring.list(), []);
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 2 }));
    assert.deepEqual(ring.list().map((record) => record.at), [2]);
});

test('stop unsubscribes once and is idempotent', () => {
    let unsubscribeCalls = 0;
    const fake = {
        /** @param {(...args: Array<unknown>) => void} fn */
        onAny(fn) {
            // Keep the listener reachable so the test can prove stop() unsubscribed.
            void fn;
            return () => { unsubscribeCalls += 1; };
        }
    };
    const ring = createEventRing({ emitter: fake });
    ring.stop();
    ring.stop();
    assert.equal(unsubscribeCalls, 1);
});

test('stop makes the real emitter forget the ring', () => {
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter });
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 1 }));
    ring.stop();
    emitter.emitSafe('scheduler:tick', envelope({ event: 'scheduler:tick', ts: 2 }));
    assert.deepEqual(ring.list().map((record) => record.at), [1]);
    assert.equal(emitter.listenerCount(), 0);
});

test('stop gates the listener and tolerates an emitter without an unsubscribe', () => {
    /** @type {((...args: Array<unknown>) => void)|undefined} */
    let captured;
    const fake = {
        /** @param {(...args: Array<unknown>) => void} fn */
        onAny(fn) { captured = fn; return () => {}; }
    };
    const ring = createEventRing({ emitter: fake, now: () => 5 });
    const listener = captured;
    assert.ok(listener);

    ring.stop();
    listener({ event: 'scheduler:tick', ts: 1 });
    listener('workspace:created', { identifier: 'MT-1' });
    assert.deepEqual(ring.list(), []);

    const bare = {
        /** @param {(...args: Array<unknown>) => void} fn */
        onAny(fn) { void fn; return /** @type {unknown} */ (undefined); }
    };
    const other = createEventRing({ emitter: bare });
    assert.doesNotThrow(() => other.stop());
    assert.doesNotThrow(() => other.stop());
});

test('a plain EventEmitter without onAny throws ConfigurationError', () => {
    assert.throws(() => createEventRing({ emitter: new EventEmitter() }), ConfigurationError);
    try {
        createEventRing({ emitter: new EventEmitter() });
        assert.fail('expected a ConfigurationError');
    } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.option, 'invalid_emitter');
    }
    assert.throws(() => createEventRing({}), ConfigurationError);
});

test('invalid limit, prefixes and now are rejected at construction', () => {
    const emitter = new MerciEventEmitter();
    const badPrefixes = /** @type {Array<string>} */ (/** @type {unknown} */ (['scheduler:', 3]));
    const badNow = /** @type {() => number} */ (/** @type {unknown} */ (5));
    assert.throws(() => createEventRing({ emitter, limit: 0 }), ConfigurationError);
    assert.throws(() => createEventRing({ emitter, limit: 1.5 }), ConfigurationError);
    assert.throws(() => createEventRing({ emitter, prefixes: [] }), ConfigurationError);
    assert.throws(() => createEventRing({ emitter, prefixes: badPrefixes }), ConfigurationError);
    assert.throws(() => createEventRing({ emitter, now: badNow }), ConfigurationError);
});

test('the ring emits no events', () => {
    let emitCalls = 0;
    /** @type {((...args: Array<unknown>) => void)|undefined} */
    let captured;
    const fake = {
        /** @param {(...args: Array<unknown>) => void} fn */
        onAny(fn) { captured = fn; return () => {}; },
        /** @returns {boolean} */
        emit() { emitCalls += 1; return false; },
        /** @returns {number} */
        emitSafe() { emitCalls += 1; return 0; }
    };
    const ring = createEventRing({ emitter: fake });
    const listener = captured;
    assert.ok(listener);
    listener({ event: 'scheduler:tick', ts: 1 });
    ring.list();
    ring.list({ identifier: 'MT-1', limit: 1 });
    ring.clear();
    ring.stop();
    assert.equal(emitCalls, 0);
});

test('projectEventRecord is the projection view.mjs applies to host records', () => {
    const snapshot = { parked: [{ identifier: 'MT-1', reason: 'attempts_exhausted', attempts: 5 }] };
    const hostile = {
        event: 'work_item:parked',
        ts: 111,
        identifier: 'MT-1',
        reason: 'attempts_exhausted',
        attempts: 5,
        prompt: 'LEAK-prompt',
        toolArgs: { LEAK: true },
        description: 'LEAK-description'
    };
    const detail = toItemResponse({ snapshot, id: 'MT-1', now: () => 999, events: () => [hostile] });
    assert.ok(detail);
    assert.deepEqual(detail.recentEvents, [projectEventRecord({ envelope: hostile, now: () => 999 })]);
    assert.deepEqual(detail.recentEvents, [{ at: 111, event: 'work_item:parked', identifier: 'MT-1', reason: 'attempts_exhausted', attempts: 5 }]);
});

test('projectEventRecord accepts a full envelope or an existing record', () => {
    assert.deepEqual(
        projectEventRecord({ envelope: { event: 'scheduler:tick', ts: 5, outcome: 'ok', prompt: 'x' } }),
        { at: 5, event: 'scheduler:tick', outcome: 'ok' }
    );
    assert.deepEqual(
        projectEventRecord({ envelope: { at: 5, event: 'scheduler:tick' }, now: () => 9 }),
        { at: 5, event: 'scheduler:tick' }
    );
    assert.deepEqual(projectEventRecord({ envelope: {}, now: () => 9 }), { at: 9 });
    assert.deepEqual(projectEventRecord({ envelope: { ts: Number.NaN }, now: () => 9 }), { at: 9 });
});
