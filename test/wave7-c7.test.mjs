// @ts-check

/**
 * Wave 7 / C7 — a dangling dependency is a plan error, not a deadlock.
 *
 * Before this slice `setSteps` accepted `a → missing`, and the scheduler only failed
 * once the graph reached the node — after other branches had already run and spent
 * tokens. The runtime deadlock stays as a backstop for a checkpoint restored without
 * validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';

/** @param {string} id @param {string[]} [dependencies] */
const step = (id, dependencies = []) => ({
    id,
    title: id,
    systemPrompt: 'Be terse.',
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
});

test('C7/plan-time: a dangling dependency is rejected by setSteps, before any run', async () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    assert.throws(
        () => executor.setSteps({ stepsList: [step('a'), step('b', ['a', 'ghost'])] }),
        /Plan rejected: dangling dependencies .*b→ghost/
    );
    assert.equal(executor.steps.size, 0, 'nothing was installed');
    assert.deepEqual(executor.outputs, {});
});

test('C7/no-partial-mutation: a rejected rewrite leaves the working plan intact', () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a')] });
    assert.throws(() => executor.setSteps({ stepsList: [step('a'), step('b', ['nope'])] }), /Plan rewrite rejected/);
    assert.deepEqual([...executor.steps.keys()], ['a'], 'the previous plan is untouched');
});

test('C7/replan: a dependency on a retained completed step is still allowed', () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a')] });
    const a = /** @type {any} */ (executor.steps.get('a'));
    a.status = 'completed';
    a.output = 'A-OUT';
    executor.outputs.a = { output: 'A-OUT', data: 'A-OUT' };
    // The rewrite omits a (it becomes historical) and a new step depends on it.
    assert.doesNotThrow(() => executor.setSteps({ stepsList: [step('c', ['a'])] }));
    assert.equal(executor.steps.get('a')?.historical, true);
    assert.deepEqual(executor.steps.get('c')?.dependencies, ['a']);
});

test('C7/replan: a dependency on a dropped pending step is rejected', () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    // b is pending; the rewrite drops it but the new step still depends on it.
    assert.throws(() => executor.setSteps({ stepsList: [step('c', ['b'])] }), /Plan rewrite rejected: .*c→b/);
});

test('C7/cycles stay a plan-time error', () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    assert.throws(() => executor.setSteps({ stepsList: [step('a', ['b']), step('b', ['a'])] }), /Invalid DAG plan/);
});

test('C7/self-dependency is rejected', () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    assert.throws(() => executor.setSteps({ stepsList: [step('a', ['a'])] }), /Invalid DAG plan/);
});

test('C7/backstop: a checkpoint restored with a dangling edge still fails at run time, named', async () => {
    const client = { session: () => ({ provider: 'openai', withSystemMessage() { return this; }, withTools() { return this; }, withMemory() { return this; }, withTodos() { return this; }, withParameters() { return this; }, run: async () => 'OUT' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a')] });
    const json = executor.save();
    // Forge a checkpoint the loader accepts (it does not re-validate the graph).
    const forged = JSON.parse(json);
    forged.steps[0].dependencies = ['ghost'];
    const restored = WorkflowExecutor.load({ json: JSON.stringify(forged), options: { client, defaultModel: 'm' } });
    await assert.rejects(() => restored.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } }), /Dangling dependencies \(not in the plan\): a→ghost/);
});

test('C7/nested: a sub-plan with a dangling dependency is rejected when the child is built', () => {
    const client = { session: () => ({ provider: 'openai' }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    // The child executor is constructed by the parent at run time; the same guard
    // applies because every child goes through setSteps.
    const child = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    assert.throws(() => child.setSteps({ stepsList: [step('x', ['y'])] }), /Plan rejected: .*x→y/);
});
