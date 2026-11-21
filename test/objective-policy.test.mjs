// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import {
    DEFAULT_OBJECTIVE_POLICY,
    normalizeObjectivePolicy,
    shouldRunObjectivePass,
    restateObjective,
    isObjectiveRestatePrompt,
    objectiveProgressDigest,
} from '../lib/agentic/objective.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/system-message.mjs';

/** @param {{text: *}} arg0 */
const oaiTextChunks = ({ text }) => (async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
    yield { usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } };
})();

/**
 * A stub that serves BOTH roles: the vendor client (chat.completions.create)
 * and the SDK client (session() + the EventEmitter API the session emits on).
 * `client.session(model)` passes the client itself as the event emitter, so the
 * session's `this.client` is this object.
 * @param {{ opts?: { restated?: string, onRestate?: Function|null, chat?: Function|null } }} [arg0]
 */
class StubClient extends EventEmitter {
    /** @param {{ opts?: { restated?: string, onRestate?: Function|null, chat?: Function|null } }} [arg0] */
    constructor({ opts = {} } = {}) {
        super();
        this.opts = opts;
        this.order = /** @type {string[]} */ ([]);
        this.restatePrompts = /** @type {string[]} */ ([]);
        this.chatParams = /** @type {any[]} */ ([]);
        this.chat = {
            completions: {
                create: async (/** @type {any} */ params) => {
                    this.order.push('chat');
                    this.chatParams.push(params);
                    if (opts.chat) return opts.chat(params);
                    return oaiTextChunks({ text: 'answer' })[Symbol.asyncIterator]();
                },
            },
        };
    }
    /** @param {string} _model */
    session(_model) {
        return {
            /** @param {{ initialInput: string, options?: any }} params */
            run: async ({ initialInput }) => {
                this.order.push('restate');
                this.restatePrompts.push(initialInput);
                if (this.opts.onRestate) return this.opts.onRestate(this.restatePrompts.length, initialInput);
                return this.opts.restated ?? 'RESTATED OBJECTIVE';
            },
        };
    }
}

/** @param {{ opts?: { restated?: string, onRestate?: Function|null, chat?: Function|null } }} [arg0] */
const makeStub = ({ opts = {} } = {}) => new StubClient({ opts });

/**
 * @param {{stub: any, objective?: string|null, options?: any}} arg0
 */
function makeSession({ stub, objective = null, options = undefined }) {
    const session = new OaiChatSession({ client: stub, model: 'gpt-4o-mini', eventEmitter: stub });
    if (objective !== null) session.withObjective({ ctx: objective, options });
    return session;
}

describe('normalizeObjectivePolicy', () => {
    it('defaults: adaptable true, hitl false, firstUpdate 1, updateTurns 10', () => {
        assert.deepEqual(normalizeObjectivePolicy(), { ...DEFAULT_OBJECTIVE_POLICY });
        assert.deepEqual(normalizeObjectivePolicy({}), { ...DEFAULT_OBJECTIVE_POLICY });
        assert.equal(DEFAULT_OBJECTIVE_POLICY.adaptable, true);
        assert.equal(DEFAULT_OBJECTIVE_POLICY.hitl, false);
    });

    it('honors explicit values and coerces only the booleans', () => {
        assert.deepEqual(normalizeObjectivePolicy({ opts: { adaptable: false, hitl: true, firstUpdate: 3, updateTurns: 7 } }),
            { adaptable: false, hitl: true, firstUpdate: 3, updateTurns: 7, preStep: false });
    });

    it('falls back to the default cadence on a bad value (never throws mid-run)', () => {
        const p = normalizeObjectivePolicy({ opts: { firstUpdate: 0, updateTurns: -2 } });
        assert.equal(p.firstUpdate, 1);
        assert.equal(p.updateTurns, 10);
        assert.equal(normalizeObjectivePolicy({ opts: { firstUpdate: 2.5 } }).firstUpdate, 1);
    });
});

describe('shouldRunObjectivePass cadence', () => {
    it('fires at firstUpdate then every updateTurns (default 1, 11, 21)', () => {
        const p = normalizeObjectivePolicy();
        const fired = [];
        for (let turn = 1; turn <= 25; turn++) if (shouldRunObjectivePass({ policy: p, turn })) fired.push(turn);
        assert.deepEqual(fired, [1, 11, 21]);
    });

    it('honors a custom firstUpdate', () => {
        const p = normalizeObjectivePolicy({ opts: { firstUpdate: 3, updateTurns: 5 } });
        const fired = [];
        for (let turn = 1; turn <= 20; turn++) if (shouldRunObjectivePass({ policy: p, turn })) fired.push(turn);
        assert.deepEqual(fired, [3, 8, 13, 18]);
    });

    it('never fires when adaptable is off', () => {
        assert.equal(shouldRunObjectivePass({ policy: normalizeObjectivePolicy({ opts: { adaptable: false } }), turn: 1 }), false);
        assert.equal(shouldRunObjectivePass({ policy: normalizeObjectivePolicy({ opts: { adaptable: false } }), turn: 11 }), false);
    });
});

describe('restateObjective guards', () => {
    it('returns null when there is no client session factory', async () => {
        assert.equal(await restateObjective({ client: {}, model: 'm', objective: 'x' }), null);
    });

    it('returns null on an empty / fallback / over-long answer', async () => {
        const empty = makeStub({ opts: { restated: '   ' } });
        assert.equal(await restateObjective({ client: empty, model: 'm', objective: 'x' }), null);
        const fallback = makeStub({ opts: { restated: FALLBACK_MESSAGE.EMPTY_RESPONSE } });
        assert.equal(await restateObjective({ client: fallback, model: 'm', objective: 'x' }), null);
        const huge = makeStub({ opts: { restated: 'x'.repeat(LIMITS.objective_max_chars + 1) } });
        assert.equal(await restateObjective({ client: huge, model: 'm', objective: 'x' }), null);
    });

    it('feeds the current objective and the work digest into the prompt', async () => {
        const stub = makeStub({ opts: { restated: 'NEW' } });
        const out = await restateObjective({ client: stub, model: 'm', objective: 'OLD GOAL', progress: 'did some work' });
        assert.equal(out, 'NEW');
        assert.ok(stub.restatePrompts[0].includes('OLD GOAL'));
        assert.ok(stub.restatePrompts[0].includes('did some work'));
    });
});

describe('objective restatement pass', () => {
    it('derives the objective from the first user message BEFORE the first model call', async () => {
        const stub = makeStub({ opts: { restated: 'RESTATED OBJECTIVE' } });
        const session = makeSession({ stub, objective: 'ORIGINAL GOAL' });
        await session.run({ initialInput: 'plan a trip to Rome' });

        assert.deepEqual(stub.order.slice(0, 2), ['restate', 'chat'],
            'the pass runs before the model call');
        assert.ok(stub.restatePrompts[0].includes('ORIGINAL GOAL'), 'the current objective rides the prompt');
        assert.ok(stub.restatePrompts[0].includes('plan a trip to Rome'), 'the intake rides the prompt');
        assert.equal((/** @type {any} */ (session._agentContext)).objective, 'RESTATED OBJECTIVE');
        assert.equal((/** @type {any} */ (session._agentContext)).objectiveInitial, 'ORIGINAL GOAL', 'the passed value is kept as the initial one');
        assert.equal((/** @type {any} */ (session._agentContext)).objectiveVersion, 1);
        assert.ok(JSON.stringify(stub.chatParams[0].messages).includes('RESTATED OBJECTIVE'),
            'the first model call already carries the restated objective');
    });

    it('emits run:objective_updated with the previous text and the version', async () => {
        const stub = makeStub({ opts: { restated: 'RESTATED' } });
        const session = makeSession({ stub, objective: 'ORIGINAL' });
        const events = /** @type {any[]} */ ([]);
        /** @type {any} */ (session.eventEmitter).on(EVENTS.CLIENT.OBJECTIVE_UPDATED, (/** @type {any} */ e) => events.push(e));
        await session.run({ initialInput: 'go' });
        assert.equal(events.length, 1);
        assert.equal(events[0].applied, true);
        assert.equal(events[0].previous, 'ORIGINAL');
        assert.equal(events[0].objective, 'RESTATED');
        assert.equal(events[0].version, 1);
        assert.equal(events[0].reason, 'cadence');
    });

    it('adaptable:false freezes the objective — no restatement call at all', async () => {
        const stub = makeStub({ opts: { restated: 'RESTATED' } });
        const session = makeSession({ stub, objective: 'ORIGINAL', options: { adaptable: false } });
        await session.run({ initialInput: 'go' });
        assert.equal(stub.restatePrompts.length, 0);
        assert.equal((/** @type {any} */ (session._agentContext)).objective, 'ORIGINAL');
        assert.equal((/** @type {any} */ (session._agentContext)).objectiveVersion, 0);
    });

    it('a same-text restatement is a no-op (no version churn, no event)', async () => {
        const stub = makeStub({ opts: { restated: 'ORIGINAL' } });
        const session = makeSession({ stub, objective: 'ORIGINAL' });
        const events = /** @type {any[]} */ ([]);
        /** @type {any} */ (session.eventEmitter).on(EVENTS.CLIENT.OBJECTIVE_UPDATED, (/** @type {any} */ e) => events.push(e));
        await session.run({ initialInput: 'go' });
        assert.equal((/** @type {any} */ (session._agentContext)).objectiveVersion, 0);
        assert.equal(events.length, 0);
    });

    it('a failed restatement keeps the previous objective and surfaces why', async () => {
        const stub = makeStub({ opts: { onRestate: () => { throw new Error('gateway down'); } } });
        const session = makeSession({ stub, objective: 'ORIGINAL' });
        const events = /** @type {any[]} */ ([]);
        /** @type {any} */ (session.eventEmitter).on(EVENTS.CLIENT.OBJECTIVE_UPDATED, (/** @type {any} */ e) => events.push(e));
        const answer = await session.run({ initialInput: 'go' });
        assert.equal(answer, 'answer', 'the run completes');
        assert.equal((/** @type {any} */ (session._agentContext)).objective, 'ORIGINAL');
        assert.equal(events.length, 1);
        assert.equal(events[0].applied, false);
        assert.equal(events[0].reason, 'restatement_failed');
        assert.match(events[0].error, /gateway down/);
    });

    it('the cadence spans run() calls and honors updateTurns', async () => {
        const stub = makeStub({ opts: { restated: 'RESTATED' } });
        const session = makeSession({ stub, objective: 'ORIGINAL', options: { firstUpdate: 1, updateTurns: 3 } });
        for (let i = 0; i < 4; i++) await session.run({ initialInput: `turn ${i}` });
        assert.equal(stub.restatePrompts.length, 2);
        assert.equal((/** @type {any} */ (session._agentContext)).objectiveTurn, 4);
    });

    it('hitl:true applies an approved change', async () => {
        const stub = makeStub({ opts: { restated: 'RESTATED' } });
        const session = makeSession({ stub, objective: 'ORIGINAL', options: { hitl: true } });
        const seen = /** @type {any[]} */ ([]);
        session.withApproval({ fn: (/** @type {string} */ name, /** @type {any} */ payload) => {
            seen.push({ name, payload });
            return true;
        } });
        await session.run({ initialInput: 'go' });
        assert.equal((/** @type {any} */ (session._agentContext)).objective, 'RESTATED');
        assert.equal(seen.length, 1);
        assert.equal(seen[0].name, 'objective_update');
        assert.equal(seen[0].payload.previous, 'ORIGINAL');
        assert.equal(seen[0].payload.objective, 'RESTATED');
    });

    it('hitl:true keeps the previous objective when declined', async () => {
        const stub = makeStub({ opts: { restated: 'RESTATED' } });
        const session = makeSession({ stub, objective: 'ORIGINAL', options: { hitl: true } });
        const events = /** @type {any[]} */ ([]);
        /** @type {any} */ (session.eventEmitter).on(EVENTS.CLIENT.OBJECTIVE_UPDATED, (/** @type {any} */ e) => events.push(e));
        session.withApproval({ fn: () => false });
        await session.run({ initialInput: 'go' });
        assert.equal((/** @type {any} */ (session._agentContext)).objective, 'ORIGINAL');
        assert.equal((/** @type {any} */ (session._agentContext)).objectiveVersion, 0);
        assert.equal(events.length, 1);
        assert.equal(events[0].applied, false);
        assert.equal(events[0].reason, 'hitl_declined');
    });

    it('hitl:true does not open a gate when the restatement changes nothing', async () => {
        const stub = makeStub({ opts: { restated: 'ORIGINAL' } });
        const session = makeSession({ stub, objective: 'ORIGINAL', options: { hitl: true } });
        let gates = 0;
        session.withApproval({ fn: () => { gates++; return true; } });
        await session.run({ initialInput: 'go' });
        assert.equal(gates, 0, 'no gate on a no-op pass');
    });
});

describe('DAG executor shares one mutable objective', () => {
    it('a restatement in step A is visible to step B (one context, one cadence)', async () => {
        const { client, systems } = makeExecutorStub();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [
            { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] },
            { id: 'b', title: 'B', systemPrompt: 'sys-b', userPromptTemplate: 'Do B.', dependencies: ['a'] },
        ] });
        await executor.execute({ userGoal: 'DAG GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { firstUpdate: 1, updateTurns: 1 } });

        assert.equal(systems.length, 2, 'both steps ran');
        assert.ok(systems[0].includes('RESTATED OBJECTIVE'),
            'step A already runs on the restated objective');
        assert.ok(systems[1].includes('RESTATED OBJECTIVE'),
            'step B sees the restated objective (the objective is shared; wave 12 / D6: the refs are not)');
        assert.equal(/** @type {any} */ (executor._agentContext).objectiveVersion, 1,
            'the restatement applied once (a same-text pass is a no-op)');
        assert.equal(/** @type {any} */ (executor._agentContext).objectiveInitial, 'DAG GOAL',
            'the execute() goal is kept as the initial value');
    });

    it('adaptable:false leaves the executor objective frozen', async () => {
        const { client, systems } = makeExecutorStub();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [
            { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] },
        ] });
        await executor.execute({ userGoal: 'DAG GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { adaptable: false } });
        assert.ok(systems[0].includes('DAG GOAL'));
        assert.equal(systems[0].includes('RESTATED OBJECTIVE'), false);
        assert.equal(/** @type {any} */ (executor._agentContext).objectiveVersion, 0);
    });
});

function makeExecutorStub() {
    const systems = /** @type {string[]} */ ([]);
    const runs = /** @type {any[]} */ ([]);
    const client = /** @type {any} */ (new EventEmitter());
    client.session = () => ({
        provider: 'openai',
        _system: '',
        withSystemMessage(/** @type {any} */ m) { this._system = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : String(m ?? ''); return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{initialInput: *}} arg0 */
        async run({ initialInput: input }) {
            if (isObjectiveRestatePrompt({ input })) return 'RESTATED OBJECTIVE';
            systems.push(this._system);
            runs.push(input);
            return 'answer';
        },
    });
    return { client, systems, runs };
}

describe('preStep opt-in (stateMachine / discussion engines)', () => {
    const STEP = { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] };
    /** @param {{input: *}} arg0 */
    const flat = ({ input }) => JSON.stringify(input);

    it('stateMachine: default false leaves the node prompt on the pre-restatement objective', async () => {
        const { client, systems } = makeExecutorStub();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'stateMachine' } });
        executor.setSteps({ stepsList: [STEP] });
        await executor.execute({ userGoal: 'DAG GOAL' });
        assert.ok(systems[0].includes('DAG GOAL'), 'the prompt was built before the pass');
        assert.equal(systems[0].includes('RESTATED OBJECTIVE'), false,
            'the node runs on the pre-restatement objective (the loop pass still covers the next node/turn — see the session-level tests)');
    });

    it('stateMachine: preStep:true restates before the node prompt is built', async () => {
        const { client, systems } = makeExecutorStub();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'stateMachine' } });
        executor.setSteps({ stepsList: [STEP] });
        await executor.execute({ userGoal: 'DAG GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { preStep: true } });
        assert.ok(systems[0].includes('RESTATED OBJECTIVE'), 'the node runs on the current objective');
    });

    it('discussion: default false leaves the first turn on the pre-restatement objective', async () => {
        const { client, runs } = makeExecutorStub();
        const executor = new WorkflowExecutor({ options: {
            client, defaultModel: 'm', engine: 'discussion',
            agents: [{ name: 'A', model: 'm', provider: 'openai', persona: 'p' }],
        } });
        executor.setSteps({ stepsList: [STEP] });
        await executor.execute({ userGoal: 'DAG GOAL' });
        assert.ok(flat({ input: runs[0] }).includes('DAG GOAL'), 'the first turn was framed before the pass');
        assert.equal(flat({ input: runs[0] }).includes('RESTATED OBJECTIVE'), false);
    });

    it('discussion: preStep:true frames the first turn with the current objective', async () => {
        const { client, runs } = makeExecutorStub();
        const executor = new WorkflowExecutor({ options: {
            client, defaultModel: 'm', engine: 'discussion',
            agents: [{ name: 'A', model: 'm', provider: 'openai', persona: 'p' }],
        } });
        executor.setSteps({ stepsList: [STEP] });
        await executor.execute({ userGoal: 'DAG GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { preStep: true } });
        assert.ok(flat({ input: runs[0] }).includes('RESTATED OBJECTIVE'), 'the first turn runs on the current objective');
    });

    it('normalizeObjectivePolicy keeps preStep off unless explicitly true', () => {
        assert.equal(normalizeObjectivePolicy().preStep, false);
        assert.equal(normalizeObjectivePolicy({ opts: { preStep: true } }).preStep, true);
        // A non-boolean is not 'true', so the knob stays off.
        assert.equal(normalizeObjectivePolicy({ opts: /** @type {any} */ ({ preStep: 'yes' }) }).preStep, false);
    });
});

describe('AgentContext objective record', () => {
    it('applyObjective keeps history + bumps the version, and no-ops on the same text', () => {
        const ctx = new AgentContext({ objective: 'ONE' });
        assert.equal(ctx.objectiveInitial, 'ONE');
        assert.equal(ctx.applyObjective({ next: 'TWO' }), true);
        assert.equal(ctx.objective, 'TWO');
        assert.equal(ctx.objectiveInitial, 'ONE');
        assert.equal(ctx.objectiveVersion, 1);
        assert.deepEqual(ctx.objectiveHistory, ['ONE']);
        assert.equal(ctx.applyObjective({ next: 'TWO' }), false, 'same text is a no-op');
        assert.equal(ctx.applyObjective({ next: '' }), false, 'empty is a no-op');
        assert.equal(ctx.objectiveVersion, 1);
    });

    it('child() carries the record + the cadence counter', () => {
        const ctx = new AgentContext({ objective: 'ONE', objectivePolicy: normalizeObjectivePolicy(), objectiveTurn: 7 });
        const child = ctx.child();
        assert.equal(child.objectiveTurn, 7, 'a child continues the run cadence');
        assert.equal(child.objectiveVersion, ctx.objectiveVersion);
        assert.deepEqual(child.objectiveHistory, ctx.objectiveHistory);
        assert.equal(child.objectivePolicy, ctx.objectivePolicy);
    });

    it('fromJSON rehydrates the record', () => {
        const restored = /** @type {any} */ (AgentContext.fromJSON(/** @type {any} */ ({
            objective: 'TWO', objectiveInitial: 'ONE', objectiveVersion: 1, objectiveHistory: ['ONE'],
        })));
        assert.equal(restored.objectiveInitial, 'ONE');
        assert.equal(restored.objectiveVersion, 1);
        assert.deepEqual(restored.objectiveHistory, ['ONE']);
    });
});

describe('objectiveProgressDigest: bounded and visibly truncated', () => {
    it('keeps small digests intact', () => {
        const digest = objectiveProgressDigest({ messages: [{ role: 'user', content: 'short goal' }] });
        assert.equal(digest, 'short goal');
    });

    it('marks truncation instead of silently slicing', () => {
        const huge = 'x'.repeat(7000);
        const digest = objectiveProgressDigest({ messages: [{ role: 'user', content: huge }] });
        assert.ok(digest.length < huge.length, 'the digest is bounded');
        assert.match(digest, /…\[truncated \d+ of \d+ chars\]/, 'data loss is visible');
    });
});
