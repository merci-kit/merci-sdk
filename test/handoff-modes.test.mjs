// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import {
    AgentContext, normalizeHandoff, goalBlockForHandoff,
    HANDOFF_MODERATED_MARKER, merciEnvelope, contextFromMerciEnvelope,
} from '../lib/index.mjs';
import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { OBJECTIVE_AUTHORITY_NOTE } from '../lib/agentic/agent-context.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { loadA2ATool } from '../lib/tools/a2a.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/**
 * @param {any} messages
 */
/** @param {{messages: *}} arg0 */
const flat = ({ messages }) =>
    (Array.isArray(messages) ? messages : [messages]).map(/** @type {(m: any) => string} */ (m => String(m?.content ?? ''))).join('\n');

function makeRecordingClient() {
    const toolsCalls = /** @type {any[]} */ ([]);
    const runs = /** @type {any[]} */ ([]);
    const client = {
        toolsCalls, runs,
        session: () => {
            const s = {
                provider: 'openai',
                /** @type {any} */
                _permissionRules: null,
                /** @type {any} */
                _toolAllowlists: null,
                withSystemMessage() { return s; },
                /** @param {{tools: any}} arg0 */
                withTools({ tools }) { toolsCalls.push(tools); return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                /** @param {any} rules */
                withPermissions(rules) { s._permissionRules = rules; return s; },
                /** @param {{patterns?: string[]|null}} [arg0] */
                withToolAllowlist({ patterns = [] } = {}) { s._toolAllowlists = [...(s._toolAllowlists ?? []), patterns]; return s; },
                /** @param {{initialInput: any}} arg0 */
                async run({ initialInput: messages }) { runs.push(messages); return 'child answer'; },
            };
            return s;
        },
    };
    return /** @type {any} */ (client);
}

function makeCapturingClient() {
    const calls = /** @type {any[]} */ ([]);
    const systems = /** @type {any[]} */ ([]);
    const client = {
        calls,
        systems,
        session: () => ({
            provider: 'openai',
            _system: '',
            /** @type {any} */
            _permissionRules: null,
            /** @type {any} */
            _toolAllowlists: null,
            withSystemMessage(/** @type {any} */ msg) { this._system = Array.isArray(msg) ? msg.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : String(msg ?? ''); return this; },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            /** @param {any} rules */
            withPermissions(rules) { this._permissionRules = rules; return this; },
            /** @param {{patterns?: string[]|null}} [arg0] */
            withToolAllowlist({ patterns = [] } = {}) { this._toolAllowlists = [...(this._toolAllowlists ?? []), patterns]; return this; },
            /** @param {{initialInput: any}} arg0 */
            async run({ initialInput: input }) {
                if (isObjectiveRestatePrompt({ input })) return '';
                calls.push(input); systems.push(this._system); return 'child answer';
            },
        }),
    };
    return /** @type {any} */ (client);
}

describe('normalizeHandoff: defaults + fail-fast enums', () => {
    it('defaults to goal full, context undefined, tools inherit', () => {
        assert.deepEqual(normalizeHandoff(), { goal: 'full', context: undefined, tools: 'inherit' });
        assert.deepEqual(normalizeHandoff({ handoff: null }), { goal: 'full', context: undefined, tools: 'inherit' });
    });

    it('throws on an invalid goal / context / tools value', () => {
        assert.throws(() => normalizeHandoff({ handoff: { goal: 'sideways' } }), /handoff\.goal/);
        assert.throws(() => normalizeHandoff({ handoff: { context: 'sideways' } }), /handoff\.context/);
        assert.throws(() => normalizeHandoff({ handoff: /** @type {any} */ ({ tools: 42 }) }), /handoff\.tools/);
    });

    it('accepts every documented value (free combination)', () => {
        assert.deepEqual(normalizeHandoff({ handoff: { goal: 'clean', context: 'moderated', tools: 'none' } }),
            { goal: 'clean', context: 'moderated', tools: 'none' });
        assert.deepEqual(normalizeHandoff({ handoff: { tools: ['a', 'b'] } }).tools, ['a', 'b']);
    });
});

describe('goalBlockForHandoff: clean / full / moderated', () => {
    const ctx = AgentContext.fromObjective({ objective: 'GOAL-1' });

    it('clean returns the empty string', () => {
        assert.equal(goalBlockForHandoff({ ctx, handoff: { goal: 'clean' } }), '');
    });

    it('full returns the exact objective block (goal + authority note)', () => {
        const expected = `[Global Objective]\nGOAL-1\n${OBJECTIVE_AUTHORITY_NOTE}`;
        assert.equal(goalBlockForHandoff({ ctx, handoff: { goal: 'full' } }), expected);
        assert.equal(goalBlockForHandoff({ ctx }), expected, 'default is full');
    });

    it('moderated returns the full block plus the exact marker', () => {
        assert.equal(goalBlockForHandoff({ ctx, handoff: { goal: 'moderated' } }),
            `[Global Objective]\nGOAL-1\n${OBJECTIVE_AUTHORITY_NOTE}\n${HANDOFF_MODERATED_MARKER}`);
        assert.equal(HANDOFF_MODERATED_MARKER, '[Handoff: context compacted; goal carried in full]');
    });

    it('returns empty when there is no objective at all', () => {
        assert.equal(goalBlockForHandoff({ ctx: null, handoff: { goal: 'full' } }), '');
    });
});

describe('task tool: handoff goal clean drops the parent objective', () => {
    it('keeps explicit args.objective/context, drops the inherited block', async () => {
        const client = makeRecordingClient();
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({
            client, model: 'm', provider: 'openai',
            eventEmitter: new EventEmitter(),
            _agentContext: AgentContext.fromObjective({ objective: 'PARENT GOAL' }),
        }) });
        await /** @type {any} */ (tool).execute({ args: {
            subagent_type: 'worker', prompt: 'Do X',
            objective: 'EXPLICIT SUBTASK', context: 'explicit ctx',
            handoff: { goal: 'clean' },
        } });
        const input = flat({ messages: client.runs[0] });
        assert.equal(input.includes('PARENT GOAL'), false, 'inherited objective is gone');
        assert.equal(input.includes('[Global Objective]'), false, 'no inherited block');
        assert.ok(input.includes('EXPLICIT SUBTASK'), 'explicit objective still applies');
        assert.ok(input.includes('explicit ctx'), 'explicit context still applies');
    });
});

describe('task tool: handoff tools', () => {
    it("tools:'none' drops the profile tool belt", async () => {
        const client = makeRecordingClient();
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', tools: ['alpha', 'beta'] }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({ client, model: 'm', provider: 'openai', eventEmitter: new EventEmitter() }) });
        await /** @type {any} */ (tool).execute({ args: { subagent_type: 'worker', prompt: 'Do X', handoff: { tools: 'none' } } });
        assert.equal(client.toolsCalls.length, 0, 'no withTools call at all');
    });

    it('inherit keeps the profile tool belt', async () => {
        const client = makeRecordingClient();
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', tools: ['alpha', 'beta'] }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({ client, model: 'm', provider: 'openai', eventEmitter: new EventEmitter() }) });
        await /** @type {any} */ (tool).execute({ args: { subagent_type: 'worker', prompt: 'Do X' } });
        assert.ok(client.toolsCalls.some((/** @type {any} */ t) => Array.isArray(t) && t.includes('alpha')), 'profile tools ride');
    });
});

describe('task tool: START carries an id in background mode', () => {
    it('emits task:start with a minted id', async () => {
        const client = makeRecordingClient();
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
        const emitter = new EventEmitter();
        const starts = /** @type {any[]} */ ([]);
        emitter.on(EVENTS.TASK.START, e => starts.push(e));
        const tool = createTaskTool({ session: /** @type {any} */ ({ client, model: 'm', provider: 'openai', eventEmitter: emitter }) });
        await /** @type {any} */ (tool).execute({ args: { subagent_type: 'worker', prompt: 'Do X', background: true } });
        assert.equal(starts.length, 1);
        assert.ok(String(starts[0].id ?? '').startsWith('task_'), 'the id is present before the child settles');
        assert.equal(starts[0].background, true);
    });
});

describe('state machine: objective survives save()/load()', () => {
    const graph = {
        entry: 'step',
        nodes: [{ id: 'step', systemPrompt: 'sys', userPromptTemplate: 'Do it.' }],
        edges: [],
    };

    it('a new save round-trips the objective', () => {
        const sm = new StateMachine({ graph: graph, options: { client: makeCapturingClient(), defaultModel: 'm', objective: 'SM GOAL' } });
        const loaded = StateMachine.load({ json: sm.save(), graph: graph, options: { client: makeCapturingClient(), defaultModel: 'm' } });
        assert.equal(JSON.parse(loaded.save()).objective, 'SM GOAL');
    });

    it('an old save without objective keys loads with a null objective', () => {
        const sm = new StateMachine({ graph: graph, options: { client: makeCapturingClient(), defaultModel: 'm', objective: 'SM GOAL' } });
        const old = JSON.parse(sm.save());
        delete old.objective;
        delete old.objectiveInjected;
        delete old.handoff;
        const loaded = StateMachine.load({ json: JSON.stringify(old), graph: graph, options: { client: makeCapturingClient(), defaultModel: 'm' } });
        const restored = JSON.parse(loaded.save());
        assert.equal(restored.objective, null);
        assert.equal(restored.objectiveInjected, false);
    });
});

describe('DAG executor: per-step handoff', () => {
    it("context:'clean' drops the upstream intake block", async () => {
        const client = makeCapturingClient();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [
            { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] },
            { id: 'b', title: 'B', systemPrompt: 'sys-b', userPromptTemplate: 'Do B.', dependencies: ['a'], handoff: { context: 'clean' } },
        ] });
        await executor.execute({ userGoal: 'DAG GOAL' });
        const bPrompt = client.calls[1][client.calls[1].length - 1].content;
        assert.equal(bPrompt.includes('=== Upstream Step Context ==='), false, 'intake dropped');
        assert.ok(String(client.systems[1]).includes('DAG GOAL'), 'objective still rides (system slot)');
    });

    it('the default keeps the upstream intake block', async () => {
        const client = makeCapturingClient();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [
            { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] },
            { id: 'b', title: 'B', systemPrompt: 'sys-b', userPromptTemplate: 'Do B.', dependencies: ['a'] },
        ] });
        await executor.execute({ userGoal: 'DAG GOAL' });
        const bPrompt = client.calls[1][client.calls[1].length - 1].content;
        assert.ok(bPrompt.includes('=== Upstream Step Context ==='), 'intake present by default');
    });

    it("goal:'clean' drops the objective block; 'moderated' appends the marker", async () => {
        const cleanClient = makeCapturingClient();
        const cleanExec = new WorkflowExecutor({ options: { client: cleanClient, defaultModel: 'm' } });
        cleanExec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'sys', userPromptTemplate: 'Do A.', dependencies: [], handoff: { goal: 'clean' } }] });
        await cleanExec.execute({ userGoal: 'DAG GOAL' });
        const cleanPrompt = cleanClient.calls[0][cleanClient.calls[0].length - 1].content;
        assert.equal(cleanPrompt.includes('DAG GOAL'), false, 'objective dropped');
        assert.equal(String(cleanClient.systems[0]).includes('[Global Objective]'), false, 'no block');

        const modClient = makeCapturingClient();
        const modExec = new WorkflowExecutor({ options: { client: modClient, defaultModel: 'm' } });
        modExec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'sys', userPromptTemplate: 'Do A.', dependencies: [], handoff: { goal: 'moderated' } }] });
        await modExec.execute({ userGoal: 'DAG GOAL' });
        const modSystem = String(modClient.systems[0]);
        assert.ok(modSystem.includes('DAG GOAL'), 'objective carried in full (system slot)');
        assert.ok(modSystem.includes(HANDOFF_MODERATED_MARKER), 'marker appended');
    });
});

describe('discussion: agent handoff goal clean drops objective + ledger', () => {
    it('the objective is absent for a clean agent, present by default', async () => {
        const cleanClient = makeCapturingClient();
        const cleanGroup = new DiscussionSession({ client: cleanClient, options: { objective: 'GROUP GOAL: debate the motion' } });
        cleanGroup.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: ProviderType.OPENAI, handoff: { goal: 'clean' } });
        await cleanGroup.discuss({ instruction: 'Take a stance.', turns: 1 });
        const cleanInput = flat({ messages: cleanClient.calls[0] });
        assert.equal(cleanInput.includes('GROUP GOAL: debate the motion'), false, 'objective dropped');
        assert.ok(cleanInput.includes('Take a stance.'), 'instruction kept');

        const fullClient = makeCapturingClient();
        const fullGroup = new DiscussionSession({ client: fullClient, options: { objective: 'GROUP GOAL: debate the motion' } });
        fullGroup.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: ProviderType.OPENAI });
        await fullGroup.discuss({ instruction: 'Take a stance.', turns: 1 });
        const fullInput = flat({ messages: fullClient.calls[0] });
        assert.ok(fullInput.includes('GROUP GOAL: debate the motion'), 'objective present by default');
    });

    it('a clean agent does not see the prior ledger entry', async () => {
        const client = makeCapturingClient();
        const group = new DiscussionSession({ client, options: { objective: 'GROUP GOAL' } });
        group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: ProviderType.OPENAI });
        group.addAgent({ name: 'B', persona: 'p', model: 'mB', provider: ProviderType.OPENAI, handoff: { goal: 'clean', context: 'clean' } });
        await group.discuss({ instruction: 'Speak.', turns: 1 });
        const bInput = flat({ messages: client.calls[1] });
        assert.equal(bInput.includes('child answer'), false, 'prior ledger entry dropped');
        assert.equal(bInput.includes('GROUP GOAL'), false, 'objective dropped');
        assert.ok(bInput.includes('Speak.'), 'instruction kept');
    });
});

describe('A2A: _merci envelope', () => {
    it('merciEnvelope/contextFromMerciEnvelope round-trip (nulls omitted)', () => {
        const env = merciEnvelope({ ctx: AgentContext.fromObjective({ objective: 'REMOTE GOAL' }) });
        assert.deepEqual(env, { objective: 'REMOTE GOAL' });
        const ctx = /** @type {any} */ (contextFromMerciEnvelope({ env }));
        assert.equal(ctx.objective, 'REMOTE GOAL');
        assert.equal(contextFromMerciEnvelope({ env: {} }), null, 'empty envelope restores nothing');
    });

    it('loadA2ATool.execute carries the envelope and the arguments in the A2A request', async () => {
        const originalFetch = globalThis.fetch;
        const bodies = /** @type {any[]} */ ([]);
        globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts = {}) => {
            if (String(url).includes('agent-card.json')) {
                // ponytail: the loader reads bodies via .text() (size-capped) —
                return { ok: true, text: async () => JSON.stringify({ skills: [{ id: 'ping', name: 'ping', description: 'd' }] }) };
            }
            bodies.push(JSON.parse(opts.body));
            return {
                ok: true,
                text: async () => JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        task: {
                            id: 'task-1',
                            contextId: 'ctx-1',
                            status: {
                                state: 'TASK_STATE_COMPLETED',
                                message: { messageId: 'm-1', contextId: 'ctx-1', taskId: 'task-1', role: 'ROLE_AGENT', parts: [{ text: 'remote-ok' }] }
                            },
                            artifacts: [],
                            history: []
                        }
                    }
                })
            };
        });
        try {
            const tools = await loadA2ATool({ agentUrl: 'https://agent.example.com', eventEmitter: null, agentContext: AgentContext.fromObjective({ objective: 'REMOTE GOAL' }) });
            assert.equal(tools.length, 1, 'card loaded');
            const out = await tools[0].execute({ args: { q: 'hi' } });
            assert.equal(out, 'remote-ok');
            assert.equal(bodies[0].method, 'SendMessage', 'the A2A v1.0 method is used');
            assert.equal(bodies[0].params.metadata.merci.objective, 'REMOTE GOAL', 'the objective rides in the conformant metadata slot');
            assert.equal(bodies[0].params._merci.objective, 'REMOTE GOAL', 'and in the legacy slot');
            const parts = /** @type {any[]} */ (bodies[0].params.message.parts);
            const data = parts.find((p) => p.data !== undefined);
            assert.equal(data.data.q, 'hi', 'the original arguments are preserved');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('_merci envelope: strict-but-loud receive', () => {
    it('absent/null/empty restore nothing', () => {
        assert.equal(contextFromMerciEnvelope({ env: /** @type {any} */ (undefined) }), null, 'absent');
        assert.equal(contextFromMerciEnvelope({ env: null }), null, 'null');
        assert.equal(contextFromMerciEnvelope({ env: {} }), null, 'empty object');
    });

    it('passes an AgentContext instance through unchanged', () => {
        const ctx = AgentContext.fromObjective({ objective: 'PASS-THROUGH' });
        assert.equal(contextFromMerciEnvelope({ env: ctx }), ctx);
    });

    it('throws on a present-but-malformed envelope instead of silently nulling', () => {
        assert.throws(() => contextFromMerciEnvelope({ env: /** @type {any} */ ('nope') }), /_merci envelope/);
        assert.throws(() => contextFromMerciEnvelope({ env: /** @type {any} */ ({ objective: 42 }) }), /_merci\.objective/);
        assert.throws(() => contextFromMerciEnvelope({ env: /** @type {any} */ ({ directive: 42 }) }), /_merci\.directive/);
        assert.throws(() => contextFromMerciEnvelope({ env: /** @type {any} */ ({ refs: 'nope' }) }), /_merci\.refs/);
    });

    it('restores a valid envelope', () => {
        const ctx = /** @type {any} */ (contextFromMerciEnvelope({ env: { objective: 'GOAL-1', directive: 'DIR-1', refs: { a: 1 } } }));
        assert.equal(ctx.objective, 'GOAL-1');
        assert.equal(ctx.directive, 'DIR-1');
        assert.deepEqual(ctx.refs, { a: 1 });
    });
});

describe('discussion group: goal clean drops session-level inherit', () => {
    const stubClient = { session: () => { throw new Error('no LLM in this test'); } };

    it('clean group carries no AgentContext (nested hops stay clean)', () => {
        const group = new DiscussionSession({ client: stubClient, options: {
            objective: 'GROUP GOAL',
            handoff: { goal: 'clean' },
        } });
        assert.equal(group._agentContext, null, 'no inherited context on a clean group');
        assert.equal(group._objective, 'GROUP GOAL', 'objective string itself is kept');
    });

    it('default group keeps the AgentContext (today\'s behavior)', () => {
        const group = new DiscussionSession({ client: stubClient, options: { objective: 'GROUP GOAL' } });
        assert.ok(group._agentContext, 'context present by default');
        assert.equal(/** @type {any} */ (group._agentContext).objective, 'GROUP GOAL');
    });

    it('explicit agentContext wins over clean (replacement, not inheritance)', () => {
        const explicit = AgentContext.fromObjective({ objective: 'EXPLICIT' });
        const group = new DiscussionSession({ client: stubClient, options: {
            objective: 'GROUP GOAL',
            agentContext: explicit,
            handoff: { goal: 'clean' },
        } });
        assert.equal(group._agentContext, explicit);
    });
});

describe('planner prompts: handoff rules present (template lock, not model behavior)', () => {
    it('DAG plan prompt carries rule 7 (handoff only for non-defaults)', async () => {
        const { DAG_WORKFLOW_PLAN_PROMPT } = await import('../lib/core/prompts/dag.mjs');
        assert.ok(DAG_WORKFLOW_PLAN_PROMPT({ objective: 'goal', toolsList: [] }).includes('"handoff" only when'), 'rule 7 present');
    });

    it('SM plan prompt carries rule 6 (handoff only for non-defaults)', async () => {
        const { SM_PLAN_PROMPT } = await import('../lib/core/prompts/sm.mjs');
        assert.ok(SM_PLAN_PROMPT({ objective: 'goal', toolsList: [] }).includes('"handoff" only for'), 'rule 6 present');
    });
});
