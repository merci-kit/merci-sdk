// @ts-check
/**
 * G3-6: an unknown decision cost is unknown, not free.
 *
 * `decisionTokensFromEvent` returned `cost: 0` when the vendor reported no
 * price, `decisionUsageCost` turned the accumulator's `null` into `0`, and the
 * step usage published the LLM's number as if it covered the decision calls.
 * The pool was already right (`cost_usd: null`), so the two views disagreed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachDecisionUsage, decisionTokensFromEvent, decisionUsageCost, decisionUsageTotal, mergeRunUsage } from '../lib/agentic/decision-usage.mjs';
import { runStep } from '../lib/agentic/step.mjs';

/** @typedef {import('../lib/agentic/decision-gate.mjs').DecisionUsage} DecisionUsage */
/** @typedef {(arg0: {usage: DecisionUsage|null, seam: string, stateChars?: number}) => void} UsageListener */
/** @typedef {{usage: DecisionUsage|null, seam?: string, stateChars?: number}} FireEvent */
/** @typedef {import('../lib/agentic/decision-gate.mjs').DecisionGate & {fire: (arg0: FireEvent) => void}} FireableGate */

/**
 * A gate double whose answered call can be fired from the test. `withUsage` is
 * the seam under test; the other members refuse to run, so the double still
 * satisfies `DecisionGate` without pretending to answer a decision.
 * @returns {{gate: FireableGate, fire: (arg0: FireEvent) => void}}
 */
function fireableGate() {
    /** @type {Array<UsageListener>} */
    const sinks = [];
    /** @type {() => Promise<never>} */
    const unused = () => Promise.reject(new Error('not exercised by this test'));
    /** @type {FireableGate} */
    const gate = {
        available: true,
        ask: unused,
        gate: unused,
        choose: unused,
        score: unused,
        withUsage({ onUsage }) {
            sinks.push(onUsage);
            return gate;
        },
        /** @param {FireEvent} event */
        fire(event) {
            for (const sink of sinks) sink({ usage: event.usage, seam: event.seam ?? 'test', stateChars: event.stateChars });
        },
    };
    return { gate, fire: gate.fire };
}

test('G3-6 an unreported decision cost is null, never zero', () => {
    assert.deepEqual(
        decisionTokensFromEvent({ usage: { inputTokens: 10, outputTokens: 5 } }),
        { tokens: 15, cost: null },
    );
    assert.deepEqual(
        decisionTokensFromEvent({ usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } }),
        { tokens: 2, cost: 0.001 },
    );
});

test('G3-6 unknown decision cost stays null', () => {
    const session = {};
    const { gate, fire } = fireableGate();
    attachDecisionUsage({ session, gate });

    fire({ usage: { inputTokens: 10, outputTokens: 5 } });
    assert.equal(decisionUsageTotal({ session }), 15);
    assert.equal(decisionUsageCost({ session }), null, 'nothing reported a price: the total is unknown, not $0');

    // Sticky: a later priced call cannot make the unknown one free.
    fire({ usage: { inputTokens: 1, outputTokens: 1, cost: 0.5 } });
    assert.equal(decisionUsageCost({ session }), null);
});

test('G3-6 a fully priced decision spend is a number', () => {
    const session = {};
    const { gate, fire } = fireableGate();
    attachDecisionUsage({ session, gate });

    fire({ usage: { inputTokens: 1, outputTokens: 1, cost: 0.25 } });
    assert.equal(decisionUsageCost({ session }), 0.25);
});

test('G3-6 mergeRunUsage keeps the LLM number but marks the cost incomplete', () => {
    const merged = mergeRunUsage({ usage: { total_tokens: 100, cost_usd: 0.5 }, decisionTokens: 15, decisionCost: null });
    assert.ok(merged);
    assert.equal(merged.cost_usd, 0.5, 'existing consumers still read the reported number');
    assert.equal(merged.cost_complete, false, 'the number does not cover the decision calls');
    assert.equal(merged.decision_tokens, 15);

    const complete = mergeRunUsage({ usage: { total_tokens: 100, cost_usd: 0.5 }, decisionTokens: 15, decisionCost: 0.25 });
    assert.ok(complete);
    assert.equal(complete.cost_usd, 0.75);
    assert.equal(complete.cost_complete, undefined, 'a priced decision spend does not need the flag');
});

/**
 * The fixture's own surface: `runStep` only turns the session and reads its
 * last-run usage, so that is what the fixture declares.
 * @typedef {Object} StepSession
 * @property {string} provider
 * @property {string} model
 * @property {Record<string, number>} [_lastRunUsage]
 * @property {(arg0: {options: {decisionGate: FireableGate}}) => Promise<string>} run
 */

test('G3-6 a step with an unpriced decision call reports an incomplete cost', async () => {
    const { gate } = fireableGate();
    /** @type {StepSession} */
    const session = {
        provider: 'openai',
        model: 'm',
        async run({ options }) {
            options.decisionGate.fire({ usage: { inputTokens: 4, outputTokens: 1 } });
            session._lastRunUsage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost_usd: 0.5 };
            return 'ok';
        },
    };

    const outcome = await runStep({ deps: { session, decisionGate: gate, configureSession: false } });
    const usage = /** @type {import('../lib/agentic/step.mjs').RunStepUsage & {cost_complete?: boolean}} */ (outcome.usage);
    assert.equal(usage.total_tokens, 17, '12 LLM + 5 decision');
    assert.equal(usage.decision_tokens, 5);
    assert.equal(usage.cost_usd, 0.5);
    assert.equal(usage.cost_complete, false, 'the decision cost was never reported');
});
