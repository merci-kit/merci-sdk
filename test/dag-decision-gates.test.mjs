// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowEvaluator } from '../lib/agentic/planning/evaluator.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { createDecisionGate } from '../lib/agentic/decision-gate.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { decisionStepVerdict } from '../lib/agentic/planning/executor-helpers.mjs';

/** @param {{runImpl: any}} arg0 */
function makeFakeSession({ runImpl }) {
    return {
        provider: 'openai',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withParameters() { return this; },
        /** @param {{initialInput: any, options: any}} arg0 */
        run: ({ initialInput, options }) =>
            isObjectiveRestatePrompt({ input: initialInput }) ? Promise.resolve('') : runImpl(initialInput, options),
    };
}

/** @param {{runImpl: any}} arg0 */
function makeFakeClient({ runImpl }) {
    return { provider: 'openai', session: () => makeFakeSession({ runImpl }) };
}

/** @param {{probability: number, confidence?: number}} arg0 */
function noulAnswer({ probability, confidence }) {
    return { type: 'noul', probability, ...(confidence === undefined ? {} : { confidence }) };
}

/** @param {{answer?: any, ask?: any}} [arg0] */
function fakeGate({ answer = null, ask = null } = {}) {
    return createDecisionGate({ ask: ask ?? (async () => ({ answers: { decision: answer } })) });
}

const SIMPLE_STEP = {
    id: 'a',
    title: 'A',
    systemPrompt: 'Be terse.',
    userPromptTemplate: 'Do the thing.',
    dependencies: [],
};

const NODE = { id: 'a', title: 'A', output: 'answer' };

// ─── evaluator seam ─────────────────────────────────────────────────────────

test('evaluator: a confident gate pass skips the LLM call', async () => {
    const client = { provider: 'openai', session: () => { throw new Error('LLM must not be called'); } };
    const evaluator = new WorkflowEvaluator({ options: {
        client: /** @type {any} */ (client),
        decisionGate: fakeGate({ answer: noulAnswer({ probability: 0.97, confidence: 0.97 }) }),
    } });
    const verdict = await evaluator.evaluate({ node: NODE, outputs: {}, objective: 'goal' });
    assert.deepEqual(verdict, {
        replanRequired: false,
        reason: 'decision_gate_pass',
        decision: { verdict: true, certainty: 0.97 },
    });
});

test('evaluator: an escalated gate falls through to the LLM verdict', async () => {
    const client = makeFakeClient({ runImpl: async () => '{"replanRequired":true,"reason":"missing evidence"}' });
    const evaluator = new WorkflowEvaluator({ options: {
        client: /** @type {any} */ (client),
        decisionGate: fakeGate({ answer: noulAnswer({ probability: 0.6 }) }),
    } });
    const verdict = await evaluator.evaluate({ node: NODE, outputs: {}, objective: 'goal' });
    assert.equal(verdict.replanRequired, true);
    assert.equal(verdict.reason, 'missing evidence');
});

test('evaluator: a gate error falls through to the LLM verdict', async () => {
    const client = makeFakeClient({ runImpl: async () => '{"replanRequired":true,"reason":"missing evidence"}' });
    const evaluator = new WorkflowEvaluator({ options: {
        client: /** @type {any} */ (client),
        decisionGate: fakeGate({ ask: async () => { throw new Error('dm down'); } }),
    } });
    const verdict = await evaluator.evaluate({ node: NODE, outputs: {}, objective: 'goal' });
    assert.equal(verdict.reason, 'missing evidence');
    assert.notEqual(verdict.reason, 'decision_gate_pass');
});

// ─── executor outage seam ───────────────────────────────────────────────────

test('executor outage: a confident gate verifies the step instead of shipping it unverified', async () => {
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        decisionGate: fakeGate({ answer: noulAnswer({ probability: 0.97, confidence: 0.97 }) }),
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });
    /** @type {any[]} */
    const skipped = [];
    executor.on(EVENTS.WORKFLOW.VERIFICATION_SKIPPED, (e) => skipped.push(e));

    /** @type {any} */ const outputs = await executor.execute({
        userGoal: 'goal',
        planner: { replan: async () => { throw new Error('must not replan'); } },
        evaluator: { evaluate: async () => { throw new Error('still down'); } },
    });
    assert.equal(outputs.a.output, 'answer', 'the workflow completes');
    assert.equal(executor._verifiedIds.has('a'), true, 'the gate pass verifies the step');
    assert.equal(skipped.length, 1, 'one skipped notice names the gate pass');
    assert.match(String(skipped[0].reason), /decision_gate_pass/);
    assert.ok(executor._workflowTokensSpent > 0, 'the outage verdict is charged to the executor cap');
});

// ─── replan seam ────────────────────────────────────────────────────────────

test('applyReplan seam: a confident retry_same re-runs the step without the planner', async () => {
    let runs = 0;
    let evaluateCalls = 0;
    let replanCalls = 0;
    const client = makeFakeClient({ runImpl: async () => { runs++; return 'answer'; } });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        decisionGate: createDecisionGate({ ask: async () => ({ answers: { decision: {
            type: 'choice', choice: 'retry_same', confidence: 0.95,
        } } }) }),
    } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({
        userGoal: 'goal',
        planner: { replan: async () => { replanCalls++; throw new Error('planner must not run'); } },
        evaluator: { evaluate: async () => {
            evaluateCalls++;
            return evaluateCalls === 1
                ? { replanRequired: true, reason: 'bad' }
                : { replanRequired: false, reason: 'ok' };
        } },
    });
    assert.equal(runs, 2, 'the retry_same decision re-runs the step once');
    assert.equal(replanCalls, 0, 'the planner is never called');
    assert.equal(executor._decisionRetries.get('a'), 1, 'the retry is claimed');
    assert.ok(executor._workflowTokensSpent > 0, 'the replan classifier is charged to the executor cap');
    assert.equal(outputs.a.output, 'answer');
});

// ─── no-gate parity ─────────────────────────────────────────────────────────

test('no decision gate: the one-step executor behaves as before', async () => {
    const client = makeFakeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [SIMPLE_STEP] });

    /** @type {any} */ const outputs = await executor.execute({
        userGoal: 'goal',
        planner: { replan: async () => { throw new Error('must not replan'); } },
        evaluator: { evaluate: async () => ({ replanRequired: false, reason: 'ok' }) },
    });
    assert.equal(executor.decisionGate, null);
    assert.equal(outputs.a.output, 'answer');
});

test('evaluator: an empty or oversized output never skips the LLM verifier', async () => {
    let asked = 0;
    const client = makeFakeClient({ runImpl: async () => '{"replanRequired":true,"reason":"llm saw it"}' });
    const evaluator = new WorkflowEvaluator({ options: {
        client: /** @type {any} */ (client),
        decisionGate: fakeGate({ ask: async () => { asked++; throw new Error('gate must not be consulted'); } }),
    } });
    const empty = await evaluator.evaluate({ node: { id: 'a', output: '' }, outputs: {}, objective: 'goal' });
    const huge = await evaluator.evaluate({ node: { id: 'a', output: 'x'.repeat(20_000) }, outputs: {}, objective: 'goal' });
    assert.equal(empty.reason, 'llm saw it');
    assert.equal(huge.reason, 'llm saw it');
    assert.equal(asked, 0, 'no gate call on a state that cannot justify a skip');
});

test('decisionStepVerdict: an empty or oversized output is never a gate verdict', async () => {
    let asked = 0;
    const gate = fakeGate({ ask: async () => { asked++; return { answers: { decision: noulAnswer({ probability: 0.97, confidence: 0.97 }) } }; } });
    const empty = await decisionStepVerdict({ gate, node: { id: 'a', output: '' }, outputs: {} });
    const huge = await decisionStepVerdict({ gate, node: { id: 'a', output: 'x'.repeat(20_000) }, outputs: {} });
    assert.equal(empty, null);
    assert.equal(huge, null);
    assert.equal(asked, 0);
});
