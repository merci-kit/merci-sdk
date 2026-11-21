// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectTemplateRefs, validateTemplateRefs } from '../lib/agentic/planning/graph-utils.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';

// =============================================================================
// collectTemplateRefs / validateTemplateRefs (the shared primitive)
// =============================================================================

test('collectTemplateRefs reads heads from a template', () => {
    const refs = collectTemplateRefs({ template: 'Do {{a.output}} then {{context.topic}} and {{b}}.' });
    assert.deepEqual(refs.map(r => r.head), ['a', 'context', 'b']);
    assert.deepEqual(refs.map(r => r.expr), ['a.output', 'context.topic', 'b']);
});

test('collectTemplateRefs tolerates non-strings and empty spans', () => {
    assert.deepEqual(collectTemplateRefs({ template: undefined }), []);
    assert.deepEqual(collectTemplateRefs({ template: 'plain' }), []);
    assert.deepEqual(collectTemplateRefs({ template: '{{  }}' }), []);
});

test('validateTemplateRefs: known step ids and context roots pass', () => {
    const steps = [
        { id: 'a', userPromptTemplate: 'Start with {{context.topic}}' },
        { id: 'b', userPromptTemplate: 'Use {{a.output}}' },
    ];
    assert.deepEqual(validateTemplateRefs({ steps }).unknown, []);
});

test('validateTemplateRefs: an unknown head is reported with its step', () => {
    const steps = [{ id: 'b', userPromptTemplate: 'Use {{ghost.output}}' }];
    assert.deepEqual(validateTemplateRefs({ steps }).unknown, [{ stepId: 'b', expr: 'ghost' }]);
});

test('validateTemplateRefs: custom context roots are honored', () => {
    const steps = [{ id: 'a', userPromptTemplate: 'Hit {{endpoint}}' }];
    assert.equal(validateTemplateRefs({ steps }).unknown.length, 1);
    assert.deepEqual(validateTemplateRefs({ steps, contextRoots: ['context', 'endpoint'] }).unknown, []);
});

test('validateTemplateRefs: subObjective is scanned too', () => {
    const steps = [{ id: 'a', subObjective: 'See {{ghost.x}}' }];
    assert.deepEqual(validateTemplateRefs({ steps }).unknown, [{ stepId: 'a', expr: 'ghost' }]);
});

// =============================================================================
// =============================================================================

/** @param {string} output @returns {any} */
function runClient(output = 'ok') {
    return {
        provider: 'openai',
        session() {
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withRetryPolicy() { return s; },
                withStreamTimeout() { return s; },
                withApproval() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                async run() { return output; },
            };
            return s;
        },
    };
}

/** @returns {WorkflowExecutor} */
function executor(options = {}) {
    return new WorkflowExecutor({ options: { client: runClient(), defaultModel: 'm', ...options } });
}

test('DAG execute rejects an unknown template reference', async () => {
    const exec = executor();
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Use {{ghost.output}}', dependencies: [] }] });
    await assert.rejects(
        () => exec.execute({ userGoal: 'g' }),
        /Unknown template reference\(s\): '\{\{ghost\}\}' in step 'a'/,
    );
});

test('DAG execute rejects an unknown reference in a nested-DAG subObjective', async () => {
    const exec = executor();
    exec.setSteps({ stepsList: [{ id: 'child', engine: 'dag', subObjective: 'See {{ghost.x}}', dependencies: [] }] });
    await assert.rejects(() => exec.execute({ userGoal: 'g' }), /Unknown template reference/);
});

test('DAG execute accepts step and context references', async () => {
    const exec = executor();
    exec.setSteps({ stepsList: [
        { id: 'a', userPromptTemplate: 'Do {{context.topic}}', dependencies: [] },
        { id: 'b', userPromptTemplate: 'Use {{a.output}}', dependencies: ['a'] },
    ] });
    const out = /** @type {Record<string, any>} */ (await exec.execute({ userGoal: 'g', context: { topic: 'T' } }));
    assert.equal(Object.keys(out).length, 2);
});

test('DAG execute allows a bare context key present on the run context', async () => {
    const exec = executor();
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Hit {{endpoint}}', dependencies: [] }] });
    await exec.execute({ userGoal: 'g', context: { endpoint: 'x' } });
    assert.equal(exec.steps.get('a')?.status, 'completed');
});

test('DAG template validation can be opted out', async () => {
    const exec = executor({ validateTemplateRefs: false });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Use {{ghost.output}}', dependencies: [] }] });
    await exec.execute({ userGoal: 'g' });
    assert.equal(exec.steps.get('a')?.status, 'completed');
});

test('DAG setSteps still rejects a cycle and duplicate ids (no regression)', () => {
    assert.throws(
        () => executor().setSteps({ stepsList: [
            { id: 'a', dependencies: ['b'] },
            { id: 'b', dependencies: ['a'] },
        ] }),
        /Invalid DAG plan/,
    );
    assert.throws(
        () => executor().setSteps({ stepsList: [{ id: 'a' }, { id: 'a' }] }),
        /duplicate step ids/,
    );
});

// =============================================================================
// StateMachine planner path (leftover A1)
// =============================================================================

/** @param {string} planText @returns {any} */
function planClient(planText) {
    return {
        provider: 'openai',
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withParameters() { return this; },
            run: async () => planText,
        }),
    };
}

test('StateMachine.planned rejects a plan with an unknown template reference', async () => {
    const bad = JSON.stringify({ summary: 's', entry: 'a', nodes: [{ id: 'a', systemPrompt: 'p', userPromptTemplate: 'Use {{ghost.output}}', terminal: true }], edges: [] });
    await assert.rejects(
        () => StateMachine.planned({ client: planClient(bad), objective: 'o', options: { defaultModel: 'm', maxPlanAttempts: 2 } }),
        /unknown template reference\(s\): '\{\{ghost\}\}' in node 'a'/,
    );
});

test('StateMachine.planned accepts a plan with valid references', async () => {
    const good = JSON.stringify({ summary: 's', entry: 'a', nodes: [{ id: 'a', systemPrompt: 'p', userPromptTemplate: 'Use {{context.x}}', terminal: true }], edges: [] });
    const sm = await StateMachine.planned({ client: planClient(good), objective: 'o', options: { defaultModel: 'm' } });
    assert.deepEqual(sm.graph.nodes.map(n => n.id), ['a']);
});
