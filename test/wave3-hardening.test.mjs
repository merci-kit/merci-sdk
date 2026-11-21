// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TodoComponent } from '../lib/agentic/todos/component.mjs';
import { isToolAllowed } from '../lib/agentic/plan/component.mjs';
import { SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { InactivityTimeoutPolicy } from '../lib/support/stream-timeout.mjs';
import { drainStepWithHooks } from '../lib/agentic/agentic-core.mjs';
import { withTaskAgents } from '../lib/agentic/task.mjs';
import { CommandDispatcher } from '../lib/agentic/cli/launcher.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';

test('todos: a filePath store hydrates on load (was write-only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-todos-'));
    try {
        const filePath = join(dir, 'todos.json');
        await writeFile(filePath, JSON.stringify({
            version: '1.0',
            tasks: [{ id: 1, title: 'persisted task', status: 'in_progress' }],
        }));
        const component = new TodoComponent({ store: undefined, filePath });
        const block =  (await component.load());
        assert.ok(/** @type {any} */ (block).includes('persisted task'), 'the persisted task must be served');
        assert.equal(component._store.size, 1);
        const list = await component.save({ args: { action: 'list' } });
        assert.equal( (/** @type {any} */ (list)).tasks.length, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('isToolAllowed: a nameless tool is denied even under *:allow', () => {
    assert.equal(isToolAllowed({ name: null, rules: { '*': 'allow' } }), false, 'nameless tools cannot be allowlisted');
    assert.equal(isToolAllowed({ name: '', rules: { '*': 'allow' } }), false);
    assert.equal(isToolAllowed({ name: 'read', rules: { '*': 'deny', read: 'allow' } }), true);
    assert.equal(isToolAllowed({ name: 'write', rules: { '*': 'deny' } }), false);
    assert.equal(isToolAllowed({ name: 'task', rules: { '*': 'allow', task: 'deny' } }), false);
});

test('SSEParser: empty data: heartbeat lines do not break the stream', () => {
    const parser = new SSEParser();
    assert.equal(parser.parseLine({ line: 'data:' }), null, 'an empty heartbeat must be ignored');
    assert.equal(parser.parseLine({ line: 'data: ' }), null);
    const ev =  (parser.parseLine({ line: 'data: {"type":"Content","content":"hi"}' }));
    assert.equal(/** @type {any} */ (ev).type, 'text');
    assert.equal(/** @type {any} */ (ev).content, 'hi');
});

test('InactivityTimeoutPolicy: onTimeoutAbort sees the latched STREAM_TIMEOUT reason', async () => {
    const policy = new InactivityTimeoutPolicy({ timeoutMs: 15 });
    const stalled = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
    let abortedWith = null;
    const reentrant = new AbortController();
    /** @param {{err: *}} arg0 */
    /** @param {{err: *}} arg0 */
    const wrapped = policy.wrapStream({ stream: stalled, signal: reentrant.signal, onTimeoutAbort: /** @type {(...args: any[]) => any} */ (({ err }) => {
        abortedWith = err;
        reentrant.abort(err);
    }) });
    await assert.rejects(() => wrapped[Symbol.asyncIterator]().next(),
        (e) => (/** @type {any} */ (e)).code === 'STREAM_TIMEOUT', 'the timeout code must survive the re-entrant abort');
    assert.equal(( (/** @type {any} */ (abortedWith)))?.code, 'STREAM_TIMEOUT');
});

test('drainStepWithHooks: a tool_request with no calls is tolerated', async () => {
    const gen = (async function* () {
        yield { type: 'tool_request' };
        return { done: true, messages: [] };
    })();
    /** @type {any[]} */
    const events =  ([]);
    const result = await drainStepWithHooks({ gen, tools: [], onEvent:  (/** @type {(...args: any[]) => any} */ ((e) => events.push(e))) });
    assert.ok(result, 'must not throw on a call-less tool_request');
    assert.ok(!events.some(e => e.type === 'tool_call_start'), 'no start events without calls');
});

test('background task ids never produce task_NaN', async () => {
    const client = new EventEmitter();
    // SP5: the background counter lives in the spawn registry; withTaskAgents
    // initialises it, so an id can never be `task_NaN`.
    withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'x', execute: async () => 'done' }] });
    const session = {
        client,
        model: 'm',
        provider: 'openai',
        eventEmitter: client,
    };
    const tool = (await import('../lib/agentic/task.mjs')).createTaskTool({ session: /** @type {any} */ (session) });
    const started = await ( (/** @type {any} */ (tool))).execute({
        args: { prompt: 'do it', subagent_type: 'x', background: true },
        signal: new AbortController().signal
    });
    assert.match(started, /task_1\b/, 'the id must be numeric, never NaN');
    await new Promise((r) => setTimeout(r, 20));
});

test('launcher: skill dispatch matches case-insensitively', () => {
    const cmd = CommandDispatcher.parse({ input: '/MySkill do the thing' });
    assert.equal(cmd.command, '/myskill');
    /** @param {{s: *}} arg0 */
    /** @param {{s: *}} arg0 */
    const cmdOf =  (/** @type {(...args: any[]) => any} */ (({ s }) => (s.command ?? s.name).startsWith('/') ? (s.command ?? s.name) : `/${s.command ?? s.name}`));
    const skill = { name: 'MySkill', command: null };
    assert.equal(cmdOf({ s: skill }).toLowerCase() === cmd.command, true, 'a mixed-case skill must dispatch');
});

test('executor: a fallback-message step output fails the step and never completes it (constants, no drift)', async () => {
    let replanned = false;
    let evaluated = false;
    const executor = new WorkflowExecutor({ options: {
        client: { session: () => ({ provider: 'openai' }) },
        defaultModel: 'm',
        engine: 'discussion',
        agents: [{ name: 'alpha', execute: async () => FALLBACK_MESSAGE.MAX_ITERATIONS }],
    } });
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: '', userPromptTemplate: 'x', dependencies: [] }] });
    await assert.rejects(
        () => executor.execute({ userGoal: 'goal', planner: {
            replan: async () => { replanned = true; return { steps: [{ id: 'a', title: 'A', systemPrompt: '', userPromptTemplate: 'x', dependencies: [] }] }; },
        }, evaluator: { evaluate: async () => { evaluated = true; return { replanRequired: true, reason: 'x' }; } } }),
        /discussion produced no usable output|halted due to failures/,
        'a fallback from the swarm must fail the step, never complete it'
    );
    assert.equal(replanned, true, 'D4: the failed step is offered to the replan');
    assert.equal(evaluated, false, 'the evaluator must never see a fallback-completed step');
});
