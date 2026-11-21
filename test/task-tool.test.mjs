// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';

import { withTaskAgents, createTaskTool, TASK_TOOL_NAME } from '../lib/agentic/task.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { RunContext } from '../lib/core/events.mjs';
import { ProviderType, CAPABILITY, FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

// =============================================================================
// Stubs
// =============================================================================

/** @param {{model: any, client: any}} arg0 @returns {any} */
function fakeSession({ model, client }) {
    return {
        model,
        provider: ProviderType.OPENAI,
        client,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        systemPrompt: null,
        tools: null,
        withSystemMessage(/** @type {any} */ p) {
            // SP6: the system may be a block list (role template + adaptation).
            this.systemPrompt = Array.isArray(p)
                ? p.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n')
                : p;
            return this;
        },
        /** @param {{tools: any}} arg0 */
        withTools({ tools }) { this.tools = tools; return this; },
        /** @param {{policy: any}} arg0 */
        withRetryPolicy({ policy }) { (/** @type {any} */ (this)).retryPolicy = policy; return this; },
        /** @param {{ms: any}} arg0 */
        withHeaderTimeout({ ms }) { (/** @type {any} */ (this)).headerTimeoutMs = ms; return this; },
        /** @param {{ms: any}} arg0 */
        withMaxElapsedMs({ ms }) { (/** @type {any} */ (this)).maxElapsedMs = ms; return this; },
        /** @param {{breaker: any}} arg0 */
        withCircuitBreaker({ breaker }) { (/** @type {any} */ (this)).circuitBreaker = breaker; return this; },
        run: async () => `result of ${model}`,
    };
}

/** @returns {any} */
function fakeClient() {
    const client = {
        created: /** @type {any[]} */ ([]),
        /** @param {any} model */
        session(model) {
            const s = fakeSession({ model, client });
            client.created.push(s);
            return s;
        },
    };
    return client;
}

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} client */
    constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

// =============================================================================
// Registry (withTaskAgents)
// =============================================================================

test('withTaskAgents: registers profiles, keyed by name, and returns the client', () => {
    const client = /** @type {any} */ ({});
    const out = withTaskAgents({ client, agents: [{ name: 'a' }, { name: 'b' }] });
    assert.equal(out, client, 'fluent');
    const registry = getSpawnRegistry({ client });
    assert.ok(registry.agents instanceof Map);
    assert.deepEqual(registry.agents.get('a'), { name: 'a' });
    assert.deepEqual([...registry.agents.keys()], ['a', 'b']);
    assert.equal(registry.maxDepth, 1, 'default depth');
    assert.equal('_taskAgents' in client, false, 'the client is a transport: no roster field');
});

test('withTaskAgents: merges across calls, later duplicate wins', () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'a', model: 'm1' }] });
    withTaskAgents({ client, agents: [{ name: 'a', model: 'm2' }, { name: 'c' }] });
    assert.equal(getSpawnRegistry({ client }).agents.size, 2);
    assert.equal(getSpawnRegistry({ client }).agents.get('a')?.model, 'm2');
});

test('withTaskAgents: honors maxDepth option', () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'a' }], options: { maxDepth: 3 } });
    assert.equal(getSpawnRegistry({ client }).maxDepth, 3);
});

test('withTaskAgents: re-registration without options preserves the configured maxDepth', () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'a' }], options: { maxDepth: 3 } });
    withTaskAgents({ client, agents: [{ name: 'b' }] });
    assert.equal(getSpawnRegistry({ client }).maxDepth, 3, 'a second registration must not reset the nesting cap');
    withTaskAgents({ client, agents: [{ name: 'c' }], options: { maxDepth: 5 } });
    assert.equal(getSpawnRegistry({ client }).maxDepth, 5, 'an explicit option still wins');
});

test('withTaskAgents: throws when a profile has no name', () => {
    assert.throws(() => withTaskAgents({ client: /** @type {any} */ ({}), agents: /** @type {any} */ ([{ prompt: 'x' }]) }), /string name/);
    assert.throws(() => withTaskAgents({ client: /** @type {any} */ (null), agents: [] }), /client is required/);
});

// =============================================================================
// Gating: advertised only while it can execute
// =============================================================================

test('a session with no registered profiles does not advertise the task tool', () => {
    const stubSdk = { session() {} };
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), stubSdk);
    const names = s._tools.map((/** @type {any} */ t) => t.name);
    assert.ok(!names.includes(TASK_TOOL_NAME), `an unexecutable task tool must not be advertised: ${names}`);
    assert.ok(s._capabilityTools.has(CAPABILITY.TASK), 'the capability stays registered internally');
});

test('registering a profile advertises the task tool with the live roster in its description', () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'worker', description: 'writes code' }] });
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), client);
    const task = /** @type {any} */ (s._tools.find((/** @type {any} */ t) => t.name === TASK_TOOL_NAME));
    assert.ok(task, 'task tool advertised once a profile exists');
    assert.match(String(task.description), /Available subagents: worker — writes code/);
});

test('a caller-supplied tool named task is dropped by the reserved-name rule', () => {
    const stubSdk = { session() {} };
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), stubSdk);
    s.withTools({ tools: [{ name: 'task', description: 'caller tool', parameters: { type: 'object', properties: {} } }] });
    const names = s._tools.map((/** @type {any} */ t) => t.name);
    assert.deepEqual(names, [], 'the reserved name never reaches the wire while the built-in capability is registered');
});

test('a session beyond every profile depth cap does not advertise the task tool', () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'child' }], options: { maxDepth: 1 } });
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), client);
    s._taskDepth = 1;
    assert.ok(!s._tools.map((/** @type {any} */ t) => t.name).includes(TASK_TOOL_NAME), 'a task tool that can only throw must be hidden');
    s._taskDepth = 0;
    assert.ok(s._tools.map((/** @type {any} */ t) => t.name).includes(TASK_TOOL_NAME), 'below the cap it stays advertised');
});

test('a profile-specific maxDepth keeps the task tool visible below that cap', () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'deep', model: 'child', maxDepth: 3 }], options: { maxDepth: 1 } });
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), client);
    s._taskDepth = 1;
    assert.ok(s._tools.map((/** @type {any} */ t) => t.name).includes(TASK_TOOL_NAME), 'the deep profile can still be reached from depth 1');
});

// =============================================================================
// Foreground execution
// =============================================================================

test('task: unknown subagent_type throws', async () => {
    const client = fakeClient();
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await assert.rejects(
        () => tool.execute({ args: { prompt: 'x', subagent_type: 'nope' } }),
        /unknown subagent_type "nope"/,
    );
});

test('task: unknown subagent_type lists the available profiles so the model can retry', async () => {
    const client = /** @type {any} */ ({});
    withTaskAgents({ client, agents: [{ name: 'alpha' }, { name: 'beta', description: 'second' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await assert.rejects(
        () => tool.execute({ args: { prompt: 'x', subagent_type: 'nope' } }),
        /unknown subagent_type "nope"\. Available: alpha, beta/,
    );
});

test('task: depth limit throws with a hint', async () => {
    const client = fakeClient();
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'child' }], options: { maxDepth: 1 } });
    const session = fakeSession({ model: 'parent', client });
    session._taskDepth = 1;
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await assert.rejects(() => tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } }), /depth limit reached \(1\)/);
});

test('task: foreground returns the child text; child inherits model, prompt, tools, depth', async () => {
    const client = fakeClient();
    withTaskAgents({ client, agents: [
        { name: 'coder', model: 'child-model', systemPrompt: 'be terse', tools: [{ name: 'grep' }] },
    ] });
    const session = fakeSession({ model: 'parent-model', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    const out = await tool.execute({ args: { prompt: 'write x', subagent_type: 'coder' } });
    assert.equal(out, 'result of child-model');
    assert.equal(client.created.length, 1);
    const child = client.created[0];
    assert.equal(child.model, 'child-model');
    assert.equal(child.systemPrompt, 'be terse');
    assert.deepEqual(child.tools, [{ name: 'grep' }]);
    assert.equal(child._taskDepth, 1, 'child starts one level deeper');
});

test('task: profile without model falls back to the parent session model', async () => {
    const client = fakeClient();
    withTaskAgents({ client, agents: [{ name: 'plain' }] });
    const session = fakeSession({ model: 'parent-model', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await tool.execute({ args: { prompt: 'x', subagent_type: 'plain' } });
    assert.equal(client.created[0].model, 'parent-model');
});

test('task: code-agent profile bypasses the LLM', async () => {
    const client = fakeClient();
    withTaskAgents({ client, agents: [{ name: 'fn', execute: async (/** @type {any} */ o) => `code:${o.prompt}` }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    const out = await tool.execute({ args: { prompt: 'hi', subagent_type: 'fn' } });
    assert.equal(out, 'code:hi');
    assert.equal(client.created.length, 0, 'no LLM child session for a code agent');
});

test('task: code agent returning { content } unwraps content', async () => {
    const client = fakeClient();
    withTaskAgents({ client, agents: [{ name: 'obj', execute: async () => ({ content: 'wrapped' }) }] });
    const tool = /** @type {any} */ (createTaskTool({ session: fakeSession({ model: 'parent', client }) }));
    assert.equal(await tool.execute({ args: { prompt: 'x', subagent_type: 'obj' } }), 'wrapped');
});

// =============================================================================
// Background
// =============================================================================

test('task: background returns immediately and emits task:finish when done', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'bg result';
        };
        client.created.push(s);
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));

    const finished = once(session.eventEmitter, 'task:finish');
    const out = await tool.execute({ args: { prompt: 'x', subagent_type: 'worker', background: true } });

    assert.match(out, /background \(id: task_1\)/, 'immediate running answer');
    assert.equal(client.created.length, 1, 'child session created synchronously');
    const [evt] = await finished;
    assert.equal(evt.result, 'bg result');
    assert.equal(evt.subagent_type, 'worker');
});

test('task: background child failure emits task:error (the single source of truth)', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('boom');
        };
        client.created.push(s);
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));

    const errored = once(session.eventEmitter, 'task:error');
    await tool.execute({ args: { prompt: 'x', subagent_type: 'worker', background: true } });
    const [evt] = await errored;
    assert.match(evt.error, /boom/, 'the actionable error preserves the root cause');
    assert.equal(evt.id, 'task_1');
});

test('task: the background promise is joinable via the spawn registry and pruned on settle', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'bg result';
        };
        client.created.push(s);
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));

    const finished = once(session.eventEmitter, 'task:finish');
    await tool.execute({ args: { prompt: 'x', subagent_type: 'worker', background: true } });
    const running = getSpawnRegistry({ client }).background.get('task_1');
    assert.ok(running instanceof Promise, 'task must be registered while running');
    await finished;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(getSpawnRegistry({ client }).background.has('task_1'), false, 'settled task must be pruned');
});

test('task: background completion events carry the same runId as task:start', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'bg result';
        };
        client.created.push(s);
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    /** @type {any[]} */
    const seen = [];
    session.eventEmitter.on('task:start', (/** @type {any} */ e) => seen.push(e));
    session.eventEmitter.on('task:finish', (/** @type {any} */ e) => seen.push(e));

    const runContext = new RunContext({ sessionId: 's1' });
    await tool.execute({ args: { prompt: 'x', subagent_type: 'worker', background: true }, context: { runContext } });
    await new Promise((r) => setTimeout(r, 20));

    const start = seen.find((e) => e.event === 'task:start');
    const finish = seen.find((e) => e.event === 'task:finish');
    assert.equal(start?.runId, runContext.runId, 'task:start carries the enclosing step runId');
    assert.equal(finish?.runId, start.runId, 'task:finish must correlate with its start');

    /** @type {any[]} */
    const errors = [];
    session.eventEmitter.on('task:error', (/** @type {any} */ e) => errors.push(e));
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => { throw new Error('bg boom'); };
        return s;
    };
    await tool.execute({ args: { prompt: 'y', subagent_type: 'worker', background: true }, context: { runContext } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(errors[0]?.runId, start.runId, 'task:error must correlate with its start');
});

// =============================================================================
// Events
// =============================================================================

test('task: foreground emits task:start and task:finish', async () => {
    const client = fakeClient();
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    /** @type {any[]} */
    const seen = [];
    session.eventEmitter.on('task:start', (/** @type {any} */ e) => seen.push(['start', e]));
    session.eventEmitter.on('task:finish', (/** @type {any} */ e) => seen.push(['finish', e]));
    await tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } });
    assert.deepEqual(seen.map(([k]) => k), ['start', 'finish']);
    assert.equal(seen[0][1].subagent_type, 'worker');
    assert.equal(seen[1][1].result, 'result of m');
});

test('task: foreground failure emits task:error and rethrows', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => { throw new Error('kaboom'); };
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    const errored = once(session.eventEmitter, 'task:error');
    await assert.rejects(() => tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } }), /kaboom/);
    const [evt] = await errored;
    assert.match(evt.error, /kaboom/, 'the actionable error preserves the root cause');
});

test('task: SDK fallback output from a child is a failed delegation, not a result', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => FALLBACK_MESSAGE.EMPTY_RESPONSE;
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    const errored = once(session.eventEmitter, 'task:error');
    await assert.rejects(() => tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } }), /returned no usable output/);
    const [evt] = await errored;
    assert.match(evt.error, /no usable output/);
});

test('task: empty or whitespace-only child output is a failed delegation too', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => '   ';
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = fakeSession({ model: 'parent', client });
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await assert.rejects(() => tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } }), /returned no usable output/);
});

test('task: truncated-but-real content still counts as a deliverable', async () => {
    const client = fakeClient();
    client.session = (/** @type {any} */ model) => {
        const s = fakeSession({ model, client });
        s.run = async () => 'real itinerary\n\n[Note: response truncated by the model\'s output token limit — the answer above may be incomplete.]';
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const tool = /** @type {any} */ (createTaskTool({ session: fakeSession({ model: 'parent', client }) }));
    const out = await tool.execute({ args: { prompt: 'x', subagent_type: 'worker' } });
    assert.match(out, /real itinerary/);
});
