// @ts-check

/**
 * @file IR-4: one identifier across the workspace, claim, snapshot, and
 * operator surfaces (RC-03).
 * @version 0.12.0
 *
 * @description
 * A real `WorkspaceManager` on `git-worktree` in a temp repository and a real
 * `WorkScheduler` over a memory work source. One item stays running and one is
 * queued for retry, so the identifier is observable through all four consumers:
 * the workspace key the manager derives, the claim store it is claimed under,
 * the `snapshot()` rows' `workItemId`/`identifier`, and the operator detail
 * resolution by `identifier` (200) versus the provider id (404).
 *
 * The workspace key is read from the handle the manager returned, never
 * recomputed, so the test proves the scheduler passed the item's `identifier`
 * into the workspace API's `workItemId` option.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { ConfigurationError } from '../lib/core/errors.mjs';

import {
    WorkScheduler,
    createEngineRunner,
    createMemoryClaimStore,
    createMemoryWorkSource,
    normalizeWorkItem
} from '../lib/agentic/scheduler/index.mjs';
import { WORKSPACE_STRATEGIES, WorkspaceManager, workspaceKeyFor } from '../lib/agentic/workspace/index.mjs';
import { normalizeIdentifier } from '../lib/agentic/workspace/identity.mjs';
import { toItemResponse } from '../lib/agentic/operator/view.mjs';
import { threadIdFor } from '../lib/agentic/thread-ids.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

const RUNNING_IDENTIFIER = 'MER-RUN';
const RUNNING_WORK_ITEM_ID = 'wi-run';
const RETRY_IDENTIFIER = 'MER-RETRY';
const RETRY_WORK_ITEM_ID = 'wi-retry';

/** True when the host has a usable `git`; the whole file is skipped otherwise. */
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * A manual clock: no timer fires on its own, so no automatic poll or retry
 * tick can race the assertions.
 * @param {{now?: number}} [arg0] -
 * @returns {{now: () => number, setTimeout: (fn: () => void, ms: number) => number, clearTimeout: (handle: unknown) => void}}
 */
function createClock({ now = 1_000 } = {}) {
    let current = now;
    let nextHandle = 1;
    /** @type {Map<number, {at: number, fn: () => void}>} */
    const timers = new Map();
    return {
        now: () => current,
        setTimeout: (fn, ms) => {
            const handle = nextHandle++;
            timers.set(handle, { at: current + ms, fn });
            return handle;
        },
        clearTimeout: (handle) => { if (typeof handle === 'number') timers.delete(handle); }
    };
}

/**
 * Run git and throw on a non-zero exit. Test setup only.
 * @param {{args: Array<string>, cwd: string}} arg0 -
 * @returns {string} Trimmed stdout.
 */
function runGit({ args, cwd }) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
}

/**
 * Create a real repository with one commit.
 * @param {{dir: string}} arg0 -
 * @returns {Promise<void>}
 */
async function createRepo({ dir }) {
    await mkdir(dir, { recursive: true });
    runGit({ args: ['init', '-b', 'main'], cwd: dir });
    await writeFile(join(dir, 'base.txt'), 'base\n');
    runGit({ args: ['add', '.'], cwd: dir });
    runGit({
        args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '-m', 'base'],
        cwd: dir
    });
}

/**
 * Poll a predicate until it holds; real git IO can outlast a microtask flush.
 * @param {{predicate: () => boolean, label: string, timeoutMs?: number}} arg0 -
 * @returns {Promise<void>}
 */
async function waitFor({ predicate, label, timeoutMs = 10_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
}

/**
 * A fake fluent session that records the thread it was configured with.
 * @param {{run?: ((arg0: {signal: AbortSignal}) => Promise<string>)|null}} [arg0] -
 * @returns {{client: {session: (model: string) => Record<string, any>}, seen: {threadIds: string[]}}}
 */
function createThreadClient({ run = null } = {}) {
    /** @type {{threadIds: string[]}} */
    const seen = { threadIds: [] };
    const client = {
        /** @param {string} model */
        session(model) {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'fake',
                model,
                /** @param {{store: unknown, threadId: string}} args */
                withSessionStore(args) {
                    seen.threadIds.push(args.threadId);
                    return session;
                },
                /** @param {{options: {signal: AbortSignal}}} args */
                async run(args) {
                    if (run !== null) return run({ signal: args.options.signal });
                    return 'done';
                }
            };
            return session;
        }
    };
    return { client, seen };
}

/**
 * A normalized work item for the runner tests.
 * @param {string} identifier -
 * @returns {WorkItem}
 */
function threadWorkItem(identifier) {
    return normalizeWorkItem({
        raw: { id: `wi-${identifier}`, identifier, title: `Work ${identifier}`, state: 'Todo', dispatchable: true }
    });
}

/** A store with no saved checkpoint. */
function emptyStore() {
    return { load: async () => null, save: async () => undefined };
}

/** @returns {AbortSignal} */
function idleSignal() {
    return new AbortController().signal;
}

/**
 * The running item waits for its abort; the retry item fails once.
 * @param {{runs: Array<{identifier: string, key: string, path: string}>}} arg0 -
 * @returns {{run: (arg0: {item: WorkItem, workspace: Record<string, unknown>|null, signal: AbortSignal}) => Promise<{status: string}>}}
 */
function createWorkflow({ runs }) {
    return {
        run: async ({ item, workspace, signal }) => {
            if (item.identifier === RETRY_IDENTIFIER) {
                throw Object.assign(new Error('transient'), { name: 'Error', code: 'E_TRANSIENT' });
            }
            assert.ok(workspace !== null, 'the manager ensured a workspace before the run');
            runs.push({
                identifier: item.identifier,
                key: /** @type {string} */ (workspace.key),
                path: /** @type {string} */ (workspace.path)
            });
            await new Promise((resolve) => {
                if (signal.aborted) {
                    resolve(undefined);
                    return;
                }
                signal.addEventListener('abort', () => resolve(undefined), { once: true });
            });
            return { status: 'canceled' };
        }
    };
}

test('one identifier keys the workspace, the claim, the snapshot, and the operator route', {
    timeout: 20000,
    skip: GIT_AVAILABLE ? false : 'git is not available on PATH'
}, async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-orchestration-identity-'));
    const repo = join(base, 'repo');
    try {
        await createRepo({ dir: repo });
    } catch (error) {
        await rm(base, { recursive: true, force: true });
        throw error;
    }
    /** @type {Array<{name: string, envelope: Record<string, any>}>} */
    const events = [];
    const eventEmitter = {
        emit: (/** @type {string} */ name, /** @type {Record<string, any>} */ envelope) => {
            events.push({ name, envelope });
        }
    };
    const manager = new WorkspaceManager({
        strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
        repoRoot: repo,
        root: join(base, 'worktrees'),
        eventEmitter
    });
    const claims = createMemoryClaimStore();
    /** @type {Array<{identifier: string, key: string, path: string}>} */
    const runs = [];
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({
            items: [
                {
                    id: RUNNING_WORK_ITEM_ID,
                    identifier: RUNNING_IDENTIFIER,
                    title: 'Run',
                    state: 'Todo',
                    dispatchable: true
                },
                {
                    id: RETRY_WORK_ITEM_ID,
                    identifier: RETRY_IDENTIFIER,
                    title: 'Retry',
                    state: 'Todo',
                    dispatchable: true
                }
            ]
        }),
        workflow: createWorkflow({ runs }),
        workspace: manager,
        claims,
        eventEmitter,
        clock: createClock(),
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 2 },
        retry: { baseMs: 60_000, maxMs: 60_000 },
        continuation: { delayMs: 0, max: 0 },
        pollIntervalMs: 60_000
    });
    let stopped = false;
    try {
        await scheduler.start();
        await waitFor({
            predicate: () => runs.length === 1 && scheduler.snapshot().retrying.length === 1,
            label: 'the running attempt and the queued retry'
        });
        const live = scheduler.snapshot();

        // 1. The workspace key the manager derived from the item's identifier.
        const run = runs[0];
        assert.equal(run.identifier, RUNNING_IDENTIFIER);
        const expectedKey = workspaceKeyFor({ workItemId: RUNNING_IDENTIFIER });
        assert.equal(run.key, expectedKey, 'the manager keyed the workspace by the identifier');
        assert.equal(basename(run.path), expectedKey, 'the directory stem is that key');
        const handle = manager.handleFor({ workItemId: RUNNING_IDENTIFIER });
        assert.equal(handle.key, expectedKey);
        assert.equal(handle.path, run.path);

        // 1b. A ring consumer joins workspace:* to work_item:* on `identifier`:
        // the dispatched event keeps the provider id, the created event names
        // the scheduling identifier it was keyed by.
        const dispatched = events.find((entry) => entry.name === 'work_item:dispatched'
            && entry.envelope.identifier === RUNNING_IDENTIFIER);
        assert.ok(dispatched, 'the running dispatch event exists');
        assert.equal(dispatched.envelope.workItemId, RUNNING_WORK_ITEM_ID);
        const created = events.find((entry) => entry.name === 'workspace:created'
            && entry.envelope.identifier === RUNNING_IDENTIFIER);
        assert.ok(created, 'the created workspace event carries the identifier');
        assert.equal(created.envelope.identifier, dispatched.envelope.identifier);
        assert.equal(created.envelope.workItemId, RUNNING_IDENTIFIER);

        // 2. The claim store is keyed by the same value the scheduler holds.
        assert.equal(await claims.isClaimed({ workItemId: RUNNING_IDENTIFIER }), true);
        assert.ok((await claims.list()).includes(RUNNING_IDENTIFIER));
        assert.equal(
            await claims.acquire({ workItemId: RUNNING_IDENTIFIER, owner: 'another-runner' }),
            false,
            'the running item is already claimed under that key'
        );
        assert.ok(live.claimed.includes(RUNNING_IDENTIFIER));

        // 3. Snapshot rows keep the provider id and the human key apart.
        const runningRow = live.running.find((row) => row.identifier === RUNNING_IDENTIFIER);
        assert.ok(runningRow, 'the running row exists');
        assert.equal(runningRow.workItemId, RUNNING_WORK_ITEM_ID);
        assert.equal(runningRow.identifier, RUNNING_IDENTIFIER);
        assert.equal(runningRow.workspacePath, run.path);
        const retryRow = live.retrying.find((row) => row.identifier === RETRY_IDENTIFIER);
        assert.ok(retryRow, 'the retrying row exists');
        assert.equal(retryRow.workItemId, RETRY_WORK_ITEM_ID);
        assert.equal(retryRow.identifier, RETRY_IDENTIFIER);

        // 4. The operator resolves by identifier, and by the provider id as a
        // fallback (the event feed carries only the provider id).
        const runningDetail = toItemResponse({ snapshot: live, id: RUNNING_IDENTIFIER, now: 1_000 });
        assert.ok(runningDetail, 'the identifier resolves');
        assert.equal(runningDetail.status, 'running');
        assert.equal(runningDetail.workItemId, RUNNING_WORK_ITEM_ID);
        assert.ok(runningDetail.workspace, 'the running detail carries the workspace');
        assert.equal(runningDetail.workspace.path, run.path);
        const byProviderId = toItemResponse({ snapshot: live, id: RUNNING_WORK_ITEM_ID, now: 1_000 });
        assert.ok(byProviderId, 'the provider id resolves as a fallback');
        assert.equal(byProviderId.identifier, RUNNING_IDENTIFIER);
        assert.equal(byProviderId.status, 'running');
        const retryDetail = toItemResponse({ snapshot: live, id: RETRY_IDENTIFIER, now: 1_000 });
        assert.ok(retryDetail);
        assert.equal(retryDetail.status, 'retrying');

        // The release used the same key: nothing is left claimed.
        await scheduler.stop({ timeoutMs: 2000 });
        stopped = true;
        assert.deepEqual(await claims.list(), []);
        assert.equal(await claims.isClaimed({ workItemId: RUNNING_IDENTIFIER }), false);
    } finally {
        if (!stopped) await scheduler.stop({ timeoutMs: 2000 });
        await rm(base, { recursive: true, force: true });
    }
});

test('WorkspaceManager keeps identifier optional and copies it onto the handle', async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-identifier-'));
    try {
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.DIRECTORY,
            root: join(base, 'workspaces')
        });
        const anonymous = await manager.ensure({ workItemId: 'MER-NONE' });
        assert.equal(anonymous.identifier, null, 'an omitted identifier is null, not invented');
        const named = await manager.ensure({ workItemId: 'MER-NAMED', identifier: 'MER-NAMED' });
        assert.equal(named.identifier, 'MER-NAMED');
        assert.equal(manager.handleFor({ workItemId: 'MER-NONE' }).identifier, null);
        assert.equal(
            manager.handleFor({ workItemId: 'MER-NAMED', identifier: 'MER-NAMED' }).identifier,
            'MER-NAMED'
        );
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('threadIdFor builds kind:id, keeps internal spaces, and refuses an empty or missing part', () => {
    assert.equal(threadIdFor({ kind: 'work', id: 'MER-1' }), 'work:MER-1');
    assert.equal(threadIdFor({ kind: 'work', id: 'Fix login page' }), 'work:Fix login page');
    assert.equal(threadIdFor({ kind: 'work', id: ' MER-1 ' }), 'work:MER-1');
    assert.equal(threadIdFor({ kind: ' work ', id: ' MER-1 ' }), 'work:MER-1');
    assert.throws(
        () => threadIdFor({ kind: 'work', id: '' }),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_thread_id'
    );
    assert.throws(
        () => threadIdFor({ kind: 'work', id: '   ' }),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_thread_id'
    );
    assert.throws(
        () => threadIdFor(/** @type {{kind: string, id: string}} */ ({ id: 'MER-1' })),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_thread_id'
    );
});

test('createEngineRunner: a custom threadId string reaches the agentic store thread', async () => {
    /** @type {{threadId: string|null}} */
    const seen = { threadId: null };
    const client = {
        session: () => ({
            provider: 'fake',
            withSessionStore(/** @type {{store: unknown, threadId: string}} */ args) {
                seen.threadId = args.threadId;
                return this;
            },
            async run() { return 'done'; }
        })
    };
    const store = { load: async () => null, save: async () => undefined };
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        store,
        prompt: 'go',
        threadId: 'host:attempt-1'
    });
    const result = await runner.run({
        item: normalizeWorkItem({ raw: { id: 'wi-1', identifier: 'MER-1', title: 'T', state: 'Todo', dispatchable: true } }),
        attempt: 1,
        signal: new AbortController().signal
    });
    assert.equal(result.status, 'completed');
    assert.equal(seen.threadId, 'host:attempt-1');
});

test('scheduler: the attempt thread wins over the configured runner thread and the snapshot names it', { timeout: 15000 }, async () => {
    const { client, seen } = createThreadClient({
        run: ({ signal }) => new Promise((resolve) => {
            if (signal.aborted) {
                resolve('done');
                return;
            }
            signal.addEventListener('abort', () => resolve('done'), { once: true });
        })
    });
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        store: emptyStore(),
        prompt: 'go',
        threadId: 'host:abc'
    });
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({
            items: [{ id: 'wi-thread', identifier: 'MER-THREAD', title: 'Thread', state: 'Todo', dispatchable: true }]
        }),
        workflow: runner,
        claims: createMemoryClaimStore(),
        clock: createClock(),
        activeStates: ['Todo'],
        terminalStates: [],
        concurrency: { global: 1 },
        pollIntervalMs: 60_000
    });
    try {
        await scheduler.start();
        await waitFor({
            predicate: () => seen.threadIds.length === 1,
            label: 'the runner to configure its store thread'
        });
        const live = scheduler.snapshot();
        assert.equal(live.running.length, 1);
        assert.equal(live.running[0].identifier, 'MER-THREAD');
        assert.equal(live.running[0].threadId, 'work:MER-THREAD');
        assert.equal(seen.threadIds[0], 'work:MER-THREAD');
        assert.equal(live.running[0].threadId, seen.threadIds[0]);
    } finally {
        await scheduler.stop({ timeoutMs: 2000 });
    }
});

test('createEngineRunner refuses an empty or non-string configured thread id', () => {
    const base = { engine: 'agentic', client: createThreadClient().client, model: 'm', prompt: 'go' };
    for (const value of ['', '  ', 42]) {
        assert.throws(
            () => createEngineRunner({ ...base, threadId: /** @type {any} */ (value) }),
            (error) => error instanceof ConfigurationError && error.option === 'invalid_thread_id',
            `threadId ${JSON.stringify(value)} must be refused`
        );
    }
    assert.doesNotThrow(() => createEngineRunner({ ...base, threadId: null }));
});

test('createEngineRunner refuses a resolved thread id that is not a non-empty string', async () => {
    for (const returned of ['', '  ', 42, undefined, null]) {
        const runner = createEngineRunner({
            engine: 'agentic',
            client: createThreadClient().client,
            model: 'm',
            store: emptyStore(),
            prompt: 'go',
            threadId: () => /** @type {any} */ (returned)
        });
        await assert.rejects(
            runner.run({ item: threadWorkItem('MER-BAD'), attempt: 1, signal: idleSignal() }),
            (error) => error instanceof ConfigurationError && error.option === 'invalid_thread_id',
            `resolved ${JSON.stringify(returned)} must be refused`
        );
    }
});

test('a threadId resolver reaches the store and a colon in the kind stays literal', async () => {
    const { client, seen } = createThreadClient();
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        store: emptyStore(),
        prompt: 'go',
        threadId: ({ item, attempt }) => `item:${item.identifier}:${attempt}`
    });
    const result = await runner.run({ item: threadWorkItem('MER-FN'), attempt: 2, signal: idleSignal() });
    assert.equal(result.status, 'completed');
    assert.equal(seen.threadIds[0], 'item:MER-FN:2');
    assert.equal(threadIdFor({ kind: 'work:a', id: 'b' }), 'work:a:b');
});

test('a throwing threadId resolver propagates', async () => {
    const runner = createEngineRunner({
        engine: 'agentic',
        client: createThreadClient().client,
        model: 'm',
        store: emptyStore(),
        prompt: 'go',
        threadId: () => { throw new Error('resolver boom'); }
    });
    await assert.rejects(
        runner.run({ item: threadWorkItem('MER-THROW'), attempt: 1, signal: idleSignal() }),
        /resolver boom/
    );
});

test('one runner refuses a thread id reused for a different item but allows the same item retry', async () => {
    const { client } = createThreadClient();
    const runner = createEngineRunner({
        engine: 'agentic',
        client,
        model: 'm',
        store: emptyStore(),
        prompt: 'go',
        threadId: () => 'shared:thread'
    });
    const item = threadWorkItem('MER-SAME');
    assert.equal((await runner.run({ item, attempt: 1, signal: idleSignal() })).status, 'completed');
    assert.equal((await runner.run({ item, attempt: 2, signal: idleSignal() })).status, 'completed');
    await assert.rejects(
        runner.run({ item: threadWorkItem('MER-OTHER'), attempt: 1, signal: idleSignal() }),
        (error) => error instanceof ConfigurationError
            && error.option === 'thread_collision'
            && error.message.includes('MER-SAME')
            && error.message.includes('MER-OTHER')
    );
});

test('normalizeIdentifier trims strings, treats blank as absent, and refuses other types', () => {
    assert.equal(normalizeIdentifier({ value: null }), null);
    assert.equal(normalizeIdentifier({ value: undefined }), null);
    assert.equal(normalizeIdentifier({ value: ' MER-1 ' }), 'MER-1');
    assert.equal(normalizeIdentifier({ value: '   ' }), null);
    for (const value of [42, {}]) {
        assert.throws(
            () => normalizeIdentifier({ value }),
            (error) => error instanceof ConfigurationError && error.option === 'invalid_identifier'
        );
    }
});

test('one normalized identifier reaches the handle, the created event, and the hook event', async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-identity-'));
    try {
        /** @type {Array<{name: string, envelope: Record<string, any>}>} */
        const events = [];
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.DIRECTORY,
            root: join(base, 'workspaces'),
            eventEmitter: {
                emit: (/** @type {string} */ name, /** @type {Record<string, any>} */ envelope) => {
                    events.push({ name, envelope });
                }
            },
            hooks: { afterCreate: 'true' }
        });
        const handle = await manager.ensure({ workItemId: 'MER-AGREE', identifier: ' MER-1 ' });
        assert.equal(handle.identifier, 'MER-1');
        const created = events.find((entry) => entry.name === 'workspace:created');
        assert.ok(created);
        assert.equal(created.envelope.identifier, handle.identifier);
        const hook = events.find((entry) => entry.name === 'workspace:hook_started');
        assert.ok(hook, 'the hook ran');
        assert.equal(hook.envelope.identifier, handle.identifier);

        await assert.rejects(
            manager.ensure({ workItemId: 'MER-BAD-NUMBER', identifier: /** @type {any} */ (42) }),
            (error) => error instanceof ConfigurationError && error.option === 'invalid_identifier'
        );
        await assert.rejects(
            manager.ensure({ workItemId: 'MER-BAD-OBJECT', identifier: /** @type {any} */ ({}) }),
            (error) => error instanceof ConfigurationError && error.option === 'invalid_identifier'
        );
        const blank = await manager.ensure({ workItemId: 'MER-BLANK', identifier: '   ' });
        assert.equal(blank.identifier, null);
        const blankEvent = events.find((entry) => entry.name === 'workspace:created'
            && entry.envelope.workItemId === 'MER-BLANK');
        assert.ok(blankEvent);
        assert.equal(blankEvent.envelope.identifier, undefined);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('a workspace key remembers its first identifier and refuses a conflict', async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-reuse-'));
    try {
        /** @type {Array<{name: string, envelope: Record<string, any>}>} */
        const events = [];
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.DIRECTORY,
            root: join(base, 'workspaces'),
            eventEmitter: {
                emit: (/** @type {string} */ name, /** @type {Record<string, any>} */ envelope) => {
                    events.push({ name, envelope });
                }
            }
        });
        await manager.ensure({ workItemId: 'REUSE-KEY', identifier: 'REUSE-1' });
        const reused = await manager.ensure({ workItemId: 'REUSE-KEY' });
        assert.equal(reused.identifier, 'REUSE-1');
        const reusedEvent = events.filter((entry) => entry.name === 'workspace:reused').at(-1);
        assert.ok(reusedEvent);
        assert.equal(reusedEvent.envelope.identifier, 'REUSE-1');

        await assert.rejects(
            manager.ensure({ workItemId: 'REUSE-KEY', identifier: 'REUSE-2' }),
            (error) => error instanceof ConfigurationError && error.option === 'identifier_conflict'
        );

        await manager.remove({ workspace: reused, force: true });
        const fresh = await manager.ensure({ workItemId: 'REUSE-KEY', identifier: 'REUSE-2' });
        assert.equal(fresh.identifier, 'REUSE-2');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('a failed ensure never records an identifier, so a later different one succeeds', async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-failed-ensure-'));
    const notDirectoryKey = 'FAIL-NOT-DIRECTORY';
    const hookKey = 'FAIL-HOOK';
    const marker = join(base, 'fail-hook');
    try {
        const root = join(base, 'workspaces');
        await mkdir(root, { recursive: true });
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.DIRECTORY,
            root,
            hooks: { afterCreate: `[ -f '${marker}' ] && exit 1; exit 0` }
        });

        // The derived path is a file, so creation is refused before it exists.
        await writeFile(manager.pathFor({ workItemId: notDirectoryKey }), 'not a directory\n');
        await assert.rejects(
            manager.ensure({ workItemId: notDirectoryKey, identifier: 'FAIL-A' }),
            (error) => /** @type {{reason?: string}} */ (error).reason === 'not_directory'
        );
        await rm(manager.pathFor({ workItemId: notDirectoryKey }), { force: true });
        const recovered = await manager.ensure({ workItemId: notDirectoryKey, identifier: 'FAIL-B' });
        assert.equal(recovered.identifier, 'FAIL-B');

        // A throwing afterCreate cleans up the created directory and the key.
        await writeFile(marker, 'fail\n');
        await assert.rejects(
            manager.ensure({ workItemId: hookKey, identifier: 'HOOK-A' }),
            (error) => /** @type {{reason?: string}} */ (error).reason === 'hook_failed'
        );
        await rm(marker, { force: true });
        const afterHook = await manager.ensure({ workItemId: hookKey, identifier: 'HOOK-B' });
        assert.equal(afterHook.identifier, 'HOOK-B');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('remove of a manually deleted workspace clears the identifier memory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-missing-remove-'));
    try {
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.DIRECTORY,
            root: join(base, 'workspaces')
        });
        const handle = await manager.ensure({ workItemId: 'GONE-KEY', identifier: 'GONE-1' });
        await rm(handle.path, { recursive: true, force: true });
        const result = await manager.remove({ workspace: handle, force: true });
        assert.deepEqual(result, { removed: false, reason: 'missing' });
        const fresh = await manager.ensure({ workItemId: 'GONE-KEY', identifier: 'GONE-2' });
        assert.equal(fresh.identifier, 'GONE-2');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('handleFor previews the remembered identifier when none is supplied', async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-handle-memory-'));
    try {
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.DIRECTORY,
            root: join(base, 'workspaces')
        });
        await manager.ensure({ workItemId: 'MEM-KEY', identifier: 'MEM-7' });
        assert.equal(manager.handleFor({ workItemId: 'MEM-KEY' }).identifier, 'MEM-7');
        assert.equal(manager.handleFor({ workItemId: 'MEM-KEY', identifier: 'MEM-8' }).identifier, 'MEM-8');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
