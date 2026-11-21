// @ts-check

/**
 * Wave 6 / SP6 — role templates with per-spawn adaptation (D11).
 *
 * The contract: a role's system prompt is a **reusable template**, each spawn may
 * adapt it, and the template must stay the cacheable prefix. That requires the
 * split system the audit's Q3 flagged: `normalizeToAAI` currently joins every
 * system row into ONE string, so a per-block `cache_control` on the template is
 * impossible, and the per-spawn brief would poison the cache prefix.
 *
 * These checks are written against that tree and are expected to fail until the
 * split lands. The oracle is the real request body the Anthropic adapter builds
 * (the wave-4 harness), not the module asserting about itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { normalizeToAAI, createUserMessage, createAssistantMessage, createSystemMessage } from '../lib/messaging/messages.mjs';

/** @param {string} provider @returns {any} */
function childSession(provider) {
    const Ctor = provider === 'anthropic' ? AaiChatSession : OaiChatSession;
    return new Ctor({
        client: { messages: { create: async () => { throw new Error('no transport in this check'); } } },
        model: provider === 'anthropic' ? 'claude-sonnet-test' : 'gpt-test',
        eventEmitter: new EventEmitter(),
    });
}

/** @param {string} provider @returns {any} */
function makeClient(provider) {
    /** @type {any[]} */
    const sessions = [];
    /** @returns {any} */
    function makeChild() {
        const s = childSession(provider);
        // The delegation run builds the request; capture it there (the fake
        // transport has no wire, so the run may throw afterwards — irrelevant).
        // A per-session proxy: `_adapter` is a shared singleton, so wrapping it
        // in place would leak the capture into the next child.
        const shared = s._adapter;
        s._adapter = Object.create(shared);
        s._adapter.buildVendorRequest = (/** @type {any} */ args) => {
            const out = shared.buildVendorRequest(args);
            s.captured = out.request;
            return out;
        };
        sessions.push(s);
        return s;
    }
    return {
        provider,
        sessions,
        session() { return makeChild(); },
        sessionWithId() { return makeChild(); },
    };
}

/**
 * The request the adapter actually builds (wave-4 harness).
 * @param {any} session @param {any[]} messages
 * @returns {Promise<any>}
 */
async function captureRequest(session, messages) {
    /** @type {any} */
    let captured = null;
    const original = session._adapter.buildVendorRequest;
    session._adapter.buildVendorRequest = (/** @type {any} */ args) => {
        const out = original(args);
        captured = out.request;
        return out;
    };
    try {
        const gen = session.step({ messages });
        let step = await gen.next();
        while (!step.done) {
            const event = step.value;
            step = await gen.next(event?.type === 'tool_request' ? [] : undefined);
        }
    } catch {
        // no wire in this check; the request is already built
    } finally {
        session._adapter.buildVendorRequest = original;
    }
    assert.ok(captured, 'the adapter built a request');
    return captured;
}

/** @param {any} request @returns {any[]} */
const systemBlocks = (request) => (Array.isArray(request.system)
    ? request.system
    : (request.system ? [{ type: 'text', text: request.system }] : []));

// ─── The normalizer must stop merging the two kinds ────────────────────────

test('W6R/aai-plain: one plain system row still becomes one string', () => {
    const { system } = normalizeToAAI({ msgs: [createSystemMessage({ provider: 'openai', content: 'ROLE' })] });
    assert.equal(typeof system, 'string', 'the shape is unchanged for a single plain row');
});

test('W6R/aai-merge: two plain system rows still join into one string', () => {
    const { system } = normalizeToAAI({
        msgs: [
            createSystemMessage({ provider: 'openai', content: 'ONE' }),
            createSystemMessage({ provider: 'openai', content: 'TWO' }),
        ],
    });
    assert.equal(typeof system, 'string');
    const text = /** @type {string} */ (system);
    assert.ok(text.includes('ONE') && text.includes('TWO'), 'both parts are there');
});

test('W6R/aai-split: block content is preserved as blocks, cache marker and all', () => {
    const row = {
        role: 'system',
        content: [
            { type: 'text', text: 'ROLE TEMPLATE', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'THIS SPAWN: focus on auth' },
        ],
    };
    const { system } = normalizeToAAI({ msgs: [row] });
    assert.ok(Array.isArray(system), 'a split system is an array of blocks');
    const blocks = /** @type {any[]} */ (system);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, 'ROLE TEMPLATE');
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' }, 'the marker survives');
    assert.equal(blocks[1].text, 'THIS SPAWN: focus on auth');
    assert.equal(blocks[1].cache_control, undefined, 'the adaptation is not marked');
});

test('W6R/objective-once: a role template does not duplicate the parent objective', async () => {
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'claude-sonnet-test', systemPrompt: 'ROLE TEMPLATE: you review code.' }] });
    const parent = childSession('anthropic');
    parent.withPromptCache({ points: 2 });
    parent.client = client;
    parent._taskDepth = 0;
    parent._agentContext = AgentContext.fromObjective({ objective: 'ROOT GOAL: audit the fleet' });
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { prompt: 'Review it', subagent_type: 'reviewer' } }).catch(() => {});
    const blocks = systemBlocks(client.sessions[0].captured);
    const all = blocks.map((/** @type {any} */ b) => String(b.text ?? '')).join('\n\n');
    assert.equal(all.split('[Global Objective]').length - 1, 1, 'the objective block appears once');
    assert.ok(all.includes('ROOT GOAL: audit the fleet'));
    assert.ok(!String(blocks[0].text).includes('[Global Objective]'), 'the objective is not in the cached block');
    assert.ok(String(blocks[1]?.text ?? '').includes('[Global Objective]'), 'it rides the unmarked block');
});

test('W6R/cache-budget: the system marker counts against the vendor breakpoint cap', async () => {
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'claude-sonnet-test', systemPrompt: 'ROLE TEMPLATE: you review code.' }] });
    const parent = childSession('anthropic');
    parent.withPromptCache({ points: 4 });
    parent.client = client;
    parent._taskDepth = 0;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { prompt: 'Review the auth module', subagent_type: 'reviewer' } }).catch(() => {});
    const request = client.sessions[0].captured;
    /** @type {any[]} */
    const marked = systemBlocks(request).filter((/** @type {any} */ b) => b.cache_control);
    for (const message of request.messages ?? []) {
        if (Array.isArray(message.content)) marked.push(...message.content.filter((/** @type {any} */ b) => b?.cache_control));
    }
    assert.ok(marked.length <= 4, `the vendor cap is 4, got ${marked.length}`);
    assert.equal(systemBlocks(request)[0].cache_control?.type, 'ephemeral', 'the role template is still marked');
});

// ─── The delegation path builds a split system for Anthropic ───────────────

test('W6R/cache-budget-multiturn: the vendor cap holds across system and message anchors', async () => {
    const session = childSession('anthropic');
    session.withSystemMessage([{ text: 'ROLE TEMPLATE: you review code.', cache: true }, { text: 'THIS SPAWN: focus.', cache: false }]);
    session.withPromptCache({ points: 4 });
    const history = [
        createUserMessage({ provider: 'anthropic', content: 'one' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack one' }),
        createUserMessage({ provider: 'anthropic', content: 'two' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack two' }),
        createUserMessage({ provider: 'anthropic', content: 'three' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack three' }),
        createUserMessage({ provider: 'anthropic', content: 'four' }),
    ];
    const request = await captureRequest(session, history);
    /** @type {any[]} */
    const marked = systemBlocks(request).filter((/** @type {any} */ b) => b.cache_control);
    for (const message of request.messages ?? []) {
        if (Array.isArray(message.content)) marked.push(...message.content.filter((/** @type {any} */ b) => b?.cache_control));
    }
    assert.equal(marked.length, 4, '1 system + 3 message anchors = the vendor cap, never 5');
    assert.ok(systemBlocks(request)[0].cache_control, 'the role template is one of the four');
});

test('W6R/cache-budget-all-volatile: a list with nothing cached does not spend a system slot', async () => {
    const session = childSession('anthropic');
    session.withSystemMessage([{ text: 'THIS SPAWN ONLY.', cache: false }]);
    session.withPromptCache({ points: 4 });
    const history = [
        createUserMessage({ provider: 'anthropic', content: 'one' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack one' }),
        createUserMessage({ provider: 'anthropic', content: 'two' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack two' }),
        createUserMessage({ provider: 'anthropic', content: 'three' }),
    ];
    const request = await captureRequest(session, history);
    const blocks = systemBlocks(request);
    assert.equal(blocks.some((/** @type {any} */ b) => b.cache_control), false, 'nothing in the system is marked');
    /** @type {any[]} */
    const marked = [];
    for (const message of request.messages ?? []) {
        if (Array.isArray(message.content)) marked.push(...message.content.filter((/** @type {any} */ b) => b?.cache_control));
    }
    assert.equal(marked.length, 4, 'all four breakpoints stay available to the messages');
});

test('W6R/cache-budget-descriptor: the SDK descriptor joins the stable block, so it spends the slot', async () => {
    const session = childSession('anthropic');
    session.withSDKDescriptorMessage?.();
    session.withSystemMessage([{ text: 'THIS SPAWN ONLY.', cache: false }]);
    session.withPromptCache({ points: 4 });
    const history = [
        createUserMessage({ provider: 'anthropic', content: 'one' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack one' }),
        createUserMessage({ provider: 'anthropic', content: 'two' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ack two' }),
        createUserMessage({ provider: 'anthropic', content: 'three' }),
    ];
    const request = await captureRequest(session, history);
    const blocks = systemBlocks(request);
    /** @type {any[]} */
    const marked = blocks.filter((/** @type {any} */ b) => b.cache_control);
    for (const message of request.messages ?? []) {
        if (Array.isArray(message.content)) marked.push(...message.content.filter((/** @type {any} */ b) => b?.cache_control));
    }
    assert.ok(marked.length <= 4, `the vendor cap is 4, got ${marked.length}`);
    const descriptor = String(session.getSystemMessage() ?? '');
    assert.ok(descriptor, 'this session has a descriptor');
    assert.ok(String(blocks[0].text).startsWith(descriptor), 'the descriptor leads the stable block');
    assert.ok(String(blocks[0].text).includes('THIS SPAWN ONLY.') === false, 'the volatile text is not in the stable block');
    assert.ok(String(blocks[1]?.text ?? '').includes('THIS SPAWN ONLY.'), 'and it is in the unmarked block');
});

test('W6R/stable-order: the descriptor precedes the role template in the cached block', async () => {
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    const session = childSession('anthropic');
    session.withSDKDescriptorMessage?.();
    session.withSystemMessage([{ text: 'ROLE TEMPLATE: you review code.', cache: true }]);
    session.withPromptCache({ points: 2 });
    session._agentContext = AgentContext.fromObjective({ objective: 'ROOT GOAL: audit the fleet' });
    const request = await captureRequest(session, [createUserMessage({ provider: 'anthropic', content: 'go' })]);
    const blocks = systemBlocks(request);
    const descriptor = String(session.getSystemMessage() ?? '');
    assert.ok(descriptor, 'this session has a descriptor');
    assert.ok(String(blocks[0].text).startsWith(descriptor), 'the descriptor leads');
    assert.ok(String(blocks[0].text).includes('ROLE TEMPLATE'), 'then the role template');
    assert.ok(!String(blocks[0].text).includes('[Global Objective]'), 'the objective stays out of the cached block');
    assert.ok(String(blocks[1]?.text ?? '').includes('[Global Objective]'), 'and rides the unmarked block');
});

test('W6R/summary-volatile: a conversation summary rides the unmarked block, never the cached one', async () => {
    const session = childSession('anthropic');
    session.withSystemMessage([{ text: 'ROLE TEMPLATE: you review code.', cache: true }]);
    session.withPromptCache({ points: 2 });
    const { CONVERSATION_SUMMARY_MARKER } = await import('../lib/core/prompts.mjs');
    const history = [
        createUserMessage({ provider: 'anthropic', content: 'one' }),
        createSystemMessage({ provider: 'anthropic', content: `${CONVERSATION_SUMMARY_MARKER}\n\nfolded prefix` }),
        createUserMessage({ provider: 'anthropic', content: 'two' }),
    ];
    const request = await captureRequest(session, history);
    const blocks = systemBlocks(request);
    assert.ok(!String(blocks[0].text).includes('folded prefix'), 'the summary is not cached');
    assert.ok(String(blocks[1]?.text ?? '').includes('folded prefix'), 'it rides the unmarked block');
});

test('W6R/child-split: a role template is the cached block, and the brief stays out of it', async () => {
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'claude-sonnet-test', systemPrompt: 'ROLE TEMPLATE: you review code.' }] });
    const parent = childSession('anthropic');
    parent.withPromptCache({ points: 2 });
    parent.client = client;
    parent._taskDepth = 0;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Review the auth module', subagent_type: 'reviewer' },
    }).catch(() => {});
    const request = client.sessions.at(-1).captured;
    const blocks = systemBlocks(request);
    assert.equal(blocks.length, 1, 'the template is the whole system (no adaptation was granted)');
    assert.ok(String(blocks[0].text).includes('ROLE TEMPLATE'), 'the template is there');
    assert.ok(blocks[0].cache_control, 'and it carries the cache marker');

    assert.ok(!String(blocks[0].text).includes('Review the auth module'), 'the per-spawn brief is not in the cached prefix');
});

test('W6R/template-stable: two spawns share the cached block byte for byte', async () => {
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'claude-sonnet-test', systemPrompt: 'ROLE TEMPLATE: you review code.' }] });
    const parent = childSession('anthropic');
    parent.withPromptCache({ points: 2 });
    parent.client = client;
    parent._taskDepth = 0;
    const tool = /** @type {any} */ (createTaskTool({ session: parent }));
    await tool.execute({ args: { prompt: 'Review the auth module', subagent_type: 'reviewer' } }).catch(() => {});
    await tool.execute({ args: { prompt: 'Review the billing module', subagent_type: 'reviewer' } }).catch(() => {});
    const a = systemBlocks(client.sessions[0].captured);
    const b = systemBlocks(client.sessions[1].captured);
    assert.equal(a.length, 1);
    assert.deepEqual(a[0], b[0], 'the cached prefix is identical across spawns');
});

test('W6R/adapt: a granted per-spawn system is appended after the template, uncached', async () => {
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'claude-sonnet-test', systemPrompt: 'ROLE TEMPLATE: generic.' }] });
    const { withAgentDelegation } = await import('../lib/agentic/task.mjs');
    withAgentDelegation({ client, system: 'any' });
    const parent = childSession('anthropic');
    parent.withPromptCache({ points: 2 });
    parent.client = client;
    parent._taskDepth = 0;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Review it', subagent_type: 'reviewer', system: 'THIS SPAWN: focus on payments.' },
    }).catch(() => {});
    const blocks = systemBlocks(client.sessions[0].captured);
    assert.equal(blocks.length, 2, 'template + adaptation');
    assert.ok(String(blocks[0].text).includes('generic'), 'the role template stays');
    assert.ok(blocks[0].cache_control, 'and stays cacheable');
    assert.ok(String(blocks[1].text).includes('payments'), 'the adaptation is the second block');
    assert.equal(blocks[1].cache_control, undefined, 'the adaptation is not cached');
});

test('W6R/no-cache: without the cache policy an Anthropic child keeps a plain system string', async () => {
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'claude-sonnet-test', systemPrompt: 'ROLE TEMPLATE: you review code.' }] });
    const parent = childSession('anthropic');
    parent.client = client;
    parent._taskDepth = 0;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { prompt: 'Review it', subagent_type: 'reviewer' } }).catch(() => {});
    const request = client.sessions[0].captured;
    assert.equal(typeof request.system, 'string', 'caching is opt-in: no marker, no block list');
    assert.ok(request.system.includes('ROLE TEMPLATE'));
});

test('W6R/non-aai: an OpenAI child sees the same joined text as before', async () => {
    const { AgentContext } = await import('../lib/agentic/agent-context.mjs');
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'reviewer', model: 'gpt-test', systemPrompt: 'ROLE TEMPLATE: you review code.' }] });
    const parent = childSession('openai');
    parent.withPromptCache({ points: 2 });
    parent.client = client;
    parent._taskDepth = 0;
    parent._agentContext = AgentContext.fromObjective({ objective: 'ROOT GOAL: audit the fleet' });
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { prompt: 'Review the auth module', subagent_type: 'reviewer' } }).catch(() => {});
    const request = client.sessions.at(-1).captured;
    const systemRow = (request.messages ?? []).find((/** @type {any} */ m) => m.role === 'system' || m.type === 'system_message');
    assert.ok(systemRow, 'OpenAI carries the system as a message row');
    assert.equal(typeof systemRow.content, 'string', 'no block list on this wire');
    assert.ok(String(systemRow.content).startsWith('ROLE TEMPLATE: you review code.\n\n[Global Objective]'),
        'the parts still join with the documented separator, in order');
});

test('W6R/no-role: a profile without a template produces no empty cached block', async () => {
    const client = makeClient('anthropic');
    withTaskAgents({ client, agents: [{ name: 'plain', model: 'claude-sonnet-test' }] });
    const parent = childSession('anthropic');
    parent.withPromptCache({ points: 2 });
    parent.client = client;
    parent._taskDepth = 0;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { prompt: 'Do the thing', subagent_type: 'plain' } }).catch(() => {});
    const request = client.sessions[0].captured;
    const blocks = systemBlocks(request);
    assert.ok(blocks.every((/** @type {any} */ b) => String(b.text ?? '').trim().length > 0), 'no empty block');
    assert.ok(!blocks.some((/** @type {any} */ b) => String(b.text).includes('ROLE TEMPLATE')), 'nothing invented');
});
