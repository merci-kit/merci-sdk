// @ts-check


/**
 * @file Git adapter for the `git-worktree` workspace strategy.
 * @version 0.12.0
 *
 * @description
 * Every git call is an argv array with no shell, a bounded timeout, and the
 * safe child environment plus `GIT_TERMINAL_PROMPT=0`; no command here talks to
 * a network. Raw process failures never escape: a missing binary, a bad
 * repository, and a bad base ref all become a `WorkspaceError`.
 *
 * Repo identity never reads `<repoRoot>/.git`. When `repoRoot` is itself a
 * linked worktree, `.git` is a file, so the common repository is resolved once
 * through `rev-parse --git-common-dir` and realpathed. Worktree identity
 * compares `--git-dir` with `--git-common-dir`: equal means the main worktree
 * or a plain subdirectory, not a linked worktree.
 *
 * This module must not import `manager.mjs`: the manager imports it.
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigurationError, WorkspaceError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { runCommand, RUN_COMMAND_TIMEOUT_CODE } from '../../support/run-command.mjs';
import { isAbortError } from './hooks.mjs';
import { isInsideRoot, realpathOrNull } from './paths.mjs';

/** Git never waits for a credential prompt, and never takes an optional lock. */
const GIT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

/**
 * @param {{text: string}} arg0 -
 * @returns {string}
 */
function stderrTail({ text }) {
    const trimmed = text.trim();
    const limit = LIMITS.workspace_git_stderr_tail;
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * @param {{message: string, path?: string, reason?: string, stderr?: string, cause?: unknown}} arg0 -
 * @returns {WorkspaceError}
 */
function gitFailure({ message, path = undefined, reason = 'git_failed', stderr = '', cause = undefined }) {
    return new WorkspaceError({
        message,
        options: {
            reason,
            path,
            cause,
            ...(stderr.trim() === '' ? {} : { stderrTail: stderrTail({ text: stderr }) })
        }
    });
}

/**
 * Run one git command. A non-zero exit is returned to the caller to interpret;
 * a spawn failure, a timeout, or a caller abort is a `WorkspaceError` (an abort
 * is rethrown unchanged).
 * @param {{args: Array<string>, cwd: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
async function runGit({ args, cwd, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    try {
        return await runCommand({ command: 'git', args, cwd, env: GIT_ENV, timeoutMs, signal });
    } catch (error) {
        if (isAbortError({ error })) throw error;
        const timedOut = /** @type {{code?: string}} */ (error).code === RUN_COMMAND_TIMEOUT_CODE;
        throw gitFailure({
            message: `git ${args[0]} could not run in ${cwd}${timedOut ? ' (timed out)' : ''}.`,
            path: cwd,
            cause: error
        });
    }
}

/**
 * Probe a repository and, optionally, resolve a base ref to a commit.
 *
 * `--show-toplevel` failing means "not a repository"; a bare repository has no
 * worktree to add to; a missing base ref is a `git_failed` because the
 * repository itself is fine.
 *
 * @param {{repoRoot: string, baseRef?: string|null, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<{commonDir: string, baseCommit: string|null}>}
 * @throws {ConfigurationError} When `repoRoot` or `baseRef` is invalid.
 * @throws {WorkspaceError} `not_repo` or `git_failed`.
 */
export async function probeRepo({ repoRoot, baseRef = null, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
        throw new ConfigurationError({ message: 'repoRoot must be a non-empty string.', options: { option: 'repoRoot' } });
    }
    const cwd = resolve(repoRoot);
    const shared = { cwd, timeoutMs, signal };

    const topLevel = await runGit({ args: ['rev-parse', '--show-toplevel'], ...shared });
    if (topLevel.code !== 0) {
        throw gitFailure({ message: `Not a git repository: ${cwd}`, path: cwd, reason: 'not_repo', stderr: topLevel.stderr });
    }
    const bare = await runGit({ args: ['rev-parse', '--is-bare-repository'], ...shared });
    if (bare.code !== 0 || bare.stdout.trim() !== 'false') {
        throw gitFailure({ message: `Refusing a bare repository as repoRoot: ${cwd}`, path: cwd, reason: 'not_repo', stderr: bare.stderr });
    }
    const common = await runGit({ args: ['rev-parse', '--git-common-dir'], ...shared });
    if (common.code !== 0) {
        throw gitFailure({ message: `Cannot resolve the common git dir: ${cwd}`, path: cwd, reason: 'not_repo', stderr: common.stderr });
    }
    const commonDir = await realpathOrNull({ path: resolve(cwd, common.stdout.trim()) });
    if (commonDir === null) {
        throw gitFailure({ message: `The common git dir does not exist: ${cwd}`, path: cwd, reason: 'not_repo' });
    }

    let baseCommit = null;
    if (baseRef !== null) {
        if (typeof baseRef !== 'string' || baseRef.trim() === '') {
            throw new ConfigurationError({ message: 'baseRef must be a non-empty string.', options: { option: 'baseRef' } });
        }
        const verify = await runGit({ args: ['rev-parse', '--verify', `${baseRef}^{commit}`], ...shared });
        if (verify.code !== 0) {
            throw gitFailure({
                message: `Cannot resolve base ref '${baseRef}' in ${cwd}.`,
                path: cwd,
                stderr: verify.stderr
            });
        }
        baseCommit = verify.stdout.trim();
    }
    return { commonDir, baseCommit };
}

/**
 * Assert the path is a linked worktree of the manager's repository.
 *
 * `gitDir === commonDir` means the candidate is the repository's main worktree
 * or a plain subdirectory of it, so it is not a linked worktree; comparing
 * common dirs alone would conflate the two. A candidate that is not a
 * repository at all is `not_worktree`, not a raw exec error.
 *
 * @param {{path: string, managerCommonDir: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<void>}
 * @throws {WorkspaceError} `not_worktree` or `wrong_repo`.
 */
export async function assertWorktreeIdentity({ path, managerCommonDir, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(path);
    const shared = { cwd, timeoutMs, signal };
    const gitDirResult = await runGit({ args: ['rev-parse', '--git-dir'], ...shared });
    if (gitDirResult.code !== 0) {
        throw gitFailure({ message: `Not a git worktree: ${cwd}`, path: cwd, reason: 'not_worktree', stderr: gitDirResult.stderr });
    }
    const commonDirResult = await runGit({ args: ['rev-parse', '--git-common-dir'], ...shared });
    if (commonDirResult.code !== 0) {
        throw gitFailure({ message: `Not a git worktree: ${cwd}`, path: cwd, reason: 'not_worktree', stderr: commonDirResult.stderr });
    }
    const gitDir = await realpathOrNull({ path: resolve(cwd, gitDirResult.stdout.trim()) });
    const commonDir = await realpathOrNull({ path: resolve(cwd, commonDirResult.stdout.trim()) });
    if (gitDir === null || commonDir === null || gitDir === commonDir) {
        throw gitFailure({ message: `Not a linked git worktree: ${cwd}`, path: cwd, reason: 'not_worktree' });
    }
    if (commonDir !== managerCommonDir) {
        throw gitFailure({ message: `Worktree belongs to another repository: ${cwd}`, path: cwd, reason: 'wrong_repo' });
    }
}

/**
 * The worktree's checked-out branch, or `null` when HEAD is detached.
 * @param {{path: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<string|null>}
 * @throws {WorkspaceError} `git_failed`.
 */
export async function currentBranch({ path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(path);
    const result = await runGit({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutMs, signal });
    if (result.code !== 0) {
        throw gitFailure({ message: `Cannot read the worktree branch: ${cwd}`, path: cwd, stderr: result.stderr });
    }
    const branch = result.stdout.trim();
    return branch === 'HEAD' ? null : branch;
}

/**
 * True when `git status` reports anything: tracked edits, untracked files, or
 * git-ignored files. Ignored output (`out/`, a generated report, a local data
 * directory) is work a non-forced removal must not delete, so the probe asks
 * for it — `--porcelain` alone reports a worktree of ignored files as clean.
 * @param {{path: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<boolean>}
 * @throws {WorkspaceError} `git_failed`.
 */
export async function isWorktreeDirty({ path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(path);
    const result = await runGit({
        args: ['status', '--porcelain', '--untracked-files=normal', '--ignored=matching'],
        cwd,
        timeoutMs,
        signal
    });
    if (result.code !== 0) {
        throw gitFailure({ message: `Cannot read the worktree status: ${cwd}`, path: cwd, stderr: result.stderr });
    }
    return result.stdout.trim() !== '';
}

/**
 * True when HEAD has commits reachable from no ref (a detached worktree would
 * lose them on removal).
 *
 * AC correction: the plan's exact `--not --all` is a no-op, because `--all`
 * includes HEAD; `--exclude=HEAD --all` hides HEAD so only real refs are
 * subtracted.
 *
 * An unborn HEAD (a fresh `checkout --orphan` with no commit) has nothing to
 * lose: `rev-list HEAD` would fail with an ambiguous argument, so the probe
 * returns false and a clean orphan worktree stays removable (AC7).
 * @param {{path: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<boolean>}
 * @throws {WorkspaceError} `git_failed`.
 */
export async function hasUnreachableHead({ path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(path);
    const head = await runGit({
        args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        cwd,
        timeoutMs,
        signal
    });
    if (head.code !== 0) return false;
    const result = await runGit({
        args: ['rev-list', '--count', 'HEAD', '--not', '--exclude=HEAD', '--all'],
        cwd,
        timeoutMs,
        signal
    });
    if (result.code !== 0) {
        throw gitFailure({ message: `Cannot read HEAD reachability: ${cwd}`, path: cwd, stderr: result.stderr });
    }
    const count = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(count)) {
        throw gitFailure({ message: `Unexpected rev-list output in ${cwd}.`, path: cwd, stderr: result.stdout });
    }
    return count > 0;
}

/**
 * Remove a partially created target, but only when it is inside the manager
 * root; a failure here is swallowed because the original create error matters
 * more. Stale worktree metadata is pruned afterwards.
 * @param {{repoRoot: string, root: string, path: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<void>}
 */
async function removePartialTarget({ repoRoot, root, path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    if (!isInsideRoot({ root, path })) return;
    try {
        await fs.rm(path, { recursive: true, force: true });
    } catch {
        // The caller is already throwing the create failure.
    }
    try {
        await runGit({ args: ['worktree', 'prune'], cwd: resolve(repoRoot), timeoutMs, signal });
    } catch {
        // Best-effort: a stale entry must not mask the create failure.
    }
}

/**
 * Create one worktree.
 *
 * The first attempt with `-b` also creates the branch; when that branch
 * already exists (for example its workspace directory was deleted and the
 * branch survived) the checkout form is the only retry, and a branch checked
 * out in another worktree is reported with a hint. No other failure is
 * retried, so a bad path or base ref is never masked.
 *
 * @param {{repoRoot: string, root: string, path: string, key: string, branchPrefix?: string, branch?: string|null, baseRef?: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<{branch: string|null, createdBranch: boolean}>}
 * @throws {ConfigurationError} When `branch` is neither a string nor null.
 * @throws {WorkspaceError} `git_failed`.
 */
export async function createWorktree({
    repoRoot,
    root,
    path,
    key,
    branchPrefix = 'merci/',
    branch = undefined,
    baseRef = 'HEAD',
    timeoutMs = LIMITS.workspace_git_timeout_ms,
    signal = null
}) {
    const cwd = resolve(repoRoot);
    const target = resolve(path);
    const branchName = branch === undefined ? `${branchPrefix}${key}` : branch;
    if (branchName !== null && (typeof branchName !== 'string' || branchName.trim() === '')) {
        throw new ConfigurationError({
            message: 'branch must be a non-empty string or null.',
            options: { option: 'branch' }
        });
    }
    const shared = { cwd, timeoutMs, signal };

    try {
        if (branchName === null) {
            const detached = await runGit({ args: ['worktree', 'add', '--detach', target, baseRef], ...shared });
            if (detached.code !== 0) {
                throw gitFailure({ message: `Cannot create the detached worktree: ${target}`, path: target, stderr: detached.stderr });
            }
            return { branch: null, createdBranch: false };
        }

        const created = await runGit({ args: ['worktree', 'add', '-b', branchName, target, baseRef], ...shared });
        if (created.code === 0) return { branch: branchName, createdBranch: true };
        if (!/already exists/i.test(created.stderr)) {
            throw gitFailure({ message: `Cannot create the worktree: ${target}`, path: target, stderr: created.stderr });
        }

        const reused = await runGit({ args: ['worktree', 'add', target, branchName], ...shared });
        if (reused.code === 0) return { branch: branchName, createdBranch: false };
        // Git versions differ: "is already checked out at" vs "is already used by worktree at".
        if (/already (?:checked out|used by worktree)/i.test(reused.stderr)) {
            throw gitFailure({
                message: `Branch '${branchName}' is already checked out in another worktree. Remove that worktree or pass branch: null.`,
                path: target,
                stderr: reused.stderr
            });
        }
        throw gitFailure({ message: `Cannot check out branch '${branchName}': ${target}`, path: target, stderr: reused.stderr });
    } catch (error) {
        await removePartialTarget({ repoRoot: cwd, root, path: target, timeoutMs, signal });
        throw error;
    }
}

/**
 * `git worktree remove`, with `--force` only when asked, then a best-effort
 * prune. A named branch is kept.
 * @param {{repoRoot: string, path: string, force?: boolean, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<void>}
 * @throws {WorkspaceError} `git_failed`.
 */
export async function removeWorktree({ repoRoot, path, force = false, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(repoRoot);
    const target = resolve(path);
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), target];
    const result = await runGit({ args, cwd, timeoutMs, signal });
    if (result.code !== 0) {
        throw gitFailure({ message: `Cannot remove the worktree: ${target}`, path: target, stderr: result.stderr });
    }
    try {
        await runGit({ args: ['worktree', 'prune'], cwd, timeoutMs, signal });
    } catch {
        // Best-effort: the worktree itself is gone.
    }
}

/**
 * Prune stale worktree metadata. Safe when a recorded path is missing.
 * @param {{repoRoot: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<void>}
 * @throws {WorkspaceError} `git_failed`.
 */
export async function pruneWorktrees({ repoRoot, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(repoRoot);
    const result = await runGit({ args: ['worktree', 'prune'], cwd, timeoutMs, signal });
    if (result.code !== 0) {
        throw gitFailure({ message: `Cannot prune worktrees: ${cwd}`, path: cwd, stderr: result.stderr });
    }
}

/**
 * Delete a branch only while it still points at `baseCommit`. Used to undo a
 * branch this call created when `afterCreate` failed; a branch that moved
 * (or existed before the call) is never deleted.
 * @param {{repoRoot: string, branch: string, baseCommit: string, timeoutMs?: number, signal?: AbortSignal|null}} arg0 -
 * @returns {Promise<boolean>} True when the branch was deleted.
 * @throws {WorkspaceError} `git_failed`.
 */
export async function deleteBranchIfAtBase({ repoRoot, branch, baseCommit, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null }) {
    const cwd = resolve(repoRoot);
    const shared = { cwd, timeoutMs, signal };
    const tip = await runGit({ args: ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], ...shared });
    if (tip.code !== 0) return false;
    if (tip.stdout.trim() !== baseCommit) return false;
    const deleted = await runGit({ args: ['branch', '-D', branch], ...shared });
    if (deleted.code !== 0) {
        throw gitFailure({ message: `Cannot delete the created branch: ${branch}`, path: cwd, stderr: deleted.stderr });
    }
    return true;
}
