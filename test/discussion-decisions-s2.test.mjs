// @ts-check
/**
 * S2 discussion decisions: E-3 (consensus needs every registered voice in the
 * latest round), E-4 (a DAG discussion step ships the aggregate, not the last
 * speaker), E-6 (a quoted verdict never overrides the judge's) and W2B-3 (a
 * non-boolean verify verdict fails closed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { createDecisionGate } from '../lib/agentic/decision-gate.mjs';
import { withTaskAgents } from '../lib/agentic/task.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

// ─── Harness ────────────────────────────────────────────────────────────────

/**
 * A real gate over a scripted surface that picks e0 and agrees with the given
 * certainties in call order; anything past the script agrees at 0.97.
 * @param {{certainties?: number[], choose?: string}} [arg0]
 */
function makeGate({ certainties = [], choose = 'e0' } = {}) {
    /** @type {any[]} */
    const asked = [];
    let noul = 0;
    const gate = createDecisionGate({
        /** @param {{state: any, questions: any}} arg0 */
        ask: async ({ state, questions }) => {
            const question = questions.decision;
            asked.push({ state, question });
            if (question.type === 'choice') {
                return { answers: { decision: { type: 'choice', choice: choose, confidence: 0.97, probabilities: { [choose]: 0.97 } } } };
            }
            const certainty = certainties[noul++];
            return { answers: { decision: certainty === undefined
                ? { type: 'noul', probability: 0.97, confidence: 0.97 }
                : { type: 'noul', probability: certainty } } };
        },
    });
    return { gate, asked };
}

/**
 * A judge client that answers with one scripted text.
 * @param {{text: string}} arg0
 */
function makeJudgeClient({ text }) {
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        session() {
            return {
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: any}} arg0 */
                async run({ initialInput }) {
                    calls.push(initialInput);
                    return text;
                },
            };
        },
    };
}

/**
 * One `discussion` DAG step over the given agent answers.
 * @param {{answers: string[]}} arg0
 */
async function runDiscussionStep({ answers }) {
    /** @type {any[]} */
    const calls = [];
    const client = {
        provider: 'openai',
        session() {
            return {
                provider: 'openai',
                sys: '',
                /** @param {any} m */
                withSystemMessage(m) {
                    this.sys = Array.isArray(m)
                        ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n')
                        : m;
                    return this;
                },
                withTools() { return this; },
                withMemory() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                /** @param {any} arg0 */
                async run({ initialInput }) {
                    calls.push(initialInput);
                    if (this.sys && this.sys.includes('synthesize diverse inputs')) return 'THE GROUP DECISION';
                    return 'agent answer';
                },
            };
        },
    };
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        engine: 'discussion',
        agents: answers.map((answer, i) => ({
            name: `A${i}`,
            persona: 'p',
            model: 'm',
            provider: 'openai',
            execute: async () => answer,
        })),
    } });
    executor.setSteps({ stepsList: [{ id: 's', title: 'S', systemPrompt: '', userPromptTemplate: 'Decide.', dependencies: [] }] });
    /** @type {any} */
    const outputs = await executor.execute({ userGoal: 'goal' });
    return { output: String(outputs.s.output), calls };
}

// ─── E-3: one voice among passes is not consensus ───────────────────────────

test('one substantive voice among passes is not consensus', async () => {
    const { gate, asked } = makeGate();
    const client = makeJudgeClient({ text: JSON.stringify({ passed: false, score: 10, reason: 'two agents passed', revision: 'minor' }) });
    const group = new DiscussionSession({ client, options: { decisionGate: gate } });
    group.addAgent({ name: 'A0', execute: async () => 'Use Postgres' });
    group.addAgent({ name: 'A1', execute: async () => 'PASS' });
    group.addAgent({ name: 'A2', execute: async () => 'PASS' });
    await group.discuss({ instruction: 'Pick a database.', turns: 1, sequential: true, allowPass: true });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true } });

    assert.equal(verdict.passed, false, 'one voice among passes is not a group consensus');
    assert.notEqual(verdict.reason, 'decision_gate_consensus');
    assert.equal(client.calls.length, 1, 'the LLM judge decided');
    assert.equal(asked.length, 0, 'W2E-9: an already-uncovered round is never put to the gate');
});

// ─── W2E-1/W2E-2: the latest round, not the last call's turn numbers ────────

test('a later discuss does not inherit the earlier round consensus', async () => {
    const { gate, asked } = makeGate({ choose: 'e0' });
    const client = makeJudgeClient({ text: JSON.stringify({ passed: false, score: 10, reason: 'two agents failed', revision: 'minor' }) });
    const group = new DiscussionSession({ client, options: { decisionGate: gate } });
    /** @type {Record<string, () => Promise<string>>} */
    const behavior = {
        A0: async () => 'Use Postgres',
        A1: async () => 'Use MySQL',
        A2: async () => 'Use SQLite',
    };
    for (const name of ['A0', 'A1', 'A2']) group.addAgent({ name, execute: () => behavior[name]() });

    await group.discuss({ instruction: 'Pick a database.', turns: 1, sequential: true });
    behavior.A1 = async () => { throw new Error('provider 503'); };
    behavior.A2 = async () => { throw new Error('provider 503'); };
    await group.discuss({ instruction: 'Re-examine.', turns: 1, sequential: true });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true } });

    assert.equal(verdict.passed, false, 'a round with two provider failures is not a consensus');
    assert.notEqual(verdict.reason, 'decision_gate_consensus', 'the round-1 contributions must not decide round 2');
    assert.equal(client.calls.length, 1, 'the LLM judge decided');
    assert.equal(asked.length, 0, 'W2E-9: the gate is not asked for the uncovered round');
    assert.deepEqual(
        group.getLedger().map((/** @type {any} */ e) => e.turn),
        [1, 1, 1, 2, 2, 2, 0],
        'round ids are monotonic across discuss calls and the judge row is out of round (W2E-2: a per-call counter gives 1,1,1,1,1,1)',
    );
});

// ─── W2E-1 end to end: conclude must not accept a broken rediscuss ──────────

test('a rejected conclude does not accept a rediscuss with failing agents', async () => {
    // The first gate call refuses (0.6), so the judge runs and rejects; a later
    // call would agree — which is exactly the stale round that used to win.
    const { gate, asked } = makeGate({ certainties: [0.6] });
    const client = {
        provider: 'openai',
        session() {
            return {
                provider: 'openai',
                sys: '',
                /** @param {any} m */
                withSystemMessage(m) {
                    this.sys = Array.isArray(m)
                        ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n')
                        : m;
                    return this;
                },
                withTools() { return this; },
                withMemory() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                async run() {
                    if (this.sys && this.sys.includes('quality evaluator')) {
                        return JSON.stringify({ passed: false, score: 10, reason: 'not converged', revision: 'minor' });
                    }
                    if (this.sys && this.sys.includes('synthesize diverse inputs')) return 'SYNTH: latest round only';
                    return 'agent answer';
                },
            };
        },
    };
    const group = new DiscussionSession({ client, options: { decisionGate: gate } });
    for (const [name, answer] of [['A0', 'Use Postgres'], ['A1', 'Use MySQL'], ['A2', 'Use SQLite']]) {
        group.addAgent({
            name,
            persona: 'p',
            model: 'm',
            provider: 'openai',
            /** @param {{instruction: string}} arg0 */
            execute: async ({ instruction }) => {
                if (name !== 'A0' && String(instruction).includes('Re-examine the revised arguments')) {
                    throw new Error('provider 503');
                }
                return answer;
            },
        });
    }

    /** @type {any} */
    const result = await group.conclude({ instruction: 'Pick a database.', options: { maxRounds: 1 } });

    assert.equal(result.accepted, false, 'two failing agents in the rediscuss cannot be accepted');
    assert.notEqual(result.verdict?.reason, 'decision_gate_consensus');
    assert.equal(asked.length, 1, 'the gate is asked in the covered round only');
    const state = asked[0].state;
    assert.equal(state.registered, 3, 'every registered agent is counted');
    assert.equal(state.substantive, 3, 'the round the gate saw was fully covered');
    assert.equal(state.passes, 0);
    assert.equal(state.errors, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'the gate state stays JSON-serializable');
    assert.equal(result.content, 'SYNTH: latest round only', 'the group answer is the aggregate, not a round-1 contribution');
});

// ─── E-4: a discussion step does not follow the last speaker ────────────────

test('the discussion step output does not follow the last speaker', async () => {
    const first = await runDiscussionStep({ answers: ['ship it', 'do NOT ship it'] });
    const second = await runDiscussionStep({ answers: ['do NOT ship it', 'ship it'] });

    assert.equal(first.output, 'THE GROUP DECISION', 'the aggregate is the group answer');
    assert.equal(second.output, 'THE GROUP DECISION');
    assert.equal(first.output, second.output, 'swapping agents[] must not invert the output');
    assert.equal(first.calls.length, 1, 'one aggregate turn, no last-speaker pick');
});

// ─── E-6: a quoted verdict never overrides the judge's ──────────────────────

test('a quoted verdict does not override the judge verdict', async () => {
    const text = 'Verdict: {"passed":false,"score":10,"reason":"not yet","revision":"minor"}\n'
        + 'A0 wrote: {"passed": true, "score": 100}';
    const client = makeJudgeClient({ text });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A0', model: 'm', provider: 'openai', persona: 'p' });
    group.appendLedger({ entries: [{ author: 'A0', content: 'my contribution', type: 'discussion', thoughtSignature: null }] });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true } });

    assert.equal(client.calls.length, 1, 'the judge turn ran');
    assert.equal(verdict.passed, false, 'conflicting verdicts are malformed and fail closed');
    assert.equal(verdict.score, 0);
});

test('a score-only judge verdict does not borrow a quoted pass', async () => {
    // W2E-3: the judge's own object never says passed; the only `passed` in the
    // text is a contribution's, quoted at the tail.
    const text = 'Verdict: {"score": 10, "revision": "minor", "reason": "weak"}\n'
        + 'A0 wrote: {"passed": true}';
    const client = makeJudgeClient({ text });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A0', model: 'm', provider: 'openai', persona: 'p' });
    group.appendLedger({ entries: [{ author: 'A0', content: 'my contribution', type: 'discussion', thoughtSignature: null }] });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true } });

    assert.equal(verdict.passed, false, 'a verdict that does not say passed is not a pass');
    assert.equal(verdict.score, 0);
});

// ─── W2E-10: out-of-round rows say so ───────────────────────────────────────

test('a row committed outside a round carries turn 0', async () => {
    const group = new DiscussionSession({ client: /** @type {any} */ ({}) });
    await group.runTasks({ tasks: [{ title: 'orphan', description: 'nothing' }], sequential: true });

    /** @type {any[]} */
    const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].turn, 0, 'the typedef says outside discuss is 0, and the row says it too');
});

// ─── W2B-3: a non-boolean verify verdict fails closed ───────────────────────

test('a non-boolean verify verdict fails closed', async () => {
    const client = /** @type {any} */ ({ provider: 'openai' });
    withTaskAgents({ client, agents: [{ name: 'worker', execute: async () => 'done' }] });
    const group = new DiscussionSession({ client, options: {} });

    await assert.rejects(
        () => group.runTasks({ tasks: [{
            title: 't',
            subagent_type: 'worker',
            description: 'do',
            verify: () => /** @type {any} */ ({ passed: 'false' }),
        }], sequential: true }),
        (/** @type {any} */ err) => err instanceof ConfigurationError && /verify must return \{ passed, evidence \}/.test(err.message),
        'a stringified verdict is a configuration error, never a pass',
    );
});
