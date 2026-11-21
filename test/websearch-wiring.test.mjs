// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import {
    CAPABILITY,
    CAPABILITY_REGISTRY,
    WEB_SEARCH_TOOL_NAME,
    WEB_SEARCH_MODES,
    WEB_SEARCH_PRELOAD_BLOCK,
    EnvKey
} from '../lib/core/constants/index.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

class MinimalSession extends AbstractChatSession {
    
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} [client] */
        constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

const mockComponent = {
    toWebSearchTool: () => ({ name: WEB_SEARCH_TOOL_NAME, description: 'search the web', parameters: { type: 'object', properties: {}, required: [] } }),
};

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('EVENTS.WEB_SEARCH exposes SEARCH_START/SUCCESS/ERROR', () => {
    assert.equal(EVENTS.WEB_SEARCH.SEARCH_START, 'web_search:start');
    assert.equal(EVENTS.WEB_SEARCH.SEARCH_SUCCESS, 'web_search:success');
    assert.equal(EVENTS.WEB_SEARCH.SEARCH_ERROR, 'web_search:error');
});

test('CAPABILITY.WEB_SEARCH + registry announcement are wired', () => {
    assert.equal(CAPABILITY.WEB_SEARCH, 'web_search');
    assert.ok(CAPABILITY_REGISTRY[CAPABILITY.WEB_SEARCH]?.announce.includes(WEB_SEARCH_TOOL_NAME));
    assert.ok(WEB_SEARCH_MODES.includes('off'));
    assert.ok(WEB_SEARCH_MODES.includes('native_with_tavily_fallback'));
});

test('EnvKey.TAVILY_API_KEY exists', () => {
    assert.equal(EnvKey.TAVILY_API_KEY, 'TAVILY_API_KEY');
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('withWebSearch stores normalized config with exact field names', () => {
    const b = new ChatSessionBuilder().withWebSearch();
    assert.deepEqual(b._webSearch, {
        mode: 'native_with_tavily_fallback',
        force: false,
        model: '',
        maxResults: 5,
        maxUses: undefined,
        allowedDomains: [],
        blockedDomains: [],
        location: null,
        includeVendorMetadata: false,
        tavily: null,
        inject: null,
        preload: true
    });
});

test('withWebSearch honors every option', () => {
    const b = new ChatSessionBuilder().withWebSearch({ options: {
        mode: 'tavily',
        force: true,
        maxResults: 10,
        maxUses: 3,
        allowedDomains: ['example.com'],
        blockedDomains: ['evil.com'],
        location: { country: 'US' },
        includeVendorMetadata: true,
        tavily: { searchDepth: 'advanced' }
    } });
    assert.deepEqual(b._webSearch, {
        mode: 'tavily',
        force: true,
        model: '',
        maxResults: 10,
        maxUses: 3,
        allowedDomains: ['example.com'],
        blockedDomains: ['evil.com'],
        location: { country: 'US' },
        includeVendorMetadata: true,
        tavily: { searchDepth: 'advanced' },
        inject: null,
        preload: true
    });
});

test('withWebSearch: preload:false is recorded and keeps the tool config', () => {
    const b = new ChatSessionBuilder().withWebSearch({ options: { mode: 'tavily', preload: false } });
    assert.equal((/** @type {any} */ (b)._webSearch).preload, false);
    assert.equal((/** @type {any} */ (b))._webSearchPreload, false);
});

test('withWebSearch rejects an unknown mode with ConfigurationError', () => {
    assert.throws(
        () => new ChatSessionBuilder().withWebSearch({ options: { mode: 'bogus' } }),
        err => err instanceof ConfigurationError && err.option === 'mode'
    );
});

test('withWebSearch returns the session for chaining', () => {
    const b = new ChatSessionBuilder();
    assert.equal(b.withWebSearch(), b);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('force:true reuses withParameters/adapter tool_choice (named web_search)', () => {
    const b = new ChatSessionBuilder().withWebSearch({ options: { force: true } });
    // The capability passes the unified spec key; the backend translator turns
    // it into the standard's wire shape (OAI: { type: 'function', function }).
    assert.deepEqual(( (/** @type {any} */ (b)))._parameters.toolChoice, { type: 'named', name: WEB_SEARCH_TOOL_NAME });
});

test('force:false leaves parameters untouched', () => {
    const b = new ChatSessionBuilder().withWebSearch({ options: { force: false } });
    assert.equal(( (/** @type {any} */ (b)))._parameters.tool_choice, undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('withWebSearch announces the capability in the system message', () => {
    const b = new ChatSessionBuilder().withWebSearch();
    assert.ok( (/** @type {any} */ (b.getSystemMessage())).includes(WEB_SEARCH_TOOL_NAME));
});

test('injected component registers its tool', () => {
    const b = new ChatSessionBuilder();
    b._webSearchComponent = /** @type {any} */ (mockComponent);
    b.withWebSearch();
    const names = b._tools.map(/** @type {(...args: any[]) => any} */ (t => t.name));
    assert.ok(names.includes(WEB_SEARCH_TOOL_NAME));
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────


/** @param {{session: *}} arg0 */
async function systemContent({ session }) {
    const prepared =  (await session._prepareStepMessages({ messages: [createUserMessage({ provider: 'openrouter', content: 'hi' })] }));
    const sys = prepared.find(/** @type {(...args: any[]) => any} */ (m => m.type === 'system_message'));
    return  (sys && sys.content);
}

test('preload block is injected when mode !== off', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withWebSearch({ options: { mode: 'native' } });
    const content = await systemContent({ session: s });
    assert.ok(content.includes(WEB_SEARCH_PRELOAD_BLOCK));
});

test('preload block is skipped when mode is off', async () => {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    s.withWebSearch({ options: { mode: 'off' } });
    const content = await systemContent({ session: s });
    assert.ok(!content.includes(WEB_SEARCH_PRELOAD_BLOCK));
});