// @ts-check

/**
 * Differential reference for the executor wave-loop's failure plumbing.
 *
 * The loop ends a run through two separate failure blocks (`failedNodes` before
 * scheduling, `unrecovered` after a wave). Both build the same `failedOutputs`
 * map and both guard the abort signal the same way. These checks pin the
 * observable contract — message shape, error fields, event payload, the
 * recorded-vs-fallback output precedence, and the abort — so extracting either
 * duplicate into a helper stays behaviour-free for a resumed run.
 *
 * Coverage boundary: the checks below drive the `unrecovered` block and the
 * wave-head abort. The `failedNodes` block and the abort inside the deferred-
 * evaluation loop need a resumed run whose checkpoint already holds a failed
 * step; no fixture reaches them, so those two sites are held by textual identity
 * with the checked ones rather than by a test. Reach them if that changes.
 *
 * Everything is observed through the real `WorkflowExecutor.run()`; no part of
 * the loop is copied here. The stub cases set `node.status`/`node.output`
 * directly to reach the `this.outputs[id]`-absent branch, which a real engine
 * never produces (it always records the error via `_recordStepError`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {any} text @returns {string} */
function asText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
    return JSON.stringify(text);
}

/** @param {{runImpl: (text: string) => Promise<any>}} arg0 @returns {any} */
function makeClient({ runImpl }) {
    return {
        session() {
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                /** @param {{initialInput: any}} arg0 */
                run: ({ initialInput }) => isObjectiveRestatePrompt({ input: initialInput })
                    ? Promise.resolve('')
                    : runImpl(asText(initialInput)),
            };
            return s;
        },
    };
}

/** @param {string} id @param {string[]} [dependencies] */
const step = (id, dependencies = []) => ({
    id,
    title: id,
    systemPrompt: 'Be terse.',
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
});

/**
 * Runs one plan with no planner (so the self-heal branch is unavailable) and
 * returns the rejection plus the instance and the WORKFLOW.FAILED envelopes.
 * @param {{stepsList: any[], runImpl?: (text: string) => Promise<any>, patch?: (node: any, executor: any) => void}} arg0
 */
async function runFailing({ stepsList, runImpl = async () => 'ok', patch = () => {} }) {
    const client = makeClient({ runImpl });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    /** @type {any[]} */
    const failedEvents = [];
    executor.on(EVENTS.WORKFLOW.FAILED, (/** @type {any} */ e) => failedEvents.push(e));
    executor.setSteps({ stepsList });
    const original = executor._executeStepNode.bind(executor);
    /** @param {any} args */
    executor._executeStepNode = async (args) => {
        if (stepsList.some((s) => s.id === args.node.id && s.__stub)) {
            patch(args.node, executor);
            return undefined;
        }
        return original(args);
    };
    /** @type {any} */
    let error = null;
    try {
        await executor.execute({ userGoal: 'goal' });
    } catch (err) {
        error = err;
    }
    return { executor, error, failedEvents };
}

// ─── 1. Typed failure, message with the reason suffix ──────────────────────

test('failure/no-heal: a normal step error throws OrchestrationFailedError with the ids and the reason', async () => {
    const { executor, error } = await runFailing({
        stepsList: [step('sad')],
        runImpl: async (text) => {
            if (text.includes('SAD-STEP')) throw new Error('session down');
            return 'ok';
        },
    });
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.equal(error.message, 'Step(s) execution failed and could not be self-healed: sad — Error: session down');
    assert.deepEqual(error.failedSteps, ['sad']);
    assert.deepEqual(error.failedOutputs, { sad: { output: 'Error: session down', data: { error: 'session down' } } });
    assert.deepEqual(error.context.failedSteps, ['sad']);
    assert.deepEqual(error.context.failedOutputs, error.failedOutputs);
    assert.equal(executor.steps.get('sad')?.status, 'failed');
});

test('failure/no-heal: several failed steps are all named', async () => {
    const { error } = await runFailing({
        stepsList: [step('sad'), step('madder')],
        runImpl: async (text) => {
            if (text.includes('SAD-STEP')) throw new Error('one');
            if (text.includes('MADDER-STEP')) throw new Error('two');
            return 'ok';
        },
    });
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.deepEqual([...error.failedSteps].sort(), ['madder', 'sad']);
    assert.deepEqual([...error.context.failedSteps].sort(), ['madder', 'sad']);
    assert.ok(Object.keys(error.failedOutputs).length === 2);
    assert.deepEqual(Object.keys(error.failedOutputs).sort(), ['madder', 'sad']);
});

test('failure/failedOutputs: a recorded falsy output is used, not replaced by the fallback', async () => {
    // `??` and `||` agree on absent output but not on recorded 0/''/false, which
    // are real stored outputs. A `||` rewrite would silently swap them.
    for (const recorded of [0, '', false]) {
        const { error } = await runFailing({
            stepsList: [{ ...step('zero'), __stub: true }],
            /** @param {any} node @param {any} executor */
            patch: (node, executor) => {
                node.status = 'failed';
                node.output = 'boom';
                executor.outputs.zero = recorded;
            },
        });
        assert.equal(error?.failedOutputs.zero, recorded, `recorded ${String(recorded)} must not hit the fallback`);
    }
});

// ─── 2. failedOutputs precedence and fallback ──────────────────────────────

test('failure/failedOutputs: the recorded output object is used verbatim', async () => {
    const { executor, error } = await runFailing({
        stepsList: [step('sad')],
        runImpl: async (text) => {
            if (text.includes('SAD-STEP')) throw new Error('session down');
            return 'ok';
        },
    });
    assert.equal(error?.failedOutputs.sad, executor.outputs.sad, 'the recorded entry is not rebuilt');
});

test('failure/failedOutputs: no recorded output falls back to the node output and its string', async () => {
    const { error } = await runFailing({
        stepsList: [{ ...step('quiet'), __stub: true }],
        patch: (node) => { node.status = 'failed'; node.output = ''; },
    });
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.deepEqual(error.failedOutputs.quiet, { output: '', data: { error: '' } });
    assert.ok(!error.message.includes(' — '), `no reason suffix expected, got: ${error.message}`);
    assert.equal(error.message, 'Step(s) execution failed and could not be self-healed: quiet');
});

test('failure/failedOutputs: an undefined node output becomes an empty error string', async () => {
    const { error } = await runFailing({
        stepsList: [{ ...step('gone'), __stub: true }],
        patch: (node) => { node.status = 'failed'; node.output = undefined; },
    });
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.ok(Object.hasOwn(error.failedOutputs.gone, 'output'), 'the output key is present');
    assert.equal(error.failedOutputs.gone.output, undefined);
    assert.deepEqual(error.failedOutputs.gone.data, { error: '' }, 'String(undefined ?? \'\') is an empty string');
    assert.ok(!error.message.includes(' — '), 'an undefined output is not a reason');
});

test('failure/failedOutputs: an object node output is kept and stringified into the error', async () => {
    const objectOutput = { detail: 'x' };
    const { error } = await runFailing({
        stepsList: [{ ...step('blob'), __stub: true }],
        patch: (node) => { node.status = 'failed'; node.output = objectOutput; },
    });
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.equal(error.failedOutputs.blob.output, objectOutput, 'the object is kept, not stringified');
    assert.deepEqual(error.failedOutputs.blob.data, { error: '[object Object]' });
    assert.match(error.message, / — \[object Object\]$/);
});

// ─── 3. Event payload matches the thrown error ─────────────────────────────

test('failure/event: WORKFLOW.FAILED is emitted once with the same failedOutputs as the throw', async () => {
    const { error, failedEvents } = await runFailing({
        stepsList: [step('sad')],
        runImpl: async (text) => {
            if (text.includes('SAD-STEP')) throw new Error('session down');
            return 'ok';
        },
    });
    assert.equal(failedEvents.length, 1, 'exactly one WORKFLOW.FAILED');
    const payload = failedEvents[0];
    assert.deepEqual(payload.failedSteps, error.failedSteps);
    assert.equal(payload.reason, 'Error: session down', 'the event names the step failure as the reason');
    assert.deepEqual(payload.failedOutputs, error.failedOutputs);
    for (const entry of Object.values(payload.failedOutputs)) {
        assert.deepEqual(Object.keys(/** @type {any} */ (entry)).sort(), ['data', 'output']);
    }
});

test('failure/event: with no reason the payload falls back to the failure sentence', async () => {
    const { error, failedEvents } = await runFailing({
        stepsList: [{ ...step('quiet'), __stub: true }],
        patch: (node) => { node.status = 'failed'; node.output = ''; },
    });
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].reason, 'Step(s) execution failed and could not be self-healed: quiet');
    assert.equal(error.message, failedEvents[0].reason);
    assert.deepEqual(failedEvents[0].failedOutputs, error.failedOutputs);
});

// ─── 4. Abort at the wave-loop head ────────────────────────────────────────

test('abort/head: an aborted signal throws AbortedError and emits no WORKFLOW.FAILED', async () => {
    const reason = new Error('operator stop');
    const controller = new AbortController();
    controller.abort(reason);
    const client = makeClient({ runImpl: async () => 'ok' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', signal: controller.signal } });
    /** @type {any[]} */
    const failedEvents = [];
    executor.on(EVENTS.WORKFLOW.FAILED, (/** @type {any} */ e) => failedEvents.push(e));
    executor.setSteps({ stepsList: [step('a')] });
    /** @type {any} */
    let error = null;
    try {
        await executor.execute({ userGoal: 'goal' });
    } catch (err) {
        error = err;
    }
    assert.equal(error?.name, 'AbortedError');
    assert.equal(error.message, 'Workflow aborted.');
    assert.equal(error.cause, reason, 'the abort reason rides as cause');
    assert.equal(failedEvents.length, 0, 'an abort is not a step failure');
});

// ─── 5. Resume: a requeued failed step does not re-run completed work ──────

test('resume/requeued-failure: a resumed run does not re-run the completed step', async () => {
    /** @type {Record<string, number>} */
    const firstCounts = {};
    let bFailed = false;
    const first = await runFailing({
        stepsList: [step('a'), step('b', ['a'])],
        runImpl: async (text) => {
            if (text.includes('A-STEP')) { firstCounts.a = (firstCounts.a ?? 0) + 1; return 'A-OUT'; }
            if (text.includes('B-STEP')) {
                firstCounts.b = (firstCounts.b ?? 0) + 1;
                if (!bFailed) { bFailed = true; throw new Error('b exploded'); }
                return 'B-OUT';
            }
            return 'unknown';
        },
    });
    assert.equal(first.error?.name, 'OrchestrationFailedError');
    assert.deepEqual(firstCounts, { a: 1, b: 1 });

    /** @type {Record<string, number>} */
    const counts = {};
    const resumed = WorkflowExecutor.load({ json: first.executor.save(), options: {
        client: makeClient({ runImpl: async (text) => {
            if (text.includes('A-STEP')) { counts.a = (counts.a ?? 0) + 1; return 'A-OUT'; }
            if (text.includes('B-STEP')) { counts.b = (counts.b ?? 0) + 1; return 'B-OUT'; }
            return 'unknown';
        } }),
        defaultModel: 'm',
    } });
    assert.deepEqual(resumed.retryFailedSteps(), ['b']);
    const outputs = /** @type {any} */ (await resumed.execute({ userGoal: 'goal' }));
    assert.equal(counts.a, undefined, 'the completed step was not re-run');
    assert.equal(outputs.a.output, 'A-OUT');
});
