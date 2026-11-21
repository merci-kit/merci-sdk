// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { runStep } from '../lib/agentic/step.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ExecutionJournal, JOURNAL_STATUS, toolJournalKey } from '../lib/agentic/journal.mjs';
import { runCommand } from '../lib/support/run-command.mjs';
import { loadMcpTools } from '../lib/tools/mcp-client.mjs';
import { AcpCapability } from '../lib/tools/external-capability.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

const CALL = { id: 'c1', name: 'count', arguments: '{"n":1}' };

/**
 * @param {{counter: *, keys?: string[]}} arg0
 */
function countingTool({ counter, keys = [] }) {
    return {
        name: 'count',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        /** @param {{args: *, signal: *, context?: *}} arg0 */
        execute: async ({ args: _args, signal: _signal, context = {} }) => {
            counter.n++;
            if (context?.idempotencyKey) keys.push(context.idempotencyKey);
            return `count=${counter.n}`;
        },
    };
}

/**
 * @param {{tool: any, capture?: *}} arg0
 */
function makeToolSession({ tool, capture = {} }) {
    return {
        provider: 'OAI',
        model: 'm',
        _tools: [tool],
        _retryPolicy: undefined,
        eventEmitter: { emit() {} },
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /**
         * @param {{messages: *}} arg0
         * @returns {AsyncGenerator<any, any>}
         */
        async *step({ messages }) {
            const results = yield { type: 'tool_request', calls: [CALL] };
            if (capture) capture.results = results;
            return { done: true, content: 'done', messages, thoughtSignature: null };
        },
        /** @param {{initialInput: *, options: *}} arg0 */
        run({ initialInput, options }) {
            return isObjectiveRestatePrompt({ input: initialInput }) ? Promise.resolve('') : runAgenticLoop({ session: this, messages: initialInput, opts: options });
        },
    };
}

/**
 * @param {{tool: any, capture?: *}} arg0
 */
function makeToolClient({ tool, capture }) {
    return { session: () => makeToolSession({ tool, capture }) };
}

const STEP = { id: 'a', title: 'A', systemPrompt: 's', userPromptTemplate: 'u', dependencies: [] };

// ─── DAG: checkpoint round-trip + replay ────────────────────────────────────

test('S14: the DAG checkpoint carries and restores the journal', () => {
    const journal = new ExecutionJournal();
    const ex = new WorkflowExecutor({ options: { client: makeToolClient({ tool: countingTool({ counter: { n: 0 } }) }), defaultModel: 'm', journal } });
    ex.setSteps({ stepsList: [STEP] });
    const key = toolJournalKey({ runId: journal.runId, boundary: 'a:b1', name: 'count', args: { n: 1 } });
    journal.begin({ key, meta: { name: 'count' } });

    const saved = JSON.parse(ex.save());
    assert.ok(saved.journal, 'the checkpoint must carry the journal');
    assert.equal(saved.journal.entries.length, 1);

    const ex2 = WorkflowExecutor.load({ json: ex.save(), options: { client: makeToolClient({ tool: countingTool({ counter: { n: 0 } }) }), defaultModel: 'm' } });
    assert.ok(ex2._journal instanceof ExecutionJournal, 'load() restores an ExecutionJournal');
    assert.equal(ex2._journal.get({ key })?.status, JOURNAL_STATUS.INTENT, 'the restored intent is visible');
});

test('S14: a resumed DAG step replays a done tool instead of re-running it', async () => {
    const counter = { n: 0 };
    const capture = /** @type {{results?: any[]}} */ ({});
    const journal = new ExecutionJournal();
    const key = toolJournalKey({ runId: journal.runId, boundary: 'a:b1', name: 'count', args: { n: 1 } });
    journal.complete({ key, outcome: { success: true, result: 'count=REPLAYED' } });

    const ex = new WorkflowExecutor({ options: { client: makeToolClient({ tool: countingTool({ counter }), capture }), defaultModel: 'm', journal } });
    ex.setSteps({ stepsList: [STEP] });
    await ex.execute({ userGoal: 'goal' });

    assert.equal(counter.n, 0, 'the completed side effect must not run again');
    assert.equal(capture.results?.[0]?.result, 'count=REPLAYED', 'the recorded result is replayed');
    assert.equal(capture.results?.[0]?.replayed, true);
});

test('S14: a resumed DAG step fails closed on an interrupted non-idempotent tool', async () => {
    const counter = { n: 0 };
    const capture = /** @type {{results?: any[]}} */ ({});
    const journal = new ExecutionJournal();
    const key = toolJournalKey({ runId: journal.runId, boundary: 'a:b1', name: 'count', args: { n: 1 } });
    journal.begin({ key, meta: { name: 'count' } });

    const ex = new WorkflowExecutor({ options: { client: makeToolClient({ tool: countingTool({ counter }), capture }), defaultModel: 'm', journal } });
    ex.setSteps({ stepsList: [STEP] });
    await ex.execute({ userGoal: 'goal' });

    assert.equal(counter.n, 0, 'unknown side-effect state must not be re-run');
    assert.equal(capture.results?.[0]?.success, false);
    assert.match(String(capture.results?.[0]?.error), /state is unknown/);
});

test('S14: sibling steps issuing the same tool call each execute (boundary scoping)', async () => {
    const counter = { n: 0 };
    const journal = new ExecutionJournal();
    const client = { session: () => makeToolSession({ tool: countingTool({ counter }) }) };
    const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', journal } });
    ex.setSteps({ stepsList: [
        { id: 'a', title: 'A', systemPrompt: 's', userPromptTemplate: 'u', dependencies: [] },
        { id: 'b', title: 'B', systemPrompt: 's', userPromptTemplate: 'u', dependencies: [] },
    ] });
    await ex.execute({ userGoal: 'goal' });
    assert.equal(counter.n, 2, 'the step-scoped key must not let b replay a');
});

// ─── SM: checkpoint round-trip + replay ─────────────────────────────────────

test('S14: the SM checkpoint carries and restores the journal', () => {
    const journal = new ExecutionJournal();
    const graph = { entry: 'a', nodes: [{ id: 'a', model: 'm', userPromptTemplate: 'do', terminal: true }], edges: [] };
    const sm = new StateMachine({ graph: graph, options: { client: makeToolClient({ tool: countingTool({ counter: { n: 0 } }) }), defaultModel: 'm', journal } });
    const key = toolJournalKey({ runId: journal.runId, boundary: 'a:v1:b1', name: 'count', args: { n: 1 } });
    journal.complete({ key, outcome: { success: true, result: 'count=SM' } });

    const saved = JSON.parse(sm.save());
    assert.ok(saved.journal, 'the SM save must carry the journal');

    const sm2 = StateMachine.load({ json: sm.save(), graph: graph, options: { client: makeToolClient({ tool: countingTool({ counter: { n: 0 } }) }), defaultModel: 'm' } });
    assert.ok(JSON.parse(sm2.save()).journal, 'load() restores the journal');
});

test('S14: a resumed SM node replays a done tool instead of re-running it', async () => {
    const counter = { n: 0 };
    const capture = /** @type {{results?: any[]}} */ ({});
    const journal = new ExecutionJournal();
    const key = toolJournalKey({ runId: journal.runId, boundary: 'a:v1:b1', name: 'count', args: { n: 1 } });
    journal.complete({ key, outcome: { success: true, result: 'count=SM-REPLAY' } });

    const graph = { entry: 'a', nodes: [{ id: 'a', model: 'm', userPromptTemplate: 'do', tools: [countingTool({ counter, keys: [] })], terminal: true }], edges: [] };
    const sm = new StateMachine({ graph: graph, options: { client: makeToolClient({ tool: countingTool({ counter }), capture }), defaultModel: 'm', journal } });
    await sm.run();

    assert.equal(counter.n, 0, 'the SM node must replay, not re-run');
    assert.equal(capture.results?.[0]?.result, 'count=SM-REPLAY');
});

// ─── runStep forwarding ─────────────────────────────────────────────────────

test('S14: runStep attaches the journal to the session and forwards the boundary prefix', async () => {
    /** @type {any} */
    let seen = null;
    const session = {
        provider: 'OAI',
        model: 'm',
        _lastStepMessages: null,
        withSystemMessage() { return this; },
        withTools() { return this; },
        /** @param {{options: *}} arg0 */
        run({ options }) {
            seen = { journal: /** @type {any} */ (this)._journal, prefix: options.boundaryPrefix };
            return Promise.resolve('x');
        },
    };
    const journal = new ExecutionJournal();
    await runStep({ step: { id: 's1' }, deps: {
        client: { session: () => session }, model: 'm', userText: 'hi',
        journal, journalBoundary: 's1:',
    } });
    assert.equal(seen?.journal, journal, 'the journal rides the session');
    assert.equal(seen?.prefix, 's1:', 'the boundary prefix reaches the loop');
});

// ─── idempotency-key propagation ────────────────────────────────────────────

test('S14: the idempotency key reaches the tool execute context', async () => {
    const counter = { n: 0 };
    const keys = /** @type {string[]} */ ([]);
    const journal = new ExecutionJournal();
    const ex = new WorkflowExecutor({ options: { client: makeToolClient({ tool: countingTool({ counter, keys }) }), defaultModel: 'm', journal } });
    ex.setSteps({ stepsList: [STEP] });
    await ex.execute({ userGoal: 'goal' });

    assert.equal(counter.n, 1);
    assert.equal(keys.length, 1, 'the tool saw the key');
    const expected = toolJournalKey({ runId: journal.runId, boundary: 'a:b1', name: 'count', args: { n: 1 } });
    assert.equal(keys[0], expected, 'the key is the same content-addressed journal key');
});

test('S14: runCommand merges the idempotency key into the child env', async () => {
    const { stdout } = await runCommand({ command: process.execPath, args: ['-e', 'process.stdout.write(process.env.MERCI_IDEMPOTENCY_KEY || "")'], env: { MERCI_IDEMPOTENCY_KEY: 'key-42' } });
    assert.equal(stdout, 'key-42');
});

test('S14: an MCP tool forwards the key as _meta.idempotencyKey', async () => {
    /** @type {any} */
    let call = null;
    const mcpClient = {
        start: async () => {},
        getTools: async () => [{ name: 'remote', inputSchema: { type: 'object', properties: {} } }],
        /** @param {{name: *, args: *, idempotencyKey: *}} arg0 */
        executeTool: async ({ name, args, idempotencyKey }) => {
            call = { name, args, idempotencyKey };
            return { content: [{ type: 'text', text: 'ok' }] };
        },
    };
    const [tool] = await loadMcpTools({ mcpClient: /** @type {any} */ (mcpClient) });
    await /** @type {any} */ (tool).execute({ args: {}, context: { idempotencyKey: 'mcp-key' } });
    assert.equal(call?.idempotencyKey, 'mcp-key');
});

test('S14: an external capability forwards the key in the _merci envelope', async () => {
    /** @type {any} */
    let params = null;
    const cap = new AcpCapability({
        id: 'x',
        client: {
            listTools: async () => [{ name: 'remote', parameters: { type: 'object', properties: {} } }],
            callTool: async (/** @type {any} */ _name, /** @type {any} */ p) => { params = p; return 'ok'; },
        },
    });
    await cap.connect();
    const [tool] = cap.tools();
    await /** @type {any} */ (tool).execute({ args: {}, context: { idempotencyKey: 'ext-key' } });
    assert.equal(params?._merci?.idempotencyKey, 'ext-key');
});
