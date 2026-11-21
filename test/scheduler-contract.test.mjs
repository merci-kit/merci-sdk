// @ts-check

/**
 * @file Stage 7 contract tests against the REAL engines: checkpoint restore
 * arg shapes, `setSteps` reattachment, `retryFailedSteps`, the additive
 * `runContext` option, the usage diff, the chat checkpoint half of resume, and
 * the approval adapter.
 * @version 0.12.0
 *
 * @description
 * These tests use `WorkflowExecutor`, `StateMachine`, `restoreCheckpoint`, and
 * the real `ChatSession` builder. A fake model client replaces the network so
 * the classes' own contracts run, not a mock of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { InMemorySessionStore } from '../lib/agentic/sessions.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { CHECKPOINT_KIND, restoreCheckpoint, wrapCheckpoint } from '../lib/agentic/planning/checkpoint.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { createEngineRunner } from '../lib/agentic/scheduler/index.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

/**
 * @param {{identifier?: string}} [arg0] -
 * @returns {WorkItem}
 */
function createItem({ identifier = 'MER-1' } = {}) {
    return {
        id: `id-${identifier}`,
        identifier,
        title: `Work ${identifier}`,
        state: 'Todo',
        dispatchable: true,
        labels: [],
        priority: null,
        createdAt: null,
        updatedAt: null,
        lane: 'default',
        nativeRef: null,
        metadata: null,
        blockedBy: [],
        description: null,
        url: null
    };
}

/**
 * @param {{
 *   onRun?: ((arg0: {session: Record<string, any>, runIndex: number}) => string)|null,
 *   usage?: Record<string, number>
 * }} [arg0] -
 */
function createModelClient({ onRun = null, usage = { total_tokens: 10 } } = {}) {
    /** @type {Array<Record<string, any>>} */
    const sessions = [];
    let runIndex = 0;
    return {
        sessions,
        getProfiles: async () => [{ id: 'm' }],
        /**
         * @param {string} model
         * @returns {Record<string, any>}
         */
        session(model) {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'openai',
                model,
                _lastRunUsage: null,
                withSystemMessage() { return session; },
                withTools() { return session; },
                withMemory() { return session; },
                withTodos() { return session; },
                withParameters() { return session; },
                withPromptCache() { return session; },
                withCircuitBreaker() { return session; },
                withRetryPolicy() { return session; },
                withStreamTimeout() { return session; },
                withApproval() { return session; },
                withBudget() { return session; },
                async run() {
                    runIndex += 1;
                    session._lastRunUsage = usage;
                    return onRun ? onRun({ session, runIndex }) : 'OUT';
                }
            };
            sessions.push(session);
            return session;
        }
    };
}

/**
 * @param {{executor: WorkflowExecutor, id: string}} arg0 -
 * @returns {import('../lib/agentic/planning/executor.mjs').WorkflowStep}
 */
function stepOf({ executor, id }) {
    const step = executor.steps.get(id);
    assert.ok(step);
    return step;
}

test('restoreCheckpoint with the options object sets client and defaultModel', () => {
    const client = createModelClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] });
    const saved = wrapCheckpoint({ kind: CHECKPOINT_KIND.WORKFLOW, payload: executor.save() });

    const restored = restoreCheckpoint({
        saved,
        kind: CHECKPOINT_KIND.WORKFLOW,
        args: [{ client, defaultModel: 'm' }]
    });

    assert.ok(restored instanceof WorkflowExecutor);
    assert.equal(/** @type {WorkflowExecutor} */ (restored).client, client);
    assert.equal(/** @type {WorkflowExecutor} */ (restored).defaultModel, 'm');
});

test('setSteps preserves a completed status and reattaches the verify function', { timeout: 5000 }, async () => {
    const client = createModelClient();
    const verify = () => ({ passed: true });
    const steps = [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO', verify }];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: steps });
    await executor.execute({ userGoal: 'goal', context: {} });

    assert.equal(stepOf({ executor, id: 'a' }).status, 'completed');
    executor.setSteps({ stepsList: steps });

    assert.equal(stepOf({ executor, id: 'a' }).status, 'completed', 'an identical re-supplied plan keeps the status');
    assert.equal(stepOf({ executor, id: 'a' }).verify, verify, 'the function is reattached from the live plan');
});

test('retryFailedSteps resets a failed step to pending', { timeout: 5000 }, async () => {
    const client = createModelClient({ onRun: () => { throw new Error('boom'); } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] });
    await assert.rejects(executor.execute({ userGoal: 'goal', context: {} }));

    assert.equal(stepOf({ executor, id: 'a' }).status, 'failed');
    const reset = executor.retryFailedSteps();
    assert.deepEqual(reset, ['a']);
    assert.equal(stepOf({ executor, id: 'a' }).status, 'pending');
});

test('WorkflowExecutor({ options: { runContext } }) parents its events to the supplied run', { timeout: 5000 }, async () => {
    const client = createModelClient();
    const parent = new RunContext({ runId: 'work-item-run' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', runContext: parent } });
    /** @type {Array<Record<string, any>>} */
    const events = [];
    executor.on(EVENTS.WORKFLOW.START, (event) => events.push(event));
    executor.on(EVENTS.WORKFLOW.STEP_START, (event) => events.push(event));
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] });

    await executor.execute({ userGoal: 'goal', context: {} });

    const workflowStart = events.find((event) => event.event === EVENTS.WORKFLOW.START);
    const stepStart = events.find((event) => event.event === EVENTS.WORKFLOW.STEP_START);
    assert.ok(workflowStart);
    assert.ok(stepStart);
    assert.equal(workflowStart.parentRunId, 'work-item-run', 'the workflow is a child of the work-item run');
    assert.equal(stepStart.parentRunId, workflowStart.runId, 'the step is a child of the workflow run');
});

test('a resumed executor reports only the new attempt usage in a before/after diff', { timeout: 5000 }, async () => {
    let failing = true;
    const client = createModelClient({
        onRun: ({ session }) => {
            session._lastRunUsage = { total_tokens: failing ? 10 : 5 };
            if (failing) throw new Error('boom');
            return 'OUT';
        }
    });
    const steps = [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: steps });
    await assert.rejects(executor.execute({ userGoal: 'goal', context: {} }));

    const saved = wrapCheckpoint({ kind: CHECKPOINT_KIND.WORKFLOW, payload: executor.save() });
    const resumed = /** @type {WorkflowExecutor} */ (restoreCheckpoint({
        saved,
        kind: CHECKPOINT_KIND.WORKFLOW,
        args: [{ client, defaultModel: 'm' }]
    }));
    assert.equal(stepOf({ executor: resumed, id: 'a' }).usage?.total_tokens, 10, 'the checkpoint carries the prior attempt usage');
    resumed.retryFailedSteps();
    const before = stepOf({ executor: resumed, id: 'a' }).usage?.total_tokens ?? 0;

    failing = false;
    await resumed.execute({ userGoal: 'goal', context: {} });
    const after = stepOf({ executor: resumed, id: 'a' }).usage?.total_tokens ?? 0;

    assert.equal(stepOf({ executor: resumed, id: 'a' }).status, 'completed');
    assert.equal(after - before, 5, 'only the resumed attempt is reported');
});

test('setSteps on the restore path keeps the restored step usage and drops it on a change', { timeout: 5000 }, async () => {
    const client = createModelClient({ onRun: () => { throw new Error('boom'); } });
    const steps = [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: steps });
    await assert.rejects(executor.execute({ userGoal: 'goal', context: {} }));

    const saved = wrapCheckpoint({ kind: CHECKPOINT_KIND.WORKFLOW, payload: executor.save() });
    const restored = /** @type {WorkflowExecutor} */ (restoreCheckpoint({
        saved,
        kind: CHECKPOINT_KIND.WORKFLOW,
        args: [{ client, defaultModel: 'm' }]
    }));
    assert.equal(stepOf({ executor: restored, id: 'a' }).usage?.total_tokens, 10);

    restored.setSteps({ stepsList: steps });
    assert.equal(stepOf({ executor: restored, id: 'a' }).usage?.total_tokens, 10, 'the restore path keeps the spend');

    restored.setSteps({ stepsList: [{ ...steps[0], userPromptTemplate: 'CHANGED' }] });
    assert.equal(stepOf({ executor: restored, id: 'a' }).usage, undefined, 'a changed definition starts a fresh ledger');
    assert.equal(stepOf({ executor: restored, id: 'a' }).status, 'pending');
});

test('loadCheckpoint restores messages and the journal, and the resumed input contains them', { timeout: 5000 }, async () => {
    const store = new InMemorySessionStore();
    const journal = new ExecutionJournal({ runId: 'prior-run' });
    journal.begin({ key: 'tool-1', meta: { kind: 'tool', name: 'read' } });
    journal.complete({ key: 'tool-1', outcome: { success: true } });
    await store.save({
        threadId: 'work:MER-1',
        data: { messages: [{ role: 'user', content: 'SAVED TURN' }], journal: journal.toJSON() }
    });

    const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
    /** @type {unknown} */
    let captured = null;
    /** @type {Record<string, any>|null} */
    let capturedSession = null;
    const client = {
        /**
         * @param {string} model
         * @returns {Record<string, any>}
         */
        session(model) {
            const session = /** @type {Record<string, any>} */ (new OaiChatSession({
                client: stubClient,
                model,
                eventEmitter: new EventEmitter()
            }));
            session.run = async (/** @type {{initialInput: unknown}} */ args) => {
                captured = args.initialInput;
                capturedSession = session;
                return 'resumed';
            };
            return session;
        }
    };
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', store, prompt: 'fresh' });

    const result = await runner.run({
        item: createItem(),
        attempt: 2,
        workspace: null,
        signal: new AbortController().signal,
        runContext: new RunContext({ runId: 'work-run-1' }),
        reportProgress: () => {}
    });

    assert.equal(result.status, 'completed');
    assert.ok(Array.isArray(captured));
    assert.equal(captured.length, 2);
    const rows = /** @type {Array<Record<string, any>>} */ (captured);
    assert.equal(rows[0].content, 'SAVED TURN');
    assert.equal(rows[1].content, 'Continue the task from where you left off. Do not repeat completed work.');
    assert.ok(capturedSession !== null);
    const resumeSession = /** @type {Record<string, any>} */ (capturedSession);
    assert.ok(resumeSession._journal instanceof ExecutionJournal);
    const restoredJournal = /** @type {ExecutionJournal} */ (resumeSession._journal);
    const entries = restoredJournal.entries();
    assert.equal(entries[0]?.key, 'tool-1', 'the journal is restored, not replaced');
});

test('the approval adapter calls the builder with { fn, options }', { timeout: 5000 }, async () => {
    const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
    /** @type {Array<Record<string, unknown>>} */
    const approvals = [];
    const client = {
        /**
         * @param {string} model
         * @returns {Record<string, any>}
         */
        session(model) {
            const session = /** @type {Record<string, any>} */ (new OaiChatSession({
                client: stubClient,
                model,
                eventEmitter: new EventEmitter()
            }));
            const original = session.withApproval.bind(session);
            session.withApproval = (/** @type {Record<string, unknown>} */ args) => {
                approvals.push(args);
                return original(args);
            };
            session.run = async () => 'approved';
            return session;
        }
    };
    const callback = () => ({ approved: true });
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        prompt: 'go',
        approval: { callback, timeoutMs: 125 }
    });

    await runner.run({
        item: createItem(),
        attempt: null,
        workspace: null,
        signal: new AbortController().signal,
        runContext: new RunContext({ runId: 'work-run-1' }),
        reportProgress: () => {}
    });

    assert.deepEqual(approvals, [{ fn: callback, options: { timeoutMs: 125 } }]);
});
