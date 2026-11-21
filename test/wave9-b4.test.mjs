// @ts-check

/**
 * Wave 9 / B4 — memory facts dedupe against the conversation, not a manager UUID.
 *
 * A `MemoryManager` is rebuilt on every resume, and its session key was a per-manager
 * `randomUUID()`: the same fact distilled into the same bank from a resumed session
 * produced a second row. The key is now the conversation id when the host has one, and
 * the random id remains only as the fallback for a manager used outside a session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/index.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {string} content */
function distillClient(content) {
    return ({
        session: () => ({
            withSystemMessage() { return this; },
            withParameters() { return this; },
            run: async () => JSON.stringify({ newFacts: [{ content, category: 'fact', targetBanks: [] }], obsoleteFactIds: [] }),
        }),
    });
}

/** @param {string} dir */
function providerAt(dir) {
    return new LocalFileMemoryProvider({ options: { filePath: join(dir, 'memory.json') } });
}

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} client */
    constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

test('B4/resume: a resumed session with the same id does not duplicate a fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b4-'));
    try {
        const provider = providerAt(dir);
        const first = new MemoryManager({ provider, options: { syncInterval: 1, sessionId: 'conv-1' } });
        await first.distill({ messages: [{ role: 'user', content: 'the workspace is flutter' }], client: distillClient('the workspace is flutter'), modelToUse: 'm', options: {} });
        const resumed = new MemoryManager({ provider, options: { syncInterval: 1, sessionId: 'conv-1' } });
        await resumed.distill({ messages: [{ role: 'user', content: 'the workspace is flutter' }], client: distillClient('the workspace is flutter'), modelToUse: 'm', options: {} });
        assert.equal(provider.facts.length, 1, 'the same conversation dedupes');
        assert.equal(/** @type {any} */ (provider.facts[0]).sessionKey, 'conv-1', 'the fact carries the conversation id');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B4/distinct: two conversations keep their own row for the same text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b4-'));
    try {
        const provider = providerAt(dir);
        for (const sessionId of ['conv-A', 'conv-B']) {
            const manager = new MemoryManager({ provider, options: { syncInterval: 1, sessionId } });
            await manager.distill({ messages: [{ role: 'user', content: 'shared fact' }], client: distillClient('shared fact'), modelToUse: 'm', options: {} });
        }
        assert.equal(provider.facts.length, 2, 'dedupe is per conversation');
        assert.deepEqual(provider.facts.map((/** @type {any} */ f) => f.sessionKey).sort(), ['conv-A', 'conv-B']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B4/withMemory: the manager inherits the session id, including one set after withMemory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b4-'));
    try {
        const provider = providerAt(dir);
        const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), /** @type {any} */ ({ session() {} }));
        session.withMemory({ provider, options: { syncInterval: 1 } });
        // Set the id afterwards: the thunk keeps the manager's key current.
        session.sessionId = 'conv-late';
        const manager = /** @type {any} */ (session)._memoryManager;
        await manager.distill({ messages: [{ role: 'user', content: 'late id fact' }], client: distillClient('late id fact'), modelToUse: 'm', options: {} });
        assert.equal(/** @type {any} */ (provider.facts[0]).sessionKey, 'conv-late');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B4/fallback: a manager outside a session still stores, on a random key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b4-'));
    try {
        const provider = providerAt(dir);
        const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
        await manager.distill({ messages: [{ role: 'user', content: 'orphan fact' }], client: distillClient('orphan fact'), modelToUse: 'm', options: {} });
        assert.equal(provider.facts.length, 1);
        assert.equal(typeof /** @type {any} */ (provider.facts[0]).sessionKey, 'string');
        assert.ok(/** @type {any} */ (provider.facts[0]).sessionKey.length > 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
