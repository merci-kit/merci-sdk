// @ts-check


/**
 * @file Per-item workspace lifecycle: `directory` and `git-worktree`.
 * @version 0.12.0
 *
 * @description
 * One workspace per work item, created once and reused afterwards. Every
 * public method validates the handle it is given before any IO, so a forged
 * handle cannot point a hook's `cwd` at, or `remove()` at, a directory the
 * manager does not own. Isolation here is a path invariant — containment plus
 * the existing approval gates — not an OS sandbox.
 *
 * The worktree strategy delegates every git operation to `git.mjs`, including
 * identity, so a plain directory, a worktree of another repository, or a
 * bare/non-repository `repoRoot` is refused before a hook can run in it.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ConfigurationError, WorkspaceError } from '../../core/errors.mjs';
import { EVENTS } from '../../core/events.mjs';
import { readStoredJson, writeJsonAtomic } from '../../support/fs-store.mjs';
import { assertDirectoryTarget, assertRealPathInsideRoot, isInsideRoot, lstatOrNull, normalizeRoot, realpathAllowingMissing, realpathOrNull, resolveWorkspaceRoot } from './paths.mjs';
import { workspaceKeyFor } from './keys.mjs';
import { normalizeIdentifier } from './identity.mjs';
import { WORKSPACE_HOOKS, emitWorkspaceEvent, isAbortError, normalizeHooks, runWorkspaceHook } from './hooks.mjs';
import {
    assertWorktreeIdentity,
    createWorktree,
    currentBranch,
    deleteBranchIfAtBase,
    hasUnreachableHead,
    isWorktreeDirty,
    probeRepo,
    pruneWorktrees,
    removeWorktree
} from './git.mjs';

/** The strategies, frozen so a caller cannot mutate the registry. */
export const WORKSPACE_STRATEGIES = Object.freeze({
    DIRECTORY: 'directory',
    GIT_WORKTREE: 'git-worktree'
});

/** The sibling file that records which work item owns a key (F2-5, F2-6). */
const OWNER_MARKER_SUFFIX = '.merci-owner.json';

/**
 * Who a workspace key belongs to, and whether its `afterCreate` finished.
 * `ownerId` is always a string, so one item id spelled two ways (`42` and
 * `'42'`) is one owner.
 * @typedef {Object} OwnerMarker
 * @property {string} ownerId
 * @property {string|null} identifier
 * @property {boolean} ready
 */

/**
 * The marker path is a sibling of the workspace directory, not a file inside
 * it: the plain-directory emptiness check and a worktree's `git status` stay
 * about the work, and a worktree removal cannot take the marker with it.
 * @param {{root: string, key: string}} arg0 -
 * @returns {string}
 */
function ownerMarkerPath({ root, key }) {
    return join(root, `${key}${OWNER_MARKER_SUFFIX}`);
}

/**
 * The marker, or `null` when there is none or it cannot be read. An unreadable
 * marker is treated as unknown ownership: the caller re-runs `afterCreate` and
 * rewrites it, which is the safe direction for a half-initialised directory.
 * A marker written before `ownerId` existed stored the key source as
 * `workItemId`; that value is read as the owner so an intermediate workspace is
 * never mistaken for a fresh one.
 * @param {{root: string, key: string}} arg0 -
 * @returns {Promise<OwnerMarker|null>}
 */
async function readOwnerMarker({ root, key }) {
    /** @type {{status: string, value?: unknown}} */
    let stored;
    try {
        stored = await readStoredJson({ filePath: ownerMarkerPath({ root, key }) });
    } catch {
        return null;
    }
    if (stored.status !== 'ok' || stored.value === null || typeof stored.value !== 'object') return null;
    const value = /** @type {Record<string, unknown>} */ (stored.value);
    const owner = value.ownerId ?? value.workItemId;
    if (typeof owner !== 'string' && typeof owner !== 'number') return null;
    return {
        ownerId: String(owner),
        identifier: normalizeIdentifier({ value: value.identifier }),
        ready: value.ready === true
    };
}

/**
 * The frozen handle `ensure()` returns and every other method accepts.
 * @typedef {Object} WorkspaceHandle
 * @property {string|number} workItemId
 * @property {string|null} identifier - The scheduling identity, when the host supplied one.
 * @property {string} key
 * @property {string} root
 * @property {string} path
 * @property {string} strategy
 * @property {string|null} branch - Informational preview only; `remove` reads the real HEAD from git, never this field.
 * @property {string|null} repoRoot
 * @property {boolean} createdNow
 * @property {string|null} createdAt
 */

/**
 * A caller-supplied handle. Every field is untrusted until
 * `assertWorkspaceIdentity` has run.
 * @typedef {Object} WorkspaceHandleLike
 * @property {unknown} [workItemId]
 * @property {unknown} [identifier]
 * @property {unknown} [key]
 * @property {unknown} [root]
 * @property {unknown} [path]
 * @property {unknown} [strategy]
 * @property {unknown} [branch]
 */

/**
 * The message of an unknown thrown value, for cleanup context.
 * @param {{error: unknown}} arg0 -
 * @returns {string}
 */
function describeError({ error }) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The identity fields a hook needs, narrowed after `assertWorkspaceHandle`.
 * @param {{workspace: WorkspaceHandleLike}} arg0 -
 * @returns {{workItemId: string|number, identifier: string|null, key: string, path: string}}
 */
function hookTarget({ workspace }) {
    return {
        workItemId: /** @type {string|number} */ (workspace.workItemId),
        identifier: normalizeIdentifier({ value: workspace.identifier }),
        key: /** @type {string} */ (workspace.key),
        path: /** @type {string} */ (workspace.path)
    };
}

/**
 * @param {{root: unknown}} arg0 -
 * @returns {string} The resolved root.
 * @throws {ConfigurationError} When the root is not a non-empty string or is the filesystem root.
 */
function normalizeRootOption({ root }) {
    const absolute = normalizeRoot({ root });
    if (absolute === parse(absolute).root) {
        throw new ConfigurationError({
            message: `Refusing the filesystem root as a workspace root: ${absolute}`,
            options: { option: 'root' }
        });
    }
    return absolute;
}


export class WorkspaceManager {

    /**
     * @param {{root?: string, strategy?: string, repoRoot?: string|null, baseRef?: string, branchPrefix?: string, hooks?: unknown, eventEmitter?: import('./hooks.mjs').WorkspaceEmitter|null}} [arg0] -
     */
    constructor({
        root = join(tmpdir(), 'merci-workspaces'),
        strategy = WORKSPACE_STRATEGIES.DIRECTORY,
        repoRoot = null,
        baseRef = 'HEAD',
        branchPrefix = 'merci/',
        hooks = {},
        eventEmitter = null
    } = {}) {
        if (strategy !== WORKSPACE_STRATEGIES.DIRECTORY && strategy !== WORKSPACE_STRATEGIES.GIT_WORKTREE) {
            throw new ConfigurationError({
                message: `Unknown workspace strategy: ${String(strategy)}. Use 'directory' or 'git-worktree'.`,
                options: { option: 'strategy' }
            });
        }
        if (strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE && (typeof repoRoot !== 'string' || repoRoot.trim() === '')) {
            throw new ConfigurationError({
                message: "strategy 'git-worktree' requires a non-empty repoRoot.",
                options: { option: 'repoRoot' }
            });
        }
        /** @type {string} */
        this.root = normalizeRootOption({ root });
        /** @type {string} */
        this.strategy = strategy;
        /** @type {string|null} */
        this.repoRoot = strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE
            ? resolve(/** @type {string} */ (repoRoot))
            : repoRoot;
        /** @type {string|null} Probed once, then reused for every identity check. */
        this.commonDir = null;
        /** @type {string} */
        this.baseRef = baseRef;
        /** @type {string} */
        this.branchPrefix = branchPrefix;
        /** @type {import('./hooks.mjs').NormalizedHooks} */
        this.hooks = normalizeHooks({ hooks });
        /** @type {import('./hooks.mjs').WorkspaceEmitter|null} */
        this.eventEmitter = eventEmitter;
        /** @type {Set<string>} */
        this.activeKeys = new Set();
        /** @type {Map<string, string>} The first identifier seen for each workspace key. */
        this.identifierByKey = new Map();
        /** @type {Map<string, Promise<void>>} */
        this.locks = new Map();
    }

    /**
     * Create the workspace for an item, or reuse it when it already exists.
     *
     * `ownerId` is the item identity the marker records and compares; it
     * defaults to `workItemId` (the key source) but the scheduler passes the
     * real provider id, because a recycled identifier derives the same key for
     * a different item. Owners compare as strings.
     *
     * `branch` defaults to `` `${branchPrefix}${key}` `` and `branch: null`
     * opts into a detached worktree; both drive the worktree strategy only.
     * `baseRef` overrides the constructor default for this call.
     *
     * @param {{workItemId: string|number, identifier?: string|null, ownerId?: string|number|null, branch?: string|null, baseRef?: string|null, signal?: AbortSignal|null}} arg0 -
     * @returns {Promise<WorkspaceHandle>} A frozen handle.
     */
    async ensure({ workItemId, identifier = null, ownerId = null, branch = undefined, baseRef = null, signal = null }) {
        const key = workspaceKeyFor({ workItemId });
        const normalizedIdentifier = normalizeIdentifier({ value: identifier });
        return this.serializeByKey({
            key,
            fn: () => this.createOrReuse({
                workItemId,
                identifier: normalizedIdentifier,
                ownerId: String(ownerId ?? workItemId),
                key,
                branch,
                baseRef,
                signal
            })
        });
    }

    /**
     * Run the `beforeRun` hook, then mark the workspace active.
     * A hook failure is fatal to the attempt.
     * @param {{workspace: WorkspaceHandleLike, signal?: AbortSignal|null}} arg0 -
     * @returns {Promise<void>}
     */
    async beforeRun({ workspace, signal = null }) {
        await this.assertWorkspaceHandle({ workspace });
        const target = hookTarget({ workspace });
        await this.#runHook({ hook: WORKSPACE_HOOKS.BEFORE_RUN, target, signal });
        this.activeKeys.add(target.key);
    }

    /**
     * Run the `afterRun` hook and clear the active guard. Never throws except a
     * caller abort; a forged handle is reported, not trusted.
     * @param {{workspace: WorkspaceHandleLike, outcome?: string, signal?: AbortSignal|null}} arg0 -
     * @returns {Promise<{skipped: true, reason: string}|undefined>}
     */
    async afterRun({ workspace, outcome: _outcome, signal = null }) {
        try {
            await this.assertWorkspaceIdentity({ workspace, requireExists: false });
        } catch (error) {
            if (isAbortError({ error })) throw error;
            return { skipped: true, reason: 'invalid_handle' };
        }
        const target = hookTarget({ workspace });
        const present = await lstatOrNull({ path: target.path });
        if (!present) {
            this.activeKeys.delete(target.key);
            return { skipped: true, reason: 'missing' };
        }
        try {
            await this.#runHook({ hook: WORKSPACE_HOOKS.AFTER_RUN, target, signal });
        } catch (error) {
            if (isAbortError({ error })) throw error;
            // runWorkspaceHook already emitted hook_failed with fatal: false.
        } finally {
            this.activeKeys.delete(target.key);
        }
        return undefined;
    }

    /**
     * Remove the workspace. Refuses an active or non-empty/dirty workspace
     * without `force`. A worktree whose actual HEAD has a commit reachable
     * from no ref also refuses without `force`; that check reads the real
     * repository state, not the handle's informational `branch` field.
     * Never deletes a path outside this manager's root.
     *
     * Serialized per key so two concurrent removals cannot both report
     * `removed: true` or race into a raw `ENOENT`.
     * @param {{workspace: WorkspaceHandleLike, force?: boolean}} arg0 -
     * @returns {Promise<{removed: boolean, reason?: string}>}
     */
    async remove({ workspace, force = false }) {
        await this.assertWorkspaceIdentity({ workspace, requireExists: false });
        const key = /** @type {string} */ (workspace.key);
        return this.serializeByKey({ key, fn: () => this.removeLocked({ workspace, force }) });
    }

    /**
     * The body of `remove`, run while the per-key lock is held.
     * @param {{workspace: WorkspaceHandleLike, force: boolean}} arg0 -
     * @returns {Promise<{removed: boolean, reason?: string}>}
     */
    async removeLocked({ workspace, force }) {
        const target = hookTarget({ workspace });

        if (this.activeKeys.has(target.key) && !force) {
            this.emitRemoveRefused({ ...target, reason: 'in_use' });
            return { removed: false, reason: 'in_use' };
        }

        const present = await lstatOrNull({ path: target.path });
        if (!present) {
            this.activeKeys.delete(target.key);
            this.identifierByKey.delete(target.key);
            await this.#removeOwnerMarker({ key: target.key });
            await this.prune();
            return { removed: false, reason: 'missing' };
        }

        await this.assertWorkspaceHandle({ workspace });
        if (this.strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE) {
            if (!force && await isWorktreeDirty({ path: target.path })) {
                this.emitRemoveRefused({ ...target, reason: 'dirty' });
                return { removed: false, reason: 'dirty' };
            }
            // Detachment is repository state, not handle data. A handle may
            // claim a named branch while `git checkout --detach` or a rebase
            // left HEAD on commits reachable from no ref, and a `handleFor()`
            // preview always claims the default branch. A named branch yields
            // a zero count, so one rule covers every case.
            if (!force && await hasUnreachableHead({ path: target.path })) {
                this.emitRemoveRefused({ ...target, reason: 'unreachable_head' });
                return { removed: false, reason: 'unreachable_head' };
            }
        } else {
            const entries = await fs.readdir(target.path);
            if (entries.length > 0 && !force) {
                this.emitRemoveRefused({ ...target, reason: 'not_empty' });
                return { removed: false, reason: 'not_empty' };
            }
        }

        try {
            await this.#runHook({ hook: WORKSPACE_HOOKS.BEFORE_REMOVE, target });
        } catch (error) {
            if (isAbortError({ error })) throw error;
            // beforeRemove failures are logged and ignored.
        }

        // Containment and derivation were enforced by assertWorkspaceIdentity
        // and re-checked by assertWorkspaceHandle above; a raw string prefix
        // here would reject a legitimate handle whose root spelling is a
        // symlink alias of the promoted real root (the scheduler cleanup path).
        try {
            if (this.strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE) {
                await removeWorktree({
                    repoRoot: /** @type {string} */ (this.repoRoot),
                    path: target.path,
                    force
                });
            } else if (force) await fs.rm(target.path, { recursive: true, force: true });
            else await fs.rmdir(target.path);
        } catch (error) {
            if (/** @type {{code?: string}} */ (error).code === 'ENOENT'
                || await lstatOrNull({ path: target.path }) === null) {
                this.activeKeys.delete(target.key);
                this.identifierByKey.delete(target.key);
                await this.#removeOwnerMarker({ key: target.key });
                await this.prune();
                return { removed: false, reason: 'missing' };
            }
            throw error;
        }

        this.activeKeys.delete(target.key);
        this.identifierByKey.delete(target.key);
        await this.#removeOwnerMarker({ key: target.key });
        emitWorkspaceEvent({
            eventEmitter: this.eventEmitter,
            name: EVENTS.WORKSPACE.REMOVED,
            payload: {
                workItemId: target.workItemId,
                ...(target.identifier === null ? {} : { identifier: target.identifier }),
                key: target.key,
                path: target.path,
                strategy: this.strategy,
                forced: Boolean(force)
            }
        });
        return { removed: true };
    }

    /**
     * The path `ensure()` will use for an item. No IO, no creation.
     * @param {{workItemId: string|number}} arg0 -
     * @returns {string}
     */
    pathFor({ workItemId }) {
        return join(this.root, workspaceKeyFor({ workItemId }));
    }

    /**
     * A fully populated handle for an item this process never ensured. No IO.
     * `branch` is a preview only: `remove` checks the actual HEAD from git, so
     * a detached or rebased workspace is still protected.
     * @param {{workItemId: string|number, identifier?: string|null}} arg0 -
     * @returns {WorkspaceHandle}
     */
    handleFor({ workItemId, identifier = null }) {
        const key = workspaceKeyFor({ workItemId });
        const supplied = normalizeIdentifier({ value: identifier });
        return Object.freeze({
            workItemId,
            identifier: supplied ?? this.identifierByKey.get(key) ?? null,
            key,
            root: this.root,
            path: join(this.root, key),
            strategy: this.strategy,
            branch: this.strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE ? `${this.branchPrefix}${key}` : null,
            repoRoot: this.repoRoot,
            createdNow: false,
            createdAt: null
        });
    }

    /**
     * Prune stale worktree metadata. Safe when a recorded worktree path is
     * already missing; a no-op for the directory strategy.
     * @returns {Promise<void>}
     */
    async prune() {
        if (this.strategy !== WORKSPACE_STRATEGIES.GIT_WORKTREE) return;
        await pruneWorktrees({ repoRoot: /** @type {string} */ (this.repoRoot) });
    }

    /**
     * The manager's common git dir, probed once. Never derived from
     * `<repoRoot>/.git`, which is a file when `repoRoot` is a linked worktree.
     * @returns {Promise<string>}
     */
    async getCommonDir() {
        if (this.commonDir !== null) return this.commonDir;
        const probe = await probeRepo({ repoRoot: /** @type {string} */ (this.repoRoot) });
        this.commonDir = probe.commonDir;
        return this.commonDir;
    }

    /**
     * Assert the handle belongs to this manager and its path is the derived
     * path inside the root. `requireExists: true` rejects a missing directory.
     * @param {{workspace: WorkspaceHandleLike, requireExists?: boolean}} arg0 -
     * @returns {Promise<void>}
     */
    async assertWorkspaceIdentity({ workspace, requireExists = false }) {
        const rawRoot = workspace?.root;
        const rawPath = workspace?.path;
        const rawKey = workspace?.key;
        const workItemId = workspace?.workItemId;
        const identifier = workspace?.identifier;
        if (typeof rawRoot !== 'string' || rawRoot === ''
            || typeof rawPath !== 'string' || rawPath === ''
            || typeof rawKey !== 'string' || rawKey === '') {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'invalid_handle',
                message: 'Workspace handle must carry non-empty string root, key, and path.'
            });
        }
        if (typeof workItemId !== 'string' && typeof workItemId !== 'number') {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'invalid_handle',
                message: 'Workspace handle must carry a string or number workItemId.'
            });
        }
        // A handle from a manager with another strategy cannot name this
        // manager's workspace, even when root and path look right.
        if (workspace?.strategy !== this.strategy) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'invalid_handle',
                message: `Workspace handle strategy '${String(workspace?.strategy)}' does not match this manager's '${this.strategy}'.`
            });
        }
        // The key must be the one this id derives, or a handle could swap in a
        // sibling's key/path and the removal event would name the wrong item.
        /** @type {string} */
        let derivedKey;
        try {
            derivedKey = workspaceKeyFor({ workItemId });
        } catch {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'invalid_handle',
                message: `Workspace handle carries an invalid workItemId: ${String(workItemId)}`
            });
        }
        if (derivedKey !== rawKey) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'path_mismatch',
                message: `Workspace key '${rawKey}' is not the key derived for this item.`
            });
        }

        const workspaceRoot = resolve(rawRoot);
        const thisRoot = resolve(this.root);
        const [realWorkspaceRoot, realThisRoot] = await Promise.all([
            realpathOrNull({ path: workspaceRoot }),
            realpathOrNull({ path: thisRoot })
        ]);
        const sameRoot = realWorkspaceRoot !== null && realThisRoot !== null
            ? realWorkspaceRoot === realThisRoot
            : workspaceRoot === thisRoot;
        if (!sameRoot) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'outside_root',
                message: `Workspace handle root is not this manager's root: ${rawRoot}`
            });
        }

        const derived = join(this.root, rawKey);
        const stats = await lstatOrNull({ path: rawPath });
        if (!stats) {
            const resolvedPath = resolve(rawPath);
            // Compare through the nearest existing ancestor, not raw strings: a
            // promoted root (`/var/...` -> `/private/var/...`) makes a handle
            // taken before promotion spell the same missing path differently.
            const realDerived = await realpathAllowingMissing({ target: derived });
            const realPath = await realpathAllowingMissing({ target: resolvedPath });
            if (realPath !== realDerived) {
                const realRoot = realThisRoot ?? thisRoot;
                if (!isInsideRoot({ root: realRoot, path: realPath })
                    || !isInsideRoot({ root: realRoot, path: dirname(realPath) })
                    || !isInsideRoot({ root: thisRoot, path: resolvedPath })) {
                    throw this.pathRejection({
                        workItemId,
                        identifier,
                        key: rawKey,
                        path: rawPath,
                        reason: 'outside_root',
                        message: `Workspace path escapes the manager root: ${rawPath}`
                    });
                }
                throw this.pathRejection({
                    workItemId,
                    identifier,
                    key: rawKey,
                    path: rawPath,
                    reason: 'path_mismatch',
                    message: `Workspace path is not the path derived for this item: ${rawPath}`
                });
            }
            if (requireExists) {
                throw this.pathRejection({
                    workItemId,
                    identifier,
                    key: rawKey,
                    path: rawPath,
                    reason: 'not_directory',
                    message: `Workspace does not exist: ${rawPath}`
                });
            }
            return;
        }
        if (stats.isSymbolicLink()) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'symlink',
                message: `Workspace path is a symlink: ${rawPath}`
            });
        }
        if (!stats.isDirectory()) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'not_directory',
                message: `Workspace path is not a directory: ${rawPath}`
            });
        }

        const realRoot = realThisRoot ?? thisRoot;
        const realPath = await realpathOrNull({ path: rawPath });
        if (realPath === null) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'not_directory',
                message: `Workspace does not exist: ${rawPath}`
            });
        }
        if (!isInsideRoot({ root: realRoot, path: realPath }) || !isInsideRoot({ root: realRoot, path: dirname(realPath) })) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'outside_root',
                message: `Workspace path resolves outside the manager root: ${realPath}`
            });
        }
        const realDerived = await realpathOrNull({ path: derived });
        if (realDerived === null || realPath !== realDerived) {
            throw this.pathRejection({
                workItemId,
                identifier,
                key: rawKey,
                path: rawPath,
                reason: 'path_mismatch',
                message: `Workspace path is not the path derived for this item: ${rawPath}`
            });
        }
        if (this.strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE) {
            try {
                const commonDir = await this.getCommonDir();
                await assertWorktreeIdentity({ path: realPath, managerCommonDir: commonDir });
            } catch (error) {
                if (error instanceof WorkspaceError) {
                    this.emitPathRejected({
                        workItemId,
                        identifier,
                        key: rawKey,
                        path: rawPath,
                        reason: error.reason ?? 'not_worktree'
                    });
                }
                throw error;
            }
        }
    }

    /**
     * `assertWorkspaceIdentity` with `requireExists: true`.
     * @param {{workspace: WorkspaceHandleLike}} arg0 -
     * @returns {Promise<void>}
     */
    async assertWorkspaceHandle({ workspace }) {
        await this.assertWorkspaceIdentity({ workspace, requireExists: true });
    }

    /**
     * Create the workspace while its per-key lock is held.
     * @param {{workItemId: string|number, identifier?: string|null, ownerId: string, key: string, branch?: string|null, baseRef?: string|null, signal: AbortSignal|null}} arg0 -
     * @returns {Promise<WorkspaceHandle>}
     */
    async createOrReuse({ workItemId, identifier = null, ownerId, key, branch = undefined, baseRef = null, signal }) {
        identifier = normalizeIdentifier({ value: identifier });
        // One key keeps the first identifier it was created with, so a later
        // reuse without one still emits the same identity and a different one
        // cannot silently take the workspace over.
        const remembered = this.identifierByKey.get(key) ?? null;
        if (identifier !== null && remembered !== null && identifier !== remembered) {
            throw new ConfigurationError({
                message: `Workspace identifier '${identifier}' conflicts with '${remembered}' for key '${key}'.`,
                options: { option: 'identifier_conflict' }
            });
        }
        if (identifier === null) identifier = remembered;

        this.root = await resolveWorkspaceRoot({ root: this.root });
        const path = join(this.root, key);

        await this.assertTarget({ workItemId, identifier, key, path });
        let existing = await lstatOrNull({ path });
        const owner = await readOwnerMarker({ root: this.root, key });
        if (existing && owner !== null && owner.ownerId !== ownerId) {
            // The directory was kept by a refused cleanup and belongs to another
            // item (a recycled identifier derives one key for both). Hand it
            // over and the new item starts in someone else's tree, so it is
            // renamed aside for the host to inspect or reap. The uuid keeps two
            // renames in one millisecond apart.
            await fs.rename(path, join(this.root, `${key}.orphan-${Date.now()}-${randomUUID().slice(0, 8)}`));
            // A worktree registration still names the old directory, and git
            // would refuse the branch as "already checked out" when the fresh
            // tree is created; the directory is gone, so the entry is stale.
            await this.prune();
            existing = null;
        }
        let createdNow = false;
        /** @type {string} */
        let createdAt;
        /** @type {'recovered'|null} */
        let hooksRun = null;
        /** @type {string|null} */
        let resolvedBranch = null;
        /** @type {{branch: string|null, createdBranch: boolean, baseCommit: string}|null} */
        let creation = null;
        if (existing) {
            createdAt = existing.birthtime.toISOString();
        } else if (this.strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE) {
            creation = await this.createWorktreeWorkspace({ key, path, branch, baseRef, signal });
            createdNow = true;
            resolvedBranch = creation.branch;
            createdAt = new Date().toISOString();
        } else {
            await fs.mkdir(path, { recursive: true });
            createdNow = true;
            createdAt = new Date().toISOString();
        }
        await this.assertInsideRootAfterCreation({ workItemId, identifier, key, path });

        // A reused path must still be a linked worktree of this repository, and
        // a new one must already be registered, before a hook runs in it. The
        // identity check runs before the HEAD read: a plain directory at the
        // derived path must be reported as `not_worktree` (with a
        // `workspace:path_rejected` event), not as a raw git failure from
        // `rev-parse --abbrev-ref HEAD`.
        if (this.strategy === WORKSPACE_STRATEGIES.GIT_WORKTREE) {
            await this.assertWorkspaceIdentity({
                workspace: { workItemId, identifier, key, root: this.root, path, strategy: this.strategy },
                requireExists: true
            });
            if (!createdNow) resolvedBranch = await currentBranch({ path });
        }

        if (createdNow) {
            // `ready` is written only after the hook succeeds, so a process that
            // dies mid-hook leaves a marker a later reuse can recognise.
            await this.#writeOwnerMarker({ key, workItemId, ownerId, identifier, ready: false });
            try {
                await this.#runHook({
                    hook: WORKSPACE_HOOKS.AFTER_CREATE,
                    target: { workItemId, identifier, key, path },
                    signal
                });
            } catch (error) {
                if (creation) await this.cleanupCreatedWorktree({ path, creation, error });
                else await this.removeCreated({ path, error });
                throw error;
            }
            await this.#writeOwnerMarker({ key, workItemId, ownerId, identifier, ready: true });
        } else if (owner === null || owner.ready !== true) {
            // A crash during `afterCreate` (or a cleanup that could not remove
            // the partial directory) leaves a path that was never initialised.
            // Reusing it silently ran every later attempt in a half-built
            // checkout, so the setup is finished here and reported as recovered.
            await this.#runHook({
                hook: WORKSPACE_HOOKS.AFTER_CREATE,
                target: { workItemId, identifier, key, path },
                signal
            });
            hooksRun = 'recovered';
            await this.#writeOwnerMarker({ key, workItemId, ownerId, identifier, ready: true });
        }

        // Record only after the workspace exists, so a failed creation never
        // pins an identifier to a key that has no workspace.
        if (identifier !== null) this.identifierByKey.set(key, identifier);

        emitWorkspaceEvent({
            eventEmitter: this.eventEmitter,
            name: createdNow ? EVENTS.WORKSPACE.CREATED : EVENTS.WORKSPACE.REUSED,
            payload: {
                workItemId,
                ...(identifier === null ? {} : { identifier }),
                key,
                path,
                strategy: this.strategy,
                branch: resolvedBranch,
                createdNow,
                ...(hooksRun === null ? {} : { hooksRun })
            }
        });
        return Object.freeze({
            workItemId,
            identifier,
            key,
            root: this.root,
            path,
            strategy: this.strategy,
            branch: resolvedBranch,
            repoRoot: this.repoRoot,
            createdNow,
            createdAt
        });
    }

    /**
     * Probe the repository and base ref, then create the worktree.
     *
     * The probe runs first, so a missing base ref fails before any directory
     * is written.
     * @param {{key: string, path: string, branch?: string|null, baseRef?: string|null, signal: AbortSignal|null}} arg0 -
     * @returns {Promise<{branch: string|null, createdBranch: boolean, baseCommit: string}>}
     */
    async createWorktreeWorkspace({ key, path, branch = undefined, baseRef = null, signal }) {
        const repoRoot = /** @type {string} */ (this.repoRoot);
        const effectiveBaseRef = baseRef ?? this.baseRef;
        const probe = await probeRepo({ repoRoot, baseRef: effectiveBaseRef, signal });
        // Cached for every later identity check; the common dir never reads
        // `<repoRoot>/.git`, which is a file when repoRoot is a linked worktree.
        this.commonDir = probe.commonDir;
        const created = await createWorktree({
            repoRoot,
            root: this.root,
            path,
            key,
            branchPrefix: this.branchPrefix,
            branch,
            baseRef: effectiveBaseRef,
            signal
        });
        return { ...created, baseCommit: /** @type {string} */ (probe.baseCommit) };
    }

    /**
     * Undo a worktree this call created after `afterCreate` failed: remove the
     * worktree with force, delete the branch only while it is still at the base
     * commit and this call created it, then prune. Cleanup failures are
     * attached to the hook error and never replace it.
     * @param {{path: string, creation: {branch: string|null, createdBranch: boolean, baseCommit: string}, error: unknown}} arg0 -
     * @returns {Promise<void>}
     */
    async cleanupCreatedWorktree({ path, creation, error }) {
        const repoRoot = /** @type {string} */ (this.repoRoot);
        /** @type {Array<string>} */
        const cleanupErrors = [];
        try {
            await removeWorktree({ repoRoot, path, force: true });
        } catch (cleanupError) {
            cleanupErrors.push(describeError({ error: cleanupError }));
        }
        if (creation.createdBranch && typeof creation.branch === 'string') {
            try {
                await deleteBranchIfAtBase({ repoRoot, branch: creation.branch, baseCommit: creation.baseCommit });
            } catch (cleanupError) {
                cleanupErrors.push(describeError({ error: cleanupError }));
            }
        }
        try {
            await pruneWorktrees({ repoRoot });
        } catch (cleanupError) {
            cleanupErrors.push(describeError({ error: cleanupError }));
        }
        if (cleanupErrors.length > 0 && error instanceof Error) {
            const withContext = /** @type {Error & {context?: Record<string, unknown>}} */ (error);
            withContext.context = {
                ...(withContext.context ?? {}),
                cleanupError: cleanupErrors.join('; '),
                path
            };
        }
    }

    /**
     * Run `assertDirectoryTarget` then `assertRealPathInsideRoot` before any
     * creation, emitting `workspace:path_rejected` on a refusal.
     * @param {{workItemId: string|number, identifier?: string|null, key: string, path: string}} arg0 -
     * @returns {Promise<void>}
     */
    async assertTarget({ workItemId, identifier = null, key, path }) {
        try {
            await assertDirectoryTarget({ root: this.root, path });
            await assertRealPathInsideRoot({ root: this.root, path });
        } catch (error) {
            if (error instanceof WorkspaceError) {
                this.emitPathRejected({ workItemId, identifier, key, path, reason: error.reason ?? 'not_directory' });
            }
            throw error;
        }
    }

    /**
     * Re-check real-path containment after creation.
     * @param {{workItemId: string|number, identifier?: string|null, key: string, path: string}} arg0 -
     * @returns {Promise<void>}
     */
    async assertInsideRootAfterCreation({ workItemId, identifier = null, key, path }) {
        try {
            await assertRealPathInsideRoot({ root: this.root, path });
        } catch (error) {
            if (error instanceof WorkspaceError) {
                this.emitPathRejected({ workItemId, identifier, key, path, reason: error.reason ?? 'outside_root' });
            }
            throw error;
        }
    }

    /**
     * Delete a directory this call just created. A cleanup failure is attached
     * to the hook error as `context`; it never replaces it.
     * @param {{path: string, error: unknown}} arg0 -
     * @returns {Promise<void>}
     */
    async removeCreated({ path, error }) {
        try {
            await fs.rm(path, { recursive: true, force: true });
        } catch (cleanupError) {
            if (error instanceof Error) {
                const withContext = /** @type {Error & {context?: Record<string, unknown>}} */ (error);
                withContext.context = {
                    ...(withContext.context ?? {}),
                    cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                };
            }
        }
    }

    /**
     * Run `fn` after every earlier call for the same key, so two concurrent
     * calls cannot act on one workspace at once (create once, remove once).
     * In-process only; cross-process claims belong to the scheduler.
     * @template T
     * @param {{key: string, fn: () => Promise<T>}} arg0 -
     * @returns {Promise<T>}
     */
    serializeByKey({ key, fn }) {
        const previous = this.locks.get(key) ?? Promise.resolve();
        const run = previous.then(() => fn());
        /** @type {Promise<void>} */
        const settled = run.then(() => undefined, () => undefined);
        this.locks.set(key, settled);
        settled.then(() => {
            if (this.locks.get(key) === settled) this.locks.delete(key);
        });
        return run;
    }

    /**
     * @param {{workItemId: unknown, identifier?: unknown, key: unknown, path: unknown, reason: string}} arg0 -
     * @returns {void}
     */
    emitPathRejected({ workItemId, identifier = null, key, path, reason }) {
        const normalized = normalizeIdentifier({ value: identifier });
        emitWorkspaceEvent({
            eventEmitter: this.eventEmitter,
            name: EVENTS.WORKSPACE.PATH_REJECTED,
            payload: { workItemId, ...(normalized === null ? {} : { identifier: normalized }), key, path, reason }
        });
    }

    /**
     * @param {{workItemId: string|number, identifier?: string|null, key: string, path: string, reason: string}} arg0 -
     * @returns {void}
     */
    emitRemoveRefused({ workItemId, identifier = null, key, path, reason }) {
        const normalized = normalizeIdentifier({ value: identifier });
        emitWorkspaceEvent({
            eventEmitter: this.eventEmitter,
            name: EVENTS.WORKSPACE.REMOVE_REFUSED,
            payload: { workItemId, ...(normalized === null ? {} : { identifier: normalized }), key, path, reason }
        });
    }

    /**
     * Emit `workspace:path_rejected` and build the error to throw.
     * @param {{workItemId: unknown, identifier?: unknown, key: unknown, path: unknown, reason: string, message: string}} arg0 -
     * @returns {WorkspaceError}
     */
    pathRejection({ workItemId, identifier = null, key, path, reason, message }) {
        this.emitPathRejected({ workItemId, identifier, key, path, reason });
        return new WorkspaceError({
            message,
            options: {
                reason,
                workItemId: typeof workItemId === 'string' || typeof workItemId === 'number' ? workItemId : undefined,
                path: typeof path === 'string' ? path : undefined
            }
        });
    }

    /**
     * The one call shape every lifecycle hook uses.
     * @param {{hook: 'afterCreate'|'beforeRun'|'afterRun'|'beforeRemove', target: import('./hooks.mjs').WorkspaceHookTarget, signal?: AbortSignal|null}} arg0 -
     * @returns {Promise<void>}
     */
    async #runHook({ hook, target, signal = null }) {
        await runWorkspaceHook({
            hook,
            script: this.hooks[hook],
            workspace: target,
            timeoutMs: this.hooks.timeoutMs,
            env: this.hooks.env,
            signal,
            eventEmitter: this.eventEmitter
        });
    }

    /**
     * Record the owning item and whether `afterCreate` finished. A write that
     * cannot land is a `WorkspaceError` naming the key, never a raw fs error:
     * without the marker the next reuse cannot tell whose tree this is, and a
     * silently missing `ready` would re-run `afterCreate` forever. The
     * `ready: false` write happens before the hook, so a failure there can
     * leave the freshly created (empty) directory behind for the host to reap.
     * @param {{key: string, workItemId: string|number, ownerId: string, identifier: string|null, ready: boolean}} arg0 -
     * @returns {Promise<void>}
     */
    async #writeOwnerMarker({ key, workItemId, ownerId, identifier, ready }) {
        const filePath = ownerMarkerPath({ root: this.root, key });
        try {
            await writeJsonAtomic({ filePath, data: { ownerId, identifier, ready } });
        } catch (error) {
            throw new WorkspaceError({
                message: `Cannot record the owner marker for workspace '${key}'.`,
                options: { reason: 'owner_marker_failed', workItemId, path: filePath, cause: error }
            });
        }
    }

    /**
     * Drop the sibling marker after its directory is gone. Best-effort: a marker
     * that cannot be removed must not turn a completed removal into a failure.
     * @param {{key: string}} arg0 -
     * @returns {Promise<void>}
     */
    async #removeOwnerMarker({ key }) {
        await fs.rm(ownerMarkerPath({ root: this.root, key }), { force: true }).catch(() => {});
    }
}
