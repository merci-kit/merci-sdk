// @ts-check
/**
 * @file Session-level decision wiring — gate usage, budget charge, runStep
 * forwarding, and the agentic runtime composition root.
 * @version 0.24.0
 *
 * @description
 * The seams are only useful if one gate can travel: a session carries it into
 * the loop, every engine's `runStep` forwards it, its usage is charged to the
 * session's pool, and `createAgenticRuntime` hands the option fragments back.
 * These tests pin those four contracts and the opt-out (no decision role).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionGate } from '../lib/agentic/decision-gate.mjs';
import { attachDecisionUsage, mergeDecisionGate } from '../lib/agentic/decision-usage.mjs';
import { getBudgetPool } from '../lib/agentic/budget-pool.mjs';
import { runStep } from '../lib/agentic/step.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { createAgenticRuntime } from '../lib/index.mjs';
import { ensureEnvLoaded } from '../lib/support/utils.mjs';
import { noulQuestion } from '../lib/messaging/decision.mjs';

ensureEnvLoaded();

const QUESTION = noulQuestion({ instructions: 'Is this a billing issue?' });

/**
 * @param {{assign: Record<string, string|undefined>, fn: () => (void|Promise<void>)}} arg0
 */
async function withEnv({ assign, fn }) {
    /** @type {Record<string, string|undefined>} */
    const saved = {};
    for (const key of Object.keys(assign)) {
        saved[key] = process.env[key];
        if (assign[key] === undefined) delete process.env[key];
        else process.env[key] = assign[key];
    }
    try {
        await fn();
    } finally {
        for (const key of Object.keys(assign)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

/** @param {{usage?: any}} [arg0] */
function usageAsk({ usage = { inputTokens: 7, outputTokens: 0, cost: 0.001 } } = {}) {
    return async () => ({ model: 'm', answers: { decision: { type: 'noul', probability: 0.95, confidence: 0.95 } }, usage });
}

test('gate.withUsage: a derived gate reports usage without losing the original listener', async () => {
    /** @type {any[]} */
    const original = [];
    /** @type {any[]} */
    const extra = [];
    const base = createDecisionGate({ ask: usageAsk(), seam: 'base', onUsage: (event) => original.push(event) });
    const derived = base.withUsage({ onUsage: (event) => extra.push(event) });

    await derived.gate({ state: 's', question: QUESTION });

    assert.equal(original.length, 1);
    assert.equal(extra.length, 1);
    assert.equal(extra[0].seam, 'base', 'the derived gate keeps the seam');
    assert.equal(extra[0].usage.inputTokens, 7);
});

test('attachDecisionUsage: a decision call charges the session budget pool', async () => {
    const session = { _budget: { maxTotalTokens: 1_000 } };
    const gate = attachDecisionUsage({ session, gate: createDecisionGate({ ask: usageAsk(), seam: 'charged' }) });

    await gate.gate({ state: 's', question: QUESTION });

    const pool = getBudgetPool({ session });
    assert.ok(pool, 'the budget created a pool');
    assert.equal(pool.usage.total_tokens, 7);
    assert.equal(pool.usage.cost_usd, 0.001);
});

test('attachDecisionUsage: the same gate is charged once, even when re-wrapped', async () => {
    const session = { _budget: { maxTotalTokens: 1_000 } };
    const gate = createDecisionGate({ ask: usageAsk(), seam: 'once' });
    const first = /** @type {any} */ (attachDecisionUsage({ session, gate }));
    const second = attachDecisionUsage({ session, gate: first });
    assert.equal(second, first, 'a derived gate is recognised and returned as-is');

    await second.gate({ state: 's', question: QUESTION });

    const pool = getBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.total_tokens, 7, 'one call, one charge');
    assert.equal(pool.usage.cost_usd, 0.001);
});

test('attachDecisionUsage: a wire with no usage is estimated, never charged zero', async () => {
    const session = { _budget: { maxTotalTokens: 1_000 } };
    const gate = /** @type {any} */ (attachDecisionUsage({ session, gate: createDecisionGate({
        ask: async () => ({ answers: { decision: { type: 'noul', probability: 0.95, confidence: 0.95 } } }),
        seam: 'estimate',
    }) }));

    await gate.gate({ state: 'x'.repeat(400), question: QUESTION });

    const pool = getBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.estimated_tokens, 100, 'state chars / 4');
    assert.equal(pool.usage.total_tokens, 100);
});

test('attachDecisionUsage: a session without a budget is charged nothing and still answers', async () => {
    const session = /** @type {any} */ ({});
    const gate = /** @type {any} */ (attachDecisionUsage({ session, gate: createDecisionGate({ ask: usageAsk(), seam: 'free' }) }));
    const result = await gate.gate({ state: 's', question: QUESTION });
    assert.equal(result.verdict, true);
    assert.equal(session._budgetPool, undefined);
});

test('mergeDecisionGate: the session gate is the default, an explicit one wins', () => {
    const sessionGate = { tag: 'session' };
    const explicit = { tag: 'explicit' };
    const options = {};
    assert.equal(mergeDecisionGate({ options, gate: null }), options, 'no gate leaves the options untouched');
    assert.deepEqual(mergeDecisionGate({ options: {}, gate: sessionGate }), { decisionGate: sessionGate });
    assert.deepEqual(mergeDecisionGate({ options: { decisionGate: explicit }, gate: sessionGate }), { decisionGate: explicit });
});

test('withDecisionGate: the session carries the gate and can clear it', () => {
    const builder = new ChatSessionBuilder();
    const gate = createDecisionGate({ ask: usageAsk(), seam: 'session' });
    assert.equal(builder.withDecisionGate({ gate }), builder, 'fluent');
    assert.equal(typeof /** @type {any} */ (builder)._decisionGate.gate, 'function');
    builder.withDecisionGate({});
    assert.equal(/** @type {any} */ (builder)._decisionGate, null);
});

test('runStep: the gate reaches the loop, wrapped once for the step pool', async () => {
    /** @type {any} */
    let captured = null;
    const session = {
        provider: 'openai',
        run: async (/** @type {{options: any}} */ { options }) => { captured = options; return 'ok'; },
    };
    const gate = createDecisionGate({ ask: usageAsk(), seam: 'step' });
    await runStep({
        step: { id: 'a', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
        deps: { session, decisionGate: gate, configureSession: false },
    });
    assert.equal(typeof captured.decisionGate.gate, 'function', 'the loop receives a gate');
    assert.notEqual(captured.decisionGate, gate, 'it is wrapped for this step session');

    /** @type {any} */
    let preAttached = null;
    const sessionWithGate = {
        provider: 'openai',
        _decisionGate: gate,
        run: async (/** @type {{options: any}} */ { options }) => { preAttached = options; return 'ok'; },
    };
    await runStep({
        step: { id: 'b', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
        deps: { session: sessionWithGate, decisionGate: gate, configureSession: false },
    });
    assert.equal(/** @type {any} */ (sessionWithGate)._decisionUsageGates, undefined, 'no second session listener is attached');
    assert.equal(typeof preAttached.decisionGate.gate, 'function', 'the step still gets a per-step sink gate');
});

test('createAgenticRuntime: all three roles, one gate, fragments for every flow', async () => {
    await withEnv({
        assign: {
            GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: 'g-model',
            EMBEDDING_PROVIDER: 'openai', EMBEDDING_MODEL: 'e-model',
            DECISION_PROVIDER: 'openai', DECISION_MODEL: 'd-model',
        },
        fn: async () => {
            /** @type {any[]} */
            const usage = [];
            const runtime = await createAgenticRuntime({
                seams: ['dag.evaluator', 'sm.verify'],
                onDecisionUsage: (event) => usage.push(event),
                clientFactory: async () => ({ client: {
                    session: () => ({}),
                    embed: () => ({}),
                    decisions: { ask: usageAsk() },
                } }),
            });
            assert.deepEqual(Object.keys(runtime.roles), ['generative', 'embedding', 'decision']);
            assert.equal(runtime.gate.available, true);
            assert.deepEqual(Object.keys(runtime.gates), ['dag.evaluator', 'sm.verify']);
            assert.equal(runtime.gateFor({ seam: 'dag.evaluator' }), runtime.gates['dag.evaluator'], 'gates are cached per seam');
            assert.equal(runtime.sessionOptions.decisionGate, runtime.gate);
            assert.equal(runtime.dag.evaluatorOptions.decisionGate, runtime.gate);
            assert.equal(runtime.sm.options.decisionGate, runtime.gate);
            assert.equal(runtime.discussion.options.decisionGate, runtime.gate);
            assert.equal(typeof runtime.guardrails.decisionTest({ question: QUESTION }), 'function');
            assert.equal(typeof runtime.memory.reranker, 'function');
            assert.equal(typeof runtime.evals.scorer({ question: QUESTION }), 'function');

            await runtime.gate.gate({ state: 's', question: QUESTION });
            assert.equal(usage.length, 1, 'the runtime listener sees the usage');
        },
    });
});

test('createAgenticRuntime: without the decision role every gate is inert', async () => {
    await withEnv({
        assign: { GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: 'g-model' },
        fn: async () => {
            const runtime = await createAgenticRuntime({
                roles: ['generative'],
                clientFactory: async () => ({ client: { session: () => ({}) } }),
            });
            assert.equal(runtime.decision, null);
            assert.equal(runtime.gate.available, false);
            assert.equal(runtime.memory.reranker, null);
            const verdict = await runtime.gate.gate({ state: 's', question: QUESTION });
            assert.equal(verdict.escalated, true, 'no surface escalates; the flow keeps its LLM path');

            const rule = runtime.guardrails.decisionTest();
            assert.equal(await rule('anything'), false, 'the guardrail rule never trips');
            const scorer = runtime.evals.scorer();
            const scored = await scorer({ observation: { output: 'answer' } });
            assert.equal(scored.skipped, true, 'the scorer skips instead of failing the case');
        },
    });
});

test('runStep: a created step session records decisions in its usage, not its budget', async () => {
    /** @type {any} */
    let session = null;
    session = {
        provider: 'openai',
        run: async (/** @type {{options: any}} */ { options }) => {
            await options.decisionGate.gate({ state: 's', question: QUESTION });
            return 'ok';
        },
    };
    const client = { session: () => session };
    const outcome = await runStep({
        step: { id: 'a', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
        deps: {
            client,
            model: 'm',
            decisionGate: createDecisionGate({ ask: usageAsk(), seam: 'step-budget' }),
            budget: { maxTotalTokens: 1_000 },
            configureSession: false,
        },
    });
    assert.equal(session._budget, undefined, 'the run cap is never written to the session');
    assert.equal(session._budgetPool, undefined, 'no pool is created without a session budget');
    assert.equal(/** @type {any} */ (outcome.usage).decision_tokens, 7, 'the step usage carries the decision tokens');
});

test('runStep: a provided group session records decisions too', async () => {
    const session = {
        provider: 'openai',
        run: async (/** @type {{options: any}} */ { options }) => {
            await options.decisionGate.gate({ state: 's', question: QUESTION });
            return 'ok';
        },
    };
    const outcome = await runStep({
        step: { id: 'a', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
        deps: {
            session,
            decisionGate: createDecisionGate({ ask: usageAsk(), seam: 'group-budget' }),
            budget: { maxTotalTokens: 1_000 },
            configureSession: false,
        },
    });
    assert.equal(/** @type {any} */ (outcome.usage).decision_tokens, 7);
    assert.equal(/** @type {any} */ (session)._budget, undefined, 'a provided session is not budgeted by the step');
});

test('withDecisionGate: attaching the same raw gate twice keeps the charged gate', async () => {
    const session = new ChatSessionBuilder();
    session.withBudget({ budget: { maxTotalTokens: 1_000 } });
    const gate = createDecisionGate({ ask: usageAsk(), seam: 'twice' });
    session.withDecisionGate({ gate });
    const first = /** @type {any} */ (session)._decisionGate;
    session.withDecisionGate({ gate });
    const second = /** @type {any} */ (session)._decisionGate;

    assert.equal(second, first, 'the derived gate is kept, not replaced by the raw one');
    await second.gate({ state: 's', question: QUESTION });
    const pool = getBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.total_tokens, 7);
});

test('runStep: a reused session charges every step, not just the first', async () => {
    const session = {
        provider: 'openai',
        run: async (/** @type {{options: any}} */ { options }) => {
            await options.decisionGate.gate({ state: 's', question: QUESTION });
            return 'ok';
        },
    };
    const gate = createDecisionGate({ ask: usageAsk(), seam: 'reuse' });
    for (let i = 0; i < 3; i++) {
        await runStep({
            step: { id: `s${i}`, systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
            deps: { session, decisionGate: gate, budget: { maxTotalTokens: 1_000 }, configureSession: false },
        });
    }
    assert.equal(/** @type {any} */ (session)._decisionUsage.total_tokens, 21, 'three steps, three charges');
});
