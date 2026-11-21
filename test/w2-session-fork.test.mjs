// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * @returns {Promise<string>} a fresh temp directory for one store
 */
async function makeTmpDir() {
    return mkdtemp(join(tmpdir(), 'merci-w2-fork-'));
}

/**
 * @param {{dir: string, eventEmitter?: import('node:events').EventEmitter|null}} arg0
 * @returns {LocalFileSessionStore}
 */
function makeStore({ dir, eventEmitter = null }) {
    return new LocalFileSessionStore({ dir, eventEmitter });
}

const SOURCE_MESSAGES = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
];

const SOURCE_CONTEXT = { objective: 'GOAL', banks: { facts: [{ id: 'f1', content: 'x' }] } };

/**
 * @param {{dir: string, threadId?: string}} arg0
 * @returns {Promise<void>}
 */
async function seedSource({ dir, threadId = 'src' }) {
    await makeStore({ dir }).save({ threadId, data: {
        messages: SOURCE_MESSAGES,
        agentContext: SOURCE_CONTEXT,
        sessionId: 'sess-1',
    } });
}

describe('LocalFileSessionStore.fork', () => {
    it('copies the messages and the agent context to a new thread id', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            const store = makeStore({ dir });
            const forked = await store.fork({ threadId: 'src', newThreadId: 'branch' });
            assert.deepEqual(forked.messages, SOURCE_MESSAGES, 'the conversation row is carried over');
            assert.deepEqual(forked.agentContext, SOURCE_CONTEXT, 'the agent context is carried over');
            assert.equal(forked.sessionId, 'sess-1', 'the conversation id is carried over');

            const loaded = await store.load('branch');
            assert.ok(loaded, 'the fork is readable under the new thread id');
            assert.deepEqual(loaded.messages, SOURCE_MESSAGES);
            assert.deepEqual(loaded.agentContext, SOURCE_CONTEXT);
            assert.equal(await store.load('branch-typo'), null, 'the source thread id is not reused');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('leaves the source thread byte-for-byte unchanged', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            const store = makeStore({ dir });
            const file = join(dir, 'src.json');
            const bytesBefore = await readFile(file, 'utf8');
            const loadedBefore = await store.load('src');

            const forked = await store.fork({ threadId: 'src', newThreadId: 'branch' });

            assert.equal(await readFile(file, 'utf8'), bytesBefore, 'the source file is untouched');
            const loadedAfter = await store.load('src');
            assert.deepEqual(loadedAfter, loadedBefore, 'the source checkpoint is unchanged');

            // the fork owns its state — mutating it cannot reach the source
            /** @type {any} */ (forked.messages)[0].content = 'mutated';
            /** @type {any} */ (forked.agentContext).objective = 'mutated';
            const reloaded = await store.load('src');
            assert.deepEqual(reloaded?.messages, SOURCE_MESSAGES, 'the source messages are unaffected');
            assert.deepEqual(reloaded?.agentContext, SOURCE_CONTEXT, 'the source context is unaffected');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('throws a typed error when the source thread does not exist', async () => {
        const dir = await makeTmpDir();
        try {
            const store = makeStore({ dir });
            await assert.rejects(
                store.fork({ threadId: 'ghost', newThreadId: 'branch' }),
                ConfigurationError
            );
            assert.equal(await store.load('branch'), null, 'no fork is written');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('refuses to overwrite an existing target thread unless overwrite is set', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            const store = makeStore({ dir });
            await store.save({ threadId: 'taken', data: { messages: [{ role: 'user', content: 'original' }] } });

            await assert.rejects(
                store.fork({ threadId: 'src', newThreadId: 'taken' }),
                ConfigurationError
            );
            const kept = await store.load('taken');
            assert.deepEqual(kept?.messages, [{ role: 'user', content: 'original' }], 'the target is untouched');

            const replaced = await store.fork({ threadId: 'src', newThreadId: 'taken', overwrite: true });
            assert.deepEqual(replaced.messages, SOURCE_MESSAGES, 'overwrite replaces the target');
            const after = await store.load('taken');
            assert.deepEqual(after?.messages, SOURCE_MESSAGES);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('forks a fork', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            const store = makeStore({ dir });
            await store.fork({ threadId: 'src', newThreadId: 'b1' });
            const forked = await store.fork({ threadId: 'b1', newThreadId: 'b2' });
            assert.deepEqual(forked.messages, SOURCE_MESSAGES);
            assert.deepEqual(forked.agentContext, SOURCE_CONTEXT);
            const b1 = await store.load('b1');
            const b2 = await store.load('b2');
            assert.deepEqual(b1?.messages, SOURCE_MESSAGES, 'the intermediate fork stays intact');
            assert.deepEqual(b2?.messages, SOURCE_MESSAGES);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('is durable — a new store over the same directory loads the fork', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            await makeStore({ dir }).fork({ threadId: 'src', newThreadId: 'branch' });

            const reopened = makeStore({ dir });
            const loaded = await reopened.load('branch');
            assert.ok(loaded, 'the fork survives a new store instance');
            assert.deepEqual(loaded.messages, SOURCE_MESSAGES);
            assert.deepEqual(loaded.agentContext, SOURCE_CONTEXT);
            assert.equal(loaded.sessionId, 'sess-1');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('sanitizes the new thread id', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            const store = makeStore({ dir });
            await store.fork({ threadId: 'src', newThreadId: 'branch/one' });
            const loaded = await store.load('branch/one');
            assert.ok(loaded, 'the unsafe id is sanitized on both write and read');
            assert.deepEqual(loaded.messages, SOURCE_MESSAGES);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('emits the store lifecycle event with the fork provenance', async () => {
        const dir = await makeTmpDir();
        try {
            await seedSource({ dir });
            const emitter = new EventEmitter();
            /** @type {any[]} */
            const events = ([]);
            emitter.on(EVENTS.SESSION.STORE_FORK, (/** @type {any} */ e) => events.push(e));
            const store = makeStore({ dir, eventEmitter: emitter });

            await store.fork({ threadId: 'src', newThreadId: 'branch' });
            const forkEvent = events.find((e) => e.forkedFrom === 'src');
            assert.ok(forkEvent, 'the fork is announced on the store emitter');
            assert.equal(forkEvent.threadId, 'branch');
            assert.equal(forkEvent.event, EVENTS.SESSION.STORE_FORK);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
