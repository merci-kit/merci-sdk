// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { assertStateSchema, stateSchemaViolation } from '../lib/agentic/planning/graph-utils.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';

/** @param {string} output @returns {any} */
function runClient(output) {
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

// =============================================================================
// assertStateSchema (shared primitive)
// =============================================================================

test('assertStateSchema: no schema is a no-op', () => {
    assert.doesNotThrow(() => assertStateSchema({ schema: null, value: 1, label: 'x' }));
});

test('assertStateSchema: a valid value passes', () => {
    assert.doesNotThrow(() => assertStateSchema({ schema: z.object({ ok: z.boolean() }), value: { ok: true }, label: 'x' }));
});

test('assertStateSchema: a violation throws VerificationError with issues', () => {
    assert.throws(
        () => assertStateSchema({ schema: z.object({ ok: z.boolean() }), value: { ok: 'nope' }, label: 'Step [a]' }),
        /Step \[a\] output failed stateSchema: ok:/,
    );
});

// =============================================================================
// DAG: model escalation on a schema failure
// =============================================================================

test('DAG: a stateSchema failure escalates the retry to escalateModel', async () => {
    /** @type {string[]} */
    const requested = [];
    const client = {
        provider: 'openai',
        getProfiles: async () => [{ id: 'm' }, { id: 'strong' }],
        /** @param {string} model */
        session(model) {
            requested.push(model);
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
                async run() { return '{"ok":"nope"}'; },
            };
            return s;
        },
    };
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', stateSchema: schema } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [], model: 'm', escalateModel: 'strong', maxRetries: 1 }] });

    await assert.rejects(() => exec.execute({ userGoal: 'g' }), /stateSchema|self-healed/);
    assert.ok(requested.includes('strong'), 'the schema-failing retry used the escalated model');
});

// =============================================================================
// DAG: _recordStepOutput is the store point
// =============================================================================

const schema = z.object({ ok: z.boolean() });

test('DAG: a schema-valid step output is stored', async () => {
    const exec = new WorkflowExecutor({ options: { client: runClient('{"ok":true}'), defaultModel: 'm', stateSchema: schema } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [] }] });
    const out = /** @type {any} */ (await exec.execute({ userGoal: 'g' }));
    assert.deepEqual(out.a.data, { ok: true });
});

test('DAG: a schema-violating step output fails the step, not stores it', async () => {
    const exec = new WorkflowExecutor({ options: { client: runClient('{"ok":"nope"}'), defaultModel: 'm', stateSchema: schema } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [] }] });
    await assert.rejects(() => exec.execute({ userGoal: 'g' }), /execution failed and could not be self-healed/);
    assert.match(String(/** @type {any} */ (exec.outputs.a.data)?.error), /stateSchema/);
    assert.equal(exec.steps.get('a')?.status, 'failed');
});

test('DAG: without a schema the same output is stored (no regression)', async () => {
    const exec = new WorkflowExecutor({ options: { client: runClient('{"ok":"nope"}'), defaultModel: 'm' } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [] }] });
    const out = /** @type {any} */ (await exec.execute({ userGoal: 'g' }));
    assert.deepEqual(out.a.data, { ok: 'nope' });
});

test('DAG: a schema violation retries and succeeds when the next output is valid', async () => {
    const outputs = ['{"ok":"nope"}', '{"ok":true}'];
    let i = 0;
    const client = {
        provider: 'openai',
        session() {
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withParameters() { return s; },
                withRetryPolicy() { return s; },
                withCircuitBreaker() { return s; },
                async run() { return outputs[Math.min(i++, outputs.length - 1)]; },
            };
            return s;
        },
    };
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', stateSchema: schema } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [], maxRetries: 2 }] });
    await exec.execute({ userGoal: 'g', objectiveOptions: { adaptable: false } });
    assert.deepEqual(exec.outputs.a.data, { ok: true });
    assert.equal(exec.steps.get('a')?.status, 'completed');
});

// =============================================================================
// StateMachine: the #ctx.set point
// =============================================================================

test('StateMachine: a schema-valid node output is stored', async () => {
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', terminal: true, userPromptTemplate: 'x' }], edges: [] }, options: { client: runClient('{"ok":true}'), defaultModel: 'm', stateSchema: z.string() } });
    const ctx = await sm.run({});
    assert.equal(ctx.get({ k: 'n' }), '{"ok":true}');
});

test('StateMachine: a schema-violating node output fails the node', async () => {
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', terminal: true, userPromptTemplate: 'x' }], edges: [] }, options: { client: runClient('{"ok":true}'), defaultModel: 'm', stateSchema: z.number() } });
    await assert.rejects(() => sm.run({}), /stateSchema/);
});

// =============================================================================
// Unified retry across engines
// =============================================================================

test('stateSchemaViolation: null when valid, the VerificationError when violated', () => {
    const s = z.object({ ok: z.boolean() });
    assert.equal(stateSchemaViolation({ schema: s, value: { ok: true }, label: 'x' }), null);
    assert.equal(stateSchemaViolation({ schema: null, value: 1, label: 'x' }), null);
    assert.match(String(stateSchemaViolation({ schema: s, value: { ok: 1 }, label: 'x' })?.message), /stateSchema/);
});

/** A client whose successive `run()` calls return the queued outputs (last repeats). @param {string[]} outputs @returns {any} */
function sequencedClient(outputs) {
    let i = 0;
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
                async run() { return outputs[Math.min(i++, outputs.length - 1)]; },
            };
            return s;
        },
    };
}

const okTrueString = z.string().refine((s) => {
    try { return JSON.parse(s).ok === true; } catch { return false; }
}, 'ok must be true');

test('StateMachine: a schema violation retries and succeeds on a later attempt', async () => {
    const client = sequencedClient(['{"ok":"nope"}', '{"ok":true}']);
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', terminal: true, userPromptTemplate: 'x' }], edges: [] }, options: { client, defaultModel: 'm', stateSchema: okTrueString, contract: { maxRetries: 2 } } });
    const ctx = await sm.run({});
    assert.equal(ctx.get({ k: 'n' }), '{"ok":true}');
});

test('StateMachine: an always-violating schema exhausts and throws a typed error', async () => {
    const client = sequencedClient(['{"ok":"nope"}']);
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', terminal: true, userPromptTemplate: 'x' }], edges: [] }, options: { client, defaultModel: 'm', stateSchema: okTrueString, contract: { maxRetries: 1 } } });
    await assert.rejects(() => sm.run({}), /stateSchema/);
});

test('Discussion: a schema violation retries the turn and commits the valid output', async () => {
    const client = sequencedClient(['{"ok":"nope"}', '{"ok":true}']);
    const group = new DiscussionSession({ client, options: { stateSchema: schema } });
    group.addAgent({ name: 'A', persona: 'P', model: 'm', provider: 'openai' });
    await group.discuss({ instruction: 'go', turns: 1, sequential: true });
    const committed = /** @type {any[]} */ (group.getLedger()).filter((e) => e.type === 'discussion');
    assert.equal(committed.at(-1)?.content, '{"ok":true}');
});

test('Discussion: an always-violating schema records an error, never a malformed commit', async () => {
    const client = sequencedClient(['{"ok":"nope"}']);
    const group = new DiscussionSession({ client, options: { stateSchema: schema } });
    group.addAgent({ name: 'A', persona: 'P', model: 'm', provider: 'openai' });
    await group.discuss({ instruction: 'go', turns: 1, sequential: true });
    const committed = /** @type {any[]} */ (group.getLedger()).filter((e) => e.type === 'discussion');
    assert.match(String(committed.at(-1)?.content), /^\[error:/);
});

test('DAG (stateMachine engine): a schema violation retries and succeeds', async () => {
    const client = sequencedClient(['{"ok":"nope"}', '{"ok":true}']);
    // The stateMachine engine stores its context map ({ <nodeId>: <answer> }),
    // so author the schema for that stored value — same contract as _recordStepOutput.
    const payloadSchema = z.object({ step: z.string().refine((s) => {
        try { return JSON.parse(s).ok === true; } catch { return false; }
    }, 'ok must be true') });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'stateMachine', stateSchema: payloadSchema } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [], maxRetries: 2 }] });
    await exec.execute({ userGoal: 'g', objectiveOptions: { adaptable: false } });
    assert.equal(/** @type {any} */ (exec.outputs.a.data).step, '{"ok":true}');
});

test('DAG (discussion engine): a schema violation retries and succeeds', async () => {
    const client = sequencedClient(['{"ok":"nope"}', '{"ok":true}']);
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'discussion', agents: [{ name: 'A', persona: 'P', model: 'm', provider: 'openai' }], stateSchema: schema } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do it', dependencies: [], maxRetries: 2 }] });
    await exec.execute({ userGoal: 'g', objectiveOptions: { adaptable: false } });
    assert.deepEqual(exec.outputs.a.data, { ok: true });
});
