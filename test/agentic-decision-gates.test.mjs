// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { createDecisionGate } from '../lib/agentic/decision-gate.mjs';
import { EVENTS } from '../lib/core/events.mjs';

// ─── Harness ────────────────────────────────────────────────────────────────

const VERIFY_Q = 'Does this node output satisfy the node directive and the run objective?';
const RETRY_Q = 'The same verification failure has repeated; is another retry likely to converge?';

/**
 * A real gate over a scripted decision surface. `answer` sees the question, so
 * one test can script a verdict per seam.
 * @param {{answer: (arg0: {question: any, call: number}) => any}} arg0
 */
function makeGate({ answer }) {
    /** @type {any[]} */
    const asked = [];
    const gate = createDecisionGate({
        /** @param {{state: any, questions: any}} arg0 */
        ask: async ({ state, questions }) => {
            const question = questions.decision;
            asked.push({ state, question });
            return { answers: { decision: answer({ question, call: asked.length }) } };
        },
    });
    return { gate, asked };
}

/** @param {{verdict: any}} arg0 */
function makeJudgeClient({ verdict }) {
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
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput }) {
                    calls.push(initialInput);
                    return JSON.stringify(verdict);
                },
            };
        },
    };
}

// ─── StateMachine: the gate stands in for an absent verify ──────────────────

test('decision gate: a confident pass verifies a node that has no verify', async () => {
    let calls = 0;
    const { gate, asked } = makeGate({ answer: () => ({ type: 'noul', probability: 0.97, confidence: 0.97 }) });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', systemPrompt: 'Produce a value.', execute: () => { calls++; return 'value'; }, terminal: true }],
        edges: []
    }, options: { decisionGate: gate } });
    /** @type {any[]} */
    const passes = [];
    sm.on(EVENTS.STATE_MACHINE.VERIFY_PASS, (e) => passes.push(e));

    await sm.run();

    assert.equal(sm.phase, 'done');
    assert.equal(calls, 1, 'a confident pass never re-runs the node');
    assert.equal((/** @type {any} */ (sm.history[0])).verified, true);
    assert.equal(passes.length, 1);
    assert.equal(passes[0].evidence, 'decision_gate_pass');
    assert.equal(asked.length, 1, 'one question for the one verify-less node');
    assert.equal(asked[0].state.nodeId, 'gen');
    assert.equal(asked[0].question.instructions, VERIFY_Q);
});

test('decision gate: a confident fail retries to the attempt cap, then rejects', async () => {
    let calls = 0;
    const { gate } = makeGate({ answer: ({ question }) => question.instructions === VERIFY_Q
        ? { type: 'noul', probability: 0.05, confidence: 0.95 }
        : { type: 'noul', probability: 0.95, confidence: 0.95 } });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', systemPrompt: 'Produce a value.', execute: () => { calls++; return 'bad'; }, terminal: true }],
        edges: []
    }, options: { decisionGate: gate } });

    await assert.rejects(() => sm.run(), /failed verification/);

    assert.equal(calls, 3, 'default maxRetries 2 → 3 attempts');
    assert.equal(sm.phase, 'escalated');
});

test('decision gate: an escalated verdict keeps verified-by-default', async () => {
    const { gate } = makeGate({ answer: () => ({ type: 'noul', probability: 0.6, confidence: 0.6 }) });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', systemPrompt: 'Produce a value.', execute: () => 'value', terminal: true }],
        edges: []
    }, options: { decisionGate: gate } });
    /** @type {any[]} */
    const failures = [];
    sm.on(EVENTS.STATE_MACHINE.VERIFY_FAIL, (e) => failures.push(e));

    await sm.run();

    assert.equal(sm.phase, 'done');
    assert.equal((/** @type {any} */ (sm.history[0])).verified, true);
    assert.equal(failures.length, 0);
});

test('decision gate: a bookkeeping execute node has no directive and is never judged', async () => {
    let asked = 0;
    const gate = createDecisionGate({ ask: async () => { asked++; throw new Error('the gate must not be consulted'); } });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', execute: () => 'value', terminal: true }],
        edges: []
    }, options: { decisionGate: gate } });

    await sm.run();

    assert.equal(sm.phase, 'done');
    assert.equal(asked, 0, 'no systemPrompt → no directive to judge');
    assert.equal((/** @type {any} */ (sm.history[0])).verified, true);
});

test('decision gate: an explicit node verify wins and the gate is never consulted', async () => {
    let asked = 0;
    const gate = createDecisionGate({ ask: async () => { asked++; throw new Error('the gate must not be consulted'); } });
    let verifyCalls = 0;
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            execute: () => 'ok',
            verify: (/** @type {any} */ out) => { verifyCalls++; return { passed: out === 'ok', evidence: 'checked' }; },
            terminal: true
        }],
        edges: []
    }, options: { decisionGate: gate } });

    await sm.run();

    assert.equal(sm.phase, 'done');
    assert.equal(verifyCalls, 1);
    assert.equal(asked, 0, 'node.verify present → no decision-gate call at all');
    assert.equal((/** @type {any} */ (sm.history[0])).verified, true);
});

test('decision gate: a repeated fingerprint the gate calls hopeless stops after 2 attempts', async () => {
    let calls = 0;
    const { gate, asked } = makeGate({ answer: () => ({ type: 'noul', probability: 0.03, confidence: 0.97 }) });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            execute: () => { calls++; return 'bad'; },
            verify: () => ({ passed: false, evidence: 'same failure', fingerprint: 'fp-1' }),
            terminal: true
        }],
        edges: []
    }, options: { decisionGate: gate } });

    await assert.rejects(() => sm.run(), /retry unlikely to converge/);

    assert.equal(calls, 2, 'the third attempt is never spent');
    assert.equal(sm.phase, 'escalated');
    assert.equal(asked.length, 1, 'one convergence question, not one per attempt');
    assert.equal(asked[0].question.instructions, RETRY_Q);
    assert.equal(asked[0].state.fingerprint, 'fp-1');
});

// ─── DiscussionSession: judge consensus shortcut ────────────────────────────

test('decision gate: a confident judge consensus returns a verdict without a judge turn', async () => {
    const { gate, asked } = makeGate({ answer: ({ question }) => question.type === 'choice'
        ? { type: 'choice', choice: 'e0', confidence: 0.97, probabilities: { e0: 0.97 } }
        : { type: 'noul', probability: 0.97, confidence: 0.97 } });
    const group = new DiscussionSession({ client: {}, options: { decisionGate: gate } });
    group.addAgent({ name: 'a', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: [
        { author: 'a', content: 'Use the cached path.', type: 'discussion', thoughtSignature: null },
        { author: 'b', content: 'Agreed: cached path.', type: 'discussion', thoughtSignature: null }
    ] });
    let judgeTurns = 0;

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: {
        asVerdict: true,
        execute: async () => { judgeTurns++; throw new Error('the judge turn must not run'); },
    } });

    assert.equal(judgeTurns, 0, 'no judge turn ran');
    assert.equal(verdict.passed, true);
    assert.equal(verdict.reason, 'decision_gate_consensus');
    assert.equal(verdict.score, 97);
    assert.equal(verdict.content, 'Use the cached path.');
    assert.equal(asked.length, 2, 'agreement, then the strongest entry');
});

test('decision gate: the consensus verdict returns the full contribution, not the DM excerpt', async () => {
    const head = 'H'.repeat(600);
    const tail = 'T'.repeat(200);
    const long = `${head}${'M'.repeat(400)}${tail}`;
    const { gate, asked } = makeGate({ answer: ({ question }) => question.type === 'choice'
        ? { type: 'choice', choice: 'e0', confidence: 0.97, probabilities: { e0: 0.97 } }
        : { type: 'noul', probability: 0.97, confidence: 0.97 } });
    const group = new DiscussionSession({ client: {}, options: { decisionGate: gate } });
    group.addAgent({ name: 'a', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: [{ author: 'a', content: long, type: 'discussion', thoughtSignature: null }] });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true } });

    assert.equal(verdict.reason, 'decision_gate_consensus');
    assert.equal(verdict.content.length, 1200, 'the ledger entry, not the excerpt');
    const sent = String(asked[0].state.entries[0].content);
    assert.equal(sent.length, 803, 'head 600 + " … " + tail 200');
    assert.ok(sent.startsWith(head), 'the DM sees the opening of a long entry');
    assert.ok(sent.endsWith(tail), 'and its closing objection, not only the opening');
});

test('decision gate: an escalated judge gate falls through to the judge turn', async () => {
    const { gate } = makeGate({ answer: () => ({ type: 'noul', probability: 0.6, confidence: 0.6 }) });
    const client = makeJudgeClient({ verdict: { passed: true, score: 72, reason: 'solid', revision: 'minor' } });
    const group = new DiscussionSession({ client, options: { decisionGate: gate } });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: [{ author: 'A', content: 'a real contribution', type: 'discussion', thoughtSignature: null }] });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true } });

    assert.equal(client.calls.length, 1, 'the judge turn ran');
    assert.equal(verdict.passed, true);
    assert.equal(verdict.score, 72);
    assert.equal(verdict.reason, 'solid');
});

// ─── DiscussionSession: task assignment ────────────────────────────────────

test('decision gate: runTasks assigns a task that names no assignee', async () => {
    const { gate } = makeGate({ answer: () => ({ type: 'choice', choice: 'b', confidence: 0.97, probabilities: { b: 0.97 } }) });
    /** @type {string[]} */
    const ran = [];
    const group = new DiscussionSession({ client: {}, options: { decisionGate: gate } });
    group.addAgent({ name: 'a', persona: 'writes prose', execute: async () => { ran.push('a'); return 'from a'; } });
    group.addAgent({ name: 'b', persona: 'writes code', execute: async () => { ran.push('b'); return 'from b'; } });

    await group.runTasks({ tasks: [{ title: 't', description: 'do it' }] });

    assert.deepEqual(ran, ['b'], 'the gate-chosen agent ran');
    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].author, 'b');
    assert.equal(ledger[0].content, 'from b');
});

test('decision gate: without a gate an unassigned task keeps the existing error', async () => {
    const group = new DiscussionSession({ client: {} });
    group.addAgent({ name: 'a', execute: async () => 'from a' });
    group.addAgent({ name: 'b', execute: async () => 'from b' });

    await group.runTasks({ tasks: [{ title: 't', description: 'do it' }] });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].author, 't');
    assert.match(ledger[0].content, /^\[error: Task "t" has no assignee or subagent_type\.\]$/);
});

test('decision gate: an existing assignee is never overridden', async () => {
    let asked = 0;
    const gate = createDecisionGate({ ask: async () => { asked++; throw new Error('the gate must not be asked'); } });
    /** @type {string[]} */
    const ran = [];
    const group = new DiscussionSession({ client: {}, options: { decisionGate: gate } });
    group.addAgent({ name: 'a', execute: async () => { ran.push('a'); return 'from a'; } });
    group.addAgent({ name: 'b', execute: async () => { ran.push('b'); return 'from b'; } });

    await group.runTasks({ tasks: [{ title: 't', description: 'do it', assignee: 'a' }] });

    assert.deepEqual(ran, ['a']);
    assert.equal(asked, 0, 'a named assignee needs no decision');
});

test('decision gate: more than eight substantive entries keeps the LLM judge', async () => {
    const { gate } = makeGate({ answer: ({ question }) => question.type === 'choice'
        ? { type: 'choice', choice: 'e0', confidence: 0.97, probabilities: { e0: 0.97 } }
        : { type: 'noul', probability: 0.97, confidence: 0.97 } });
    const client = makeJudgeClient({ verdict: { passed: true, score: 50, reason: 'llm judged', revision: 'minor' } });
    const group = new DiscussionSession({ client, options: { decisionGate: gate } });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: Array.from({ length: 9 }, (_, i) => ({ author: 'A', content: `entry ${i}`, type: 'discussion', thoughtSignature: null })) });

    /** @type {any} */
    const verdict = await group.judge({ instruction: 'grade', options: { asVerdict: true } });

    assert.equal(client.calls.length, 1, 'a dissent could sit outside the window, so the LLM judge runs');
    assert.equal(verdict.reason, 'llm judged');
});
