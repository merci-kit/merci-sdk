// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { createTaskTool, withTaskAgents } from '../lib/agentic/task.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

function makeTmpDir() {
    return mkdtempSync(join(tmpdir(), 'merci-sessions-'));
}

describe('LocalFileSessionStore', () => {
    it('round-trips a checkpoint per thread and lists newest-first', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            await store.save({ threadId: 'thread-a', data: { messages: [{ role: 'user', content: 'a' }] } });
            await store.save({ threadId: 'thread-b', data: { messages: [{ role: 'user', content: 'b' }] } });
            const loaded = /** @type {any} */ (await store.load('thread-a'));
            assert.deepEqual(loaded.messages, [{ role: 'user', content: 'a' }]);
            assert.ok(loaded.updatedAt, 'the checkpoint is stamped');
            const list = await store.list();
            assert.equal(list.length, 2);
            assert.equal(list[0].threadId, 'thread-b', 'newest first');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('loads null for an unknown thread and sanitizes ids', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            assert.equal(await store.load('nope'), null);
            const file = await store.save({ threadId: 'a/b:c', data: { messages: [] } });
            assert.ok(file.endsWith(`${join('', 'a_b_c.json')}`), 'unsafe chars are replaced');
            assert.equal(readdirSync(dir).length, 1, 'one sanitized file');
            assert.ok(!readdirSync(dir).some(f => f.endsWith('.tmp')), 'atomic writes leave no tmp files');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a legacy checkpoint under an uppercase id still loads', async () => {
        const dir = makeTmpDir();
        try {
            // Written by 0.22.x, which used the id verbatim as the file name.
            writeFileSync(join(dir, 'Thread-A.json'), JSON.stringify({
                threadId: 'Thread-A',
                messages: [{ role: 'user', content: 'legacy' }],
            }), 'utf8');
            const store = new LocalFileSessionStore({ dir });
            const loaded = /** @type {any} */ (await store.load('Thread-A'));
            assert.equal(loaded.messages[0].content, 'legacy', 'an existing checkpoint must not be orphaned');
            assert.equal((await store.list()).length, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a case-only id cannot silently read another thread', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            await store.save({ threadId: 'Thread-A', data: { messages: [{ role: 'user', content: 'upper' }] } });
            // On a case-insensitive volume the two ids are one file; on a
            // case-sensitive one they are genuinely two, and there is no hazard.
            const aliased = existsSync(join(dir, 'thread-a.json'));
            if (!aliased) {
                assert.equal(await store.load('thread-a'), null, 'a different case is a different thread');
                return;
            }
            const collision = await store.load('thread-a').then(() => null, (error) => error);
            assert.ok(collision instanceof ConfigurationError, 'the aliased read must refuse, not return the wrong thread');
            assert.equal(collision.option, 'thread-case-collision');
            assert.match(String(collision.message), /case/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a case-only id cannot overwrite another thread\'s checkpoint', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            await store.save({ threadId: 'Thread-A', data: { messages: [{ role: 'user', content: 'upper' }] } });
            const aliased = existsSync(join(dir, 'thread-a.json'));
            const attempt = await store.save({
                threadId: 'thread-a',
                data: { messages: [{ role: 'user', content: 'lower' }] },
            }).then(() => null, (error) => error);
            if (!aliased) {
                assert.equal(attempt, null, 'a different case is a different thread on this volume');
                return;
            }
            assert.ok(attempt instanceof ConfigurationError, 'the aliased write must refuse');
            assert.equal(attempt.option, 'thread-case-collision');
            assert.equal(attempt.nonRetryable, true);
            const kept = /** @type {any} */ (await store.load('Thread-A'));
            assert.equal(kept.messages[0].content, 'upper', "the other thread's checkpoint must be untouched");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('re-saving the same thread rewrites its checkpoint', async () => {
        for (const threadId of ['thread-a', 'Thread-A']) {
            const dir = makeTmpDir();
            try {
                const store = new LocalFileSessionStore({ dir });
                await store.save({ threadId, data: { messages: [{ role: 'user', content: 'first' }] } });
                await store.save({ threadId, data: { messages: [{ role: 'user', content: 'second' }] } });
                const loaded = /** @type {any} */ (await store.load(threadId));
                assert.equal(loaded.messages[0].content, 'second', `${threadId} keeps last-write-wins for its own file`);
                assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1, 'one file, not a second one');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it('an unreadable existing checkpoint still takes today\'s overwrite path', async () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, 'thread-a.json'), '{"messages": [', 'utf8');
            const store = new LocalFileSessionStore({ dir });
            await store.save({ threadId: 'thread-a', data: { messages: [{ role: 'user', content: 'fresh' }] } });
            assert.equal(/** @type {any} */ (await store.load('thread-a')).messages[0].content, 'fresh');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('save on an existing unreadable checkpoint is typed, not a raw EACCES (G1-3)', { skip: process.getuid?.() === 0 ? 'root can read anything' : false }, async () => {
        const dir = makeTmpDir();
        try {
            const file = join(dir, 'thread-a.json');
            writeFileSync(file, JSON.stringify({ threadId: 'thread-a', messages: [] }), 'utf8');
            chmodSync(file, 0o000);
            const emitter = new EventEmitter();
            /** @type {string[]} */
            const names = [];
            emitter.on(EVENTS.SESSION.STORE_CORRUPT, () => names.push(EVENTS.SESSION.STORE_CORRUPT));
            const store = new LocalFileSessionStore({ dir, eventEmitter: emitter });
            await assert.rejects(
                store.save({ threadId: 'thread-a', data: { messages: [] } }),
                (error) => error instanceof ConfigurationError && error.option === 'checkpoint_unreadable',
                'the collision pre-read fails typed instead of leaking EACCES'
            );
            assert.deepEqual(names, [EVENTS.SESSION.STORE_CORRUPT], 'the unreadable record is reported');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('emits store_miss and only store_miss when the thread is absent (W2C-7)', async () => {
        const dir = makeTmpDir();
        try {
            const emitter = new EventEmitter();
            /** @type {string[]} */
            const names = [];
            emitter.on(EVENTS.SESSION.STORE_MISS, () => names.push(EVENTS.SESSION.STORE_MISS));
            emitter.on(EVENTS.SESSION.STORE_CORRUPT, () => names.push(EVENTS.SESSION.STORE_CORRUPT));
            const store = new LocalFileSessionStore({ dir, eventEmitter: emitter });

            assert.equal(await store.load('absent'), null);
            assert.deepEqual(names, [EVENTS.SESSION.STORE_MISS], 'a missing file is one miss, never a corrupt');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a corrupt checkpoint emits store_corrupt once and throws instead of hydrating (W2C-3/W2C-7)', async () => {
        const dir = makeTmpDir();
        try {
            const emitter = new EventEmitter();
            /** @type {string[]} */
            const names = [];
            emitter.on(EVENTS.SESSION.STORE_MISS, () => names.push(EVENTS.SESSION.STORE_MISS));
            emitter.on(EVENTS.SESSION.STORE_CORRUPT, () => names.push(EVENTS.SESSION.STORE_CORRUPT));
            const store = new LocalFileSessionStore({ dir, eventEmitter: emitter });
            writeFileSync(join(dir, 'broken.json'), '{"messages": [', 'utf8');

            await assert.rejects(
                store.load('broken'),
                (error) => error instanceof ConfigurationError && error.option === 'checkpoint_corrupt',
                'a present-but-unreadable record is an error, not a fresh thread'
            );
            assert.deepEqual([...names], [EVENTS.SESSION.STORE_CORRUPT], 'exactly one store_corrupt and no store_miss');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('an unreadable checkpoint emits store_corrupt and throws instead of reading as absent (G1-3)', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async () => {
        const dir = makeTmpDir();
        const file = join(dir, 'locked.json');
        try {
            const emitter = new EventEmitter();
            /** @type {Array<Record<string, any>>} */
            const corrupt = [];
            emitter.on(EVENTS.SESSION.STORE_CORRUPT, (payload) => corrupt.push(payload));
            const store = new LocalFileSessionStore({ dir, eventEmitter: emitter });
            writeFileSync(file, JSON.stringify({ threadId: 'locked', messages: [] }), 'utf8');
            chmodSync(file, 0o000);

            const failure = await store.load('locked').then(() => null, (error) => error);
            assert.ok(failure instanceof ConfigurationError, `a typed failure, got ${failure?.name}: ${failure?.message}`);
            assert.equal(failure.option, 'checkpoint_unreadable');
            assert.match(String(failure.message), /locked/, 'the message names the thread');
            assert.match(String(failure.message), /EACCES|EPERM/, 'the message names the fs code');
            assert.equal(corrupt.length, 1, 'exactly one store_corrupt');
            assert.equal(corrupt[0].threadId, 'locked');
            assert.match(String(corrupt[0].reason), /EACCES|EPERM/);
            assert.equal(existsSync(file), true, 'an unreadable record is left in place, never quarantined');
        } finally {
            if (existsSync(file)) chmodSync(file, 0o600);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('withSessionStore auto-checkpoints after run() and restores on a fresh session', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
            const session = new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
            session.withSessionStore({ store, threadId: 't-1' }).withObjective({ ctx: 'THE GOAL' });
            await session.run({ initialInput: 'hello' });
            const saved = /** @type {any} */ (await store.load('t-1'));
            assert.ok(Array.isArray(saved.messages), 'the conversation row was persisted');
            assert.equal(saved.agentContext.objective, 'THE GOAL', 'the context was persisted');

            const fresh = new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
            fresh.withSessionStore({ store, threadId: 't-1' });
            const checkpoint = await fresh.loadCheckpoint();
            assert.deepEqual(checkpoint, saved);
            assert.equal(fresh._agentContext?.objective, 'THE GOAL', 'restored onto the fresh session');
            assert.equal(fresh._lastStepMessages?.length, saved.messages.length, 'messages restored for inherit:history');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('loadCheckpoint REHYDRATES the AgentContext — delegation after resume never throws', async () => {
        const dir = makeTmpDir();
        try {
            const store = new LocalFileSessionStore({ dir });
            const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
            const session = new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
            session.withSessionStore({ store, threadId: 't-2' }).withObjective({ ctx: 'RESUMED GOAL' });
            await session.run({ initialInput: 'hello' });
            await store.save({ threadId: 't-2', data: { messages: session._lastStepMessages, agentContext: { objective: 'RESUMED GOAL' } } });

            const fresh = new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
            fresh.withSessionStore({ store, threadId: 't-2' });
            await fresh.loadCheckpoint();
            assert.ok(fresh._agentContext instanceof AgentContext,
                'the context is an AgentContext instance after restore');
            assert.equal(fresh._agentContext.toModelBlock().includes('RESUMED GOAL'), true,
                'toModelBlock works after restore');

            const childCalls = /** @type {any[]} */ ([]);
            const childSystems = /** @type {any[]} */ ([]);
            const childClient = /** @type {any} */ ({
                session: () => ({
                    provider: 'openai',
                    _system: '',
                    withSystemMessage(/** @type {any} */ msg) { this._system = Array.isArray(msg) ? msg.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : String(msg ?? ''); return this; },
                    withTools() { return this; },
                    /** @param {{initialInput: *}} arg0 */
                    async run({ initialInput: messages }) { childCalls.push(messages); childSystems.push(this._system); return 'ok'; },
                }),
            });
            withTaskAgents({ client: childClient, agents: [{ name: 'worker', model: 'm' }] });
            const tool = createTaskTool({ session: /** @type {any} */ ({
                client: childClient, model: 'm', provider: 'openai',
                eventEmitter: new EventEmitter(),
                _agentContext: fresh._agentContext,
            }) });
            const result = await (/** @type {any} */ (tool)).execute({ args: { subagent_type: 'worker', prompt: 'Do X' } });
            assert.equal(result, 'ok');
            const input = `${String(childSystems[0] ?? '')}\n${String(childCalls[0][0].content)}`;
            assert.ok(input.includes('RESUMED GOAL'), 'the rehydrated objective reaches the child');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
