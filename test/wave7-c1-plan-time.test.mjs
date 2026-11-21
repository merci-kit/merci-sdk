// @ts-check

/**
 * Wave 7 / C1 (closing slice) — a template reference to a non-ancestor is a plan-time
 * error.
 *
 * C1 already bounded the *intake* to ancestors: a step never absorbs a sibling's
 * output. A `{{sibling.output}}` in the prompt was the remaining hole — it passed the
 * existence check and rendered `[UNRESOLVED: …]` mid-run. The rule is now enforced
 * where the plan is installed, and again for a rewrite, a patch and a restore.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { Plan } from '../lib/agentic/planning/plan.mjs';

/** @param {string} id @param {string[]} [dependencies] @param {Record<string, any>} [extra] */
const step = (id, dependencies = [], extra = {}) => ({
    id,
    title: id,
    systemPrompt: 'Be terse.',
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
    ...extra,
});

/** @param {Record<string, any>} [options] */
function makeExecutor(options = {}) {
    const client = {
        getProfiles: async () => [{ id: 'm' }],
        session: () => {
            const s = /** @type {any} */ ({
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withPromptCache() { return s; },
                run: async () => 'OUT',
            });
            return s;
        },
    };
    return new WorkflowExecutor({ options: { client, defaultModel: 'm', ...options } });
}

test('C1p/sibling: a reference to a step that is not an ancestor is rejected when the plan is installed', () => {
    const executor = makeExecutor();
    assert.throws(
        () => executor.setSteps({ stepsList: [
            step('a'),
            step('x'),
            step('b', ['a'], { userPromptTemplate: 'use {{x.output}}' }),
        ] }),
        /Plan rejected: Template reference\(s\) to a non-ancestor: '\{\{x\.output\}\}' in step 'b'.*add the dependency/s
    );
    assert.equal(executor.steps.size, 0, 'nothing was installed');
    assert.deepEqual(executor.outputs, {});
});

test('C1p/self: a step that reads its own output is a non-ancestor too', () => {
    const executor = makeExecutor();
    assert.throws(
        () => executor.setSteps({ stepsList: [step('a', [], { userPromptTemplate: 'again {{a.output}}' })] }),
        /non-ancestor: '\{\{a\.output\}\}' in step 'a'/
    );
});

test('C1p/ancestors: a direct and a transitive ancestor still resolve', () => {
    const executor = makeExecutor();
    assert.doesNotThrow(() => executor.setSteps({ stepsList: [
        step('a'),
        step('b', ['a'], { userPromptTemplate: 'use {{a.output}}' }),
        step('c', ['b'], { userPromptTemplate: 'use {{a.output}} and {{b.output}}' }),
    ] }));
    assert.deepEqual([...executor.steps.keys()], ['a', 'b', 'c']);
});

test('C1p/context: a context root is not a step, so the ancestry rule leaves it alone', async () => {
    /** @type {string[]} */
    const seen = [];
    const executor = makeExecutor();
    executor.on('workflow:step_start', () => {});
    // A custom root is only known once the run supplies context; the plan-time check
    // must not guess it is a missing step.
    assert.doesNotThrow(() => executor.setSteps({ stepsList: [
        step('a', [], { userPromptTemplate: 'hit {{context.topic}}' }),
        step('b', ['a'], { userPromptTemplate: 'hit {{endpoint}} and {{a.output}}' }),
    ] }));
    const outputs = /** @type {any} */ (await executor.execute({ userGoal: 'goal', context: { topic: 'T', endpoint: 'E' } }));
    assert.deepEqual(Object.keys(outputs).sort(), ['a', 'b'], 'both steps ran with their context roots');
    assert.equal(executor.steps.get('b')?.status, 'completed');
});

test('C1p/rewrite: a replan that drops the dependency while the prompt still reads it is rejected', () => {
    const executor = makeExecutor();
    executor.setSteps({ stepsList: [
        step('a'),
        step('b', ['a'], { userPromptTemplate: 'use {{a.output}}' }),
    ] });
    assert.throws(
        () => executor.setSteps({ stepsList: [
            step('a'),
            step('b', [], { userPromptTemplate: 'use {{a.output}}' }),
        ] }),
        /Plan rejected: .*non-ancestor.*\{\{a\.output\}\}.*step 'b'/
    );
    assert.deepEqual(executor.steps.get('b')?.dependencies, ['a'], 'the working plan is untouched');
});

test('C1p/patch: a plan patch that reads a non-ancestor is rejected and journaled', async () => {
    const executor = makeExecutor();
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const patched = [];
    executor.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let n = 0;
    executor.planEvaluator = {
        evaluate: async () => {
            n += 1;
            return n === 1
                ? { verdict: 'replan', reason: 'peek', patch: { ops: [{ op: 'add', node: step('c', ['a'], { userPromptTemplate: 'use {{b.output}}' }) }] } }
                : { verdict: 'continue' };
        },
    };
    await executor.execute({ userGoal: 'goal' });
    assert.equal(patched[0]?.noop, true);
    assert.match(patched[0].rejected[0].error, /non-ancestor/);
    assert.equal(executor.steps.has('c'), false);
    assert.equal(executor.steps.get('b')?.status, 'completed', 'the run still finished');
});

test('C1p/history: a completed ancestor that became history still counts', () => {
    const executor = makeExecutor({ maxReplanCount: 2 });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'], { userPromptTemplate: 'use {{a.output}}' })] });
    const a = /** @type {any} */ (executor.steps.get('a'));
    a.status = 'completed';
    a.output = 'A-OUT';
    executor.outputs.a = { output: 'A-OUT', data: 'A-OUT' };
    // Drop `a` from the list: it becomes history, `b` still depends on it and reads it.
    assert.doesNotThrow(() => executor.setSteps({ stepsList: [step('b', ['a'], { userPromptTemplate: 'use {{a.output}}' })] }));
    assert.equal(executor.steps.get('a')?.historical, true);
});

test('C1p/patch-history: a replan that strands a dependent is refused, and the patch still lands', async () => {
    // This test used to drop the completed `b` while `c` kept depending on it, which
    // is the C-2 bug: a rejected step is not evidence for a dependent. The rewrite is
    // now refused (the rejected step re-runs), and the later patch still has to pass
    // the ancestry check over the live graph.
    const executor = makeExecutor({ maxReplanCount: 2 });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['b'])] });
    /** @type {any[]} */
    const journal = [];
    executor.on('plan:patched', (/** @type {any} */ e) => journal.push(e));
    let patched = false;
    let stepVerdicts = 0;
    executor.planEvaluator = {
        evaluate: async (/** @type {any} */ { progress }) => {
            // After `c`, so the per-step replan of `b` has already rewritten the plan.
            if (patched || !progress.completed.some((/** @type {any} */ c) => c.id === 'c')) return { verdict: 'continue' };
            patched = true;
            return { verdict: 'replan', reason: 'audit', patch: { ops: [{ op: 'add', node: step('d', ['c'], { userPromptTemplate: 'check {{a.output}}' }) }] } };
        },
    };
    await executor.execute({
        userGoal: 'goal',
        planner: { replan: async () => ({ steps: [step('a'), step('c', ['b'])] }) },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => {
            if (node.id !== 'b') return { replanRequired: false };
            stepVerdicts += 1;
            return { replanRequired: stepVerdicts === 1, reason: 'weak' };
        } },
    });
    assert.notEqual(executor.steps.get('b')?.historical, true, 'the working plan keeps the rejected step');
    const refusal = journal.find((e) => e.rejected?.length > 0);
    assert.ok(refusal, 'the stranding rewrite is refused, visibly');
    assert.match(refusal.rejected[0].error, /c→b/);
    const applied = journal.find((e) => e.applied?.length > 0);
    assert.ok(applied, 'the ancestry check follows the run graph');
    assert.deepEqual(applied.applied.map((/** @type {any} */ o) => o.op), ['add']);
    assert.ok('d' in executor.outputs, 'the added node ran');
});

test('C1p/patch-history-accepted: a patch may read an ancestor reachable only through accepted history', async () => {
    // W2D-8: the refusal above covers a *rejected* drop. History the run accepted (a
    // `setSteps` drop, as `C1p/history` uses) is still evidence: `d` reaches `a` only
    // through `c → b(history) → a`, so this patch is applied for that reason.
    const executor = makeExecutor({ maxReplanCount: 2 });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['b'])] });
    for (const id of ['a', 'b', 'c']) {
        const node = /** @type {any} */ (executor.steps.get(id));
        node.status = 'completed';
        node.output = `${id.toUpperCase()}-OUT`;
        executor.outputs[id] = { output: node.output, data: node.output };
    }
    // The drop is not a rejected replan, so `b` keeps satisfying `c` and the
    // ancestry graph keeps the b → a edge alive.
    executor.setSteps({ stepsList: [step('a'), step('c', ['b'])] });
    assert.equal(executor.steps.get('b')?.historical, true, 'b is history');
    assert.notEqual(executor.steps.get('b')?.rejected, true, 'accepted history, not a rejected step');

    /** @type {any[]} */
    const journal = [];
    executor.on('plan:patched', (/** @type {any} */ e) => journal.push(e));
    let patched = false;
    executor.planEvaluator = {
        evaluate: async (/** @type {any} */ { progress }) => {
            if (patched || !progress.completed.some((/** @type {any} */ c) => c.id === 'c')) return { verdict: 'continue' };
            patched = true;
            return { verdict: 'replan', reason: 'audit', patch: { ops: [{ op: 'add', node: step('d', ['c'], { userPromptTemplate: 'check {{a.output}}' }) }] } };
        },
    };
    await executor.execute({ userGoal: 'goal' });
    const applied = journal.find((e) => e.applied?.length > 0);
    assert.ok(applied, 'the ancestry check follows accepted history: d → c → b(history) → a');
    assert.deepEqual(applied.applied.map((/** @type {any} */ o) => o.op), ['add']);
    assert.ok('d' in executor.outputs, 'the added node ran');
});

test('C1p/projection: the Plan projection is unchanged by the rule', () => {
    const plan = Plan.fromDag({ steps: [step('a'), step('b', ['a'])] });
    assert.equal(plan.nodes.length, 2);
});

test('C1p/repair-patch: a patch that adds the missing dependency is applied, not rejected', async () => {
    const executor = makeExecutor();
    // `b` reads `a` but does not depend on it yet: the plan is rejected as installed,
    // so start from a valid plan and repair it with a patch that adds the dependency.
    executor.setSteps({ stepsList: [step('a'), step('b', [], { userPromptTemplate: 'wait' })] });
    /** @type {any[]} */
    const journal = [];
    executor.on('plan:patched', (/** @type {any} */ e) => journal.push(e));
    let patched = false;
    executor.planEvaluator = {
        evaluate: async () => {
            if (patched) return { verdict: 'continue' };
            patched = true;
            return {
                verdict: 'replan',
                reason: 'b needs a',
                patch: { ops: [{ op: 'replace', id: 'b', node: { dependencies: ['a'], userPromptTemplate: 'use {{a.output}}' } }] },
            };
        },
    };
    await executor.execute({ userGoal: 'goal' });
    const applied = journal.find((e) => e.applied?.length > 0);
    assert.ok(applied, 'the edit was applied: the same patch supplies the dependency and the reference');
    assert.equal(executor.steps.get('b')?.status, 'completed');
});

test('C1p/drop-dep: a patch that drops the dependency while the prompt still reads it is a journaled no-op', async () => {
    const executor = makeExecutor();
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'], { userPromptTemplate: 'use {{a.output}}' })] });
    /** @type {any[]} */
    const journal = [];
    executor.on('plan:patched', (/** @type {any} */ e) => journal.push(e));
    let patched = false;
    executor.planEvaluator = {
        evaluate: async () => {
            if (patched) return { verdict: 'continue' };
            patched = true;
            return { verdict: 'replan', reason: 'decouple', patch: { ops: [{ op: 'rewire', id: 'b', dependsOn: [] }] } };
        },
    };
    await executor.execute({ userGoal: 'goal' });
    assert.equal(journal[0]?.noop, true);
    assert.match(String(journal[0]?.rejected?.[0]?.error), /non-ancestor/);
    assert.deepEqual(executor.steps.get('b')?.dependencies, ['a'], 'the working plan is intact');
    assert.equal(executor.steps.get('b')?.status, 'completed');
});

test('C1p/rewrite-history: a rewrite that drops a completed ancestor while the prompt still reads it is rejected', () => {
    const executor = makeExecutor();
    executor.setSteps({ stepsList: [step('x'), step('b', ['x'], { userPromptTemplate: 'use {{x.output}}' })] });
    const x = /** @type {any} */ (executor.steps.get('x'));
    x.status = 'completed';
    x.output = 'X-OUT';
    executor.outputs.x = { output: 'X-OUT', data: 'X-OUT' };
    // `x` is dropped from the list (it survives as history) and `b` no longer depends on it.
    assert.throws(
        () => executor.setSteps({ stepsList: [step('b', [], { userPromptTemplate: 'use {{x.output}}' })] }),
        /Plan rejected: .*non-ancestor.*\{\{x\.output\}\}.*step 'b'/
    );
    assert.deepEqual(executor.steps.get('b')?.dependencies, ['x'], 'the working plan is intact');
});
