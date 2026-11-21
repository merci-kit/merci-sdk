// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runStep } from '../lib/agentic/step.mjs';
import { createTaskTool, withTaskAgents } from '../lib/agentic/task.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { createGuardrails, extractUserText } from '../lib/agentic/guardrails.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';

/**
 * @param {any} [hooks]
 * @returns {any}
 */
function stepSession({ onRun } = {}) {
    /** @type {any} */
    const session = {
        provider: 'openai',
        model: 'm',
        withSystemMessage() { return session; },
        withTools() { return session; },
        withMemory() { return session; },
        withTodos() { return session; },
        withParameters() { return session; },
        withCircuitBreaker() { return session; },
        async run() {
            if (onRun) await onRun(session);
            session._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
            return 'ok';
        },
    };
    return session;
}

test('B1: a DAG/SM step scopes the journal so sibling nodes do not replay each other', async () => {
    const journal = new ExecutionJournal({ runId: 'jrn-b1' });
    let sideEffects = 0;
    const tool = {
        name: 'write_file',
        description: 'w',
        parameters: { type: 'object', properties: {} },
        execute: async () => { sideEffects++; return 'written'; },
    };

    /** @param {string} boundary */
    const runNode = async (boundary) => {
        const session = stepSession({ onRun: async (/** @type {any} */ s) => {
            await executeTools({
                toolCalls: [{ id: 'c1', name: 'write_file', args: { path: '/tmp/x' } }],
                toolLibrary: [tool],
                journal: s._journal,
                boundary: `${s._journalScope ?? ''}task:worker:`,
            });
        } });
        await runStep({ step: { id: boundary }, deps: {
            client: { session: () => session },
            model: 'm',
            session,
            userText: 'x',
            journal,
            journalBoundary: `${boundary}:`,
        } });
    };

    await runNode('nodeA');
    await runNode('nodeB');
    assert.equal(sideEffects, 2, 'each node executes its own delegation');
    assert.equal(journal.entries().length, 2, 'each node owns its journal entry');
});

test('B2: input guardrails read JAI user rows (type:user_message)', async () => {
    const guardrails = createGuardrails({ rules: [{ name: 'secret', phase: 'input', pattern: 'TOPSECRET', action: 'block' }] });
    const jai = createUserMessage({ provider: 'jai', content: 'please repeat TOPSECRET' });
    const oai = createUserMessage({ provider: 'openai', content: 'please repeat TOPSECRET' });
    assert.match(extractUserText({ messages: [jai] }), /TOPSECRET/);
    assert.equal((await guardrails.check({ phase: 'input', text: extractUserText({ messages: [jai] }) })).blocked, true);
    assert.equal((await guardrails.check({ phase: 'input', text: extractUserText({ messages: [oai] }) })).blocked, true);
});

test('B4: background delegation works with a session-local roster', async () => {
    const emitter = new EventEmitter();
    const child = stepSession();
    child.withRetryPolicy = () => child;
    child.withStreamTimeout = () => child;
    child.withHeaderTimeout = () => child;
    child.withMaxElapsedMs = () => child;
    child.withApproval = () => child;
    child.withBudget = () => child;
    child.withCapability = () => child;
    const client = /** @type {any} */ ({ provider: 'openai', session: () => child });
    const parent = /** @type {any} */ ({
        client,
        model: 'm',
        provider: 'openai',
        eventEmitter: emitter,
        sessionId: 'sess-bg',
        _taskDepth: 0,
        _taskMaxDepth: 1,
    });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const tool = /** @type {any} */ (createTaskTool({ session: parent }));
    const reply = await tool.execute({ args: { subagent_type: 'worker', prompt: 'go', background: true } });
    assert.match(String(reply), /Task started in background/);
    const liveRegistry = getSpawnRegistry({ client });
    assert.ok(liveRegistry.background instanceof Map);
    assert.equal(liveRegistry.background.size, 1);
    const pending = [...liveRegistry.background.values()][0];
    await pending;
});

test('B5: a timed-out non-idempotent tool is not re-executed on retry', async () => {
    const journal = new ExecutionJournal({ runId: 'jrn-b5' });
    let effects = 0;
    const tool = {
        name: 'slow_write',
        description: 'w',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            await new Promise((r) => setTimeout(r, 40));
            effects++;
            return 'written';
        },
    };
    const call = { id: 'c1', name: 'slow_write', args: { path: '/tmp/x' } };
    const first = /** @type {any[]} */ (await executeTools({ toolCalls: [call], toolLibrary: [tool], journal, boundary: 'b1', toolTimeoutMs: 5 }));
    assert.equal(first[0].success, false);
    assert.equal(journal.entries()[0].status, 'interrupted', 'a timeout is unknown state, not a clean failure');
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(effects, 1);
    const second = /** @type {any[]} */ (await executeTools({ toolCalls: [call], toolLibrary: [tool], journal, boundary: 'b1', toolTimeoutMs: 5 }));
    assert.equal(second[0].success, false);
    assert.match(String(second[0].error), /side-effect state is unknown/);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(effects, 1, 'the retry must not double the side effect');
});

/**
 * @param {any} [opts]
 * @returns {any}
 */
function minimalSession(opts = {}) {
    return new (class extends AbstractChatSession {
        constructor() {
            super({ provider: 'openai', model: 'm', eventEmitter: new EventEmitter(), client: opts.client ?? {}, sessionId: opts.sessionId ?? null });
        }
    })();
}

test('B3: a subagent inherits permissions, guardrails, hooks, processors, tool timeout and compaction', async () => {
    const parent = minimalSession();
    parent.withPermissions({ deny: ['bash'] });
    parent.withGuardrails({ rules: [{ name: 'secret', phase: 'input', pattern: 'TOPSECRET', action: 'block' }] });
    parent.withToolTimeout({ ms: 123 });
    parent.withCompaction();
    parent.withContextProcessor({ name: 'p', process: () => undefined });
    parent._hooks = /** @type {any} */ ({ runWaterfall: async () => undefined, runSerial: async () => undefined, has: () => false, count: () => 0 });

    const bash = { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} }, execute: async () => 'ran' };
    const child = minimalSession();
    child.run = async function () {
        this._lastStepMessages = [{ role: 'assistant', content: 'child' }];
        return 'child';
    };
    const client = {
        provider: 'openai',
        /** @param {{model: string, sessionId: string|null}} arg0 */
        sessionWithId({ model, sessionId }) {
            assert.equal(model, 'm');
            assert.equal(sessionId, parent.sessionId, 'the child session is constructed with the parent conversation id');
            return child;
        },
        session() { return child; },
    };
    withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'worker', model: 'm', tools: [bash] }] });
    parent.client = client;
    parent._taskDepth = 0;
    parent._taskMaxDepth = 1;

    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { subagent_type: 'worker', prompt: 'go' } });

    assert.deepEqual(child._permissionRules.deny, ['bash'], 'the deny list is inherited');
    assert.equal(child._tools.some((/** @type {any} */ t) => t.name === 'bash'), false, 'the denied tool is not exposed');
    assert.equal(child._guardrails, parent._guardrails, 'guardrails are inherited');
    assert.equal(child._hooks, parent._hooks, 'hooks are inherited');
    assert.equal(child._contextProcessors.length, 1, 'context processors are inherited');
    assert.equal(child._toolTimeoutMs, 123, 'tool timeout is inherited');
    assert.deepEqual(child._compaction, {}, 'compaction is inherited');
});

test('M11: a session created by runStep emits session:start with the run session id', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const starts = [];
    emitter.on(EVENTS.CLIENT.SESSION_START, (e) => starts.push(e));
    const adapter = {
        vendorName: 'FAKE',
        buildVendorRequest: () => ({ request: {}, observability: {} }),
        executeVendorRequest: async () => (async function* () { yield { type: 'text', content: 'ok' }; })(),
        /** @param {{rawStream: any}} arg0 */
        consumeStream: ({ rawStream }) => rawStream,
        formatToolCall: () => ({}),
        extractXmlToolCalls: () => [],
    };
    /** @type {any} */
    let created = null;
    const client = {
        provider: 'openai',
        /** @param {{model: string, sessionId: string|null}} arg0 */
        sessionWithId({ model, sessionId }) {
            created = new (class extends AbstractChatSession {
                constructor() {
                    super({ provider: 'openai', model, eventEmitter: emitter, client, sessionId: sessionId ?? null });
                    this._adapter = adapter;
                    this._streamTimeoutPolicy = {};
                }
            })();
            return created;
        },
        session() { return created; },
    };
    await runStep({ step: {}, deps: { client, model: 'm', userText: 'x', sessionId: 'sess-explicit' } });
    assert.equal(starts.length, 1);
    assert.equal(starts[0].sessionId, 'sess-explicit', 'session:start uses the adopted id');
    assert.ok(created);
    assert.equal(created.sessionId, 'sess-explicit');
    assert.equal(created._sessionRunCtx.sessionId, 'sess-explicit');
});

test('M2: a timed-out SM node aborts the losing run instead of abandoning it', async () => {
    const { StateMachine } = await import('../lib/agentic/state-machine/machine.mjs');
    let aborted = false;
    const session = /** @returns {any} */ (() => ({
        provider: 'openai', model: 'm',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{options: any}} arg0 */
        async run({ options }) {
            await new Promise((resolve, reject) => {
                const onAbort = () => { aborted = true; reject(new Error('aborted')); };
                if (options.signal?.aborted) onAbort();
                else options.signal?.addEventListener('abort', onAbort, { once: true });
            });
            return 'late';
        },
    }));
    const client = /** @type {any} */ ({ provider: 'openai', session });
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', userPromptTemplate: 'x', timeoutMs: 10 }], edges: [] }, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm.run({}), /timed out/);
    assert.equal(aborted, true, 'the losing node run must receive the abort');
});

test('M7: run_state_machine forwards budget, approval and defaultModel to the machine', async () => {
    const { createStateMachineTool } = await import('../lib/agentic/state-machine/machine.mjs');
    /** @type {any[]} */
    const seen = [];
    const session = /** @returns {any} */ (() => ({
        provider: 'openai', model: 'm',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{options: any}} arg0 */
        async run({ options }) {
            const self = /** @type {any} */ (this);
            seen.push({ approval: self._approvalPolicy, budget: options.budget });
            self._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
            return 'ok';
        },
    }));
    const client = /** @type {any} */ ({ provider: 'openai', session });
    const approval = { callback: async () => true };
    const tool = /** @type {any} */ (createStateMachineTool({
        graph: { entry: 'n', nodes: [{ id: 'n', userPromptTemplate: 'x' }], edges: [] },
        options: { client, defaultModel: 'm', budget: { maxTotalTokens: 5 }, approval },
    }));
    await tool.execute({ args: { context: {} } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].approval.callback, approval.callback, 'approval reaches the node session');
    assert.deepEqual(seen[0].budget, { maxTotalTokens: 5 }, 'budget reaches the node session');
});

test('M1: per-step verify is honored by the stateMachine and discussion engines', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    const client = { provider: 'openai', session: () => stepSession() };
    for (const engine of ['stateMachine', 'discussion']) {
        let calls = 0;
        const ex = new WorkflowExecutor({ options: {
            client,
            defaultModel: 'm',
            agents: engine === 'discussion' ? [{ name: 'a', model: 'm', provider: 'openai' }] : [],
        } });
        ex.setSteps({ stepsList: [{
            id: 's',
            engine,
            userPromptTemplate: 'do it',
            maxRetries: 0,
            verify: () => { calls++; return { passed: false, evidence: 'nope' }; },
        }] });
        await assert.rejects(() => ex.execute({ userGoal: 'goal' }));
        assert.ok(calls > 0, `${engine} must call step.verify`);
    }
});

test('M3: a verified MAA task stores the answer text, not the StateContext envelope', async () => {
    const client = { provider: 'openai', session: () => stepSession() };
    const group = new DiscussionSession({ client, options: {} });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    await group.runTasks({ tasks: [{ title: 't', assignee: 'a', description: 'do', verify: () => ({ passed: true, evidence: 'ok' }) }], sequential: true });
    const entry = /** @type {any} */ (group.getLedger()[0]);
    assert.equal(entry.content, 'ok', 'the ledger carries the node output, not {"turn":"..."}');
    assert.equal(JSON.stringify(entry.content).includes('turn'), false);
});

test('M4: planForEach routes steps through the agent client, not the group client', async () => {
    const plan = JSON.stringify({ steps: [
        { id: 's1', description: 'one', dependencies: [] },
        { id: 's2', description: 'two', dependencies: ['s1'] },
    ] });
    /** @type {string[]} */
    const groupCalls = [];
    /** @type {string[]} */
    const altCalls = [];
    /**
     * @param {string} label
     * @param {any[]} calls
     * @returns {any}
     */
    const make = (label, calls) => ({
        provider: 'openai', model: 'm',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        withHeaderTimeout() { return this; },
        withMaxElapsedMs() { return this; },
        withApproval() { return this; },
        withBudget() { return this; },
        withCircuitBreaker() { return this; },
        withCapability() { return this; },
        withParameters() { return this; },
        /** @param {{initialInput: any}} arg0 */
        async run({ initialInput }) {
            calls.push(label);
            const out = typeof initialInput === 'string' ? plan : `${label}-output`;
            /** @type {any} */ (this)._lastStepMessages = [{ role: 'assistant', content: out }];
            return out;
        },
    });
    const groupClient = { provider: 'openai', session: () => make('group', groupCalls) };
    const altClient = { provider: 'openai', session: () => make('alt', altCalls) };
    const group = new DiscussionSession({ client: groupClient, options: {} });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai', client: altClient });
    await group.planForEach({ instruction: 'plan this', options: {} });
    assert.equal(altCalls.length, 2, 'both planned steps run on the agent transport');
    assert.equal(groupCalls.length, 1, 'only the planner uses the group transport');
});

test('M10: the discussion objective is restated on cadence, not every turn, and the update is kept', async () => {
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    const emitter = new EventEmitter();
    /** @type {string[]} */
    const calls = [];
    /** @type {any} */
    let client;
    /** @returns {any} */
    const makeSession = () => {
        const adapter = {
            vendorName: 'FAKE',
            /** @param {{preparedMessages: any}} arg0 */
            buildVendorRequest: ({ preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
            /** @param {{request: any}} arg0 */
            executeVendorRequest: async ({ request }) => (async function* () {
                const text = JSON.stringify(request.preparedMessages);
                const restate = text.includes('You maintain the working objective');
                calls.push(restate ? 'RESTATE' : 'TURN');
                yield { type: 'text', content: restate ? 'RESTATED GOAL' : 'ARGUMENT' };
            })(),
            /** @param {{rawStream: any}} arg0 */
            consumeStream: ({ rawStream }) => rawStream,
            formatToolCall: () => ({}),
            extractXmlToolCalls: () => [],
        };
        return new (class extends AbstractChatSession {
            constructor() {
                super({ provider: 'openai', model: 'm', eventEmitter: emitter, client });
                this._adapter = adapter;
                this._streamTimeoutPolicy = {};
            }
        })();
    };
    client = { provider: 'openai', session: () => makeSession() };
    const ctx = AgentContext.fromObjective({ objective: 'GOAL' });
    ctx.objectivePolicy = { adaptable: true, hitl: false, firstUpdate: 1, updateTurns: 10, preStep: false };
    const group = new DiscussionSession({ client, options: { objective: 'GOAL', agentContext: ctx } });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'b', model: 'm', provider: 'openai' });
    await group.discuss({ instruction: 'debate', turns: 2, sequential: true });
    assert.equal(calls.filter((c) => c === 'RESTATE').length, 1, 'one restatement on a two-turn cadence');
    assert.equal(calls.filter((c) => c === 'TURN').length, 4, 'every agent turn still runs');
    assert.equal(group._agentContext?.objective, 'RESTATED GOAL', 'the group adopts the update');
    assert.equal(group._agentContext?.objectiveTurn, 4, 'the shared turn counter advances across turns');
});

test('M5: tokens from an unreported step are charged to the run budget', async () => {
    const { runAgenticLoop } = await import('../lib/agentic/agentic-core.mjs');
    const { NoRetryPolicy } = await import('../lib/support/retry-policy.mjs');
    const emitter = new EventEmitter();
    let call = 0;
    const tool = { name: 't', description: 't', parameters: { type: 'object', properties: {} }, execute: async () => 'tool-ok' };
    const session = /** @type {any} */ ({
        provider: 'openai', model: 'm', eventEmitter: emitter, sessionId: 's', _lastStepMessages: null,
        _tools: [tool], _retryPolicy: new NoRetryPolicy(), _approvalPolicy: null,
        /** @param {{messages: any}} arg0 */
        async *step({ messages }) {
            call++;
            if (call === 1) {
                yield { type: 'quota', data: { prompt_tokens: 900, completion_tokens: 0 } };
                yield { type: 'tool_request', calls: [{ id: 'c1', name: 't', args: {} }] };
                yield { type: 'tool_request', calls: [{ id: 'c1', name: 't', args: {} }] };
                return { done: false, content: '', messages: [...messages, { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', name: 't', content: 'tool-ok' }] };
            }
            const text = 'FINAL-' + 'x'.repeat(400);
            return { done: true, content: text, messages: [...messages, { role: 'assistant', content: text }] };
        },
    });
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'openai', content: 'go' })], opts: { budget: { maxTotalTokens: 5000 }, maxIterations: 5 } });
    assert.match(String(out), /FINAL-/);
    assert.ok(session._lastRunUsage.total_tokens > 900, 'the estimated step is added to the reported total');
    assert.ok(session._lastRunUsage.estimated_tokens > 0, 'the estimate is visible, not folded away');
});

test('M6: a fork window never starts on a dangling tool result', async () => {
    const rows = [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'data' },
        ...Array.from({ length: 39 }, (_, i) => ({ role: 'user', content: 'filler ' + i })),
    ];
    let childInput = null;
    const child = stepSession();
    child.withRetryPolicy = () => child;
    child.withStreamTimeout = () => child;
    child.withHeaderTimeout = () => child;
    child.withMaxElapsedMs = () => child;
    child.withApproval = () => child;
    child.withBudget = () => child;
    child.withCapability = () => child;
    child.run = async function (/** @type {any} */ { initialInput }) {
        childInput = initialInput;
        this._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
        return 'ok';
    };
    const client = /** @type {any} */ ({ provider: 'openai', session: () => child });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const parent = /** @type {any} */ ({ client, model: 'm', provider: 'openai', eventEmitter: new EventEmitter(), sessionId: 's', _taskDepth: 0, _taskMaxDepth: 1, _lastStepMessages: rows });
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { subagent_type: 'worker', prompt: 'go', handoff: { context: 'fork' } } });
    assert.ok(Array.isArray(childInput));
    assert.equal(/** @type {any[]} */ (childInput)[0]?.role, 'assistant', 'the fork starts on the tool call, not the result');
});

test('m17: a JAI tool_message is recognized as a tool result by the transfer safety net', async () => {
    const { renderTransfer } = await import('../lib/agentic/transfer.mjs');
    const call = { type: 'assistant_message_tool', id: 'c1', toolName: 'read', content: '{}' };
    const result = { type: 'tool_message', id: 'c1', toolName: 'read', result: 'data' };
    const rendered = await renderTransfer({
        units: [
            { id: 'u1', provider: 'jai', messages: [call] },
            { id: 'u2', provider: 'jai', messages: [result] },
        ],
        transfer: { mode: 'ledger', select: 'tail', tail: 1 },
        targetProvider: 'jai',
    });
    assert.equal(rendered.rows.some((r) => /** @type {any} */ (r).type === 'tool_message'), false, 'a dangling JAI tool result is degraded, not replayed');
});

test('m4: a frontmatter-only SKILL.md with no trailing newline still loads', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { loadSkillsFromDirectory } = await import('../lib/tools/skills.mjs');
    const root = await mkdtemp(join(tmpdir(), 'merci-skill-'));
    try {
        await mkdir(join(root, 'alpha'));
        await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: no trailing newline\n---');
        const tools = await loadSkillsFromDirectory({ directory: root, requireScriptApproval: false });
        assert.deepEqual(tools.map((t) => t.name), ['alpha']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('M8: a subagent inherits the parent skill tools and runStep applies a skills capability', async () => {
    const parent = minimalSession();
    parent.withSkills({ skills: [{ name: 'alpha', description: 'a', instructions: 'A-BODY' }] });
    const child = minimalSession();
    child.run = async function () {
        this._lastStepMessages = [{ role: 'assistant', content: 'child' }];
        return 'child';
    };
    const client = /** @type {any} */ ({
        provider: 'openai',
        sessionWithId: () => child,
        session: () => child,
    });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    parent.client = client;
    parent._taskDepth = 0;
    parent._taskMaxDepth = 1;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { subagent_type: 'worker', prompt: 'go' } });
    assert.ok(child._skillToolsStore.some((/** @type {any} */ t) => t.name === 'alpha'), 'the skill tool is inherited');

    let applied = null;
    const fake = stepSession();
    fake.withSkills = (/** @type {any} */ { skills }) => { applied = skills; return fake; };
    await runStep({ step: {}, deps: {
        client: { session: () => fake },
        model: 'm',
        session: fake,
        userText: 'x',
        capabilities: { skills: [{ name: 'beta' }], skillsPreload: false },
    } });
    assert.deepEqual(applied, [{ name: 'beta' }]);
});

test('m1: a discussion-engine step injects the global objective once', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    /** @type {any[]} */
    const inputs = [];
    const client = { provider: 'openai', session: () => {
        const s = stepSession();
        s.run = async function (/** @type {any} */ { initialInput }) {
            inputs.push(initialInput);
            s._lastStepMessages = [{ role: 'assistant', content: 'ANSWER' }];
            return 'ANSWER';
        };
        return s;
    } };
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', agents: [{ name: 'a', model: 'm', provider: 'openai' }] } });
    ex.setSteps({ stepsList: [{ id: 's', engine: 'discussion', userPromptTemplate: 'Do the task.', dependencies: [] }] });
    await ex.execute({ userGoal: 'THE GLOBAL GOAL' });
    const flat = JSON.stringify(inputs[0] ?? []);
    assert.equal((flat.match(/THE GLOBAL GOAL/g) || []).length, 1, 'the objective is not duplicated into Constraints');
});

test('m2: the objective HITL gate reaches the executor approval policy', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    let approvals = 0;
    const client = { provider: 'openai', session: () => {
        const s = stepSession();
        s.run = async function (/** @type {any} */ { initialInput }) {
            const text = Array.isArray(initialInput) ? initialInput.map((m) => m.content).join('\n') : String(initialInput);
            const out = text.includes('You maintain the working objective') ? 'RESTATED GOAL' : 'STEP OUTPUT';
            s._lastStepMessages = [{ role: 'assistant', content: out }];
            return out;
        };
        return s;
    } };
    const ctx = AgentContext.fromObjective({ objective: 'GOAL' });
    ctx.objectivePolicy = { adaptable: true, hitl: true, firstUpdate: 1, updateTurns: 10, preStep: true };
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', agentContext: ctx, approval: { callback: async () => { approvals++; return true; } } } });
    ex.setSteps({ stepsList: [{ id: 's', userPromptTemplate: 'Do it.', dependencies: [] }] });
    await ex.execute({ userGoal: 'GOAL' });
    assert.equal(approvals, 1, 'the objective restatement is gated through the executor approval policy');
});

test('m3: repeated withSkills keeps earlier skills in the listing', async () => {
    const session = minimalSession();
    session.withSkills({ skills: [{ name: 'alpha', description: 'a', instructions: 'A-BODY' }] });
    session.withSkills({ skills: [{ name: 'beta', description: 'b', instructions: 'B-BODY' }] });
    const listing = await session._skillsLibrary.load();
    assert.match(listing, /alpha/);
    assert.match(listing, /beta/);
    assert.ok(session._tools.some((/** @type {any} */ t) => t.name === 'alpha'));
    assert.ok(session._tools.some((/** @type {any} */ t) => t.name === 'beta'));
});

test('m8: DAG systemPrompt templates are interpolated like userPromptTemplate', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    /** @type {any[]} */
    const systems = [];
    const client = { provider: 'openai', session: () => {
        const s = stepSession();
        s.run = async function (/** @type {any} */ { initialInput }) {
            systems.push(this._sys);
            const out = String(initialInput?.[initialInput.length - 1]?.content ?? '').includes('SOURCE') ? 'SOURCE' : 'TARGET';
            s._lastStepMessages = [{ role: 'assistant', content: out }];
            return out;
        };
        s.withSystemMessage = function (/** @type {any} */ m) { this._sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : String(m ?? ''); return this; };
        return s;
    } };
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [
        { id: 'a', userPromptTemplate: 'SOURCE', dependencies: [] },
        { id: 'b', systemPrompt: 'Use {{a.output}}', userPromptTemplate: 'TARGET', dependencies: ['a'] },
    ] });
    await ex.execute({ userGoal: 'GOAL' });
    assert.ok(systems.some((s) => /Use SOURCE/.test(String(s))), 'the system prompt is interpolated');
});

test('m13: repeating runStep with the same processor does not duplicate it', async () => {
    const processor = { name: 'p', order: 0, process: () => undefined };
    const session = stepSession();
    for (let i = 0; i < 2; i++) {
        await runStep({ step: {}, deps: {
            client: { session: () => session },
            model: 'm',
            session,
            userText: 'x',
            contextProcessors: [processor],
        } });
    }
    assert.equal(session._contextProcessors.length, 1);
});

test('m9: a step that enables toolEvents forwards tool start/end with its payload', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen = [];
    emitter.on('step:tool_start', (e) => seen.push(['start', e.name, e.stepId]));
    emitter.on('step:tool_end', (e) => seen.push(['end', e.name, e.stepId]));
    const session = stepSession();
    session.run = async function (/** @type {any} */ { options }) {
        options.onEvent({ type: 'tool_call_start', name: 'read', args: {} });
        options.onEvent({ type: 'tool_call_end', name: 'read', result: 'ok' });
        this._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
        return 'ok';
    };
    await runStep({ step: { id: 's1' }, deps: {
        client: { session: () => session },
        model: 'm',
        session,
        userText: 'x',
        emitter,
        toolEvents: true,
        events: {
            text: 'step:text',
            thought: 'step:thought',
            toolStart: 'step:tool_start',
            toolEnd: 'step:tool_end',
            makePayload: (/** @type {any} */ { content }) => ({ stepId: 's1', content }),
        },
    } });
    assert.deepEqual(seen, [['start', 'read', 's1'], ['end', 'read', 's1']]);
});

test('WAVE-N 1: the objective pass swallows a stream timeout but rethrows a caller abort', async () => {
    const { runObjectivePass } = await import('../lib/agentic/objective.mjs');
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    /** @returns {any} */
    const timeoutClient = () => ({
        session: () => ({
            run: async () => { throw Object.assign(new Error('Stream inactivity timeout'), { name: 'AbortError', code: 'STREAM_TIMEOUT' }); },
        }),
    });
    const ctx = AgentContext.fromObjective({ objective: 'ORIGINAL' });
    ctx.objectivePolicy = { adaptable: true, hitl: false, firstUpdate: 1, updateTurns: 10, preStep: false };
    const outcomes = [];
    const out = await runObjectivePass({ p: {
        ctx,
        client: timeoutClient(),
        model: 'm',
        emit: (/** @type {any} */ { outcome }) => outcomes.push(outcome),
    } });
    assert.equal(out?.reason, 'restatement_failed', 'a stream timeout is a no-op, not a run cancellation');
    assert.equal(outcomes.length, 1);

    const abortCtx = AgentContext.fromObjective({ objective: 'ORIGINAL' });
    abortCtx.objectivePolicy = { adaptable: true, hitl: false, firstUpdate: 1, updateTurns: 10, preStep: false };
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await assert.rejects(() => runObjectivePass({ p: {
        ctx: abortCtx,
        client: timeoutClient(),
        model: 'm',
        signal: controller.signal,
    } }), /cancel|abort/i);
});

test('WAVE-N 2: the naive DAG engine forwards tool start/end events', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    const fake = stepSession();
    fake.run = async function (/** @type {any} */ { options }) {
        options.onEvent({ type: 'tool_call_start', name: 'read', args: {} });
        options.onEvent({ type: 'tool_call_end', name: 'read', result: 'ok' });
        this._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
        return 'ok';
    };
    const ex = new WorkflowExecutor({ options: { client: { provider: 'openai', session: () => fake }, defaultModel: 'm' } });
    /** @type {any[]} */
    const seen = [];
    ex.on(EVENTS.WORKFLOW.STEP_TOOL_CALL_START, (e) => seen.push(['start', e.name, e.stepId]));
    ex.on(EVENTS.WORKFLOW.STEP_TOOL_CALL_END, (e) => seen.push(['end', e.name, e.stepId]));
    ex.setSteps({ stepsList: [{ id: 's', userPromptTemplate: 'do it' }] });
    await ex.execute({ userGoal: 'goal' });
    assert.deepEqual(seen, [['start', 'read', 's'], ['end', 'read', 's']]);
});

test('WAVE-N 3: skills reach the stateMachine and discussion engines, not only the naive engine', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    for (const engine of ['stateMachine', 'discussion']) {
        /** @type {any[]} */
        const applied = [];
        const fake = stepSession();
        fake.withSkills = (/** @type {any} */ { skills }) => { applied.push(skills); return fake; };
        fake.run = async function () {
            this._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
            return 'ok';
        };
        const client = { provider: 'openai', session: () => fake };
        const ex = new WorkflowExecutor({ options: {
            client,
            defaultModel: 'm',
            skills: [{ name: 'alpha' }],
            agents: engine === 'discussion' ? [{ name: 'a', model: 'm', provider: 'openai' }] : [],
        } });
        ex.setSteps({ stepsList: [{ id: 's', engine, userPromptTemplate: 'do it' }] });
        await ex.execute({ userGoal: 'goal' });
        assert.ok(applied.some((list) => list.some((/** @type {any} */ s) => s.name === 'alpha')), `${engine} must receive the skills capability`);
    }
});

test('WAVE-N 4: withStateMachine reads policy, skills and agent context at execution time', async () => {
    /** @type {any} */
    let captured = null;
    /** @type {any[]} */
    let skills = [];
    const nodeSession = stepSession();
    nodeSession.withSkills = (/** @type {any} */ { skills: s }) => { skills = s; return nodeSession; };
    nodeSession.run = async function () {
        captured = { permissions: this._permissionRules, skills };
        this._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
        return 'ok';
    };
    const parent = minimalSession();
    parent.client = { provider: 'openai', session: () => nodeSession };
    parent.withStateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', userPromptTemplate: 'x' }], edges: [] }, options: { defaultModel: 'm' } });
    parent.withPermissions({ deny: ['bash'] });
    parent.withSkills({ skills: [{ name: 'alpha', description: 'a', instructions: 'A' }] });
    const tool = parent._tools.find((/** @type {any} */ t) => t.name === 'run_state_machine');
    assert.ok(tool, 'state machine tool registered');
    await tool.execute({ args: { context: {} } });
    assert.deepEqual(captured.permissions.deny, ['bash'], 'late withPermissions must apply');
    assert.ok(captured.skills.some((/** @type {any} */ s) => s.name === 'alpha'), 'late withSkills must apply');
});

test('WAVE-N 5: a verify-gated code subagent is not retried by default and gets feedback when opted in', async () => {
    const calls = [];
    const client = /** @type {any} */ ({ provider: 'openai' });
    withTaskAgents({ client, agents: [{ name: 'worker', execute: async (/** @type {any} */ { prompt }) => { calls.push(prompt); return 'bad'; } }] });
    const group = new DiscussionSession({ client, options: {} });
    await group.runTasks({ tasks: [{ title: 't', subagent_type: 'worker', description: 'do', verify: () => ({ passed: false, evidence: 'nope' }) }], sequential: true });
    assert.equal(calls.length, 1, 'default code subagent verify must not re-execute a side-effecting agent');
    assert.match(/** @type {any} */ (group.getLedger()[0]).content, /\[error:/);

    /** @type {string[]} */
    const retryCalls = [];
    const retryClient = /** @type {any} */ ({ provider: 'openai' });
    withTaskAgents({ client: retryClient, agents: [{ name: 'worker2', execute: async (/** @type {any} */ { prompt }) => { retryCalls.push(prompt); return retryCalls.length === 1 ? 'bad' : 'good'; } }] });
    const retryGroup = new DiscussionSession({ client: retryClient, options: {} });
    await retryGroup.runTasks({ tasks: [{
        title: 't', subagent_type: 'worker2', description: 'do', maxRetries: 1,
        verify: (/** @type {any} */ out) => out === 'good' ? { passed: true } : { passed: false, evidence: 'nope' },
    }], sequential: true });
    assert.equal(retryCalls.length, 2);
    assert.match(retryCalls[1], /failed verification|nope/i, 'the retry carries the verify evidence');
});

test('WAVE-N 6: parallel discussion turns advance objective cadence and adopt a unanimous update', async () => {
    const emitter = new EventEmitter();
    /** @type {string[]} */
    const calls = [];
    /** @type {any} */
    let client;
    /** @returns {any} */
    const makeSession = () => {
        const adapter = {
            vendorName: 'FAKE',
            /** @param {{preparedMessages: any}} arg0 */
            buildVendorRequest: ({ preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
            /** @param {{request: any}} arg0 */
            executeVendorRequest: async ({ request }) => (async function* () {
                const text = JSON.stringify(request.preparedMessages);
                const restate = text.includes('You maintain the working objective');
                calls.push(restate ? 'RESTATE' : 'TURN');
                yield { type: 'text', content: restate ? 'RESTATED GOAL' : 'ARGUMENT' };
            })(),
            /** @param {{rawStream: any}} arg0 */
            consumeStream: ({ rawStream }) => rawStream,
            formatToolCall: () => ({}),
            extractXmlToolCalls: () => [],
        };
        return new (class extends AbstractChatSession {
            constructor() {
                super({ provider: 'openai', model: 'm', eventEmitter: emitter, client });
                this._adapter = adapter;
                this._streamTimeoutPolicy = {};
            }
        })();
    };
    client = { provider: 'openai', session: () => makeSession() };
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    const ctx = AgentContext.fromObjective({ objective: 'GOAL' });
    ctx.objectivePolicy = { adaptable: true, hitl: false, firstUpdate: 1, updateTurns: 10, preStep: false };
    const group = new DiscussionSession({ client, options: { objective: 'GOAL', agentContext: ctx } });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'b', model: 'm', provider: 'openai' });
    await group.discuss({ instruction: 'debate', turns: 2, sequential: false });
    assert.equal(calls.filter((c) => c === 'RESTATE').length, 2, 'one restatement per agent in the first turn, none in the second');
    assert.equal(group._agentContext?.objective, 'RESTATED GOAL', 'a unanimous update is adopted');
    assert.equal(group._agentContext?.objectiveTurn, 2, 'the shared turn counter advances across parallel turns');
});

test('WAVE-N 7: utilitySession constructs with the explicit id so session:start is stable', async () => {
    const { utilitySession } = await import('../lib/agentic/planning/planner-utils.mjs');
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const starts = [];
    emitter.on(EVENTS.CLIENT.SESSION_START, (e) => starts.push(e));
    /** @type {any} */
    let client;
    /** @param {string|null} sessionId @returns {any} */
    const make = (sessionId) => new (class extends AbstractChatSession {
        constructor() {
            super({ provider: 'openai', model: 'm', eventEmitter: emitter, client, sessionId });
        }
    })();
    client = /** @type {any} */ ({
        provider: 'openai',
        session: () => make(null),
        sessionWithId: (/** @type {any} */ { sessionId }) => make(sessionId),
    });
    const s = utilitySession({ client, model: 'm', sessionId: 'S' });
    assert.equal(s.sessionId, 'S');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].sessionId, 'S', 'the one session:start carries the explicit id');
});

test('WAVE-N 8: the budget gate counts an unreported step, not only the reported total', async () => {
    const { runAgenticLoop } = await import('../lib/agentic/agentic-core.mjs');
    const { NoRetryPolicy } = await import('../lib/support/retry-policy.mjs');
    let call = 0;
    const tool = { name: 't', description: 't', parameters: { type: 'object', properties: {} }, execute: async () => 'tool-ok' };
    const session = /** @type {any} */ ({
        provider: 'openai', model: 'm', eventEmitter: new EventEmitter(), sessionId: 's', _lastStepMessages: null,
        _tools: [tool], _retryPolicy: new NoRetryPolicy(), _approvalPolicy: null,
        /** @param {{messages: any}} arg0 */
        async *step({ messages }) {
            call++;
            if (call === 1) {
                yield { type: 'quota', data: { prompt_tokens: 900, completion_tokens: 0 } };
                yield { type: 'tool_request', calls: [{ id: 'c1', name: 't', args: {} }] };
                return { done: false, content: '', messages: [...messages,
                    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
                    { role: 'tool', tool_call_id: 'c1', name: 't', content: 'tool-ok' }] };
            }
            const text = 'FINAL-' + 'x'.repeat(400);
            return { done: true, content: text, messages: [...messages, { role: 'assistant', content: text }] };
        },
    });
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [createUserMessage({ provider: 'openai', content: 'go' })], opts: { budget: { maxTotalTokens: 1000 }, maxIterations: 5 } }),
        /budget|exceeded/i,
        'reported 900 + an unreported step must cross the 1000-token cap',
    );
});

test('WAVE-N 9: a delegated task gets the remaining group budget, not the full policy cap', async () => {
    /** @type {any[]} */
    const budgets = [];
    const child = stepSession();
    child.withBudget = (/** @type {any} */ { budget }) => { budgets.push(budget); child._budget = budget; return child; };
    child.run = async function () {
        child._lastStepMessages = [{ role: 'assistant', content: 'ok' }];
        return 'ok';
    };
    const client = /** @type {any} */ ({
        provider: 'openai',
        session: () => child,
        sessionWithId: () => child,
    });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', provider: 'openai' }] });
    const group = new DiscussionSession({ client, options: {
        budget: { maxTotalTokens: 100 },
        sessionPolicy: { budget: { maxTotalTokens: 100 } },
    } });
    group._usageTokens = 60;
    await group.runTasks({ tasks: [{ title: 't', subagent_type: 'worker', description: 'do' }], sequential: true });
    assert.equal(budgets[0]?.maxTotalTokens, 40, 'the child receives the 40 tokens left, not 100');
});

test('WAVE-N 10: a non-participating parallel agent cannot turn a lone restatement into consensus', async () => {
    const emitter = new EventEmitter();
    /** @type {string[]} */
    const calls = [];
    /** @type {any} */
    let client;
    /** @returns {any} */
    const makeSession = () => {
        const adapter = {
            vendorName: 'FAKE',
            /** @param {{preparedMessages: any}} arg0 */
            buildVendorRequest: ({ preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
            /** @param {{request: any}} arg0 */
            executeVendorRequest: async ({ request }) => (async function* () {
                const text = JSON.stringify(request.preparedMessages);
                const restate = text.includes('You maintain the working objective');
                calls.push(restate ? 'RESTATE' : 'TURN');
                yield { type: 'text', content: restate ? 'RESTATED GOAL' : 'ARGUMENT' };
            })(),
            /** @param {{rawStream: any}} arg0 */
            consumeStream: ({ rawStream }) => rawStream,
            formatToolCall: () => ({}),
            extractXmlToolCalls: () => [],
        };
        return new (class extends AbstractChatSession {
            constructor() {
                super({ provider: 'openai', model: 'm', eventEmitter: emitter, client });
                this._adapter = adapter;
                this._streamTimeoutPolicy = {};
            }
        })();
    };
    client = { provider: 'openai', session: () => makeSession() };
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    const ctx = AgentContext.fromObjective({ objective: 'GOAL' });
    ctx.objectivePolicy = { adaptable: true, hitl: false, firstUpdate: 1, updateTurns: 10, preStep: false };
    const group = new DiscussionSession({ client, options: { objective: 'GOAL', agentContext: ctx } });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'b', model: 'm', provider: 'openai', handoff: { goal: 'clean' } });
    await group.discuss({ instruction: 'debate', turns: 1, sequential: false });
    assert.equal(calls.filter((c) => c === 'RESTATE').length, 1);
    assert.equal(group._agentContext?.objective, 'GOAL', 'a lone restatement stays in its child');
    assert.equal(group._agentContext?.objectiveTurn, 1, 'cadence still advances');
});

test('WAVE-N 11: configureSession:false does not apply a session policy or context processors', async () => {
    const processor = { name: 'p', process: () => undefined };
    const session = stepSession();
    session._permissionRules = { allow: [], deny: [], mode: 'default' };
    session._contextProcessors = [];
    await runStep({ step: {}, deps: {
        client: { session: () => session },
        model: 'm',
        session,
        userText: 'x',
        configureSession: false,
        sessionPolicy: { permissions: { allow: [], deny: ['bash'], mode: 'default' } },
        contextProcessors: [processor],
    } });
    assert.deepEqual(session._permissionRules.deny, [], 'the caller session is untouched');
    assert.equal(session._contextProcessors.length, 0);
});

test('WAVE-N 12: a stateSchema does not retry a side-effecting code subagent by default', async () => {
    let calls = 0;
    const client = /** @type {any} */ ({ provider: 'openai' });
    withTaskAgents({ client, agents: [{ name: 'worker', execute: async () => { calls++; return '{"y":1}'; } }] });
    const schema = { safeParse: (/** @type {any} */ value) => value && value.x === 'x' ? { success: true } : { success: false, error: { issues: [{ path: ['x'], message: 'x is required' }] } } };
    const group = new DiscussionSession({ client, options: { stateSchema: schema } });
    await group.runTasks({ tasks: [{ title: 't', subagent_type: 'worker', description: 'do' }], sequential: true });
    assert.equal(calls, 1, 'a code subagent is not re-executed for schema repair by default');
    assert.match(/** @type {any} */ (group.getLedger()[0]).content, /\[error:/);
});

test('B4b: an inherited capability keeps its volatile mark and extra context', async () => {
    const emitter = new EventEmitter();
    const child = stepSession();
    child.withRetryPolicy = () => child;
    child.withStreamTimeout = () => child;
    child.withHeaderTimeout = () => child;
    child.withMaxElapsedMs = () => child;
    child.withApproval = () => child;
    child.withBudget = () => child;
    /** @type {Array<any>} */
    const registered = [];
    child.withCapability = (/** @type {any} */ arg) => { registered.push(arg); return child; };

    const component = { id: 'live', startupAnnounce: () => null, toLoadTool: () => null, toSaveTool: () => null };
    const client = /** @type {any} */ ({ provider: 'openai', session: () => child });
    const parent = /** @type {any} */ ({
        client,
        model: 'm',
        provider: 'openai',
        eventEmitter: emitter,
        sessionId: 'sess-inherit',
        _taskDepth: 0,
        _taskMaxDepth: 1,
        _extraStepComponents: [{ component, preload: true, errorLabel: 'live block failed', rethrowAbort: false, volatile: true, extra: { mode: 'per-step' } }],
    });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const tool = /** @type {any} */ (createTaskTool({ session: parent }));
    await tool.execute({ args: { subagent_type: 'worker', prompt: 'go', background: true } });
    const pending = [...getSpawnRegistry({ client }).background.values()][0];
    await pending;

    const inherited = registered.find((entry) => entry?.capability === component);
    assert.ok(inherited, 'the capability must be inherited by the child');
    assert.equal(inherited.volatile, true, 'a live-state block must stay volatile in the child');
    assert.deepEqual(inherited.extra, { mode: 'per-step' }, 'extra context must survive inheritance');
});
