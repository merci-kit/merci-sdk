// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { resolveAgentClient, withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';

// =============================================================================
// =============================================================================

test('resolveAgentClient: no client/backend falls back to the parent', () => {
    const parent = { provider: 'openai' };
    assert.equal(resolveAgentClient({ parent, agent: null }), parent);
    assert.equal(resolveAgentClient({ parent, agent: {} }), parent);
    assert.equal(resolveAgentClient({ parent, agent: { model: 'm' } }), parent);
});

test('resolveAgentClient: an explicit agent.client wins', () => {
    const parent = { provider: 'openai' };
    const other = { provider: 'anthropic' };
    assert.equal(resolveAgentClient({ parent, agent: { client: other } }), other);
});

test('resolveAgentClient: agent.client + mismatched backend throws', () => {
    const parent = { provider: 'openai' };
    const gai = { provider: 'google_genai' };
    assert.throws(
        () => resolveAgentClient({ parent, agent: { client: gai, provider: 'anthropic' } }),
        /does not match agent\.client\.provider/,
    );
});

test('resolveAgentClient: a registered backend routes to that client', () => {
    const parent = { provider: 'openai' };
    const gai = { provider: 'google_genai' };
    const withMap = { ...parent };
    getSpawnRegistry({ client: withMap }).clients.set('google_genai', gai);
    assert.equal(resolveAgentClient({ parent: withMap, agent: { provider: 'google_genai' } }), gai);

    const withResolver = { ...parent };
    getSpawnRegistry({ client: withResolver }).resolver = /** @type {any} */ ((/** @type {string} */ b) => (b === 'google_genai' ? gai : null));
    assert.equal(resolveAgentClient({ parent: withResolver, agent: { provider: 'google_genai' } }), gai);
});

test('resolveAgentClient: a backend matching the parent stays on the parent', () => {
    const parent = { provider: 'openai' };
    assert.equal(resolveAgentClient({ parent, agent: { provider: 'openai' } }), parent);
});

test('resolveAgentClient: an unregistered differing backend is a loud error', () => {
    const parent = { provider: 'anthropic' };
    assert.throws(() => resolveAgentClient({ parent, agent: { provider: 'google_genai' } }), /no registered client/);
});

test('resolveAgentClient: a parent without a backend label keeps the parent (metadata, not routing)', () => {
    const parent = {};
    assert.equal(resolveAgentClient({ parent, agent: { provider: 'google_genai' } }), parent);
});

// =============================================================================
// =============================================================================

/** @param {{model: any, client: any}} arg0 @returns {any} */
function fakeSession({ model, client }) {
    return {
        model,
        provider: client?.provider ?? 'openai',
        client,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        withSystemMessage(/** @type {any} */ p) { this.systemPrompt = Array.isArray(p) ? p.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : String(p ?? ''); return this; },
        /** @param {{tools: any}} arg0 */
        withTools({ tools }) { this.tools = tools; return this; },
        withRetryPolicy() { return this; },
        withHeaderTimeout() { return this; },
        withMaxElapsedMs() { return this; },
        withApproval() { return this; },
        withBudget() { return this; },
        withCircuitBreaker() { return this; },
        run: async () => `result of ${model}`,
    };
}

/** @returns {any} */
function fakeClient(provider = 'openai') {
    const client = {
        provider,
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

test('task: profile.client routes the child to that client', async () => {
    const parent = fakeClient('openai');
    const other = fakeClient('anthropic');
    withTaskAgents({ client: parent, agents: [{ name: 'a', model: 'm', client: other }] });
    const session = fakeSession({ model: 'parent', client: parent });
    const out = await /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'x', subagent_type: 'a' } });
    assert.equal(out, 'result of m');
    assert.equal(other.created.length, 1, 'child ran on the named client');
    assert.equal(parent.created.length, 0, 'parent client untouched');
});

test('task: profile.provider uses the registered client map', async () => {
    const parent = fakeClient('openai');
    const gai = fakeClient('google_genai');
    withTaskAgents({ client: parent, agents: [{ name: 'a', model: 'm', provider: 'google_genai' }], options: { clients: { google_genai: gai } } });
    const session = fakeSession({ model: 'parent', client: parent });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'x', subagent_type: 'a' } });
    assert.equal(gai.created.length, 1);
    assert.equal(parent.created.length, 0);
});

test('task: profile.provider uses a resolveClient function', async () => {
    const parent = fakeClient('openai');
    const gai = fakeClient('google_genai');
    withTaskAgents({ client: parent, agents: [{ name: 'a', model: 'm', provider: 'google_genai' }], options: { resolveClient: (/** @type {string} */ b) => (b === 'google_genai' ? gai : null) } });
    const session = fakeSession({ model: 'parent', client: parent });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'x', subagent_type: 'a' } });
    assert.equal(gai.created.length, 1);
    assert.equal(parent.created.length, 0);
});

test('task: a matching backend stays on the parent client (no regression)', async () => {
    const parent = fakeClient('openai');
    withTaskAgents({ client: parent, agents: [{ name: 'a', model: 'm', provider: 'openai' }] });
    const session = fakeSession({ model: 'parent', client: parent });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'x', subagent_type: 'a' } });
    assert.equal(parent.created.length, 1);
});

test('task: an unregistered differing backend fails loudly', async () => {
    const parent = fakeClient('anthropic');
    withTaskAgents({ client: parent, agents: [{ name: 'a', model: 'm', provider: 'google_genai' }] });
    const session = fakeSession({ model: 'parent', client: parent });
    await assert.rejects(
        () => /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'x', subagent_type: 'a' } }),
        /no registered client/,
    );
    assert.equal(parent.created.length, 0);
});

// =============================================================================
// =============================================================================

/** @param {{provider: string, label: string}} arg0 @returns {any} */
function makeRoutingClient({ provider, label }) {
    const runs = /** @type {any[]} */ ([]);
    return {
        provider,
        runs,
        /** @param {any} model */
        session(model) {
            const s = {
                provider,
                model,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                /** @param {{initialInput: any}} arg0 */
                async run({ initialInput }) { runs.push({ model, input: initialInput }); return `${label} answer`; },
            };
            return s;
        },
    };
}

test('discussion: agent.client routes its turn to that client', async () => {
    const primary = makeRoutingClient({ provider: 'openai', label: 'primary' });
    const other = makeRoutingClient({ provider: 'anthropic', label: 'other' });
    const group = new DiscussionSession({ client: primary, options: { objective: 'O' } });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', client: other });
    await group.discuss({ instruction: 'Speak.', turns: 1 });
    assert.equal(other.runs.length, 1, 'turn ran on the agent client');
    assert.equal(primary.runs.length, 0, 'group client untouched');
    assert.equal(other.runs[0].model, 'mA');
});

test('discussion: an agent backend matching the group client stays on it', async () => {
    const primary = makeRoutingClient({ provider: 'openai', label: 'primary' });
    const group = new DiscussionSession({ client: primary, options: {} });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    await group.discuss({ instruction: 'Speak.', turns: 1 });
    assert.equal(primary.runs.length, 1);
});
