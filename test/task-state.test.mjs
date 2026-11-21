// @ts-check

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { TaskState } from '../lib/agentic/planning/task-state.mjs';
import {
    CHECKPOINT_KIND, wrapCheckpoint, unwrapCheckpoint, saveCheckpoint, restoreCheckpoint,
} from '../lib/agentic/planning/checkpoint.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { safeStringify } from '../lib/support/utils.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

function seeded() {
    const executor = new WorkflowExecutor({ options: { defaultModel: 'm' } });
    executor.globalObjective = 'ship it';
    executor.context = { topic: 'tacos' };
    executor.steps.set('a', /** @type {any} */ ({ id: 'a', description: 'A', dependencies: [], status: 'completed', output: 'OUT-A', messages: [], historical: false }));
    executor.steps.set('b', /** @type {any} */ ({ id: 'b', description: 'B', dependencies: ['a'], status: 'pending', output: null, messages: [], historical: false }));
    executor.outputs = /** @type {any} */ ({ a: 'OUT-A' });
    executor._replanCount = 1;
    return executor;
}

describe('TaskState', () => {
    it('round-trips objective, context, agent-context, steps and outputs', () => {
        const state = TaskState.fromExecutor({ executor: seeded() });
        const restored = TaskState.fromJSON(state.toJSON());
        assert.equal(restored.objective, 'ship it');
        assert.deepEqual(restored.vars, { topic: 'tacos' });
        assert.equal(restored.agentContext.objective, 'ship it');
        assert.equal((/** @type {any} */ (restored.outputs)).a, 'OUT-A');
        assert.equal(restored.replanCount, 1);
        assert.equal((/** @type {any} */ (restored.steps.find((s) => s.id === 'a'))).status, 'completed');
    });

    it('survives a JSON string round-trip', () => {
        const restored = TaskState.fromJSON(JSON.stringify(TaskState.fromExecutor({ executor: seeded() })));
        assert.equal(restored.steps.length, 2);
        assert.deepEqual(restored.vars, { topic: 'tacos' });
    });
});

describe('WorkflowExecutor checkpoint', () => {
    it('save/load restores step statuses, outputs and context', () => {
        const restored = WorkflowExecutor.load({ json: seeded().save(), options: { defaultModel: 'm' } });
        assert.equal(restored.globalObjective, 'ship it');
        assert.deepEqual(restored.context, { topic: 'tacos' });
        assert.equal((/** @type {any} */ (restored.steps.get('a'))).status, 'completed');
        assert.equal((/** @type {any} */ (restored.steps.get('b'))).status, 'pending');
        assert.equal((/** @type {any} */ (restored.outputs)).a, 'OUT-A');
        assert.equal(restored._replanCount, 1);
    });

    it('a resumed execute() keeps the restored state and agent-context', async () => {
        const seed = seeded();
        seed.steps.set('b', /** @type {any} */ ({ ...seed.steps.get('b'), status: 'completed', output: 'OUT-B' }));
        (/** @type {any} */ (seed.outputs)).b = 'OUT-B';
        const restored = WorkflowExecutor.load({ json: seed.save(), options: { defaultModel: 'm' } });
        const agentContext = restored._agentContext;
        await restored.execute({ userGoal: 'ship it' });
        assert.equal((/** @type {any} */ (restored.steps.get('a'))).status, 'completed', 'a completed step must stay completed on resume');
        assert.equal(restored.outputs.a, 'OUT-A');
        assert.equal(restored._agentContext, agentContext, 'the agent-context must not be rebuilt on resume');
    });

    it('execute() still resets a run that was not resumed', async () => {
        const executor = seeded();
        const ac = new AbortController();
        ac.abort();
        executor.signal = ac.signal;
        await assert.rejects(() => executor.execute({ userGoal: 'ship it' }));
        assert.equal((/** @type {any} */ (executor.steps.get('a'))).status, 'pending', 'a fresh execute must reset stale completed steps');
        assert.deepEqual(executor.outputs, {});
    });
});

describe('unified checkpoint envelope', () => {
    /** @type {string} */
    let dir;
    before(() => { dir = mkdtempSync(join(tmpdir(), 'merci-ckpt-')); });
    after(() => { rmSync(dir, { recursive: true, force: true }); });

    it('rejects an unknown kind', () => {
        assert.throws(() => wrapCheckpoint({ kind: 'bogus', payload: '{}' }), ConfigurationError);
    });

    it('saves and restores a workflow checkpoint through the session store', async () => {
        const store = new LocalFileSessionStore({ dir });
        const payload = seeded().save();
        await saveCheckpoint({ store, threadId: 'thread-1', kind: CHECKPOINT_KIND.WORKFLOW, payload });

        const saved = /** @type {any} */ (await store.load('thread-1'));
        assert.equal((/** @type {any} */ (unwrapCheckpoint({ saved }))).kind, CHECKPOINT_KIND.WORKFLOW);

        const restored = restoreCheckpoint({ saved, kind: CHECKPOINT_KIND.WORKFLOW, args: [{ defaultModel: 'm' }] });
        assert.ok(restored instanceof WorkflowExecutor);
        assert.equal(restored.outputs.a, 'OUT-A');
    });

    it('throws on a kind mismatch (G1-3: a present record must not restart the run)', async () => {
        const store = new LocalFileSessionStore({ dir });
        await saveCheckpoint({ store, threadId: 'thread-2', kind: CHECKPOINT_KIND.CHAT, payload: 'hello' });
        const saved = /** @type {any} */ (await store.load('thread-2'));
        // G1-3: this used to return null, so the caller started over and
        // replayed every completed side effect.
        assert.throws(
            () => restoreCheckpoint({ saved, kind: CHECKPOINT_KIND.WORKFLOW, args: [{}] }),
            (/** @type {any} */ err) => err instanceof ConfigurationError && /kind mismatch/i.test(err.message),
        );
        assert.equal(restoreCheckpoint({ saved, kind: CHECKPOINT_KIND.CHAT }), 'hello');
    });
});

describe('D-3/G1-3: a record that exists but is not restorable throws instead of starting over', () => {
    it('a CHAT envelope read as WORKFLOW throws', () => {
        const saved = wrapCheckpoint({ kind: CHECKPOINT_KIND.CHAT, payload: 'hello' });
        assert.throws(
            () => restoreCheckpoint({ saved, kind: CHECKPOINT_KIND.WORKFLOW, args: [{}] }),
            /kind mismatch: expected 'workflow', record is 'chat'/,
        );
    });

    it('a non-string payload throws, naming the kind', () => {
        const saved = { checkpoint: { version: 1, kind: CHECKPOINT_KIND.WORKFLOW, payload: { steps: [] } } };
        assert.throws(
            () => restoreCheckpoint({ saved, kind: CHECKPOINT_KIND.WORKFLOW, args: [{}] }),
            /kind mismatch: expected 'workflow'.*non-string payload/,
        );
    });

    it('a null record still returns null', () => {
        assert.equal(restoreCheckpoint({ saved: null, kind: CHECKPOINT_KIND.WORKFLOW }), null);
    });

    it('ExecutionJournal.fromJSON throws on a version it cannot read', () => {
        assert.throws(() => ExecutionJournal.fromJSON({ version: 99, entries: [] }), /version 99 \(expected 1\)/);
        assert.throws(() => ExecutionJournal.fromJSON('garbage'), /must be an object/);
        assert.throws(() => ExecutionJournal.fromJSON({ version: 1, entries: {} }), /entries must be an array/);
    });

    it('a checkpoint over the node budget throws at save() and never writes "[truncated]"', () => {
        const rows = Array.from({ length: LIMITS.safe_stringify_max_nodes + 10 }, (_, i) => ({ i }));
        const machine = new StateMachine({
            graph: { entry: 'a', nodes: [{ id: 'a' }], edges: [] },
            options: { context: { rows } },
        });
        assert.throws(() => machine.save(), (/** @type {any} */ err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, /safe_stringify_max_nodes/);
            assert.equal(err.option, 'safe_stringify_max_nodes', 'the option is attached (W2C-4)');
            assert.match(String(err.message), /MERCI_LIMIT_SAFE_STRINGIFY_MAX_NODES/, 'the remedy is named');
            assert.equal(err.nonRetryable, true, 'an over-budget checkpoint is not retried');
            assert.ok(!err.message.includes('[truncated]'));
            return true;
        });
        // The tolerant twin (token estimates, prompt blocks) still truncates.
        assert.match(safeStringify({ value: { rows } }), /\[truncated\]/);
    });
});
