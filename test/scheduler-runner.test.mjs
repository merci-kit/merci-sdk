// @ts-check

/**
 * @file Stage 7 contract tests for `createEngineRunner`: engine selection,
 * construction validation, the four adapters, resume, usage, and approvals.
 * @version 0.12.0
 *
 * @description
 * The agentic path uses a fake fluent session so every builder call and the
 * exact `run()` input are observable; the DAG and state-machine paths use the
 * REAL executor/machine with a fake model client, so no network call happens
 * while restore, `setSteps`, `retryFailedSteps`, and the usage diff are still
 * the real contracts. The discussion path uses the real `DiscussionSession`
 * with `execute` agents and a stub judge/aggregator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetExceededError, ConfigurationError } from '../lib/core/errors.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';
import { absorbPoolUsage, createBudgetPool, ensureBudgetPool, getBudgetPool, getPoolParent, setPoolParent } from '../lib/agentic/budget-pool.mjs';
import { pooledClient, releaseAttemptLedger, attachSessionPool } from '../lib/agentic/pooled-client.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { isObjectiveRestatePrompt, normalizeObjectivePolicy } from '../lib/agentic/objective.mjs';
import { accumulateUsage } from '../lib/agentic/scheduler/state.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { withTaskAgents, runTaskChild, continueSpawn } from '../lib/agentic/task.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { CHECKPOINT_KIND, restoreCheckpoint, wrapCheckpoint } from '../lib/agentic/planning/checkpoint.mjs';
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
 * @returns {AbortSignal}
 */
function createSignal() {
    return new AbortController().signal;
}

/**
 * @param {{identifier?: string, attempt?: number|null, signal?: AbortSignal}} [arg0] -
 * @returns {{
 *   item: WorkItem,
 *   attempt: number|null,
 *   workspace: null,
 *   signal: AbortSignal,
 *   runContext: RunContext,
 *   reportProgress: () => void,
 *   progress: { count: number }
 * }}
 */
function runArgs({ identifier = 'MER-1', attempt = 1, signal = createSignal() } = {}) {
    const progress = { count: 0 };
    return {
        item: createItem({ identifier }),
        attempt,
        workspace: null,
        signal,
        runContext: new RunContext({ runId: 'work-run-1' }),
        reportProgress: () => { progress.count += 1; },
        progress
    };
}

/**
 * A fake fluent session builder. Every configuration call is recorded and the
 * `run()` argument is kept verbatim.
 * @param {{
 *   checkpoint?: {messages?: Array<Record<string, unknown>>}|null,
 *   run?: ((arg0: {session: Record<string, any>, args: {initialInput: unknown, options: Record<string, any>}}) => unknown)|null,
 *   usage?: Record<string, number>|null
 * }} [arg0] -
 */
function createAgenticClient({ checkpoint = null, run = null, usage = { total_tokens: 7 } } = {}) {
    /** @type {Array<Record<string, any>>} */
    const sessions = [];
    return {
        sessions,
        /**
         * @param {string} model
         * @returns {Record<string, any>}
         */
        session(model) {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'openai',
                model,
                journal: null,
                tools: null,
                budget: null,
                approvals: [],
                store: null,
                threadId: null,
                checkpoint,
                loaded: 0,
                input: null,
                runOptions: null,
                _lastRunUsage: usage,
                withSessionStore(/** @type {{store: unknown, threadId: string}} */ args) {
                    session.store = args.store;
                    session.threadId = args.threadId;
                    return session;
                },
                withExecutionJournal(/** @type {{journal: unknown}} */ args) {
                    session.journal = args.journal;
                    return session;
                },
                withTools(/** @type {{tools: unknown[]}} */ args) {
                    session.tools = args.tools;
                    return session;
                },
                withBudget(/** @type {{budget: unknown}} */ args) {
                    session.budget = args.budget;
                    session._budget = args.budget;
                    return session;
                },
                withApproval(/** @type {Record<string, unknown>} */ args) {
                    session.approvals.push(args);
                    return session;
                },
                async loadCheckpoint() {
                    session.loaded += 1;
                    return session.checkpoint;
                },
                async run(/** @type {{initialInput: unknown, options: Record<string, any>}} */ args) {
                    session.input = args.initialInput;
                    session.runOptions = args.options;
                    return run ? run({ session, args }) : 'agentic done';
                }
            };
            sessions.push(session);
            return session;
        }
    };
}

/**
 * @param {{
 *   onRun?: ((arg0: {session: Record<string, any>, runIndex: number, args: Record<string, any>|undefined}) => string)|null,
 *   usage?: Record<string, number>
 * }} [arg0] -
 */
/**
 * @param {{onRun?: ((arg0: {session: Record<string, any>, runIndex: number, args: Record<string, any>|undefined}) => string|Promise<string>)|null, usage?: Record<string, number>}} [arg0]
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
                async run(/** @type {Record<string, any>|undefined} */ args) {
                    runIndex += 1;
                    session._lastRunUsage = usage;
                    return onRun ? onRun({ session, runIndex, args }) : 'OUT';
                }
            };
            sessions.push(session);
            return session;
        }
    };
}

/**
 * @param {Record<string, Record<string, unknown>>} [initial] -
 */
function createStore(initial = {}) {
    /** @type {Map<string, Record<string, unknown>>} */
    const records = new Map(Object.entries(initial));
    /** @type {Array<{op: string, threadId: string, data?: Record<string, unknown>}>} */
    const calls = [];
    return {
        records,
        calls,
        /**
         * @param {string} threadId
         * @returns {Promise<Record<string, unknown>|null>}
         */
        async load(threadId) {
            calls.push({ op: 'load', threadId });
            return records.get(threadId) ?? null;
        },
        /**
         * @param {{threadId: string, data: Record<string, unknown>}} arg0
         * @returns {Promise<null>}
         */
        async save({ threadId, data }) {
            calls.push({ op: 'save', threadId, data });
            records.set(threadId, data);
            return null;
        }
    };
}

/**
 * @param {Array<Record<string, unknown>>} sessions -
 * @returns {Array<Record<string, unknown>>}
 */
function savesOf(sessions) {
    return sessions.filter((entry) => entry.op === 'save');
}

test('construction selects every engine and validates every required option', () => {
    const client = createAgenticClient();
    assert.equal(typeof createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go' }).run, 'function');
    assert.equal(typeof createEngineRunner({ engine: 'dag', client, model: 'm', planFor: async () => ({ steps: [] }) }).run, 'function');
    assert.equal(typeof createEngineRunner({ engine: 'stateMachine', client, model: 'm', graphFor: () => ({}) }).run, 'function');
    assert.equal(typeof createEngineRunner({ engine: 'discussion', client, model: 'm', agents: [] }).run, 'function');

    /** @type {Array<[Record<string, unknown>, string]>} */
    const cases = [
        [{ engine: 'nope', client, model: 'm' }, 'unsupported_engine'],
        [{ engine: 'agentic', model: 'm', prompt: 'go' }, 'missing_client'],
        [{ engine: 'agentic', client, prompt: 'go' }, 'missing_model'],
        [{ engine: 'agentic', client, model: 'm' }, 'missing_prompt'],
        [{ engine: 'dag', client, model: 'm' }, 'missing_plan'],
        [{ engine: 'stateMachine', client, model: 'm' }, 'missing_graph'],
        [{ engine: 'discussion', client, model: 'm' }, 'missing_agents'],
        [{ engine: 'discussion', client, model: 'm', agents: [], store: createStore() }, 'discussion_no_resume']
    ];
    for (const [options, option] of cases) {
        assert.throws(
            () => createEngineRunner(options),
            (error) => error instanceof ConfigurationError && error.option === option,
            `expected ${option}`
        );
    }

    assert.throws(
        () => createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', store: {} }),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_store'
    );
    assert.throws(
        () => createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', approval: {} }),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_approval'
    );
});

/**
 * A discussion client whose judge answers with a fixed verdict.
 * @param {boolean} passed -
 */
function judgeClient(passed) {
    return {
        provider: 'openai',
        /**
         * @returns {Record<string, unknown>}
         */
        session() {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'openai',
                withSystemMessage() { return session; },
                withTools() { return session; },
                withTodos() { return session; },
                withMemory() { return session; },
                withParameters() { return session; },
                withRetryPolicy() { return session; },
                withStreamTimeout() { return session; },
                withCircuitBreaker() { return session; },
                withApproval() { return session; },
                withBudget() { return session; },
                withPromptCache() { return session; },
                async run() {
                    session._lastRunUsage = { total_tokens: 4 };
                    return JSON.stringify({ passed, score: passed ? 90 : 10, reason: 'verdict', revision: 'minor' });
                }
            };
            return session;
        }
    };
}

test('agentic: store, thread id, journal, tools, progress, usage, and summary', { timeout: 5000 }, async () => {
    const store = createStore();
    let hostEvents = 0;
    const client = createAgenticClient({
        run: ({ session, args }) => {
            args.options.onEvent({ type: 'text', content: 'chunk' });
            return `answer from ${session.model}`;
        }
    });
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        store,
        prompt: (/** @type {{item: WorkItem}} */ { item }) => `work on ${item.identifier}`,
        tools: (/** @type {{item: WorkItem, attempt: number|null, workspace: Record<string, unknown>|null}} */ { item, attempt, workspace }) => [{ name: `tool-${item.identifier}-${attempt}-${workspace === null}` }],
        onEvent: () => { hostEvents += 1; }
    });

    const args = runArgs();
    const result = await runner.run(args);

    const session = client.sessions[0];
    assert.equal(session.store, store);
    assert.equal(session.threadId, 'work:MER-1');
    assert.ok(session.journal instanceof ExecutionJournal);
    assert.deepEqual(session.tools, [{ name: 'tool-MER-1-1-true' }]);
    assert.equal(session.loaded, 1, 'resume with a store loads the checkpoint');

    assert.equal(args.progress.count, 1, 'a session event refreshes progress');
    assert.equal(hostEvents, 1, 'the host onEvent is forwarded');

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.usage, { total_tokens: 7 });
    assert.equal(result.summary, 'answer from m');
    assert.equal(result.progress, true);
});

test('agentic resume passes the saved messages plus the resume prompt', { timeout: 5000 }, async () => {
    const store = createStore();
    const client = createAgenticClient({
        checkpoint: { messages: [{ role: 'user', content: 'SAVED' }] },
        run: () => 'resumed'
    });
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', store, prompt: 'fresh work' });

    const result = await runner.run(runArgs({ attempt: 2 }));

    const session = client.sessions[0];
    assert.ok(Array.isArray(session.input));
    assert.equal(session.input.length, 2);
    assert.equal(session.input[0].content, 'SAVED');
    assert.equal(session.input[1].content, 'Continue the task from where you left off. Do not repeat completed work.');
    assert.equal(result.status, 'completed');
});

test('agentic: a model failure is failed with the raw error, an abort is canceled', { timeout: 5000 }, async () => {
    const failure = await createEngineRunner({
        engine: 'agentic',
        client: createAgenticClient({ run: () => { throw new Error('model down'); } }),
        model: 'm',
        prompt: 'go'
    }).run(runArgs({ attempt: null }));
    assert.equal(failure.status, 'failed');
    assert.equal(/** @type {Error} */ (failure.error).message, 'model down');

    const controller = new AbortController();
    controller.abort();
    const canceled = await createEngineRunner({
        engine: 'agentic',
        client: createAgenticClient({ run: () => { throw new Error('aborted'); } }),
        model: 'm',
        prompt: 'go'
    }).run(runArgs({ attempt: null, signal: controller.signal }));
    assert.equal(canceled.status, 'canceled');
});

test('W2B-6: a moderation sentinel is CONTENT_FILTERED and non-retryable, an empty one stays EMPTY_OUTPUT', { timeout: 5000 }, async () => {
    const filtered = await createEngineRunner({
        engine: 'agentic',
        client: createAgenticClient({ run: () => FALLBACK_MESSAGE.CONTENT_FILTERED }),
        model: 'm',
        prompt: 'go'
    }).run(runArgs({ attempt: null }));
    assert.equal(filtered.status, 'failed');
    assert.equal(/** @type {any} */ (filtered.error).code, 'CONTENT_FILTERED', 'a moderation stop is not an empty answer');
    assert.equal(/** @type {any} */ (filtered.error).nonRetryable, true, 'a moderation stop must not be retried');

    const empty = await createEngineRunner({
        engine: 'agentic',
        client: createAgenticClient({ run: () => FALLBACK_MESSAGE.EMPTY_RESPONSE }),
        model: 'm',
        prompt: 'go'
    }).run(runArgs({ attempt: null }));
    assert.equal(/** @type {any} */ (empty.error).code, 'EMPTY_OUTPUT', 'an empty answer keeps the retryable code');
});

test('agentic approval reaches the builder as { fn, options }', { timeout: 5000 }, async () => {
    const client = createAgenticClient();
    const callback = () => ({ approved: true });
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        prompt: 'go',
        approval: { fn: callback, options: { timeoutMs: 250 } }
    });

    await runner.run(runArgs({ attempt: null }));

    assert.deepEqual(client.sessions[0].approvals, [{ fn: callback, options: { timeoutMs: 250 } }]);
});

test('dag: plans once per attempt, saves on failure, restores, reattaches verify, retries failed steps, and diffs usage', { timeout: 5000 }, async () => {
    const store = createStore();
    const verifyCalls = [];
    /** @type {Array<Record<string, unknown>>} */
    const steps = [{
        id: 'step-1',
        title: 'Step 1',
        systemPrompt: 'Be terse.',
        userPromptTemplate: 'DO-IT',
        verify: (/** @type {unknown} */ output) => {
            verifyCalls.push(output);
            return { passed: true };
        }
    }];
    let planCalls = 0;
    let failing = true;
    const client = createModelClient({
        onRun: ({ session, runIndex }) => {
            session._lastRunUsage = { total_tokens: failing ? 10 : 5 };
            if (failing) throw new Error(`attempt ${runIndex} failed`);
            return 'OUT';
        }
    });
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        store,
        planFor: async () => {
            planCalls += 1;
            return { objective: 'ship it', context: { key: 'value' }, steps };
        }
    });

    const first = await runner.run(runArgs({ attempt: 1 }));
    assert.equal(first.status, 'failed');
    assert.equal(planCalls, 1, 'the first attempt plans once');
    assert.equal(savesOf(store.calls).length, 1, 'a throw still saves the checkpoint');

    failing = false;
    const loadsBefore = store.calls.filter((entry) => entry.op === 'load').length;
    const second = await runner.run(runArgs({ attempt: 2 }));

    assert.equal(second.status, 'completed');
    assert.equal(planCalls, 2, 'the second attempt plans again');
    assert.ok(store.calls.filter((entry) => entry.op === 'load').length > loadsBefore, 'the second attempt restores');
    assert.deepEqual(second.usage, { total_tokens: 5 }, 'only the second attempt usage is reported');
    assert.equal(verifyCalls.length > 0, true, 'setSteps reattached the verify function');
    assert.equal(savesOf(store.calls).length, 2, 'the second attempt saves too');
});

test('dag approval reaches the executor as the normalized callback object', { timeout: 5000 }, async () => {
    const callback = () => ({ approved: true });
    const client = createModelClient();
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        approval: { callback, timeoutMs: 99 },
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    });

    const result = await runner.run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    assert.equal(client.sessions.length > 0, true);
    assert.deepEqual(client.sessions[0]._approvalPolicy, { callback, timeoutMs: 99 });
});

test('state machine: graphFor is used, checkpoint restores, node events report progress, and usage is a diff', { timeout: 5000 }, async () => {
    const store = createStore();
    let nodeRuns = 0;
    /** @type {Record<string, unknown>} */
    const graph = {
        entry: 'only',
        nodes: [{ id: 'only', execute: async () => { nodeRuns += 1; return 'ok'; }, terminal: true }],
        edges: []
    };
    const payload = JSON.stringify({ phase: 'idle', current: 'only', visited: [], history: [], context: {}, usageTokens: 7 });
    await store.save({
        threadId: 'work:MER-1',
        data: wrapCheckpoint({ kind: CHECKPOINT_KIND.STATE_MACHINE, payload })
    });
    store.calls.length = 0;
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store,
        graphFor: (/** @type {{item: WorkItem, attempt: number|null}} */ { item, attempt }) => {
            assert.equal(item.identifier, 'MER-1');
            assert.equal(attempt, 1);
            return graph;
        }
    });
    const args = runArgs({ attempt: 1 });
    const result = await runner.run(args);

    assert.equal(result.status, 'completed');
    assert.equal(nodeRuns, 1, 'the graph ran');
    assert.deepEqual(result.usage, { total_tokens: 0 }, 'the restored usage is not reported again');
    assert.equal(args.progress.count >= 2, true, 'node start/end refresh progress');
    const saves = savesOf(store.calls);
    assert.equal(saves.length, 1, 'the resumed run saves the new checkpoint');
    const savedPayload = JSON.parse(/** @type {Record<string, any>} */ (saves[0].data).checkpoint.payload);
    assert.equal(savedPayload.usageTokens, 7, 'the restored checkpoint started from the saved usage');
});

test('state machine with a store saves the checkpoint after the run', { timeout: 5000 }, async () => {
    const store = createStore();
    const graph = {
        entry: 'only',
        nodes: [{ id: 'only', execute: async () => 'ok', terminal: true }],
        edges: []
    };
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store,
        graphFor: () => graph
    });

    const result = await runner.run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    const saves = savesOf(store.calls);
    assert.equal(saves.length, 1);
    assert.equal(/** @type {Record<string, any>} */ (saves[0].data).checkpoint.kind, CHECKPOINT_KIND.STATE_MACHINE);
});

test('D-4: a state machine that dead-ends on an implicit terminal fails the attempt', { timeout: 5000 }, async () => {
    /** @type {Array<Record<string, any>>} */
    const events = [];
    let sessionCalls = 0;
    const strictClient = /** @type {any} */ ({
        /** @param {string} model */
        session(model) { sessionCalls += 1; throw new Error(`no model call expected (${model})`); }
    });
    const result = await createEngineRunner({
        engine: 'stateMachine',
        client: strictClient,
        model: 'm',
        onEvent: (event) => { events.push(/** @type {Record<string, any>} */ (event)); },
        // A non-terminal node with no matching edge: the machine takes the
        // implicit terminal, and the attempt must not claim the goal is done.
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => 'ok' }], edges: [] })
    }).run(runArgs({ attempt: null }));

    assert.equal(sessionCalls, 0, 'the node needs no model');
    assert.equal(result.status, 'failed', 'a dead end is not a completion');
    assert.equal(result.progress, false, 'the goal was not reached, so there is no progress');
    assert.match(String(/** @type {any} */ (result.error)?.message), /dead end at node "only"/);
    const warning = events.find((event) => event.event === EVENTS.CLIENT.WARNING);
    assert.equal(warning?.code, 'IMPLICIT_TERMINAL', 'the warning still reaches the host');

    // An explicitly terminal node is the same graph's honest completion.
    const completed = await createEngineRunner({
        engine: 'stateMachine',
        client: strictClient,
        model: 'm',
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => 'ok', terminal: true }], edges: [] })
    }).run(runArgs({ attempt: null }));
    assert.equal(completed.status, 'completed', 'an explicit terminal still completes');
    assert.equal(sessionCalls, 0);
});

test('discussion: accepted true completes, accepted false fails', { timeout: 5000 }, async () => {
    const agents = [{ name: 'A', execute: async () => 'a substantive contribution' }];
    const completed = await createEngineRunner({
        engine: 'discussion', client: judgeClient(true), model: 'm', agents, objective: 'ship it'
    }).run(runArgs({ attempt: null }));
    assert.equal(completed.status, 'completed');
    assert.equal(/** @type {Record<string, number>} */ (completed.usage).total_tokens > 0, true);

    const failed = await createEngineRunner({
        engine: 'discussion', client: judgeClient(false), model: 'm', agents, objective: 'ship it'
    }).run(runArgs({ attempt: null }));
    assert.equal(failed.status, 'failed');
    assert.equal(/** @type {Record<string, number>} */ (failed.usage).total_tokens > 0, true);
});

test('a non-object approval is refused, not silently disabled', () => {
    assert.throws(
        () => createEngineRunner({ engine: 'agentic', client: createAgenticClient(), model: 'm', prompt: 'go', approval: 'maybe' }),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_approval'
    );
});

test('W2C-1: a failed checkpoint write fails the attempt on dag and stateMachine', { timeout: 5000 }, async () => {
    const failingStore = {
        load: async () => null,
        save: async () => { throw new Error('disk full'); }
    };

    const dag = await createEngineRunner({
        engine: 'dag',
        client: createModelClient(),
        model: 'm',
        store: failingStore,
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    }).run(runArgs({ attempt: 1 }));
    assert.equal(dag.status, 'failed', 'a run with no durable checkpoint is not completed');
    assert.match(/** @type {Error} */ (dag.error).message, /disk full/);

    const sm = await createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store: failingStore,
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => 'ok', terminal: true }], edges: [] })
    }).run(runArgs({ attempt: 1 }));
    assert.equal(sm.status, 'failed', 'a machine run with no durable checkpoint is not completed');
    assert.match(/** @type {Error} */ (sm.error).message, /disk full/);
});

test('W2C-1: an over-budget checkpoint fails the attempt instead of reporting completed', { timeout: 5000 }, async () => {
    const rows = Array.from({ length: LIMITS.safe_stringify_max_nodes + 10 }, (_, i) => ({ i }));
    const store = createStore();
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store,
        graphFor: () => ({
            entry: 'only',
            nodes: [{ id: 'only', execute: async () => rows, terminal: true }],
            edges: []
        })
    });

    const result = await runner.run(runArgs({ attempt: 1 }));

    assert.equal(result.status, 'failed', 'the checkpoint could not be written, so the attempt is not completed');
    const error = /** @type {any} */ (result.error);
    assert.match(String(error?.message), /safe_stringify_max_nodes/);
    assert.equal(error?.option, 'safe_stringify_max_nodes');
    assert.equal(savesOf(store.calls).length, 0, 'nothing durable was written');
});

test('dag: a plain step refreshes progress on step start and complete', { timeout: 5000 }, async () => {
    // A naive DAG step emits STEP_START/STEP_COMPLETE (not STEP_NODE_*); a long
    // step must still look alive to the stall watchdog (AC12).
    const runner = createEngineRunner({
        engine: 'dag',
        client: createModelClient(),
        model: 'm',
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    });
    const args = runArgs({ attempt: null });
    const result = await runner.run(args);

    assert.equal(result.status, 'completed');
    assert.ok(args.progress.count >= 2, `a plain step reports progress (saw ${args.progress.count})`);
});

test('dag: the host onEvent sees the engine run parented to runContext', { timeout: 5000 }, async () => {
    /** @type {Array<Record<string, any>>} */
    const events = [];
    const runner = createEngineRunner({
        engine: 'dag',
        client: createModelClient(),
        model: 'm',
        onEvent: (event) => { events.push(/** @type {Record<string, any>} */ (event)); },
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    });

    const result = await runner.run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    const start = events.find((event) => event.event === EVENTS.WORKFLOW.START);
    assert.ok(start, 'the engine run start is forwarded');
    assert.equal(start.parentRunId, 'work-run-1', 'the engine run is a child of the supplied run');
    assert.equal(typeof start.runId, 'string');
});

test('state machine: the host onEvent sees the engine run parented to runContext', { timeout: 5000 }, async () => {
    /** @type {Array<Record<string, any>>} */
    const events = [];
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        onEvent: (event) => { events.push(/** @type {Record<string, any>} */ (event)); },
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => 'ok', terminal: true }], edges: [] })
    });

    const result = await runner.run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    const start = events.find((event) => event.event === EVENTS.STATE_MACHINE.START);
    assert.ok(start, 'the machine run start is forwarded');
    assert.equal(start.parentRunId, 'work-run-1');
});

test('discussion: an execute agent refreshes progress', { timeout: 5000 }, async () => {
    const runner = createEngineRunner({
        engine: 'discussion',
        client: judgeClient(true),
        model: 'm',
        agents: [{ name: 'A', execute: async () => 'a substantive contribution' }],
        objective: 'ship it'
    });
    const args = runArgs({ attempt: null });
    const result = await runner.run(args);

    assert.equal(result.status, 'completed');
    assert.ok(args.progress.count >= 1, 'an agent start/finish refreshes progress');
});

test('dag: setSteps on the restore path keeps the prior step usage and the diff is the new spend', { timeout: 5000 }, async () => {
    const store = createStore();
    let failing = true;
    const client = createModelClient({
        onRun: ({ session }) => {
            session._lastRunUsage = { total_tokens: failing ? 10 : 5 };
            if (failing) throw new Error('first attempt failed');
            return 'OUT';
        }
    });
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        store,
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    });

    assert.equal((await runner.run(runArgs({ attempt: 1 }))).status, 'failed');
    failing = false;
    const second = await runner.run(runArgs({ attempt: 2 }));

    assert.equal(second.status, 'completed');
    assert.deepEqual(second.usage, { total_tokens: 5 }, 'only the new spend is reported');
    const restored = /** @type {import('../lib/agentic/planning/executor.mjs').WorkflowExecutor} */ (restoreCheckpoint({
        saved: store.records.get('work:MER-1') ?? null,
        kind: CHECKPOINT_KIND.WORKFLOW,
        args: [{ client, defaultModel: 'm' }]
    }));
    assert.equal(restored.steps.get('a')?.usage?.total_tokens, 15, 'the cumulative spend survives the checkpoint');
});

test('summary caps an agentic and a DAG answer at 2000 characters', { timeout: 5000 }, async () => {
    const agentic = await createEngineRunner({
        engine: 'agentic',
        client: createAgenticClient({ run: () => 'x'.repeat(2500) }),
        model: 'm',
        prompt: 'go'
    }).run(runArgs({ attempt: null }));
    assert.equal(agentic.summary?.length, 2000);

    const dag = await createEngineRunner({
        engine: 'dag',
        client: createModelClient({ onRun: () => 'y'.repeat(2500) }),
        model: 'm',
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    }).run(runArgs({ attempt: null }));
    assert.equal(dag.status, 'completed');
    assert.equal(dag.summary?.length, 2000, 'toPayloadString is capped too');
});

test('dag: an execute throw survives a throwing checkpoint save', { timeout: 5000 }, async () => {
    const store = {
        load: async () => null,
        save: async () => { throw new Error('disk full'); }
    };
    const runner = createEngineRunner({
        engine: 'dag',
        client: createModelClient({ onRun: () => { throw new Error('step boom'); } }),
        model: 'm',
        store,
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    });

    const result = await runner.run(runArgs({ attempt: 1 }));

    assert.equal(result.status, 'failed');
    const message = /** @type {Error} */ (result.error).message;
    assert.match(message, /step boom/, 'the execute error survives');
    assert.equal(message.includes('disk full'), false, 'the save failure does not mask the step error');
    assert.match(
        String(/** @type {any} */ (result.error).durabilityError?.message),
        /disk full/,
        'the checkpoint failure still rides the failed result'
    );
});

test('agentic: a fresh attempt ignores a saved conversation, a resume uses it', { timeout: 5000 }, async () => {
    const saved = { messages: [{ role: 'user', content: 'SAVED' }] };

    const freshClient = createAgenticClient({ checkpoint: saved, run: () => 'fresh' });
    const fresh = await createEngineRunner({
        engine: 'agentic',
        client: freshClient,
        model: 'm',
        store: createStore({ 'work:MER-1': saved }),
        prompt: 'fresh work'
    }).run(runArgs({ attempt: null }));
    assert.equal(fresh.status, 'completed');
    assert.equal(freshClient.sessions[0].input, 'fresh work', 'a fresh attempt uses the prompt, not the saved messages');

    const resumeClient = createAgenticClient({ checkpoint: saved, run: () => 'resumed' });
    await createEngineRunner({
        engine: 'agentic',
        client: resumeClient,
        model: 'm',
        store: createStore({ 'work:MER-1': saved }),
        prompt: 'fresh work'
    }).run(runArgs({ attempt: 2 }));
    assert.ok(Array.isArray(resumeClient.sessions[0].input));
    assert.equal(resumeClient.sessions[0].input[0].content, 'SAVED', 'a resume uses them');
});

test('every engine maps a throw to failed and an abort to canceled without rejecting', { timeout: 5000 }, async () => {
    /** @type {Array<{name: string, make: () => ReturnType<typeof createEngineRunner>}>} */
    const engines = [
        {
            name: 'dag',
            make: () => createEngineRunner({
                engine: 'dag',
                client: createModelClient({ onRun: () => { throw new Error('dag boom'); } }),
                model: 'm',
                planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
            })
        },
        {
            name: 'stateMachine',
            make: () => createEngineRunner({
                engine: 'stateMachine',
                client: createModelClient(),
                model: 'm',
                graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => { throw new Error('sm boom'); }, terminal: true }], edges: [] })
            })
        },
        {
            name: 'discussion',
            make: () => createEngineRunner({
                engine: 'discussion',
                client: { session: () => { throw new Error('discussion boom'); } },
                model: 'm',
                agents: [{ name: 'A', execute: async () => 'a' }],
                objective: 'ship it'
            })
        }
    ];

    for (const engine of engines) {
        const failed = await engine.make().run(runArgs({ attempt: null }));
        assert.equal(failed.status, 'failed', `${engine.name}: a throw is failed`);

        const controller = new AbortController();
        controller.abort();
        const canceled = await engine.make().run(runArgs({ attempt: null, signal: controller.signal }));
        assert.equal(canceled.status, 'canceled', `${engine.name}: an abort is canceled`);
    }
});

/**
 * One session reused across attempts, so its tree pool keeps every attempt's
 * spend — the shape a scheduler that reuses a builder produces. `child` is what
 * a delegated child adds to the pool during `run()`; `fail` throws after it.
 * @param {{child: {prompt_tokens: number, completion_tokens: number, total_tokens: number, cost_usd?: number}, fail?: boolean}} arg0 -
 * @returns {{client: {session: (model: string) => Record<string, any>}, session: Record<string, any>}}
 */
function createPooledClient({ child, fail = false }) {
    /** @type {Record<string, any>} */
    const session = {
        provider: 'openai',
        model: 'm',
        budget: null,
        _budget: null,
        _budgetPool: null,
        _lastRunUsage: { total_tokens: 999 },
        attempts: 0,
        withBudget(/** @type {{budget: unknown}} */ args) {
            session.budget = args.budget;
            session._budget = args.budget;
            return session;
        },
        async run() {
            session.attempts += 1;
            const pool = session._budgetPool;
            pool.usage.prompt_tokens += child.prompt_tokens;
            pool.usage.completion_tokens += child.completion_tokens;
            pool.usage.total_tokens += child.total_tokens;
            if (typeof child.cost_usd === 'number') pool.usage.cost_usd = (pool.usage.cost_usd ?? 0) + child.cost_usd;
            if (fail) throw new Error('attempt failed');
            return 'done';
        }
    };
    return {
        session,
        client: {
            session: (model) => { session.model = model; return session; }
        }
    };
}

test('agentic: usage is the tree pool delta, so a delegated child spend is included', { timeout: 5000 }, async () => {
    const { client, session } = createPooledClient({ child: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: 0.5 } });
    const runner = createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } });

    const first = await runner.run(runArgs({ attempt: 1 }));
    assert.equal(first.status, 'completed');
    const firstPool = session._budgetPool;
    assert.deepEqual(first.usage, {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        cost_usd: 0.5
    }, 'the first costed attempt reports its cost; a pool that started at null cost counts as zero');

    const second = await runner.run(runArgs({ attempt: 2 }));
    assert.deepEqual(second.usage, {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        cost_usd: 0.5
    }, 'the second attempt reports only its own delta, not the cumulative pool');
    assert.equal(session._budgetPool, firstPool, 'both attempts share one tree pool');
    assert.equal(session._budgetPool.usage.total_tokens, 10, 'the pool itself is cumulative');
});

test('agentic: a pool that never reports a cost keeps the attempt cost unknown', { timeout: 5000 }, async () => {
    const { client } = createPooledClient({ child: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } }).run(runArgs({ attempt: null }));

    assert.deepEqual(result.usage, {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cost_usd: null
    }, 'a null after-cost cannot be proven, so the delta reports null');
});

test('agentic: a failed attempt still reports its tree delta', { timeout: 5000 }, async () => {
    const { client } = createPooledClient({ child: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: 0.5 }, fail: true });
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } }).run(runArgs({ attempt: null }));

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.usage, {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        cost_usd: 0.5
    }, 'a throw still reports what the tree spent');
});

test('agentic: a canceled attempt still reports its tree delta', { timeout: 5000 }, async () => {
    const { client } = createPooledClient({ child: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: 0.5 }, fail: true });
    const controller = new AbortController();
    controller.abort();
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } }).run(runArgs({ attempt: null, signal: controller.signal }));

    assert.equal(result.status, 'canceled');
    assert.deepEqual(result.usage, {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        cost_usd: 0.5
    }, 'a cancel still reports what the tree spent');
});

test('agentic: a pool with no observed spend reports no usage, not zeros', { timeout: 5000 }, async () => {
    const { client } = createPooledClient({ child: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } }).run(runArgs({ attempt: null }));

    assert.equal(result.usage, null, 'an all-zero delta is not reported usage');
});

test('agentic: a replaced pool is unknown, not a fresh zero delta', { timeout: 5000 }, async () => {
    // The session swaps its pool during the run (a re-cap that rebuilds it); the
    // two snapshots describe different ledgers, so no delta can be claimed.
    const { client, session } = createPooledClient({ child: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const inner = session.run;
    session.run = async () => {
        session._budgetPool = {
            owner: session,
            maxTotalTokens: 1_000,
            maxBudgetUsd: null,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: null, estimated_tokens: 0 }
        };
        return inner();
    };
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget: { maxTotalTokens: 1_000 } }).run(runArgs({ attempt: null }));

    assert.equal(result.usage, null);
});

test('agentic: without a pool the tree delta is not invented and the run usage is reported', { timeout: 5000 }, async () => {
    const client = createAgenticClient({ usage: { total_tokens: 7 } });
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go' }).run(runArgs({ attempt: null }));

    assert.deepEqual(result.usage, { total_tokens: 7 }, 'no budget means no pool, and the old usage report is unchanged');
    assert.equal(client.sessions[0]._budgetPool ?? null, null, 'the runner does not create a pool for an unbudgeted session');
});

test('the engine budget accepts the coordination maxTotalUsd as maxBudgetUsd', { timeout: 5000 }, async () => {
    /**
     * @param {unknown} budget
     * @returns {Promise<Record<string, unknown>>}
     */
    const passed = async (budget) => {
        const client = createAgenticClient();
        await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget }).run(runArgs({ attempt: null }));
        return client.sessions[0].budget;
    };

    assert.deepEqual(await passed({ maxTotalUsd: 2 }), { maxBudgetUsd: 2 });
    assert.deepEqual(await passed({ maxTotalTokens: 1_000 }), { maxTotalTokens: 1_000 }, 'the token cap passes through unchanged');
    assert.deepEqual(
        await passed({ maxBudgetUsd: 5, maxTotalUsd: 2 }),
        { maxBudgetUsd: 2 },
        'two spellings are one cap, and the smaller one wins'
    );
    assert.deepEqual(await passed({ maxBudgetUsd: null, maxTotalUsd: 2 }), { maxBudgetUsd: 2 }, 'a null spelling cannot erase the cap');
    assert.deepEqual(await passed({ maxBudgetUsd: 0, maxTotalUsd: -1 }), {}, 'non-positive caps are dropped, not clamped');
    assert.deepEqual(await passed({ maxTotalUsd: Infinity }), {}, 'an infinite money cap is ignored');
    assert.deepEqual(await passed({ maxTotalUsd: '2' }), {}, 'a string is not coerced into a cap');
    assert.deepEqual(await passed({ maxTotalUsd: Symbol('2') }), {}, 'a symbol is ignored');
});

test('a budget with a hostile getter cannot abort the attempt', { timeout: 5000 }, async () => {
    const budget = {
        get maxTotalUsd() { throw new Error('hostile'); },
        maxTotalTokens: 500
    };
    const client = createAgenticClient();
    const result = await createEngineRunner({ engine: 'agentic', client, model: 'm', prompt: 'go', budget }).run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    assert.deepEqual(client.sessions[0].budget, { maxTotalTokens: 500 }, 'the readable cap survives');
});

// ─── Attempt ledger for dag / stateMachine / discussion ──────────────────────
//
// The three non-agentic engines report the same tree spend as `agentic`: one
// cap-less ledger per run() collects every session the engine creates (own
// calls and delegated children), and the runner reports its growth.

const ATTEMPT_CHARGE = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cost_usd: 0.25 };

/**
 * The usage shape `usageDelta` reports for `n` charges.
 * @param {number} n
 * @returns {{input_tokens: number, output_tokens: number, total_tokens: number, cost_usd: number}}
 */
function attemptDelta(n) {
    return { input_tokens: 4 * n, output_tokens: n, total_tokens: 5 * n, cost_usd: 0.25 * n };
}

/**
 * A fake model client whose sessions charge the attempt ledger and report a
 * DIFFERENT own-only usage. `orphan` counts a charge that found no attempt pool.
 * @param {{
 *   ownUsage?: Record<string, number>,
 *   fail?: 'throw'|'abort'|null,
 *   abort?: AbortController|null,
 *   gate?: Promise<unknown>|null,
 *   charge?: ((arg0: {session: Record<string, any>, args: Record<string, any>|undefined}) => boolean)|null
 * }} [arg0] -
 * @returns {{client: ReturnType<typeof createModelClient>, orphan: {count: number}, charged: {count: number}, pools: Array<Record<string, any>>}}
 */
function createAttemptClient({ ownUsage = { total_tokens: 9 }, fail = null, abort = null, gate = null, charge = null } = {}) {
    const orphan = { count: 0 };
    const charged = { count: 0 };
    /** @type {Array<Record<string, any>>} */
    const pools = [];
    const client = createModelClient({
        usage: ownUsage,
        onRun: ({ session, args }) => {
            const pool = session._budgetPool;
            if (charge !== null && !charge({ session, args })) {
                // A silent call: no charge, and no orphan either.
            } else if (!pool) {
                orphan.count += 1;
            } else {
                charged.count += 1;
                pools.push(pool);
                // Charge the way a real session does: through the pool chain.
                absorbPoolUsage({ pool, usage: ATTEMPT_CHARGE });
            }
            if (fail === 'throw') throw new Error('attempt failed');
            if (fail === 'abort' && abort) {
                abort.abort();
                const error = new Error('attempt aborted');
                error.name = 'AbortError';
                throw error;
            }
            return gate ? /** @type {any} */ (gate).then(() => 'OUT') : 'OUT';
        }
    });
    return { client, orphan, charged, pools };
}

/**
 * A DAG plan of independent model steps.
 * @param {number} count
 * @returns {() => Promise<{objective: string, context: Record<string, unknown>, steps: Array<Record<string, unknown>>}>}
 */
function dagPlan(count) {
    return async () => ({
        objective: 'ship',
        context: {},
        steps: Array.from({ length: count }, (/** @type {number} */ _, /** @type {number} */ i) => ({
            id: `s${i}`,
            title: `S${i}`,
            systemPrompt: 'S',
            userPromptTemplate: 'GO'
        }))
    });
}

/** A two-node state machine graph.
 * @type {Record<string, unknown>}
 */
const TWO_NODE_GRAPH = {
    entry: 'a',
    nodes: [
        { id: 'a', model: 'm', userPromptTemplate: 'GO' },
        { id: 'b', model: 'm', userPromptTemplate: 'GO', terminal: true }
    ],
    edges: [{ from: 'a', to: 'b' }]
};

/** One discussion agent that runs on the model client.
 * @type {Array<Record<string, unknown>>}
 */
const MODEL_AGENTS = [{ name: 'A', model: 'm', provider: 'openai' }];

/**
 * Every budgeted engine, so the shared contract is pinned on each.
 * @param {Record<string, any>} client
 * @returns {Record<string, ReturnType<typeof createEngineRunner>>}
 */
function budgetedEngines(client) {
    return {
        dag: createEngineRunner({ engine: 'dag', client, model: 'm', planFor: dagPlan(2), budget: { maxTotalTokens: 1_000 } }),
        stateMachine: createEngineRunner({ engine: 'stateMachine', client, model: 'm', graphFor: () => TWO_NODE_GRAPH, budget: { maxTotalTokens: 1_000 } }),
        discussion: createEngineRunner({ engine: 'discussion', client, model: 'm', agents: MODEL_AGENTS, objective: 'ship', budget: { maxTotalTokens: 1_000 } })
    };
}

for (const engine of /** @type {const} */ (['dag', 'stateMachine', 'discussion'])) {
    test(`${engine}: usage is the attempt ledger delta, so child spend is reported once`, { timeout: 5000 }, async () => {
        const { client, orphan, charged, pools } = createAttemptClient();
        const result = await budgetedEngines(client)[engine].run(runArgs({ attempt: 1 }));

        assert.equal(client.sessions.length >= 1, true, 'the engine created sessions');
        assert.equal(pools.length >= 1, true, 'a budgeted attempt attaches a ledger');
        const pool = pools[0];
        assert.equal(new Set(pools).size, 1, 'every session joins the one attempt ledger');
        assert.deepEqual(result.usage, attemptDelta(charged.count), 'the delta counts each session once');
        assert.equal(pool.usage.total_tokens, 5 * charged.count, 'the ledger holds exactly the reported growth');
        assert.notEqual(
            /** @type {Record<string, number>} */ (result.usage).total_tokens,
            9 * client.sessions.length,
            'the engine own-only total is not the report'
        );
        assert.equal(orphan.count, 0, 'no session charged without the attempt ledger');
        assert.equal(client.sessions.every((session) => session._budgetPool === undefined), true, 'the ledger is detached after the attempt');
    });
}

test('dag and state machine: two units total the ledger growth once, not twice', { timeout: 5000 }, async () => {
    for (const engine of /** @type {const} */ (['dag', 'stateMachine'])) {
        const { client, charged, pools } = createAttemptClient();
        const result = await budgetedEngines(client)[engine].run(runArgs({ attempt: null }));
        const pool = pools[0];

        assert.equal(charged.count >= 2, true, `${engine}: the two units each charged`);
        assert.deepEqual(result.usage, attemptDelta(charged.count), `${engine}: one charge per unit`);
        assert.equal(pool.usage.total_tokens, /** @type {Record<string, number>} */ (result.usage).total_tokens);
        assert.notDeepEqual(result.usage, attemptDelta(charged.count * 2), `${engine}: the delta is not applied twice`);
    }
});

test('two concurrent run() calls get distinct ledgers', { timeout: 5000 }, async () => {
    /** @type {Array<Record<string, any>>} */
    const pools = [];
    /** @type {() => void} */
    let release = () => {};
    const bothStarted = new Promise((resolve) => { release = () => resolve(undefined); });
    const client = createModelClient({
        usage: { total_tokens: 9 },
        onRun: ({ session }) => {
            const pool = session._budgetPool;
            pools.push(pool);
            pool.usage.prompt_tokens += ATTEMPT_CHARGE.prompt_tokens;
            pool.usage.completion_tokens += ATTEMPT_CHARGE.completion_tokens;
            pool.usage.total_tokens += ATTEMPT_CHARGE.total_tokens;
            pool.usage.cost_usd = (pool.usage.cost_usd ?? 0) + ATTEMPT_CHARGE.cost_usd;
            if (pools.length === 2) release();
            return /** @type {any} */ (bothStarted).then(() => 'OUT');
        }
    });
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', model: 'm', userPromptTemplate: 'GO', terminal: true }], edges: [] })
    });

    const [first, second] = await Promise.all([
        runner.run(runArgs({ identifier: 'MER-1', attempt: null })),
        runner.run(runArgs({ identifier: 'MER-2', attempt: null }))
    ]);

    assert.equal(pools.length, 2, 'both attempts ran while the other was live');
    assert.notEqual(pools[0], pools[1], 'each run() owns its ledger');
    assert.equal(pools[0].usage.total_tokens, 5, 'a charge in one attempt is invisible to the other');
    assert.equal(pools[1].usage.total_tokens, 5, 'a charge in one attempt is invisible to the other');
    assert.deepEqual(first.usage, attemptDelta(1));
    assert.deepEqual(second.usage, attemptDelta(1));
});

test('failed attempts report the ledger delta on all three engines', { timeout: 5000 }, async () => {
    for (const engine of /** @type {const} */ (['dag', 'stateMachine', 'discussion'])) {
        const { client, charged, orphan } = createAttemptClient({ fail: 'throw' });
        const result = await budgetedEngines(client)[engine].run(runArgs({ attempt: null }));

        assert.equal(result.status, 'failed', `${engine}: a throw is failed`);
        assert.deepEqual(result.usage, attemptDelta(charged.count), `${engine}: a failed attempt still reports what it spent`);
        assert.equal(charged.count >= 1, true);
        assert.equal(orphan.count, 0, `${engine}: no session charged without the attempt ledger`);
    }
});

test('canceled attempts report the ledger delta on all three engines', { timeout: 5000 }, async () => {
    for (const engine of /** @type {const} */ (['dag', 'stateMachine', 'discussion'])) {
        const controller = new AbortController();
        const { client, charged } = createAttemptClient({ fail: 'abort', abort: controller });
        const result = await budgetedEngines(client)[engine]
            .run(runArgs({ attempt: null, signal: controller.signal }));

        assert.equal(result.status, 'canceled', `${engine}: an abort is canceled`);
        assert.deepEqual(result.usage, attemptDelta(charged.count), `${engine}: a canceled attempt still reports what it spent`);
        assert.equal(charged.count >= 1, true);
    }
});

test('no budget: no ledger is created and the per-engine usage is unchanged', { timeout: 5000 }, async () => {
    // The exact per-engine numbers this reported before the change.
    const dag = createAttemptClient();
    const dagResult = await createEngineRunner({ engine: 'dag', client: dag.client, model: 'm', planFor: dagPlan(2) }).run(runArgs({ attempt: null }));
    assert.deepEqual(dagResult.usage, { total_tokens: 18 }, 'dag reports its own step total');
    assert.equal(dag.client.sessions.every((session) => session._budgetPool === undefined), true, 'dag attaches no ledger');

    const sm = createAttemptClient();
    const smResult = await createEngineRunner({ engine: 'stateMachine', client: sm.client, model: 'm', graphFor: () => TWO_NODE_GRAPH }).run(runArgs({ attempt: null }));
    assert.deepEqual(smResult.usage, { total_tokens: 18 }, 'stateMachine reports its own node total');
    assert.equal(sm.client.sessions.every((session) => session._budgetPool === undefined), true, 'stateMachine attaches no ledger');

    const base = judgeClient(true);
    /** @type {Array<Record<string, any>>} */
    const sessions = [];
    const discussionClient = { provider: 'openai', session: (/** @type {string} */ model) => { const session = base.session(); sessions.push(session); return session; } };
    const discussionResult = await createEngineRunner({
        engine: 'discussion',
        client: discussionClient,
        model: 'm',
        agents: [{ name: 'A', execute: async () => 'a substantive contribution' }],
        objective: 'ship'
    }).run(runArgs({ attempt: null }));
    assert.deepEqual(discussionResult.usage, { total_tokens: 8 }, 'discussion reports its own session total');
    assert.equal(sessions.every((session) => session._budgetPool === undefined), true, 'discussion attaches no ledger');
});

test('a nested state machine inside a DAG step reports the nested spend once', { timeout: 5000 }, async () => {
    const { client, orphan, charged, pools } = createAttemptClient();
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: async () => ({
            objective: 'ship',
            context: {},
            steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO', engine: 'stateMachine' }]
        })
    });
    const result = await runner.run(runArgs({ attempt: null }));
    const pool = pools[0];

    assert.equal(charged.count >= 1, true, 'the nested node charged the outer ledger');
    assert.deepEqual(result.usage, attemptDelta(charged.count), 'the nested spend is counted once, not per engine');
    assert.equal(pool.usage.total_tokens, /** @type {Record<string, number>} */ (result.usage).total_tokens, 'the outer ledger holds exactly the reported growth');
    assert.equal(orphan.count, 0);
});

test('withBudget on an attached session creates a capped child ledger, not a re-capped attempt', { timeout: 5000 }, async () => {
    /** @type {Array<{own: any, attempt: any, shared: boolean, maxTotalTokens: unknown}>} */
    const observed = [];
    const { client } = createScriptedClient({
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        decorate: (session) => {
            // Applied after attach, before the run: the realistic builder order.
            const run = session.run.bind(session);
            session.run = async (/** @type {any} */ args) => {
                session.withBudget({ budget: { maxTotalTokens: 50 } });
                const view = getBudgetPool({ session });
                observed.push({
                    own: session._budgetPool,
                    attempt: getPoolParent({ pool: session._budgetPool }),
                    shared: view?.shared === true,
                    maxTotalTokens: view?.maxTotalTokens ?? null
                });
                return run(args);
            };
        }
    });
    const result = await createEngineRunner({ engine: 'stateMachine', client, model: 'm', budget: { maxTotalTokens: 1_000 }, graphFor: () => ONE_NODE_GRAPH })
        .run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    assert.equal(observed.length, 1);
    const [entry] = observed;
    assert.notEqual(entry.own, entry.attempt, 'the session got its own ledger under the attempt');
    assert.equal(entry.shared, false, 'the session owns the cap');
    assert.equal(entry.maxTotalTokens, 50, 'the cap is preserved');
    assert.equal(entry.attempt?.maxTotalTokens, null, 'a session budget never re-caps the attempt ledger');
    assert.equal(entry.attempt?.maxBudgetUsd, null);
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, 'the spend still reaches the attempt once');
    assert.equal(getPoolParent({ pool: entry.own }), null, 'release unlinks the child ledger');
    assert.equal(entry.own.usage.total_tokens, 5, 'the child ledger keeps its own usage');
});

test('a pooled attempt that observed no spend reports an explicit zero', { timeout: 5000 }, async () => {
    const client = createModelClient({ usage: { total_tokens: 9 }, onRun: () => 'OUT' });
    const result = await createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', model: 'm', userPromptTemplate: 'GO', terminal: true }], edges: [] })
    }).run(runArgs({ attempt: null }));

    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: null }, 'a zero ledger is reported, not null');

    const totals = /** @type {any} */ ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, usageComplete: true, costComplete: true });
    accumulateUsage({ totals, usage: result.usage });
    assert.equal(totals.usageComplete, true, 'a reported zero keeps usage complete');
    assert.equal(totals.costComplete, false, 'no cost was reported');
});

test('a detached memoized session starts the next sequential attempt clean', { timeout: 5000 }, async () => {
    /** @type {Array<Record<string, any>>} */
    const pools = [];
    /** @type {Record<string, any>} */
    const session = {
        provider: 'openai',
        model: 'm',
        _budgetPool: undefined,
        _lastRunUsage: null,
        withSystemMessage() { return session; },
        withTools() { return session; },
        withTodos() { return session; },
        withMemory() { return session; },
        withParameters() { return session; },
        withRetryPolicy() { return session; },
        withStreamTimeout() { return session; },
        withCircuitBreaker() { return session; },
        withApproval() { return session; },
        withBudget() { return session; },
        withPromptCache() { return session; },
        async run() {
            const pool = session._budgetPool;
            pools.push(pool);
            pool.usage.prompt_tokens += ATTEMPT_CHARGE.prompt_tokens;
            pool.usage.completion_tokens += ATTEMPT_CHARGE.completion_tokens;
            pool.usage.total_tokens += ATTEMPT_CHARGE.total_tokens;
            pool.usage.cost_usd = (pool.usage.cost_usd ?? 0) + ATTEMPT_CHARGE.cost_usd;
            return 'OUT';
        }
    };
    const client = { session: () => session };
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', model: 'm', userPromptTemplate: 'GO', terminal: true }], edges: [] })
    });

    const first = await runner.run(runArgs({ identifier: 'MER-1', attempt: null }));
    const second = await runner.run(runArgs({ identifier: 'MER-2', attempt: null }));

    assert.equal(pools.length, 2, 'each attempt attached a ledger');
    assert.notEqual(pools[0], pools[1], 'the memoized session got a fresh ledger');
    assert.deepEqual(first.usage, attemptDelta(1), 'the first attempt reports its own delta');
    assert.deepEqual(second.usage, attemptDelta(1), 'the second attempt reports its own delta');
    assert.equal(session._budgetPool, undefined, 'the last attempt detached its ledger');
});

test('discussion: an agent on its own client still charges the attempt ledger', { timeout: 5000 }, async () => {
    const runnerClient = createAttemptClient();
    const ownClient = createAttemptClient();
    /** @type {any} */ (ownClient.client).provider = 'openai';
    const result = await createEngineRunner({
        engine: 'discussion',
        client: runnerClient.client,
        model: 'm',
        agents: [{ name: 'A', model: 'm', client: ownClient.client }],
        objective: 'ship',
        budget: { maxTotalTokens: 1_000 }
    }).run(runArgs({ attempt: null }));

    assert.equal(ownClient.charged.count >= 1, true, 'the own-client session charged the ledger');
    assert.equal(ownClient.orphan.count, 0, 'the own client session found the attempt ledger');
    assert.equal(runnerClient.charged.count, 0, 'the runner client itself created no session');
    assert.deepEqual(result.usage, attemptDelta(ownClient.charged.count), 'the attempt reports the own-client spend');
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens > 0, true);
});

test('discussion: a task subtree keeps its capped pool and folds its spend into the attempt', { timeout: 5000 }, async () => {
    const base = createAttemptClient();
    /** @type {any} */ (base.client).provider = 'openai';
    withTaskAgents({ client: base.client, agents: [{ name: 'worker', model: 'm', provider: 'openai' }] });
    const attempt = createBudgetPool();
    const group = new DiscussionSession({
        client: /** @type {any} */ (pooledClient({ client: base.client, pool: attempt })),
        options: { budget: { maxTotalTokens: 100 }, budgetPool: attempt }
    });
    group.addAgent({ name: 'A', model: 'm', provider: 'openai' });

    await group.runTasks({ tasks: [{ title: 't', subagent_type: 'worker', description: 'do' }], sequential: true });

    const record = [...getSpawnRegistry({ client: base.client }).spawns.values()][0];
    const pseudoParent = /** @type {any} */ (record?.parent);
    const capped = pseudoParent?._budgetPool;
    assert.ok(capped, 'the task pseudo-parent built its own capped pool');
    assert.notEqual(capped, attempt, 'the cap-less attempt ledger is not inherited');
    assert.equal(getPoolParent({ pool: capped }), attempt, 'but the subtree reports to the attempt ledger');
    assert.equal(capped.maxTotalTokens, 100, 'the pseudo-parent budget is the cap');
    assert.equal(capped.usage.total_tokens, 5, 'the task charges its own capped pool');
    assert.equal(attempt.usage.total_tokens, 5, 'and the charge reaches the attempt ledger once');

    await group.discuss({ instruction: 'x', turns: 1, sequential: true });
    assert.equal(attempt.usage.total_tokens, 10, 'the main turn adds its 5, not the task spend again');
    assert.equal(capped.usage.total_tokens, 5, 'the child pool stays its own ledger');
});

test('dag (real sessions): a delegated child charges the attempt ledger', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    /** @param {string} model */
    client.session = (model) => {
        const session = new OaiChatSession({ client, model, eventEmitter: emitter });
        // A real session's `.client` is its emitter; delegation resolves the transport.
        /** @type {any} */ (session).client = client;
        /** @type {any} */ (session).step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
            const restate = messages.some((row) => String(row?.content ?? '').includes('You maintain the working objective'));
            if (restate) {
                yield { type: 'quota', data: { prompt_tokens: 1, completion_tokens: 0 } };
                return { done: true, content: 'OBJECTIVE', messages: [...messages, { role: 'assistant', content: 'OBJECTIVE' }] };
            }
            if (model === 'child-model') {
                yield { type: 'quota', data: { prompt_tokens: 3, completion_tokens: 2 } };
                return { done: true, content: 'child answer', messages: [...messages, { role: 'assistant', content: 'child answer' }] };
            }
            yield { type: 'quota', data: { prompt_tokens: 4, completion_tokens: 1 } };
            // A real delegation: the real task path builds a real child session on
            // this client, and its model call charges the same attempt ledger.
            await runTaskChild({
                session: /** @type {any} */ (session),
                profile: /** @type {any} */ (getSpawnRegistry({ client }).agents.get('worker')),
                args: { description: 'x', prompt: 'do', subagent_type: 'worker' },
                signal: undefined,
                eventEmitter: emitter
            });
            return { done: true, content: 'FINAL', messages: [...messages, { role: 'assistant', content: 'FINAL' }] };
        };
        return session;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'child-model' }] });

    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 10_000 },
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 'a', title: 'A', systemPrompt: 'S', userPromptTemplate: 'GO' }] })
    });
    const result = await runner.run(runArgs({ attempt: null }));

    assert.deepEqual(
        result.usage,
        { input_tokens: 8, output_tokens: 3, total_tokens: 11, cost_usd: null },
        'objective 1 + own 5 + the delegated child 5'
    );
});

test('the objective restatement charges the attempt ledger', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const transport = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    /** @param {string} model */
    transport.session = (model) => {
        const session = new OaiChatSession({ client: transport, model, eventEmitter: emitter });
        /** @type {any} */ (session).client = transport;
        /** @type {any} */ (session).step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
            yield { type: 'quota', data: { prompt_tokens: 2, completion_tokens: 1 } };
            return { done: true, content: 'RESTATED GOAL', messages: [...messages, { role: 'assistant', content: 'RESTATED GOAL' }] };
        };
        return session;
    };
    const pool = createBudgetPool();
    const session = /** @type {any} */ (transport.session('m'));
    session._budgetPool = pool;
    session._agentContext = AgentContext.fromObjective({ objective: 'ship it' });
    session._agentContext.objectivePolicy = normalizeObjectivePolicy({});

    const outcome = await session._maybeObjectivePass({ messages: [createUserMessage({ provider: 'openai', content: 'go' })] });

    assert.equal(outcome?.applied, true, 'the restatement was applied');
    assert.equal(pool.usage.prompt_tokens, 2, 'the restatement prompt is on the attempt ledger');
    assert.equal(pool.usage.completion_tokens, 1);
    assert.equal(pool.usage.total_tokens, 3, 'the whole restatement call is on the attempt ledger');
});

test('a session already carrying another attempt ledger is refused', { timeout: 5000 }, async () => {
    /** @type {Record<string, any>} */
    const memoized = { provider: 'openai', _budget: null, _budgetPool: undefined, async run() { return 'OUT'; } };
    const memoClient = { session: () => memoized };
    const first = createBudgetPool();
    const second = createBudgetPool();

    const firstView = /** @type {any} */ (pooledClient({ client: memoClient, pool: first }));
    assert.equal(firstView.session('m')._budgetPool, first, 'the first view attaches its ledger');
    assert.throws(
        () => /** @type {any} */ (pooledClient({ client: memoClient, pool: second })).session('m'),
        (error) => error instanceof ConfigurationError && error.option === 'session_reused_across_attempts',
        'a second attempt refuses the stale ledger'
    );

    const capped = /** @type {any} */ ({ _budget: { maxTotalTokens: 10 }, _budgetPool: { owner: {}, maxTotalTokens: 10, maxBudgetUsd: null, usage: {} } });
    const cappedView = /** @type {any} */ (pooledClient({ client: { session: () => capped }, pool: second }));
    assert.equal(cappedView.session('m')._budgetPool, capped._budgetPool, 'an own-budget session keeps its capped pool');
});

test('two concurrent attempts cannot share one memoized session', { timeout: 5000 }, async () => {
    /** @type {Record<string, any>} */
    const memoized = {
        provider: 'openai',
        _budget: null,
        _budgetPool: undefined,
        _lastRunUsage: null,
        withSystemMessage() { return memoized; },
        withTools() { return memoized; },
        withTodos() { return memoized; },
        withMemory() { return memoized; },
        withParameters() { return memoized; },
        withRetryPolicy() { return memoized; },
        withStreamTimeout() { return memoized; },
        withCircuitBreaker() { return memoized; },
        withApproval() { return memoized; },
        withBudget() { return memoized; },
        withPromptCache() { return memoized; },
        async run() {
            memoized._budgetPool.usage.total_tokens += 5;
            return 'OUT';
        }
    };
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: { session: () => memoized },
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', model: 'm', userPromptTemplate: 'GO', terminal: true }], edges: [] })
    });

    const results = await Promise.all([
        runner.run(runArgs({ identifier: 'MER-1', attempt: null })),
        runner.run(runArgs({ identifier: 'MER-2', attempt: null }))
    ]);

    const refused = results.filter((result) => result.status === 'failed'
        && /** @type {any} */ (result.error)?.option === 'session_reused_across_attempts');
    const completed = results.filter((result) => result.status === 'completed');
    assert.equal(refused.length, 1, 'one attempt is refused loudly');
    assert.equal(completed.length, 1, 'the other attempt owns the session');
    assert.equal(/** @type {Record<string, number>} */ (completed[0].usage).total_tokens, 5);
});

// ─── A budgeted subtree folds into the attempt ledger (phase A+B) ────────────
//
// A session that owns `_budget` keeps its own cap and its own ledger: the cap
// still binds the subtree exactly as before. What changed is reporting — the
// charge also reaches the attempt ledger through the parent chain, so a
// budgeted subtree is no longer invisible to the scheduler's totals.

test('pool chain: a charge reaches every ancestor once, and a cycle terminates', () => {
    const attempt = createBudgetPool();
    const child = createBudgetPool();
    const grandchild = createBudgetPool();
    setPoolParent({ pool: child, parent: attempt });
    setPoolParent({ pool: grandchild, parent: child });

    absorbPoolUsage({ pool: grandchild, usage: { prompt_tokens: 3, completion_tokens: 2, cost_usd: 0.5 } });
    for (const pool of [attempt, child, grandchild]) {
        assert.equal(pool.usage.prompt_tokens, 3);
        assert.equal(pool.usage.completion_tokens, 2);
        assert.equal(pool.usage.total_tokens, 5, 'each ancestor totals the charge once');
        assert.equal(pool.usage.cost_usd, 0.5, 'a finite cost propagates');
    }

    absorbPoolUsage({ pool: grandchild, usage: null, estTokens: 7 });
    for (const pool of [attempt, child, grandchild]) {
        assert.equal(pool.usage.total_tokens, 12, 'a silent charge propagates as the estimate');
        assert.equal(pool.usage.estimated_tokens, 7);
    }

    assert.throws(
        () => setPoolParent({ pool: grandchild, parent: grandchild }),
        (error) => error instanceof ConfigurationError,
        'a ledger cannot be its own parent'
    );
    assert.equal(getPoolParent({ pool: grandchild }), child, 'the rejected link changed nothing');

    // A two-pool cycle is still malformed data; the visited guard must end it.
    const left = createBudgetPool();
    const right = createBudgetPool();
    setPoolParent({ pool: left, parent: right });
    setPoolParent({ pool: right, parent: left });
    absorbPoolUsage({ pool: left, usage: { prompt_tokens: 1, completion_tokens: 0 } });
    assert.equal(left.usage.total_tokens, 1, 'a cycle stops after one pass');
    assert.equal(right.usage.total_tokens, 1, 'and the other pool sees the charge once');

    assert.doesNotThrow(() => JSON.stringify(attempt), 'the parent link is not enumerable');
    assert.equal('parent' in attempt, false, 'no parent property exists on the ledger');
});

test('an eager owner ledger registers with its parent and keeps its own cap', () => {
    const attempt = createBudgetPool();
    /** @type {Record<string, any>} */
    const session = { _budget: { maxTotalTokens: 100 } };
    const pool = /** @type {any} */ (ensureBudgetPool({ session, parent: attempt }));

    assert.equal(session._budgetPool, pool);
    assert.equal(getPoolParent({ pool }), attempt);
    assert.deepEqual(attempt.children, [pool], 'the parent can release the link later');
    assert.equal(pool.maxTotalTokens, 100, 'the child cap still binds the subtree');
    assert.equal(getBudgetPool({ session })?.shared, false, 'the child owns its cap');

    /** @type {Record<string, any>} */
    const lazySession = { _budget: { maxTotalTokens: 50 } };
    const lazy = /** @type {any} */ (ensureBudgetPool({ session: lazySession }));
    assert.equal(getPoolParent({ pool: lazy }), null, 'the lazy path links no parent');
    assert.equal(lazySession._budgetPool, lazy);

    // A ledger created lazily (a pre-run read) joins the attempt when it appears.
    ensureBudgetPool({ session: lazySession, parent: attempt });
    assert.equal(getPoolParent({ pool: lazy }), attempt, 'an existing unparented pool is linked');
    assert.equal(attempt.children.includes(lazy), true, 'and registered once');
    assert.equal(attempt.children.filter((entry) => entry === lazy).length, 1);
});

test('session lists stay out of JSON after a session attached', () => {
    const attempt = createBudgetPool();
    /** @type {Record<string, any>} */
    const attachedSession = { _budget: null };
    /** @type {Record<string, any>} */
    const ownerSession = { _budget: { maxTotalTokens: 100 } };
    /** @type {any} */ (pooledClient({ client: { session: () => attachedSession }, pool: attempt })).session('m');
    ensureBudgetPool({ session: ownerSession, parent: attempt });

    assert.equal(attachedSession._budgetPool, attempt);
    assert.equal(attempt.attached.length, 1);
    assert.equal(attempt.children.length, 1);
    const plain = JSON.parse(JSON.stringify(attempt));
    assert.equal(plain.attached, undefined, 'the session list is not enumerable');
    assert.equal(plain.children, undefined, 'the child list is not enumerable');
});

/**
 * A real OAI session whose one model call reports `usage`. `decorate` runs at
 * creation (before the attempt attaches), `onStep` inside the turn.
 * @param {{
 *   usage?: {prompt_tokens: number, completion_tokens: number},
 *   decorate?: ((arg0: Record<string, any>, arg1: number) => void)|null,
 *   onStep?: ((arg0: Record<string, any>) => void)|null
 * }} [arg0] -
 * @returns {{client: any, sessions: Array<Record<string, any>>}}
 */
function createScriptedClient({ usage = { prompt_tokens: 90, completion_tokens: 30 }, decorate = null, onStep = null } = {}) {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    /** @type {Array<Record<string, any>>} */
    const sessions = [];
    /** @param {string} model */
    client.session = (model) => {
        const session = /** @type {any} */ (new OaiChatSession({ client, model, eventEmitter: emitter }));
        decorate?.(session, sessions.length);
        session.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
            onStep?.(session);
            yield { type: 'quota', data: usage };
            return { done: true, content: 'OUT', messages: [...messages, { role: 'assistant', content: 'OUT' }] };
        };
        sessions.push(session);
        return session;
    };
    return { client, sessions };
}

/** One terminal node.
 * @type {Record<string, unknown>}
 */
const ONE_NODE_GRAPH = {
    entry: 'only',
    nodes: [{ id: 'only', model: 'm', userPromptTemplate: 'GO', terminal: true }],
    edges: []
};

test('a session that arrives budgeted keeps its cap and folds its spend', { timeout: 5000 }, async () => {
    const { client } = createScriptedClient({ decorate: (session) => { session._budget = { maxTotalTokens: 100 }; } });
    const result = await createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    }).run(runArgs({ attempt: null }));

    assert.equal(result.status, 'failed', 'the subtree cap still stops the run');
    assert.ok(result.error instanceof BudgetExceededError, 'with the typed budget error');
    assert.equal(/** @type {any} */ (result.error).maxTotalTokens, 100, 'the session cap is preserved, not the runner cap');
    assert.equal(/** @type {any} */ (result.error).usage.total_tokens, 120);
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 120, 'and the spend is folded into the attempt');
});

test('a budget at attach and a budget applied after attach keep their contracts', { timeout: 5000 }, async () => {
    /** @type {any} */
    let childView = null;
    /** @type {any} */
    let attempt = null;
    const attachedRun = createScriptedClient({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        decorate: (session) => { session._budget = { maxTotalTokens: 100 }; },
        onStep: (session) => {
            session.withBudget({ budget: { maxTotalTokens: 40 } });
            attempt = getPoolParent({ pool: session._budgetPool });
            childView = getBudgetPool({ session });
        }
    });
    const first = await createEngineRunner({
        engine: 'stateMachine',
        client: attachedRun.client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    }).run(runArgs({ attempt: null }));

    assert.equal(first.status, 'completed');
    assert.equal(childView?.maxTotalTokens, 40, 'the child ledger follows its own withBudget');
    assert.equal(childView?.shared, false, 'the child owns that cap');
    assert.equal(attempt?.maxTotalTokens, null, 'the attempt ledger stays cap-less');
    assert.equal(attempt?.maxBudgetUsd, null);

    // A session budgeted AFTER it joined gets its own capped ledger under the
    // attempt: the cap bounds the subtree and the spend folds in once.
    /** @type {any} */
    let borrowedView = null;
    /** @type {any} */
    let borrowedOwn = null;
    /** @type {any} */
    let borrowedAttempt = null;
    const bareRun = createScriptedClient({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        decorate: (session) => {
            const run = session.run.bind(session);
            session.run = async (/** @type {any} */ args) => {
                session.withBudget({ budget: { maxTotalTokens: 40 } });
                borrowedView = getBudgetPool({ session });
                borrowedOwn = session._budgetPool;
                borrowedAttempt = getPoolParent({ pool: session._budgetPool });
                return run(args);
            };
        }
    });
    await createEngineRunner({
        engine: 'stateMachine',
        client: bareRun.client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    }).run(runArgs({ attempt: null }));

    assert.equal(borrowedView?.shared, false, 'the session now owns a capped ledger');
    assert.equal(borrowedView?.maxTotalTokens, 40, 'and its budget is preserved');
    assert.equal(borrowedAttempt?.maxTotalTokens, null, 'the attempt ledger stays cap-less');
    assert.equal(borrowedAttempt?.maxBudgetUsd, null);
    assert.equal(getPoolParent({ pool: borrowedOwn }), null, 'release unlinks the child ledger');
    assert.equal(borrowedOwn?.usage.total_tokens, 15, 'the child ledger keeps its own usage');
});

test('a DAG step budget applied after joining bounds its delegated grandchild', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit(/** @type {string} */ name, /** @type {any} */ payload) { return emitter.emit(name, payload); } });
    /** @type {any} */
    let attempt = null;
    /** @type {any} */
    let delegatedError = null;
    /** @param {string} model */
    client.session = (model) => {
        const session = /** @type {any} */ (new OaiChatSession({ client, model, eventEmitter: emitter }));
        session.client = client;
        session.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
            const restate = messages.some((row) => isObjectiveRestatePrompt({ input: String(row?.content ?? '') }));
            if (restate) {
                return { done: true, content: 'OBJECTIVE', messages: [...messages, { role: 'assistant', content: 'OBJECTIVE' }] };
            }
            if (model === 'child-model') {
                yield { type: 'quota', data: { prompt_tokens: 50, completion_tokens: 0 } };
                return { done: true, content: 'CHILD', messages: [...messages, { role: 'assistant', content: 'CHILD' }] };
            }
            attempt ??= session._budgetPool;
            session.withBudget({ budget: { maxTotalTokens: 10 } });
            try {
                await runTaskChild({
                    session,
                    profile: /** @type {any} */ ({
                        name: 'worker',
                        model: 'child-model',
                        execute: async (/** @type {{client: any}} */ { client: execClient }) => {
                            await execClient.session('child-model').run({ initialInput: 'go' });
                            return 'CHILD';
                        }
                    }),
                    args: { description: 'x', prompt: 'do', subagent_type: 'worker' },
                    signal: undefined,
                    eventEmitter: emitter
                });
            } catch (error) {
                delegatedError = error;
                throw error;
            }
            return { done: true, content: 'FINAL', messages: [...messages, { role: 'assistant', content: 'FINAL' }] };
        };
        return session;
    };
    const result = await createEngineRunner({
        engine: 'dag', client, model: 'm', budget: { maxTotalTokens: 1_000 }, planFor: dagPlan(1)
    }).run(runArgs({ attempt: null }));

    assert.equal(result.status, 'failed', 'the grandchild spend stops the unit');
    assert.ok(delegatedError instanceof BudgetExceededError, 'the typed budget error surfaces');
    assert.equal(delegatedError.maxTotalTokens, 10, 'the unit cap is the one that fired');
    assert.equal(/** @type {any} */ (delegatedError).usage.total_tokens, 50, 'the grandchild spend is in the typed error');
    assert.equal(attempt?.maxTotalTokens, null, 'the attempt ledger stays cap-less');
    assert.equal(attempt?.maxBudgetUsd, null);
    assert.equal(attempt.usage.prompt_tokens, 50, 'the reported grandchild spend is on the attempt ledger once');
    assert.equal(
        /** @type {Record<string, number>} */ (result.usage).total_tokens,
        attempt.usage.total_tokens,
        'the attempt reports the ledger growth'
    );
});

test('a DAG step cap folds an LLM child spend once, not twice', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit(/** @type {string} */ name, /** @type {any} */ payload) { return emitter.emit(name, payload); } });
    /** @type {any} */
    let attempt = null;
    /** @type {any} */
    let delegatedError = null;
    let childRuns = 0;
    /** @param {string} model */
    client.session = (model) => {
        const session = /** @type {any} */ (new OaiChatSession({ client, model, eventEmitter: emitter }));
        session.client = client;
        if (model === 'm') {
            // The realistic builder order: budget applied after attach, before run.
            const run = session.run.bind(session);
            session.run = async (/** @type {any} */ args) => {
                attempt ??= session._budgetPool;
                session._taskMaxDepth = 2;
                session.withBudget({ budget: { maxTotalTokens: 10 } });
                return run(args);
            };
        }
        session.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
            if (model === 'grandchild-model') {
                yield { type: 'quota', data: { prompt_tokens: 50, completion_tokens: 0 } };
                return { done: true, content: 'GRANDCHILD', messages: [...messages, { role: 'assistant', content: 'GRANDCHILD' }] };
            }
            if (model === 'child-model') {
                childRuns += 1;
                // Two calls: the grandchild's and the child's own, 50 each.
                await runTaskChild({
                    session,
                    profile: /** @type {any} */ ({ name: 'grand', model: 'grandchild-model', budget: { maxTotalTokens: 50 } }),
                    args: { description: 'x', prompt: 'do', subagent_type: 'grand' },
                    signal: undefined,
                    eventEmitter: emitter
                });
                yield { type: 'quota', data: { prompt_tokens: 50, completion_tokens: 0 } };
                return { done: true, content: 'CHILD', messages: [...messages, { role: 'assistant', content: 'CHILD' }] };
            }
            try {
                await runTaskChild({
                    session,
                    profile: /** @type {any} */ ({ name: 'worker', model: 'child-model' }),
                    args: { description: 'x', prompt: 'do', subagent_type: 'worker' },
                    signal: undefined,
                    eventEmitter: emitter
                });
            } catch (error) {
                delegatedError = error;
                throw error;
            }
            return { done: true, content: 'FINAL', messages: [...messages, { role: 'assistant', content: 'FINAL' }] };
        };
        return session;
    };
    const result = await createEngineRunner({
        engine: 'dag', client, model: 'm', budget: { maxTotalTokens: 1_000 },
        planFor: async () => ({ context: {}, steps: [ONE_STEP] })
    }).run(runArgs({ attempt: null }));

    const typed = /** @type {any} */ (delegatedError);
    assert.equal(result.status, 'failed', 'the child cap stops the step');
    assert.ok(typed instanceof BudgetExceededError, 'the LLM child error stays typed');
    assert.equal(typed.maxTotalTokens, 10, 'the step cap is the one that fired');
    assert.equal(/** @type {any} */ (typed).usage.prompt_tokens, 50, 'the spend the failing session actually made is in the typed usage');
    assert.equal(/Token budget exceeded: 50 > 10/.test(typed.message), true, 'the failure detail names the cap');
    // B-1: the step cap binds the grandchild's call too, so the grandchild's call
    // is the only one made (the child's own call never starts). Each call is
    // still counted exactly once: 50, never 100 for a single call.
    assert.equal(attempt.usage.prompt_tokens, 50, 'the attempt reports each model call once, not 200');
    assert.equal(childRuns, 1, 'the child ran once; the cap stopped its nested call before the sibling call');
    assert.equal(
        /** @type {Record<string, number>} */ (result.usage).total_tokens,
        attempt.usage.total_tokens,
        'the attempt reports the ledger growth'
    );
});

test('a wider grandchild budget cannot escape a task child cap', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit(/** @type {string} */ name, /** @type {any} */ payload) { return emitter.emit(name, payload); } });
    const attempt = createBudgetPool();
    /** @param {string} model */
    client.session = (model) => {
        const session = /** @type {any} */ (new OaiChatSession({ client, model, eventEmitter: emitter }));
        session.client = client;
        session.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
            if (model === 'grandchild-model') {
                yield { type: 'quota', data: { prompt_tokens: 50, completion_tokens: 0 } };
                return { done: true, content: 'GRANDCHILD', messages: [...messages, { role: 'assistant', content: 'GRANDCHILD' }] };
            }
            await runTaskChild({
                session,
                profile: /** @type {any} */ ({ name: 'grand', model: 'grandchild-model', budget: { maxTotalTokens: 50 } }),
                args: { description: 'x', prompt: 'do', subagent_type: 'grand' },
                signal: undefined,
                eventEmitter: emitter
            });
            return { done: true, content: 'CHILD', messages: [...messages, { role: 'assistant', content: 'CHILD' }] };
        };
        return session;
    };

    const error = await runTaskChild({
        session: /** @type {any} */ ({ client, model: 'm', provider: 'openai', _budgetPool: attempt, _taskMaxDepth: 2 }),
        profile: /** @type {any} */ ({ name: 'worker', model: 'child-model', budget: { maxTotalTokens: 10 } }),
        args: { description: 'x', prompt: 'do', subagent_type: 'worker' },
        signal: undefined,
        eventEmitter: emitter
    }).then(() => null, (/** @type {any} */ err) => err);

    assert.ok(error instanceof BudgetExceededError, 'the child cap still fires');
    assert.equal(error.maxTotalTokens, 10, 'the child cap, not the grandchild budget, is the limit');
    assert.equal(/** @type {any} */ (error).usage.prompt_tokens, 50, 'the grandchild spend is in the typed usage');
    assert.equal(attempt.usage.prompt_tokens, 50, 'the subtree spend folds into the attempt once');
});

test('release: child ledgers keep their usage, attached sessions drop the ledger', { timeout: 5000 }, async () => {
    /** @type {Array<any>} */
    const attempts = [];
    /** @type {Array<any>} */
    const childPools = [];
    const { client, sessions } = createScriptedClient({
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        decorate: (session, index) => {
            // Each attempt creates two node sessions; the first one arrives budgeted.
            if (index % 2 === 0) session._budget = { maxTotalTokens: 100 };
        },
        onStep: (session) => {
            const own = session._budgetPool;
            const parent = getPoolParent({ pool: own });
            if (parent && !attempts.includes(parent)) attempts.push(parent);
            if (parent && !childPools.includes(own)) childPools.push(own);
        }
    });
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => TWO_NODE_GRAPH
    });

    const first = await runner.run(runArgs({ identifier: 'MER-1', attempt: null }));
    assert.equal(/** @type {Record<string, number>} */ (first.usage).total_tokens, 10, 'both nodes charge the attempt');
    assert.equal(childPools[0].usage.total_tokens, 5, 'the child ledger holds its own charge');
    assert.equal(getPoolParent({ pool: childPools[0] }), null, 'release clears the child parent link');
    assert.equal(getBudgetPool({ session: sessions[0] })?.usage.total_tokens, 5, 'a later read still reports the child usage');
    assert.equal(sessions[1]._budgetPool, undefined, 'an attached session is detached');
    assert.equal(attempts[0].children.length, 0, 'the attempt keeps no child list after release');
    assert.equal(attempts[0].attached.length, 0, 'and no session list');

    await runner.run(runArgs({ identifier: 'MER-2', attempt: null }));
    assert.equal(attempts.length, 2, 'each sequential attempt gets its own ledger');
    assert.notEqual(attempts[1], attempts[0]);
    assert.equal(getPoolParent({ pool: childPools[1] }), null, 'the new child ledger is released too');
    assert.equal(childPools[1].usage.total_tokens, 5);
});

test('a memoized budgeted session is re-linked and each attempt reports its own delta', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    const session = /** @type {any} */ (new OaiChatSession({ client, model: 'm', eventEmitter: emitter }));
    session._budget = { maxTotalTokens: 100 };
    session.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
        yield { type: 'quota', data: { prompt_tokens: 3, completion_tokens: 2 } };
        return { done: true, content: 'OUT', messages: [...messages, { role: 'assistant', content: 'OUT' }] };
    };
    client.session = () => session;

    /** @type {Array<any>} */
    const parents = [];
    const step = session.step;
    session.step = async function* parentedStep(/** @type {{messages: Array<Record<string, any>>}} */ args) {
        const parent = getPoolParent({ pool: session._budgetPool });
        if (parent && !parents.includes(parent)) parents.push(parent);
        return yield* step(args);
    };
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    });

    const first = await runner.run(runArgs({ identifier: 'MER-1', attempt: null }));
    const second = await runner.run(runArgs({ identifier: 'MER-2', attempt: null }));

    assert.equal(/** @type {Record<string, number>} */ (first.usage).total_tokens, 5, 'the first attempt reports its delta');
    assert.equal(/** @type {Record<string, number>} */ (second.usage).total_tokens, 5, 'the second attempt reports its own delta, not zero');
    assert.equal(parents.length, 2, 'the reused ledger followed each attempt');
    assert.notEqual(parents[0], parents[1], 'and it was re-linked to the newer one');
    assert.equal(getPoolParent({ pool: session._budgetPool }), null, 'the last release unlinked it');
    assert.equal(getBudgetPool({ session })?.usage.total_tokens, 10, 'the owner ledger stays cumulative and truthful');
});

// ─── A task-profile client that memoizes its child (phase E) ─────────────────
//
// A profile may name its own `client`; when that client memoizes the child
// session, the real task path must attach it to the current attempt ledger, not
// keep the closed ledger of the attempt that created it.

/**
 * A task profile whose child session is memoized: every `memoClient.session()`
 * returns the same session object. The real `runTaskChild` path builds it.
 * @param {{budget?: Record<string, number>|null, gate?: Promise<unknown>|null, continueTurn?: boolean}} [arg0] -
 * @returns {{client: Record<string, any>, child: Record<string, any>, pools: Array<Record<string, any>>}}
 */
function createMemoTaskProfile({ budget = null, gate = null, continueTurn = false } = {}) {
    /** @type {Array<Record<string, any>>} */
    const pools = [];
    /** @type {Record<string, any>} */
    const memoClient = { provider: 'openai', emit() { return false; } };
    const child = /** @type {any} */ (new OaiChatSession({ client: /** @type {any} */ (memoClient), model: 'child-model', eventEmitter: /** @type {any} */ (memoClient) }));
    memoClient.session = () => child;
    if (budget) child._budget = budget;
    child.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
        pools.push(child._budgetPool);
        if (gate) await gate;
        yield { type: 'quota', data: { prompt_tokens: 3, completion_tokens: 2 } };
        return { done: true, content: 'CHILD', messages: [...messages, { role: 'assistant', content: 'CHILD' }] };
    };
    /** @type {Record<string, any>} */
    const client = createModelClient({
        usage: { total_tokens: 99 },
        onRun: async (/** @type {{session: Record<string, any>}} */ { session }) => {
            session.client = client;
            await runTaskChild({
                session: /** @type {any} */ (session),
                profile: { name: 'worker', model: 'child-model', client: /** @type {any} */ (memoClient) },
                args: { description: 'x', prompt: 'do', subagent_type: 'worker' },
                signal: undefined,
                eventEmitter: new EventEmitter()
            });
            if (continueTurn) {
                const record = [...getSpawnRegistry({ client }).spawns.values()].at(-1);
                await continueSpawn({ client: /** @type {any} */ (client), id: /** @type {any} */ (record).id, prompt: 'more' });
            }
            return 'OUT';
        }
    });
    return { client, child, pools };
}

test('task profile: a memoized child is re-linked and each attempt reports its own spend', { timeout: 5000 }, async () => {
    const { client, child, pools } = createMemoTaskProfile();
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    });

    const first = await runner.run(runArgs({ identifier: 'MER-1', attempt: null }));
    assert.equal(/** @type {Record<string, number>} */ (first.usage).total_tokens, 5, 'the first attempt reports the child spend');
    assert.equal(pools.length, 1, 'the delegated child ran once');
    assert.equal(child._budgetPool, undefined, 'the closed ledger detached the memoized child');

    const second = await runner.run(runArgs({ identifier: 'MER-2', attempt: null }));
    assert.equal(/** @type {Record<string, number>} */ (second.usage).total_tokens, 5, 'the second attempt reports its own 5, not zero');
    assert.notEqual(pools[1], pools[0], 'the memoized child was linked to the fresh ledger');
    assert.equal(pools[0].usage.total_tokens, 5, 'the closed ledger never grew');
    assert.equal(child._budgetPool, undefined, 'the last release detached it again');
});

test('task profile: a memoized budgeted child gets a fresh capped ledger each attempt', { timeout: 5000 }, async () => {
    // 10 tokens is a per-spawn cap; three 5-token attempts would exhaust one
    // cumulative thousand-token ledger on the third try.
    const budget = { maxTotalTokens: 10 };
    const { client, child, pools } = createMemoTaskProfile({ budget });
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    });

    for (const identifier of ['MER-1', 'MER-2', 'MER-3']) {
        const result = await runner.run(runArgs({ identifier, attempt: null }));
        assert.equal(result.status, 'completed', `${identifier} completed under its local cap`);
        assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, `${identifier} reports its own 5`);
        assert.equal(child._budgetPool?.maxTotalTokens, 10, `${identifier} keeps the child cap`);
        assert.equal(getPoolParent({ pool: child._budgetPool }), null, `${identifier} release unlinked the borrowed attempt`);
        assert.equal(child._budgetPool?.usage.total_tokens, 5, `${identifier} has no cumulative spend`);
        assert.equal(child._budget, budget, 'the declared budget is unchanged');
    }
    assert.equal(pools.length, 3, 'the child ran once per attempt');
    assert.equal(new Set(pools).size, 3, 'a fresh capped owner ledger each time, not one cumulative pool');
    assert.equal(pools.every((pool) => pool.maxTotalTokens === 10), true, 'every attempt keeps the child cap');
    assert.equal(pools.every((pool) => pool.usage.total_tokens === 5), true, 'each closed child ledger holds only its own 5');
});

test('task profile: two concurrent attempts refuse the live memoized child', { timeout: 5000 }, async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = /** @type {() => void} */ (resolve); });
    const { client } = createMemoTaskProfile({ gate, budget: { maxTotalTokens: 10 } });
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    });

    // The first attempt to attach holds its child at the gate, so the other
    // attempt must hit the live ledger instead of silently sharing it.
    try {
        const results = await Promise.all([
            runner.run(runArgs({ identifier: 'MER-1', attempt: null })),
            runner.run(runArgs({ identifier: 'MER-2', attempt: null }))
        ].map((run) => run.finally(release)));
        const refused = results.filter((result) => result.status === 'failed'
            && /** @type {any} */ (result.error)?.option === 'session_reused_across_attempts');
        const completed = results.filter((result) => result.status === 'completed');
        assert.equal(refused.length, 1, 'one attempt is refused loudly');
        assert.equal(completed.length, 1, 'the other attempt owns the child');
        assert.equal(/** @type {Record<string, number>} */ (completed[0].usage).total_tokens, 5, 'it reports its own 5, not 10 or 0');
        assert.ok(refused[0].error instanceof ConfigurationError, 'the typed configuration error is not wrapped');
        assert.equal(refused[0].error.message.includes('Hint:'), false, 'a configuration error gets no retry hint');
    } finally {
        release();
    }
});

test('task profile: a continued spawn keeps charging the open ledger', { timeout: 5000 }, async () => {
    const { client, pools } = createMemoTaskProfile({ continueTurn: true });
    const result = await createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    }).run(runArgs({ attempt: null }));

    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 10, 'both turns of the spawn charged the attempt');
    assert.equal(new Set(pools).size, 1, 'the continuation reused the open attempt ledger');
});

test('a budgeted session links to the same session pool and refuses a different one', { timeout: 5000 }, () => {
    const poolA = /** @type {any} */ (ensureBudgetPool({ session: { _budget: { maxTotalTokens: 500 } } }));
    const poolB = /** @type {any} */ (ensureBudgetPool({ session: { _budget: { maxTotalTokens: 500 } } }));
    const session = /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } });
    const client = { session: () => session };

    const own = /** @type {any} */ (pooledClient({ client, pool: poolA })).session('m')._budgetPool;
    assert.notEqual(own, poolA, 'the session pool is not written over');
    assert.equal(own.owner, session, 'the session still owns its ledger');
    assert.equal(own.maxTotalTokens, 100, 'the cap stays');
    assert.equal(getPoolParent({ pool: own }), poolA, 'and it links to the session pool');
    assert.equal(poolA.children.includes(own), true, 'the session pool lists it');

    assert.equal(/** @type {any} */ (pooledClient({ client, pool: poolA })).session('m')._budgetPool, own, 'the same pool keeps the same link');
    assert.equal(poolA.children.length, 1, 'registered once');

    assert.throws(
        () => /** @type {any} */ (pooledClient({ client, pool: poolB })).session('m'),
        (error) => error instanceof ConfigurationError && error.option === 'session_reused_across_attempts',
        'a different session pool is refused'
    );
    assert.equal(session._budgetPool, own, 'the refused attach changed nothing');
});

test('a task child already reporting to another live attempt is refused', { timeout: 5000 }, () => {
    const foreign = createBudgetPool();
    const target = createBudgetPool();
    const session = /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } });
    const own = ensureBudgetPool({ session, parent: foreign });

    assert.throws(
        () => attachSessionPool({ session, pool: target, share: true }),
        (error) => error instanceof ConfigurationError && error.option === 'session_reused_across_attempts',
        'switching a live subtree to another attempt is refused'
    );
    assert.equal(session._budgetPool, own, 'the owner pool is untouched');
    assert.equal(getPoolParent({ pool: own }), foreign, 'and it still reports to its own attempt');
});

test('a released ledger a host left on a session is replaced', { timeout: 5000 }, () => {
    const closed = createBudgetPool();
    releaseAttemptLedger({ pool: closed });
    const open = createBudgetPool();
    const session = /** @type {any} */ ({ _budgetPool: closed });

    attachSessionPool({ session, pool: open });
    assert.equal(session._budgetPool, open, 'the stale closed ledger is gone');
    assert.equal(open.attached.length, 1, 'the session joined the open ledger');
});

test('attachSessionPool registers a repeated attach once', { timeout: 5000 }, () => {
    const ledger = createBudgetPool();
    const session = /** @type {any} */ ({});
    attachSessionPool({ session, pool: ledger, share: true });
    attachSessionPool({ session, pool: ledger, share: true });
    assert.equal(ledger.attached.length, 1, 'the session is listed once');
    assert.equal(session._budgetPool, ledger);
});

test('a getBudgetPool read before the attempt does not prevent folding', { timeout: 5000 }, async () => {
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    const session = /** @type {any} */ (new OaiChatSession({ client, model: 'm', eventEmitter: emitter }));
    session._budget = { maxTotalTokens: 100 };
    session.step = async function* step(/** @type {{messages: Array<Record<string, any>>}} */ { messages }) {
        yield { type: 'quota', data: { prompt_tokens: 3, completion_tokens: 2 } };
        return { done: true, content: 'OUT', messages: [...messages, { role: 'assistant', content: 'OUT' }] };
    };
    client.session = () => session;

    const early = getBudgetPool({ session });
    assert.equal(early?.shared, false, 'the pre-run read created the owner ledger');
    assert.equal(early?.maxTotalTokens, 100);

    const result = await createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => ONE_NODE_GRAPH
    }).run(runArgs({ attempt: null }));

    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, 'the eager pool still folds');
    assert.equal(getBudgetPool({ session })?.usage.total_tokens, 5);
});

test('a host-shaped attempt ledger works through the budgetPool option', { timeout: 5000 }, async () => {
    const base = createAttemptClient();
    /** @type {any} */ (base.client).provider = 'openai';
    withTaskAgents({ client: base.client, agents: [{ name: 'worker', model: 'm', provider: 'openai' }] });
    // A plain ledger: no `attached`/`children` lists, exactly what a host may pass.
    const ledger = /** @type {any} */ ({
        maxTotalTokens: null,
        maxBudgetUsd: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: null, estimated_tokens: 0 }
    });
    const group = new DiscussionSession({
        client: /** @type {any} */ (pooledClient({ client: base.client, pool: ledger })),
        options: { budget: { maxTotalTokens: 100 }, budgetPool: ledger }
    });
    group.addAgent({ name: 'A', model: 'm', provider: 'openai' });

    await group.runTasks({ tasks: [{ title: 't', subagent_type: 'worker', description: 'do' }], sequential: true });
    assert.equal(ledger.usage.total_tokens, 5, 'the task subtree folds into the plain ledger');

    await group.discuss({ instruction: 'x', turns: 1, sequential: true });
    assert.equal(ledger.usage.total_tokens, 10, 'the turn charges it too');
    assert.equal(ledger.attached.length, 1, 'the missing session list was created lazily');
    assert.equal(ledger.children.length, 1, 'and the missing child list');

    releaseAttemptLedger({ pool: ledger });
    assert.equal(ledger.attached.length, 0);
    assert.equal(ledger.children.length, 0);
});

test('an old ledger release does not unlink a re-attached child', () => {
    const older = createBudgetPool();
    const newer = createBudgetPool();
    /** @type {Record<string, any>} */
    const session = { _budget: { maxTotalTokens: 100 } };
    const child = /** @type {any} */ (ensureBudgetPool({ session, parent: older }));
    assert.equal(getPoolParent({ pool: child }), older);

    // The same owner ledger is re-linked to a newer attempt (the sequential reuse
    // path registers it there too); an out-of-order release of the older ledger
    // must not steal it back.
    setPoolParent({ pool: child, parent: newer });
    newer.children.push(child);
    assert.equal(getPoolParent({ pool: child }), newer);

    releaseAttemptLedger({ pool: older });
    assert.equal(getPoolParent({ pool: child }), newer, 'the older release leaves a re-linked child alone');

    releaseAttemptLedger({ pool: newer });
    assert.equal(getPoolParent({ pool: child }), null);
});

/**
 * A model client whose charging sessions are the listed models only, so the
 * attempt's own step or judge sessions stay silent. `verdict` makes every run
 * answer as a judge, so a discussion concludes on the first round.
 * @param {{charging?: string[], verdict?: boolean}} [arg0] -
 */
function createCodeAgentClient({ charging = ['child-model'], verdict = false } = {}) {
    return createModelClient({
        onRun: ({ session }) => {
            if (charging.includes(session.model) && session._budgetPool) {
                absorbPoolUsage({ pool: session._budgetPool, usage: ATTEMPT_CHARGE });
            }
            return verdict
                ? JSON.stringify({ passed: true, score: 90, reason: 'verdict', revision: 'minor' })
                : 'OUT';
        }
    });
}

/** One DAG step any plan can return.
 * @type {Record<string, unknown>}
 */
const ONE_STEP = { id: 'only', title: 'Only', systemPrompt: 'S', userPromptTemplate: 'GO' };

test('planFor spending through the provided client is inside the attempt snapshot', { timeout: 5000 }, async () => {
    // The plan hook's own call is inside the delta; a planned step adds its spend
    // (and the DAG path may add a first-step objective restatement).
    const charge = (/** @type {{args: Record<string, any>|undefined}} */ { args }) => !isObjectiveRestatePrompt({ input: args?.initialInput });
    const { client } = createAttemptClient({ charge });
    /** @type {Record<string, any>} */
    const seen = {};
    /** @type {Array<string>} */
    let keys = [];
    const run = (/** @type {Array<Record<string, unknown>>} */ steps) => createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: async (/** @type {Record<string, any>} */ bag) => {
            keys = Object.keys(bag).sort();
            seen.client = bag.client;
            seen.pool = bag.budgetPool;
            await bag.client.session('m').run();
            seen.afterHook = bag.budgetPool.usage.total_tokens;
            return { objective: 'ship', context: {}, steps };
        }
    }).run(runArgs({ attempt: null }));

    const oneStep = await run([ONE_STEP]);
    assert.equal(typeof seen.client?.session, 'function', 'planFor is given the engine client');
    assert.deepEqual(keys, ['attempt', 'budgetPool', 'client', 'item', 'runContext', 'signal'], 'planFor gets the plan bag');
    assert.equal(seen.afterHook, 5, 'the plan hook call is inside the attempt delta');
    assert.equal(
        /** @type {Record<string, number>} */ (oneStep.usage).total_tokens >= 10,
        true,
        'the step spend is added; the total is not fixed because a first-step restatement may add more'
    );

    const zeroStep = await run([]);
    assert.equal(/** @type {Record<string, number>} */ (zeroStep.usage).total_tokens, 5, 'a zero-step plan reports the hook spend alone');
});

test('a hook gets a frozen budgetPool view, not the live ledger', { timeout: 5000 }, async () => {
    const { client } = createAttemptClient({ charge: ({ session }) => session.model === 'factory-model' });
    /** @type {any} */
    let view = null;
    const result = await createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: dagPlan(1),
        tools: async (/** @type {{client: any, budgetPool: any}} */ { client: factoryClient, budgetPool }) => {
            view = budgetPool;
            await factoryClient.session('factory-model').run();
            return [];
        }
    }).run(runArgs({ attempt: null }));

    assert.ok(view, 'the hook is given a ledger handle');
    assert.equal(Object.isFrozen(view), true, 'the handle itself is frozen');
    assert.equal(Object.isFrozen(view.usage), true, 'the usage snapshot is frozen');
    assert.throws(() => { view.usage.total_tokens = 500; }, TypeError, 'a write to the usage snapshot throws');
    assert.throws(() => { view.maxTotalTokens = 1; }, TypeError, 'the caps have no setters');
    assert.equal(view.maxTotalTokens, null, 'the attempt ledger stays cap-less');
    assert.equal(view.maxBudgetUsd, null);
    assert.equal(view.usage.total_tokens, 5, 'a read returns the current usage');
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, 'the failed write did not change the attempt');
});

test('graphFor spending then throwing reports the spend and fails', { timeout: 5000 }, async () => {
    const { client, charged } = createAttemptClient();
    /** @type {any} */
    let seen = null;
    const result = await createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: async (/** @type {{client: any, budgetPool: any}} */ bag) => {
            seen = bag;
            await bag.client.session('m').run();
            throw new Error('graph blew up');
        }
    }).run(runArgs({ attempt: null }));

    const hookClient = /** @type {any} */ (seen?.client);
    assert.equal(typeof hookClient?.session, 'function', 'graphFor is given the engine client');
    assert.ok(seen?.budgetPool, 'graphFor is given the attempt ledger');
    assert.equal(charged.count, 1);
    assert.equal(result.status, 'failed');
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, 'the hook spend is still reported');
});

test('graphFor: a thenable graph passes through, a promise graph is awaited', { timeout: 5000 }, async () => {
    /** @type {Record<string, any>} */
    const thenable = {
        entry: 'only',
        nodes: [{ id: 'only', model: 'm', userPromptTemplate: 'GO', terminal: true }],
        edges: [],
        // A `then` transition verb, not a thenable continuation: awaiting it hangs.
        then: () => thenable
    };
    const thenableClient = createModelClient();
    const passed = await createEngineRunner({
        engine: 'stateMachine', client: thenableClient, model: 'm', graphFor: () => thenable
    }).run(runArgs({ attempt: null }));
    assert.equal(passed.status, 'completed', 'a thenable graph is not awaited');
    assert.equal(thenableClient.sessions.length, 1, 'its one node ran');

    const promiseClient = createModelClient();
    const awaited = await createEngineRunner({
        engine: 'stateMachine', client: promiseClient, model: 'm', graphFor: () => Promise.resolve(TWO_NODE_GRAPH)
    }).run(runArgs({ attempt: null }));
    assert.equal(awaited.status, 'completed', 'a promise graph is awaited');
    assert.equal(promiseClient.sessions.length, 2, 'both nodes of the awaited graph ran');
});

test('an async tools factory is awaited, bound, and its spend counted', { timeout: 5000 }, async () => {
    const base = createAttemptClient({ charge: ({ session }) => session.model === 'factory-model' });
    /** @type {Array<any>} */
    const boundTools = [];
    const client = {
        /** @param {string} model */
        session(model) {
            const session = base.client.session(model);
            session.withTools = (/** @type {any} */ args) => {
                boundTools.push(args?.tools ?? args);
                return session;
            };
            return session;
        }
    };
    const tool = { name: 'async_tool', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' };
    /** @type {Record<string, any>} */
    const seen = {};
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: dagPlan(1),
        tools: async (/** @type {{client: any, budgetPool: any}} */ { client: factoryClient, budgetPool }) => {
            seen.client = factoryClient;
            seen.pool = budgetPool;
            await factoryClient.session('factory-model').run();
            seen.afterCharge = budgetPool.usage.total_tokens;
            return [tool];
        }
    });
    const result = await runner.run(runArgs({ attempt: null }));

    assert.equal(typeof seen.client?.session, 'function', 'the tools factory is given the engine client');
    assert.equal(seen.afterCharge, 5, 'the factory spend is inside the attempt delta');
    assert.equal(
        seen.pool.usage.total_tokens,
        /** @type {Record<string, number>} */ (result.usage).total_tokens,
        'the hook spend is part of the attempt total'
    );
    assert.equal(
        boundTools.some((list) => Array.isArray(list) && list.some((entry) => entry?.name === 'async_tool')),
        true,
        'the awaited tools are bound to the steps'
    );

    // A sync factory is used as-is, with no await or copy.
    const syncRunner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: dagPlan(1),
        tools: () => [tool]
    });
    const syncResult = await syncRunner.run(runArgs({ identifier: 'MER-2', attempt: null }));
    assert.equal(syncResult.status, 'completed');
    assert.equal(
        boundTools.some((list) => Array.isArray(list) && list.some((entry) => entry?.name === 'async_tool')),
        true,
        'a sync factory array is still bound unchanged'
    );
});

test('a tools factory that throws after spending fails with its spend and leaks nothing', { timeout: 5000 }, async () => {
    const { client, charged } = createAttemptClient();
    /** @type {Record<string, any>} */
    const seen = {};
    const result = await createEngineRunner({
        engine: 'stateMachine',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        graphFor: () => TWO_NODE_GRAPH,
        tools: async (/** @type {{client: any, budgetPool: any}} */ { client: factoryClient, budgetPool }) => {
            seen.pool = budgetPool;
            seen.session = factoryClient.session('m');
            await seen.session.run();
            throw new Error('tools failed');
        }
    }).run(runArgs({ attempt: null }));

    assert.equal(charged.count, 1, 'the factory session ran');
    assert.equal(result.status, 'failed');
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, 'the factory spend is reported');
    assert.equal(seen.session._budgetPool, undefined, 'the attached session was detached');
    assert.equal(Object.isFrozen(seen.pool), true, 'the hook handle is read-only');
});

test('a client a hook kept cannot re-attach a released ledger', { timeout: 5000 }, async () => {
    // A memoizing client is the case the stale view used to poison: the same
    // session object would keep the closed ledger and refuse the next attempt.
    const base = createModelClient({
        onRun: ({ session }) => {
            if (session._budgetPool) absorbPoolUsage({ pool: session._budgetPool, usage: ATTEMPT_CHARGE });
            return 'OUT';
        }
    });
    /** @type {any} */
    let memo = null;
    const client = {
        getProfiles: base.getProfiles,
        /** @param {string} model */
        session(model) {
            memo ??= base.session(model);
            return memo;
        }
    };
    /** @type {Record<string, any>} */
    const seen = {};
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: async (/** @type {Record<string, any>} */ bag) => {
            seen.client = bag.client;
            seen.pool = bag.budgetPool;
            return { objective: 'ship', context: {}, steps: [ONE_STEP] };
        }
    });

    const first = await runner.run(runArgs({ identifier: 'MER-1', attempt: null }));
    assert.equal(first.status, 'completed');
    const spent = seen.pool.usage.total_tokens;
    assert.equal(spent > 0, true, 'the first attempt charged its ledger');
    assert.equal(memo?._budgetPool, undefined, 'the attempt detached its session');

    // The host uses the client it kept after the attempt ended.
    const late = seen.client.session('m');
    assert.equal(late._budgetPool, undefined, 'a released ledger is not re-attached');
    await late.run();
    assert.equal(seen.pool.usage.total_tokens, spent, 'the closed ledger takes no charge');

    const second = await runner.run(runArgs({ identifier: 'MER-2', attempt: null }));
    assert.equal(second.status, 'completed', 'the next attempt is not refused as a reused session');
    assert.equal(/** @type {Record<string, number>} */ (second.usage).total_tokens, spent, 'it reports its own delta');
});

test('a DAG code agent charges the attempt through the client it is given', { timeout: 5000 }, async () => {
    const client = createCodeAgentClient();
    const emitter = new EventEmitter();
    /** @type {any} */
    let created = null;
    withTaskAgents({ client, agents: [{
        name: 'coder',
        model: 'child-model',
        execute: async (/** @type {{client: any, budgetPool: any}} */ { client: execClient, budgetPool }) => {
            assert.equal(typeof execClient?.session, 'function', 'execute is given a client');
            assert.ok(budgetPool, 'execute is given a ledger view');
            assert.throws(() => { budgetPool.usage.total_tokens = 500; }, TypeError, 'the view refuses a write');
            created = execClient.session('child-model');
            await created.run();
            assert.equal(budgetPool.usage.total_tokens, 5, 'the write changed nothing');
            return 'ok';
        }
    }] });
    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        budget: { maxTotalTokens: 1_000 },
        planFor: async (/** @type {{client: any}} */ { client: planClient }) => {
            // The parent session the hook builds joins the attempt ledger itself;
            // the hook handle is a read-only view and cannot be used as a pool.
            const parent = planClient.session('m');
            parent.client = planClient;
            await runTaskChild({
                session: /** @type {any} */ (parent),
                profile: /** @type {any} */ (getSpawnRegistry({ client }).agents.get('coder')),
                args: { description: 'code', prompt: 'do it', subagent_type: 'coder' },
                signal: undefined,
                eventEmitter: emitter
            });
            return { objective: 'ship', context: {}, steps: [ONE_STEP] };
        }
    });

    const first = await runner.run(runArgs({ identifier: 'MER-1', attempt: null }));
    assert.equal(first.status, 'completed');
    assert.equal(/** @type {Record<string, number>} */ (first.usage).total_tokens, 5, 'the execute body spend is reported');
    assert.equal(created?._budgetPool, undefined, 'the execute session is detached after the attempt');

    const second = await runner.run(runArgs({ identifier: 'MER-2', attempt: null }));
    assert.equal(/** @type {Record<string, number>} */ (second.usage).total_tokens, 5, 'a second attempt reports its own spend');
});

test('a code agent detaches the sessions its execute opens', { timeout: 5000 }, async () => {
    // No scheduler here: only the code agent's own release can detach these.
    const { client } = createAttemptClient();
    const base = /** @type {any} */ (client);
    base.sessionWithId = (/** @type {{model: string}} */ args) => base.session(args.model);
    const emitter = new EventEmitter();
    const pool = createBudgetPool();
    /** @type {Record<string, any>} */
    const opened = {};
    /** @type {any} */
    const parent = { client, model: 'm', provider: 'openai', _budgetPool: pool };
    withTaskAgents({ client, agents: [{
        name: 'coder',
        model: 'child-model',
        execute: async (/** @type {Record<string, any>} */ bag) => {
            assert.equal(bag.session, parent, 'execute gets the parent session object');
            assert.notEqual(bag.budgetPool, pool, 'execute gets a view, not the live ledger');
            assert.equal(bag.budgetPool.maxTotalTokens, null, 'the view reads the attempt caps');
            assert.throws(() => { bag.budgetPool.usage.total_tokens = 500; }, TypeError, 'the view refuses a write');
            opened.byModel = bag.client.session('child-model');
            opened.byId = bag.client.sessionWithId({ model: 'child-model' });
            await opened.byModel.run();
            await opened.byId.run();
            assert.equal(bag.budgetPool.usage.total_tokens, 10, 'a read still reflects the live usage');
            return 'ok';
        }
    }] });

    const result = await runTaskChild({
        session: parent,
        profile: /** @type {any} */ (getSpawnRegistry({ client }).agents.get('coder')),
        args: { description: 'code', prompt: 'do it', subagent_type: 'coder' },
        signal: undefined,
        eventEmitter: emitter
    });

    assert.equal(result, 'ok');
    assert.equal(opened.byModel._budgetPool, undefined, 'the execute session is detached');
    assert.equal(opened.byId._budgetPool, undefined, 'a sessionWithId session is detached too');
    assert.equal(pool.attached.length, 0, 'the pool retains neither');
    assert.equal(pool.usage.total_tokens, 10, 'both calls charged the ledger while they ran');
    assert.equal(parent._budgetPool, pool, 'the parent keeps the ledger');
});

test('a discussion execute charges the attempt through the client it is given', { timeout: 5000 }, async () => {
    const client = createCodeAgentClient({ verdict: true });
    /** @type {any} */
    let created = null;
    const result = await createEngineRunner({
        engine: 'discussion',
        client,
        model: 'm',
        objective: 'ship',
        budget: { maxTotalTokens: 1_000 },
        agents: [{ name: 'A', execute: async (/** @type {{client: any, budgetPool: any}} */ { client: execClient, budgetPool }) => {
            assert.equal(typeof execClient?.session, 'function', 'execute is given a client');
            assert.ok(budgetPool, 'execute is given a ledger view');
            assert.throws(() => { budgetPool.usage.total_tokens = 500; }, TypeError, 'the view refuses a write');
            created = execClient.session('child-model');
            await created.run();
            assert.equal(budgetPool.usage.total_tokens, 5, 'the write changed nothing and the spend is reported');
            return 'a reasoned answer';
        } }]
    }).run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5);
    assert.equal(created?._budgetPool, undefined, 'the execute session is detached after the attempt');
});

test('an async agents factory is awaited, bound, and its spend reported', { timeout: 5000 }, async () => {
    // Only the factory's own call charges; the judge stays silent.
    const client = createModelClient({
        usage: { total_tokens: 99 },
        onRun: ({ session }) => {
            if (session.model === 'factory-model') {
                if (session._budgetPool) absorbPoolUsage({ pool: session._budgetPool, usage: ATTEMPT_CHARGE });
                return 'OUT';
            }
            return JSON.stringify({ passed: true, score: 90, reason: 'verdict', revision: 'minor' });
        }
    });
    /** @type {Record<string, any>} */
    const seen = {};
    let agentRan = false;
    const result = await createEngineRunner({
        engine: 'discussion',
        client,
        model: 'm',
        objective: 'ship',
        budget: { maxTotalTokens: 1_000 },
        agents: async (/** @type {Record<string, any>} */ bag) => {
            seen.keys = Object.keys(bag).sort();
            seen.workspace = bag.workspace;
            seen.attempt = bag.attempt;
            seen.identifier = bag.item?.identifier;
            Object.assign(seen, { client: bag.client, pool: bag.budgetPool });
            await bag.client.session('factory-model').run();
            seen.afterCharge = bag.budgetPool.usage.total_tokens;
            return [{ name: 'A', execute: async () => { agentRan = true; return 'a reasoned answer'; } }];
        }
    }).run(runArgs({ attempt: null }));

    assert.equal(result.status, 'completed');
    assert.deepEqual(seen.keys, ['attempt', 'budgetPool', 'client', 'item', 'runContext', 'workspace'], 'agents gets the option bag');
    assert.equal(typeof seen.client?.session, 'function', 'the factory is given the engine client');
    assert.equal(seen.afterCharge, 5, 'the factory spend is inside the attempt delta');
    assert.equal(seen.attempt, null);
    assert.equal(seen.identifier, 'MER-1');
    assert.equal(seen.workspace, null);
    assert.equal(agentRan, true, 'the awaited agent is bound and runs');
    assert.equal(/** @type {Record<string, number>} */ (result.usage).total_tokens, 5, 'the attempt reports exactly the factory spend');
});

test('agentic keeps the raw client, and a hook that ignores the new keys is unchanged', { timeout: 5000 }, async () => {
    const raw = createAgenticClient();
    /** @type {Array<boolean>} */
    const identity = [];
    const client = {
        /** @param {string} model */
        session(model) {
            identity.push(this === client);
            return raw.session(model);
        }
    };
    const result = await createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        prompt: 'go',
        budget: { maxTotalTokens: 1_000 },
        tools: (/** @type {{item: any, attempt: any, workspace: any}} */ { item, attempt, workspace }) => [{ name: `${item.identifier}:${attempt}:${workspace === null}` }]
    }).run(runArgs({ attempt: 1 }));

    assert.equal(result.status, 'completed');
    assert.deepEqual(identity, [true], 'the agentic engine calls the raw client, never a view');
    assert.deepEqual(raw.sessions[0].tools, [{ name: 'MER-1:1:true' }], 'an ignoring tools factory still supplies tools');
    assert.equal(raw.sessions[0]._budgetPool.owner, raw.sessions[0], 'the agentic session owns its own pool');
});

// ─── The completion gate and the implicit terminal (F2-1, D-4) ───────────────

test('F2-1: a state-machine attempt whose completion gate fails is failed, not completed', { timeout: 5000 }, async () => {
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        graphFor: () => ONE_NODE_GRAPH,
        contract: { criteria: [{ name: 'c', check: async () => ({ passed: false, evidence: 'no' }) }] }
    });

    const result = await runner.run(runArgs({ attempt: null }));

    assert.equal(result.status, 'failed', 'a failed gate is a failed attempt');
    assert.ok(result.error, 'and it carries the failure reason');
    assert.equal(result.progress, true);
});

test('createEngineRunner refuses an unknown option key instead of dropping it', () => {
    assert.throws(
        () => createEngineRunner(
            /** @type {any} */ ({ engine: 'agentic', client: createAgenticClient(), model: 'm', prompt: 'go', contractt: {} })
        ),
        (error) => error instanceof ConfigurationError
            && error.option === 'unknown_option'
            && /contractt/.test(error.message),
        'an unknown key is named in a ConfigurationError'
    );
});

test('D-4: an implicit terminal is named on DONE and warns through the run emitter', { timeout: 5000 }, async () => {
    /** @type {Array<Record<string, any>>} */
    const done = [];
    const graph = {
        entry: 'only',
        nodes: [{
            id: 'only',
            execute: async (/** @type {unknown} */ _ctx, /** @type {{machine: any}} */ { machine }) => {
                machine.on(EVENTS.STATE_MACHINE.DONE, (/** @type {Record<string, any>} */ event) => done.push(event));
                return 'ok';
            }
        }],
        edges: []
    };
    /** @type {Array<Record<string, any>>} */
    const events = [];
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        onEvent: (event) => { events.push(/** @type {Record<string, any>} */ (event)); },
        graphFor: () => graph
    });

    const result = await runner.run(runArgs({ attempt: null }));

    // D-4: the machine's own DONE contract is unchanged, but the scheduler now
    // refuses to call a dead end a completion.
    assert.equal(result.status, 'failed', 'an implicit terminal is a dead end, not a completed goal');
    assert.match(String(/** @type {any} */ (result.error)?.message), /dead end at node "only"/);
    assert.equal(done.length, 1, 'the machine emitted its completion');
    assert.equal(done[0].implicitTerminal, 'only', 'DONE names the node that ended the run implicitly');
    const warnings = events.filter((event) => event.event === EVENTS.CLIENT.WARNING);
    assert.equal(warnings.length, 1, 'exactly one warning reaches the host');
    assert.equal(warnings[0].code, 'IMPLICIT_TERMINAL');
    assert.match(String(warnings[0].message), /only/);
});

// ─── W2C-2: what a retry resumes ─────────────────────────────────────────────

test('W2C-2: a failed completion gate resumes the node and fails again without "Unknown node"', { timeout: 5000 }, async () => {
    const store = createStore();
    let nodeRuns = 0;
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store,
        graphFor: () => ({
            entry: 'only',
            nodes: [{ id: 'only', execute: async () => { nodeRuns += 1; return 'ok'; }, terminal: true }],
            edges: []
        }),
        contract: { criteria: [{ name: 'c', check: async () => ({ passed: false, evidence: 'no' }) }] }
    });

    const first = await runner.run(runArgs({ attempt: 1 }));
    assert.equal(first.status, 'failed', 'the gate fails the first attempt');

    const second = await runner.run(runArgs({ attempt: 2 }));
    assert.equal(second.status, 'failed', 'the gate fails the retry too');
    assert.equal(nodeRuns, 2, 'the retry re-ran the node');
    assert.doesNotMatch(String(/** @type {Error} */ (second.error).message), /Unknown node/, 'the saved null current is not stepped');
    assert.match(String(/** @type {Error} */ (second.error).message), /phase: failed/);
});

test('W2C-2: resuming a DONE checkpoint returns completed without re-running', { timeout: 5000 }, async () => {
    const store = createStore();
    let nodeRuns = 0;
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store,
        graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => { nodeRuns += 1; return 'ok'; }, terminal: true }], edges: [] })
    });

    assert.equal((await runner.run(runArgs({ attempt: 1 }))).status, 'completed');
    assert.equal(nodeRuns, 1);
    const savesBefore = savesOf(store.calls).length;

    const resumed = await runner.run(runArgs({ attempt: 2 }));
    assert.equal(resumed.status, 'completed', 'a finished checkpoint is the answer');
    assert.equal(nodeRuns, 1, 'the terminal node did not run again');
    assert.equal(savesOf(store.calls).length, savesBefore, 'a done checkpoint is not rewritten');
});

test('W2C-3: a corrupt checkpoint fails the attempt and does not replay the completed node', { timeout: 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-w2c3-'));
    try {
        const store = new LocalFileSessionStore({ dir });
        let nodeRuns = 0;
        const runner = createEngineRunner({
            engine: 'stateMachine',
            client: createModelClient(),
            model: 'm',
            store,
            threadId: 'w2c3',
            graphFor: () => ({ entry: 'only', nodes: [{ id: 'only', execute: async () => { nodeRuns += 1; return 'ok'; }, terminal: true }], edges: [] })
        });

        assert.equal((await runner.run(runArgs({ attempt: 1 }))).status, 'completed');
        assert.equal(nodeRuns, 1);
        writeFileSync(join(dir, 'w2c3.json'), '{"checkpoint": {"version": 1, "kind": "stateM', 'utf8');

        const second = await runner.run(runArgs({ attempt: 2 }));
        assert.equal(second.status, 'failed', 'a present-but-unreadable record is an error, not a first attempt');
        assert.equal(/** @type {any} */ (second.error)?.option, 'checkpoint_corrupt');
        assert.equal(nodeRuns, 1, 'the completed node was not replayed');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W2C-6: a foreign-kind checkpoint names the engine switch and the remedy', { timeout: 5000 }, async () => {
    const store = createStore({ 'work:MER-1': wrapCheckpoint({ kind: CHECKPOINT_KIND.CHAT, payload: 'hello' }) });
    const runner = createEngineRunner({
        engine: 'stateMachine',
        client: createModelClient(),
        model: 'm',
        store,
        graphFor: () => ONE_NODE_GRAPH
    });

    const result = await runner.run(runArgs({ attempt: 1 }));

    assert.equal(result.status, 'failed');
    assert.match(
        String(/** @type {Error} */ (result.error).message),
        /kind mismatch: expected 'stateMachine', record is 'chat'; use a fresh thread id/
    );
});

test('W2C-9: contract is refused outside the stateMachine engine', () => {
    const contract = { criteria: [] };
    /** @type {Array<Record<string, unknown>>} */
    const cases = [
        { engine: 'agentic', client: createAgenticClient(), prompt: 'go' },
        { engine: 'dag', client: createModelClient(), planFor: async () => ({ steps: [] }) },
        { engine: 'discussion', client: judgeClient(true), agents: [] }
    ];
    for (const options of cases) {
        assert.throws(
            () => createEngineRunner({ model: 'm', contract, ...options }),
            (error) => error instanceof ConfigurationError
                && error.option === 'contract'
                && error.message.includes(`'${options.engine}'`),
            `${options.engine}: contract is refused and the engine is named`
        );
    }
});
