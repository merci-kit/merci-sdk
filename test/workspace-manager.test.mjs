// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    WorkspaceManager,
    WORKSPACE_HOOKS,
    WORKSPACE_STRATEGIES,
    workspaceKeyFor,
    isInsideRoot
} from '../lib/agentic/workspace/index.mjs';
import { ConfigurationError, WorkspaceError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * A plain emitter `emitEvent` accepts: it only needs `emit`. `on` keeps the
 * shape honest for callers that pass an `EventEmitter`-like object.
 * @typedef {Object} CapturingEmitter
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/**
 * @returns {CapturingEmitter}
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
 * Run a body in a fresh temp directory and always clean it up.
 * @param {{fn: (arg0: {dir: string}) => Promise<void>}} arg0 -
 * @returns {Promise<void>}
 */
async function withTempDir({ fn }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-workspace-manager-'));
    try {
        await fn({ dir });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * @param {{emitter: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<{event: string, [key: string]: unknown}>}
 */
function eventsNamed({ emitter, name }) {
    return emitter.events.filter((entry) => entry.event === name);
}

/**
 * Assert a promise rejects with the expected `WorkspaceError.reason`.
 * @param {{promise: Promise<unknown>, reason: string}} arg0 -
 * @returns {Promise<void>}
 */
async function assertWorkspaceRejects({ promise, reason }) {
    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof WorkspaceError, `expected WorkspaceError, got ${String(err)}`);
        assert.equal(err.reason, reason);
        return true;
    });
}

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
 * A shell script that appends a marker line to `file`.
 * @param {{file: string}} arg0 -
 * @returns {string}
 */
function appendMarker({ file }) {
    return `printf 'ran\\n' >> ${JSON.stringify(file)}`;
}

test('exports the stage-2 surface', async () => {
    assert.ok(Object.isFrozen(WORKSPACE_STRATEGIES));
    assert.equal(WORKSPACE_STRATEGIES.DIRECTORY, 'directory');
    assert.equal(WORKSPACE_STRATEGIES.GIT_WORKTREE, 'git-worktree');
    assert.ok(Object.isFrozen(WORKSPACE_HOOKS));
    assert.deepEqual(
        [WORKSPACE_HOOKS.AFTER_CREATE, WORKSPACE_HOOKS.BEFORE_RUN, WORKSPACE_HOOKS.AFTER_RUN, WORKSPACE_HOOKS.BEFORE_REMOVE],
        ['afterCreate', 'beforeRun', 'afterRun', 'beforeRemove']
    );
    assert.equal(EVENTS.WORKSPACE.CREATED, 'workspace:created');
    assert.equal(Object.keys(EVENTS.WORKSPACE).length, 8);

    const barrel = await import('../lib/agentic/workspace/index.mjs');
    assert.equal('normalizeHooks' in barrel, false);
    assert.equal('runWorkspaceHook' in barrel, false);
    const hooks = await import('../lib/agentic/workspace/hooks.mjs');
    assert.equal(typeof hooks.normalizeHooks, 'function');
    assert.equal(typeof hooks.runWorkspaceHook, 'function');
});

test('constructor rejects unsupported strategies, a missing repoRoot, and invalid hooks', () => {
    assert.throws(() => new WorkspaceManager({ strategy: 'git-worktree' }), ConfigurationError);
    assert.throws(() => new WorkspaceManager({ strategy: 'git-worktree', repoRoot: '' }), ConfigurationError);
    assert.throws(() => new WorkspaceManager({ strategy: 'nope' }), ConfigurationError);
    assert.throws(() => new WorkspaceManager({ hooks: { timeoutMs: 0 } }), ConfigurationError);
    assert.throws(() => new WorkspaceManager({ hooks: { timeoutMs: 1.5 } }), ConfigurationError);
    assert.throws(() => new WorkspaceManager({ hooks: { beforeRun: 42 } }), ConfigurationError);
});

test('ensure creates a fresh workspace inside the root', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });
        const workspace = await manager.ensure({ workItemId: 'MER-1' });

        assert.equal(workspace.createdNow, true);
        assert.equal(workspace.workItemId, 'MER-1');
        assert.equal(workspace.key, workspaceKeyFor({ workItemId: 'MER-1' }));
        assert.equal(workspace.strategy, WORKSPACE_STRATEGIES.DIRECTORY);
        assert.equal(workspace.branch, null);
        assert.equal(workspace.repoRoot, null);
        assert.equal(typeof workspace.createdAt, 'string');
        assert.ok(Object.isFrozen(workspace));

        const stats = await stat(workspace.path);
        assert.equal(stats.isDirectory(), true);
        const realRoot = await realpath(workspace.root);
        const realPath = await realpath(workspace.path);
        assert.equal(realRoot, workspace.root);
        assert.ok(isInsideRoot({ root: realRoot, path: realPath }));

        const created = eventsNamed({ emitter, name: EVENTS.WORKSPACE.CREATED });
        assert.equal(created.length, 1);
        assert.equal(created[0].createdNow, true);
        assert.equal(created[0].key, workspace.key);
    } });
});

test('a second ensure reuses the same path and runs afterCreate once', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { afterCreate: 'printf "created\\n" >> runs.txt' },
            eventEmitter: emitter
        });
        const first = await manager.ensure({ workItemId: 'MER-2' });
        const second = await manager.ensure({ workItemId: 'MER-2' });

        assert.equal(first.createdNow, true);
        assert.equal(second.createdNow, false);
        assert.equal(first.path, second.path);
        assert.equal((await readFile(join(second.path, 'runs.txt'), 'utf8')).trim(), 'created');
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORKSPACE.CREATED }).length, 1);
        const reused = eventsNamed({ emitter, name: EVENTS.WORKSPACE.REUSED });
        assert.equal(reused.length, 1);
        assert.equal(reused[0].createdNow, false);
    } });
});

test('two concurrent ensure calls create once and run afterCreate once', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { afterCreate: 'printf "created\\n" >> runs.txt' },
            eventEmitter: emitter
        });
        const [a, b] = await Promise.all([
            manager.ensure({ workItemId: 'MER-CONCURRENT' }),
            manager.ensure({ workItemId: 'MER-CONCURRENT' })
        ]);
        assert.equal(a.path, b.path);
        assert.equal([a, b].filter((handle) => handle.createdNow).length, 1);
        assert.equal((await readFile(join(a.path, 'runs.txt'), 'utf8')).trim(), 'created');
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORKSPACE.CREATED }).length, 1);
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORKSPACE.REUSED }).length, 1);
    } });
});

test('a file at the derived path is rejected and left untouched', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const root = join(dir, 'root');
        await mkdir(root, { recursive: true });
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root, eventEmitter: emitter });
        const target = join(root, workspaceKeyFor({ workItemId: 'MER-3' }));
        await writeFile(target, 'keep-me');

        await assertWorkspaceRejects({ promise: manager.ensure({ workItemId: 'MER-3' }), reason: 'not_directory' });
        assert.equal(await readFile(target, 'utf8'), 'keep-me');
        const rejected = eventsNamed({ emitter, name: EVENTS.WORKSPACE.PATH_REJECTED });
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason, 'not_directory');
    } });
});

test('a symlink to an outside directory is rejected without following it', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const outside = await mkdtemp(join(tmpdir(), 'merci-workspace-outside-'));
        try {
            await writeFile(join(outside, 'keep.txt'), 'keep');
            const root = join(dir, 'root');
            await mkdir(root, { recursive: true });
            const emitter = createEmitter();
            const manager = new WorkspaceManager({ root, eventEmitter: emitter });
            const target = join(root, workspaceKeyFor({ workItemId: 'MER-4' }));
            await symlink(outside, target, 'dir');

            await assertWorkspaceRejects({ promise: manager.ensure({ workItemId: 'MER-4' }), reason: 'symlink' });
            assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
            const rejected = eventsNamed({ emitter, name: EVENTS.WORKSPACE.PATH_REJECTED });
            assert.equal(rejected[0].reason, 'symlink');
            assert.equal((await lstat(target)).isSymbolicLink(), true);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    } });
});

test('the filesystem root is refused as a workspace root', () => {
    assert.throws(() => new WorkspaceManager({ root: '/' }), ConfigurationError);
});

test('a failing afterCreate hook rejects and removes the new directory', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root'), hooks: { afterCreate: 'exit 7' } });
        const expected = manager.handleFor({ workItemId: 'MER-5' });
        await assertWorkspaceRejects({ promise: manager.ensure({ workItemId: 'MER-5' }), reason: 'hook_failed' });
        assert.equal(await exists({ path: expected.path }), false);
    } });
});

test('an afterCreate timeout reports hook_timeout and removes the new directory', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { afterCreate: 'sleep 5', timeoutMs: 150 }
        });
        const expected = manager.handleFor({ workItemId: 'MER-6' });
        await assertWorkspaceRejects({ promise: manager.ensure({ workItemId: 'MER-6' }), reason: 'hook_timeout' });
        assert.equal(await exists({ path: expected.path }), false);
    } });
});

test('a failing beforeRun rejects and leaves the workspace inactive', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root'), hooks: { beforeRun: 'exit 3' } });
        const workspace = await manager.ensure({ workItemId: 'MER-7' });
        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace }), reason: 'hook_failed' });
        const removed = await manager.remove({ workspace });
        assert.equal(removed.removed, true);
    } });
});

test('a failing afterRun resolves and emits a non-fatal hook_failed event', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { afterRun: 'exit 4' },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-8' });
        const result = await manager.afterRun({ workspace, outcome: 'succeeded' });
        assert.equal(result, undefined);

        const failed = eventsNamed({ emitter, name: EVENTS.WORKSPACE.HOOK_FAILED });
        assert.equal(failed.length, 1);
        assert.equal(failed[0].fatal, false);
        assert.equal(failed[0].hook, 'afterRun');
        assert.equal(failed[0].exitCode, 4);
        assert.equal(typeof failed[0].durationMs, 'number');
    } });
});

test('hooks run in the workspace with the MERCI environment and no parent secret', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { beforeRun: 'pwd > cwd.txt; env > env.txt' },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-9' });
        process.env.FAKE_SECRET = 'merci-parent-secret-value';
        try {
            await manager.beforeRun({ workspace });
        } finally {
            delete process.env.FAKE_SECRET;
        }

        const cwd = (await readFile(join(workspace.path, 'cwd.txt'), 'utf8')).trim();
        assert.equal(cwd, await realpath(workspace.path));
        const env = await readFile(join(workspace.path, 'env.txt'), 'utf8');
        assert.match(env, new RegExp(`^MERCI_WORKSPACE=${workspace.path}$`, 'm'));
        assert.match(env, new RegExp(`^MERCI_WORKSPACE_KEY=${workspace.key}$`, 'm'));
        assert.match(env, /^MERCI_WORK_ITEM_ID=MER-9$/m);
        assert.ok(!env.includes('FAKE_SECRET'));
        assert.ok(!env.includes('merci-parent-secret-value'));

        const started = eventsNamed({ emitter, name: EVENTS.WORKSPACE.HOOK_STARTED });
        assert.equal(started[0].hook, 'beforeRun');
        assert.equal(started[0].path, workspace.path);
        const finished = eventsNamed({ emitter, name: EVENTS.WORKSPACE.HOOK_FINISHED });
        assert.equal(finished.length, 1);
        assert.equal(finished[0].exitCode, 0);
        assert.equal(typeof finished[0].durationMs, 'number');
    } });
});

test('remove refuses a non-empty directory without force', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });
        const workspace = await manager.ensure({ workItemId: 'MER-10' });
        await writeFile(join(workspace.path, 'work.txt'), 'agent output');

        const result = await manager.remove({ workspace });
        assert.deepEqual(result, { removed: false, reason: 'not_empty' });
        assert.equal(await readFile(join(workspace.path, 'work.txt'), 'utf8'), 'agent output');
        const refused = eventsNamed({ emitter, name: EVENTS.WORKSPACE.REMOVE_REFUSED });
        assert.equal(refused[0].reason, 'not_empty');
    } });
});

test('remove with force deletes the directory and runs beforeRemove', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const marker = join(dir, 'before-remove.txt');
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { beforeRemove: appendMarker({ file: marker }) },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-11' });
        await writeFile(join(workspace.path, 'work.txt'), 'agent output');

        const result = await manager.remove({ workspace, force: true });
        assert.deepEqual(result, { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
        assert.equal((await readFile(marker, 'utf8')).trim(), 'ran');
        const removed = eventsNamed({ emitter, name: EVENTS.WORKSPACE.REMOVED });
        assert.equal(removed.length, 1);
        assert.equal(removed[0].forced, true);
        assert.equal(removed[0].key, workspace.key);
    } });
});

test('remove on a missing workspace reports missing without throwing', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const workspace = await manager.ensure({ workItemId: 'MER-12' });
        await rm(workspace.path, { recursive: true, force: true });
        assert.deepEqual(await manager.remove({ workspace }), { removed: false, reason: 'missing' });
    } });
});

test('pathFor previews the path without creating it', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const preview = manager.pathFor({ workItemId: 'MER-13' });
        assert.equal(preview, join(manager.handleFor({ workItemId: 'MER-13' }).root, workspaceKeyFor({ workItemId: 'MER-13' })));
        assert.equal(await exists({ path: preview }), false);

        const workspace = await manager.ensure({ workItemId: 'MER-13' });
        assert.equal(workspace.path, await realpath(preview));
        assert.equal(manager.pathFor({ workItemId: 'MER-13' }), workspace.path);

        assert.throws(() => manager.pathFor({ workItemId: '  ' }), ConfigurationError);
    } });
});

test('handleFor builds a frozen handle without touching the filesystem', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });
        const handle = manager.handleFor({ workItemId: 'MER-14' });

        assert.ok(Object.isFrozen(handle));
        assert.equal(handle.workItemId, 'MER-14');
        assert.equal(handle.key, workspaceKeyFor({ workItemId: 'MER-14' }));
        assert.equal(handle.strategy, WORKSPACE_STRATEGIES.DIRECTORY);
        assert.equal(handle.branch, null);
        assert.equal(handle.repoRoot, null);
        assert.equal(handle.createdNow, false);
        assert.equal(handle.createdAt, null);
        assert.equal(handle.path, join(handle.root, handle.key));
        assert.equal(await exists({ path: handle.path }), false);

        assert.deepEqual(await manager.remove({ workspace: handle }), { removed: false, reason: 'missing' });
        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: handle }), reason: 'not_directory' });

        await manager.ensure({ workItemId: 'MER-14' });
        const result = await manager.beforeRun({ workspace: handle });
        assert.equal(result, undefined);
        await manager.afterRun({ workspace: handle, outcome: 'succeeded' });
    } });
});

test('a tampered path or a foreign root is rejected by every guarded method', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const workspace = await manager.ensure({ workItemId: 'MER-15' });
        await writeFile(join(workspace.path, 'keep.txt'), 'keep');
        const sibling = await manager.ensure({ workItemId: 'MER-16' });

        const foreignRoot = { ...workspace, root: dir };
        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: foreignRoot }), reason: 'outside_root' });
        await assertWorkspaceRejects({ promise: manager.remove({ workspace: foreignRoot }), reason: 'outside_root' });

        const tampered = { ...workspace, path: sibling.path };
        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: tampered }), reason: 'path_mismatch' });
        await assertWorkspaceRejects({ promise: manager.remove({ workspace: tampered, force: true }), reason: 'path_mismatch' });
        assert.equal(await readFile(join(workspace.path, 'keep.txt'), 'utf8'), 'keep');
        assert.equal(await readFile(join(sibling.path, 'keep.txt'), 'utf8').catch(() => 'absent'), 'absent');

        const skipped = await manager.afterRun({ workspace: tampered, outcome: 'failed' });
        assert.deepEqual(skipped, { skipped: true, reason: 'invalid_handle' });
    } });
});

test('a handle pointing outside the root is rejected and the target untouched', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const outside = await mkdtemp(join(tmpdir(), 'merci-workspace-forged-'));
        try {
            await writeFile(join(outside, 'keep.txt'), 'keep');
            const manager = new WorkspaceManager({ root: join(dir, 'root') });
            const handle = { ...manager.handleFor({ workItemId: 'MER-17' }), path: outside };

            await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: handle }), reason: 'outside_root' });
            await assertWorkspaceRejects({ promise: manager.remove({ workspace: handle, force: true }), reason: 'outside_root' });
            assert.deepEqual(
                await manager.afterRun({ workspace: handle, outcome: 'failed' }),
                { skipped: true, reason: 'invalid_handle' }
            );
            assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    } });
});

test('a symlinked workspace path is rejected and the link target is untouched', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const outside = await mkdtemp(join(tmpdir(), 'merci-workspace-link-'));
        try {
            await writeFile(join(outside, 'keep.txt'), 'keep');
            const manager = new WorkspaceManager({ root: join(dir, 'root') });
            const workspace = await manager.ensure({ workItemId: 'MER-18' });
            await rm(workspace.path, { recursive: true, force: true });
            await symlink(outside, workspace.path, 'dir');

            await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace }), reason: 'symlink' });
            await assertWorkspaceRejects({ promise: manager.remove({ workspace, force: true }), reason: 'symlink' });
            assert.deepEqual(
                await manager.afterRun({ workspace, outcome: 'failed' }),
                { skipped: true, reason: 'invalid_handle' }
            );
            assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
            assert.equal((await lstat(workspace.path)).isSymbolicLink(), true);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    } });
});

test('remove refuses an active workspace, allows it after afterRun, and force overrides', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });

        const first = await manager.ensure({ workItemId: 'MER-19' });
        await manager.beforeRun({ workspace: first });
        assert.deepEqual(await manager.remove({ workspace: first }), { removed: false, reason: 'in_use' });
        assert.equal(await exists({ path: first.path }), true);
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORKSPACE.REMOVE_REFUSED })[0].reason, 'in_use');
        await manager.afterRun({ workspace: first, outcome: 'succeeded' });
        assert.deepEqual(await manager.remove({ workspace: first }), { removed: true });

        const second = await manager.ensure({ workItemId: 'MER-20' });
        await manager.beforeRun({ workspace: second });
        assert.deepEqual(await manager.remove({ workspace: second, force: true }), { removed: true });
        assert.equal(await exists({ path: second.path }), false);
    } });
});

test('afterRun tolerates a deleted workspace without throwing', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const workspace = await manager.ensure({ workItemId: 'MER-21' });
        await rm(workspace.path, { recursive: true, force: true });
        assert.deepEqual(await manager.afterRun({ workspace, outcome: 'failed' }), { skipped: true, reason: 'missing' });
    } });
});

test('prune is a no-op for the directory strategy', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const workspace = await manager.ensure({ workItemId: 'MER-22' });
        assert.equal(await manager.prune(), undefined);
        assert.equal(await exists({ path: workspace.path }), true);
    } });
});

test('events never carry hook script text or secret values', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const script = 'echo HOOK_SCRIPT_TOKEN_7f3a; printf "created\\n" >> runs.txt';
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { afterCreate: script, beforeRun: 'echo HOOK_SCRIPT_TOKEN_7f3a', afterRun: 'echo HOOK_SCRIPT_TOKEN_7f3a; exit 1' },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-23' });
        process.env.FAKE_SECRET = 'merci-parent-secret-value';
        try {
            await manager.beforeRun({ workspace });
            await manager.afterRun({ workspace, outcome: 'failed' });
        } finally {
            delete process.env.FAKE_SECRET;
        }
        await manager.remove({ workspace, force: true });

        const serialized = JSON.stringify(emitter.events);
        assert.ok(!serialized.includes('HOOK_SCRIPT_TOKEN_7f3a'));
        assert.ok(!serialized.includes('merci-parent-secret-value'));
        assert.ok(emitter.events.length >= 6);
    } });
});

test('a failing beforeRemove is ignored and removal still succeeds', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { beforeRemove: 'exit 9' },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-R1' });

        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
        const failed = eventsNamed({ emitter, name: EVENTS.WORKSPACE.HOOK_FAILED });
        assert.equal(failed.length, 1);
        assert.equal(failed[0].hook, 'beforeRemove');
        assert.equal(failed[0].fatal, false);
        assert.equal(failed[0].exitCode, 9);
    } });
});

test('beforeRun timeout is fatal and afterRun timeout resolves', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { beforeRun: 'sleep 5', afterRun: 'sleep 5', timeoutMs: 150 },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-R2' });

        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace }), reason: 'hook_timeout' });
        assert.equal(await manager.afterRun({ workspace, outcome: 'failed' }), undefined);

        const failed = eventsNamed({ emitter, name: EVENTS.WORKSPACE.HOOK_FAILED });
        const before = failed.find((entry) => entry.hook === 'beforeRun');
        const after = failed.find((entry) => entry.hook === 'afterRun');
        assert.ok(before, 'beforeRun failure event missing');
        assert.ok(after, 'afterRun failure event missing');
        assert.equal(before.fatal, true);
        assert.equal(before.timedOut, true);
        assert.equal(before.exitCode, null);
        assert.equal(after.fatal, false);
        assert.equal(after.timedOut, true);
        assert.equal(after.exitCode, null);
    } });
});

test('all eight workspace events fire and carry the identity fields', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: { afterCreate: 'true', afterRun: 'exit 2', beforeRemove: 'true' },
            eventEmitter: emitter
        });
        const workspace = await manager.ensure({ workItemId: 'MER-R3' });
        await manager.ensure({ workItemId: 'MER-R3' });

        await writeFile(join(workspace.path, 'keep.txt'), 'keep');
        assert.deepEqual(await manager.remove({ workspace }), { removed: false, reason: 'not_empty' });

        await manager.afterRun({ workspace, outcome: 'failed' });
        await assertWorkspaceRejects({
            promise: manager.beforeRun({ workspace: { ...workspace, path: join(workspace.root, 'not-a-workspace') } }),
            reason: 'path_mismatch'
        });

        assert.deepEqual(await manager.remove({ workspace, force: true }), { removed: true });

        const expected = [
            'workspace:created',
            'workspace:reused',
            'workspace:removed',
            'workspace:remove_refused',
            'workspace:hook_started',
            'workspace:hook_finished',
            'workspace:hook_failed',
            'workspace:path_rejected'
        ];
        const seen = [...new Set(emitter.events.map((entry) => entry.event))].sort();
        assert.deepEqual(seen, [...expected].sort());

        for (const name of ['workspace:removed', 'workspace:remove_refused', 'workspace:path_rejected']) {
            const events = eventsNamed({ emitter, name });
            assert.ok(events.length > 0, `${name} missing`);
            for (const entry of events) {
                assert.equal(typeof entry.workItemId, 'string');
                assert.equal(typeof entry.key, 'string');
                assert.equal(typeof entry.path, 'string');
            }
        }
    } });
});

test('hooks.env cannot shadow the manager-computed workspace identity', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            hooks: {
                env: { MERCI_WORKSPACE: '/elsewhere', MERCI_CUSTOM: 'x' },
                beforeRun: 'printf "%s\\n%s\\n" "$MERCI_WORKSPACE" "$MERCI_CUSTOM" > env.txt'
            }
        });
        const workspace = await manager.ensure({ workItemId: 'MER-R4' });
        await manager.beforeRun({ workspace });

        const lines = (await readFile(join(workspace.path, 'env.txt'), 'utf8')).trim().split('\n');
        assert.equal(lines[0], await realpath(workspace.path));
        assert.equal(lines[0], workspace.path);
        assert.notEqual(lines[0], '/elsewhere');
        assert.equal(lines[1], 'x');
    } });
});

test('invalid handles and non-derived paths are rejected', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const workspace = await manager.ensure({ workItemId: 'MER-R5' });

        for (const broken of [
            { ...workspace, root: 42 },
            { ...workspace, key: '' },
            { ...workspace, path: '' },
            { ...workspace, workItemId: null }
        ]) {
            await assertWorkspaceRejects({
                promise: manager.beforeRun({ workspace: broken }),
                reason: 'invalid_handle'
            });
        }

        for (const key of ['.', '..']) {
            await assertWorkspaceRejects({
                promise: manager.beforeRun({ workspace: { ...workspace, key } }),
                reason: 'path_mismatch'
            });
        }

        await assertWorkspaceRejects({
            promise: manager.beforeRun({ workspace: { ...workspace, path: join(workspace.root, 'not-derived') } }),
            reason: 'path_mismatch'
        });
    } });
});

test('a handleFor handle is removable after another call promotes the root', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const stale = manager.handleFor({ workItemId: 'MER-R6' });
        await manager.ensure({ workItemId: 'MER-R6' });

        assert.deepEqual(await manager.remove({ workspace: stale }), { removed: true });
        assert.equal(await exists({ path: stale.path }), false);
    } });
});

test('a handle with a sibling key or a foreign id is rejected', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const a = await manager.ensure({ workItemId: 'A' });
        const b = await manager.ensure({ workItemId: 'B' });

        await assertWorkspaceRejects({
            promise: manager.beforeRun({ workspace: { ...a, key: b.key, path: b.path } }),
            reason: 'path_mismatch'
        });
        await assertWorkspaceRejects({
            promise: manager.beforeRun({ workspace: { ...a, workItemId: 'SOMEONE-ELSE', key: a.key, path: a.path } }),
            reason: 'path_mismatch'
        });
    } });
});

test('concurrent remove calls report exactly one removal', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });
        const workspace = await manager.ensure({ workItemId: 'MER-R7' });

        const results = await Promise.allSettled([
            manager.remove({ workspace }),
            manager.remove({ workspace })
        ]);
        /** @type {Array<{removed: boolean, reason?: string}>} */
        const values = [];
        for (const result of results) {
            assert.equal(result.status, 'fulfilled');
            if (result.status === 'fulfilled') values.push(result.value);
        }
        assert.equal(values.filter((value) => value.removed).length, 1);
        assert.equal(values.filter((value) => value.reason === 'missing').length, 1);
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORKSPACE.REMOVED }).length, 1);
    } });
});

test('a pre-promotion handleFor handle for a cleaned workspace reports missing', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });
        const stale = manager.handleFor({ workItemId: 'GONE' });
        await manager.ensure({ workItemId: 'OTHER' });

        assert.deepEqual(await manager.remove({ workspace: stale }), { removed: false, reason: 'missing' });
        assert.deepEqual(await manager.remove({ workspace: stale, force: true }), { removed: false, reason: 'missing' });
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORKSPACE.REMOVED }).length, 0);
    } });
});

test('a pre-promotion handleFor handle for a cleaned workspace fails beforeRun as not_directory', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const manager = new WorkspaceManager({ root: join(dir, 'root') });
        const stale = manager.handleFor({ workItemId: 'GONE' });
        await manager.ensure({ workItemId: 'OTHER' });

        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: stale }), reason: 'not_directory' });
    } });
});

test('a missing path that escapes the root is still rejected', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const manager = new WorkspaceManager({ root: join(dir, 'root'), eventEmitter: emitter });
        await manager.ensure({ workItemId: 'OTHER' });
        const escaping = {
            ...manager.handleFor({ workItemId: 'GONE' }),
            path: join(dir, 'outside', 'gone')
        };

        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: escaping }), reason: 'outside_root' });
        await assertWorkspaceRejects({ promise: manager.remove({ workspace: escaping }), reason: 'outside_root' });
        const rejected = eventsNamed({ emitter, name: EVENTS.WORKSPACE.PATH_REJECTED });
        assert.ok(rejected.length >= 1);
        assert.equal(rejected[0].reason, 'outside_root');
    } });
});

test('a pre-promotion handle for a missing path survives symlinked-root promotion', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const real = join(dir, 'real');
        await mkdir(real, { recursive: true });
        const alias = join(dir, 'alias');
        await symlink(real, alias, 'dir');

        const manager = new WorkspaceManager({ root: join(alias, 'root') });
        const stale = manager.handleFor({ workItemId: 'MISSING' });
        const other = await manager.ensure({ workItemId: 'OTHER' });

        // The promotion is deterministic: ensure() stores the realpath, so the
        // pre-promotion spelling must differ from the post-promotion one.
        const promoted = manager.handleFor({ workItemId: 'MISSING' });
        assert.ok(other.path.startsWith(await realpath(real)));
        assert.notEqual(stale.path, promoted.path);

        assert.deepEqual(await manager.remove({ workspace: stale }), { removed: false, reason: 'missing' });
        await assertWorkspaceRejects({ promise: manager.beforeRun({ workspace: stale }), reason: 'not_directory' });
    } });
});
