// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runStep } from '../lib/agentic/step.mjs';


/**
 * Fake client whose session records the builder setters and the run options.
 * @param {{ onRun?: (input: any, options: any, session: any) => any }} [hooks]
 */
function makeClient({ onRun } = {}) {
    
    /** @type {any[]} */
        const sessions = [];
    
    /** @type {any[]} */
        const calls = [];
    return {
        sessions,
        calls,
        session: /** @type {(...args: any[]) => any} */ (( model) => {
            
            /** @type {any} */
                        const s = {
                provider: 'openai',
                model,
                /** @param {*} v */
                withSystemMessage( v) { this._systemMessage = v; return this; },
                /** @param {{tools: *}} arg0 */
                withTools({ tools }) { this._tools = tools; return this; },
                /** @param {{provider: *, options: *}} arg0 */
                withMemory({ provider, options }) { this._memory = { p: provider, o: options }; return this; },
                /** @param {{store: *, options: *}} arg0 */
                withTodos({ store, options }) { this._todos = { st: store, o: options }; return this; },
                /** @param {{params: *}} arg0 */
                withParameters({ params }) { this._params = params; return this; },
                /** @param {{breaker: *}} arg0 */
                withCircuitBreaker({ breaker }) { this._circuitBreaker = breaker; return this; },
                /** @param {{initialInput: *, options: *}} arg0 */
                run: async ({ initialInput: input, options }) => {
                    calls.push({ input, options, session: s });
                    s._lastStepMessages = [{ role: 'assistant', content: 'done' }];
                    if (onRun) return onRun(input, options, s);
                    return 'result-text';
                },
            };
            sessions.push(s);
            return s;
        }),
    };
}

const BASE = {
    systemPrompt: 'sys',
    userText: 'do it',
    maxIterations: 5,
};

test('runStep: applies approval policy, breaker, system, tools, memory/todos and run options', async () => {
    const client = makeClient();
    const policy = { callback: async () => true };
    const budget = { maxTotalTokens: 100 };
    const controller = new AbortController();
    const runContext = { emit: () => {} };

    const outcome = await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
        tools: [{ name: 't' }],
        capabilities: { memoryProvider: { x: 1 }, memoryOptions: {}, todoStore: new Map(), todoOptions: {}, parallelToolCalls: true },
        approvalPolicy: policy,
        budget,
        signal: controller.signal,
        followUp: () => {},
        autoExtend: true,
        errorHandlers: { max_turns: () => true },
        runContext,
        emitter: new EventEmitter(),
        /** @param {{c: *}} arg0 */
        /** @param {{c: *}} arg0 */
        events: { text: 'x:text', thought: 'x:thought', makePayload: /** @type {(...args: any[]) => any} */ (({ c }) => ({ c })) },
    } });

    const session = client.sessions[0];
    assert.equal(session._approvalPolicy, policy, 'approval policy applied');
    assert.ok(session._circuitBreaker, 'breaker attached');
    assert.equal(session._systemMessage, 'sys');
    assert.deepEqual(session._tools, [{ name: 't' }]);
    assert.equal(session._memory.p.x, 1);
    assert.ok(session._todos.st instanceof Map);
    assert.equal(typeof session._params, 'function', 'parallelToolCalls parameter applied');

    const options = client.calls[0].options;
    assert.equal(options.maxIterations, 5);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.runContext, runContext);
    assert.deepEqual(options.budget, budget);
    assert.equal(options.autoExtend, true);
    assert.deepEqual(options.errorHandlers, { max_turns: options.errorHandlers.max_turns });
    assert.equal(typeof options.onEvent, 'function');
    assert.equal(outcome.result, 'result-text');
    assert.deepEqual(outcome.messages, [{ role: 'assistant', content: 'done' }]);
});

test('runStep: verifyFeedback is appended to the user turn', async () => {
    const client = makeClient();
    await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
        verifyFeedback: 'EVIDENCE-42',
        events: { text: 'x:text', thought: 'x:thought', makePayload: /** @type {(...args: any[]) => any} */ ((c) => ({ c })) },
    } });
    const user = client.calls[0].input[0];
    assert.ok(String(user.content).includes('do it'));
    assert.ok(String(user.content).includes('EVIDENCE-42'), 'feedback reaches the prompt');
    assert.ok(String(user.content).includes('[Verification feedback'));
});

test('runStep: an explicit messages history wins over userText', async () => {
    const client = makeClient();
    const history = [{ role: 'user', content: 'ledger-turn' }, { role: 'assistant', content: 'prior' }];
    await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        userText: 'IGNORED',
        client,
        model: 'm',
        messages: history,
        events: { text: 'x:text', thought: 'x:thought', makePayload: /** @type {(...args: any[]) => any} */ ((c) => ({ c })) },
    } });
    assert.deepEqual(client.calls[0].input, history, 'the explicit history is sent verbatim');
});

test('runStep: toolEvents forwards tool_call_start/end and captures the signature', async () => {
    const emitter = new EventEmitter();
    
    /** @type {any[]} */
        const events = [];
    emitter.on('x:tool_start', (p) => events.push(['start', p]));
    emitter.on('x:tool_end', (p) => events.push(['end', p]));
    const client = makeClient({
        onRun: (_input, options) => {
            options.onEvent({ type: 'tool_call_start', name: 'read', args: { path: 'a' } });
            options.onEvent({ type: 'tool_call_end', name: 'read', result: 'ok' });
            options.onEvent({ type: 'thought_signature', signature: 'sig-1' });
            return 'r';
        },
    });
    const outcome = await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
        toolEvents: true,
        emitter,
        events: {
            text: 'x:text',
            thought: 'x:thought',
            thoughtSignature: 'x:sig',
            toolStart: 'x:tool_start',
            toolEnd: 'x:tool_end',
            makePayload: /** @type {(...args: any[]) => any} */ ((content) => ({ agent: 'A', type: 'discussion', content })),
        },
    } });
    assert.deepEqual(events[0], ['start', { agent: 'A', type: 'discussion', name: 'read', args: { path: 'a' } }]);
    assert.deepEqual(events[1], ['end', { agent: 'A', type: 'discussion', name: 'read', result: 'ok' }]);
    assert.equal(outcome.signature, 'sig-1', 'signature captured from the stream event');
});

test('runStep: goal:"clean" does not inherit the AgentContext', async () => {
    const client = makeClient();
    const agentContext = { objective: 'x' };
    await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
        agentContext,
        handoff: { goal: 'clean' },
        events: { text: 'x:text', thought: 'x:thought', makePayload: /** @type {(...args: any[]) => any} */ ((c) => ({ c })) },
    } });
    assert.equal(client.sessions[0]._agentContext, undefined, 'clean turn drops direction');

    const client2 = makeClient();
    await runStep({ step: { id: 's2' }, deps: {
        ...BASE,
        client: client2,
        model: 'm',
        agentContext,
        handoff: { goal: 'full' },
        events: { text: 'x:text', thought: 'x:thought', makePayload: /** @type {(...args: any[]) => any} */ ((c) => ({ c })) },
    } });
    assert.equal(client2.sessions[0]._agentContext, agentContext, 'full turn inherits the context');
});

// ─── configureSession:false (task.mjs subagent children) ────────────────────

test('runStep: configureSession:false leaves a caller-configured session untouched', async () => {
    const client = makeClient();
    const session = client.session('m');
    session.withSystemMessage('PRESET').withTools({ tools: [{ name: 'preset' }] });
    session._approvalPolicy = { callback: async () => true };
    session._circuitBreaker = { preset: true };
    // A6 — the caller's own tool store and capability map. `configureSession:false`
    // must not touch them even when the handoff asks for no tools: stripping here
    // would silently override the policy the caller already applied.
    session._toolsStore = [{ name: 'preset' }];
    session._capabilityTools = new Map([['task', { name: 'task' }]]);

    await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
        session,
        configureSession: false,
        handoff: { tools: 'none' },
        systemPrompt: 'SHOULD-NOT-APPLY',
        tools: [{ name: 'new' }],
        capabilities: { memoryProvider: { x: 1 }, todoStore: new Map() },
        approvalPolicy: { callback: async () => false },
        agentContext: { objective: 'x' },
        sessionId: 'run-1',
        messages: [{ role: 'user', content: 'brief' }],
        events: { text: 'x:text', thought: 'x:thought', makePayload: /** @type {(...args: any[]) => any} */ ((c) => ({ c })) },
    } });

    assert.equal(session._systemMessage, 'PRESET', 'system prompt not overwritten');
    assert.deepEqual(session._tools, [{ name: 'preset' }], 'tools not overwritten');
    assert.deepEqual(session._toolsStore, [{ name: 'preset' }], 'the caller-set tool store is preserved (handoff.tools:none is the caller\'s decision, not this flag\'s)');
    assert.ok(session._capabilityTools.has('task'), 'the caller-set capability map is preserved');
    assert.equal(session._memory, undefined, 'memory not wired');
    assert.equal(session._todos, undefined, 'todos not wired');
    assert.equal(session._agentContext, undefined, 'agent context not assigned');
    assert.equal(session._explicitSessionId, undefined, 'session id not assigned');
    assert.deepEqual(session._circuitBreaker, { preset: true }, 'the caller-set breaker is preserved, not replaced');
    assert.equal(client.calls[0].options.maxIterations, 5, 'the run still happened');
});

// ─── onEvent override ───────────────────────────────────────────────────────

test('runStep: an explicit onEvent wins over the events map', async () => {
    
    /** @type {any[]} */
        const seen = [];
    const client = makeClient({
        onRun: (_input, options) => {
            options.onEvent({ type: 'text', content: 'hi' });
            return 'r';
        },
    });
    await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
        onEvent: /** @type {(...args: any[]) => any} */ (( e) => seen.push(e)),
    } });
    assert.deepEqual(seen, [{ type: 'text', content: 'hi' }], 'the caller handler received the raw stream event');
});

test('runStep: with neither events nor onEvent the run options omit onEvent', async () => {
    const client = makeClient();
    await runStep({ step: { id: 's1' }, deps: {
        ...BASE,
        client,
        model: 'm',
    } });
    assert.equal('onEvent' in client.calls[0].options, false, 'no onEvent key is passed');
});
