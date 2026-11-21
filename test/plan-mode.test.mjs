// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { createPlanStageFollowUp, AGENT_PLAN, AGENT_EXECUTE } from '../lib/agentic/plan/component.mjs';
import { PLAN_STAGE_REMINDER, LOAD_TODOS_TOOL_NAME, MANAGE_TODOS_TOOL_NAME } from '../lib/core/constants/index.mjs';
import { TASK_TOOL_NAME } from '../lib/agentic/task.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

class MinimalSession extends AbstractChatSession {
    
    /** @param {any} provider @param {any} model @param {any} [eventEmitter] @param {any} [client] */
        constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

const readTool = { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => 'file' };
const shellTool = { name: 'shell', description: 'run a command', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => 'ok' };


/** @type {string} */
let tmp;
test.before(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'merci-plan-')); });
test.after(async () => { await rm(tmp, { recursive: true, force: true }); });

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('withPlan enters the plan agent and gates the tool set (todos-backed, task advertised while a profile exists)', () => {
    const b = new ChatSessionBuilder()
        .withTaskAgents({ agents: [{ name: 'worker' }] })
        .withPlan({ options: { filePath: path.join(tmp, 'p.json') } })
        .withPlanTools({ tools: [readTool] });
    assert.equal(b.agent, AGENT_PLAN);
    const names = b._tools.map(/** @type {(...args: any[]) => any} */ (t => t.name)).sort();
    assert.deepEqual(names, [LOAD_TODOS_TOOL_NAME, MANAGE_TODOS_TOOL_NAME, 'plan_exit', 'read', TASK_TOOL_NAME].sort());
});

test('withPlan hides the task tool while no profile is reachable', () => {
    const b = new ChatSessionBuilder()
        .withPlan({ options: { filePath: path.join(tmp, 'p.json') } })
        .withPlanTools({ tools: [readTool] });
    const names = b._tools.map(/** @type {(...args: any[]) => any} */ (t => t.name));
    assert.ok(!names.includes(TASK_TOOL_NAME), `an unexecutable task tool must not be advertised in plan mode: ${names}`);
});

test('withPlan uses the caller-provided todos store and does not clobber it', () => {
    const store =  (new Map([[1, { id: 1, title: 'existing', status: 'pending' }]]));
    const b = new ChatSessionBuilder()
        .withTodos({ store: /** @type {any} */ (store) })
        .withPlan();
    assert.equal(( (/** @type {any} */ (b._todoComponent)))._store, store);
    assert.equal(( (/** @type {any} */ (b._todoComponent)))._store.get(1).title, 'existing');
    assert.equal(b.agent, AGENT_PLAN);
});

test('withPlan rules can deny task delegation', () => {
    const b = new ChatSessionBuilder()
        .withPlan({ options: { rules: { [TASK_TOOL_NAME]: 'deny' } } })
        .withPlanTools({ tools: [readTool] });
    const names = b._tools.map(/** @type {(...args: any[]) => any} */ (t => t.name));
    assert.ok(!names.includes(TASK_TOOL_NAME));
    assert.ok(names.includes('read'));
});

test('withExecute overrides plan: full store back, plan_exit hidden, denies applied', () => {
    const b = new ChatSessionBuilder()
        .withTools({ tools: [shellTool] })
        .withPlan({ options: { filePath: path.join(tmp, 'p.json') } })
        .withPlanTools({ tools: [readTool] })
        .withExecute({ options: { rules: { [TASK_TOOL_NAME]: 'deny' } } });
    assert.equal(b.agent, AGENT_EXECUTE);
    const names = b._tools.map(/** @type {(...args: any[]) => any} */ (t => t.name));
    assert.ok(names.includes('shell'));
    assert.ok(!names.includes('plan_exit'));
    assert.ok(!names.includes('read'));
    assert.ok(!names.includes(TASK_TOOL_NAME));
    assert.ok(names.includes(LOAD_TODOS_TOOL_NAME));
    assert.ok(names.includes(MANAGE_TODOS_TOOL_NAME));
});

test('agent_changed fires on plan -> execute switch', () => {
    const emitter = new EventEmitter();
    
    /** @type {any[]} */
        const seen = [];
    emitter.on('agent_changed', e => seen.push(e));
    const s = new MinimalSession('openrouter', 'm', emitter);
    s.withPlan();
    s.withExecute();
    assert.deepEqual(seen.map(({ from, to }) => ({ from, to })), [
        { from: AGENT_EXECUTE, to: AGENT_PLAN },
        { from: AGENT_PLAN, to: AGENT_EXECUTE }
    ]);
    for (const e of seen) {
        assert.equal(e.event, 'agent_changed');
        assert.equal(typeof e.ts, 'number');
    }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────


/** @param {{session: *}} arg0 */
async function systemContent({ session }) {
    const prepared = await session._prepareStepMessages({ messages: [createUserMessage({ provider: 'openrouter', content: 'hi' })] });
    const sys = prepared.find(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'system_message'));
    return sys.content;
}

test('plan mode injects the read-only reminder with the todos workflow', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan({ options: { filePath: path.join(tmp, 'p.json') } }).withPlanTools({ tools: [readTool] });
    const content = await systemContent({ session: s });
    assert.ok(content.includes('PLAN MODE'));
    assert.ok(content.includes(MANAGE_TODOS_TOOL_NAME));
    assert.ok(content.includes('subagent profiles are registered'), 'the delegation clause is conditional on a registered roster');
});

test('first execute run after plan injects the build-switch reminder once', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan({ options: { filePath: path.join(tmp, 'p.json') } }).withPlanTools({ tools: [readTool] });
    s.withExecute();
    s._planHandoff = true;
    const content = await systemContent({ session: s });
    assert.ok(content.includes('changed from plan to execute'));
    assert.ok(content.includes(path.join(tmp, 'p.json')));
    s._planHandoff = false;
    assert.ok(!(await systemContent({ session: s })).includes('changed from plan to execute'));
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('plan_exit blocks on the coordinator until approval', async () => {
    const emitter = new EventEmitter();
    
    /** @type {any[]} */
        const requested = [];
    
    /** @type {any[]} */
        const resolved = [];
    emitter.on('plan:exit_requested', e => requested.push(e));
    emitter.on('plan:exit_resolved', e => resolved.push(e));
    const s = new MinimalSession('openrouter', 'm', emitter);
    s.withPlan({ options: { filePath: path.join(tmp, 'p.json') } });
    const tool = /** @type {any} */ (s._tools.find(/** @type {(...args: any[]) => any} */ (t => t.name === 'plan_exit')));
    assert.ok(tool);
    assert.ok(tool);
    const resultPromise = tool.execute({ args: {} });
    await new Promise(r => setImmediate(r));
    assert.equal(requested.length, 1);
    assert.equal(requested[0].planPath, path.join(tmp, 'p.json'));
    s.approvePlanExit({ approved: true });
    const result = await resultPromise;
    assert.equal(result.approved, true);
    assert.equal(resolved[0].approved, true);
});

test('declined or pre-resolved plan_exit keeps the agent in plan mode', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan();
    const tool = /** @type {any} */ (s._tools.find(/** @type {(...args: any[]) => any} */ (t => t.name === 'plan_exit')));
    assert.ok(tool);
    s.approvePlanExit({ approved: false });
    const result = await tool.execute({ args: {} });
    assert.equal(result.approved, false);
});

test('a second plan_exit after a pre-resolved one is a FRESH gate, not a stale decision', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan();
    const tool = /** @type {any} */ (s._tools.find(/** @type {(...args: any[]) => any} */ (t => t.name === 'plan_exit')));
    assert.ok(tool);
    s.approvePlanExit({ approved: false });
    const first = await tool.execute({ args: {} });
    assert.equal(first.approved, false);
    s._planExitRequested = false;
    let settled = false;
    const second = tool.execute({ args: {} }).then(/** @type {(...args: any[]) => any} */ (( r) => { settled = true; return r; }));
    await new Promise(r => setImmediate(r));
    assert.equal(settled, false, 'second wait returned a stale approval');
    s.approvePlanExit({ approved: true });
    const result = await second;
    assert.equal(result.approved, true);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('plan_exit sets the run flag', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan();
    const tool = /** @type {any} */ (s._tools.find(/** @type {(...args: any[]) => any} */ (t => t.name === 'plan_exit')));
    assert.ok(tool);
    s.approvePlanExit({ approved: false });
    await tool.execute({ args: {} });
    assert.equal(s._planExitRequested, true);
});

test('stage followUp queues the reminder until plan_exit was called', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan();
    const followUp = createPlanStageFollowUp({ session: /** @type {any} */ (s) });
    assert.equal(followUp({ round: 0 }), PLAN_STAGE_REMINDER);
    s._planExitRequested = true;
    assert.equal(followUp({ round: 1 }), null);
});

test('run() resets the plan_exit flag at entry', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withPlan();
    s._planExitRequested = true;
    await assert.rejects(() => s.run({ initialInput: 'hi' }), /no _adapter set/);
    assert.equal(s._planExitRequested, false);
});
