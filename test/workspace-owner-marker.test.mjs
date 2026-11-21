// @ts-check


/**
 * @file F2-5 / W1-2: a workspace is one item's, and the marker proves whose.
 * @version 0.13.0
 *
 * @description
 * A tracker can recycle an identifier, and the workspace key derives from it,
 * so two different items (`wi-1`, `wi-9`) present the same key — the scheduler
 * passes the real `item.id` as the marker's `ownerId` for exactly that reason.
 * A directory kept by a refused terminal cleanup then becomes the next item's
 * starting tree unless the marker says so. Owners compare as strings, so one id
 * spelled two ways (`42` and `'42'`) is one owner and is not renamed aside.
 *
 * The rename is `<key>.orphan-<epoch-ms>-<uuid>`, so two renames in one
 * millisecond cannot collide, and a marker that cannot be written fails as a
 * `WorkspaceError` naming the key instead of a raw fs error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager, WORKSPACE_STRATEGIES, workspaceKeyFor } from '../lib/agentic/workspace/index.mjs';
import { WorkScheduler, createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { WorkspaceError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** True when the host has a usable `git`; the worktree cases skip otherwise. */
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * @param {{path: string}} arg0 -
 * @returns {Promise<boolean>}
 */
async function exists({ path }) {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * A capturing emitter `emitEvent` accepts.
 * @returns {{events: Array<{event: string, [key: string]: unknown}>, emit: (arg0: string, arg1: Record<string, unknown>) => void, on: () => void}}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    return {
        events,
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {}
    };
}

/**
 * Poll a predicate; real git IO can outlast a microtask flush.
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
 * Run git and throw on a non-zero exit. Test setup only.
 * @param {{args: Array<string>, cwd: string}} arg0 -
 * @returns {string}
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

test('F2-5 a new item does not inherit another item\'s files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-workspace-owner-'));
    const manager = new WorkspaceManager({ root });
    try {
        const first = await manager.ensure({ workItemId: 'MER-42', identifier: 'MER-42', ownerId: 'wi-1' });
        await writeFile(join(first.path, 'output-of-wi-1.txt'), 'left behind\n');

        // The refused cleanup keeps the directory; the tracker recycles the
        // identifier for a different item, so the key is the same and the owner
        // is not.
        const second = await manager.ensure({ workItemId: 'MER-42', identifier: 'MER-42', ownerId: 'wi-9' });
        assert.equal(second.key, first.key);
        assert.equal(second.createdNow, true, 'a different owner gets a fresh workspace');
        assert.equal(await exists({ path: join(second.path, 'output-of-wi-1.txt') }), false,
            'the new item does not start in another item\'s tree');

        const siblings = await readdir(root);
        const orphan = siblings.find((name) => name.startsWith(`${first.key}.orphan-`));
        assert.ok(orphan, 'the previous directory was renamed aside, not deleted');
        assert.equal(await exists({ path: join(root, orphan, 'output-of-wi-1.txt') }), true,
            'and its files are still there for the host to reap');
        assert.equal(await exists({ path: join(root, `${first.key}.merci-owner.json`) }), true);

        const marker = JSON.parse(await readFile(join(root, `${second.key}.merci-owner.json`), 'utf8'));
        assert.deepEqual(marker, { ownerId: 'wi-9', identifier: 'MER-42', ready: true },
            'the marker names the current owner and records a completed setup');

        const removed = await manager.remove({ workspace: second, force: true });
        assert.deepEqual(removed, { removed: true });
        assert.equal(await exists({ path: join(root, `${second.key}.merci-owner.json`) }), false,
            'a successful removal drops the marker too');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('W1-2 one item id spelled two ways is one owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-workspace-owner-same-'));
    const manager = new WorkspaceManager({ root });
    try {
        const first = await manager.ensure({ workItemId: 42, ownerId: 42 });
        await writeFile(join(first.path, 'output.txt'), 'this item\'s work\n');

        const second = await manager.ensure({ workItemId: '42', ownerId: '42' });
        assert.equal(second.key, first.key);
        assert.equal(second.createdNow, false, 'one id, one owner: the workspace is reused');
        assert.equal(await exists({ path: join(second.path, 'output.txt') }), true, 'its own file survives');
        const orphans = (await readdir(root)).filter((name) => name.includes('.orphan-'));
        assert.deepEqual(orphans, [], 'the same item\'s tree is never renamed aside');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('W1-12 two renames in one millisecond cannot collide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-workspace-orphan-'));
    const manager = new WorkspaceManager({ root });
    const realNow = Date.now;
    try {
        await manager.ensure({ workItemId: 'MER-ONE', ownerId: 'wi-1' });
        Date.now = () => 1_760_000_000_000;
        const second = await manager.ensure({ workItemId: 'MER-ONE', ownerId: 'wi-2' });
        const third = await manager.ensure({ workItemId: 'MER-ONE', ownerId: 'wi-3' });
        assert.equal(second.createdNow, true);
        assert.equal(third.createdNow, true, 'the second rename in the same millisecond still lands');
        const orphans = (await readdir(root)).filter((name) => name.includes('.orphan-'));
        assert.equal(orphans.length, 2);
        assert.equal(new Set(orphans).size, 2, 'each rename gets its own suffix');
    } finally {
        Date.now = realNow;
        await rm(root, { recursive: true, force: true });
    }
});

test('W1-12 a marker that cannot be written is a WorkspaceError naming the key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-workspace-marker-fail-'));
    const manager = new WorkspaceManager({ root });
    const key = workspaceKeyFor({ workItemId: 'MER-MARK' });
    try {
        // A directory where the marker file belongs: the read treats it as an
        // unknown owner, and the write cannot replace it.
        await mkdir(join(root, `${key}.merci-owner.json`));
        await assert.rejects(
            () => manager.ensure({ workItemId: 'MER-MARK' }),
            (error) => {
                assert.ok(error instanceof WorkspaceError, `expected WorkspaceError, got ${String(error)}`);
                assert.equal(error.reason, 'owner_marker_failed');
                assert.ok(error.message.includes(key), 'the error names the key');
                return true;
            }
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('W1-2 the scheduler gives a recycled identifier a fresh worktree', {
    skip: GIT_AVAILABLE ? false : 'git is not available on PATH',
    timeout: 30_000
}, async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-owner-scheduler-'));
    const repo = join(base, 'repo');
    await createRepo({ dir: repo });
    const emitter = createEmitter();
    const manager = new WorkspaceManager({
        strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
        repoRoot: repo,
        root: join(base, 'worktrees'),
        eventEmitter: emitter
    });
    /** @type {Array<Record<string, unknown>>} */
    const items = [];
    /** @type {Array<{id: unknown, leftover: boolean, path: string}>} */
    const runs = [];
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items }),
        workflow: {
            run: async (/** @type {{item: Record<string, unknown>, workspace: Record<string, unknown>|null}} */ input) => {
                const handle = /** @type {{path?: unknown}} */ (input.workspace);
                const workspacePath = /** @type {string} */ (handle.path);
                const leftover = await exists({ path: join(workspacePath, 'output-of-wi-1.txt') });
                runs.push({ id: input.item.id, leftover, path: workspacePath });
                if (input.item.id === 'wi-1') await writeFile(join(workspacePath, 'output-of-wi-1.txt'), 'dirty\n');
                return { status: 'completed' };
            }
        },
        workspace: manager,
        eventEmitter: emitter,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        pollIntervalMs: 60_000
    });
    try {
        await scheduler.start();
        items.push({ id: 'wi-1', identifier: 'MER-42', title: 'First', state: 'Todo', dispatchable: true });
        await scheduler.tick();
        await waitFor({ predicate: () => runs.length === 1, label: 'the first item' });

        // The worktree is now dirty, so the terminal cleanup keeps it and the
        // claim is released while the directory stays behind.
        /** @type {Record<string, unknown>} */ (items[0]).state = 'Done';
        await scheduler.tick();
        await waitFor({
            predicate: () => emitter.events.some((entry) => entry.event === EVENTS.WORK_ITEM.RELEASED),
            label: 'the terminal release'
        });
        assert.equal(
            emitter.events.some((entry) => entry.event === EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED),
            true,
            'the dirty worktree was kept, exactly the case that used to hand it over'
        );

        items.push({ id: 'wi-9', identifier: 'MER-42', title: 'Second', state: 'Todo', dispatchable: true });
        await scheduler.tick();
        await waitFor({ predicate: () => runs.length === 2, label: 'the second item' });

        assert.equal(runs[1].id, 'wi-9');
        assert.equal(runs[1].leftover, false,
            'the recycled identifier got a fresh worktree, not the first item\'s files');
        assert.equal(runs[1].path, runs[0].path, 'the key is the same; only the tree behind it is new');
        assert.ok(
            (await readdir(join(base, 'worktrees'))).some((name) => name.endsWith('.merci-owner.json')),
            'the marker records the current owner beside the worktree'
        );
    } finally {
        await scheduler.stop({ timeoutMs: 5_000 }).catch(() => {});
        await rm(base, { recursive: true, force: true });
    }
});
