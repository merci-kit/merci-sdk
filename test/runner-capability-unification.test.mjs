// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { TodoComponent } from '../lib/agentic/todos/component.mjs';
import { MemoryComponent } from '../lib/agentic/memory/component.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';

// =============================================================================
// Stubs
// =============================================================================

/**
 * @param {{collected: any[]}} arg0
 */
function stubSession({ collected }) {
    const s = /** @type {any} */ ({
        provider: 'openai',
        memoryArgs: null,
        todosArgs: null,
        capabilities: [],
        withSystemMessage() { return this; },
        withTools() { return this; },
        withParameters() { return this; },
        /** @param {{provider: *, options: *}} arg0 */
        withMemory({ provider, options }) { this.memoryArgs = [provider, options]; return this; },
        /** @param {{store: *, options: *}} arg0 */
        withTodos({ store, options }) { this.todosArgs = [store, options]; return this; },
        /** @param {{capability: *, preload: *}} arg0 */
        withCapability({ capability, preload }) { this.capabilities.push([capability, preload]); return this; },
        run: async () => 'stub answer',
    });
    collected.push(s);
    return s;
}

/**
 * @param {{collected: any[]}} arg0
 */
function stubClient({ collected }) {
    return { session: () => stubSession({ collected }) };
}

const STUB_ENGINE = { load: async () => null, save: async () => ({ success: true }) };

// =============================================================================
// StateMachine node sessions
// =============================================================================

test('SM: LLM node sessions receive the machine memory/todos stores', async () => {
    const collected = /** @type {any[]} */ ([]);
    const provider = { query: async () => [], store: async () => ({}) };
    const store = new Map();
    const memOpts = { syncInterval: 7 };
    const todoOpts = { filePath: null };
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', model: 'm' }], edges: [] }, options: { client: stubClient({ collected }), defaultModel: 'm', memoryProvider: provider, memoryOptions: memOpts, todoStore: store, todoOptions: todoOpts } });
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.equal(collected.length, 1);
    assert.deepEqual(collected[0].memoryArgs, [provider, memOpts]);
    assert.deepEqual(collected[0].todosArgs, [store, todoOpts]);
});

test('SM: no stores configured means no capability wiring (unchanged default)', async () => {
    const collected = /** @type {any[]} */ ([]);
    const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', model: 'm' }], edges: [] }, options: { client: stubClient({ collected }), defaultModel: 'm' } });
    await sm.run();
    assert.equal(collected.length, 1);
    assert.equal(collected[0].memoryArgs, null);
    assert.equal(collected[0].todosArgs, null);
});

// =============================================================================
// Executor non-naive engines
// =============================================================================

const STEP = { id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'Do it.', dependencies: [] };

test('executor stateMachine engine: step SM inherits the run memory/todos stores', async () => {
    const collected = /** @type {any[]} */ ([]);
    const provider = { query: async () => [], store: async () => ({}) };
    const store = new Map();
    const executor = new WorkflowExecutor({ options: {
        client: stubClient({ collected }),
        defaultModel: 'm',
        engine: 'stateMachine',
        memoryProvider: provider,
        todoStore: store,
    } });
    executor.setSteps({ stepsList: [STEP] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal(collected.length, 1);
    assert.equal(collected[0].memoryArgs[0], provider);
    assert.equal(collected[0].todosArgs[0], store);
});

test('executor discussion engine: agent sessions inherit the run todos/memory stores', async () => {
    const collected = /** @type {any[]} */ ([]);
    const provider = { query: async () => [], store: async () => ({}) };
    const store = new Map();
    const executor = new WorkflowExecutor({ options: {
        client: stubClient({ collected }),
        defaultModel: 'm',
        engine: 'discussion',
        agents: [{ name: 'a', model: 'm', provider: 'openai' }],
        memoryProvider: provider,
        todoStore: store,
    } });
    executor.setSteps({ stepsList: [STEP] });
    const outputs = /** @type {any} */ (await executor.execute({ userGoal: 'goal' }));
    assert.ok(outputs.a.output.includes('stub answer'));
    const wired = collected.filter((s) => s.todosArgs || s.memoryArgs);
    assert.ok(wired.length >= 1, 'at least one agent session got capabilities');
    for (const s of wired) {
        if (s.todosArgs) assert.equal(s.todosArgs[0], store);
        if (s.memoryArgs) assert.equal(s.memoryArgs[0], provider);
    }
});

// =============================================================================
// MAA verify-gated turns
// =============================================================================

test('MAA verify turn: the gating SM keeps the group todos store', async () => {
    const collected = /** @type {any[]} */ ([]);
    const store = new Map();
    const group = new DiscussionSession({ client: stubClient({ collected }), options: { todosStore: store, objective: 'goal' } });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    await group.runTasks({ tasks: [{
        title: 't1', description: 'do it', assignee: 'a',
        verify: async () => ({ passed: true, evidence: 'ok' }),
    }] });
    const wired = collected.filter((s) => s.todosArgs);
    assert.ok(wired.length >= 1, 'verify-gated turn session got the todos store');
    assert.equal(wired[0].todosArgs[0], store);
});

// =============================================================================
// Task-tool children
// =============================================================================

test('task child: inherits the parent capability components (shared instances)', async () => {
    const collected = /** @type {any[]} */ ([]);
    const client = stubClient({ collected });
    const store = new Map();
    const todos = new TodoComponent({ store });
    const memory = new MemoryComponent({ engine: STUB_ENGINE });
    const parent = {
        model: 'm',
        provider: 'openai',
        client,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _todoComponent: todos,
        _memoryComponent: memory,
        _skillsLibrary: null,
        _webSearchComponent: null,
        _webScrapeComponent: null,
        _extraStepComponents: [],
    };
    withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'w', model: 'm' }] });
    const out = await (/** @type {any} */ (createTaskTool({ session: /** @type {any} */ (parent) }))).execute({ args: { prompt: 'do x', subagent_type: 'w' } });
    assert.equal(out, 'stub answer');
    assert.equal(collected.length, 1);
    const inherited = collected[0].capabilities.map((/** @type {any} */ entry) => entry[0]);
    assert.ok(inherited.includes(todos), 'child inherited the todos component');
    assert.ok(inherited.includes(memory), 'child inherited the memory component');
    assert.equal(inherited.filter((/** @type {any} */ c) => c === todos).length, 1, 'inherited exactly once');
});

test('task child: parent without capabilities leaves the child untouched', async () => {
    const collected = /** @type {any[]} */ ([]);
    const client = stubClient({ collected });
    const parent = {
        model: 'm', provider: 'openai', client,
        eventEmitter: new EventEmitter(), _taskDepth: 0,
    };
    withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'w', model: 'm' }] });
    await (/** @type {any} */ (createTaskTool({ session: /** @type {any} */ (parent) }))).execute({ args: { prompt: 'do x', subagent_type: 'w' } });
    assert.deepEqual(collected[0].capabilities, []);
});

// =============================================================================
// =============================================================================

const flushMirror = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test('executor: step lifecycle is mirrored into the shared todo store', async () => {
    const collected = /** @type {any[]} */ ([]);
    const store = new Map();
    const executor = new WorkflowExecutor({ options: {
        client: stubClient({ collected }),
        defaultModel: 'm',
        todoStore: store,
    } });
    executor.setSteps({ stepsList: [{ ...STEP, name: 'Do it' }] });
    await flushMirror();
    assert.equal(store.get('dag:a')?.status, 'pending');
    await executor.execute({ userGoal: 'goal' });
    await flushMirror();
    const task = store.get('dag:a');
    assert.equal(task?.status, 'completed');
    assert.equal(task?.title, 'Do it');
});

test('executor: failed steps mirror as failed, model tasks untouched', async () => {
    const collected = /** @type {any[]} */ ([]);
    const store = new Map([['own', { id: 'own', title: 'Mine', status: 'pending' }]]);
    const failingClient = { session: () => { const s = stubSession({ collected }); s.run = async () => { throw new Error('boom'); }; return s; } };
    const executor = new WorkflowExecutor({ options: { client: failingClient, defaultModel: 'm', todoStore: store } });
    executor.setSteps({ stepsList: [STEP] });
    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /boom/);
    await flushMirror();
    assert.equal(store.get('dag:a')?.status, 'failed');
    assert.deepEqual(store.get('own'), { id: 'own', title: 'Mine', status: 'pending' });
});

test('executor: no todoStore means no mirror and no new behavior', async () => {
    const collected = /** @type {any[]} */ ([]);
    const executor = new WorkflowExecutor({ options: { client: stubClient({ collected }), defaultModel: 'm' } });
    executor.setSteps({ stepsList: [STEP] });
    const outputs = /** @type {any} */ (await executor.execute({ userGoal: 'goal' }));
    assert.equal(outputs.a.output, 'stub answer');
    assert.equal(executor._todoMirrorComp ?? null, null);
});

test('MAA conclude: the final aggregate is persisted to the memory store', async () => {
    const collected = /** @type {any[]} */ ([]);
    const saved = /** @type {any[]} */ ([]);
    const provider = {
        query: async () => [],
        /** @param {{content: *, category: *}} arg0 */
        store: async ({ content, category }) => { saved.push({ content, category }); return { id: '1' }; },
    };
    const group = new DiscussionSession({ client: stubClient({ collected }), options: { memoryProvider: provider, objective: 'goal' } });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    const entry = /** @type {any} */ (await group.conclude({ instruction: 'wrap up', options: { maxRounds: 0 } }));
    assert.ok(entry?.content?.includes('stub answer'));
    assert.equal(saved.length, 1);
    assert.ok(saved[0].content.includes('stub answer'));
    assert.equal(saved[0].category, 'discussion');
});

test('MAA conclude: no memory provider means no persistence (unchanged default)', async () => {
    const collected = /** @type {any[]} */ ([]);
    const group = new DiscussionSession({ client: stubClient({ collected }), options: { objective: 'goal' } });
    group.addAgent({ name: 'a', model: 'm', provider: 'openai' });
    const entry = /** @type {any} */ (await group.conclude({ instruction: 'wrap up', options: { maxRounds: 0 } }));
    assert.ok(entry?.content?.includes('stub answer'));
});

// =============================================================================
// ponytail: ArtifactComponent (the LoadableComponent listing wrapper) was
// =============================================================================

test('artifacts: the factory tool round-trips a save through manifest + file', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'merci-artifacts-'));
    const tool = createSaveArtifactTool({ dir });
    assert.equal(tool.name, 'save_artifact');
    const path = await tool.execute({ args: { name: 'findings.md', content: '# Hi' } });
    assert.ok(path.endsWith('findings.md'));
    assert.equal(readFileSync(path, 'utf8'), '# Hi');
    const manifest = JSON.parse(readFileSync(join(dir, '.artifacts.json'), 'utf8'));
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].name, 'findings.md');
    assert.equal(manifest.entries[0].bytes, 4);
});

test('artifacts: a save into a missing directory creates it on demand, never throws', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = join(mkdtempSync(join(tmpdir(), 'merci-artifacts-')), 'nested', 'deeper');
    assert.equal(existsSync(dir), false);
    const tool = createSaveArtifactTool({ dir });
    const path = await tool.execute({ args: { name: 'findings.md', content: '# Hi' } });
    assert.ok(existsSync(path));
});

test('artifacts: a name collision versions instead of clobbering', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'merci-artifacts-'));
    const tool = createSaveArtifactTool({ dir });
    const first = await tool.execute({ args: { name: 'findings.md', content: 'v1' } });
    const second = await tool.execute({ args: { name: 'findings.md', content: 'v2' } });
    assert.ok(first.endsWith('findings.md'));
    assert.ok(second.endsWith('findings.v2.md'), `expected a versioned path, got ${second}`);
    assert.equal(readFileSync(first, 'utf8'), 'v1', 'the original version must not be clobbered');
    const manifest = JSON.parse(readFileSync(join(dir, '.artifacts.json'), 'utf8'));
    assert.deepEqual(manifest.entries.map((/** @type {any} */ e) => [e.name, e.version]), [['findings.md', 1], ['findings.md', 2]]);
});
