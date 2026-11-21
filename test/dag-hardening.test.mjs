// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { WorkflowPlanner } from '../lib/agentic/planning/planner.mjs';
import { WorkflowEvaluator } from '../lib/agentic/planning/evaluator.mjs';
import { TaskState } from '../lib/agentic/planning/task-state.mjs';
import { getLeafOutput } from '../lib/agentic/planning/graph-utils.mjs';
import { restoreCheckpoint } from '../lib/agentic/planning/checkpoint.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

/** @param {{runImpl: any}} arg0 */
function makeFakeSession({ runImpl }) {
    return {
        provider: 'openai',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        /** @param {{initialInput: any, options: any}} arg0 */
        run: ({ initialInput: input, options }) =>
            isObjectiveRestatePrompt({ input }) ? Promise.resolve('') : runImpl(input, options),
    };
}

/** @param {{runImpl: any}} arg0 */
function makeFakeClient({ runImpl }) {
    return { session: () => makeFakeSession({ runImpl }) };
}

/**
 * @param {{input: any}} arg0
 */
function promptText({ input }) {
    return Array.isArray(input)
        ? input.map((/** @type {any} */ m) => String(m?.content ?? '')).join('\n')
        : String(input);
}

const SIMPLE_STEP = {
    id: 'a',
    title: 'A',
    systemPrompt: 'Be terse.',
    userPromptTemplate: 'Do the thing.',
    dependencies: [],
};

/** @param {{ms: any}} arg0 */
/** @param {{ms: *}} arg0 */
const sleep = ({ ms }) => new Promise((r) => setTimeout(r, ms));

// ─── D2: listener isolation ─────────────────────────────────────────────────

test('D2: a throwing step_complete listener leaves the node completed', async () => {
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.on('workflow:step_complete', () => { throw new Error('listener boom'); });
    /** @type {any[]} */
    const listenerErrors = [];
    executor.on('workflow:listener_error', (e) => listenerErrors.push(e));
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(outputs.a.output, 'answer');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');
    assert.equal(listenerErrors.length, 1, 'the listener failure is surfaced, not swallowed silently');
});

test('D2: a throwing step_start listener does not reject execute()', async () => {
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.on('workflow:step_start', () => { throw new Error('start boom'); });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(outputs.a.output, 'answer');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');
});

// ─── D4: same-id retry-as-is replan ─────────────────────────────────────────

test('D4: a same-id replan (retry as-is) re-runs the failed step and completes', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('transient boom');
        return 'recovered';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    const replan = async () => ({ steps: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null });
    assert.equal(calls, 2, 'the failed step must re-run');
    assert.equal(outputs.a.output, 'recovered');
});

// ─── D5: replanner context + rewrite validation ─────────────────────────────

test('D5: replan omitting a pending step emits workflow:steps_dropped', async () => {
    let aAttempts = 0;
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        if (promptText({ input }).includes('do a')) {
            aAttempts++;
            if (aAttempts === 1) throw new Error('boom');
        }
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a', userPromptTemplate: 'do a' },
        { ...SIMPLE_STEP, id: 'b', title: 'B', userPromptTemplate: 'do b', dependencies: ['a'] },
    ] });
    /** @type {any[]} */
    const dropped = [];
    executor.on('workflow:steps_dropped', (e) => dropped.push(e));
    const replan = async () => ({ steps: [{ ...SIMPLE_STEP, userPromptTemplate: 'do a retry' }] });

    await executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null });
    assert.equal(dropped.length, 1, 'dropping pending work must be visible');
    assert.deepEqual(dropped[0].stepIds, ['b']);
});

test('D5: a rewritten plan leaving a dangling dep fails with a named error, not a generic deadlock', async () => {
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        if (promptText({ input }).includes('do a')) throw new Error('boom');
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a', userPromptTemplate: 'do a' },
        { ...SIMPLE_STEP, id: 'b', title: 'B', userPromptTemplate: 'do b', dependencies: ['a'] },
    ] });
    const replan = async () => ({
        steps: [
            { ...SIMPLE_STEP, id: 'a2', userPromptTemplate: 'do a2' },
            { ...SIMPLE_STEP, id: 'b', title: 'B', userPromptTemplate: 'do b', dependencies: ['a'] },
        ],
    });
    let failedEvent = /** @type {any} */ (null);
    executor.on('workflow:failed', (e) => { failedEvent = e; });

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null }), /b→a/);
    assert.ok(failedEvent, 'workflow:failed emitted before the throw');
});

test('D5: planner.replan receives the live plan and forwards it into the prompt', async () => {
    let promptSeen = '';
    const client = {
        provider: 'openai',
        session: () => {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withParameters() { return s; },
                withTools() { return s; },
                /** @param {{initialInput: any}} arg0 */
                async run({ initialInput: p }) {
                    promptSeen = String(p);
                    return JSON.stringify({ steps: [{ id: 'a', userPromptTemplate: 'x', dependencies: [] }] });
                },
            };
            return s;
        },
    };
    const planner = new WorkflowPlanner({ options: { client, model: 'm' } });
    await planner.replan({ objective: 'goal', failedStepId: 'a', failureReason: 'boom', currentOutputs: {}, signal: null, plan: [{ id: 'pending_b', title: 'B', status: 'pending', dependencies: [], historical: false }] });
    assert.ok(promptSeen.includes('pending_b'), 'the live plan reaches the replan prompt');
    assert.ok(promptSeen.includes('pending'), 'the live statuses reach the replan prompt');
});

// ─── D6: checkpoint completeness ────────────────────────────────────────────

test('D6: save/load + setSteps(originalPlan) keeps completed status and reattaches verify', async () => {
    let runs = 0;
    const client = makeFakeClient({ runImpl: async () => { runs++; return 'verified output'; } });
    const step = { ...SIMPLE_STEP, verify: (/** @type {any} */ out) => ({ passed: String(out).includes('verified'), evidence: 'ok' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');

    const restored = WorkflowExecutor.load({ json: executor.save(), options: { client, defaultModel: 'm' } });
    restored.setSteps({ stepsList: [step] });
    const node = /** @type {any} */ (restored.steps).get('a');
    assert.equal(node.status, 'completed', 'completed status must survive checkpoint + setSteps');
    assert.equal(typeof node.verify, 'function', 'verify must be reattached from the incoming plan');

    /** @type {any} */ const outputs = await restored.execute({ userGoal: 'goal' });
    assert.equal(runs, 1, 'a completed step must not re-run after resume (no duplicate side effects)');
    assert.equal(outputs.a.output, 'verified output');
});

test('D6: TaskState preserves the objective envelope and pending evaluations', () => {
    const executor = new WorkflowExecutor({ options: { defaultModel: 'm' } });
    executor.globalObjective = 'goal';
    executor._agentContext = AgentContext.fromObjective({ objective: 'goal' });
    executor._agentContext.applyObjective({ next: 'goal v2' });
    executor._agentContext.objectivePolicy = { adaptable: true, hitl: false, firstUpdate: 1, updateTurns: 7, preStep: false };
    executor._pendingEvaluations.set('a', 1);

    const restored = WorkflowExecutor.load({ json: executor.save(), options: { defaultModel: 'm' } });
    const ac = /** @type {any} */ (restored._agentContext);
    assert.equal(ac.objectiveVersion, 1, 'objective version survives');
    assert.deepEqual(ac.objectiveHistory, ['goal'], 'objective history survives');
    assert.equal(ac.objectivePolicy.updateTurns, 7, 'objective policy survives');
    assert.equal(restored._pendingEvaluations.get('a'), 1, 'deferred evaluations survive');
});

test('D6: an unsupported TaskState snapshot version is rejected', () => {
    assert.throws(
        () => TaskState.fromJSON(JSON.stringify({ version: 99, objective: 'x' })),
        /version/i
    );
});

test('D6: restoreCheckpoint rejects a future envelope version', () => {
    const saved = { checkpoint: { version: 99, kind: 'workflow', payload: '{}' } };
    assert.throws(() => restoreCheckpoint({ saved, kind: 'workflow', args: [{}] }), /version/i);
});

// ─── D7: timeout / concurrency / budget ─────────────────────────────────────

test('D7: maxConcurrency caps the in-flight steps', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const client = makeFakeClient({ runImpl: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await sleep({ ms: 15 });
        inflight--;
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxConcurrency: 2 } });
    executor.setSteps({ stepsList: Array.from({ length: 8 }, (_, i) => ({
        ...SIMPLE_STEP, id: `s${i}`, title: `S${i}`, userPromptTemplate: `do ${i}`,
    })) });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(maxInflight, 2, 'never more than maxConcurrency steps in flight');
});

test('D7: stepTimeoutMs fails a never-resolving step instead of hanging', async () => {
    const client = makeFakeClient({ runImpl: async () => new Promise(() => { /* never settles */ }) });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', stepTimeoutMs: 50 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    const started = Date.now();

    const outcome = await Promise.race([
        executor.execute({ userGoal: 'goal' }).then(() => 'settled', (err) => `rejected:${err.message}`),
        sleep({ ms: 2000 }).then(() => 'race-timeout'),
    ]);
    assert.match(String(outcome), /rejected.*timed out/, 'the step must fail on its timeout');
    assert.ok(Date.now() - started < 1500, 'the run settles quickly');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

test('D7: a re-execute after a timeout re-runs the step instead of staying latched', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        if (calls === 1) return new Promise(() => { /* never settles */ });
        return 'recovered after timeout';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', stepTimeoutMs: 50 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await Promise.race([executor.execute({ userGoal: 'goal' }).catch(() => { /* timed out */ }), sleep({ ms: 2000 })]);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');

    const outcome = await Promise.race([
        executor.execute({ userGoal: 'goal' }).then((out) => `ok:${(/** @type {any} */ (out)).a.output}`, (err) => `rejected:${err.message}`),
        sleep({ ms: 2000 }).then(() => 'race-timeout'),
    ]);
    assert.equal(outcome, 'ok:recovered after timeout', 'the second run must not stay stuck in running');
});

test('D7: budget is forwarded into the step session run', async () => {
    /** @type {any[]} */
    const runOptions = [];
    const client = {
        session: () => {
            /** @type {any} */
            const s = makeFakeSession({ runImpl: async (/** @type {any} */ input, /** @type {any} */ options) => {
                runOptions.push(options);
                return 'ok';
            } });
            return s;
        },
    };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', budget: { maxTotalTokens: 123 } } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await executor.execute({ userGoal: 'goal' });
    const stepRun = runOptions.find((o) => o && 'maxIterations' in o);
    assert.ok(stepRun, 'the step run happened');
    assert.deepEqual(stepRun.budget, { maxTotalTokens: 123 }, 'the run budget reaches the step session');
});

// ─── D8: per-step engine routing ────────────────────────────────────────────

test('D8: node.engine routes the step to the discussion engine (not silently naive)', async () => {
    const client = makeFakeClient({ runImpl: async () => 'naive answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, engine: 'discussion' }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /agents\[\]/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

// ─── D9: contract criteria on the default engine ────────────────────────────

test('D9: an always-failing contract criterion fails a naive-engine step', async () => {
    const client = makeFakeClient({ runImpl: async () => 'bad output' });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        maxReplanCount: 0,
        contract: { criteria: [{ name: 'always_fails', check: () => ({ passed: false, evidence: 'nope' }) }] },
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /failed verification/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

// ─── D10: graph hygiene ─────────────────────────────────────────────────────

test('D10: duplicate step ids are rejected with a typed error + workflow:failed', () => {
    const executor = new WorkflowExecutor({ options: { defaultModel: 'm' } });
    let failed = /** @type {any} */ (null);
    executor.on('workflow:failed', (e) => { failed = e; });

    assert.throws(
        () => executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, id: 'a' }, { ...SIMPLE_STEP, id: 'a' }] }),
        (/** @type {any} */ err) => err.code === 'MERCI-CONFIG-ERR' && /duplicate/i.test(err.message)
    );
    assert.ok(failed, 'workflow:failed emitted for the duplicate-id plan');
});

test('D10: an empty plan is rejected by setSteps and by execute()', async () => {
    const executor = new WorkflowExecutor({ options: { defaultModel: 'm' } });
    assert.throws(() => executor.setSteps({ stepsList: [] }), /empty plan/i);
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /empty plan/i);
});

test('D10: a cycle emits workflow:failed before throwing', () => {
    const executor = new WorkflowExecutor({ options: { defaultModel: 'm' } });
    let failed = /** @type {any} */ (null);
    executor.on('workflow:failed', (e) => { failed = e; });

    assert.throws(() => executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a', dependencies: ['b'] },
        { ...SIMPLE_STEP, id: 'b', title: 'B', dependencies: ['a'] },
    ] }), /cycle|Cycle/);
    assert.ok(failed, 'workflow:failed emitted before the cycle throw');
});

// ─── D11: HITL iteration gate fail-fast ─────────────────────────────────────

test('D11: the iteration-limit gate fails fast with no listener (no 300s stall)', async () => {
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ _input, /** @type {any} */ options) => {
        const extended = await options.onLimitReached({ reason: 'limit', iterationsUsed: 1, extensionRound: 0 });
        return extended ? 'extended answer' : FALLBACK_MESSAGE.MAX_ITERATIONS;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    const started = Date.now();

    const outcome = await Promise.race([
        executor.execute({ userGoal: 'goal' }).then(() => 'settled', (err) => `rejected:${err.message}`),
        sleep({ ms: 2000 }).then(() => 'race-timeout'),
    ]);
    for (const coordinator of executor._pendingApprovals.values()) coordinator.resolve({ approved: false, details: {} });
    assert.match(String(outcome), /rejected/, 'the run settles with a controlled failure');
    assert.ok(Date.now() - started < 1500, 'the gate must not idle the default timeout');
});

// ─── D12/D13: fingerprint budget + replan fairness ──────────────────────────

test('D12/D13: a step burning replans does not starve another step\'s first replan', async () => {
    let bAttempts = 0;
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        const text = promptText({ input });
        if (text.includes('do a')) throw new Error('a is broken');
        if (text.includes('do b')) {
            bAttempts++;
            if (bAttempts === 1) throw new Error('b transient');
        }
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a', userPromptTemplate: 'do a' },
        { ...SIMPLE_STEP, id: 'b', title: 'B', userPromptTemplate: 'do b' },
    ] });
    /** @type {string[]} */
    const replanned = [];
    executor.on('workflow:replan_triggered', (e) => replanned.push(e.failedStepId));
    let round = 0;
    const replan = async () => {
        round++;
        return {
            steps: [
                { ...SIMPLE_STEP, id: 'a', userPromptTemplate: `do a retry ${round}` },
                { ...SIMPLE_STEP, id: 'b', title: 'B', userPromptTemplate: `do b retry ${round}` },
            ],
        };
    };

    await executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null }).catch(() => { /* a never recovers — expected */ });
    assert.ok(replanned.includes('b'), 'b must get its first replan even though a keeps failing');
    assert.equal((/** @type {any} */ (executor.steps)).get('b').status, 'completed');
});

// ─── M11: discussion step output selection ───

// E-4: a multi-agent group answers through aggregate; the old expectation
// (one surviving voice = the group answer) was the flaw this replaces.
test('M11: a discussion step with a failing sibling ships the substantive entry', async () => {
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

// ─── D14/D15: partial-failure artifacts + leaf output ───────────────────────

test('D14: a failed step preserves its last artifact and the throw carries failed outputs', async () => {
    const client = makeFakeClient({ runImpl: async () => 'partial artifact text' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, maxRetries: 0, verify: () => ({ passed: false, evidence: 'never good' }) }] });

    let caught = /** @type {any} */ (null);
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), (/** @type {any} */ err) => { caught = err; return true; });

    const node = /** @type {any} */ (executor.steps).get('a');
    assert.equal(node.status, 'failed');
    assert.equal(node.lastArtifact, 'partial artifact text', 'the failed attempt artifact is kept on the node');
    assert.ok(caught.failedOutputs && caught.failedOutputs.a, 'failed outputs ride the thrown error');
    assert.match(JSON.stringify(caught.failedOutputs.a), /partial artifact text/);
});

test('D15: getLeafOutput keeps a legitimate output that merely starts with "Error:"', () => {
    const steps = new Map([
        ['a', { id: 'a', dependencies: [] }],
        ['b', { id: 'b', dependencies: ['a'] }],
    ]);
    const outputs = {
        a: { output: 'Error: this is a valid report', data: 'Error: this is a valid report' },
        b: { output: 'Error: boom', data: { error: 'boom' } },
    };
    const leaf = getLeafOutput({ stepsMap: steps, outputs });
    assert.equal(leaf.sourceId, 'a');
    assert.equal(leaf.output, 'Error: this is a valid report');
});

// ─── D17: run correlation on planner/evaluator calls ────────────────────────

test('D17: planner/evaluator structured calls receive the run session id', async () => {
    /** @type {any[]} */
    const seen = [];
    let call = 0;
    const client = {
        provider: 'openai',
        session: () => {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withParameters() { return s; },
                withTools() { return s; },
                async run() {
                    seen.push(s._explicitSessionId);
                    call++;
                    return call === 1
                        ? JSON.stringify({ steps: [{ id: 'a', userPromptTemplate: 'x', dependencies: [] }] })
                        : JSON.stringify({ replanRequired: false, reason: 'ok' });
                },
            };
            return s;
        },
    };
    const planner = new WorkflowPlanner({ options: { client, model: 'm' } });
    await planner.replan({ objective: 'goal', failedStepId: 'a', failureReason: 'boom', currentOutputs: {}, signal: null, sessionId: 'run-42' });
    const evaluator = new WorkflowEvaluator({ options: { client, model: 'm' } });
    await evaluator.evaluate({ node: { id: 'a', output: 'x' }, outputs: {}, objective: 'goal', signal: null, sessionId: 'run-42' });
    assert.deepEqual(seen, ['run-42', 'run-42']);
});

test('D17: the executor threads its run correlation id and live plan into replan', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    let runId = /** @type {any} */ (null);
    executor.on('workflow:start', (e) => { runId = e.runId; });
    let seenOptions = /** @type {any} */ (null);
    /** @param {{sessionId: any, plan: any}} arg0 */
    /** @param {{sessionId: *, plan: *}} arg0 */
    const replan = async ({ sessionId, plan }) => {
        seenOptions = { sessionId, plan };
        return { steps: [{ ...SIMPLE_STEP, userPromptTemplate: 'retry' }] };
    };

    await executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null });
    assert.ok(runId, 'run id captured');
    assert.equal(seenOptions?.sessionId, runId, 'the run correlation id reaches the planner');
    assert.ok(Array.isArray(seenOptions?.plan) && seenOptions.plan.some((/** @type {any} */ s) => s.id === 'a'),
        'the live plan reaches the planner');
});
