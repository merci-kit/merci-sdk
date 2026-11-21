// @ts-check

/**
 * The durable inbox (`withInboxStore`).
 *
 * The contract under test is the one `enqueueInput` already has, extended across
 * a restart: the store holds the PENDING rows under the conversation's thread id,
 * a claimed row leaves it, and a row that was never delivered is still there for
 * the next process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { InMemoryInboxStore, LocalFileInboxStore } from '../lib/agentic/inbox-store.mjs';
import { deactivateClaimOwner } from '../lib/agentic/scheduler/claims.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @param {string} text @returns {any} */
const queueRow = (text) => {
    const row = /** @type {any} */ (createUserMessage({ provider: 'openai', content: text }));
    row.delivery = 'queue';
    return row;
};

/** @param {string} text @returns {any} */
const userRow = (text) => createUserMessage({ provider: 'openai', content: text });

/**
 * A builder with a stubbed engine call and a durable inbox.
 * @param {{store: any, threadId?: string}} arg0
 * @returns {{session: any, runs: Array<any>}}
 */
function durableHarness({ store, threadId = 'thread-1' }) {
    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.provider = 'openai';
    session.eventEmitter = new EventEmitter();
    session.withInboxStore({ store, threadId });
    /** @type {Array<any>} */
    const runs = [];
    session._runOnce = async (/** @type {{initialInput: any}} */ { initialInput }) => {
        runs.push(initialInput);
        return `answer ${runs.length}`;
    };
    return { session, runs };
}

/** @param {any} rows @param {string} text @returns {number} */
const countOf = (rows, text) => JSON.stringify(rows ?? []).split(text).length - 1;

test('InMemoryInboxStore hands back copies, not the stored rows', async () => {
    const store = new InMemoryInboxStore();
    const row = queueRow('hello');
    await store.save({ threadId: 't', rows: [row] });

    const loaded = await store.load({ threadId: 't' });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].content, 'hello');
    /** @type {any} */ (loaded[0]).content = 'mutated';
    assert.equal((await store.load({ threadId: 't' }))[0].content, 'hello', 'the store kept its own value');

    await store.save({ threadId: 't', rows: [] });
    assert.deepEqual(await store.load({ threadId: 't' }), [], 'an empty queue leaves nothing behind');
    assert.deepEqual(await store.list(), []);
});

test('LocalFileInboxStore persists, lists and clears per thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-inbox-'));
    try {
        const store = new LocalFileInboxStore({ dir });
        await store.save({ threadId: 'a', rows: [queueRow('for a')] });
        await store.save({ threadId: 'B', rows: [queueRow('for B')] });

        assert.deepEqual((await store.load({ threadId: 'a' })).map((row) => row.content), ['for a']);
        assert.deepEqual((await store.load({ threadId: 'B' })).map((row) => row.content), ['for B'], 'case-distinct ids stay distinct files');
        assert.deepEqual((await store.list()).sort(), ['B', 'a']);

        await store.clear({ threadId: 'a' });
        assert.deepEqual(await store.load({ threadId: 'a' }), []);
        assert.deepEqual(await store.list(), ['B'], 'the cleared thread is gone from the dispatcher list');
        await store.clear({ threadId: 'a' });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a corrupt inbox file is quarantined and the session starts empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-inbox-corrupt-'));
    try {
        const store = new LocalFileInboxStore({ dir });
        await store.save({ threadId: 'c', rows: [userRow('placeholder')] });
        const [name] = await readdir(dir);
        await writeFile(join(dir, String(name)), '{ not json', 'utf8');

        assert.deepEqual(await store.load({ threadId: 'c' }), [], 'a broken file is not user data we can trust');
        const after = await readdir(dir);
        assert.equal(after.length, 1, 'the broken file is moved out of the way');
        assert.ok(after[0].includes('.corrupt-'), 'the bytes are kept as a quarantine sibling, not deleted');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a queued message survives a restart and is answered by the next session', async () => {
    const store = new InMemoryInboxStore();

    const first = durableHarness({ store });
    first.session.enqueueInput({ input: 'survive the restart' });
    await first.session.loadInbox();
    await first.session._flushInbox();

    // "Restart": a fresh builder over the same conversation id.
    const second = durableHarness({ store });
    assert.deepEqual(second.session.getPendingInputs(), [], 'nothing is in memory');
    const restored = await second.session.loadInbox();
    assert.equal(restored.length, 1, 'the durable queue was loaded');
    assert.equal(restored[0].content, 'survive the restart');

    const drained = await second.session.drainInbox();
    assert.equal(second.runs.length, 1);
    assert.equal(countOf(second.runs[0], 'survive the restart'), 1);
    assert.equal(second.session.getPendingInputs().length, 0);
    assert.deepEqual(await store.load({ threadId: 'thread-1' }), [], 'the store dropped the delivered message');
    assert.match(String(drained?.text), /answer 1/);
});

test('run() writes the durable inbox and drops a delivered row', async () => {
    const store = new InMemoryInboxStore();
    const { session, runs } = durableHarness({ store });
    const row = /** @type {any} */ (queueRow('run me'));
    session.enqueueInput({ input: row });
    await session.loadInbox();

    assert.equal((await store.load({ threadId: 'thread-1' })).length, 1, 'pending before the turn');

    await session.run({ initialInput: 'first' });

    assert.equal(runs.length, 1, 'the pending message is delivered into the opening turn');
    assert.equal(countOf(runs[0], 'run me'), 1);
    assert.deepEqual(await store.load({ threadId: 'thread-1' }), [], 'delivered rows leave the store');
});

test('a message enqueued into an idle, never-run session is persisted', async () => {
    const store = new InMemoryInboxStore();
    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.provider = 'openai';
    session.withInboxStore({ store, threadId: 'idle-thread' });

    session.enqueueInput({ input: 'written before any run' });
    // The load kicked by the enqueue is fire-and-forget; the public await settles it.
    await session.loadInbox();
    await session._flushInbox();

    const stored = await store.load({ threadId: 'idle-thread' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].content, 'written before any run');
});

test('cancelling a pending message removes it from the durable queue', async () => {
    const store = new InMemoryInboxStore();
    const { session } = durableHarness({ store });
    /** @type {any} */
    const row = session.enqueueInput({ input: 'withdraw me' });
    await session.loadInbox();
    assert.equal((await store.load({ threadId: 'thread-1' })).length, 1);

    session.cancelInput({ input: row });
    await session._flushInbox();
    assert.deepEqual(await store.load({ threadId: 'thread-1' }), []);
});

test('withInboxStore refuses a store that cannot load, save and clear', () => {
    const session = /** @type {any} */ (new ChatSessionBuilder());
    assert.throws(() => session.withInboxStore({ store: {} }), /load\/save\/clear/);
    assert.throws(() => session.withInboxStore(), /load\/save\/clear/);
});

// ---------------------------------------------------------------------------
// The lease: one drainer per thread, across processes
// ---------------------------------------------------------------------------

test('a drain is skipped while another owner holds the lease, and delivers after it is released', async () => {
    const store = new InMemoryInboxStore();
    const { session, runs } = durableHarness({ store });
    session.enqueueInput({ input: 'mine to deliver' });
    await session.loadInbox();

    assert.equal(await store.lease.acquire({ threadId: 'thread-1', owner: 'other-worker' }), true);
    const skipped = await session.drainInbox();
    assert.equal(skipped?.skipped, 'lease', 'a busy queue is reported, not raced');
    assert.deepEqual(skipped?.answers, []);
    assert.equal(runs.length, 0, 'no model call under another owner’s lease');
    assert.equal(session.getPendingInputs().length, 1, 'the message is untouched');

    assert.equal(await store.lease.release({ threadId: 'thread-1', owner: 'other-worker' }), true);
    const drained = await session.drainInbox();
    assert.equal(drained?.answers.length, 1, 'the queue is worked once the lease is free');
    assert.equal(session.getPendingInputs().length, 0);
});

test('a drain releases its lease, so the next worker can take the thread', async () => {
    const store = new InMemoryInboxStore();
    const { session } = durableHarness({ store });
    session.enqueueInput({ input: 'work me' });
    await session.loadInbox();

    await session.drainInbox();
    assert.equal(await store.lease.acquire({ threadId: 'thread-1', owner: 'next-worker' }), true, 'the lease was released');
    await store.lease.release({ threadId: 'thread-1', owner: 'next-worker' });
});

test('a file lease left by a stopped owner is reclaimed, not waited on forever', async () => {
    // The in-memory store needs no staleness: its map dies with the process, and a
    // drain always releases in `finally`. A FILE lease outlives a crash, so the
    // claim store's orphan/stale path is what frees it.
    const dir = await mkdtemp(join(tmpdir(), 'merci-inbox-orphan-'));
    try {
        const store = new LocalFileInboxStore({ dir });
        const { session } = durableHarness({ store, threadId: 't' });
        session.enqueueInput({ input: 'reclaim me' });
        await session.loadInbox();

        assert.equal(await store.lease.acquire({ threadId: 't', owner: 'crashed-worker' }), true);
        // That instance stopped: its token is no longer a live owner in this
        // process, which is the claim store's documented orphan path.
        deactivateClaimOwner({ owner: 'crashed-worker' });

        const drained = await session.drainInbox();
        assert.equal(drained?.answers.length, 1, 'the orphaned lease did not strand the queue');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the file store leases under its own directory and list() ignores the lease files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-inbox-lease-'));
    try {
        const store = new LocalFileInboxStore({ dir });
        await store.save({ threadId: 't', rows: [queueRow('queued')] });
        assert.equal(await store.lease.acquire({ threadId: 't', owner: 'w1' }), true);
        assert.equal(await store.lease.acquire({ threadId: 't', owner: 'w2' }), false, 'one owner per thread');
        assert.deepEqual(await store.list(), ['t'], 'the lease file is not a queue');
        assert.equal(await store.lease.release({ threadId: 't', owner: 'w1' }), true);
        assert.equal(await store.lease.acquire({ threadId: 't', owner: 'w2' }), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
