// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {{model: any, client: any}} arg0 @returns {any} */
function fakeSession({ model, client }) {
    return {
        model,
        provider: client.provider,
        client,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        withSystemMessage() { return this; },
        withTools() { return this; },
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
        session(model) { const s = fakeSession({ model, client }); client.created.push(s); return s; },
    };
    return client;
}

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} client */
    constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

test('task: a session-local roster wins over the client registry', async () => {
    const parent = fakeClient('openai');
    withTaskAgents({ client: parent, agents: [{ name: 'server', model: 'sm' }] });
    const session = fakeSession({ model: 'parent', client: parent });
    session._taskAgents = new Map([['local', { name: 'local', model: 'lm' }]]);
    const tool = /** @type {any} */ (createTaskTool({ session }));

    assert.equal(await tool.execute({ args: { prompt: 'x', subagent_type: 'local' } }), 'result of lm');
    await assert.rejects(() => tool.execute({ args: { prompt: 'x', subagent_type: 'server' } }), /unknown subagent_type/);
});

test('task: a session-local roster cascades to the delegated child', async () => {
    const parent = fakeClient('openai');
    const session = fakeSession({ model: 'parent', client: parent });
    session._taskAgents = new Map([['local', { name: 'local', model: 'lm' }]]);
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await tool.execute({ args: { prompt: 'x', subagent_type: 'local' } });
    assert.equal(parent.created[0]._taskAgents, session._taskAgents, 'the roster cascades to the child');
});

test('session.withTaskAgents registers a local roster with a depth cap', () => {
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), { session() {} });
    s.withTaskAgents({ agents: [{ name: 'a' }] });
    assert.ok(/** @type {any} */ (s)._taskAgents.get('a'));
    assert.equal(/** @type {any} */ (s)._taskMaxDepth, 1);
    assert.throws(() => s.withTaskAgents({ agents: /** @type {any} */ ([{ model: 'x' }]) }), /string name/);
});

test('a session-local depth cap is a ceiling over a deeper profile (E-8)', () => {
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), { session() {} });
    s.withTaskAgents({ agents: [{ name: 'deep', model: 'm', maxDepth: 3 }], options: { maxDepth: 1 } });
    s._taskDepth = 1;
    assert.ok(!s._tools.map((/** @type {any} */ t) => t.name).includes('task'),
        'the host cap wins: min(3, 1) = 1, so depth 1 may not delegate');
});

test('a deep profile raises the implicit depth default on the documented call', () => {
    const s = new MinimalSession(ProviderType.OPENAI, 'gpt-x', new EventEmitter(), { session() {} });
    // The call docs/SPAWNING.md documents: no `options.maxDepth` at all.
    s.withTaskAgents({ agents: [{ name: 'deep', model: 'm', maxDepth: 5 }] });
    s._taskDepth = 1;
    assert.ok(s._tools.map((/** @type {any} */ t) => t.name).includes('task'),
        'the profile raises the implicit default the session installs; it was never a host cap');
});
