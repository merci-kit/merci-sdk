// @ts-check

/**
 * Wave 6 / SP8 — opt-in child persistence (D10).
 *
 * The contract: children are **in-memory by default**; when the host attaches a
 * `SessionStore` to the parent, its children are **durable** (each under its own
 * deterministic thread) and **forkable on request** — without the child ever
 * overwriting the parent's thread, and without a code-agent spawn pretending to
 * have a conversation.
 *
 * These checks are written against the pre-SP8 tree and are expected to fail
 * until the store travels with the delegation. The oracle is the store on disk:
 * a real `LocalFileSessionStore`, real `ChatSession` children and a stub vendor
 * transport, so the checkpoint is written by the same code a host runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { withTaskAgents, withAgentDelegation, createTaskTool } from '../lib/agentic/task.mjs';
import { listSpawns } from '../lib/agentic/spawn-registry.mjs';

/** @param {{text: string}} arg0 */
const oaiTextChunks = ({ text }) => (async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
    yield { usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } };
})();

/**
 * A stub that is both the vendor client and the SDK client: `session()` returns a
 * REAL ChatSession wired to the stub transport, so `run()` (and its checkpoint)
 * is the real code path.
 */
class StubClient extends EventEmitter {
    /** @param {{fail?: boolean}} [arg0] */
    constructor({ fail = false } = {}) {
        super();
        this.fail = fail;
        /** @type {any[]} */
        this.sessions = [];
        this.chat = {
            completions: {
                create: async () => {
                    if (this.fail) throw new Error('vendor exploded');
                    return oaiTextChunks({ text: 'child answer' })[Symbol.asyncIterator]();
                },
            },
        };
    }
    /** @param {string} model @returns {any} */
    session(model) {
        const s = new OaiChatSession({ client: /** @type {any} */ (this), model, eventEmitter: this });
        this.sessions.push(s);
        return s;
    }
    /** @param {{model?: string, sessionId?: string}} [arg0] @returns {any} */
    sessionWithId({ model = 'gpt-test', sessionId } = {}) {
        const s = new OaiChatSession({ client: /** @type {any} */ (this), model, eventEmitter: this });
        if (sessionId) s.withSessionId({ id: sessionId });
        this.sessions.push(s);
        return s;
    }
}

function makeTmpDir() {
    return mkdtempSync(join(tmpdir(), 'merci-durable-'));
}

/**
 * @param {{store?: any, threadId?: string, fail?: boolean}} [arg0]
 * @returns {{client: any, parent: any}}
 */
function makeParent({ store = null, threadId = 'parent-thread', fail = false } = {}) {
    const client = new StubClient({ fail });
    const parent = new OaiChatSession({ client: /** @type {any} */ (client), model: 'gpt-parent', eventEmitter: client });
    if (store) parent.withSessionStore({ store, threadId });
    return { client, parent };
}

/** @param {any} client @param {any} parent @param {string} [agent] */
async function spawn(client, parent, agent = 'worker') {
    const tool = /** @type {any} */ (createTaskTool({ session: parent }));
    return tool.execute({ args: { prompt: 'Do the durable thing', subagent_type: agent } });
}

/** @param {any} client */
const lastSpawn = (client) => listSpawns({ client }).at(-1);

// ─── In-memory is the default ──────────────────────────────────────────────

test('W6DUR/default-in-memory: without a store a child writes nothing', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent();
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        const out = await spawn(client, parent);
        assert.equal(out, 'child answer');
        const child = client.sessions.at(-1);
        assert.equal(child._sessionStore ?? null, null, 'the child has no store');
        assert.equal(child._threadId ?? null, null, 'and no thread id');
        assert.equal(lastSpawn(client)?.threadId ?? null, null, 'the handle says so');
        assert.deepEqual(readdirSync(dir), [], 'nothing was written');
        assert.equal(await store.load('parent-thread'), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── The store travels with the delegation ─────────────────────────────────

test('W6DUR/inherit-store: the child gets the parent store under its own thread', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle, 'the spawn has a handle');
        const child = client.sessions.at(-1);
        assert.equal(child._sessionStore, store, 'the same store instance');
        assert.equal(child._threadId, `spawn:${handle.id}`, 'a deterministic per-spawn thread');
        assert.notEqual(child._threadId, 'parent-thread', 'never the parent thread');
        assert.equal(handle.threadId, `spawn:${handle.id}`, 'the handle exposes it');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/checkpoint-written: the child conversation is on disk after it settles', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle, 'the spawn has a handle');
        const saved = /** @type {any} */ (await store.load(`spawn:${handle.id}`));
        assert.ok(saved, 'the child checkpoint exists');
        assert.ok(Array.isArray(saved.messages) && saved.messages.length > 0, 'with the conversation rows');
        const text = JSON.stringify(saved.messages);
        assert.ok(text.includes('Do the durable thing'), 'the brief is part of it');
        assert.ok(saved.updatedAt, 'stamped');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/parent-untouched: a child never writes the parent thread', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        assert.equal(await store.load('parent-thread'), null, 'the parent thread is still absent');
        assert.equal(readdirSync(dir).length, 1, 'exactly one child file');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/failure-saves: a child that fails still leaves its partial checkpoint', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store, fail: true });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await assert.rejects(() => spawn(client, parent), /vendor exploded|failed/i);
        const handle = lastSpawn(client);
        assert.ok(handle, 'the spawn has a handle');
        assert.equal(handle.status, 'error');
        const saved = await store.load(`spawn:${handle.id}`);
        assert.ok(saved, 'the failed child still has a checkpoint');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── Forkable and resumable on request ─────────────────────────────────────

test('W6DUR/fork: forkSpawn branches the child thread and leaves the original', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle, 'the spawn has a handle');
        const original = /** @type {any} */ (await store.load(`spawn:${handle.id}`));
        const { forkSpawn } = await import('../lib/agentic/task.mjs');
        const forked = await forkSpawn({ client, id: handle.id, newThreadId: 'branch-1' });
        assert.ok(forked, 'the fork returns the new checkpoint');
        assert.equal(forked.threadId, 'branch-1', 'the RETURNED payload is the branch, not the source');
        const branch = /** @type {any} */ (await store.load('branch-1'));
        assert.ok(branch, 'the branch is stored');
        assert.equal(branch.threadId, 'branch-1', 'the branch knows its own thread');
        assert.deepEqual(branch.messages, original.messages, 'with the same conversation');
        assert.ok(await store.load(`spawn:${handle.id}`), 'the original survives');
        const listed = await store.list();
        assert.ok(listed.some((/** @type {any} */ e) => e.threadId === 'branch-1'), 'list() reports the branch thread, not the sanitized file name');
        assert.ok(listed.some((/** @type {any} */ e) => e.threadId === handle.threadId), 'and the child thread saved by the run maps back to its spawn id');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/resume: a fresh session can load a child thread and continue it', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle, 'the spawn has a handle');
        const fresh = new OaiChatSession({ client: /** @type {any} */ (client), model: 'gpt-test', eventEmitter: client });
        fresh.withSessionStore({ store, threadId: `spawn:${handle.id}` });
        const loaded = await fresh.loadCheckpoint();
        assert.ok(loaded, 'the checkpoint loads in a new session');
        assert.ok(Array.isArray(fresh._lastStepMessages) && fresh._lastStepMessages.length > 0, 'messages restored');
        assert.ok(JSON.stringify(fresh._lastStepMessages).includes('Do the durable thing'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/fork-cross-process: a fork works from the store alone', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle);
        const { forkSpawn } = await import('../lib/agentic/task.mjs');
        // No client, no registry: exactly what a second process has.
        const forked = await forkSpawn({ store, threadId: handle.threadId, newThreadId: 'branch-2' });
        assert.equal(forked.threadId, 'branch-2');
        assert.ok(await store.load('branch-2'));
        // A fresh client (a restarted process) can fork by id alone.
        const restarted = new StubClient();
        const byId = await forkSpawn({ client: restarted, id: handle.id, store, newThreadId: 'branch-3' });
        assert.equal(byId.threadId, 'branch-3', 'the id maps back to the deterministic thread');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/save-error: a failed durability write never loses the answer', async () => {
    const dir = makeTmpDir();
    try {
        const real = new LocalFileSessionStore({ dir });
        const broken = {
            /** @param {{threadId: string, data: any}} arg0 */
            save: async ({ threadId, data }) => {
                if (String(threadId).startsWith('spawn:')) throw new Error('disk is on fire');
                return real.save({ threadId, data });
            },
            load: real.load.bind(real),
            fork: real.fork.bind(real),
            list: real.list.bind(real),
        };
        const { client, parent } = makeParent({ store: broken });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        const out = await spawn(client, parent);
        assert.equal(out, 'child answer', 'the child answer survives the failed write');
        const handle = lastSpawn(client);
        assert.ok(handle);
        assert.match(String(handle.checkpointError), /disk is on fire/, 'and the host can see why');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/checkpoint-error-clears: a later successful write clears the failure', async () => {
    const dir = makeTmpDir();
    try {
        const real = new LocalFileSessionStore({ dir });
        let spawnSaves = 0;
        const flaky = {
            /** @param {{threadId: string, data: any}} arg0 */
            save: async ({ threadId, data }) => {
                if (String(threadId).startsWith('spawn:')) {
                    spawnSaves += 1;
                    // #1 is the run's auto-checkpoint; #2 is the settle save.
                    if (spawnSaves === 2) throw new Error('transient disk error');
                }
                return real.save({ threadId, data });
            },
            load: real.load.bind(real),
            fork: real.fork.bind(real),
            list: real.list.bind(real),
        };
        const { client, parent } = makeParent({ store: flaky });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle);
        assert.match(String(handle.checkpointError), /transient disk error/, 'the first write failed');
        const { continueSpawn } = await import('../lib/agentic/task.mjs');
        await continueSpawn({ client, id: handle.id, prompt: 'one more turn' });
        assert.equal(handle.checkpointError, null, 'a later successful write clears the flag');
        const saved = /** @type {any} */ (await real.load(/** @type {string} */ (handle.threadId)));
        assert.ok(JSON.stringify(saved.messages).includes('one more turn'), 'and the checkpoint is current');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/no-clobber: a failed continuation never erases the good checkpoint', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        await spawn(client, parent);
        const handle = lastSpawn(client);
        assert.ok(handle);
        const before = /** @type {any} */ (await store.load(/** @type {string} */ (handle.threadId)));
        assert.ok(before.messages.length > 0, 'the first turn is stored');
        const { continueSpawn } = await import('../lib/agentic/task.mjs');
        // Abort before the loop takes its first snapshot: the turn has no rows.
        await assert.rejects(() => continueSpawn({ client, id: handle.id, prompt: 'never runs', signal: AbortSignal.abort() }));
        const after = /** @type {any} */ (await store.load(/** @type {string} */ (handle.threadId)));
        assert.ok(after, 'the checkpoint still exists');
        assert.deepEqual(after.messages, before.messages, 'the previous turns were not erased (exactly)');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/fork-errors: forking an unknown spawn or a session-less spawn is explicit', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [
            { name: 'worker', model: 'gpt-test' },
            { name: 'coder', model: 'gpt-test', execute: async () => 'code' },
        ] });
        const { forkSpawn } = await import('../lib/agentic/task.mjs');
        await assert.rejects(
            () => forkSpawn({ client, id: 'nope', newThreadId: 'x' }),
            /no spawn with id/,
        );
        await spawn(client, parent, 'coder');
        await assert.rejects(
            () => forkSpawn({ client, id: /** @type {any} */ (lastSpawn(client)).id, newThreadId: 'x' }),
            /no conversation to fork/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── Spawns without a conversation, and nesting ────────────────────────────

test('W6DUR/code-agent: a code-agent spawn has no thread and no checkpoint', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'coder', model: 'gpt-test', execute: async () => 'code answer' }] });
        const out = await spawn(client, parent, 'coder');
        assert.equal(out, 'code answer');
        assert.equal(lastSpawn(client)?.threadId ?? null, null);
        assert.deepEqual(readdirSync(dir), [], 'a code agent writes no conversation');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('W6DUR/grandchild: a nested spawn gets its own thread, not the child one', async () => {
    const dir = makeTmpDir();
    try {
        const store = new LocalFileSessionStore({ dir });
        const { client, parent } = makeParent({ store });
        withTaskAgents({ client, agents: [{ name: 'worker', model: 'gpt-test' }] });
        withAgentDelegation({ client, maxDepth: 2 });
        await spawn(client, parent);
        const child = client.sessions.at(-1);
        await spawn(client, child);
        const grandchild = client.sessions.at(-1);
        const handles = listSpawns({ client });
        const grandHandle = handles.find((/** @type {any} */ h) => h.id === grandchild._spawnId);
        assert.ok(grandHandle, 'the grandchild has a handle');
        assert.equal(grandchild._threadId, `spawn:${grandHandle.id}`);
        assert.notEqual(grandchild._threadId, child._threadId, 'its own thread');
        assert.ok(await store.load(child._threadId), 'the child thread is still there');
        assert.ok(await store.load(grandchild._threadId), 'and the grandchild thread exists');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
