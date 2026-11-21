// @ts-check

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InMemorySessionStore, LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';

// 0.8.0 item J: one SessionStore contract, the same behaviour from every store.

/** @type {Array<{name: string, make: () => {store: any, cleanup: () => void}}>} */
const STORES = [
    { name: 'InMemorySessionStore', make: () => ({ store: new InMemorySessionStore(), cleanup: () => {} }) },
    {
        name: 'LocalFileSessionStore',
        make: () => {
            const dir = mkdtempSync(join(tmpdir(), 'merci-store-conformance-'));
            return { store: new LocalFileSessionStore({ dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
        },
    },
];

const ROWS = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];

for (const { name, make } of STORES) {
    describe(`SessionStore conformance — ${name}`, () => {
        /** @param {(store: any) => Promise<void>} fn */
        const withStore = async (fn) => {
            const { store, cleanup } = make();
            try { await fn(store); } finally { cleanup(); }
        };

        it('round-trips a checkpoint; a missing thread loads as null', () => withStore(async (store) => {
            await store.save({ threadId: 't1', data: { messages: ROWS, sessionId: 's1' } });
            const loaded = await store.load('t1');
            assert.deepEqual(loaded.messages, ROWS);
            assert.equal(loaded.sessionId, 's1');
            assert.equal(loaded.threadId, 't1');
            assert.equal(await store.load('nope'), null);
        }));

        it('a loaded or saved object is a copy: mutating it never changes the stored thread', () => withStore(async (store) => {
            const data = { messages: [{ role: 'user', content: 'a' }] };
            await store.save({ threadId: 't1', data });
            data.messages.push({ role: 'user', content: 'b' });
            const first = await store.load('t1');
            first.messages.push({ role: 'user', content: 'c' });
            assert.equal((await store.load('t1')).messages.length, 1);
        }));

        it('saves are last-write-wins', () => withStore(async (store) => {
            await store.save({ threadId: 't1', data: { messages: [ROWS[0]] } });
            await store.save({ threadId: 't1', data: { messages: ROWS } });
            assert.equal((await store.load('t1')).messages.length, 2);
        }));

        it('fork copies a thread under a new id and leaves the source alone', () => withStore(async (store) => {
            await store.save({ threadId: 'src', data: { messages: ROWS } });
            const forked = await store.fork({ threadId: 'src', newThreadId: 'branch' });
            assert.equal(forked.threadId, 'branch');
            await store.save({ threadId: 'branch', data: { messages: [ROWS[0]] } });
            assert.equal((await store.load('src')).messages.length, 2, 'the source is untouched');
            assert.equal((await store.load('branch')).messages.length, 1);
        }));

        it('fork refuses an unknown source and a taken target unless overwrite', () => withStore(async (store) => {
            await assert.rejects(() => store.fork({ threadId: 'nope', newThreadId: 'x' }), ConfigurationError);
            await store.save({ threadId: 'a', data: { messages: ROWS } });
            await store.save({ threadId: 'b', data: { messages: [] } });
            await assert.rejects(() => store.fork({ threadId: 'a', newThreadId: 'b' }), ConfigurationError);
            await store.fork({ threadId: 'a', newThreadId: 'b', overwrite: true });
            assert.equal((await store.load('b')).messages.length, 2);
        }));

        it('an invalid thread id is a ConfigurationError', () => withStore(async (store) => {
            await assert.rejects(() => store.save({ threadId: '', data: {} }), ConfigurationError);
        }));

        it('backs a session: saveCheckpoint then loadCheckpoint restores messages and the AgentContext', () => withStore(async (store) => {
            class Session extends AbstractChatSession {
                constructor() { super({ provider: 'openai', model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({}) }); }
            }
            const first = /** @type {any} */ (new Session());
            first.withSessionStore({ store, threadId: 'conv' });
            first._lastStepMessages = ROWS;
            first._agentContext = new AgentContext({ objective: 'ship it' });
            await first.saveCheckpoint();
            const second = /** @type {any} */ (new Session());
            second.withSessionStore({ store, threadId: 'conv' });
            const restored = await second.loadCheckpoint();
            assert.deepEqual(restored.messages, ROWS);
            assert.ok(second._agentContext instanceof AgentContext, 'rehydrated, not a plain object');
            assert.equal(second._agentContext.objective, 'ship it');
        }));
    });
}
