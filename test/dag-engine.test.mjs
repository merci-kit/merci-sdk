// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { WorkflowPlanner } from '../lib/agentic/planning/planner.mjs';
import { DAG_WORKFLOW_PLAN_SCHEMA, DAG_WORKFLOW_REPLAN_SCHEMA } from '../lib/core/prompts.mjs';
import { extractAndParseJson } from '../lib/support/json.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {{runImpl: any, provider?: string}} arg0 */
function makeFakeSession({ runImpl, provider = 'openai' }) {
    return {
        provider,
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        /** @param {{initialInput: any, options: any}} arg0 */
        run: ({ initialInput, options }) =>
            isObjectiveRestatePrompt({ input: initialInput }) ? Promise.resolve('') : runImpl(initialInput, options),
    };
}

/**
 * @param {{runImpl: any}} arg0
 */
function makeFakeClient({ runImpl }) {
    return { session: () => makeFakeSession({ runImpl }) };
}

/** @param {{runImpl: any, getProfiles?: any, provider?: any}} arg0 */
function makeRecordingClient({ runImpl, getProfiles }) {
    /** @type {any[]} */
    const requested = [];
    return {
        requested,
        getProfiles,
        session: (/** @type {any} */ model) => {
            requested.push(model);
            return makeFakeSession({ runImpl });
        },
    };
}

const SIMPLE_STEP = {
    id: 'a',
    title: 'A',
    systemPrompt: 'Be terse.',
    userPromptTemplate: 'Do the thing.',
    dependencies: [],
};

// ─── default engine is 'naive' (unchanged behaviour) ────────────────────────

test('WorkflowExecutor: default engine is naive and records step output', async () => {
    const client = makeFakeClient({ runImpl: async () => 'plain answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(executor.engine, 'naive');
    assert.equal(outputs.a.output, 'plain answer');
    assert.equal(outputs.a.data, 'plain answer');
});

// ─── stateMachine engine ────────────────────────────────────────────────────

test('stateMachine engine: step passes contract criteria → step completes', async () => {
    const client = makeFakeClient({ runImpl: async () => 'good' });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'stateMachine',
        contract: {
            maxRetries: 2,
            criteria: [{ name: 'is_good', check: (/** @type {any} */ ctx) => ({ passed: ctx.get({ k: 'step' }) === 'good', evidence: ctx.get({ k: 'step' }) }) }]
        }
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    const parsed = JSON.parse(outputs.a.output);
    assert.equal(parsed.step, 'good');
});

test('stateMachine engine: failing criteria retries by fingerprint then passes', async () => {
    const calls = [];
    const client = makeFakeClient({ runImpl: async () => {
        calls.push(1);
        return calls.length === 1 ? 'bad' : 'good';
    } });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'stateMachine',
        contract: {
            maxRetries: 2,
            criteria: [{ name: 'is_good', check: (/** @type {any} */ ctx) => ({ passed: ctx.get({ k: 'step' }) === 'good' }) }]
        }
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(calls.length, 2, 'one retry after the first failed verification');
    assert.equal(JSON.parse(outputs.a.output).step, 'good');
});

test('stateMachine engine: persistent criteria failure marks the step failed', async () => {
    const client = makeFakeClient({ runImpl: async () => 'always-bad' });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'stateMachine',
        contract: {
            maxRetries: 1,
            criteria: [{ name: 'is_good', check: () => ({ passed: false, evidence: 'nope' }) }]
        }
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /Step\(s\) execution failed/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

// ─── discussion engine ──────────────────────────────────────────────────────

test('discussion engine: step output is the last agent contribution', async () => {
    const client = makeFakeClient({ runImpl: async () => { throw new Error('LLM must not run for code agents'); } });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'discussion',
        agents: [{
            name: 'Alice',
            persona: 'You debate well.',
            /** @param {{instruction: string}} arg0 */
            execute: async (/** @type {any} */ { instruction }) => `debated: ${instruction.length > 0}`
        }]
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.match(outputs.a.output, /^debated: /);
});

test('discussion engine: retries a transient empty response', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => { throw new Error('LLM must not run for code agents'); } });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'discussion',
        agents: [{
            name: 'Alice',
            persona: 'You debate well.',
            execute: async () => (++calls === 1 ? FALLBACK_MESSAGE.EMPTY_RESPONSE : 'debated answer')
        }]
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(calls, 2, 'the empty first turn must be retried');
    assert.equal(outputs.a.output, 'debated answer');
});

test('discussion engine: throws when no agents are configured', async () => {
    const client = makeFakeClient({ runImpl: async () => 'unused' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'discussion' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /Step\(s\) execution failed/);
});

// ─── HITL still works through the shared gate ───────────────────────────────

test('naive engine: HITL interception still routes through ApprovalCoordinator', async () => {
    const client = makeFakeClient({ runImpl: async () => 'approved answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 100 } });
    executor.on('workflow:hitl_pending', ({ approvalId }) => executor.resolveApproval({ approvalId, approved: true }));
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, hitl: true }] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(outputs.a.output, 'approved answer');
});

// ─── replan status reset (C2) / re-run (M6) ──────────────────────────────────

test('replan: a changed step definition re-runs instead of staying completed', async () => {
    const calls = [];
    const client = makeFakeClient({ runImpl: async () => { calls.push(1); return 'redo'; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');

    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, userPromptTemplate: 'Do it BETTER this time.' }] });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'pending', 'changed definition must reset to pending');
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(calls.length, 2, 'changed step must re-run');
    assert.equal(outputs.a.output, 'redo');
});

test('replan: an unchanged step definition keeps its completed status', async () => {
    const calls = [];
    const client = makeFakeClient({ runImpl: async () => { calls.push(1); return 'done'; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal(calls.length, 1);
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed', 'identical re-set must not reset to pending');
    assert.equal(calls.length, 1);
});

test('execute(): a second run actually re-executes instead of returning stale outputs', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => { calls++; return `run-${calls}`; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const first = await executor.execute({ userGoal: 'goal' });
    assert.equal(first.a.output, 'run-1');
    /** @type {any} */ const second = await executor.execute({ userGoal: 'goal' });
    assert.equal(second.a.output, 'run-2', 'second execute() must re-run the steps');
    assert.equal(calls, 2);
});

test('naive engine: iteration-limit fallback fails the step instead of completing it', async () => {
    const client = makeFakeClient({ runImpl: async () => 'The model reached the maximum tool iteration limit and could not provide a final text response.' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /iteration limit/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

test('stateMachine engine: iteration-limit fallback fails the step instead of verifying it', async () => {
    const client = makeFakeClient({ runImpl: async () => 'The model reached the maximum tool iteration limit and could not provide a final text response.' });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'stateMachine',
        contract: {
            maxRetries: 2,
            criteria: [{ name: 'non_empty', check: (/** @type {any} */ ctx) => ({ passed: !!ctx.get({ k: 'step' }) }) }]
        }
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /no usable output|iteration limit/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed', 'fallback must NOT verify as completed');
});

test('naive engine: empty-response fallback fails the step instead of completing it', async () => {
    const client = makeFakeClient({ runImpl: async () => FALLBACK_MESSAGE.EMPTY_RESPONSE });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /final answer/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed', 'empty-response fallback must fail the step');
});

test('replan: rewriting an upstream step resets its completed dependents', async () => {
    let calls = [];
    const client = makeFakeClient({ runImpl: async () => { calls.push(1); return 'done'; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', userPromptTemplate: 'do a', dependencies: [] },
        { id: 'b', title: 'B', userPromptTemplate: 'do b', dependencies: ['a'] }
    ] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal((/** @type {any} */ (executor.steps)).get('b').status, 'completed');

    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', userPromptTemplate: 'do a BETTER', dependencies: [] },
        { id: 'b', title: 'B', userPromptTemplate: 'do b', dependencies: ['a'] }
    ] });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'pending', 'changed upstream resets');
    assert.equal((/** @type {any} */ (executor.steps)).get('b').status, 'pending', 'dependent must be invalidated');
});

test('replan: a changed function-form field (verify) resets the step; an identical one does not', async () => {
    const client = makeFakeClient({ runImpl: async () => 'done' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'stateMachine' } });
    const verifyA = () => ({ passed: true });
    /** @param {{fn: any}} arg0 */
    /** @param {{fn: *}} arg0 */
    const stepWithVerify = ({ fn }) => ({ ...SIMPLE_STEP, verify: fn });
    executor.setSteps({ stepsList: [stepWithVerify({ fn: verifyA })] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');

    executor.setSteps({ stepsList: [stepWithVerify({ fn: verifyA })] });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed', 'identical function source must keep completed');

    executor.setSteps({ stepsList: [stepWithVerify({ fn: () => ({ passed: false, evidence: 'stricter' }) })] });
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'pending', 'changed function body must reset to pending');
});

test('plan time: a dangling dependency is rejected before any step runs (C7)', () => {
    const client = makeFakeClient({ runImpl: async () => 'unused' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    assert.throws(
        () => executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, dependencies: ['missing-step'] }] }),
        /Plan rejected: dangling dependencies .*a→missing-step/
    );
    assert.equal(executor.steps.size, 0, 'a rejected plan mutates nothing');
});

// ─── evaluator failsafe (H4) ─────────────────────────────────────────────────

test('evaluator failure skips replan instead of forcing one on a healthy step', async () => {
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    let replanCalled = false;
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal', planner: {
            replan: async () => { replanCalled = true; return { steps: [SIMPLE_STEP] }; }
        }, evaluator: {
            evaluate: async () => { throw new Error('evaluator down'); }
        } });
    assert.equal(replanCalled, false, 'evaluator outage must not trigger a replan');
    assert.equal(outputs.a.output, 'answer');
});

// ─── deferred evaluation (residual R2) ───────────────────────────────────────

test('deferred verdict: evaluator outage then recovery re-evaluates and replans', async () => {
    let replans = 0;
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    let evaluateCalls = 0;
    const deferred = [];
    /** @type {any[]} */
    const replanned = [];
    executor.on('workflow:verification_deferred', (e) => deferred.push(e));
    executor.on('workflow:replan_triggered', (e) => replanned.push(e));

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal', planner: {
            replan: async () => { replans++; return { steps: [{ ...SIMPLE_STEP, userPromptTemplate: 'do it again' }] }; }
        }, evaluator: {
            evaluate: async () => {
                evaluateCalls++;
                if (evaluateCalls === 1) throw new Error('outage');
                return { replanRequired: evaluateCalls === 2, reason: 'output is weak' };
            }
        } });
    assert.equal(evaluateCalls, 3, 'deferred re-check + post-replan evaluation both run');
    assert.equal(replans, 1, 'the deferred replan must actually fire');
    assert.equal(deferred.length, 1, 'verification_deferred emitted once');
    assert.ok(replanned.some((/** @type {any} */ e) => e.failedStepId === 'a'));
    assert.equal(outputs.a.output, 'answer');
});

test('deferred verdict: evaluator permanently down → completes with skipped warning, no hang', async () => {
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    const skipped = [];
    const deferred = [];
    executor.on('workflow:verification_deferred', (e) => deferred.push(e));
    executor.on('workflow:verification_skipped', (e) => skipped.push(e));

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal', planner: { replan: async () => { throw new Error('must not replan'); } }, evaluator: { evaluate: async () => { throw new Error('still down'); } } });
    assert.equal(outputs.a.output, 'answer', 'workflow completes');
    assert.equal(skipped.length, 1, 'skipped warning emitted after the attempt cap');
    assert.ok(deferred.length >= 1, 'deferral recorded');
    assert.equal(executor._pendingEvaluations.size, 0, 'no dangling deferred state');
});

// ─── D4: in-loop replan on a failed step ────────────────────────────────────

test('D4: a failed step with a planner is replanned in-loop (bounded by maxReplanCount)', async () => {
    let calls = 0;
    let replans = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'recovered';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any[]} */
    const triggered = [];
    executor.on('workflow:replan_triggered', (e) => triggered.push(e));
    const replan = async (/** @type {any} */ goal, /** @type {any} */ failedId, /** @type {any} */ reason, /** @type {any} */ outputs) => {
        replans++;
        return { steps: [{ ...SIMPLE_STEP, userPromptTemplate: `Retry with: ${reason}` }] };
    };

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null });
    assert.equal(replans, 1, 'exactly one in-loop replan');
    assert.equal(calls, 2, 'the replanned step re-ran');
    assert.equal(outputs.a.output, 'recovered');
    assert.equal(triggered.length, 1);
    assert.match(triggered[0].reason, /boom/);
});

test('D4: replans are capped — at the budget the workflow fails loudly', async () => {
    const client = makeFakeClient({ runImpl: async () => { throw new Error('still broken'); } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    const replan = async () => ({ steps: [{ ...SIMPLE_STEP, userPromptTemplate: 'retry again' }] });
    let failedEvent = null;
    executor.on('workflow:failed', (e) => { failedEvent = e; });

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null }), /could not be self-healed|halted due to failures/);
    assert.ok(failedEvent, 'workflow:failed emitted at the cap');
});

test('D4: without a planner the failure still hard-throws (unchanged)', async () => {
    const client = makeFakeClient({ runImpl: async () => { throw new Error('boom'); } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner: null, evaluator: null }), /could not be self-healed/);
});

// ─── D5: HITL fail-fast + timeout event ─────────────────────────────────────

test('D5: a HITL step with no listener fails fast instead of idling 300s', async () => {
    const client = makeFakeClient({ runImpl: async () => 'unreachable' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 50 } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, hitl: true }] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /no listener is registered on 'workflow:hitl_pending'/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed', 'the step is recorded as failed');
});

test('D5: a HITL timeout emits workflow:hitl_timeout (operator never answered)', async () => {
    const client = makeFakeClient({ runImpl: async () => 'unreachable' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 30 } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, hitl: true }] });
    /** @type {any[]} */
    /** @type {any[]} */
    const timeouts = [];
    executor.on('workflow:hitl_timeout', (e) => timeouts.push(e));
    executor.on('workflow:hitl_pending', () => { /* listener present — no fail-fast */ });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /rejected|halted|could not be self-healed/);
    assert.equal(timeouts.length, 1, 'the auto-decline is observable');
    assert.equal(timeouts[0].stepId, 'a');
});

test('D4/M1: a HITL-rejected step is NEVER auto-replanned (the human decided)', async () => {
    const client = makeFakeClient({ runImpl: async () => 'unreachable' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, hitl: true }] });
    let replans = 0;
    const replan = async () => { replans++; return { steps: [{ ...SIMPLE_STEP, userPromptTemplate: 'retry' }] }; };
    executor.on('workflow:hitl_pending', ({ approvalId }) => executor.resolveApproval({ approvalId, approved: false }));

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null }), /rejected by the human operator/);
    assert.equal(replans, 0, 'operator rejection must not engage the in-loop replan');
});

test('D5: the no-listener fail-fast is not auto-replanned either', async () => {
    const client = makeFakeClient({ runImpl: async () => 'unreachable' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, hitl: true }] });
    let replans = 0;
    const replan = async () => { replans++; return { steps: [{ ...SIMPLE_STEP, userPromptTemplate: 'retry' }] }; };

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null }), /no listener is registered/);
    assert.equal(replans, 0, 'a gate that could never be answered must not be replanned');
});

test('B6: workflow:failed payload is uniform — { failedSteps, reason } with a plain reason', async () => {
    const client = makeFakeClient({ runImpl: async () => { throw new Error('boom'); } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any} */ let payload = null;
    executor.on('workflow:failed', (e) => { payload = e; });

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner: null, evaluator: null }), /could not be self-healed/);
    assert.ok(payload, 'workflow:failed emitted');
    assert.deepEqual(payload.failedSteps, ['a']);
    assert.ok(typeof payload.reason === 'string' && payload.reason.length > 0, 'reason present');
    assert.ok(!payload.reason.startsWith(' — '), 'reason is NOT a prefixed slice');
});

// ─── L1: naive-engine step verify gate (retry/rewrite loop) ─────────────────

test('L1: a passing verify records the step as completed', async () => {
    const client = makeFakeClient({ runImpl: async () => 'good output' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, verify: (/** @type {any} */ out) => ({ passed: out.includes('good'), evidence: out }) }] });
    const passes = [];
    executor.on('workflow:step_verify_pass', (e) => passes.push(e));

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(outputs.a.output, 'good output');
    assert.equal(passes.length, 1);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');
});

test('L1: a failing verify retries with evidence, then succeeds', async () => {
    let calls = 0;
    /** @type {any[]} */
    const seen = [];
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        calls++;
        seen.push(String(input[input.length - 1]?.content ?? ''));
        return calls === 1 ? 'bad' : 'good now';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, maxRetries: 2, verify: (/** @type {any} */ out) => ({ passed: out.includes('good'), evidence: 'EVID-77' }) }] });
    /** @type {any[]} */
    const fails = [];
    executor.on('workflow:step_verify_fail', (e) => fails.push(e));

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(calls, 2, 'one retry');
    assert.equal(outputs.a.output, 'good now');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].evidence, 'EVID-77');
    assert.ok(seen[1].includes('EVID-77'), 'the retry prompt carries the verification evidence');
    assert.ok(seen[1].includes('[Verification feedback from the previous attempt]'));
});

test('L1: a verify that never passes exhausts maxRetries and fails the step', async () => {
    const client = makeFakeClient({ runImpl: async () => 'never good' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, maxRetries: 1, verify: () => ({ passed: false, evidence: 'nope' }) }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /failed verification after 2 attempt/);
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

test('L1: a fallback output is never fed to the verify gate', async () => {
    let verifyCalls = 0;
    const client = makeFakeClient({ runImpl: async () => FALLBACK_MESSAGE.EMPTY_RESPONSE });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, maxRetries: 1, verify: () => { verifyCalls++; return { passed: true, evidence: 'would wrongly pass' }; } }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /no final answer/);
    assert.equal(verifyCalls, 0, 'a fallback must never reach the verify gate');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'failed');
});

// ─── model escalation on a schema/verify failure ───────────────────────────

test('escalateModel: a verify failure retries on the escalated model', async () => {
    let checks = 0;
    const client = makeRecordingClient({
        runImpl: async () => 'answer',
        getProfiles: async () => [{ id: 'm', name: 'M' }, { id: 'strong', name: 'Strong' }],
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, model: 'm', escalateModel: 'strong', maxRetries: 2, verify: () => {
        checks += 1;
        return checks > 1 ? { passed: true, evidence: 'ok' } : { passed: false, evidence: 'too weak' };
    } }] });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(client.requested.at(-1), 'strong', 'the retry uses the escalated model');
    assert.equal(client.requested.filter((m) => m === 'strong').length, 1, 'only the retry escalates');
    assert.equal(client.requested.includes('m'), true, 'the first attempt kept the step model');
});

test('escalateModel: a transient empty response does not escalate', async () => {
    let calls = 0;
    const client = makeRecordingClient({
        runImpl: async () => { calls += 1; return calls === 1 ? FALLBACK_MESSAGE.EMPTY_RESPONSE : 'answer'; },
        getProfiles: async () => [{ id: 'm', name: 'M' }, { id: 'strong', name: 'Strong' }],
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, model: 'm', escalateModel: 'strong', maxRetries: 2 }] });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(calls, 2, 'the empty response was retried');
    assert.equal(client.requested.includes('strong'), false, 'a STEP_RETRY is not evidence the model is too weak');
});

test('escalateModel: without the field every attempt keeps the step model', async () => {
    let checks = 0;
    const client = makeRecordingClient({
        runImpl: async () => 'answer',
        getProfiles: async () => [{ id: 'm', name: 'M' }, { id: 'strong', name: 'Strong' }],
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, model: 'm', maxRetries: 2, verify: () => {
        checks += 1;
        return checks > 1 ? { passed: true, evidence: 'ok' } : { passed: false, evidence: 'too weak' };
    } }] });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(client.requested.includes('strong'), false, 'no escalation without escalateModel');
});

// ─── transient empty responses are retried, budget exhaustion is not ────────

test('naive engine: retries a transient empty response, then completes', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        return calls === 1 ? FALLBACK_MESSAGE.EMPTY_RESPONSE : 'recovered answer';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(calls, 2, 'the empty first attempt must be retried');
    assert.equal(outputs.a.output, 'recovered answer');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');
});

test('naive engine: a persistent empty response fails after maxRetries + 1 attempts', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => { calls++; return FALLBACK_MESSAGE.EMPTY_RESPONSE; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, maxRetries: 2 }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /no final answer after 3 attempt/);
    assert.equal(calls, 3, 'maxRetries=2 → three attempts');
});

test('naive engine: does not retry a MAX_ITERATIONS exhaustion', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => { calls++; return FALLBACK_MESSAGE.MAX_ITERATIONS; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, maxRetries: 3 }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /iteration limit/);
    assert.equal(calls, 1, 'a spent tool budget is fatal on the first attempt');
});

test('stateMachine engine: retries a transient empty response', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        return calls === 1 ? FALLBACK_MESSAGE.EMPTY_RESPONSE : 'sm answer';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'stateMachine' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(calls, 2, 'the empty first attempt must be retried');
    assert.equal((/** @type {any} */ (executor.steps)).get('a').status, 'completed');
    assert.match(JSON.stringify(outputs.a.output), /sm answer/);
});

// ─── step model roster guard (hallucinated planner model ids) ───────────────

test('a step model NOT in the backend roster degrades to defaultModel (no doomed request)', async () => {
    const client = makeRecordingClient({ runImpl: async () => 'answer', getProfiles: async () => [{ id: 'real-model', name: 'Real' }] });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'deepseek-v4-flash' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, model: 'fast-reporting-model' }] });

    await executor.execute({ userGoal: 'goal' });
    assert.deepEqual([...new Set(client.requested)], ['deepseek-v4-flash'],
        'the executor must never send a request for a model the backend does not support');
});

test('a step model present in the backend roster is honored', async () => {
    const client = makeRecordingClient({ runImpl: async () => 'answer', getProfiles: async () => [{ id: 'fast-reporting-model', name: 'Fast' }] });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'deepseek-v4-flash' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, model: 'fast-reporting-model' }] });

    await executor.execute({ userGoal: 'goal' });
    assert.deepEqual([...new Set(client.requested)], ['fast-reporting-model'],
        'a roster-valid step model must still be used');
});

test('the roster is fetched once per executor and reused across steps', async () => {
    let fetches = 0;
    const client = makeRecordingClient({ runImpl: async () => 'answer', getProfiles: async () => { fetches++; return [{ id: 'real-model', name: 'Real' }]; } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'deepseek-v4-flash' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a', model: 'hallucinated-a' },
        { ...SIMPLE_STEP, id: 'b', model: 'hallucinated-b', dependencies: ['a'] },
    ] });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(fetches, 1, 'the roster fetch must be cached per executor instance');
    assert.deepEqual([...new Set(client.requested)], ['deepseek-v4-flash']);
});

test('a failed roster fetch is retried, not cached empty — a later valid override still works', async () => {
    let fetches = 0;
    const client = makeRecordingClient({ runImpl: async () => 'answer', getProfiles: async () => {
            fetches++;
            if (fetches === 1) throw new Error('gateway blip');
            return [{ id: 'real-model', name: 'Real' }];
        } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'deepseek-v4-flash' } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, id: 'a', model: 'real-model' }] });
    await executor.execute({ userGoal: 'goal' });
    assert.deepEqual([...new Set(client.requested)], ['deepseek-v4-flash'], 'a failed fetch must degrade to defaultModel');
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, id: 'b', model: 'real-model' }] });
    await executor.execute({ userGoal: 'goal' });
    assert.deepEqual([...new Set(client.requested)], ['deepseek-v4-flash', 'real-model'],
        'a successful later fetch must re-enable valid overrides');
    assert.equal(fetches, 2, 'the failed fetch must not be cached as empty');
});

test('the roster guard applies to the stateMachine engine too', async () => {
    const client = makeRecordingClient({ runImpl: async () => 'good', getProfiles: async () => [{ id: 'real-model', name: 'Real' }] });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'stateMachine',
    } });
    executor.setSteps({ stepsList: [{ ...SIMPLE_STEP, model: 'fast-reporting-model' }] });

    await executor.execute({ userGoal: 'goal' });
    assert.deepEqual([...new Set(client.requested)], ['m'],
        'the SM engine must degrade a hallucinated step model to defaultModel');
});

// ─── replan schema: a single remaining step is a valid replan ───────────────

test('a 1-step plan validates under DAG_WORKFLOW_REPLAN_SCHEMA but not the initial-plan schema', () => {
    const singleStepPlan = {
        summary: 'Only the reporting step remains.',
        steps: [{
            id: 'report_graphql_sync',
            title: 'Report GraphQL sync',
            systemPrompt: 'Report the sync.',
            userPromptTemplate: 'Write the report.',
            dependencies: []
        }]
    };
    /** @type {any} */ const planResult = extractAndParseJson({ input: JSON.stringify(singleStepPlan), schema: DAG_WORKFLOW_PLAN_SCHEMA });
    assert.equal(planResult.success, false, 'the initial-plan schema must still demand >= 2 steps');
    /** @type {any} */ const replanResult = extractAndParseJson({ input: JSON.stringify(singleStepPlan), schema: DAG_WORKFLOW_REPLAN_SCHEMA });
    assert.equal(replanResult.success, true, 'a single remaining task is a valid replan');
    assert.equal(replanResult.data.steps.length, 1);
});

test('WorkflowPlanner.replan accepts a single-step answer from the model', async () => {
    const client = makeRecordingClient({ runImpl: async () => JSON.stringify({
        summary: 'Only one step remains.',
        steps: [{
            id: 'report_graphql_sync',
            title: 'Report GraphQL sync',
            systemPrompt: 'Report it.',
            userPromptTemplate: 'Write the report.',
            dependencies: []
        }]
    }), provider: 'openai' });
    const planner = new WorkflowPlanner({ options: { client, model: 'm' } });
    /** @type {any} */ const plan = await planner.replan({ objective: 'goal', failedStepId: 'failed_step', failureReason: '401 Model x is not supported', currentOutputs: {} });
    assert.equal(plan.steps.length, 1, 'a replan must be allowed to contain exactly one remaining step');
});

// ─── Scheduler-core routing ──────────────────────────────────────────────────

test('WorkflowExecutor: step sessions carry the client-registry breaker; open breaker fail-fasts the step with zero backend calls', async () => {
    const { getCircuitBreaker, BREAKER_OPEN_CODE } = await import('../lib/support/retry-policy.mjs');
    /** @type {any[]} */
    const attached = [];
    let backendCalls = 0;
    const client = {
        session: (/** @type {any} */ model) => {
            /** @type {any} */
            const s = {
                provider: 'openai', model,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                /** @param {{breaker: any}} arg0 */
                withCircuitBreaker({ breaker }) { attached.push(breaker); s._breaker = breaker; return s; },
                /** @param {{initialInput: any}} arg0 */
                async run({ initialInput: input }) {
                    if (isObjectiveRestatePrompt({ input })) return '';
                    if (s._breaker && !s._breaker.canRun()) {
                        throw Object.assign(new Error('Circuit breaker open'), { code: BREAKER_OPEN_CODE });
                    }
                    backendCalls++;
                    s._breaker?.recordSuccess();
                    return 'step answer';
                },
            };
            return s;
        },
    };
    const step = { id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.', dependencies: [] };

    const ex1 = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex1.setSteps({ stepsList: [step] });
    /** @type {any} */ const outputs = await ex1.execute({ userGoal: 'goal' });
    assert.equal(outputs.a.output, 'step answer');
    assert.equal(backendCalls, 1);
    assert.equal(attached[0], getCircuitBreaker({ client, key: 'openai:m' }), 'step shares the client registry breaker');

    for (let i = 0; i < 5; i++) getCircuitBreaker({ client, key: 'openai:m' }).recordFailure();
    const ex2 = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex2.setSteps({ stepsList: [step] });
    await assert.rejects(() => ex2.execute({ userGoal: 'goal' }), /could not be self-healed/);
    assert.equal(backendCalls, 1, 'open breaker made zero additional backend calls');
});

// ─── Scheduler-core branching proofs ─────────────────────────────────────────

test('parallel due set: a failing sibling neither abandons nor unrecords the rest', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        if (calls === 1) return 'The model reached the maximum tool iteration limit and could not provide a final text response.';
        return 'good answer';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a' },
        { ...SIMPLE_STEP, id: 'b', title: 'B' },
    ] });
    /** @type {any[]} */
    const completed = [];
    /** @type {any[]} */
    const errored = [];
    executor.on('workflow:step_complete', (e) => completed.push(e.stepId));
    executor.on('workflow:step_error', (e) => errored.push(e.stepId));
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /could not be self-healed|halted due to failures/);
    assert.equal(calls, 2, 'both siblings attempted — no abandonment');
    // ponytail: WHICH sibling lands the first call depends on the due-set
    assert.deepEqual([...completed, ...errored].sort(), ['a', 'b'], 'both siblings recorded exactly one outcome');
    assert.equal(errored.length, 1, 'the failing sibling recorded its failure');
    assert.equal(completed.length, 1, 'the healthy sibling recorded its output');
});

test('replan: a replan that SPAWNS brand-new steps runs them mid-run', async () => {
    let calls = 0;
    const client = makeFakeClient({ runImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    const replan = async () => ({
        steps: [
            { ...SIMPLE_STEP, userPromptTemplate: 'Retry it.' },
            { ...SIMPLE_STEP, id: 'spawned', title: 'Spawned', userPromptTemplate: 'Brand-new mid-run work.' },
        ],
    });
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal', planner: { replan }, evaluator: null });
    assert.equal(outputs.a.output, 'ok', 'the replanned step re-ran');
    assert.equal(outputs.spawned.output, 'ok', 'the spawned step ran mid-run');
});

// ─── empty-response retry: characterization + visibility ────────────────────
test('naive engine: an empty response is retried in a fresh session and surfaced as step_verify_fail', async () => {
    let runs = 0;
    /** @type {any[]} */
    const usedSessions = [];
    const client = {
        session: () => {
            const s = makeFakeSession({ runImpl: async () => {
                usedSessions.push(s);
                return ++runs === 1 ? FALLBACK_MESSAGE.EMPTY_RESPONSE : 'real answer';
            } });
            return s;
        },
    };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any[]} */
    const verifyFail = [];
    executor.on('workflow:step_verify_fail', (e) => verifyFail.push(e));
    /** @type {any} */ const outputs = await executor.execute({ userGoal: 'goal' });
    assert.equal(runs, 2, 'the step executed twice');
    assert.equal(new Set(usedSessions).size, 2, 'each attempt ran in a fresh session');
    assert.equal(outputs.a.output, 'real answer');
    assert.equal(verifyFail.length, 1, 'the silent retry is evented');
    assert.match(String(verifyFail[0].evidence), /empty response — retrying/);
});

test('DAG intake: a huge upstream output is capped with a visible marker', async () => {
    const huge = 'y'.repeat(20000);
    /** @type {any[]} */
    const prompts = [];
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        const text = Array.isArray(input) ? input.map((m) => String(m?.content ?? '')).join('\n') : String(input);
        prompts.push(text);
        return text.includes('=== Upstream Step Context ===') ? 'b done' : huge;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a' },
        { ...SIMPLE_STEP, id: 'b', dependencies: ['a'], userPromptTemplate: 'Summarize the upstream findings.' },
    ] });
    await executor.execute({ userGoal: 'goal' });
    const bPrompt = prompts.find((p) => p.includes('Summarize the upstream findings.')) ?? '';
    assert.ok(bPrompt.includes('=== Upstream Step Context ==='), 'the intake block is present');
    assert.ok(bPrompt.includes('…[truncated'), 'the cap marker is visible');
    assert.ok(!bPrompt.includes(huge), 'the full 20k payload is not inlined');
});

// ─── transfer: ledger rows vs stringified intake ────────────────────────────

test('DAG transfer: ledger injects upstream message rows, not a stringified block', async () => {
    /** @type {any[]} */
    const inputs = [];
    let n = 0;
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        inputs.push(input);
        n += 1;
        return n === 1 ? 'a answer' : 'b answer';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a' },
        { ...SIMPLE_STEP, id: 'b', dependencies: ['a'], transfer: 'ledger' },
    ] });
    await executor.execute({ userGoal: 'goal' });

    const bInput = inputs[1];
    assert.ok(Array.isArray(bInput), 'ledger mode feeds message rows');
    assert.deepEqual(
        bInput.map((m) => [m.role, m.content]),
        [['user', 'Do the thing.'], ['assistant', 'a answer'], ['user', 'Do the thing.']],
        "upstream rows replay with their original roles, then the step's own prompt",
    );
    assert.ok(!bInput.some((m) => String(m.content).includes('=== Upstream Step Context ===')), 'no stringified intake block');
});

test('DAG transfer: ledger rows are injected once across a verify-retry', async () => {
    /** @type {any[]} */
    const inputs = [];
    let n = 0;
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        inputs.push(input);
        n += 1;
        return n === 1 ? 'a answer' : `b attempt ${n - 1}`;
    } });
    let checks = 0;
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a' },
        { ...SIMPLE_STEP, id: 'b', dependencies: ['a'], transfer: 'ledger',
            verify: () => { checks += 1; return { passed: checks > 1, evidence: 'not yet' }; } },
    ] });
    await executor.execute({ userGoal: 'goal' });

    assert.equal(checks, 2, 'b retried once after the failed verification');
    const countA = (/** @type {any[]} */ arr) => arr.filter((m) => m.role === 'assistant' && m.content === 'a answer').length;
    assert.equal(countA(/** @type {any[]} */ (inputs[1])), 1, 'first attempt carries the upstream row once');
    assert.equal(countA(/** @type {any[]} */ (inputs[2])), 1, 'the retry reuses node.messages — no re-injection, no doubling');
});

test('DAG transfer: ledger-selected windows the tail and marks the dropped prefix', async () => {
    /** @type {any[]} */
    const inputs = [];
    let n = 0;
    const client = makeFakeClient({ runImpl: async (/** @type {any} */ input) => {
        inputs.push(input);
        n += 1;
        return `answer ${n}`;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a' },
        { ...SIMPLE_STEP, id: 'b', dependencies: ['a'] },
        { ...SIMPLE_STEP, id: 'c', dependencies: ['b'], intakeMode: 'all', transfer: { preset: 'ledger-selected', tail: 1 } },
    ] });
    await executor.execute({ userGoal: 'goal' });

    const cInput = /** @type {any[]} */ (inputs[2]);
    assert.equal(cInput[0].role, 'user');
    assert.ok(String(cInput[0].content).includes('earlier entries omitted'), 'dropped prefix is visible, not silent');
    // the retained tail is b's rows, in order, then c's own prompt
    assert.ok(cInput.some((m) => m.role === 'assistant' && m.content === 'answer 2'), "b's rows are kept");
    assert.ok(!cInput.some((m) => m.role === 'assistant' && m.content === 'answer 1'), "a's rows are dropped");
});

test('DAG transfer: a foreign-backend upstream degrades to a digest (no verbatim replay)', async () => {
    /** @type {any[]} */
    const inputs = [];
    let n = 0;
    /** @type {any} */
    const client = {
        getProfiles: async () => [{ id: 'mA' }, { id: 'mB' }],
        session: (/** @type {any} */ model) => makeFakeSession({
            provider: model === 'mB' ? 'openai' : 'anthropic',
            runImpl: async (/** @type {any} */ input) => {
                inputs.push(input);
                n += 1;
                return n === 1 ? 'a answer' : 'b answer';
            },
        }),
    };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'mA' } });
    executor.setSteps({ stepsList: [
        { ...SIMPLE_STEP, id: 'a' },
        { ...SIMPLE_STEP, id: 'b', dependencies: ['a'], model: 'mB', transfer: 'ledger' },
    ] });
    await executor.execute({ userGoal: 'goal' });

    const bInput = /** @type {any[]} */ (inputs[1]);
    assert.ok(!bInput.some((m) => m.role === 'assistant'), 'foreign rows are not replayed as assistant turns');
    assert.ok(bInput.some((m) => m.role === 'user' && String(m.content).includes('[Output from Step "a"]') && String(m.content).includes('a answer')), 'degraded to a user digest');
});

