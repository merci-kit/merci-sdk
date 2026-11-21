// @ts-check

/**
 * Wave 2 — the single run ledger (D1 + A2 + B7).
 *
 * Each check below was observed FAILING against the pre-fix tree; the failing
 * assertion is named in the run record. The last check is a pin: it passes
 * before and after and exists so the A2 repair cannot silently delete the
 * documented `runStep` fallback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { runStep } from '../lib/agentic/step.mjs';
import { createAssistantMessage } from '../lib/messaging/messages.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

// ─── D1 — a transfer unit carries the delta, not the cumulative transcript ──

/**
 * Captures every SM node run's initial message array.
 * @returns {{inputs: any[][], session: (model?: string) => any}}
 */
function makeCapturingSmClient() {
    /** @type {any[][]} */
    const inputs = [];
    let n = 0;
    return {
        inputs,
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withTools() { return this; },
            /** @param {{initialInput: any}} arg0 */
            async run({ initialInput }) {
                inputs.push(initialInput);
                n += 1;
                return `answer ${n}`;
            },
        }),
    };
}

const rowsOf = (/** @type {any[]} */ input) => input.map((m) => [m.role, m.content]);

test('W2/D1-SM: a 3-node ledger chain replays each node turn once (5 rows, not 7)', async () => {
    const client = makeCapturingSmClient();
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'm', userPromptTemplate: 'Ask B.' },
            { id: 'c', model: 'm', userPromptTemplate: 'Ask C.', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm', transfer: 'ledger' } });
    await sm.run();

    const cInput = rowsOf(client.inputs[2]);
    assert.deepEqual(cInput, [
        ['user', 'Ask A.'], ['assistant', 'answer 1'],
        ['user', 'Ask B.'], ['assistant', 'answer 2'],
        ['user', 'Ask C.'],
    ], "each upstream turn reaches node c exactly once — a's turn is not replayed inside b's unit");
    const flattened = cInput.map(([, content]) => content);
    assert.equal(flattened.filter((c) => c === 'Ask A.').length, 1, "the audit's duplicate: 'Ask A.' must appear once");
});

/**
 * @param {string[]} prompts
 * @returns {{client: any, inputs: any[][]}}
 */
function makeCapturingDagClient(prompts) {
    /** @type {any[][]} */
    const inputs = [];
    return {
        inputs,
        client: {
            /** @param {string} model */
            session: (model) => ({
                provider: 'openai',
                model,
                _tools: [],
                eventEmitter: { emit() {} },
                withSystemMessage() { return this; },
                withTools() { return this; },
                withMemory() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                withCircuitBreaker() { return this; },
                /** @param {{initialInput: any}} arg0 */
                run({ initialInput }) {
                    if (isObjectiveRestatePrompt({ input: initialInput })) return Promise.resolve('');
                    inputs.push(initialInput);
                    return Promise.resolve(prompts[inputs.length - 1]);
                },
            }),
        },
    };
}

test('W2/D1-DAG: a 3-step ledger chain replays each step turn once (5 rows, not 7)', async () => {
    const { client, inputs } = makeCapturingDagClient(['answer 1', 'answer 2', 'answer 3']);
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', transfer: 'ledger' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', systemPrompt: 'sys', userPromptTemplate: 'Do A.', dependencies: [] },
        { id: 'b', title: 'B', systemPrompt: 'sys', userPromptTemplate: 'Do B.', dependencies: ['a'] },
        { id: 'c', title: 'C', systemPrompt: 'sys', userPromptTemplate: 'Do C.', dependencies: ['a', 'b'], intakeMode: 'all' },
    ] });
    await executor.execute({ userGoal: 'goal' });

    assert.deepEqual(rowsOf(inputs[2]), [
        ['user', 'Do A.'], ['assistant', 'answer 1'],
        ['user', 'Do B.'], ['assistant', 'answer 2'],
        ['user', 'Do C.'],
    ], "step c receives one copy of every upstream turn — step b's transcript does not re-carry step a");
});

// ─── A2 — one writer, after the turn ────────────────────────────────────────

/**
 * A session that honours the documented `step()` contract — returns
 * `{ done, content, messages }` — and NEVER touches `_lastStepMessages`.
 * @returns {any}
 */
function makeContractSession() {
    const session = {
        provider: 'openai',
        model: 'm',
        _tools: [],
        eventEmitter: { emit() {} },
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        withCircuitBreaker() { return session; },
        /** @param {{initialInput: any[]}} arg0 */
        run({ initialInput }) {
            return runAgenticLoop({ session, messages: initialInput, opts: { maxIterations: 5 } });
        },
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            const next = [...messages, createAssistantMessage({ provider: 'openai', content: 'THE ANSWER' })];
            return { done: true, content: 'THE ANSWER', messages: next, thoughtSignature: null };
        },
    };
    return session;
}

test('W2/A2: runStep returns the answer row when the backend honours the step contract only', async () => {
    const session = makeContractSession();
    const outcome = await runStep({ step: {}, deps: {
        client: { session: () => session },
        model: 'm',
        userText: 'hi',
    } });
    assert.equal(outcome.result, 'THE ANSWER');
    assert.deepEqual(outcome.messages.map((/** @type {any} */ m) => [m.role, m.content]), [
        ['user', 'hi'], ['assistant', 'THE ANSWER'],
    ], 'the committed transcript is written by the loop AFTER the turn, not pre-filled before it');
});

test('W2/A2-pin: a session that bypasses the agentic loop still gets the synthesized answer row', async () => {
    /** @type {any} */
    const session = {
        provider: 'openai',
        model: 'm',
        _tools: [],
        eventEmitter: { emit() {} },
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        withCircuitBreaker() { return session; },
        async run() { return 'BARE ANSWER'; },
    };
    const outcome = await runStep({ step: {}, deps: { client: { session: () => session }, model: 'm', userText: 'hi' } });
    assert.deepEqual(outcome.messages.map((/** @type {any} */ m) => [m.role, m.content]), [
        ['user', 'hi'], ['assistant', 'BARE ANSWER'],
    ], 'the documented fallback survives the one-writer repair');
});

test('W2/A2-delta: a session that rewrote its history is never sliced as if it were the input', async () => {
    const rewritten = [
        { role: 'user', content: '[SUMMARY of earlier rows]' },
        { role: 'user', content: 'NEW ASK' },
        { role: 'assistant', content: 'NEW ANSWER' },
    ];
    /** @type {any} */
    const session = {
        provider: 'openai',
        model: 'm',
        _tools: [],
        eventEmitter: { emit() {} },
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        withCircuitBreaker() { return session; },
        /** @param {{initialInput: any[]}} arg0 */
        async run({ initialInput }) {
            // Same LENGTH as the input, different rows: a length-based slice
            // would hand downstream an empty unit and lose the answer.
            assert.equal(rewritten.length, initialInput.length);
            session._lastStepMessages = rewritten;
            return 'NEW ANSWER';
        },
    };
    const outcome = await runStep({ step: {}, deps: {
        client: { session: () => session }, model: 'm', priorMessages: [{ role: 'user', content: 'OLD ASK 1' }, { role: 'assistant', content: 'OLD ANSWER 1' }], userText: 'NEW ASK',
    } });
    assert.deepEqual(outcome.deltaMessages, rewritten,
        'a rewritten prefix falls back to the whole transcript — never a silent slice');
});

test("W2/A2-stale: a reused session never returns the previous run's rows", async () => {
    /** @type {any} */
    const session = {
        provider: 'openai',
        model: 'm',
        _tools: [],
        eventEmitter: { emit() {} },
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        withCircuitBreaker() { return session; },
        /** @param {{initialInput: any[]}} arg0 */
        async run({ initialInput }) {
            session._lastStepMessages = [...initialInput, { role: 'assistant', content: 'FIRST' }];
            return 'FIRST';
        },
    };
    const deps = { client: { session: () => session }, model: 'm', userText: 'one' };
    await runStep({ step: {}, deps });
    // The second run's backend does not write the private field. Without the
    // pre-run clear it would inherit the FIRST transcript instead of falling back.
    session.run = async () => 'SECOND';
    const second = await runStep({ step: {}, deps: { ...deps, userText: 'two' } });
    assert.deepEqual(second.messages.map((/** @type {any} */ m) => String(m.content)), ['two', 'SECOND'],
        'the documented fallback synthesizes this run, not the previous one');
});

test('W2/D1-restore: a pre-wave-2 checkpoint (no nodeDelta) still replays verbatim', async () => {
    const client = makeCapturingSmClient();
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'm', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
    };
    // The exact shape an old save() wrote: nodeMessages/nodeBackend, no nodeDelta.
    const oldCheckpoint = {
        phase: 'idle',
        current: 'b',
        visited: [['a', 1]],
        history: [],
        context: { a: 'answer 1' },
        nodeMessages: [['a', [{ role: 'user', content: 'Ask A.' }, { role: 'assistant', content: 'answer 1' }]]],
        nodeBackend: [['a', 'openai']],
        replanCount: 0,
        usageTokens: 0,
    };
    const sm = StateMachine.load({ json: JSON.stringify(oldCheckpoint), graph, options: { client, defaultModel: 'm', transfer: 'ledger' } });
    await sm.run();
    assert.deepEqual(rowsOf(client.inputs[0]), [
        ['user', 'Ask A.'], ['assistant', 'answer 1'], ['user', 'Execute your task.'],
    ], 'the cumulative capture is the fallback — not a degraded digest row');
});

// ─── B7 — the step record carries its own cost ──────────────────────────────
test('W2/B7: a step records its usage and keeps it across save/load', async () => {
    const client = {
        /** @param {string} model */
        session: (model) => ({
            provider: 'openai',
            model,
            _tools: [],
            eventEmitter: { emit() {} },
            withSystemMessage() { return this; },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            withCircuitBreaker() { return this; },
            /** @param {{initialInput: any}} arg0 */
            run({ initialInput }) {
                if (isObjectiveRestatePrompt({ input: initialInput })) return Promise.resolve('');
                /** @type {any} */ (this)._lastRunUsage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
                return Promise.resolve('step output');
            },
        }),
    };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', systemPrompt: 'sys', userPromptTemplate: 'Do A.', dependencies: [] },
    ] });
    await executor.execute({ userGoal: 'goal' });

    const live = /** @type {any} */ (executor.steps.get('a')).usage;
    assert.deepEqual(live, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        '"what did step a cost" is answerable from the step record');

    const restored = WorkflowExecutor.load({ json: executor.save(), options: { client, defaultModel: 'm' } });
    assert.deepEqual(/** @type {any} */ (restored.steps.get('a')).usage,
        { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        'a restored step keeps its per-token cost');
});
