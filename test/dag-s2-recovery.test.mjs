// @ts-check
/**
 * S2 recovery — the three DAG faults the audit confirmed, each driven through
 * the production paths (DEBUG-ANALYSIS C-1, C-2, C-3).
 *
 * C-1: a shared session group (`sessionScope: 'plan'` / `'branch'`) put two
 * members of one wave onto ONE session object, so the second run was refused by
 * the real in-flight guard. The fake session here carries that guard, which is
 * why the suite never saw it.
 * C-2: a step the planner drops keeps the output the run refused. A replan that
 * would leave a dependent reading it is refused (the rejected step re-runs and
 * its dependents follow the fresh evidence); when the drop is clean, the node
 * keeps no output and no longer satisfies anything.
 * C-3: `hasVerify` was recomputed from the live step on every save, so the
 * second checkpoint forgot the gate and the resumed step ran ungated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { assertNotInFlight } from '../lib/agentic/agentic-core.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {any} text @returns {string} */
function asText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? m))).join('\n');
    return JSON.stringify(text);
}

/**
 * A client whose sessions are real about one thing: a session refuses a second
 * run while one is in flight (`assertNotInFlight`, the guard `runAgenticLoop`
 * applies). Without it, C-1 is invisible.
 * @param {{answer?: (text: string, run: number) => string|Promise<string>, delayMs?: number}} [arg0]
 */
function makeClient({ answer = () => 'OUT', delayMs = 0 } = {}) {
    /** @type {any[]} */
    const sessions = [];
    /** @type {string[]} */
    const prompts = [];
    /** @type {{maxActive: number}} */
    const state = { maxActive: 0 };
    let active = 0;
    const client = {
        sessions,
        prompts,
        state,
        session(/** @type {string} */ model) {
            const s = /** @type {any} */ ({
                provider: 'openai',
                model,
                inputs: /** @type {any[]} */ ([]),
                runs: 0,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                /** @param {{initialInput: any}} arg0 */
                async run({ initialInput }) {
                    if (isObjectiveRestatePrompt({ input: initialInput })) return '';
                    assertNotInFlight({
                        flag: s._runInFlight,
                        label: 'This session already has a run in flight; concurrent runs on one session are not supported.',
                    });
                    const rows = Array.isArray(initialInput) ? initialInput : [initialInput];
                    const text = asText(rows.at(-1)?.content ?? initialInput);
                    prompts.push(text);
                    s._runInFlight = true;
                    s.runs += 1;
                    s.inputs.push(initialInput);
                    active += 1;
                    state.maxActive = Math.max(state.maxActive, active);
                    try {
                        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                        return await answer(text, s.runs);
                    } finally {
                        active -= 1;
                        s._runInFlight = false;
                    }
                },
            });
            sessions.push(s);
            return s;
        },
    };
    return client;
}

/**
 * @param {string} id
 * @param {string[]} [dependencies]
 * @param {Record<string, any>} [extra]
 * @returns {any}
 */
const step = (id, dependencies = [], extra = {}) => ({
    id,
    title: id,
    systemPrompt: 'Be terse.',
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
    ...extra,
});

// ─── C-1: one group, one run at a time ─────────────────────────────────────

test('a plan-scoped session survives a two-step parallel wave', async () => {
    const client = makeClient({
        answer: (text) => {
            if (text.includes('D-STEP')) return 'D-OUT';
            if (text.includes('C-STEP')) return 'C-OUT';
            if (text.includes('B-STEP')) return 'B-OUT';
            return 'A-OUT';
        },
        delayMs: 20,
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])] });

    const outputs = /** @type {any} */ (await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } }));

    assert.equal(outputs.a.output, 'A-OUT');
    assert.equal(outputs.b.output, 'B-OUT');
    assert.equal(outputs.c.output, 'C-OUT');
    assert.equal(outputs.d.output, 'D-OUT');
    assert.equal(client.sessions.length, 1, 'the plan stays one conversation');
    assert.equal(client.state.maxActive, 1, 'one group never has two runs in flight');
    assert.equal(/** @type {any} */ (executor)._sessionGroupChains.size, 0, 'the gate chain map does not grow per attempt');
});

test('a step-scoped plan keeps its parallel wave parallel', async () => {
    const client = makeClient({ delayMs: 20 });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('b'), step('c')] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(client.state.maxActive, 2, 'step scope is not serialized');
});

test('a step that times out while queued for its group never starts a run', async () => {
    // W2D-4: the gate is taken inside the attempt, which the deadline does not
    // cancel. A member queued behind a slow one used to start its model call after
    // its own deadline AND without its step signal (the timeout deletes it).
    /** @param {'plan'|'step'} scope */
    async function drive(scope) {
        const client = makeClient({
            answer: async (text) => {
                if (text.includes('A-STEP')) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    return 'A-OUT';
                }
                return 'B-OUT';
            },
        });
        const executor = new WorkflowExecutor({
            options: { client, defaultModel: 'm', sessionScope: scope, stepTimeoutMs: 80, maxConcurrency: 2 },
        });
        executor.setSteps({ stepsList: [step('a'), step('b')] });
        const startedAt = Date.now();
        /** @type {any} */
        let error = null;
        try {
            await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
        } catch (err) {
            error = err;
        }
        const elapsed = Date.now() - startedAt;
        // Let the aborted-but-uninterruptible `a` call finish: that is when a queued
        // attempt would get the gate.
        await new Promise((resolve) => setTimeout(resolve, 320));
        return {
            error,
            elapsed,
            bRuns: client.prompts.filter((p) => p.includes('B-STEP')).length,
            chains: /** @type {any} */ (executor)._sessionGroupChains.size,
        };
    }

    const gated = await drive('plan');
    assert.ok(gated.error, 'the deadline fails the wave');
    assert.match(String(gated.error?.message), /timed out after 80ms/);
    assert.equal(gated.bRuns, 0, 'the queued step never starts a model call after its deadline');
    assert.equal(gated.chains, 0, 'the refused attempt still releases its group');

    const isolated = await drive('step');
    assert.equal(isolated.bRuns, 1, 'the control: an isolated sibling starts immediately');
    // The gated path settles with the deadline, not with the stalled group.
    assert.ok(gated.elapsed <= isolated.elapsed + 100, `gated ${gated.elapsed}ms vs step-scope ${isolated.elapsed}ms`);
});

// ─── C-2: a rejected step is never evidence ────────────────────────────────

test('a replan that would feed the rejected step to its dependent is refused', async () => {
    let sRuns = 0;
    const client = makeClient({
        answer: (text) => {
            if (text.includes('D-STEP')) return 'D-OUT';
            sRuns += 1;
            return sRuns === 1 ? 'S-REJECTED-OUTPUT' : 'S-GOOD';
        },
    });
    const plan = [step('s'), step('d', ['s'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));

    let sVerdicts = 0;
    const outputs = /** @type {any} */ (await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        // The plausible LLM answer: drop the rejected step, leave the dependent
        // untouched (so its edge still names the dropped id).
        planner: { replan: async () => ({ steps: [plan[1]] }) },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => {
                if (node.id !== 's') return { replanRequired: false };
                sVerdicts += 1;
                return { replanRequired: sVerdicts === 1, reason: 'the output is wrong' };
            },
        },
    }));

    const refusal = patched.find((e) => e.rejected?.length > 0);
    assert.ok(refusal, 'the rewrite is refused, visibly');
    assert.equal(refusal.noop, true);
    assert.match(refusal.rejected[0].error, /'s'/);
    assert.match(refusal.rejected[0].error, /d→s/);
    assert.notEqual(executor.steps.get('s')?.historical, true, 'the working plan stays intact');
    assert.equal(sVerdicts, 2, 'the rejected step was re-run, not dropped');
    const dependentPrompts = client.prompts.filter((p) => p.includes('D-STEP'));
    assert.equal(dependentPrompts.length, 1, 'the dependent ran once');
    assert.equal(dependentPrompts[0].includes('S-REJECTED-OUTPUT'), false, 'the dependent never reads the rejected output');
    assert.match(dependentPrompts[0], /S-GOOD/, 'it reads the replacement the re-run produced');
    assert.match(refusal.rejected[0].error, /replaces:/, 'the refusal names the remedy');
    assert.equal(outputs.d.output, 'D-OUT');
});

test('a declared replacement rewires the rejected step dependents onto it', async () => {
    const client = makeClient({
        answer: (text) => {
            if (text.includes('D-STEP')) return 'D-OUT';
            if (text.includes('R-STEP')) return 'R-OUT';
            return 'S-REJECTED-OUTPUT';
        },
    });
    // The dependent names the rejected id in BOTH a step field and a template ref.
    const plan = [step('s'), step('d', ['s'], { userPromptTemplate: 'D-STEP {{s.output}}' })];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));

    let sVerdicts = 0;
    const outputs = /** @type {any} */ (await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [plan[1], step('r', [], { replaces: 's' })] }) },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => {
                if (node.id !== 's') return { replanRequired: false };
                sVerdicts += 1;
                return { replanRequired: sVerdicts === 1, reason: 'the output is wrong' };
            },
        },
    }));

    const applied = patched.find((e) => e.rewired?.length > 0);
    assert.ok(applied, 'the rewired patch is journaled');
    assert.deepEqual(applied.rewired, [{ from: 's', to: 'r', steps: ['d'] }]);
    assert.equal(applied.verdict, 'replan');
    assert.equal(applied.source, 'planner');
    assert.equal(applied.noop, undefined, 'the patch applied');
    assert.deepEqual(executor.steps.get('d')?.dependencies, ['r'], 'the live dependent names the replacement');
    assert.equal(executor.steps.get('s')?.rejected, true, 'the rejected step is dropped, not shipped');
    const dependentPrompt = client.prompts.filter((p) => p.includes('D-STEP')).at(-1) ?? '';
    assert.match(dependentPrompt, /R-OUT/, 'the template ref followed the rewire');
    assert.equal(dependentPrompt.includes('S-REJECTED-OUTPUT'), false, 'the dependent never reads the rejected output');
    assert.equal(outputs.d.output, 'D-OUT');
});

test('a declared replacement re-runs the dependent that already completed', async () => {
    let dRuns = 0;
    const client = makeClient({
        answer: (text) => {
            if (text.includes('D-STEP')) { dRuns += 1; return `D-OUT-${dRuns}`; }
            if (text.includes('R-STEP')) return 'R-OUT';
            return 'S-REJECTED-OUTPUT';
        },
    });
    const plan = [step('s'), step('d', ['s'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));

    // The evaluator is briefly down for `s`, so `d` completes on the rejected
    // output before the deferred verdict arrives and the replacement is installed.
    let sVerdicts = 0;
    const outputs = /** @type {any} */ (await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [plan[1], step('r', [], { replaces: 's' })] }) },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => {
                if (node.id !== 's') return { replanRequired: false };
                sVerdicts += 1;
                if (sVerdicts === 1) throw new Error('evaluator briefly down');
                return { replanRequired: sVerdicts === 2, reason: 'the output is wrong' };
            },
        },
    }));

    assert.ok(patched.some((e) => e.rewired?.length > 0), 'the rewired patch is journaled');
    assert.equal(dRuns, 2, 'the completed dependent was invalidated and re-ran');
    const lastDependentPrompt = client.prompts.filter((p) => p.includes('D-STEP')).at(-1) ?? '';
    assert.match(lastDependentPrompt, /R-OUT/, 'it re-ran against the replacement');
    assert.equal(lastDependentPrompt.includes('S-REJECTED-OUTPUT'), false);
    assert.equal(outputs.d.output, 'D-OUT-2', 'the stale dependent output is not the result');
});

test('a declared replacement rewires the dependents of a failed step', async () => {
    const client = makeClient({
        answer: (text) => {
            if (text.includes('SCAN-STEP')) throw new Error('scan boom');
            if (text.includes('R-STEP')) return 'R-OUT';
            if (text.includes('D-STEP')) return 'D-OUT';
            return 'A-OUT';
        },
    });
    const plan = [step('scan'), step('d', ['scan'], { userPromptTemplate: 'D-STEP {{scan.output}}' })];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    /** @type {string|undefined} */
    let dependentStatusAtPatch;
    executor.on('plan:patched', (/** @type {any} */ e) => {
        patched.push(e);
        if (e.rewired?.length) dependentStatusAtPatch = executor.steps.get('d')?.status;
    });

    const outputs = /** @type {any} */ (await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [plan[1], step('r', [], { replaces: 'scan' })] }) },
        evaluator: null,
    }));

    const rows = patched.filter((e) => e.rewired?.length > 0);
    assert.equal(rows.length, 1, 'exactly one rewired journal row');
    assert.deepEqual(rows[0].rewired, [{ from: 'scan', to: 'r', steps: ['d'] }]);
    assert.equal(dependentStatusAtPatch, 'pending', 'the dependent is queued again at install');
    assert.deepEqual(executor.steps.get('d')?.dependencies, ['r'], 'the live dependent names the replacement');
    assert.equal(executor.steps.get('scan')?.rejected, true, 'the failed step is dropped, not retried');
    assert.equal(executor.steps.get('r')?.status, 'completed', 'the replacement ran');
    const dependentPrompts = client.prompts.filter((p) => p.includes('D-STEP'));
    assert.equal(dependentPrompts.length, 1, 'the dependent ran once');
    assert.match(dependentPrompts[0], /R-OUT/, 'the template ref followed the rewire');
    assert.equal(dependentPrompts[0].includes('scan boom'), false, 'it never reads the failed output');
    assert.equal(outputs.d.output, 'D-OUT');
});

test('a malformed replaces on the failed path is a specific ConfigurationError', async () => {
    const client = makeClient({ answer: (text) => {
        if (text.includes('SCAN-STEP')) throw new Error('scan boom');
        return 'R-OUT';
    } });
    const plan = [step('scan'), step('d', ['scan'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any} */
    let error = null;
    try {
        await executor.execute({
            userGoal: 'goal',
            objectiveOptions: { adaptable: false },
            planner: { replan: async () => ({ steps: [plan[1], step('r', [], { replaces: 'ghost' })] }) },
            evaluator: null,
        });
    } catch (err) {
        error = err;
    }
    assert.ok(error instanceof ConfigurationError, `expected a ConfigurationError, got ${String(error)}`);
    assert.match(/** @type {Error} */ (error).message, /unknown step 'ghost'/);
    assert.doesNotMatch(/** @type {Error} */ (error).message, /dangling dependencies/);
    assert.equal(executor.steps.has('r'), false, 'no partial application');
});

test('two declared replacements on the failed path are refused', async () => {
    const client = makeClient({ answer: (text) => {
        if (text.includes('SCAN-STEP')) throw new Error('scan boom');
        return 'R-OUT';
    } });
    const plan = [step('scan'), step('d', ['scan'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    /** @type {any} */
    let error = null;
    try {
        await executor.execute({
            userGoal: 'goal',
            objectiveOptions: { adaptable: false },
            planner: { replan: async () => ({ steps: [plan[1], step('r1', [], { replaces: 'scan' }), step('r2', [], { replaces: 'scan' })] }) },
            evaluator: null,
        });
    } catch (err) {
        error = err;
    }
    assert.ok(error, 'the run cannot recover without a replacement');
    const refusal = patched.find((e) => e.noop === true);
    assert.ok(refusal, 'the ambiguous rewrite is refused, visibly');
    assert.match(refusal.rejected[0].error, /more than one replacement/);
    assert.equal(executor.steps.has('r1'), false, 'neither candidate is installed');
    assert.equal(executor.steps.has('r2'), false);
});

test('a replacement that keeps the rejected id as its own dependency is refused', async () => {
    const client = makeClient({ answer: (text) => {
        if (text.includes('SCAN-STEP')) throw new Error('scan boom');
        return 'R-OUT';
    } });
    const plan = [step('scan'), step('d', ['scan'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    /** @type {any} */
    let error = null;
    try {
        await executor.execute({
            userGoal: 'goal',
            objectiveOptions: { adaptable: false },
            planner: { replan: async () => ({ steps: [plan[1], step('r', ['scan'], { replaces: 'scan' })] }) },
            evaluator: null,
        });
    } catch (err) {
        error = err;
    }
    assert.ok(error, 'the run cannot install a cyclic replacement');
    const refusal = patched.find((e) => e.noop === true);
    assert.ok(refusal, 'the cyclic replacement is refused, visibly');
    assert.match(refusal.rejected[0].error, /invalid plan/);
    assert.equal(executor.steps.has('r'), false, 'the replacement is not installed');
    assert.notEqual(executor.steps.get('scan')?.rejected, true, 'the failed step is not marked rejected');
});

test('two declared replacements for one rejected step are refused', async () => {
    const client = makeClient({
        answer: (text) => (text.includes('D-STEP') ? 'D-OUT' : 'S-GOOD'),
    });
    const plan = [step('s'), step('d', ['s'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));

    let sVerdicts = 0;
    await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [plan[1], step('r1', [], { replaces: 's' }), step('r2', [], { replaces: ['s'] })] }) },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => {
                if (node.id !== 's') return { replanRequired: false };
                sVerdicts += 1;
                return { replanRequired: sVerdicts === 1, reason: 'the output is wrong' };
            },
        },
    });

    const refusal = patched.find((e) => e.noop === true);
    assert.ok(refusal, 'the ambiguous rewrite is refused, visibly');
    assert.match(refusal.rejected[0].error, /replaces:/, 'the refusal names the remedy');
    assert.notEqual(executor.steps.get('s')?.rejected, true, 'the working plan stays intact');
    assert.equal(executor.steps.has('r1'), false, 'neither candidate is installed');
    assert.equal(executor.steps.has('r2'), false);
});

for (const [label, replaces, pattern] of /** @type {Array<[string, string, RegExp]>} */ ([
    ['an unknown id', 'ghost', /unknown step 'ghost'/],
    ['itself', 'r', /its own id/],
    ['a completed step', 'a', /'a' is completed/],
])) {
    test(`a replacement naming ${label} is a rejected patch`, async () => {
        const client = makeClient({ answer: (text) => (text.includes('R-STEP') ? 'R-OUT' : 'S-OUT') });
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
        executor.setSteps({ stepsList: [step('a'), step('s', ['a']), step('d', ['s'])] });
        let sVerdicts = 0;
        /** @type {any} */
        let error = null;
        try {
            await executor.execute({
                userGoal: 'goal',
                objectiveOptions: { adaptable: false },
                planner: { replan: async () => ({ steps: [step('d', ['s']), step('r', [], { replaces })] }) },
                evaluator: {
                    evaluate: async (/** @type {any} */ { node }) => {
                        if (node.id !== 's') return { replanRequired: false };
                        sVerdicts += 1;
                        return { replanRequired: sVerdicts === 1, reason: 'the output is wrong' };
                    },
                },
            });
        } catch (err) {
            error = err;
        }
        assert.ok(error instanceof ConfigurationError, `expected a ConfigurationError, got ${String(error)}`);
        assert.match(/** @type {Error} */ (error).message, pattern);
        assert.match(/** @type {Error} */ (error).message, /replaces:/);
        assert.equal(executor.steps.has('r'), false, 'no partial application: the replacement is not installed');
        assert.notEqual(executor.steps.get('s')?.rejected, true, 'no partial application: the rejected step is untouched');
    });
}

test('a completed dependent of a rejected step is invalidated and re-runs', async () => {
    let sRuns = 0;
    let dRuns = 0;
    const client = makeClient({
        answer: (text) => {
            if (text.includes('D-STEP')) {
                dRuns += 1;
                return `D-OUT-${dRuns}`;
            }
            sRuns += 1;
            return sRuns === 1 ? 'S-REJECTED-OUTPUT' : 'S-GOOD';
        },
    });
    const plan = [step('s'), step('d', ['s'])];
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: plan });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));

    // The evaluator is briefly down for `s`, so `d` runs first — built on the
    // output the evaluator rejects a moment later (R2 of the analysis).
    let sVerdicts = 0;
    const outputs = /** @type {any} */ (await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [plan[1]] }) },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => {
                if (node.id !== 's') return { replanRequired: false };
                sVerdicts += 1;
                if (sVerdicts === 1) throw new Error('evaluator briefly down');
                return { replanRequired: sVerdicts === 2, reason: 'the output is wrong' };
            },
        },
    }));

    const refusal = patched.find((e) => e.rejected?.length > 0);
    assert.ok(refusal, 'the rewrite is refused, visibly');
    assert.match(refusal.rejected[0].error, /d→s/);
    assert.equal(dRuns, 2, 'the dependent was invalidated and re-ran');
    assert.equal(sRuns, 2, 'the rejected step re-ran');
    const lastDependentPrompt = client.prompts.filter((p) => p.includes('D-STEP')).at(-1) ?? '';
    assert.equal(lastDependentPrompt.includes('S-REJECTED-OUTPUT'), false, 'the shipped run reads the fresh output');
    assert.match(lastDependentPrompt, /S-GOOD/);
    assert.equal(outputs.d.output, 'D-OUT-2', 'the stale dependent output is not the result');
});

test('a dropped rejected step satisfies and feeds nothing', async () => {
    const client = makeClient({
        answer: (text) => (text.includes('X-STEP') ? 'X-OUT' : 'S-REJECTED-OUTPUT'),
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: [step('s'), step('x')] });

    const outputs = /** @type {any} */ (await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        // Nothing reads `s`, so dropping it is a clean edit and is applied.
        planner: { replan: async () => ({ steps: [step('x')] }) },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => (node.id === 's'
                ? { replanRequired: true, reason: 'the output is wrong' }
                : { replanRequired: false }),
        },
    }));

    const dropped = /** @type {any} */ (executor.steps.get('s'));
    assert.equal(dropped.historical, true, 'the dropped step is kept as history');
    assert.equal(dropped.output, null, 'its rejected output is gone');
    assert.equal(dropped.rejected, true, 'the dropped step is marked rejected');
    assert.equal(dropped.status, 'completed', 'the status is not rewritten: the mark is what makes it non-satisfying');
    assert.equal(executor.outputs.s, undefined, 'no output entry survives for it');
    assert.equal(outputs.s, undefined, 'nothing is returned for it');
    assert.equal(outputs.x.output, 'X-OUT', 'the rest of the plan still ships');

    // The mark is runtime state on the step record, so a checkpoint carries it and
    // a resume never treats the dropped step as a satisfier again. It is not part
    // of the definition fingerprint: the fingerprint was taken from the plan.
    const saved = /** @type {any} */ (JSON.parse(executor.save()).steps.find((/** @type {any} */ s) => s.id === 's'));
    assert.equal(saved.rejected, true, 'rejected rides the checkpoint');
    assert.equal(saved.output, null);
    assert.equal(saved._stepFingerprint, dropped._stepFingerprint, 'the mark does not change the definition hash');

    // Re-admitting the id is a new run of the step, not a resurrection.
    executor.setSteps({ stepsList: [step('s'), step('x')] });
    const readmitted = /** @type {any} */ (executor.steps.get('s'));
    assert.equal(readmitted.status, 'pending', 'a re-admitted historical id is pending');
    assert.equal(readmitted.output, null);
    assert.deepEqual(readmitted.messages, []);
    assert.equal(readmitted.rejected, undefined, 'the rejection mark is cleared');
});

/**
 * Drives a plan-evaluator patch against `[a, scan(a), d(scan)]` at the first wave
 * boundary, where `scan` is still pending, so the patch may remove it.
 * @param {Array<Record<string, any>>} ops
 */
async function driveEvaluatorPatch(ops) {
    const client = makeClient({
        answer: (text) => {
            if (text.includes('D-STEP')) return 'D-OUT';
            if (text.includes('R-STEP')) return 'R-OUT';
            return 'A-OUT';
        },
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a'), step('scan', ['a']), step('d', ['scan'], { userPromptTemplate: 'D-STEP {{scan.output}}' })] });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let calls = 0;
    executor.planEvaluator = {
        evaluate: async () => {
            calls += 1;
            return calls === 1
                ? { verdict: 'replan', reason: 'scan is redundant', patch: { ops } }
                : { verdict: 'continue' };
        },
    };
    /** @type {any} */
    let error = null;
    let outputs = null;
    try {
        outputs = await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false }, evaluator: null });
    } catch (err) {
        error = err;
    }
    return { executor, client, patched, error, outputs };
}

test('an evaluator patch may declare the replacement of the step it removes', async () => {
    const { executor, client, patched, error, outputs } = await driveEvaluatorPatch([
        { op: 'remove', id: 'scan' },
        { op: 'add', node: step('r', ['a'], { replaces: 'scan' }) },
    ]);
    assert.equal(error, null);
    const applied = patched.find((e) => e.rewired?.length > 0);
    assert.ok(applied, 'the rewired patch is journaled');
    assert.deepEqual(applied.rewired, [{ from: 'scan', to: 'r', steps: ['d'] }]);
    assert.equal(applied.verdict, 'replan');
    assert.deepEqual(executor.steps.get('d')?.dependencies, ['r'], 'the dependent names the replacement');
    assert.equal(executor.steps.get('d')?.userPromptTemplate, 'D-STEP {{r.output}}', 'the template ref followed the rewire');
    assert.equal(executor.steps.get('r')?.replaces, undefined, 'replaces is a directive, not an installed field');
    assert.equal(executor.steps.has('scan'), false, 'the removed step is gone');
    const dependentPrompt = client.prompts.filter((p) => p.includes('D-STEP')).at(-1) ?? '';
    assert.match(dependentPrompt, /R-OUT/, 'the dependent reads the replacement');
    assert.equal(/** @type {any} */ (outputs).d.output, 'D-OUT');
});

test('an evaluator patch may declare replaces on a replace op that omits node.id', async () => {
    // `replace` merges fields into the target step and may omit `node.id`; the
    // replacement's id is then the op's id. A declaration must resolve to it.
    const { executor, patched, error } = await driveEvaluatorPatch([
        { op: 'remove', id: 'scan' },
        { op: 'replace', id: 'a', node: { replaces: 'scan' } },
    ]);
    assert.equal(error, null);
    const applied = patched.find((e) => e.rewired?.length > 0);
    assert.ok(applied, 'the rewired patch is journaled');
    assert.deepEqual(applied.rewired, [{ from: 'scan', to: 'a', steps: ['d'] }]);
    assert.deepEqual(executor.steps.get('d')?.dependencies, ['a'], 'the dependent names the replacement');
    assert.equal(executor.steps.get('a')?.replaces, undefined, 'replaces is a directive, not an installed field');
    assert.equal(executor.steps.has('scan'), false, 'the removed step is gone');
});

test('an evaluator patch that drops a named step without a declaration is still refused', async () => {
    const { executor, patched } = await driveEvaluatorPatch([
        { op: 'remove', id: 'scan' },
        { op: 'add', node: step('r', ['a']) },
    ]);
    const refusal = patched.find((e) => e.noop === true);
    assert.ok(refusal, 'the dangling patch is refused, visibly');
    assert.match(refusal.rejected[0].error, /dangling dependencies/);
    assert.match(refusal.rejected[0].error, /d→scan/);
    assert.equal(executor.steps.has('r'), false, 'nothing is installed');
    assert.ok(executor.steps.has('scan'), 'the removed step stays');
});

test('two evaluator-patch replacements for one removed step are refused', async () => {
    const { executor, patched } = await driveEvaluatorPatch([
        { op: 'remove', id: 'scan' },
        { op: 'add', node: step('r1', ['a'], { replaces: 'scan' }) },
        { op: 'add', node: step('r2', ['a'], { replaces: 'scan' }) },
    ]);
    const refusal = patched.find((e) => e.noop === true);
    assert.ok(refusal, 'the ambiguous patch is refused, visibly');
    assert.match(refusal.rejected[0].error, /more than one replacement/);
    assert.equal(executor.steps.has('r1'), false, 'neither candidate is installed');
    assert.equal(executor.steps.has('r2'), false);
    assert.ok(executor.steps.has('scan'), 'the working plan stays intact');
});

test('an evaluator patch that names a step it does not remove is refused', async () => {
    const { executor, patched } = await driveEvaluatorPatch([
        { op: 'remove', id: 'scan' },
        { op: 'add', node: step('r', ['a'], { replaces: 'a' }) },
    ]);
    const refusal = patched.find((e) => e.noop === true);
    assert.ok(refusal, 'the stray declaration is refused, visibly');
    assert.match(refusal.rejected[0].error, /does not remove 'a'/);
    assert.equal(executor.steps.has('r'), false, 'nothing is installed');
    assert.ok(executor.steps.has('scan'));
});

// ─── C-3: a gate the checkpoint could not carry fails closed ────────────────

test('a restored step whose verify gate vanished fails closed', async () => {
    let bRuns = 0;
    const client = makeClient({
        answer: (text) => {
            if (text.includes('B-STEP')) bRuns += 1;
            return 'B-BAD';
        },
    });
    const gated = () => ({ passed: false, evidence: 'the answer is BAD' });

    const build = () => {
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [step('a'), step('b', ['a'], { verify: gated })] });
        return executor;
    };

    // hop 0: the snapshot is taken while `b` is still running; JSON cannot carry
    // the function, so the record says the gate existed.
    const hop0 = JSON.parse(build().save());
    assert.equal(hop0.steps[1].hasVerify, true, 'a live gate is marked in the snapshot');
    hop0.steps[1].status = 'running';

    // hop 1: restored without re-supplying the plan, then checkpointed again.
    const hop1 = WorkflowExecutor.load({ json: JSON.stringify(hop0), options: { client, defaultModel: 'm' } });
    const hop1Saved = JSON.parse(hop1.save());
    assert.equal(hop1Saved.steps[1].status, 'pending', 'a running step is re-queued by the restore');
    assert.equal(hop1Saved.steps[1].hasVerify, true, 'the gate marker is sticky across a checkpoint');
    assert.equal(hop1Saved.steps[1].verify, undefined, 'the function itself cannot travel');

    // hop 2: the step is due and its gate is gone.
    const hop2 = WorkflowExecutor.load({ json: JSON.stringify(hop1Saved), options: { client, defaultModel: 'm' } });
    /** @type {any} */
    let shipped = null;
    /** @type {any} */
    let error = null;
    try {
        shipped = await hop2.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    } catch (err) {
        error = err;
    }
    assert.equal(shipped, null, `a step whose gate vanished must not ship: ${JSON.stringify(shipped?.b)}`);
    assert.ok(error instanceof ConfigurationError, `expected a ConfigurationError, got ${String(error)}`);
    assert.match(/** @type {Error} */ (error).message, /'b'/);
    assert.match(/** @type {Error} */ (error).message, /verify gate/);
    assert.equal(bRuns, 0, 'the ungated step never ran');

    // The documented escape hatch runs the plan ungated on purpose.
    const optOut = WorkflowExecutor.load({
        json: JSON.stringify(hop1Saved),
        options: { client, defaultModel: 'm', allowLostStepFunctions: true },
    });
    const out = /** @type {any} */ (await optOut.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } }));
    assert.equal(out.b.output, 'B-BAD', 'the opt-out is explicit: the run continues ungated');
});
