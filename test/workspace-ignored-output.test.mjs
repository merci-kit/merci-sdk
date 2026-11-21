// @ts-check


/**
 * @file F2-4: git-ignored output is work, so a non-forced removal refuses it.
 * @version 0.12.0
 *
 * @description
 * The terminal cleanup runs `remove({ force: false })` on the promise that the
 * work survives. `git status --porcelain` alone hides ignored files, so a
 * worktree holding only `out/report.md` was reported clean and deleted. The
 * dirty probe counts ignored files too, so the non-forced path refuses and the
 * host decides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager, WORKSPACE_STRATEGIES } from '../lib/agentic/workspace/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** True when the host has a usable `git`; the test is skipped otherwise. */
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

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

test('F2-4 remove refuses a worktree holding only ignored output', {
    skip: GIT_AVAILABLE ? false : 'git is not available on PATH'
}, async () => {
    const base = await mkdtemp(join(tmpdir(), 'merci-workspace-ignored-'));
    const repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    runGit({ args: ['init', '-b', 'main'], cwd: repo });
    await writeFile(join(repo, '.gitignore'), 'out/\n');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    runGit({ args: ['add', '.'], cwd: repo });
    runGit({
        args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '-m', 'base'],
        cwd: repo
    });

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const manager = new WorkspaceManager({
        root: join(base, 'workspaces'),
        strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
        repoRoot: repo,
        eventEmitter: { emit: (name, payload) => { events.push({ event: name, ...payload }); } }
    });
    try {
        const workspace = await manager.ensure({ workItemId: 'MER-IGNORED-1' });
        await mkdir(join(workspace.path, 'out'));
        await writeFile(join(workspace.path, 'out', 'report.md'), 'agent output\n');

        const result = await manager.remove({ workspace });
        assert.deepEqual(result, { removed: false, reason: 'dirty' },
            'ignored output is work, not a clean tree');
        assert.equal(await exists({ path: join(workspace.path, 'out', 'report.md') }), true,
            'the non-forced path kept the file');
        const refused = events.filter((envelope) => envelope.event === EVENTS.WORKSPACE.REMOVE_REFUSED);
        assert.deepEqual(refused.map((envelope) => envelope.reason), ['dirty']);

        const forced = await manager.remove({ workspace, force: true });
        assert.deepEqual(forced, { removed: true });
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
