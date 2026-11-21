// @ts-check

/**
 * Wave 7 / C5 + C6 — the checkpoint contract.
 *
 * C5: nothing in the library saves a workflow checkpoint automatically, the
 * snapshot is whole-step, and a plain `execute()` on an already-run instance is a
 * fresh run (steps reset, outputs cleared) — resume is a different path. The
 * contract must be stated and pinned so it cannot drift.
 *
 * C6: a checkpoint carrying a failed step aborts before scheduling, so a
 * load-then-execute dead-ends unless the operator can retry those steps. These
 * checks pin the abort (documented behaviour) and the escape hatch
 * (`retryFailedSteps()`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {any} text @returns {string} */
function asText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
    return JSON.stringify(text);
}

/**
 * A client that counts runs per step marker and answers by marker.
 * @param {{runImpl: (text: string) => Promise<any>}} arg0
 * @returns {any}
 */
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

/** @param {Record<string, number>} counts @param {string} id */
const bump = (counts, id) => { counts[id] = (counts[id] ?? 0) + 1; };

/**
 * Run a→b where b fails once (the first execution), leaving a completed and b
 * failed; returns the checkpoint and the counters.
 * @param {{failFirstB?: boolean}} [arg0]
 */
async function runAndSave({ failFirstB = true } = {}) {
    /** @type {Record<string, number>} */
    const counts = {};
    let bFailures = 0;
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        if (text.includes('B-STEP')) {
            bump(counts, 'b');
            if (failFirstB && bFailures === 0) { bFailures += 1; throw new Error('b exploded'); }
            return 'B-OUT';
        }
        return 'unknown';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any} */
    let error = null;
    try { await executor.execute({ userGoal: 'goal' }); } catch (err) { error = err; }
    return { executor, counts, error, checkpoint: executor.save(), client };
}

// ─── C5: what a resume does ────────────────────────────────────────────────

test('W7C56/resume-skips-completed: a resumed run does not re-run completed steps', async () => {
    const first = await runAndSave();
    assert.equal(first.error?.name, 'OrchestrationFailedError');
    assert.deepEqual(first.counts, { a: 1, b: 1 }, 'a completed, b failed once');

    /** @type {Record<string, number>} */
    const counts = {};
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        if (text.includes('B-STEP')) { bump(counts, 'b'); return 'B-OUT'; }
        return 'unknown';
    } });
    const resumed = WorkflowExecutor.load({ json: first.checkpoint, options: { client, defaultModel: 'm' } });
    assert.deepEqual(resumed.retryFailedSteps(), ['b'], 'the failed step is offered for retry');
    /** @type {any} */
    const outputs = await resumed.execute({ userGoal: 'goal' });
    assert.equal(counts.a, undefined, 'the completed step was NOT re-run');
    assert.equal(counts.b, 1, 'the failed step was retried once');
    assert.equal(outputs.a.output, 'A-OUT', 'the completed output came from the checkpoint');
    assert.equal(outputs.b.output, 'B-OUT');
});

test('W7C56/running-step-reruns: a step interrupted mid-run is pending again, not lost', { timeout: 15000 }, async () => {
    /** @type {Record<string, number>} */
    const counts = {};
    /** @type {any} */
    let executorRef = null;
    /** @type {string|null} */
    let midRunCheckpoint = null;
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) {
            bump(counts, 'a');
            if (!midRunCheckpoint) midRunCheckpoint = executorRef.save(); // a is `running` here
            return 'A-OUT';
        }
        if (text.includes('B-STEP')) { bump(counts, 'b'); return 'B-OUT'; }
        return 'unknown';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executorRef = executor;
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    await executor.execute({ userGoal: 'goal' });
    assert.ok(midRunCheckpoint, 'captured a checkpoint while a was running');

    /** @type {Record<string, number>} */
    const counts2 = {};
    const client2 = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts2, 'a'); return 'A-OUT'; }
        if (text.includes('B-STEP')) { bump(counts2, 'b'); return 'B-OUT'; }
        return 'unknown';
    } });
    const resumed = WorkflowExecutor.load({ json: /** @type {string} */ (midRunCheckpoint), options: { client: client2, defaultModel: 'm' } });
    await resumed.execute({ userGoal: 'goal' });
    assert.equal(counts2.a, 1, 'the interrupted step runs again (at-least-once)');
    assert.equal(counts2.b, 1, 'the pending step runs');
});

test('W7C56/journal-travels: the execution journal is part of the checkpoint', async () => {
    const journal = new ExecutionJournal();
    journal.begin({ key: 'tool:a', meta: { kind: 'tool' } });
    journal.complete({ key: 'tool:a', outcome: 'cached' });
    /** @type {Record<string, number>} */
    const counts = {};
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        return 'unknown';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', journal } });
    executor.setSteps({ stepsList: [step('a')] });
    await executor.execute({ userGoal: 'goal' });
    const json = executor.save();
    assert.match(json, /journal/, 'the checkpoint carries the journal');
    const restored = WorkflowExecutor.load({ json, options: { client, defaultModel: 'm' } });
    assert.ok(restored._journal, 'the journal is restored');
    assert.match(JSON.stringify(restored._journal.toJSON()), /tool:a/, 'with its recorded call');
});

// ─── C5: a plain re-execute is NOT a resume ────────────────────────────────

test('W7C56/plain-reexecute-reruns: calling execute() again on the same instance re-runs every step', async () => {
    /** @type {Record<string, number>} */
    const counts = {};
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        return 'unknown';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a')] });
    await executor.execute({ userGoal: 'goal' });
    await executor.execute({ userGoal: 'goal' });
    assert.equal(counts.a, 2, 'a fresh execute resets and re-runs — resume needs a checkpoint');
});

// ─── C6: a failed checkpoint and the retry escape hatch ────────────────────

test('W7C56/failed-checkpoint-aborts: an unresumed checkpoint with a failed step stops before scheduling', async () => {
    const first = await runAndSave();
    /** @type {Record<string, number>} */
    const counts = {};
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        if (text.includes('B-STEP')) { bump(counts, 'b'); return 'B-OUT'; }
        return 'unknown';
    } });
    const resumed = WorkflowExecutor.load({ json: first.checkpoint, options: { client, defaultModel: 'm' } });
    /** @type {any} */
    let error = null;
    try { await resumed.execute({ userGoal: 'goal' }); } catch (err) { error = err; }
    assert.equal(error?.name, 'OrchestrationFailedError');
    assert.match(String(error?.message), /b/, 'the restored failure is named');
    assert.deepEqual(counts, {}, 'nothing ran — the checkpoint carries the failure');
});

test('W7C56/retry-failed-steps: the escape hatch resets the failed step and clears its output', async () => {
    const first = await runAndSave();
    const resumed = WorkflowExecutor.load({ json: first.checkpoint, options: { client: first.client, defaultModel: 'm' } });
    const ids = resumed.retryFailedSteps();
    assert.deepEqual(ids, ['b']);
    assert.equal(resumed.steps.get('b')?.status, 'pending');
    assert.equal(resumed.outputs.b, undefined, 'the failed output is cleared');
    assert.equal(resumed.steps.get('a')?.status, 'completed', 'a completed step is untouched');
    assert.deepEqual(resumed.retryFailedSteps(), [], 'nothing left to retry');
});

test('W7C56/retry-keeps-resume: aborting before scheduling leaves the checkpoint resumable', async () => {
    const first = await runAndSave();
    /** @type {Record<string, number>} */
    const counts = {};
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        if (text.includes('B-STEP')) { bump(counts, 'b'); return 'B-OUT'; }
        return 'unknown';
    } });
    const resumed = WorkflowExecutor.load({ json: first.checkpoint, options: { client, defaultModel: 'm' } });
    /** @type {any} */
    let error = null;
    try { await resumed.execute({ userGoal: 'goal' }); } catch (err) { error = err; }
    assert.equal(error?.name, 'OrchestrationFailedError');
    // The abort happened before scheduling; the instance must still be resuming.
    resumed.retryFailedSteps();
    await resumed.execute({ userGoal: 'goal' });
    assert.equal(counts.a, undefined, 'the abort did not consume the resume flag — a is not re-run');
    assert.equal(counts.b, 1);
});

test('W7C56/lost-verify-gate: a restored step whose verify callback is gone fails closed, and setSteps() re-attaches it', async () => {
    // The stripped branch used to prove that the step re-ran **unverified** after a
    // warning — the C-3 bug: the gate vanished and the output shipped. The rule now:
    // the resume is refused by name, and the ungated run happens only through the
    // documented `allowLostStepFunctions` opt-out.
    /** @type {Record<string, number>} */
    const counts = {};
    const gate = () => /** @type {any} */ ({ passed: false, evidence: 'gate says no' });
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) { bump(counts, 'a'); return 'A-OUT'; }
        return 'unknown';
    } });
    const failing = { ...step('a'), verify: gate, maxRetries: 0 };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [failing] });
    /** @type {any} */
    let firstError = null;
    try { await executor.execute({ userGoal: 'goal' }); } catch (err) { firstError = err; }
    assert.match(String(firstError?.message), /failed verification/, 'the gate rejects the step');
    assert.equal(counts.a, 1);
    const checkpoint = executor.save();

    // Restored without re-supplying the function: the gate is gone (the marker says so).
    const stripped = WorkflowExecutor.load({ json: checkpoint, options: { client, defaultModel: 'm' } });
    assert.equal(stripped.steps.get('a')?.verify, undefined, 'functions do not serialize');
    assert.equal(/** @type {any} */ (stripped.steps.get('a')).hasVerify, true, 'the loss is recorded');
    /** @type {Array<any>} */
    const warnings = [];
    stripped.on('workflow:restore_warning', (evt) => warnings.push(evt));
    stripped.retryFailedSteps();
    /** @type {any} */
    let gateError = null;
    try { await stripped.execute({ userGoal: 'goal' }); } catch (err) { gateError = err; }
    assert.ok(gateError instanceof ConfigurationError, 'the resume refuses to run an ungated step');
    assert.match(String(gateError.message), /'a'/);
    assert.match(String(gateError.message), /verify gate/);
    assert.equal(warnings.length, 1, 'the resume warns that the gate was dropped');
    assert.equal(warnings[0]?.stepId, 'a');
    assert.deepEqual(warnings[0]?.lost, ['verify gate']);
    assert.equal(counts.a, 1, 'the refused resume ran no model call');

    // The documented opt-out: run the plan ungated, knowingly.
    const optedOut = WorkflowExecutor.load({ json: checkpoint, options: { client, defaultModel: 'm', allowLostStepFunctions: true } });
    optedOut.retryFailedSteps();
    await optedOut.execute({ userGoal: 'goal' });
    assert.equal(counts.a, 2, 'the opt-out re-ran the step and it completed unverified');

    // The documented fix: re-supply the same plan before resuming.
    const reattached = WorkflowExecutor.load({ json: checkpoint, options: { client, defaultModel: 'm' } });
    reattached.setSteps({ stepsList: [failing] });
    assert.equal(typeof reattached.steps.get('a')?.verify, 'function');
    assert.equal(/** @type {any} */ (reattached.steps.get('a')).hasVerify, undefined, 'the marker is cleared by the re-attachment');
    assert.equal(reattached.steps.get('a')?.status, 'failed', 'the restored status survives re-supply');
    reattached.retryFailedSteps();
    /** @type {any} */
    let again = null;
    try { await reattached.execute({ userGoal: 'goal' }); } catch (err) { again = err; }
    assert.match(String(again?.message), /failed verification/, 'the re-attached gate is enforced');
});

test('W7C56/step-signal-not-serialized: a live AbortSignal never enters the checkpoint', async () => {
    /** @type {any} */
    let executorRef = null;
    /** @type {string|null} */
    let midRun = null;
    const client = makeClient({ runImpl: async (text) => {
        if (text.includes('A-STEP')) {
            midRun = executorRef.save();
            return 'A-OUT';
        }
        return 'unknown';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', stepTimeoutMs: 5000 } });
    executorRef = executor;
    executor.setSteps({ stepsList: [step('a')] });
    await executor.execute({ userGoal: 'goal' });
    assert.ok(midRun);
    const parsed = JSON.parse(/** @type {string} */ (midRun));
    assert.equal(parsed.steps.some((/** @type {any} */ s) => Object.hasOwn(s, '_stepSignal')), false, 'no signal object in the JSON');
    const restored = WorkflowExecutor.load({ json: /** @type {string} */ (midRun), options: { client, defaultModel: 'm', stepTimeoutMs: 5000 } });
    assert.equal(/** @type {any} */ (restored.steps.get('a'))._stepSignal, undefined, 'no dead signal on the restored node');
});
