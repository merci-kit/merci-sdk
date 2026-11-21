// @ts-check
/**
 * C-7: planner and evaluator calls are real model spend.
 *
 * `structuredLlmCall` already accepted an `onUsage` sink, but the planner and
 * both evaluators never got one, so the workflow cap never moved for a replan:
 * a replan-heavy run could exceed `budget.maxTotalTokens` by every planning
 * call it made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { WorkflowPlanner } from '../lib/agentic/planning/planner.mjs';
import { WorkflowEvaluator } from '../lib/agentic/planning/evaluator.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';

const REPLAN_ANSWER = JSON.stringify({
    summary: 'Retry the same step.',
    steps: [{
        id: 'a',
        title: 'A',
        systemPrompt: 'Be terse.',
        userPromptTemplate: 'Try again.',
        dependencies: [],
    }],
});

const STEP = { id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'Do the thing.', dependencies: [] };

/**
 * One session factory for both roles: a replanning call answers a schema-valid
 * plan (and reports `planningTokens`), any other call fails — which is what
 * forces the executor to replan.
 * @param {{planningCalls: number[], planningTokens: number}} arg0
 */
function client({ planningCalls, planningTokens }) {
    return {
        provider: 'openai',
        /** @param {string} _model */
        session(_model) {
            let systemMessage = '';
            /** @type {any} */
            const session = {
                provider: 'openai',
                withSystemMessage(/** @type {string} */ content) { systemMessage = String(content ?? ''); return session; },
                withTools() { return session; },
                withParameters() { return session; },
                withTimeout() { return session; },
                /** @param {{options?: any}} arg0 */
                async run({ options }) {
                    if (!systemMessage.includes('Replanner')) throw new Error('boom');
                    planningCalls.push(1);
                    options?.onEvent?.({ type: 'quota', data: {
                        prompt_tokens: planningTokens - 100,
                        completion_tokens: 100,
                        total_tokens: planningTokens,
                    } });
                    return REPLAN_ANSWER;
                },
            };
            return session;
        },
    };
}

/** A client whose step answers text, so a wave completes. */
function passingClient() {
    return {
        provider: 'openai',
        session() {
            /** @type {any} */
            const session = {
                provider: 'openai',
                withSystemMessage() { return session; },
                withTools() { return session; },
                withParameters() { return session; },
                withTimeout() { return session; },
                async run() { return 'answer'; },
            };
            return session;
        },
    };
}

test('C-7 a replan is charged to the workflow cap', async () => {
    /** @type {number[]} */
    const planningCalls = [];
    const fake = client({ planningCalls, planningTokens: 500 });
    const executor = new WorkflowExecutor({ options: { client: fake, defaultModel: 'm', maxReplanCount: 5, budget: { maxTotalTokens: 600 } } });
    executor.setSteps({ stepsList: [STEP] });
    const planner = new WorkflowPlanner({ options: { client: fake, model: 'm' } });

    await assert.rejects(
        () => executor.execute({ userGoal: 'goal', planner, evaluator: null }),
        BudgetExceededError,
    );
    // W2-4: the overrun is a budget stop, not a parse failure — it is not
    // retried, so the call that crossed the cap costs exactly one call.
    assert.equal(planningCalls.length, 2, 'the overrun is charged once, never re-tried as a parse failure');
    assert.equal(executor._workflowTokensSpent, 1_000, 'the ledger holds the two charged calls, not the retries');
});

test('W2-9 a host sink does not disable the workflow cap', async () => {
    /** @type {number[]} */
    const planningCalls = [];
    const fake = client({ planningCalls, planningTokens: 500 });
    const executor = new WorkflowExecutor({ options: { client: fake, defaultModel: 'm', maxReplanCount: 1 } });
    executor.setSteps({ stepsList: [STEP] });
    /** @type {number[]} */
    const seen = [];
    const planner = new WorkflowPlanner({ options: { client: fake, model: 'm', onUsage: ({ total_tokens }) => seen.push(Number(total_tokens)) } });

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner, evaluator: null }));
    assert.equal(seen.length, 1, "the caller's own sink still runs once");
    assert.equal(executor._workflowTokensSpent, 500, 'and the workflow cap is charged too');
});

test('W2-9 a planner shared by two executors charges each caller', async () => {
    /** @type {number[]} */
    const planningCalls = [];
    const fake = client({ planningCalls, planningTokens: 500 });
    /** @type {number[]} */
    const seen = [];
    const planner = new WorkflowPlanner({ options: { client: fake, model: 'm', onUsage: ({ total_tokens }) => seen.push(Number(total_tokens)) } });
    const first = new WorkflowExecutor({ options: { client: fake, defaultModel: 'm', maxReplanCount: 1 } });
    const second = new WorkflowExecutor({ options: { client: fake, defaultModel: 'm', maxReplanCount: 1 } });
    first.setSteps({ stepsList: [STEP] });
    second.setSteps({ stepsList: [STEP] });

    await assert.rejects(() => first.execute({ userGoal: 'goal', planner, evaluator: null }));
    await assert.rejects(() => second.execute({ userGoal: 'goal', planner, evaluator: null }));
    assert.equal(seen.length, 2, "the caller's sink runs once per planning call");
    assert.equal(first._workflowTokensSpent, 500, 'the first executor is charged');
    assert.equal(second._workflowTokensSpent, 500, 'the second executor is charged, not the first host again');
});

test('C-7 a step evaluator is charged to the workflow cap', async () => {
    /** @type {number[]} */
    const planningCalls = [];
    const evaluator = new WorkflowEvaluator({ options: { client: client({ planningCalls, planningTokens: 500 }), model: 'm' } });
    /** @type {any} */
    const evaluatorAny = evaluator;
    evaluatorAny.evaluate = async function evaluate() {
        this.onUsage?.({ total_tokens: 40 });
        return { replanRequired: false, reason: 'ok' };
    };
    const executor = new WorkflowExecutor({ options: { client: passingClient(), defaultModel: 'm' } });
    executor.setSteps({ stepsList: [STEP] });
    // The executor only evaluates when a planner is present too.
    const planner = new WorkflowPlanner({ options: { client: passingClient(), model: 'm' } });

    await executor.execute({ userGoal: 'goal', planner, evaluator });
    assert.equal(typeof evaluator.onUsage, 'function', 'the step evaluator got the workflow sink');
    assert.equal(executor._workflowTokensSpent, 40, 'its tokens reached the workflow ledger');
});

test('C-7 a plan evaluator is charged to the workflow cap', async () => {
    let ran = 0;
    /** @type {any} */
    const planEvaluator = {
        async evaluate() {
            ran += 1;
            this.onUsage?.({ total_tokens: 40 });
            return { verdict: 'continue' };
        },
        onUsage: undefined,
    };
    const executor = new WorkflowExecutor({ options: { client: passingClient(), defaultModel: 'm', planEvaluator, planEvaluateEvery: 1 } });
    executor.setSteps({ stepsList: [STEP] });

    await executor.execute({ userGoal: 'goal' });
    assert.ok(ran >= 1, 'the plan evaluator ran at the wave boundary');
    assert.equal(executor._workflowTokensSpent, 40, 'its tokens reached the workflow ledger');
});
