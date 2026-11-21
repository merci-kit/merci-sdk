// @ts-check
// Phase 4 of the provenance run — the deferred findings that were FIXED. Each test is the named
// check for one fix: it fails on the pre-fix tree (see probe/p4-deferred.probe.mjs for the
// reproduction before/after) and pins the behaviour from here on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { createAcpAgent } from '../lib/agentic/acp-agent.mjs';
import { client as acpClient, methods } from '@agentclientprotocol/sdk/unstable';

/**
 * A minimal client stand-in: announces `session:start` with the id it was built
 * with, and counts every construction.
 * @param {{emitter?: any, answer?: string}} [arg0]
 */
function makeClient({ emitter = null, answer = 'ok' } = {}) {
    /** @type {any[]} */
    const built = [];
    /** @param {string|undefined} id */
    const make = (id) => {
        const session = {
            provider: 'openai',
            model: 'm',
            id: id ?? `auto-${built.length + 1}`,
            withSystemMessage() { return session; },
            withTools() { return session; },
            withMemory() { return session; },
            withTodos() { return session; },
            withParameters() { return session; },
            withCircuitBreaker() { return session; },
            withApprovalPolicy() { return session; },
            /** @param {{initialInput?: any, options?: any}} arg0 */
            async run({ initialInput, options } = {}) {
                options?.onEvent?.({ type: 'text', content: answer });
                /** @type {any} */ (session)._lastStepMessages = [{ role: 'assistant', content: answer }];
                return answer;
            },
        };
        built.push(session);
        emitter?.emit?.('session:start', { sessionId: session.id });
        return session;
    };
    return {
        provider: 'openai',
        built,
        session: () => make(undefined),
        /** @param {{sessionId?: string}} arg0 */
        sessionWithId: ({ sessionId }) => make(sessionId),
    };
}

test('B2: re-beginning a journal key keeps the prior attempt as history', () => {
    const journal = new ExecutionJournal({ runId: 'r-b2' });
    journal.begin({ key: 'k', meta: { name: 'first' } });
    journal.complete({ key: 'k', outcome: { success: true, result: 'CHARGED' } });
    const second = /** @type {any} */ (journal.begin({ key: 'k', meta: { name: 'second' } }));
    assert.equal(second.status, 'intent', 'the row is the current attempt');
    assert.equal(second.name, 'second');
    assert.equal(second.attempts?.length, 1, 'the previous attempt rides along');
    assert.equal(second.attempts[0].name, 'first');
    assert.equal(second.attempts[0].status, 'done', 'and keeps its outcome');
});

test('F1: a DAG step announces the conversation id it uses', async () => {
    const emitter = new EventEmitter();
    const client = makeClient({ emitter });
    /** @type {string[]} */
    const announced = [];
    emitter.on('session:start', (e) => announced.push(String(e?.sessionId)));
    const executor = new WorkflowExecutor({ options: { client: /** @type {any} */ (client), defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'one', dependencies: [] }] });
    await executor.execute({ userGoal: 'goal' });
    const runId = /** @type {any} */ (executor)._runCtx?.runId;
    assert.ok(announced.length > 0, 'the step session announced itself');
    assert.equal(announced[0], runId, 'the step session announces the run id, not an auto uuid');
});

test('F2: the StateMachine adopts the run id', async () => {
    const emitter = new EventEmitter();
    const client = makeClient({ emitter });
    const sm = new StateMachine({ graph: {
        entry: 'a', nodes: [{ id: 'a', userPromptTemplate: 'one', terminal: true }], edges: [],
    }, options: { client: /** @type {any} */ (client), model: 'm', eventEmitter: emitter } });
    await sm.run();
    const runId = /** @type {any} */ (sm)._runCtx?.runId;
    assert.equal(client.built.length, 1, 'one session for one node');
    assert.equal(client.built[0].id, runId, 'and it carries the run id');
});

test('G4: a two-node ledger state machine does not mint throwaway sessions', async () => {
    const emitter = new EventEmitter();
    const client = makeClient({ emitter });
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [
            { id: 'a', userPromptTemplate: 'one' },
            { id: 'b', userPromptTemplate: 'two', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
    }, options: { client: /** @type {any} */ (client), model: 'm', transfer: { mode: 'ledger' } } });
    await sm.run();
    assert.equal(client.built.length, 2, 'two nodes build two sessions, not four (the ledger probe used to build one per node)');
});

test('G5: the objective restatement announces a run-scoped id, not an auto uuid', async () => {
    const emitter = new EventEmitter();
    const client = makeClient({ emitter });
    /** @type {string[]} */
    const announced = [];
    emitter.on('session:start', (e) => announced.push(String(e?.sessionId)));
    const executor = new WorkflowExecutor({ options: { client: /** @type {any} */ (client), defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'one', dependencies: [] }] });
    await executor.execute({ userGoal: 'goal' });
    const runId = /** @type {any} */ (executor)._runCtx?.runId;
    assert.ok(announced.includes(`${runId}:objective`), `the restatement session is named after the run (announced ${announced.join(',')})`);
    assert.equal(announced.some((id) => id.startsWith('auto-')), false, 'no auto uuid is announced');
});

test('E8: the ACP agent does not advertise a history replay it cannot deliver', async () => {
    const agent = createAcpAgent({ session: { run: async () => 'x' } });
    const app = acpClient({ name: 'phase4-editor' });
    await app.connectWith(agent, async (ctx) => {
        const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
        assert.equal(/** @type {any} */ (init.agentCapabilities).loadSession, false, 'loadSession is advertised false: there is no per-session history to replay');
    });
});

test('B2: the attempt history is flat — N re-begins cost N rows, not 2^N', () => {
    const journal = new ExecutionJournal({ runId: 'r-flat' });
    for (let i = 0; i < 12; i++) {
        journal.begin({ key: 'k', meta: { name: `n${i}` } });
        journal.complete({ key: 'k', outcome: { success: true, result: 'x'.repeat(1_000) } });
    }
    const entry = /** @type {any} */ (journal.entries()[0]);
    assert.equal(entry.attempts.length, 11, 'eleven prior attempts');
    assert.equal(entry.attempts.every((/** @type {any} */ a) => a.attempts === undefined), true, 'each stored attempt drops the attempts it carried');
    const bytes = JSON.stringify(journal.toJSON()).length;
    assert.ok(bytes < 100_000, `twelve 1 KB re-begins stay linear (${bytes} bytes; the nested form reached ~2.4 MB)`);
});

test('B2: a circular outcome in a prior attempt still serializes, fail-closed', () => {
    const journal = new ExecutionJournal({ runId: 'r-circular' });
    /** @type {any} */
    const circular = { success: true, result: 'CHARGED' };
    circular.self = circular;
    journal.begin({ key: 'c' });
    journal.complete({ key: 'c', outcome: circular });
    journal.begin({ key: 'c', meta: { name: 'second' } });
    const json = journal.toJSON();
    const serialized = JSON.stringify(json);
    assert.ok(serialized.length > 0, 'the journal serializes');
    const prior = /** @type {any} */ (json.entries[0].attempts?.[0]);
    assert.equal(prior?.outcome?.success, false, 'the unreadable attempt replays as a failure, not a success');
});

test('G5b: the session-level objective pass announces <sessionId>:objective', async () => {
    // chat-session's own cadence pass (not the executor's) — the second half of G5.
    const { AbstractChatSession } = await import('../lib/agentic/chat-session.mjs');
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    /** @type {string[]} */
    const built = [];
    /** @param {string|undefined} id */
    const make = (id) => {
        const s = {
            provider: 'openai',
            withSystemMessage() { return s; },
            withParameters() { return s; },
            /** @param {{options?: any}} arg0 */
            run: async ({ options } = {}) => { options?.onEvent?.({ type: 'text', content: 'NEW OBJECTIVE' }); return 'NEW OBJECTIVE'; },
        };
        built.push(id ?? 'auto');
        return s;
    };
    const client = { provider: 'openai', session: () => make(undefined), sessionWithId: (/** @type {{sessionId?: string}} */ { sessionId }) => make(sessionId) };
    const session = new AbstractChatSession({ provider: 'openai', model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ (client) });
    /** @type {any} */ (session)._agentContext = new AgentContext({ objective: 'OLD', objectivePolicy: { adaptable: true, firstUpdate: 1, updateTurns: 1 } });
    await /** @type {any} */ (session)._maybeObjectivePass({ messages: [] });
    assert.equal(built.length, 1, 'the restatement built one session');
    assert.match(built[0], /:objective$/, 'and it is named after the session, not an auto uuid');
});
