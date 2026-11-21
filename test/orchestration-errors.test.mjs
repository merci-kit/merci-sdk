// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    StateMachine,
    OrchestrationError,
    VerificationError,
    OrchestrationExhaustedError,
    GraphError,
    OrchestrationFailedError,
    ConfigurationError,
    normalizeHandoff,
    contextFromMerciEnvelope,
    createSaveArtifactTool,
    LocalFileSessionStore,
    TaskState
} from '../lib/index.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { sortDagNodes } from '../lib/agentic/planning/graph-utils.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';
import { ERROR_CODES } from '../lib/core/constants/index.mjs';

/**
 * @param {{runImpl: any}} arg0
 */
function makeFakeSession({ runImpl }) {
    return {
        provider: 'openai',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        /** @param {{initialInput: *, options: *}} arg0 */
        run: ({ initialInput: input, options }) =>
            isObjectiveRestatePrompt({ input }) ? Promise.resolve('') : runImpl(input, options),
    };
}

/**
 * @param {{runImpl: any}} arg0
 */
function makeFakeClient({ runImpl }) {
    return { session: () => makeFakeSession({ runImpl }) };
}

// ─── taxonomy ───────────────────────────────────────────────────────────────

test('orchestration errors are exported and form a MerciError family', () => {
    const instances = [
        new VerificationError({ message: 'v' }),
        new OrchestrationExhaustedError({ message: 'e' }),
        new GraphError({ message: 'g' }),
        new OrchestrationFailedError({ message: 'f' }),
    ];
    const names = ['VerificationError', 'OrchestrationExhaustedError', 'GraphError', 'OrchestrationFailedError'];
    for (const [i, err] of instances.entries()) {
        assert.ok(err instanceof OrchestrationError, `${err.name} is an OrchestrationError`);
        assert.ok(err instanceof Error, `${err.name} is an Error`);
        assert.equal(err.name, names[i]);
    }
    assert.equal(new OrchestrationError({ message: 'x' }).name, 'OrchestrationError');
    assert.equal(new OrchestrationError({ message: 'x' }).code, ERROR_CODES.ORCH);
    assert.equal(instances[0].code, ERROR_CODES.ORCH_VERIFY);
    assert.equal(instances[1].code, ERROR_CODES.ORCH_EXHAUSTED);
    assert.equal(instances[2].code, ERROR_CODES.ORCH_GRAPH);
    assert.equal(instances[3].code, ERROR_CODES.ORCH_FAILED);
});

// ─── StateMachine ───────────────────────────────────────────────────────────

test('SM: a failed verify throws a typed VerificationError', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{
            id: 'a',
            terminal: true,
            execute: () => 'out',
            verify: () => ({ passed: false, evidence: 'nope', fingerprint: 'fp' }),
        }],
        edges: [],
    }, options: { contract: { maxRetries: 0 } } });

    await assert.rejects(() => sm.run(), (/** @type {any} */ err) => {
        assert.ok(err instanceof VerificationError, 'typed VerificationError');
        assert.ok(err instanceof OrchestrationError);
        assert.equal(err.code, ERROR_CODES.ORCH_VERIFY);
        assert.equal(err.nodeId, 'a');
        assert.equal(err.evidence, 'nope');
        assert.match(err.message, /failed verification/);
        return true;
    });
});

test('SM: maxVisits exhaustion throws a typed OrchestrationExhaustedError', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', maxVisits: 1, execute: () => 'x' }],
        edges: [{ from: 'a', to: 'a' }],
    } });

    await assert.rejects(() => sm.run(), (/** @type {any} */ err) => {
        assert.ok(err instanceof OrchestrationExhaustedError);
        assert.equal(err.code, ERROR_CODES.ORCH_EXHAUSTED);
        assert.match(err.message, /visited 2 times/);
        return true;
    });
});

test('SM: graph validation throws a typed ConfigurationError', () => {
    assert.throws(
        () => new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', execute: () => {} }],
            edges: [{ from: 'a', to: 'ghost' }],
        } }),
        (/** @type {any} */ err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.equal(err.code, ERROR_CODES.CONFIG);
            assert.match(err.message, /edge to "ghost" not in nodes/);
            return true;
        }
    );
});

test('SM: a verify returning a non-verdict throws a typed ConfigurationError', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', terminal: true, execute: () => 'x', verify: () => null }],
        edges: [],
    } });

    await assert.rejects(() => sm.run(), (/** @type {any} */ err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /verify must return/);
        return true;
    });
});

// ─── DAG executor ───────────────────────────────────────────────────────────

test('DAG: a dependency cycle in sortDagNodes throws a typed GraphError', () => {
    assert.throws(
        () => sortDagNodes({ steps: [
            { id: 'a', dependencies: ['b'] },
            { id: 'b', dependencies: ['a'] },
        ] }),
        (/** @type {any} */ err) => {
            assert.ok(err instanceof GraphError);
            assert.equal(err.code, ERROR_CODES.ORCH_GRAPH);
            assert.match(err.message, /Cycle or unresolved dependency/);
            return true;
        }
    );
});

test('DAG: an unresolvable prerequisite is a plan-time error, and a forged checkpoint still throws a typed GraphError', async () => {
    const client = makeFakeClient({ runImpl: async () => 'x' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    const solo = {
        id: 'solo',
        title: 'Solo',
        systemPrompt: 'Be terse.',
        userPromptTemplate: 'Do the thing.',
        dependencies: ['ghost'],
    };
    // C7: the plan is rejected when it is installed, not after other branches ran.
    assert.throws(() => executor.setSteps({ stepsList: [solo] }), /dangling dependencies/);

    // The runtime deadlock stays as a backstop for a checkpoint the loader accepts.
    const valid = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    valid.setSteps({ stepsList: [{ ...solo, dependencies: [] }] });
    const forged = JSON.parse(valid.save());
    forged.steps[0].dependencies = ['ghost'];
    const restored = WorkflowExecutor.load({ json: JSON.stringify(forged), options: { client, defaultModel: 'm' } });
    await assert.rejects(() => restored.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } }), (/** @type {any} */ err) => {
        assert.ok(err instanceof GraphError);
        assert.equal(err.code, ERROR_CODES.ORCH_GRAPH);
        assert.match(err.message, /Deadlock in DAG structure/);
        return true;
    });
});

test('DAG: a step that never passes verify ends with a typed OrchestrationFailedError', async () => {
    const executor = new WorkflowExecutor({ options: { client: makeFakeClient({ runImpl: async () => 'answer' }), defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{
        id: 'a',
        title: 'A',
        systemPrompt: 'Be terse.',
        userPromptTemplate: 'Do the thing.',
        dependencies: [],
        maxRetries: 0,
        verify: () => ({ passed: false, evidence: 'nope' }),
    }] });
    /** @type {any} */ let failedEvent = null;
    executor.on('workflow:failed', (e) => { failedEvent = e; });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), (/** @type {any} */ err) => {
        assert.ok(err instanceof OrchestrationFailedError);
        assert.equal(err.code, ERROR_CODES.ORCH_FAILED);
        assert.deepEqual(err.failedSteps, ['a']);
        assert.ok(err.failedOutputs && /** @type {any} */ (err.failedOutputs).a, 'failedOutputs stay attached');
        assert.deepEqual(/** @type {any} */ (err.context)?.failedSteps, ['a']);
        assert.match(err.message, /could not be self-healed: a — Error: Step \[a\] failed verification/);
        return true;
    });
    assert.ok(failedEvent, 'workflow:failed emitted');
    assert.match(failedEvent.reason, /Step \[a\] failed verification/);
});

test('DAG: an empty plan throws a typed ConfigurationError', () => {
    const executor = new WorkflowExecutor({ options: { client: makeFakeClient({ runImpl: async () => 'x' }), defaultModel: 'm' } });
    assert.throws(() => executor.setSteps({ stepsList: [] }), (/** @type {any} */ err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.equal(err.code, ERROR_CODES.CONFIG);
        return true;
    });
});

// ─── validation throws (agent-context / artifacts / sessions / task-state) ───

const isConfig = (/** @type {any} */ err) =>
    err instanceof ConfigurationError && err.code === ERROR_CODES.CONFIG;

test('validation throws are typed ConfigurationErrors, not plain Errors', async () => {
    assert.throws(() => normalizeHandoff({ handoff: { goal: 'sideways' } }), isConfig);
    assert.throws(() => normalizeHandoff({ handoff: { context: 'sideways' } }), isConfig);
    assert.throws(() => normalizeHandoff({ handoff: /** @type {any} */ ({ tools: 42 }) }), isConfig);
    assert.throws(() => contextFromMerciEnvelope({ env: /** @type {any} */ ({ objective: 42 }) }), isConfig);
    assert.throws(() => TaskState.fromJSON('{broken'), isConfig);

    const artifactTool = createSaveArtifactTool({ dir: 'unused-artifacts' });
    await assert.rejects(() => artifactTool.execute({ args: { name: '', content: 'x' } }), isConfig);

    const store = new LocalFileSessionStore({ dir: 'unused-sessions' });
    await assert.rejects(() => store.save({ threadId: '', data: {} }), isConfig);
});
