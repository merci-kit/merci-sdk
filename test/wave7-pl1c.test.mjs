// @ts-check

/**
 * Wave 7 / PL1c — progressive decomposition.
 *
 * A coarse plan can say "this node needs planning of its own" with
 * `expansion: 'decompose'`. The node is planned when it becomes runnable: the
 * planner sees the node's brief, the outputs its ancestors produced and the plan
 * that is still pending, and the sub-plan runs on the existing nested engine
 * (depth limit, child checkpoint, shared journal). Nothing changes for a node that
 * does not declare it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { Plan } from '../lib/agentic/planning/plan.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {any} text @returns {string} */
function asText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? m))).join('\n');
    return JSON.stringify(text);
}

/** @param {{answer?: (text: string) => string}} [arg0] */
function makeClient({ answer = () => 'OUT' } = {}) {
    /** @type {any[]} */
    const sessions = [];
    const client = {
        sessions,
        getProfiles: async () => [{ id: 'm', default: true, object: 'model' }],
        session(/** @type {string} */ model) {
            const s = /** @type {any} */ ({
                provider: 'openai',
                model,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withPromptCache() { return s; },
                run(/** @type {{initialInput: any}} */ { initialInput }) {
                    const rows = Array.isArray(initialInput) ? initialInput : [initialInput];
                    const text = asText(rows.at(-1)?.content ?? initialInput);
                    if (isObjectiveRestatePrompt({ input: initialInput })) return Promise.resolve('');
                    return Promise.resolve(answer(text));
                },
            });
            sessions.push(s);
            return s;
        },
    };
    return client;
}

/** @param {string} id @param {string[]} [dependencies] @param {Record<string, any>} [extra] */
const step = (id, dependencies = [], extra = {}) => ({
    id,
    title: id,
    brief: `${id} is done`,
    systemPrompt: `Be terse (${id}).`,
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
    ...extra,
});

/**
 * A planner that returns a fixed sub-plan and records every objective it saw.
 * @param {Array<Record<string, any>>} subSteps
 */
function recordingPlanner(subSteps) {
    /** @type {string[]} */
    const objectives = [];
    return {
        objectives,
        /** @param {{objective: string}} arg0 */
        plan: async ({ objective }) => { objectives.push(objective); return { steps: subSteps }; },
        replan: async () => ({ steps: subSteps }),
    };
}

test('PL1c/decompose: a node that declares it plans itself when it becomes runnable', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); if (text.includes('SUB')) return 'RESEARCH-NOTES'; return 'OUT'; } });
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('scan'), step('work', ['scan'], { expansion: 'decompose', brief: 'a reviewed patch is ready' }), step('ship', ['work'])] });
    const planner = recordingPlanner([step('sub1'), step('sub2', ['sub1'])]);
    /** @type {any[]} */
    const decomposed = [];
    ex.on('workflow:step_decomposed', (/** @type {any} */ e) => decomposed.push(e));

    const outputs = /** @type {any} */ (await ex.execute({ userGoal: 'goal', planner }));

    assert.equal(decomposed.length, 1, 'the decomposition is visible');
    assert.equal(decomposed[0].stepId, 'work');
    assert.deepEqual(decomposed[0].subSteps, ['sub1', 'sub2']);
    assert.ok(seen.some((t) => t.includes('SUB1')), 'the sub-plan ran');
    assert.ok(seen.some((t) => t.includes('SHIP-STEP')), 'the dependant ran after it');
    assert.equal(outputs.work.output, 'RESEARCH-NOTES', 'the node output is the sub-plan leaf');
});

test('PL1c/planner-context: the decomposition objective carries the brief, the prerequisites and the remaining plan', async () => {
    const client = makeClient({ answer: (text) => (text.includes('SCAN-STEP') ? 'SCAN-RESULT' : 'OUT') });
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [
        step('scan'),
        step('work', ['scan'], { expansion: 'decompose', brief: 'a reviewed patch is ready' }),
        step('ship', ['work'], { brief: 'the release is out' }),
    ] });
    const planner = recordingPlanner([step('sub1')]);
    await ex.execute({ userGoal: 'goal', planner });
    const objective = planner.objectives[0] ?? '';
    assert.match(objective, /## Acceptance[\s\S]*a reviewed patch is ready/, "the node's own brief");
    assert.match(objective, /SCAN-RESULT/, 'the ancestor output reaches the planner');
    assert.match(objective, /## Remaining plan[\s\S]*ship: the release is out/, 'what is still pending');

    // With the intake block switched off, the ancestor output must still reach the
    // planner — the decomposition objective is not redundant with intake.
    const bare = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    bare.setSteps({ stepsList: [
        step('scan'),
        step('work', ['scan'], { expansion: 'decompose', brief: 'a reviewed patch is ready', intakeMode: 'none' }),
    ] });
    const second = recordingPlanner([step('sub1')]);
    await bare.execute({ userGoal: 'goal', planner: second });
    assert.match(second.objectives[0] ?? '', /## Completed prerequisites[\s\S]*scan: SCAN-RESULT/);
});

test('PL1c/atomic-untouched: a plan with no decompose node never calls the planner', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    const planner = recordingPlanner([step('should-not-run')]);
    await ex.execute({ userGoal: 'goal', planner });
    assert.deepEqual(planner.objectives, []);
});

test('PL1c/static: an explicit sub-plan is used without planning anything', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'], { engine: 'dag', subSteps: [step('s1'), step('s2', ['s1'])] })] });
    const planner = recordingPlanner([step('should-not-run')]);
    await ex.execute({ userGoal: 'goal', planner });
    assert.deepEqual(planner.objectives, []);
});

test('PL1c/depth-cap: decomposition is bounded by maxDepth', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxDepth: 0 } });
    ex.setSteps({ stepsList: [step('work', [], { expansion: 'decompose' })] });
    // A planner that offers no real edit: the depth failure must be what the run reports.
    const planner = {
        plan: async () => ({ steps: [step('sub1')] }),
        replan: async () => ({ steps: [step('work', [], { expansion: 'decompose' })] }),
    };
    await assert.rejects(() => ex.execute({ userGoal: 'goal', planner }), /depth limit \(0\) is reached/);
});

test('PL1c/verify: the node verify gate sees the sub-plan leaf, not the node prompt', async () => {
    /** @type {any[]} */
    const verified = [];
    const client = makeClient({ answer: (text) => (text.includes('SUB1') ? 'LEAF-OUTPUT' : 'OUT') });
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('work', [], {
        expansion: 'decompose',
        verify: (/** @type {any} */ out) => { verified.push(out); return { passed: true, evidence: 'ok' }; },
    })] });
    await ex.execute({ userGoal: 'goal', planner: recordingPlanner([step('sub1')]) });
    assert.deepEqual(verified, ['LEAF-OUTPUT']);
});

test('PL1c/plan-projection: the Plan reports decompose and gate kinds instead of flattening them', () => {
    const plan = Plan.fromDag({ steps: [
        { id: 'a', dependencies: [] },
        { id: 'b', dependencies: ['a'], expansion: 'decompose' },
        { id: 'g', dependencies: ['b'], kind: 'gate' },
    ] });
    assert.equal(plan.node({ id: 'a' })?.expansion, 'atomic');
    assert.equal(plan.node({ id: 'b' })?.expansion, 'decompose');
    assert.equal(plan.node({ id: 'g' })?.kind, 'gate');
});

test('PL1c/retry-reuses: a verify retry reuses the sub-plan instead of planning again', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'LEAF'; } });
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    let checks = 0;
    ex.setSteps({ stepsList: [step('work', [], {
        expansion: 'decompose',
        verify: () => { checks += 1; return { passed: checks > 1, evidence: checks > 1 ? 'ok' : 'weak' }; },
    })] });
    const planner = recordingPlanner([step('sub1')]);
    /** @type {any[]} */
    const decomposed = [];
    ex.on('workflow:step_decomposed', (/** @type {any} */ e) => decomposed.push(e));
    await ex.execute({ userGoal: 'goal', planner });
    assert.equal(planner.objectives.length, 1, 'planned once');
    assert.equal(decomposed.length, 1, 'one decomposition, on the first attempt');
    assert.equal(checks, 2, 'the verify gate ran twice');
    assert.equal(ex.steps.get('work')?._decomposedSteps?.[0]?.id, 'sub1', 'the learned sub-plan stays on the node');
});

test('PL1c/nested-event: a decompose node inside a nested child is visible at the root', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxDepth: 2 } });
    ex.setSteps({ stepsList: [step('outer', [], { engine: 'dag', subSteps: [step('inner', [], { expansion: 'decompose' })] })] });
    /** @type {any[]} */
    const decomposed = [];
    ex.on('workflow:step_decomposed', (/** @type {any} */ e) => decomposed.push(e));
    await ex.execute({ userGoal: 'goal', planner: recordingPlanner([step('deep')]) });
    assert.equal(decomposed.length, 1);
    assert.equal(decomposed[0].stepId, 'inner', "the child's step id survives the forward");
});

test('PL1c/planner-tools: the planner is offered the tools the sub-plan will run with', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    const nodeTools = [{ name: 'node-tool' }];
    const executorTools = [{ name: 'executor-tool' }];
    ex.setSteps({ stepsList: [step('work', [], { expansion: 'decompose', tools: nodeTools })] });
    /** @type {any[]} */
    const offered = [];
    await ex.execute({ userGoal: 'goal', planner: {
        plan: async (/** @type {any} */ { availableTools }) => { offered.push(availableTools); return { steps: [step('sub1')] }; },
        replan: async () => ({ steps: [] }),
    } });
    assert.deepEqual(offered[0], nodeTools);
    void executorTools;
});

test('PL1c/empty-replan: an empty replan response is refused, so the step failure is what surfaces', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1 } });
    ex.setSteps({ stepsList: [step('work', [], { verify: () => ({ passed: false, evidence: 'always weak' }) })] });
    await assert.rejects(
        () => ex.execute({
            userGoal: 'goal',
            planner: { plan: async () => ({ steps: [step('sub1')] }), replan: async () => ({ steps: [] }) },
        }),
        /failed verification|always weak/
    );
    assert.ok(ex.steps.has('work'), 'the plan was not emptied');
});

test('PL1c/static-wins: an explicit sub-plan reports static even when the node carries the decompose label', () => {
    const plan = Plan.fromDag({ steps: [{ id: 'a', dependencies: [], expansion: 'decompose', subSteps: [{ id: 's1', dependencies: [] }] }] });
    assert.equal(plan.node({ id: 'a' })?.expansion, 'static');
});

test('PL1c/no-false-dedupe: an ancestor whose output text also appears in the prompt is still listed', async () => {
    const client = makeClient({ answer: (text) => (text.includes('SCAN-STEP') ? 'SHIP' : 'OUT') });
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [
        step('scan'),
        step('work', ['scan'], { expansion: 'decompose', userPromptTemplate: 'Return SHIP now', intakeMode: 'none' }),
    ] });
    const planner = recordingPlanner([step('sub1')]);
    await ex.execute({ userGoal: 'goal', planner });
    assert.match(planner.objectives[0] ?? '', /## Completed prerequisites[\s\S]*scan: SHIP/);
});

test('PL1c/setSteps-keeps-subplan: re-supplying the same plan after a restore does not re-plan', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('work', [], { expansion: 'decompose' })] });
    const planner = recordingPlanner([step('sub1')]);
    await ex.execute({ userGoal: 'goal', planner });
    assert.equal(planner.objectives.length, 1);

    const restored = WorkflowExecutor.load({ json: ex.save(), options: { client, defaultModel: 'm' } });
    assert.equal(restored.steps.get('work')?._decomposedSteps?.[0]?.id, 'sub1', 'the sub-plan reached the checkpoint');
    restored.setSteps({ stepsList: [step('work', [], { expansion: 'decompose' })] });
    assert.equal(restored.steps.get('work')?._decomposedSteps?.[0]?.id, 'sub1', 'setSteps kept it for the same definition');
    assert.equal(restored.steps.get('work')?.status, 'completed');
});

test('PL1c/invalid-subplan: an invalid planned sub-plan is not cached and never announced', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('work', [], { expansion: 'decompose' })] });
    /** @type {any[]} */
    const decomposed = [];
    ex.on('workflow:step_decomposed', (/** @type {any} */ e) => decomposed.push(e));
    const planner = recordingPlanner([step('dup'), step('dup')]);
    await assert.rejects(() => ex.execute({ userGoal: 'goal', planner }), /duplicate step ids|Duplicate/i);
    assert.deepEqual(decomposed, [], 'nothing was announced for a sub-plan that never ran');
    assert.equal(ex.steps.get('work')?._decomposedSteps, undefined, 'an invalid sub-plan is not replayed forever');
});

test('PL1c/fresh-rerun: a plain re-execution plans the decompose node again', async () => {
    const client = makeClient();
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    ex.setSteps({ stepsList: [step('work', [], { expansion: 'decompose' })] });
    const planner = recordingPlanner([step('sub1')]);
    await ex.execute({ userGoal: 'goal', planner });
    assert.equal(planner.objectives.length, 1);
    await ex.execute({ userGoal: 'goal again', planner });
    assert.equal(planner.objectives.length, 2, 'the second run planned against its own context');
});
