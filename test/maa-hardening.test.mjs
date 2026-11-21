// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { withTaskAgents } from '../lib/agentic/task.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';

// =============================================================================
// Stubs
// =============================================================================

/** @param {{model: any, calls: any[], behavior?: any}} arg0 @returns {any} */
function phaseSession({ model, calls, behavior = {} }) {
    return {
        provider: 'openai',
        model,
        sys: null,
        withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withMemory() { return this; },
        withParameters() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        withCircuitBreaker() { return this; },
        withApproval() { return this; },
        withBudget() { return this; },
        /** @param {{initialInput: any, options: any}} arg0 */
        async run({ initialInput: input, options: opts }) {
            calls.push({ sys: this.sys, input, opts });
            if (opts?.onEvent) opts.onEvent({ type: 'text', content: `streamed:${this.sys ?? 'no-sys'}` });
            if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                return behavior.planner ? behavior.planner(this, input) : JSON.stringify({ summary: 'plan', steps: [] });
            }
            if (this.sys && this.sys.includes('quality evaluator')) {
                if (behavior.verdictRaw) return behavior.verdictRaw;
                const v = typeof behavior.verdicts === 'function'
                    ? behavior.verdicts()
                    : behavior.verdicts?.shift() ?? { passed: true, score: 90, reason: 'ok', revision: 'minor' };
                return typeof v === 'string' ? v : JSON.stringify(v);
            }
            if (this.sys && this.sys.includes('synthesize diverse inputs')) return behavior.aggregateOutput ?? 'FINAL ANSWER';
            if (behavior.agentOutput) return behavior.agentOutput(this, input);
            return `answer from ${this.sys ?? 'no-sys'}`;
        },
    };
}

/**
 * @param {{behavior?: any}} arg0
 * @returns {any}
 */
function phaseClient({ behavior = {} } = {}) {
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        sessions: /** @type {any[]} */ ([]),
        session(/** @type {any} */ model) {
            const s = phaseSession({ model, calls, behavior });
            this.sessions.push(s);
            return s;
        },
    };
}

// =============================================================================
// =============================================================================

test('M4 judge: a verdict at the END wins over an earlier brace in prose', async () => {
    const client = phaseClient({ behavior: {
        verdictRaw: 'The score placeholder {score} is not JSON.\n{"passed":true,"score":77,"reason":"solid","revision":"minor"}',
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    group.appendLedger({ entries: [{ author: 'A', content: 'real contribution', type: 'discussion', thoughtSignature: null }] });

    const verdict = /** @type {any} */ (await group.judge({ instruction: 'grade it', options: { asVerdict: true } }));

    assert.equal(verdict.passed, true);
    assert.equal(verdict.score, 77);
    assert.equal(verdict.revision, 'minor');
});

// =============================================================================
// =============================================================================

test('M5 execute agents receive the objective, handoff, signal and run context', async () => {
    /** @type {any} */ let payload = null;
    const controller = new AbortController();
    const group = new DiscussionSession({ client: {}, options: { objective: 'GROUP GOAL: win the audit', handoff: { goal: 'full', context: 'clean' } } });
    group.addAgent({ name: 'remote', execute: async (/** @type {any} */ p) => { payload = p; return 'remote done'; } });

    await group.discuss({ instruction: 'go', turns: 1, sequential: true, signal: controller.signal });

    assert.ok(payload, 'execute invoked');
    assert.equal(payload.objective, 'GROUP GOAL: win the audit');
    assert.equal(payload._merci.objective, 'GROUP GOAL: win the audit');
    assert.equal(payload.agentContext.objective, 'GROUP GOAL: win the audit');
    assert.equal(payload.handoff.goal, 'full');
    assert.equal(payload.handoff.context, 'clean');
    assert.equal(payload.signal, controller.signal, 'the caller signal is forwarded');
    assert.equal(typeof payload.runContext?.runId, 'string', 'run correlation is threaded');
    assert.deepEqual(payload.agent, { name: 'remote', persona: undefined });
    assert.equal(/** @type {any} */ (group.getLedger()[0]).content, 'remote done');
});

// =============================================================================
// =============================================================================

test('M6 MAA subagent stage degrades to profile.fallbackModel and emits task:fallback', async () => {
    /** @type {any[]} */ const created = [];
    const client = {
        provider: 'openai',
        session(/** @type {any} */ model) {
            const s = phaseSession({ model, calls: [], behavior: {} });
            s.run = async () => {
                if (model === 'primary') throw Object.assign(new Error('gateway down'), { status: 503 });
                return 'fallback-ok';
            };
            created.push(s);
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'primary', fallbackModel: 'cheap' }] });
    const group = new DiscussionSession({ client });
    /** @type {any[]} */ const fallbacks = [];
    group.on('task:fallback', (e) => fallbacks.push(e));

    await group.runTasks({ tasks: [{ title: 'stage', description: 'do the work', subagent_type: 'worker' }] });

    assert.equal(/** @type {any} */ (group.getLedger()[0]).content, 'fallback-ok');
    assert.equal(fallbacks.length, 1, 'task:fallback surfaced on the discussion emitter');
    assert.equal(fallbacks[0].fallbackModel, 'cheap');
    assert.deepEqual(created.map((s) => s.model), ['primary', 'cheap']);
});

// =============================================================================
// M2 — verify/maxRetries on subagent tasks
// =============================================================================

test('M2 a subagent task with a failing verify records an [error:] entry, not a silent success', async () => {
    const client = phaseClient();
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const group = new DiscussionSession({ client });

    await group.runTasks({ tasks: [{
        title: 'gated',
        description: 'do it',
        subagent_type: 'worker',
        maxRetries: 1,
        verify: () => ({ passed: false, evidence: 'not good enough' }),
    }] });

    const entry = /** @type {any} */ (group.getLedger()[0]);
    assert.match(String(entry.content), /^\[error:/);
    assert.match(String(entry.content), /not good enough|verification/i);
});

// =============================================================================
// M7 — dependency failure gating
// =============================================================================

test('M7 a task whose dependency failed is skipped with an explicit error (no model call)', async () => {
    let bCalls = 0;
    const group = new DiscussionSession({ client: phaseClient() });
    group.addAgent({ name: 'A', execute: async () => { throw new Error('A exploded'); } });
    group.addAgent({ name: 'B', execute: async () => { bCalls++; return 'B ran'; } });

    await group.runTasks({ tasks: [
        { title: 'A', description: 'first', assignee: 'A' },
        { title: 'B', description: 'second', assignee: 'B', dependsOn: ['A'] },
    ] });

    assert.equal(bCalls, 0, 'the dependent never ran');
    const ledger = /** @type {any[]} */ (group.getLedger());
    assert.ok(ledger.some((e) => String(e.content).includes('dependency "A" failed')), 'the skip is explicit');
    assert.ok(ledger.some((e) => String(e.content).includes('A exploded')), 'the root failure is recorded');
});

// =============================================================================
// M8 — independent branches run in parallel
// =============================================================================

test('M8 independent tasks overlap; sequential:true keeps them serial', async () => {
    const makeClient = () => {
        let active = 0;
        const state = { peak: 0 };
        return {
            state,
            session: () => {
                const s = phaseSession({ model: 'm', calls: [], behavior: {} });
                s.run = async () => {
                    active++;
                    state.peak = Math.max(state.peak, active);
                    await new Promise((r) => setTimeout(r, 30));
                    active--;
                    return 'done';
                };
                return s;
            },
        };
    };
    const parallelClient = makeClient();
    const group = new DiscussionSession({ client: parallelClient });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    await group.runTasks({ tasks: [
        { title: 't1', description: 'one', assignee: 'A' },
        { title: 't2', description: 'two', assignee: 'A' },
    ] });
    assert.equal(parallelClient.state.peak, 2, 'both independent tasks overlapped');
    assert.deepEqual(/** @type {any[]} */ (group.getLedger()).map((e) => e.author), ['A', 'A'], 'registration-order commit');

    const serialClient = makeClient();
    const serialGroup = new DiscussionSession({ client: serialClient });
    serialGroup.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    await serialGroup.runTasks({ tasks: [
        { title: 't1', description: 'one', assignee: 'A' },
        { title: 't2', description: 'two', assignee: 'A' },
    ], sequential: true });
    assert.equal(serialClient.state.peak, 1, 'sequential:true stays serial');
});

// =============================================================================
// M9 — conclude forwards phase options
// =============================================================================

test('M9 conclude forwards a judge execute override (not agents[0])', async () => {
    const client = phaseClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    let judgeRuns = 0;

    const final = /** @type {any} */ (await group.conclude({ instruction: 'topic', options: {
        judge: { execute: async () => { judgeRuns++; return JSON.stringify({ passed: true, score: 88, reason: 'ok', revision: 'minor' }); } },
    } }));

    assert.equal(judgeRuns, 1, 'the provided judge execute ran');
    assert.equal(client.calls.filter((/** @type {any} */ c) => c.sys?.includes('quality evaluator')).length, 0, 'no LLM judge call');
    assert.equal(final.verdict.score, 88);
    assert.equal(final.accepted, true);
});

test('M9 conclude forwards discuss.sequential=false (parallel member turns)', async () => {
    let active = 0;
    const peak = { value: 0 };
    const client = {
        session() {
            const s = phaseSession({ model: 'm', calls: [], behavior: {} });
            s.run = async () => {
                active++;
                peak.value = Math.max(peak.value, active);
                await new Promise((r) => setTimeout(r, 20));
                active--;
                return 'contribution';
            };
            return s;
        },
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'm', provider: 'openai' });

    await group.conclude({ instruction: 'topic', options: { discuss: { sequential: false } } });

    assert.equal(peak.value, 2, 'both member turns overlapped');
});

// =============================================================================
// M10 — conclude error contract
// =============================================================================

test('M10 conclude returns error:true instead of throwing when a replan fails', async () => {
    const client = phaseClient({ behavior: {
        verdicts: [{ passed: false, score: 30, reason: 'drift', revision: 'full' }],
        planner: () => JSON.stringify({
            summary: 'plan',
            steps: [
                { id: 'x', title: 'X', systemPrompt: 's', userPromptTemplate: 't', dependencies: [] },
                { id: 'x', title: 'X2', systemPrompt: 's', userPromptTemplate: 't', dependencies: [] },
            ],
        }),
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });

    const final = /** @type {any} */ (await group.conclude({ instruction: 'topic', options: { maxRounds: 1 } }));

    assert.equal(final.error, true);
    assert.equal(final.accepted, false);
    assert.match(String(final.content), /^\[error:.*duplicate/);
});

// =============================================================================
// =============================================================================

test('M12 a 2-turn discussion stamps the turn on agent events; ledger_entry fires per commit', async () => {
    const client = phaseClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'm', provider: 'openai' });
    /** @type {any[]} */ const finishes = [];
    /** @type {any[]} */ const entries = [];
    group.on('discussion:agent_finish', (e) => finishes.push(e));
    group.on('discussion:ledger_entry', (e) => entries.push(e));

    await group.discuss({ instruction: 'go', turns: 2, sequential: true });

    assert.equal(finishes.length, 4);
    assert.deepEqual(finishes.map((e) => e.turn), [1, 1, 2, 2], 'every finish carries its turn');
    assert.equal(entries.length, group.getLedger().length, 'one ledger_entry per committed entry');
    assert.deepEqual(entries.map((e) => e.index), [0, 1, 2, 3]);
});

// =============================================================================
// M13 — objective race: per-agent child contexts
// =============================================================================

test('M13 parallel agents get child contexts; a restatement cannot leak or double-apply', async () => {
    /** @type {any[]} */ const contexts = [];
    const client = {
        session() {
            const s = phaseSession({ model: 'm', calls: [], behavior: {} });
            s.run = async function () {
                contexts.push(this._agentContext);
                if (this.sys === 'A') this._agentContext.applyObjective({ next: 'restated by A' });
                return `from ${this.sys}`;
            };
            return s;
        },
    };
    const group = new DiscussionSession({ client, options: { objective: 'original goal' } });
    const parentCtx = /** @type {any} */ (group._agentContext);
    group.addAgent({ name: 'A', persona: 'A', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'm', provider: 'openai' });

    await group.discuss({ instruction: 'go', turns: 1 });

    assert.equal(contexts.length, 2);
    assert.notEqual(contexts[0], contexts[1], 'each agent has its own context');
    assert.notEqual(contexts[0], parentCtx, 'agent contexts are children of the group context');
    const [a, b] = contexts;
    assert.equal(a.objective, 'restated by A');
    assert.equal(b.objective, 'original goal', "B never saw A's restatement");
    assert.equal(parentCtx.objective, 'original goal', 'the group context is untouched');
    assert.equal(a.objectiveVersion, 1, 'the restatement applied exactly once');
    assert.equal(b.objectiveVersion, 0);
    assert.equal(parentCtx.objectiveVersion, 0, 'no lost update on the shared parent');
});

// =============================================================================
// M14 — maxRounds validation
// =============================================================================

test('M14 maxRounds: Infinity terminates (bounded judge loop)', async () => {
    let judgeCalls = 0;
    const client = phaseClient();
    client.session = (/** @type {any} */ model) => {
        const s = phaseSession({ model, calls: client.calls, behavior: {} });
        const orig = s.run.bind(s);
        s.run = async (/** @type {any} */ input, /** @type {any} */ opts) => {
            if (s.sys && s.sys.includes('quality evaluator')) {
                judgeCalls++;
                if (judgeCalls > 20) return JSON.stringify({ passed: true, score: 90, reason: 'safety', revision: 'minor' });
                return JSON.stringify({ passed: false, score: 10, reason: 'bad', revision: 'minor' });
            }
            return orig(input, opts);
        };
        return s;
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });

    const final = /** @type {any} */ (await group.conclude({ instruction: 'topic', options: { maxRounds: Infinity } }));

    assert.ok(judgeCalls <= 4, `judge loop bounded (ran ${judgeCalls})`);
    assert.equal(final.accepted, false);
    assert.equal(final.error, false, 'the aggregate still produced a conclusion');
});

// =============================================================================
// =============================================================================

test('M15 a regressed debate aggregates the best-scoring round, not the last', async () => {
    const client = phaseClient({ behavior: {
        verdicts: [
            { passed: false, score: 90, reason: 'strong but rejected', revision: 'minor' },
            { passed: false, score: 40, reason: 'worse', revision: 'minor' },
        ],
        agentOutput: (/** @type {any} */ s, /** @type {any} */ input) => {
            const last = Array.isArray(input) ? String(input[input.length - 1]?.content ?? '') : String(input ?? '');
            if (last.startsWith('The judge rejected')) return 'REVISED ARGUMENT';
            if (last.startsWith('Re-examine')) return 'RE-EXAMINED ARGUMENT';
            return 'ORIGINAL ARGUMENT';
        },
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });

    await group.conclude({ instruction: 'topic', options: { maxRounds: 1 } });

    const aggCall = client.calls.find((/** @type {any} */ c) => c.sys && c.sys.includes('synthesize diverse inputs'));
    assert.ok(aggCall, 'the aggregate ran');
    const text = aggCall.input.map((/** @type {any} */ m) => String(m.content)).join('\n');
    assert.ok(text.includes('ORIGINAL ARGUMENT'), 'the best round is synthesized');
    assert.ok(!text.includes('REVISED ARGUMENT'), 'the regressed round is not');
    assert.ok(!text.includes('RE-EXAMINED ARGUMENT'));
});

// =============================================================================
// M16 — aggregate empty guard
// =============================================================================

test('M16 an all-error ledger yields error:true, no fabricated conclusion, no model call', async () => {
    let sessions = 0;
    const client = {
        session(/** @type {any} */ model) { sessions++; return phaseSession({ model, calls: [], behavior: {} }); },
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', execute: async () => { throw new Error('always down'); } });

    const final = /** @type {any} */ (await group.conclude({ instruction: 'topic', options: { maxRounds: 1 } }));

    assert.equal(final.accepted, false);
    assert.equal(final.error, true);
    assert.match(String(final.content), /\[error:/);
    assert.equal(sessions, 0, 'no aggregator model call on an empty ledger');
});

// =============================================================================
// =============================================================================

// E-4: a multi-agent group answers through aggregate; the old expectation
// (one surviving voice = the group answer) was the flaw this replaces.
test('M11 DAG discussion step survives a failing sibling and ships the substantive output', async () => {
    /** @type {any[]} */
    const inputs = [];
    const client = { session: () => ({
        provider: 'openai',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        /** @param {{initialInput: any}} arg0 */
        async run({ initialInput }) {
            inputs.push(initialInput);
            return 'SYNTH: substantive contribution';
        },
    }) };
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'discussion',
        agents: [
            { name: 'good', persona: 'p', execute: async () => 'substantive contribution' },
            { name: 'bad', persona: 'p', execute: async () => { throw new Error('sibling failed'); } },
        ],
    } });
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'Debate this.', dependencies: [] }] });

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });

    assert.equal(outputs.a.output, 'SYNTH: substantive contribution', 'the group ships the aggregate, not one survivor (E-4)');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed', 'the failing sibling did not abort the step');
    const seen = JSON.stringify(inputs);
    assert.match(seen, /substantive contribution/, 'the sibling error did not lose the surviving work');
    assert.match(seen, /\[error: sibling failed\]/, 'the error row stays in the ledger');
});

// =============================================================================
// M17 — missing assignee
// =============================================================================

test('M17 a task without assignee/subagent_type records an explicit error naming the task', async () => {
    let sessions = 0;
    const client = {
        session(/** @type {any} */ model) { sessions++; return phaseSession({ model, calls: [], behavior: {} }); },
    };
    const group = new DiscussionSession({ client });

    await group.runTasks({ tasks: [{ title: 'orphan', description: 'nothing to run' }] });

    const entry = /** @type {any} */ (group.getLedger()[0]);
    assert.equal(entry.author, 'orphan', 'the entry is attributed to the task, not undefined');
    assert.match(String(entry.content), /orphan/);
    assert.match(String(entry.content), /assignee/);
    assert.equal(sessions, 0, 'no model call');
});
