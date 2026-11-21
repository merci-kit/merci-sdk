// @ts-check

/**
 * Wave 7 / C4 — an unhandled step rejection becomes a step failure.
 *
 * A step is marked `running` before its engine runs. If the engine rejects
 * *outside* its own catch, the wave loop used to discard that rejection: the node
 * stayed `running` forever, and the `while (true)` scheduler — whose terminal
 * check needs `runningNodes.length === 0` — spun with no way out. All four
 * built-in engines catch internally, so this is a guard, not an active bug: the
 * guard must make the failure visible and the run terminal.
 *
 * The checks force such a rejection by patching the engine dispatch on the
 * instance, next to a step that fails through the normal path so the run rejects
 * (rather than hangs) on the pre-fix tree too.
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

/** @param {string} id @param {string[]} dependencies */
const step = (id, dependencies = []) => ({
    id,
    title: id,
    systemPrompt: 'Be terse.',
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
});

/**
 * A plan where `boom` rejects outside its engine and `sad` fails normally.
 * @param {{maxConcurrency?: number}} [arg0]
 */
async function runBoomPlan({ maxConcurrency = 8 } = {}) {
    /** @type {any[]} */
    const stepErrors = [];
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('SAD-STEP')) throw new Error('session down');
        return `${text}-OK`;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxConcurrency } });
    executor.on(EVENTS.WORKFLOW.STEP_ERROR, (/** @type {any} */ e) => stepErrors.push(e));
    executor.setSteps({ stepsList: [step('sad'), step('boom'), step('fine')] });
    const original = executor._executeStepNode.bind(executor);
    /** @param {any} args */
    executor._executeStepNode = async (args) => {
        if (args.node.id === 'boom') throw new Error('engine exploded');
        return original(args);
    };
    /** @type {any} */
    let error = null;
    try {
        await executor.execute({ userGoal: 'goal' });
    } catch (err) {
        error = err;
    }
    return { executor, error, stepErrors };
}

// ─── The guard ─────────────────────────────────────────────────────────────

test('W7C4/unhandled-becomes-failure: an escaped rejection fails the step and ends the run', async () => {
    const { executor, error } = await runBoomPlan();
    assert.ok(error, 'the run rejects instead of spinning');
    assert.equal(error.name, 'OrchestrationFailedError', `expected OrchestrationFailedError, got ${error?.name}: ${error?.message}`);
    const failed = String(error?.message ?? '');
    assert.ok(failed.includes('boom'), 'the escaped rejection is named in the failure');
    assert.ok(failed.includes('sad'), 'and so is the normal failure');
    const boom = executor.steps.get('boom');
    assert.equal(boom?.status, 'failed', 'the node is no longer running');
    assert.match(String(boom?.output), /engine exploded/);
    assert.match(String(/** @type {any} */ (executor.outputs.boom?.data)?.error), /engine exploded/);
    assert.equal(executor.steps.get('fine')?.status, 'completed', 'the healthy sibling still completed');
});

test('W7C4/bounded-path: the guard also covers the concurrency-limited wave runner', async () => {
    const { executor, error } = await runBoomPlan({ maxConcurrency: 1 });
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.match(String(error?.message), /boom/);
    assert.equal(executor.steps.get('boom')?.status, 'failed');
});

// ─── Observability and no double-recording ─────────────────────────────────

test('W7C4/step-error-event: the escaped rejection emits the normal STEP_ERROR once', async () => {
    const { stepErrors } = await runBoomPlan();
    const boomEvents = stepErrors.filter((e) => e?.stepId === 'boom');
    assert.equal(boomEvents.length, 1, 'exactly one STEP_ERROR for the escaped step');
    assert.match(String(boomEvents[0]?.error), /engine exploded/);
});

test('W7C4/no-double-record: an engine that already recorded its failure is not re-recorded', async () => {
    const { executor, stepErrors } = await runBoomPlan();
    const sadEvents = stepErrors.filter((e) => e?.stepId === 'sad');
    assert.equal(sadEvents.length, 1, 'the normal failure is recorded once');
    assert.match(String(executor.steps.get('sad')?.output), /session down/);
});

test('W7C4/record-then-rethrow: an engine that records and rethrows is not recorded twice', async () => {
    /** @type {any[]} */
    const stepErrors = [];
    const client = makeClient({ runImpl: async () => 'ok' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.on(EVENTS.WORKFLOW.STEP_ERROR, (/** @type {any} */ e) => stepErrors.push(e));
    executor.setSteps({ stepsList: [step('boom')] });
    const original = executor._executeStepNode.bind(executor);
    /** @param {any} args */
    executor._executeStepNode = async (args) => {
        if (args.node.id === 'boom') {
            const err = new Error('engine recorded then threw');
            executor._recordStepError({ node: args.node, err, stepCtx: args.stepCtx });
            throw err;
        }
        return original(args);
    };
    /** @type {any} */
    let error = null;
    try { await executor.execute({ userGoal: 'goal' }); } catch (err) { error = err; }
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.match(String(error?.message), /engine recorded then threw/);
    const boomEvents = stepErrors.filter((e) => e?.stepId === 'boom');
    assert.equal(boomEvents.length, 1, 'recorded once, not again by the guard');
});

test('W7C4/circular-details: a verify error with circular details keeps its real message', async () => {
    const client = makeClient({ runImpl: async () => 'answer' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{
        ...step('checked'),
        verify: () => {
            /** @type {any} */
            const details = { reason: 'schema mismatch' };
            details.self = details;
            throw Object.assign(new Error('verify exploded'), { details });
        },
    }] });
    /** @type {any} */
    let error = null;
    try { await executor.execute({ userGoal: 'goal' }); } catch (err) { error = err; }
    assert.equal(error?.name, 'OrchestrationFailedError', 'the run ends');
    assert.match(String(error?.message), /verify exploded/, 'the real reason survives the circular details');
    assert.equal(executor.steps.get('checked')?.status, 'failed');
});

test('W7C4/timeout-once: a step timeout is recorded once, not again by the guard', async () => {
    /** @type {any[]} */
    const stepErrors = [];
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('SLOW-STEP')) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            return 'late';
        }
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.on(EVENTS.WORKFLOW.STEP_ERROR, (/** @type {any} */ e) => stepErrors.push(e));
    executor.setSteps({ stepsList: [{ ...step('slow'), stepTimeoutMs: 20 }] });
    /** @type {any} */
    let error = null;
    try { await executor.execute({ userGoal: 'goal' }); } catch (err) { error = err; }
    assert.equal(error?.name, 'OrchestrationFailedError', 'the timeout ends the run');
    assert.match(String(error?.message), /slow/);
    const slowEvents = stepErrors.filter((e) => e?.stepId === 'slow');
    assert.equal(slowEvents.length, 1, 'the timeout is recorded exactly once');
    assert.match(String(slowEvents[0]?.error), /timed out after 20ms/);
    assert.equal(executor.steps.get('slow')?.status, 'failed');
});

// ─── Invariant: a clean wave is unaffected ─────────────────────────────────

test('W7C4/clean-wave: a wave with no rejection completes normally', async () => {
    const client = makeClient({ runImpl: async (text) => `${text}-OK` });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any} */
    const outputs = await executor.execute({ userGoal: 'goal' });
    assert.match(String(outputs.a.output), /^A-STEP-OK$/);
    assert.match(String(outputs.b.output), /^B-STEP[\s\S]*-OK$/);
    assert.equal(executor.steps.get('b')?.status, 'completed');
});
