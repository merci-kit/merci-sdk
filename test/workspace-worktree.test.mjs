// @ts-check

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    WorkspaceManager,
    WORKSPACE_STRATEGIES,
    workspaceKeyFor
} from '../lib/agentic/workspace/index.mjs';
import { removeWorktree } from '../lib/agentic/workspace/git.mjs';
import { ConfigurationError, WorkspaceError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * A plain emitter `emitEvent` accepts: it only needs `emit`.
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

/** True when the host has a usable `git`; the whole file is skipped otherwise. */
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

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
 * The `worktree` paths `git worktree list` reports.
 * @param {{repo: string}} arg0 -
 * @returns {Array<string>}
 */
function listWorktrees({ repo }) {
    return runGit({ args: ['worktree', 'list', '--porcelain'], cwd: repo })
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
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
 * @param {{promise: Promise<unknown>, reason: string}} arg0 -
 * @returns {Promise<WorkspaceError>} The rejection, after checking its reason.
 */
async function rejectedWorkspaceError({ promise, reason }) {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof WorkspaceError, `expected WorkspaceError, got ${String(error)}`);
        assert.equal(error.reason, reason);
        return error;
    }
    assert.fail('the promise resolved; expected a WorkspaceError');
}

describe('git-worktree workspace strategy', {
    skip: GIT_AVAILABLE ? false : 'git is not available on PATH'
}, () => {
    /** @type {{base: string, repo: string}} */
    let fixture;

    before(async () => {
        const base = await mkdtemp(join(tmpdir(), 'merci-workspace-worktree-'));
        const repo = join(base, 'repo');
        await createRepo({ dir: repo });
        fixture = { base, repo };
    });

    after(async () => {
        await rm(fixture.base, { recursive: true, force: true });
    });

    /**
     * A manager root unique to one test, plus the manager built on it.
     * @param {{name: string, repoRoot?: string, hooks?: Record<string, unknown>}} arg0 -
     * @returns {WorkspaceManager}
     */
    function managerFor({ name, repoRoot = fixture.repo, hooks = {} }) {
        return new WorkspaceManager({
            root: join(fixture.base, 'roots', name),
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot,
            hooks
        });
    }

    test('constructor requires a repoRoot for the worktree strategy', () => {
        assert.throws(() => new WorkspaceManager({ strategy: 'git-worktree' }), ConfigurationError);
    });

    test('create builds a linked worktree on merci/<key>', async () => {
        const manager = managerFor({ name: 'create' });
        const workspace = await manager.ensure({ workItemId: 'MER-W1' });

        assert.equal(workspace.createdNow, true);
        assert.equal(workspace.strategy, WORKSPACE_STRATEGIES.GIT_WORKTREE);
        assert.equal(workspace.repoRoot, fixture.repo);
        assert.equal(workspace.branch, `merci/${workspace.key}`);
        assert.ok(Object.isFrozen(workspace));
        assert.equal((await lstat(workspace.path)).isDirectory(), true);
        assert.equal((await lstat(join(workspace.path, '.git'))).isFile(), true);
        assert.equal(await readFile(join(workspace.path, 'base.txt'), 'utf8'), 'base\n');
        assert.equal(runGit({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: workspace.path }), workspace.branch);

        const preview = manager.handleFor({ workItemId: 'MER-W1' });
        assert.equal(preview.path, workspace.path);
        assert.equal(preview.branch, workspace.branch);
        assert.equal(preview.repoRoot, fixture.repo);
    });

    test('a handle from another strategy is rejected and the worktree untouched', async () => {
        const manager = managerFor({ name: 'strategy-mismatch' });
        const workspace = await manager.ensure({ workItemId: 'MER-W22' });
        const mixed = { ...workspace, strategy: WORKSPACE_STRATEGIES.DIRECTORY };

        await rejectedWorkspaceError({ promise: manager.beforeRun({ workspace: mixed }), reason: 'invalid_handle' });
        await rejectedWorkspaceError({ promise: manager.remove({ workspace: mixed }), reason: 'invalid_handle' });
        assert.equal(await exists({ path: workspace.path }), true);
    });

    test('a second ensure reuses the same worktree and branch', async () => {
        const manager = managerFor({
            name: 'reuse',
            hooks: { afterCreate: 'printf "created\\n" >> runs.txt' }
        });
        const first = await manager.ensure({ workItemId: 'MER-W2' });
        const second = await manager.ensure({ workItemId: 'MER-W2' });

        assert.equal(first.createdNow, true);
        assert.equal(second.createdNow, false);
        assert.equal(second.path, first.path);
        assert.equal(second.branch, first.branch);
        assert.equal((await readFile(join(second.path, 'runs.txt'), 'utf8')).trim(), 'created');
    });

    test('branch: null creates a detached worktree', async () => {
        const manager = managerFor({ name: 'detached-create' });
        const workspace = await manager.ensure({ workItemId: 'MER-W3', branch: null });

        assert.equal(workspace.createdNow, true);
        assert.equal(workspace.branch, null);
        assert.equal(runGit({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: workspace.path }), 'HEAD');
    });

    test('ids that sanitize to the same text get distinct paths and branches', async () => {
        const manager = managerFor({ name: 'collision' });
        const a = await manager.ensure({ workItemId: 'alpha/beta' });
        const b = await manager.ensure({ workItemId: 'alpha beta' });

        assert.notEqual(a.key, b.key);
        assert.notEqual(a.path, b.path);
        assert.notEqual(a.branch, b.branch);
        assert.equal(a.branch, `merci/${a.key}`);
        assert.equal(b.branch, `merci/${b.key}`);
    });

    test('a plain directory inside the repo is not_worktree and untouched', async () => {
        const root = join(fixture.repo, 'plain-root');
        await mkdir(root, { recursive: true });
        const key = workspaceKeyFor({ workItemId: 'MER-W5' });
        const target = join(root, key);
        await mkdir(target);
        await writeFile(join(target, 'keep.txt'), 'keep');
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root,
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: fixture.repo,
            eventEmitter: emitter
        });

        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W5' }), reason: 'not_worktree' });
        // The identity check runs before any HEAD read, so the refusal is
        // reported as not_worktree rather than a raw git failure.
        const rejected = emitter.events.filter((entry) => entry.event === EVENTS.WORKSPACE.PATH_REJECTED);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason, 'not_worktree');
        assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep');
        assert.equal((await lstat(target)).isDirectory(), true);
        // remove() re-checks the same identity and must not delete a plain dir.
        await rejectedWorkspaceError({ promise: manager.remove({ workspace: manager.handleFor({ workItemId: 'MER-W5' }) }), reason: 'not_worktree' });
        assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep');
    });

    test('a plain directory outside any repo is not_worktree with one path_rejected', async () => {
        const root = join(fixture.base, 'roots', 'non-repo-target');
        await mkdir(root, { recursive: true });
        const key = workspaceKeyFor({ workItemId: 'MER-W33' });
        const target = join(root, key);
        await mkdir(target);
        await writeFile(join(target, 'keep.txt'), 'keep');
        const emitter = createEmitter();
        const manager = new WorkspaceManager({
            root,
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: fixture.repo,
            eventEmitter: emitter
        });

        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W33' }), reason: 'not_worktree' });
        const rejected = emitter.events.filter((entry) => entry.event === EVENTS.WORKSPACE.PATH_REJECTED);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason, 'not_worktree');
        assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep');
        assert.equal((await lstat(target)).isDirectory(), true);
    });

    test('a worktree of another repo is wrong_repo and untouched', async () => {
        const other = join(fixture.base, 'other-repo');
        await createRepo({ dir: other });
        const root = join(fixture.base, 'roots', 'wrong-repo');
        await mkdir(root, { recursive: true });
        const key = workspaceKeyFor({ workItemId: 'MER-W6' });
        const target = join(root, key);
        runGit({ args: ['worktree', 'add', '-b', 'other-branch', target, 'HEAD'], cwd: other });
        const manager = managerFor({ name: 'wrong-repo' });

        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W6' }), reason: 'wrong_repo' });
        assert.equal(runGit({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: target }), 'other-branch');
        assert.equal((await lstat(join(target, '.git'))).isFile(), true);
    });

    test('a repoRoot that is itself a linked worktree works', async () => {
        const slice = join(fixture.base, 'slice');
        runGit({ args: ['worktree', 'add', '-b', 'slice-branch', slice, 'HEAD'], cwd: fixture.repo });
        assert.equal((await lstat(join(slice, '.git'))).isFile(), true);

        const manager = managerFor({ name: 'linked-repo-root', repoRoot: slice });
        const first = await manager.ensure({ workItemId: 'MER-W7' });
        const second = await manager.ensure({ workItemId: 'MER-W7' });

        assert.equal(first.createdNow, true);
        assert.equal(second.createdNow, false);
        assert.equal(second.path, first.path);
        assert.equal(await readFile(join(first.path, 'base.txt'), 'utf8'), 'base\n');
        assert.deepEqual(await manager.remove({ workspace: first }), { removed: true });
    });

    test('root and repo paths containing a space work end to end', async () => {
        const repo = join(fixture.base, 'repo with space');
        await createRepo({ dir: repo });
        const manager = new WorkspaceManager({
            root: join(fixture.base, 'root with space'),
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: repo
        });

        const workspace = await manager.ensure({ workItemId: 'MER-W8' });
        assert.equal(workspace.path.startsWith(manager.root), true);
        assert.equal(await readFile(join(workspace.path, 'base.txt'), 'utf8'), 'base\n');
        const reused = await manager.ensure({ workItemId: 'MER-W8' });
        assert.equal(reused.createdNow, false);
        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
    });

    test('a missing base ref is git_failed and leaves no directory', async () => {
        const manager = managerFor({ name: 'missing-base' });
        await rejectedWorkspaceError({
            promise: manager.ensure({ workItemId: 'MER-W9', baseRef: 'no-such-ref' }),
            reason: 'git_failed'
        });
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W9' }) }), false);
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.includes('MER-W9')), false);
    });

    test('a failing afterCreate removes the worktree and the branch this call created', async () => {
        const manager = managerFor({ name: 'after-create-fail', hooks: { afterCreate: 'exit 7' } });
        const key = workspaceKeyFor({ workItemId: 'MER-W10' });

        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W10' }), reason: 'hook_failed' });
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W10' }) }), false);
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.endsWith(key)), false);
        const branch = spawnSync('git', ['rev-parse', '--verify', `refs/heads/merci/${key}`], {
            cwd: fixture.repo,
            encoding: 'utf8'
        });
        assert.notEqual(branch.status, 0);
    });

    test('an afterCreate timeout removes the worktree and the branch this call created', async () => {
        const manager = managerFor({
            name: 'after-create-timeout',
            hooks: { afterCreate: 'sleep 5', timeoutMs: 150 }
        });
        const key = workspaceKeyFor({ workItemId: 'MER-W11' });

        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W11' }), reason: 'hook_timeout' });
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W11' }) }), false);
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.endsWith(key)), false);
        const branch = spawnSync('git', ['rev-parse', '--verify', `refs/heads/merci/${key}`], {
            cwd: fixture.repo,
            encoding: 'utf8'
        });
        assert.notEqual(branch.status, 0);
    });

    test('a failed afterCreate keeps the created branch when the hook moved its tip', async () => {
        const manager = managerFor({
            name: 'hook-moved-tip',
            hooks: {
                afterCreate: 'git -c user.name=Merci -c user.email=merci@example.com commit --allow-empty -m hook >/dev/null; exit 7'
            }
        });
        const key = workspaceKeyFor({ workItemId: 'MER-W34' });
        const branch = `merci/${key}`;
        const base = runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.repo });

        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W34' }), reason: 'hook_failed' });
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W34' }) }), false);
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.endsWith(key)), false);

        // The hook moved the branch away from the base ref, so the
        // "tip still equals the base commit" guard must keep it.
        const tip = runGit({ args: ['rev-parse', '--verify', `refs/heads/${branch}`], cwd: fixture.repo });
        assert.notEqual(tip, base);
        assert.equal(runGit({ args: ['log', '-1', '--format=%s', branch], cwd: fixture.repo }), 'hook');
    });

    test('a failed afterCreate keeps a branch that existed before the call', async () => {
        const manager = managerFor({ name: 'preexisting-branch', hooks: { afterCreate: 'exit 7' } });
        const base = runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.repo });

        // Case 1: the branch already exists at the base tip.
        const key = workspaceKeyFor({ workItemId: 'MER-W26' });
        const branch = `merci/${key}`;
        runGit({ args: ['branch', branch, base], cwd: fixture.repo });
        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W26' }), reason: 'hook_failed' });
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W26' }) }), false);
        assert.equal(runGit({ args: ['rev-parse', '--verify', `refs/heads/${branch}`], cwd: fixture.repo }), base);
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.endsWith(key)), false);

        // Case 2: the branch already exists at a later commit.
        const key2 = workspaceKeyFor({ workItemId: 'MER-W27' });
        const branch2 = `merci/${key2}`;
        const tree = runGit({ args: ['rev-parse', 'HEAD^{tree}'], cwd: fixture.repo });
        const later = runGit({
            args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit-tree', tree, '-p', base, '-m', 'later'],
            cwd: fixture.repo
        });
        runGit({ args: ['branch', branch2, later], cwd: fixture.repo });
        await rejectedWorkspaceError({ promise: manager.ensure({ workItemId: 'MER-W27' }), reason: 'hook_failed' });
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W27' }) }), false);
        assert.equal(runGit({ args: ['rev-parse', '--verify', `refs/heads/${branch2}`], cwd: fixture.repo }), later);
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.endsWith(key2)), false);
    });

    test('removeWorktree passes --force only when force is true', async () => {
        const manager = managerFor({ name: 'force-behaviour' });
        const clean = await manager.ensure({ workItemId: 'MER-W28' });
        await removeWorktree({ repoRoot: fixture.repo, path: clean.path, force: false });
        assert.equal(await exists({ path: clean.path }), false);

        const dirty = await manager.ensure({ workItemId: 'MER-W29' });
        await writeFile(join(dirty.path, 'work.txt'), 'agent output');
        await rejectedWorkspaceError({
            promise: removeWorktree({ repoRoot: fixture.repo, path: dirty.path, force: false }),
            reason: 'git_failed'
        });
        assert.equal(await exists({ path: dirty.path }), true);
        await removeWorktree({ repoRoot: fixture.repo, path: dirty.path, force: true });
        assert.equal(await exists({ path: dirty.path }), false);
    });

    test('a branch already checked out elsewhere is git_failed with a hint', async () => {
        const key = workspaceKeyFor({ workItemId: 'MER-W12' });
        const branch = `merci/${key}`;
        runGit({ args: ['branch', branch, 'HEAD'], cwd: fixture.repo });
        const elsewhere = join(fixture.base, 'elsewhere-branch');
        runGit({ args: ['worktree', 'add', elsewhere, branch], cwd: fixture.repo });

        const manager = managerFor({ name: 'branch-checked-out' });
        const error = await rejectedWorkspaceError({
            promise: manager.ensure({ workItemId: 'MER-W12' }),
            reason: 'git_failed'
        });
        assert.match(error.message, /checked out/i);
        assert.equal(await exists({ path: manager.pathFor({ workItemId: 'MER-W12' }) }), false);
    });

    test('an uncommitted host file is absent from the worktree', async () => {
        await writeFile(join(fixture.repo, 'host-only.txt'), 'local only\n');
        try {
            const manager = managerFor({ name: 'host-caveat' });
            const workspace = await manager.ensure({ workItemId: 'MER-W13' });
            assert.equal(await exists({ path: join(workspace.path, 'host-only.txt') }), false);
            assert.equal(await readFile(join(workspace.path, 'base.txt'), 'utf8'), 'base\n');
        } finally {
            await rm(join(fixture.repo, 'host-only.txt'), { force: true });
        }
    });

    test('a clean remove deletes the worktree and keeps the named branch', async () => {
        const manager = managerFor({ name: 'clean-remove' });
        const workspace = await manager.ensure({ workItemId: 'MER-W14' });
        const realPath = await realpath(workspace.path);

        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
        assert.equal(listWorktrees({ repo: fixture.repo }).includes(realPath), false);
        assert.equal(
            runGit({ args: ['rev-parse', '--verify', `refs/heads/${workspace.branch}`], cwd: fixture.repo }).length,
            40
        );
    });

    test('remove refuses a dirty worktree without force and force deletes it', async () => {
        const manager = managerFor({ name: 'dirty-remove' });
        const workspace = await manager.ensure({ workItemId: 'MER-W15' });
        await writeFile(join(workspace.path, 'work.txt'), 'agent output');

        assert.deepEqual(await manager.remove({ workspace }), { removed: false, reason: 'dirty' });
        assert.equal(await readFile(join(workspace.path, 'work.txt'), 'utf8'), 'agent output');
        assert.deepEqual(await manager.remove({ workspace, force: true }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
    });

    test('a detached worktree with an unreachable commit is refused without force', async () => {
        const manager = managerFor({ name: 'detached-unreachable' });
        const workspace = await manager.ensure({ workItemId: 'MER-W16', branch: null });
        runGit({
            args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '--allow-empty', '-m', 'work'],
            cwd: workspace.path
        });

        assert.deepEqual(await manager.remove({ workspace }), { removed: false, reason: 'unreachable_head' });
        assert.equal(await exists({ path: workspace.path }), true);
        assert.deepEqual(await manager.remove({ workspace, force: true }), { removed: true });
    });

    test('a detached worktree at the base commit is removable without force', async () => {
        const manager = managerFor({ name: 'detached-clean' });
        const workspace = await manager.ensure({ workItemId: 'MER-W17', branch: null });

        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
    });

    test('a clean worktree on an unborn orphan branch is removable', async () => {
        const manager = managerFor({ name: 'orphan-clean' });
        const workspace = await manager.ensure({ workItemId: 'MER-W31' });
        runGit({ args: ['checkout', '--orphan', 'fresh-history'], cwd: workspace.path });
        runGit({ args: ['rm', '-rqf', '.'], cwd: workspace.path });
        assert.equal(runGit({ args: ['status', '--porcelain'], cwd: workspace.path }), '');

        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
    });

    test('an orphan branch with a commit is reachable from its own ref, so removal keeps it', async () => {
        const manager = managerFor({ name: 'orphan-commit' });
        const workspace = await manager.ensure({ workItemId: 'MER-W32' });
        runGit({ args: ['checkout', '--orphan', 'fresh-history'], cwd: workspace.path });
        runGit({ args: ['rm', '-rqf', '.'], cwd: workspace.path });
        runGit({
            args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '--allow-empty', '-m', 'orphan'],
            cwd: workspace.path
        });
        const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: workspace.path });
        // `git commit` on an orphan branch creates its ref, so HEAD is reachable
        // from `refs/heads/fresh-history`; this is a named branch, not a
        // detached HEAD, and removal cannot lose the commit.
        assert.equal(runGit({ args: ['rev-list', '--count', 'HEAD', '--not', '--exclude=HEAD', '--all'], cwd: workspace.path }), '0');

        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
        assert.equal(
            runGit({ args: ['rev-parse', '--verify', 'refs/heads/fresh-history'], cwd: fixture.repo }),
            head
        );
    });

    test('remove checks the actual detached HEAD, not the handle branch', async () => {
        const manager = managerFor({ name: 'actual-head' });
        const workspace = await manager.ensure({ workItemId: 'MER-W23' });
        assert.equal(typeof workspace.branch, 'string');
        runGit({ args: ['checkout', '--detach'], cwd: workspace.path });
        runGit({
            args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '--allow-empty', '-m', 'detached'],
            cwd: workspace.path
        });

        assert.deepEqual(await manager.remove({ workspace }), { removed: false, reason: 'unreachable_head' });
        assert.equal(await exists({ path: workspace.path }), true);
        assert.deepEqual(await manager.remove({ workspace, force: true }), { removed: true });
    });

    test('a handleFor preview cannot bypass the detached-HEAD guard', async () => {
        const manager = managerFor({ name: 'handlefor-detached' });
        const workspace = await manager.ensure({ workItemId: 'MER-W24', branch: null });
        runGit({
            args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '--allow-empty', '-m', 'detached'],
            cwd: workspace.path
        });
        const preview = manager.handleFor({ workItemId: 'MER-W24' });
        assert.equal(typeof preview.branch, 'string');
        assert.equal(preview.path, workspace.path);

        assert.deepEqual(await manager.remove({ workspace: preview }), { removed: false, reason: 'unreachable_head' });
        assert.equal(await exists({ path: workspace.path }), true);
        assert.deepEqual(await manager.remove({ workspace: preview, force: true }), { removed: true });
    });

    test('a forged branch field cannot bypass the detached-HEAD guard', async () => {
        const manager = managerFor({ name: 'forged-branch' });
        const workspace = await manager.ensure({ workItemId: 'MER-W25', branch: null });
        runGit({
            args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '--allow-empty', '-m', 'detached'],
            cwd: workspace.path
        });
        const forged = { ...workspace, branch: `merci/${workspace.key}` };

        assert.deepEqual(await manager.remove({ workspace: forged }), { removed: false, reason: 'unreachable_head' });
        assert.equal(await exists({ path: workspace.path }), true);
        assert.deepEqual(await manager.remove({ workspace: forged, force: true }), { removed: true });
    });

    test('remove on a missing worktree prunes and reports missing', async () => {
        const manager = managerFor({ name: 'missing-remove' });
        const workspace = await manager.ensure({ workItemId: 'MER-W18' });
        const key = workspace.key;
        await rm(workspace.path, { recursive: true, force: true });

        assert.deepEqual(await manager.remove({ workspace }), { removed: false, reason: 'missing' });
        assert.equal(listWorktrees({ repo: fixture.repo }).some((path) => path.endsWith(key)), false);
    });

    test('a failing beforeRemove is ignored and removal proceeds', async () => {
        const manager = managerFor({ name: 'before-remove-fail', hooks: { beforeRemove: 'exit 9' } });
        const workspace = await manager.ensure({ workItemId: 'MER-W19' });

        assert.deepEqual(await manager.remove({ workspace }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
    });

    test('a fresh manager resolves the common dir lazily for a linked-worktree repoRoot', async () => {
        const slice = join(fixture.base, 'slice-lazy');
        runGit({ args: ['worktree', 'add', '-b', 'slice-lazy-branch', slice, 'HEAD'], cwd: fixture.repo });
        const root = join(fixture.base, 'roots', 'lazy-common');
        const creator = new WorkspaceManager({
            root,
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: slice
        });
        const workspace = await creator.ensure({ workItemId: 'MER-W30' });
        assert.equal(typeof creator.commonDir, 'string');

        // A different instance never created this workspace, so its common dir
        // is still unprobed when remove() starts.
        const fresh = new WorkspaceManager({
            root,
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: slice
        });
        assert.equal(fresh.commonDir, null);
        const preview = fresh.handleFor({ workItemId: 'MER-W30' });
        assert.deepEqual(await fresh.remove({ workspace: preview }), { removed: true });
        assert.equal(await exists({ path: workspace.path }), false);
        assert.equal(fresh.commonDir, creator.commonDir);
    });

    test('a repoRoot that is not a repo or is bare is rejected', async () => {
        const notRepo = join(fixture.base, 'not-a-repo');
        await mkdir(notRepo, { recursive: true });
        const bare = join(fixture.base, 'bare.git');
        runGit({ args: ['init', '--bare', bare], cwd: fixture.base });

        await rejectedWorkspaceError({
            promise: managerFor({ name: 'not-repo', repoRoot: notRepo }).ensure({ workItemId: 'MER-W20' }),
            reason: 'not_repo'
        });
        await rejectedWorkspaceError({
            promise: managerFor({ name: 'bare', repoRoot: bare }).ensure({ workItemId: 'MER-W21' }),
            reason: 'not_repo'
        });
    });
});
