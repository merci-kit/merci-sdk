// @ts-check

/**
 * Wave 10 / E4 — a foreground subagent is not a black box.
 *
 * `runTaskChild` could already take an `onChildEvent` forwarder (the discussion/MAA
 * path used it), but the task tool never passed one: a caller watching the event stream
 * saw `task:start` and `task:finish` and nothing the child actually did. The child's
 * text, thoughts and tool calls now reach the parent emitter, correlated to the
 * spawning step.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { RunContext } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {{model: any, client: any, onEvent?: ((e: any) => void)|null}} arg0 */
function fakeSession({ model, client, onEvent = null }) {
    return /** @type {any} */ ({
        model,
        provider: ProviderType.OPENAI,
        client,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        systemPrompt: null,
        tools: null,
        withSystemMessage(/** @type {any} */ p) { this.systemPrompt = p; return this; },
        withTools({ tools } = /** @type {any} */ ({})) { this.tools = tools; return this; },
        withRetryPolicy() { return this; },
        withHeaderTimeout() { return this; },
        withMaxElapsedMs() { return this; },
        withCircuitBreaker() { return this; },
        async run({ options } = /** @type {any} */ ({})) {
            if (onEvent) options?.onEvent?.(onEvent);
            return `result of ${model}`;
        },
    });
}

/** @param {((e: any) => void)|null} [onEvent] */
function fakeClient(onEvent = null) {
    /** @type {any} */
    const client = {
        provider: ProviderType.OPENAI,
        created: [],
        session(/** @type {any} */ model) {
            const s = fakeSession({ model, client, onEvent });
            client.created.push(s);
            return s;
        },
    };
    return client;
}

test('E4/child-events: a foreground subagent streams its text and tool calls to the parent', async () => {
    let childSession = null;
    const client = {
        provider: ProviderType.OPENAI,
        created: /** @type {any[]} */ ([]),
        session(/** @type {any} */ model) {
            const s = fakeSession({ model, client });
            childSession = s;
            childSession.run = async (/** @type {any} */ { options } = {}) => {
                options?.onEvent?.({ type: 'text', content: 'CHILD-TEXT' });
                options?.onEvent?.({ type: 'thought', content: 'CHILD-THOUGHT' });
                options?.onEvent?.({ type: 'tool_call_start', name: 'read_file', args: { path: 'a.txt' } });
                options?.onEvent?.({ type: 'tool_call_end', name: 'read_file', result: 'ok' });
                return 'child answer';
            };
            client.created.push(s);
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));

    /** @type {any[]} */
    const texts = [];
    /** @type {any[]} */
    const thoughts = [];
    /** @type {any[]} */
    const tools = [];
    session.eventEmitter.on('workflow:step_text', (/** @type {any} */ e) => texts.push(e));
    session.eventEmitter.on('workflow:step_thought', (/** @type {any} */ e) => thoughts.push(e));
    session.eventEmitter.on('workflow:step_tool_call_start', (/** @type {any} */ e) => tools.push(e));

    const runContext = new RunContext({ runId: 'parent-run' });
    const answer = await tool.execute({ args: { prompt: 'x', subagent_type: 'worker' }, context: { runContext } });

    assert.equal(answer, 'child answer');
    assert.equal(texts.length, 1, 'the child text reached the parent');
    assert.equal(texts[0].content, 'CHILD-TEXT');
    assert.equal(texts[0].subagent, 'worker', 'the event says which subagent');
    assert.equal(texts[0].runId, 'parent-run', 'correlated to the spawning step');
    assert.equal(thoughts[0]?.content, 'CHILD-THOUGHT');
    assert.equal(tools[0]?.name, 'read_file');
    assert.deepEqual(tools[0]?.args, { path: 'a.txt' });
    void childSession;
});

test('E4/no-listener: forwarding does not require a parent listener', async () => {
    const client = fakeClient((e) => { if (e.type === 'text') return; });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    const answer = await tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } });
    assert.equal(answer, 'result of m');
});

test('E3/lineage: the child run hangs off the spawning step, and the forwarded tool event names the subagent', async () => {
    /** @type {any[]} */
    const childContexts = [];
    const client = {
        provider: ProviderType.OPENAI,
        created: /** @type {any[]} */ ([]),
        session(/** @type {any} */ model) {
            const s = fakeSession({ model, client });
            s.run = async (/** @type {any} */ { options } = {}) => {
                childContexts.push(options?.runContext ?? null);
                options?.onEvent?.({ type: 'tool_call_start', name: 'read_file', args: { path: 'a.txt' } });
                options?.onEvent?.({ type: 'text', content: 'done' });
                return `result of ${model}`;
            };
            client.created.push(s);
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    /** @type {any[]} */
    const tools = [];
    /** @type {any[]} */
    const texts = [];
    session.eventEmitter.on('workflow:step_tool_call_start', (/** @type {any} */ e) => tools.push(e));
    session.eventEmitter.on('workflow:step_text', (/** @type {any} */ e) => texts.push(e));

    const parentCtx = new RunContext({ runId: 'parent-run' });
    /** @type {any} */ (parentCtx)._stepId = 'node-1';
    await tool.execute({ args: { prompt: 'x', subagent_type: 'worker' }, context: { runContext: parentCtx } });

    const child = childContexts[0];
    assert.ok(child, 'the child run received a context');
    assert.equal(child.parentRunId, 'parent-run', 'the child is not a new root');
    assert.notEqual(child.runId, 'parent-run', 'and it has its own run id');
    assert.equal(child._stepId, 'node-1', 'a child context inherits the step id');
    assert.equal(texts[0]?.stepId, 'node-1', 'the forwarded event names the node, not "task"');
    assert.equal(tools[0]?.subagent, 'worker', 'tool events name the subagent too');
});

test('N3/listener-isolation: a throwing parent listener does not abort the child', async () => {
    const client = {
        provider: ProviderType.OPENAI,
        created: /** @type {any[]} */ ([]),
        session(/** @type {any} */ model) {
            const s = fakeSession({ model, client });
            s.run = async (/** @type {any} */ { options } = {}) => {
                // A real child streams; the forwarded text is what the listener throws on.
                options?.onEvent?.({ type: 'text', content: 'streamed' });
                return `result of ${model}`;
            };
            client.created.push(s);
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    session.eventEmitter.on('workflow:step_text', () => { throw new Error('listener boom'); });
    const answer = await tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } });
    assert.equal(answer, 'result of m', 'the child still completed');
});
