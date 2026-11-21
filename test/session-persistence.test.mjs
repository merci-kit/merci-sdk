// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { createTaskTool, withTaskAgents } from '../lib/agentic/task.mjs';

function makeTmpDir() {
    return mkdtempSync(join(tmpdir(), 'merci-session-persistence-'));
}

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} client */
    constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

describe('session id persistence', () => {
    it('LocalFileSessionStore round-trips an opaque sessionId', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            await store.save({ threadId: 'thread-1', data: { messages: [{ role: 'user', content: 'a' }], sessionId: 'sess-opaque-1' } });
            const loaded = /** @type {any} */ (await store.load('thread-1'));
            assert.equal(loaded.sessionId, 'sess-opaque-1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('saveCheckpoint persists a sessionId and loadCheckpoint adopts it', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
            const session = new MinimalSession('openai', 'test-model', new EventEmitter(), stubClient);
            session.withSessionStore({ store, threadId: 't-1' }).withSessionId({ id: 'sess-1' });
            assert.equal(session._explicitSessionId, 'sess-1', 'withSessionId stores the explicit id');
            session._lastStepMessages = [{ role: 'user', content: 'hi' }];
            await session.saveCheckpoint();
            const saved = /** @type {any} */ (await store.load('t-1'));
            assert.ok(saved.sessionId, 'the checkpoint carries a sessionId');

            const fresh = new MinimalSession('openai', 'test-model', new EventEmitter(), stubClient);
            fresh.withSessionStore({ store, threadId: 't-1' });
            await fresh.loadCheckpoint();
            assert.equal(fresh._explicitSessionId, saved.sessionId, 'load adopts the persisted id');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('old checkpoints without sessionId keep the current id (stamped on re-save)', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            await store.save({ threadId: 't-2', data: { messages: [] } });
            const session = new MinimalSession('openai', 'test-model', new EventEmitter(), {});
            session.withSessionStore({ store, threadId: 't-2' }).withSessionId({ id: 'sess-2' });
            const checkpoint = /** @type {any} */ (await session.loadCheckpoint());
            assert.equal(checkpoint.sessionId, undefined, 'old checkpoint has no sessionId');
            assert.equal(session._explicitSessionId, 'sess-2', 'current id untouched by an old checkpoint');
            await session.saveCheckpoint();
            const reSaved = /** @type {any} */ (await store.load('t-2'));
            assert.ok(reSaved.sessionId, 're-save stamps the sessionId');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('checkpoint save over a failing store (0.7.3 item D)', () => {
    it('a load that rejects aborts the save instead of writing an empty conversation over the stored one', async () => {
        let saves = 0;
        const store = /** @type {any} */ ({
            load: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
            save: async () => { saves += 1; return null; },
        });
        const session = new MinimalSession('openai', 'test-model', new EventEmitter(), {});
        session.withSessionStore({ store, threadId: 't-broken' });
        session._lastStepMessages = [];
        await assert.rejects(() => session.saveCheckpoint(), /EACCES/);
        assert.equal(saves, 0, 'save is never called');
    });

    it('a missing thread (load answers null) still saves', async () => {
        let saves = 0;
        const store = /** @type {any} */ ({ load: async () => null, save: async () => { saves += 1; return null; } });
        const session = new MinimalSession('openai', 'test-model', new EventEmitter(), {});
        session.withSessionStore({ store, threadId: 't-new' });
        session._lastStepMessages = [];
        await session.saveCheckpoint();
        assert.equal(saves, 1);
    });
});

describe('session id inheritance (task tool)', () => {
    /**
 * @param {{children: any[]}} arg0
 * @returns {any}
 */
    function stubClient({ children }) {
        return {
            /** @param {any} model */
            session(model) {
                const child = {
                    provider: 'openai',
                    _explicitSessionId: undefined,
                    withSystemMessage() { return this; },
                    withTools() { return this; },
                    run: async () => 'ok',
                };
                children.push(child);
                return child;
            },
        };
    }

    it('children share the parent sessionId', async () => {
        const children = /** @type {any[]} */ ([]);
        const client = stubClient({ children });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({
            sessionId: 'sess-parent-1',
            client,
            model: 'm',
            eventEmitter: new EventEmitter(),
        }) });
        const result = await (/** @type {any} */ (tool)).execute({ args: { subagent_type: 'worker', prompt: 'Do X' } });
        assert.equal(result, 'ok');
        assert.equal(children.length, 1);
        assert.equal(children[0]._explicitSessionId, 'sess-parent-1', 'child shares the parent conversation id');
    });

    it('children fall back to the parent run id when no sessionId is minted', async () => {
        const children = /** @type {any[]} */ ([]);
        const client = stubClient({ children });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({
            client,
            model: 'm',
            eventEmitter: new EventEmitter(),
            _sessionRunCtx: { runId: 'run-fallback-1' },
        }) });
        await (/** @type {any} */ (tool)).execute({ args: { subagent_type: 'worker', prompt: 'Do X' } });
        assert.equal(children[0]._explicitSessionId, 'run-fallback-1', 'child falls back to the run id');
    });
});