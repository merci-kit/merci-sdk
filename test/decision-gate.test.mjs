// @ts-check
/**
 * @file The shared decision gate — certainty, verdicts, escalation, events.
 * @version 0.24.0
 *
 * @description
 * The gate turns one bound decision surface into a verdict the agentic loop
 * may trust. This test pins the calibration primitive (`certaintyOf`), the
 * escalation rule (below the threshold, wrong answer type, no surface, or a
 * backend error), the closed-world trap guard on `choose`, the state cap, and
 * the one event per gate call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { certaintyOf, createDecisionGate } from '../lib/agentic/decision-gate.mjs';
import { choiceQuestion, noulQuestion, scoreQuestion } from '../lib/messaging/decision.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';


/**
 * A decision surface answering one canned answer under the gate's question key.
 * @param {Record<string, any>} answer
 * @returns {(arg0: {state: unknown, questions: Record<string, any>, signal?: AbortSignal|null}) => Promise<any>}
 */
function surfaceFor(answer) {
    return async () => ({ model: 'm', answers: { decision: answer }, usage: { inputTokens: 1, outputTokens: 1, cost: null } });
}

const NOUL = noulQuestion({ instructions: 'Is it a refund?', criteria: { true: 'Yes.', false: 'No.' } });


test('certainty: confidence wins, else the noul margin from 0.5', () => {
    assert.equal(certaintyOf({ answer: { type: 'noul', probability: 0.9, confidence: 0.7 } }), 0.7);
    assert.equal(certaintyOf({ answer: { type: 'noul', probability: 0.55, confidence: null } }), 0.55);
    assert.equal(certaintyOf({ answer: { type: 'noul', probability: 0.2, confidence: null } }), 0.8);
    assert.equal(certaintyOf({ answer: { type: 'noul', probability: null, confidence: null } }), null);
});


test('certainty: choice uses the top probability, score uses confidence', () => {
    assert.equal(certaintyOf({ answer: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 }, confidence: null } }), 0.6);
    assert.equal(certaintyOf({ answer: { type: 'choice', choice: 'a', probabilities: { a: 0.6 }, confidence: 0.95 } }), 0.95);
    assert.equal(certaintyOf({ answer: { type: 'score', score: 2, confidence: 0.75 } }), 0.75);
    assert.equal(certaintyOf({ answer: { type: 'score', score: 2, confidence: null } }), null);
    assert.equal(certaintyOf({ answer: { type: 'refusal' } }), null);
});


test('certainty: confidence without a usable probability cannot stand', async () => {
    const noProbability = createDecisionGate({ ask: surfaceFor({ type: 'noul', confidence: 0.99 }) });
    const missing = await noProbability.gate({ state: 's', question: NOUL });
    assert.equal(missing.verdict, null);
    assert.equal(missing.certainty, 0.99);
    assert.equal(missing.escalated, true, 'a trusted certainty with no verdict must escalate');

    const nanConfidence = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: 0.9, confidence: NaN }) });
    const nan = await nanConfidence.gate({ state: 's', question: NOUL });
    assert.equal(nan.verdict, true);
    assert.equal(nan.certainty, 0.9, 'a non-finite confidence falls back to the margin');
    assert.equal(nan.escalated, false);

    const stringProbability = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: '0.9', confidence: 0.99 }) });
    const asString = await stringProbability.gate({ state: 's', question: NOUL });
    assert.equal(asString.verdict, null);
    assert.equal(asString.escalated, true);
});


test('certainty: a probability outside 0..1 is never a certain answer', async () => {
    const percent = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: 1.7, confidence: null }) });
    const high = await percent.gate({ state: 's', question: NOUL });
    assert.equal(high.verdict, null);
    assert.equal(high.certainty, null);
    assert.equal(high.escalated, true);

    const negative = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: -0.3, confidence: null }) });
    const low = await negative.gate({ state: 's', question: NOUL });
    assert.equal(low.verdict, null);
    assert.equal(low.certainty, null);
    assert.equal(low.escalated, true);
});


test('gate: a certain answer stands, a marginal one escalates', async () => {
    const certain = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: 0.9, confidence: null }) });
    const stand = await certain.gate({ state: 's', question: NOUL });
    assert.equal(stand.verdict, true);
    assert.equal(stand.escalated, false);
    assert.equal(stand.certainty, 0.9);

    const marginal = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: 0.55, confidence: null }) });
    const soft = await marginal.gate({ state: 's', question: NOUL });
    assert.equal(soft.verdict, true);
    assert.equal(soft.escalated, true);

    const negative = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: 0.2, confidence: null }) });
    const no = await negative.gate({ state: 's', question: NOUL });
    assert.equal(no.verdict, false);
    assert.equal(no.escalated, true);
});


test('gate: an answer of the wrong type escalates', async () => {
    const gate = createDecisionGate({ ask: surfaceFor({ type: 'choice', choice: 'a', probabilities: { a: 0.99 }, confidence: 0.99 }) });
    const result = await gate.gate({ state: 's', question: NOUL });
    assert.equal(result.verdict, null);
    assert.equal(result.escalated, true);
});


test('gate: no surface means unavailable, null ask, and an escalated verdict', async () => {
    const gate = createDecisionGate();
    assert.equal(gate.available, false);
    assert.equal(await gate.ask({ state: 's', questions: {} }), null);
    const result = await gate.gate({ state: 's', question: NOUL });
    assert.equal(result.escalated, true);
    assert.equal(result.verdict, null);
    assert.equal(result.reason, null);
});


test('gate: a backend error escalates with reason error, an abort rethrows', async () => {
    const failing = createDecisionGate({ ask: async () => { throw new Error('backend down'); } });
    const result = await failing.gate({ state: 's', question: NOUL });
    assert.equal(result.escalated, true);
    assert.equal(result.reason, 'error');
    assert.equal(result.answer, null);

    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    const aborted = createDecisionGate({ ask: async () => { throw abort; } });
    await assert.rejects(aborted.gate({ state: 's', question: NOUL }), /cancelled/);
});


test('signal: every primitive forwards the caller cancellation', async () => {
    /** @type {Array<AbortSignal|null>} */
    const seen = [];
    const gate = createDecisionGate({
        ask: async ({ signal }) => {
            seen.push(signal ?? null);
            return { model: 'm', answers: { decision: { type: 'noul', probability: 0.9, confidence: null } }, usage: {} };
        },
    });
    const controller = new AbortController();
    await gate.gate({ state: 's', question: NOUL, signal: controller.signal });
    await gate.choose({ state: 's', question: choiceQuestion({ instructions: 'Which?', criteria: { a: 'A.', other: 'Else.' } }), signal: controller.signal });
    await gate.score({ state: 's', question: scoreQuestion({ instructions: 'How urgent?', criteria: ['Low', 'High'] }), signal: controller.signal });
    assert.equal(seen.length, 3);
    assert.equal(seen.every((signal) => signal === controller.signal), true);
});


test('state: a string and an object are both capped before the call', async () => {
    /** @type {Array<unknown>} */
    const seen = [];
    const gate = createDecisionGate({
        maxStateChars: 100,
        ask: async ({ state }) => {
            seen.push(state);
            return { model: 'm', answers: { decision: { type: 'noul', probability: 0.9, confidence: null } }, usage: {} };
        },
    });
    await gate.gate({ state: 'x'.repeat(20_000), question: NOUL });
    assert.equal(typeof seen[0], 'string');
    assert.equal(/** @type {string} */ (seen[0]).length, 100);

    await gate.gate({ state: { text: 'y'.repeat(500) }, question: NOUL });
    assert.equal(typeof seen[1], 'string');
    assert.equal(/** @type {string} */ (seen[1]).length, 100);
});


test('choose: an undeclared answer escalates instead of becoming a trusted pick', async () => {
    const question = choiceQuestion({ instructions: 'Which team?', criteria: { billing: 'Charges.', other: 'Anything else.' } });
    const gate = createDecisionGate({ ask: surfaceFor({ type: 'choice', choice: 'ghost', probabilities: { ghost: 0.9 }, confidence: 0.9 }) });
    const result = await gate.choose({ state: 's', question });
    assert.equal(result.choice, 'ghost');
    assert.equal(result.escalated, true);
    assert.equal(result.reason, 'undeclared');
});


test('state: a non-serializable state never makes ask() throw', async () => {
    /** @type {Array<unknown>} */
    const seen = [];
    const gate = createDecisionGate({
        maxStateChars: 10,
        ask: async ({ state }) => {
            seen.push(state);
            return { model: 'm', answers: { decision: { type: 'noul', probability: 0.9, confidence: null } }, usage: {} };
        },
    });
    const undefinedJson = { toJSON() { return undefined; } };
    await gate.ask({ state: undefinedJson, questions: {} });
    await gate.ask({ state: 10n, questions: {} });
    assert.equal(seen.length, 2);
    assert.equal(seen[0], undefinedJson);
    assert.equal(seen[1], 10n);
});


test('choose: the escape option must be declared, and choosing it is an escape', async () => {
    const question = choiceQuestion({ instructions: 'Which team?', criteria: { billing: 'Charges.', other: 'Anything else.' } });
    const gate = createDecisionGate({ ask: surfaceFor({ type: 'choice', choice: 'other', probabilities: { billing: 0.2, other: 0.8 }, confidence: 0.9 }) });
    const result = await gate.choose({ state: 's', question });
    assert.equal(result.choice, 'other');
    assert.equal(result.escaped, true);
    assert.equal(result.escalated, false);

    await assert.rejects(
        gate.choose({ state: 's', question: choiceQuestion({ instructions: 'Which team?', criteria: { billing: 'Charges.' } }) }),
        ConfigurationError,
    );
});


test('score: the number and its certainty come back', async () => {
    const gate = createDecisionGate({ ask: surfaceFor({ type: 'score', score: 2, confidence: 0.9 }) });
    const result = await gate.score({ state: 's', question: scoreQuestion({ instructions: 'Urgency?', criteria: ['Low', 'Medium', 'High'] }) });
    assert.equal(result.score, 2);
    assert.equal(result.certainty, 0.9);
    assert.equal(result.escalated, false);
});


test('certainty: a score without confidence uses its probability spread', () => {
    assert.equal(certaintyOf({ answer: { type: 'score', score: 2, confidence: null, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 } } }), 0.85);
    assert.equal(certaintyOf({ answer: { type: 'score', score: 2, confidence: null, probabilities: {} } }), null);
});


test('choose and score: a backend error escalates with reason error', async () => {
    const gate = createDecisionGate({ ask: async () => { throw new Error('backend down'); } });
    const chose = await gate.choose({ state: 's', question: choiceQuestion({ instructions: 'Which?', criteria: { a: 'A.', other: 'Else.' } }) });
    assert.equal(chose.escalated, true);
    assert.equal(chose.reason, 'error');
    assert.equal(chose.choice, null);

    const scored = await gate.score({ state: 's', question: scoreQuestion({ instructions: 'How urgent?', criteria: ['Low', 'High'] }) });
    assert.equal(scored.escalated, true);
    assert.equal(scored.reason, 'error');
    assert.equal(scored.score, null);
});


test('state: a circular object is passed through, not thrown on', async () => {
    /** @type {any} */
    const circular = { name: 'loop' };
    circular.self = circular;
    /** @type {Array<unknown>} */
    const seen = [];
    const gate = createDecisionGate({
        maxStateChars: 10,
        ask: async ({ state }) => {
            seen.push(state);
            return { model: 'm', answers: { decision: { type: 'noul', probability: 0.9, confidence: null } }, usage: {} };
        },
    });
    const result = await gate.gate({ state: circular, question: NOUL });
    assert.equal(result.escalated, false);
    assert.equal(seen[0], circular);
});


test('events: choose and score each emit their own primitive', async () => {
    const emitter = new EventEmitter();
    /** @type {Array<Record<string, any>>} */
    const received = [];
    emitter.on(EVENTS.CLIENT.DECISION_GATE, (event) => received.push(event));
    const gate = createDecisionGate({
        emitter,
        seam: 'triage',
        ask: async ({ questions }) => {
            const primitive = Object.keys(questions)[0];
            const answer = primitive === 'decision' && questions.decision.type === 'choice'
                ? { type: 'choice', choice: 'a', probabilities: { a: 0.9, other: 0.1 }, confidence: 0.9 }
                : { type: 'score', score: 1, confidence: 0.8 };
            return { model: 'm', answers: { decision: answer }, usage: {} };
        },
    });
    await gate.choose({ state: 's', question: choiceQuestion({ instructions: 'Which?', criteria: { a: 'A.', other: 'Else.' } }) });
    await gate.score({ state: 's', question: scoreQuestion({ instructions: 'How urgent?', criteria: ['Low', 'High'] }) });
    assert.equal(received.length, 2);
    assert.equal(received[0].primitive, 'choice');
    assert.equal(received[0].choice, 'a');
    assert.equal(received[1].primitive, 'score');
    assert.equal(received[1].score, 1);
    assert.equal(received[1].seam, 'triage');
});


test('events: one DECISION_GATE event per gate call', async () => {
    const emitter = new EventEmitter();
    /** @type {Array<Record<string, any>>} */
    const received = [];
    emitter.on(EVENTS.CLIENT.DECISION_GATE, (event) => received.push(event));
    const gate = createDecisionGate({ ask: surfaceFor({ type: 'noul', probability: 0.9, confidence: null }), emitter, seam: 'triage' });
    await gate.gate({ state: 's', question: NOUL });
    assert.equal(received.length, 1);
    assert.equal(received[0].event, EVENTS.CLIENT.DECISION_GATE);
    assert.equal(received[0].seam, 'triage');
    assert.equal(received[0].primitive, 'noul');
    assert.equal(received[0].verdict, true);
    assert.equal(received[0].escalated, false);
});
