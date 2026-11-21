// @ts-check
/** Middleware pipeline proofs: tool:before/after/error wired via withHooks. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createHooks, STOP, HOOKS } from '../lib/core/hooks.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { AbstractChatSession, BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { drainStepWithHooks } from '../lib/agentic/agentic-core.mjs';

const schema = { type: 'object', properties: {} };

class MinimalSession extends AbstractChatSession {
    constructor(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ eventEmitter, /** @type {any} */ client) {
        super({ provider, model, eventEmitter, client });
    }
}

test('withHooks stores the registry on the session and is fail-loud', () => {
    const s = new MinimalSession('openai', 'm', new EventEmitter(), {});
    const hooks = createHooks();
    assert.equal(s.withHooks({ hooks }), s);
    assert.equal(s._hooks, hooks);
    assert.throws(() => s.withHooks({ hooks: /** @type {any} */ (null) }), /HookRegistry/);
});

test('tool:before can transform the parsed args', async () => {
    const hooks = createHooks();
    let seen = null;
    const tool = { name: 'echo', parameters: schema, execute: async (/** @type {any} */ { args }) => { seen = args; return 'ok'; } };
    hooks.add({ name: HOOKS.TOOL_BEFORE, fn: (/** @type {any} */ call) => ({ ...call, args: { n: 42 } }) });
    await executeTools({ toolCalls: [{ id: '1', name: 'echo', args: '{}' }], toolLibrary: [tool], hooks });
    assert.deepEqual(seen, { n: 42 });
});

test('tool:before returning STOP blocks execution', async () => {
    const hooks = createHooks();
    let ran = false;
    const tool = { name: 'danger', parameters: schema, execute: async () => { ran = true; return 'x'; } };
    hooks.add({ name: HOOKS.TOOL_BEFORE, fn: () => STOP });
    const [res] = /** @type {any[]} */ (await executeTools({ toolCalls: [{ id: '1', name: 'danger', args: '{}' }], toolLibrary: [tool], hooks }));
    assert.equal(ran, false);
    assert.equal(res.success, false);
    assert.equal(res.blocked, true);
});

test('tool:after transforms the result', async () => {
    const hooks = createHooks();
    const tool = { name: 'echo', parameters: schema, execute: async () => 'raw' };
    hooks.add({ name: HOOKS.TOOL_AFTER, fn: (/** @type {any} */ v) => `${v}!` });
    const [res] = /** @type {any[]} */ (await executeTools({ toolCalls: [{ id: '1', name: 'echo', args: '{}' }], toolLibrary: [tool], hooks }));
    assert.equal(res.result, 'raw!');
});

test('tool:error hooks run when a tool throws, and the tool still fails', async () => {
    const hooks = createHooks();
    /** @type {string[]} */
    const seen = [];
    hooks.add({ name: HOOKS.TOOL_ERROR, fn: (/** @type {any} */ ctx) => { seen.push(ctx.error); } });
    const tool = { name: 'boom', parameters: schema, execute: async () => { throw new Error('kaboom'); } };
    const [res] = /** @type {any[]} */ (await executeTools({ toolCalls: [{ id: '1', name: 'boom', args: '{}' }], toolLibrary: [tool], hooks }));
    assert.equal(res.success, false);
    assert.deepEqual(seen, ['kaboom']);
});

test('request:before transforms the built vendor request end-to-end', async () => {
    /** @type {any} */
    let seenRequest = null;
    /** @type {any} */
    let seenObservability = null;
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: { marker: 'original' }, observability: { model: 'm' } }),
        executeVendorRequest: (/** @type {any} */ { request }) => { seenRequest = request; return {}; },
        consumeStream: async function* () { yield { type: 'text', content: 'hi' }; },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} }),
    };
    const session = new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: new EventEmitter(),
        provider: ProviderType.OPENAI,
        adapter,
        buildParameters: (/** @type {any} */ { s }) => s,
    });
    session._onStepShouldPrepare = () => false;
    const hooks = createHooks();
    hooks.add({ name: HOOKS.REQUEST_BEFORE, fn: (/** @type {any} */ value, /** @type {any} */ ctx) => {
        seenObservability = ctx.observability;
        return { ...value, marker: 'transformed' };
    } });
    session.withHooks({ hooks });

    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    assert.equal(seenRequest.marker, 'transformed');
    assert.equal(seenObservability.model, 'm');
    assert.equal((/** @type {any} */ (r.value)).done, true);
});

test('session._hooks reaches executeTools through drainStepWithHooks', async () => {
    /** @type {any} */
    let seenArgs = null;
    const tools = [{ name: 'echo', parameters: schema, execute: async (/** @type {any} */ { args }) => { seenArgs = args; return 'pong'; } }];
    const hooks = createHooks();
    hooks.add({ name: HOOKS.TOOL_BEFORE, fn: (/** @type {any} */ call) => ({ ...call, args: { n: 42 } }) });
    async function* gen() {
        yield { type: 'tool_request', calls: [{ id: 'c1', name: 'echo', args: '{}' }] };
        return { done: false, messages: [] };
    }
    const out = await drainStepWithHooks({ gen: gen(), tools, hooks });
    assert.deepEqual(seenArgs, { n: 42 });
    assert.ok(out && out.usage);
});
