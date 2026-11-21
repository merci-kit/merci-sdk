// @ts-check
/**
 * Named checks for the closeout run's Wave 1 (see
 * `.dev-team/closeout/verification.md`). One test per fix, each observed
 * failing on the pre-fix tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { createHooks } from '../lib/core/hooks.mjs';
import { ConfigurationError, OrchestrationError } from '../lib/core/errors.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';

/**
 * A client whose sessions can be inspected after the run. `sessionWithId` is
 * omitted on purpose: `createSession` then falls back to `session(model)`, the
 * path a stub client owns.
 * @param {{throws?: Error|null, usageOnSuccess?: number|null}} [arg0]
 */
function recordingClient({ throws = null, usageOnSuccess = null } = {}) {
    /** @type {any[]} */
    const sessions = [];
    /** @param {string} model */
    const make = (model) => {
        /** @type {any} */
        const s = {
            provider: 'openai',
            model,
            withSystemMessage() { return s; },
            withTools() { return s; },
            withCircuitBreaker() { return s; },
            /** @param {{initialInput?: any}} [arg0] */
            async run(arg0 = {}) {
                if (usageOnSuccess != null) s._lastRunUsage = { total_tokens: usageOnSuccess };
                if (throws) {
                    // A failed attempt that still spent tokens: the shape the
                    // loop writes while streaming, then the throw.
                    s._lastRunUsage = { total_tokens: 42, prompt_tokens: 40, completion_tokens: 2 };
                    throw throws;
                }
                return 'ok';
            },
        };
        sessions.push(s);
        return s;
    };
    return { sessions, session: make };
}

// ── #3: a thrown node is charged ────────────────────────────────────────────

test('a state-machine node that throws after reporting usage is still charged', async () => {
    const client = recordingClient({ throws: new Error('backend blew up after reporting usage') });
    const graph = { entry: 'a', nodes: [{ id: 'a', model: 'm', terminal: true }], edges: [] };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await assert.rejects(sm.run(), /blew up/);
    assert.equal(sm.usageTokens, 42, 'the failed attempt cost 42 tokens and the budget must see them');
});

test('a successful node is charged exactly once (no double count)', async () => {
    // The stub reports usage on the success path too, so a doubled charge shows.
    const client = recordingClient({ usageOnSuccess: 42 });
    const graph = { entry: 'a', nodes: [{ id: 'a', model: 'm', terminal: true }], edges: [] };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await sm.run();
    assert.equal(sm.usageTokens, 42, 'exactly the reported tokens, never twice');
});

test('a thrown node charges the RUN total, not only the failed iteration', async () => {
    // The real loop attaches the failed step's usage (10) to the error and keeps
    // the whole run's total (60) on the session; charging `err.usage` first
    // under-counted a node that failed on iteration N.
    const client = recordingClient();
    const session = client.session;
    /** @param {string} model */
    client.session = (model) => {
        const s = session(model);
        s.run = async () => {
            s._lastRunUsage = { total_tokens: 60 };
            const err = /** @type {any} */ (new Error('boom on iteration 3'));
            err.usage = { total_tokens: 10 };
            throw err;
        };
        return s;
    };
    const graph = { entry: 'a', nodes: [{ id: 'a', model: 'm', terminal: true }], edges: [] };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await assert.rejects(sm.run(), /boom/);
    assert.equal(sm.usageTokens, 60, 'the attempt total, not the last iteration');
});

test('a thrown discussion turn is charged too', async () => {
    const client = recordingClient({ throws: new Error('turn blew up') });
    const group = new DiscussionSession({ client: /** @type {any} */ (client), options: {} });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    await group.runTasks({ tasks: [{ title: 't', description: 'd', assignee: 'A' }] });
    assert.equal(group.usageTokens, 42, 'the failed turn still spent 42 tokens');
});

// ── #6: the attempt history has a loud ceiling ──────────────────────────────

test('the journal refuses the (MAX+1)th attempt on one key instead of growing forever', () => {
    const journal = new ExecutionJournal({ runId: 'r-cap' });
    const maxAttempts = LIMITS.journal_max_attempts;
    for (let i = 0; i < maxAttempts; i++) journal.begin({ key: 'k' });
    assert.equal(journal.entries()[0].attempts?.length, maxAttempts - 1);
    assert.throws(
        () => journal.begin({ key: 'k' }),
        (err) => err instanceof OrchestrationError && /refusing to append another/.test(err.message),
    );
});

// ── #10: the ledger has a public append seam ────────────────────────────────

test('appendLedger appends rows and getLedger returns a copy', () => {
    const group = new DiscussionSession({ client: /** @type {any} */ ({ session: () => null }) });
    const n = group.appendLedger({ entries: [
        { author: 'A', content: 'one', type: 'discussion', thoughtSignature: null },
        { author: 'B', content: 'two', type: 'discussion', thoughtSignature: null },
    ] });
    assert.equal(n, 2);
    assert.equal(group.getLedger().length, 2);
    const copy = group.getLedger();
    /** @type {any} */ (copy).push({ author: 'C', content: 'three', type: 'discussion', thoughtSignature: null });
    assert.equal(group.getLedger().length, 2, 'mutating the copy never changes the session');
});

test('appendLedger refuses a malformed row loudly', () => {
    const group = new DiscussionSession({ client: /** @type {any} */ ({ session: () => null }) });
    assert.throws(
        () => group.appendLedger({ entries: [/** @type {any} */ ({ author: 'A', content: 'x' })] }),
        (err) => err instanceof ConfigurationError && /thoughtSignature/.test(err.message),
    );
    assert.throws(() => group.appendLedger({ entries: /** @type {any} */ ('nope') }), ConfigurationError);
    assert.equal(group.getLedger().length, 0, 'a refused batch appends nothing');
});

test('appendLedger refuses an unbounded restore', () => {
    const group = new DiscussionSession({ client: /** @type {any} */ ({ session: () => null }) });
    const rows = Array.from({ length: 1001 }, (_, i) => ({ author: 'A', content: `e${i}`, type: 'discussion', thoughtSignature: null }));
    assert.throws(() => group.appendLedger({ entries: rows }), /seed seam holds at most/);
    assert.equal(group.getLedger().length, 0);
});

// ── B2 (phase 2): every engine hands the hook registry to its step session ───

test('B2: the state machine propagates the hook registry to its step session', async () => {
    const hooks = createHooks();
    const client = recordingClient();
    const graph = { entry: 'a', nodes: [{ id: 'a', model: 'm', terminal: true }], edges: [] };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm', sessionPolicy: { hooks } } });
    await sm.run();
    assert.equal(client.sessions[0]?._hooks, hooks, 'the node session carries the registry');
});

test('B2: the DAG executor propagates the hook registry to its step session', async () => {
    const hooks = createHooks();
    const client = recordingClient();
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionPolicy: { hooks } } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'go', dependencies: [] }] });
    await exec.execute({ userGoal: 'go' });
    assert.equal(client.sessions[0]?._hooks, hooks, 'the step session carries the registry');
});

test('B2: the discussion engine propagates the hook registry to its turn session', async () => {
    const hooks = createHooks();
    const client = recordingClient();
    const group = new DiscussionSession({ client: /** @type {any} */ (client), options: { sessionPolicy: { hooks } } });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    await group.runTasks({ tasks: [{ title: 't', description: 'd', assignee: 'A' }] });
    assert.equal(client.sessions[0]?._hooks, hooks, 'the turn session carries the registry');
});

test('B2: the chat session adopts the registry through withHooks', () => {
    const hooks = createHooks();
    const session = new AbstractChatSession({
        provider: 'openai',
        model: 'm',
        eventEmitter: new EventEmitter(),
        client: /** @type {any} */ (undefined),
        sessionId: 's',
    });
    // The naive engine's wiring: withHooks stores the registry on the session the
    // loop later hands to drainStepWithHooks.
    /** @type {any} */ (session).withHooks({ hooks });
    assert.equal(/** @type {any} */ (session)._hooks, hooks);
});

test('B2: the DAG stateMachine engine propagates the registry too', async () => {
    const hooks = createHooks();
    const client = recordingClient();
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionPolicy: { hooks }, engine: 'stateMachine' } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'go', dependencies: [] }] });
    await exec.execute({ userGoal: 'go' });
    assert.equal(client.sessions[0]?._hooks, hooks, 'the SM-engine step session carries the registry');
});
