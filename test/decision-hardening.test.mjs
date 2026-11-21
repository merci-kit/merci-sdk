// @ts-check
/**
 * @file Decision hardening — ownership, cap unification, memory admission,
 * and threshold calibration.
 * @version 0.24.0
 */

import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';

import { createDecisionGate } from '../lib/agentic/decision-gate.mjs';
import { attachDecisionUsage, mergeRunUsage } from '../lib/agentic/decision-usage.mjs';
import { getBudgetPool } from '../lib/agentic/budget-pool.mjs';
import { runStep } from '../lib/agentic/step.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { decisionCalibration } from '../lib/agentic/decision-calibration.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { noulQuestion } from '../lib/messaging/decision.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const QUESTION = noulQuestion({ instructions: 'Is this a billing issue?' });

/** @param {{usage?: any}} [arg0] */
function usageAsk({ usage = { inputTokens: 7, outputTokens: 0, cost: 0.001 } } = {}) {
    return async () => ({ model: 'm', answers: { decision: { type: 'noul', probability: 0.95, confidence: 0.95 } }, usage });
}

// ─── gate ownership ─────────────────────────────────────────────────────────

test('a derived gate cannot be shared with another session', () => {
    const sessionA = { _budget: { maxTotalTokens: 1_000 } };
    const sessionB = { _budget: { maxTotalTokens: 1_000 } };
    const raw = createDecisionGate({ ask: usageAsk(), seam: 'owned' });
    const derived = attachDecisionUsage({ session: sessionA, gate: raw });

    assert.throws(
        () => attachDecisionUsage({ session: sessionB, gate: derived }),
        (error) => {
            assert.ok(error instanceof ConfigurationError);
            assert.match(error.message, /belongs to one session/);
            return true;
        },
    );
});

// ─── runStep: budget borrowed for the step, usage merged ───────────────────

test('runStep: decision spend is in the returned usage and the session is untouched', async () => {
    const session = /** @type {any} */ ({
        provider: 'openai',
        run: async (/** @type {{options: any}} */ { options }) => {
            await options.decisionGate.gate({ state: 's', question: QUESTION });
            session._lastRunUsage = { total_tokens: 10, prompt_tokens: 10, completion_tokens: 0 };
            return 'ok';
        },
    });
    const outcome = await runStep({
        step: { id: 'a', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
        deps: {
            session,
            decisionGate: createDecisionGate({ ask: usageAsk(), seam: 'step' }),
            budget: { maxTotalTokens: 1_000 },
            configureSession: false,
        },
    });

    assert.equal(session._budget, undefined, 'the session budget is never borrowed or mutated');
    assert.equal(session._budgetPool, undefined, 'no pool is created on a session without a budget');
    assert.ok(outcome.usage);
    const usage = /** @type {any} */ (outcome.usage);
    assert.equal(usage.total_tokens, 17, '10 LLM + 7 decision');
    assert.equal(usage.decision_tokens, 7);
    assert.equal(usage.cost_usd, undefined, 'an unknown LLM cost is not made complete by a known decision cost');
    assert.equal(usage.decision_cost_usd, 0.001, 'the decision cost is reported separately');
});

test('mergeRunUsage: no decision spend leaves the usage untouched', () => {
    const usage = { total_tokens: 10 };
    assert.equal(mergeRunUsage({ usage, decisionTokens: 0 }), usage);
    assert.deepEqual(mergeRunUsage({ usage: null, decisionTokens: 5 }), { total_tokens: 5, decision_tokens: 5 });
});

// ─── memory admission ───────────────────────────────────────────────────────

/** @param {{onStore: (content: string) => void}} arg0 */
function makeProvider({ onStore }) {
    /** @type {any[]} */
    const facts = [];
    return {
        facts,
        load: async () => {},
        save: async () => {},
        query: async () => [],
        /** @param {{content: string, category?: string}} arg0 */
        store: async ({ content, category }) => {
            onStore(content);
            const fact = { id: String(facts.length + 1), content, category, timestamp: Date.now() };
            facts.push(fact);
            return fact;
        },
        getBankDescriptions: () => 'default bank',
    };
}

function distillClient() {
    return {
        session: () => ({
            withSystemMessage() { return this; },
            withParameters() { return this; },
            run: async () => JSON.stringify({
                newFacts: [
                    { content: 'Likes dark mode', category: 'preference', targetBanks: [] },
                    { content: 'Said hello', category: 'chatter', targetBanks: [] },
                ],
                obsoleteFactIds: [],
            }),
        }),
    };
}

/**
 * @param {{gate: any}} arg0
 * @returns {Promise<Array<string>>}
 */
async function distillWith({ gate }) {
    /** @type {string[]} */
    const stored = [];
    const provider = makeProvider({ onStore: (content) => stored.push(content) });
    const manager = new MemoryManager({ provider: /** @type {any} */ (provider), options: { admissionGate: gate } });
    await manager.distill({
        messages: [createUserMessage({ provider: 'openai', content: 'hi' })],
        client: distillClient(),
        modelToUse: 'm',
    });
    assert.equal(manager.lastDistillError, null, 'the distill itself succeeded');
    return stored;
}

test('memory admission: a confident no keeps the fact out of the bank', async () => {
    const gate = createDecisionGate({
        ask: async (/** @type {{state: any}} */ { state }) => ({ answers: { decision: { type: 'noul', probability: state.fact === 'Said hello' ? 0.05 : 0.95, confidence: 0.95 } } }),
    });
    assert.deepEqual(await distillWith({ gate }), ['Likes dark mode']);
});

test('memory admission: an escalation admits, and no gate stores everything', async () => {
    const escalating = createDecisionGate({
        ask: async () => ({ answers: { decision: { type: 'noul', probability: 0.6, confidence: 0.6 } } }),
    });
    assert.deepEqual(await distillWith({ gate: escalating }), ['Likes dark mode', 'Said hello']);
    assert.deepEqual(await distillWith({ gate: null }), ['Likes dark mode', 'Said hello']);
});

// ─── calibration ────────────────────────────────────────────────────────────

test('calibration: a perfectly calibrated sample has zero ECE', () => {
    const samples = [
        ...Array.from({ length: 90 }, () => ({ probability: 0.9, expected: true })),
        ...Array.from({ length: 10 }, () => ({ probability: 0.9, expected: false })),
    ];
    const report = decisionCalibration({ samples, bins: 10 });
    assert.equal(report.count, 100);
    assert.ok(report.ece < 1e-9, `ece ${report.ece}`);
    assert.ok(Math.abs(report.brier - 0.09) < 1e-9);
});

test('calibration: the sweep trades coverage for accuracy', () => {
    const samples = [
        { probability: 0.95, expected: true },
        { probability: 0.9, expected: false },
        { probability: 0.55, expected: false },
        { probability: 0.2, expected: false },
    ];
    const report = decisionCalibration({ samples, thresholds: [0.85, 0.95] });
    const at85 = report.sweep.find((point) => point.threshold === 0.85);
    const at95 = report.sweep.find((point) => point.threshold === 0.95);
    assert.ok(at85);
    assert.ok(at95);
    assert.equal(at85.coverage, 0.5, 'two of four clear 0.85 certainty');
    assert.equal(at85.accuracy, 0.5, 'one of the two confident calls is wrong');
    assert.equal(at95.coverage, 0.25);
    assert.equal(at95.accuracy, 1, 'raising the bar buys accuracy at coverage');
});

test('calibration: a bad sample is refused, not silently skipped', () => {
    assert.throws(() => decisionCalibration({ samples: [] }), ConfigurationError);
    assert.throws(() => decisionCalibration({ samples: [{ probability: 1.2, expected: true }] }), ConfigurationError);
    assert.throws(() => decisionCalibration({ samples: /** @type {any} */ ([{ probability: 0.5, expected: 'yes' }]) }), ConfigurationError);
});

test('calibration: the sweep uses confidence when the wire reports it', () => {
    const samples = [
        { probability: 0.55, expected: true, confidence: 0.95 },
        { probability: 0.55, expected: true, confidence: null },
    ];
    const report = decisionCalibration({ samples, thresholds: [0.9] });
    const point = report.sweep[0];
    assert.equal(point.coverage, 0.5, 'only the confident sample clears 0.9');
    assert.equal(point.accuracy, 1);
});

test('calibration: thresholds are validated and an empty decision set is null, not 0', () => {
    assert.throws(() => decisionCalibration({ samples: [{ probability: 0.5, expected: true }], thresholds: [2] }), ConfigurationError);
    assert.throws(() => decisionCalibration({ samples: [{ probability: 0.5, expected: true }], thresholds: [Number.NaN] }), ConfigurationError);
    const report = decisionCalibration({ samples: [{ probability: 0.5, expected: true }], thresholds: [0.99] });
    assert.equal(report.sweep[0].coverage, 0);
    assert.equal(report.sweep[0].accuracy, null);
});

test('a copied or re-derived gate keeps its owner', () => {
    const sessionA = { _budget: { maxTotalTokens: 1_000 } };
    const sessionB = { _budget: { maxTotalTokens: 1_000 } };
    const derived = attachDecisionUsage({ session: sessionA, gate: createDecisionGate({ ask: usageAsk(), seam: 'copy' }) });

    const copied = { ...derived };
    assert.throws(() => attachDecisionUsage({ session: sessionB, gate: copied }), /belongs to one session/);

    const rederived = derived.withUsage({ onUsage: () => {} });
    assert.throws(() => attachDecisionUsage({ session: sessionB, gate: rederived }), /belongs to one session/);
});

test('a foreign gate is refused before the inbox is claimed', async () => {
    const owner = { _budget: { maxTotalTokens: 1_000 } };
    const foreign = attachDecisionUsage({ session: owner, gate: createDecisionGate({ ask: usageAsk(), seam: 'foreign' }) });
    const inbox = [{ id: 'pending-1' }];
    const session = /** @type {any} */ ({
        provider: 'openai',
        _budget: { maxTotalTokens: 500 },
        _pendingInputRows: inbox,
        run: async () => 'ok',
    });

    await assert.rejects(
        runStep({
            step: { id: 'a', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
            deps: { session, decisionGate: foreign, budget: { maxTotalTokens: 400 }, configureSession: false },
        }),
        /belongs to one session/,
    );
    assert.equal(session._budget.maxTotalTokens, 500, 'the session budget is untouched');
    assert.equal(session._pendingInputRows, inbox, 'the inbox is not claimed');
});

test('memory admission: the bank policy is judged and a skip is observable', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const events = [];
    emitter.on(EVENTS.MEMORY.DISTILL_SUCCESS, (event) => events.push(event));
    /** @type {string[]} */
    const instructions = [];
    const gate = createDecisionGate({
        ask: async (/** @type {{state: any, questions: any}} */ { state, questions }) => {
            instructions.push(questions.decision.instructions);
            return { answers: { decision: { type: 'noul', probability: state.fact === 'Said hello' ? 0.05 : 0.95, confidence: 0.95 } } };
        },
    });
    /** @type {string[]} */
    const stored = [];
    const provider = makeProvider({ onStore: (content) => stored.push(content) });
    const manager = new MemoryManager({ provider: /** @type {any} */ (provider), options: { admissionGate: gate } });

    await manager.distill({
        messages: [createUserMessage({ provider: 'openai', content: 'hi' })],
        client: distillClient(),
        modelToUse: 'm',
        options: { emitter },
    });

    assert.deepEqual(stored, ['Likes dark mode']);
    assert.ok(instructions.every((text) => text.includes('default bank')), 'the bank policy is part of the question');
    assert.equal(events.length, 1);
    assert.equal(events[0].skippedFacts, 1, 'a rejection is observable');
});

test('attachDecisionUsage: an adapter object with null tokens is estimated, not zero', async () => {
    const session = { _budget: { maxTotalTokens: 1_000 } };
    const gate = attachDecisionUsage({ session, gate: createDecisionGate({
        ask: async () => ({ answers: { decision: { type: 'noul', probability: 0.95, confidence: 0.95 } }, usage: { inputTokens: null, outputTokens: null, cost: null } }),
        seam: 'silent',
    }) });

    await gate.gate({ state: 'x'.repeat(400), question: QUESTION });

    assert.equal(/** @type {any} */ (session)._decisionUsage.total_tokens, 100, 'null tokens mean unreported');
    const pool = getBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.total_tokens, 100);
});

test('mergeRunUsage: a known decision cost never completes an unknown LLM cost', () => {
    const unknown = mergeRunUsage({ usage: { total_tokens: 10, cost_usd: null }, decisionTokens: 5, decisionCost: 0.25 });
    assert.ok(unknown);
    assert.equal(unknown.cost_usd, null);
    assert.equal(unknown.decision_cost_usd, 0.25);
    const known = mergeRunUsage({ usage: { total_tokens: 10, cost_usd: 0.5 }, decisionTokens: 5, decisionCost: 0.25 });
    assert.ok(known);
    assert.equal(known.cost_usd, 0.75);
});

test('a re-derived gate for the same session is already charged once', async () => {
    const session = { _budget: { maxTotalTokens: 1_000 } };
    const derived = attachDecisionUsage({ session, gate: createDecisionGate({ ask: usageAsk(), seam: 'same' }) });
    const rederived = derived.withUsage({ onUsage: () => {} });
    const attached = attachDecisionUsage({ session, gate: rederived });
    assert.equal(attached, rederived, 'no second listener is composed');

    await attached.gate({ state: 's', question: QUESTION });
    const pool = getBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.total_tokens, 7, 'one call, one charge');
});

test('withMemory accepts the admission gate at the top level', () => {
    const provider = makeProvider({ onStore: () => {} });
    const gate = createDecisionGate({ ask: usageAsk(), seam: 'admission' });
    const builder = new ChatSessionBuilder();
    builder.withMemory({ provider: /** @type {any} */ (provider), admissionGate: gate });
    assert.equal(/** @type {any} */ (builder)._memoryManager.admissionGate, gate);
});

test('mergeRunUsage: a cost-only decision does not claim a token total', () => {
    const merged = mergeRunUsage({ usage: null, decisionTokens: 0, decisionCost: 0.25 });
    assert.ok(merged);
    assert.equal(merged.total_tokens, undefined, 'no token total is invented');
    assert.equal(merged.decision_tokens, undefined);
    assert.equal(merged.decision_cost_usd, 0.25);
});

test('runStep: a withDecisionGate session gate is used when deps omit it', async () => {
    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.withBudget({ budget: { maxTotalTokens: 1_000 } });
    session.withDecisionGate({ gate: createDecisionGate({ ask: usageAsk(), seam: 'session-default' }) });
    session.run = async (/** @type {{options: any}} */ { options }) => {
        await options.decisionGate.gate({ state: 's', question: QUESTION });
        session._lastRunUsage = { total_tokens: 10, prompt_tokens: 10, completion_tokens: 0 };
        return 'ok';
    };

    const outcome = await runStep({
        step: { id: 'a', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.' },
        deps: { session, configureSession: false },
    });

    assert.equal(/** @type {any} */ (outcome.usage).decision_tokens, 7, 'the session default gate is used and counted');
    const pool = getBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.total_tokens, 7, 'charged once, not twice');
});
