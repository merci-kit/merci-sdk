// @ts-check

/**
 * Wave 3 — the step + glue contract (A1, A3, A4, A5, A6, A7).
 *
 * Six checks were observed failing against the pre-fix tree (A1, A3, A4, A5's
 * invalid-handoff rejection, A5's ignored tool list, A6 — the last is the widened
 * `test/step.test.mjs` check the plan names, not a duplicate here). Two more
 * (`W3/A3-empty`, `W3/A3-resume`) were added as verifier findings were closed and
 * fail against the repair they pin. The rest are pins: they pass before and after
 * and exist so a repair cannot quietly delete the documented behaviour. A7 is a
 * documentation decision with no behaviour to assert — its evidence is the docblock
 * in `lib/agentic/step.mjs` and the comment in the REPL loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runStep } from '../lib/agentic/step.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';

/**
 * Fake client whose session records the builder setters and every run input.
 * @param {{answer?: (n: number) => string}} [arg0]
 * @returns {any}
 */
function makeClient({ answer = (n) => `answer ${n}` } = {}) {
    const calls = /** @type {any[]} */ ([]);
    let n = 0;
    return {
        calls,
        session: (/** @type {any} */ model) => ({
            provider: 'openai',
            model,
            _tools: [],
            _toolsStore: [{ name: 'preset' }],
            _capabilityTools: new Map([['task', {}]]),
            _systemMessage: /** @type {any} */ (null),
            eventEmitter: { emit() {} },
            /** @param {*} v */
            withSystemMessage(v) { this._systemMessage = v; return this; },
            /** @param {{tools: *}} arg0 */
            withTools({ tools }) { this._tools = tools; return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            withCircuitBreaker() { return this; },
            /** @param {{initialInput: any, options: any}} arg0 */
            async run({ initialInput }) {
                calls.push({ input: initialInput, session: this });
                n += 1;
                return answer(n);
            },
        }),
    };
}

/** @param {any[]} input @returns {string} */
const promptText = (input) => input.map((m) => String(m?.content ?? '')).join('\n');

// ─── A1 — the declared Step is the runnable input ───────────────────────────

test('W3/A1: a Step-shaped input drives the run (deps still win)', async () => {
    const client = makeClient({ answer: () => 'ok' });
    const outcome = await runStep({ step: {
        id: 's1',
        systemPrompt: 'SYS-FROM-STEP',
        userPromptTemplate: 'PROMPT-FROM-STEP',
        tools: [{ name: 'tool-from-step' }],
        messages: [{ role: 'user', content: 'EARLIER-TURN' }],
        maxIterations: 3,
    }, deps: { client, model: 'm' } });

    assert.equal(outcome.result, 'ok');
    const call = client.calls[0];
    assert.equal(call.session._systemMessage, 'SYS-FROM-STEP', 'the declared systemPrompt reaches the session');
    assert.deepEqual(call.session._tools, [{ name: 'tool-from-step' }], 'the declared tools reach the session');
    assert.deepEqual(call.input.map((/** @type {any} */ m) => [m.role, m.content]), [
        ['user', 'EARLIER-TURN'], ['user', 'PROMPT-FROM-STEP'],
    ], 'the declared history and prompt are the input');
});

test('W3/A1: an explicit deps field overrides the Step field', async () => {
    const client = makeClient({ answer: () => 'ok' });
    await runStep({ step: { systemPrompt: 'SYS-FROM-STEP' }, deps: { client, model: 'm', systemPrompt: 'SYS-FROM-DEPS', userText: 'go' } });
    assert.equal(client.calls[0].session._systemMessage, 'SYS-FROM-DEPS', 'the engine bag is the authority, the Step its default');
});

// ─── A3 — the SM retry sees the answer it must revise ───────────────────────

test('W3/A3: the SM retry prompt contains the failed answer', async () => {
    const client = makeClient({ answer: (n) => `answer-${n}` });
    const graph = {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            model: 'm',
            userPromptTemplate: 'Produce it.',
            verify: () => ({ passed: false, evidence: 'EV-1' }),
            terminal: true,
        }],
        edges: [],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm.run(), /failed verification/);

    assert.ok(client.calls.length >= 2, 'a retry happened');
    const retry = promptText(client.calls[1].input);
    assert.ok(retry.includes('answer-1'), 'the retry carries the answer it is asked to revise');
    assert.ok(retry.includes('[Verification feedback from the previous attempt]'), 'and the feedback that rejected it');
    assert.ok(retry.includes('Produce it.'), 'and the original task');
});

// ─── A4 — verifyFeedback reaches the model on the explicit-history path ─────

test('W3/A4: verifyFeedback is applied when an explicit history is passed', async () => {
    const client = makeClient({ answer: () => 'ok' });
    await runStep({ step: {}, deps: {
        client,
        model: 'm',
        messages: [{ role: 'user', content: 'HISTORY-TURN' }, { role: 'assistant', content: 'HISTORY-ANSWER' }],
        verifyFeedback: 'EV-EXPLICIT',
    } });
    const input = client.calls[0].input;
    assert.equal(input[0].content, 'HISTORY-TURN', 'the explicit history is preserved, not rewritten');
    assert.ok(promptText(input).includes('EV-EXPLICIT'), 'the feedback is not silently dropped on this path');
    assert.ok(promptText(input).includes('[Verification feedback'), 'and it is labelled like the documented one');
});

test('W3/A3-cycle: a successful retry clears the stash, so a later visit starts clean', async () => {
    let verdicts = 0;
    const client = makeClient({ answer: (n) => `answer-${n}` });
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'A-task.', maxVisits: 10, verify: () => {
                verdicts += 1;
                return verdicts === 1 ? { passed: false, evidence: 'EV-CYCLE' } : { passed: true, evidence: 'ok' };
            } },
            { id: 'done', execute: async () => 'finished', terminal: true },
        ],
        edges: [
            { from: 'a', to: 'a', condition: (/** @type {any} */ ctx) => {
                const n = (ctx.get({ k: 'n' }) ?? 0) + 1;
                ctx.set({ k: 'n', v: n });
                return n < 2;
            } },
            { from: 'a', to: 'done', condition: () => true },
        ],
    }, options: { client, defaultModel: 'm' } });
    await sm.run();

    assert.equal(client.calls.length, 3, 'attempt 1, a successful retry, then a second visit');
    const secondVisit = promptText(client.calls[2].input);
    assert.ok(!secondVisit.includes('EV-CYCLE'), 'a later visit must not inherit feedback from an earlier verify cycle');
    assert.ok(!secondVisit.includes('answer-1'), 'nor the failed attempt it replaced');
});

// ─── A5 — the handoff is validated once, at the boundary ────────────────────

test('W3/A5: runStep rejects an invalid handoff instead of inventing a default', async () => {
    const client = makeClient({ answer: () => 'ok' });
    await assert.rejects(
        () => runStep({ step: {}, deps: { client, model: 'm', userText: 'go', handoff: { goal: 'bogus' } } }),
        /handoff\.goal must be one of/,
        'a typo in handoff.goal must fail loud, not fall back to "full"',
    );
    assert.equal(client.calls.length, 0, 'no model call was made with an invalid policy');
});

test('W3/A5: a valid handoff still reaches the step unchanged', async () => {
    const client = makeClient({ answer: () => 'ok' });
    await runStep({ step: {}, deps: { client, model: 'm', userText: 'go', handoff: { goal: 'clean', tools: 'none' } } });
    assert.deepEqual(client.calls[0].session._toolsStore, [], 'tools:none still strips the store when the session is ours to configure');
    assert.equal(client.calls[0].session._capabilityTools.has('task'), false, 'and the task capability is removed');
});

test('W3/A5-tools: an explicit handoff tool list drives the session', async () => {
    const client = makeClient({ answer: () => 'ok' });
    await runStep({ step: {}, deps: {
        client, model: 'm', userText: 'go',
        tools: [{ name: 'deps-tool' }],
        handoff: { tools: [{ name: 'handoff-tool' }] },
    } });
    assert.deepEqual(client.calls[0].session._tools, [{ name: 'handoff-tool' }],
        'a handoff tool list is a decision — it used to be validated and then ignored here');
});

test('W3/A3-empty: a verdict without evidence still carries the failed answer', async () => {
    const client = makeClient({ answer: (n) => `answer-${n}` });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', model: 'm', userPromptTemplate: 'Produce it.', verify: () => ({ passed: false }), terminal: true }],
        edges: [],
    }, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm.run(), /failed verification/);
    // `{passed:false}` is a legal verdict; `assertVerifyVerdict` checks the shape,
    // not a non-empty evidence string. The retry must still see the answer.
    assert.ok(promptText(client.calls[1].input).includes('answer-1'),
        'the failed answer does not depend on the feedback string being truthy');
});

test('W3/A3-resume: a checkpoint resumed mid-verify-loop continues with the failed answer and its feedback', async () => {
    /** @type {any} */
    let failOn = null;
    const firstClient = makeClient({ answer: (n) => `answer-${n}` });
    const firstSm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen', model: 'm', userPromptTemplate: 'Produce it.',
            verify: () => { if (failOn === 'second') throw new Error('transport died'); return { passed: false, evidence: 'EV-RESUME' }; },
            terminal: true,
        }],
        edges: [],
    }, options: { client: firstClient, defaultModel: 'm', contract: { maxRetries: 3 } } });
    // Attempt 1 fails verification; attempt 2 dies before the model answers.
    let calls = 0;
    const originalRun = firstClient.session;
    firstClient.session = (/** @type {any} */ model) => {
        const s = originalRun(model);
        const run = s.run;
        s.run = async (/** @type {any} */ arg) => {
            calls += 1;
            if (calls === 2) throw new Error('transport died');
            return run(arg);
        };
        return s;
    };
    await assert.rejects(() => firstSm.run(), /transport died/);
    const saved = firstSm.save();

    const resumedClient = makeClient({ answer: () => 'resumed-answer' });
    const resumed = StateMachine.load({ json: saved, graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', model: 'm', userPromptTemplate: 'Produce it.', verify: () => ({ passed: true, evidence: 'ok' }), terminal: true }],
        edges: [],
    }, options: { client: resumedClient, defaultModel: 'm', contract: { maxRetries: 3 } } });
    await resumed.run();

    const firstResumedPrompt = promptText(resumedClient.calls[0].input);
    assert.ok(firstResumedPrompt.includes('answer-1'),
        'the resumed retry still carries the answer it was asked to revise (the stash rides the checkpoint)');
    assert.ok(firstResumedPrompt.includes('EV-RESUME'),
        'and the feedback that rejected it (persisted with the stash, not only in the loop local)');
});

test('W3/A3-restore: a failed attempt is never replayed as a unit by a node id that did not run', async () => {
    const failing = makeClient({ answer: (n) => `poison-answer-${n}` });
    const failingSm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', model: 'm', userPromptTemplate: 'Produce poison.', verify: () => ({ passed: false, evidence: 'POISON-EV' }), terminal: true }],
        edges: [],
    }, options: { client: failing, defaultModel: 'm' } });
    await assert.rejects(() => failingSm.run(), /failed verification/);
    const saved = failingSm.save();

    // The checkpoint resumes with the same id as a programmatic node: it never
    // touches the row maps, so a leaked failed transcript would reach the sibling.
    const sibling = makeClient({ answer: () => 'sib-answer' });
    const resumed = StateMachine.load({
        json: saved,
        graph: {
            entry: 'gen',
            nodes: [
                { id: 'gen', execute: async () => 'stub-output' },
                { id: 'sib', model: 'm', transfer: 'ledger', userPromptTemplate: 'Summarize upstream.', terminal: true },
            ],
            edges: [{ from: 'gen', to: 'sib' }],
        },
        options: { client: sibling, defaultModel: 'm' },
    });
    await resumed.run();
    const sibPrompt = promptText(sibling.calls[0].input);
    assert.ok(!sibPrompt.includes('poison-answer'), "a sibling must not replay the failed attempt's answer (the retry stash is not a transfer unit)");
    assert.ok(!sibPrompt.includes('Produce poison.'), 'nor its failed prompt row');
    assert.ok(sibPrompt.includes('stub-output'), 'the programmatic node output is the unit');
});
