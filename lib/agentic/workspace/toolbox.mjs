// @ts-check


/**
 * @file Bind the built-in context, shell, and artifact tools to one workspace.
 * @version 0.12.0
 *
 * @description
 * `WorkspaceManager` decides where a work item lives; this binder decides which
 * tools may touch it. Every tool is constructed with the workspace path the
 * binder owns, never a caller value:
 *
 *   context  — `read`/`grep`/`glob` rooted at `workspace.path`; `read` and
 *              `grep` deny an outside path with `tool:path_denied`, while
 *              `glob` resolves only inside the root and returns no matches for
 *              a pattern that points outside
 *   shell    — `cwd` and `roots` set to `workspace.path`; a path operand outside
 *              it escalates to the approval callback
 *   artifacts— a save directory outside the workspace by default
 *
 * The default artifact directory is a **sibling** of the workspace
 * (`<root>/<key>.artifacts`) on purpose: the worktree stays clean, so
 * `git status` keeps meaning something, and the agent cannot read its own
 * artifacts through the context tools. The *host* reads the returned absolute
 * path with `fs`, which is the multi-agent pattern: pass references, not token
 * copies. A host that needs agent read-back passes
 * `artifactsDir: join(workspace.path, '.merci-artifacts')`; that directory is
 * inside the workspace and therefore readable, and it shows as untracked until
 * the host ignores it.
 *
 * Isolation here is a path invariant plus the existing approval gates, not an
 * OS sandbox: an approved shell command can still leave the workspace. The
 * binder never constructs a session; the host wires `withAutoContext()` and
 * `withTools()`.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { ConfigurationError } from '../../core/errors.mjs';
import { createContextTools } from '../../tools/context-tools.mjs';
import { createShellTool } from '../../tools/shell-tools.mjs';
import { normalizeApproval } from '../approval.mjs';
import { createSaveArtifactTool } from '../artifacts.mjs';
import { isInsideRoot, realpathAllowingMissingSync } from './paths.mjs';

/** The tool groups `include` accepts, in default order. @type {readonly string[]} */
const TOOL_GROUPS = Object.freeze(['context', 'shell', 'artifacts']);

/**
 * @param {{message: string, option: string, cause?: unknown}} arg0 -
 * @returns {ConfigurationError}
 */
const invalid = ({ message, option, cause }) => new ConfigurationError({ message, options: { option, cause } });

/**
 * Validate the handle before any tool is built. A missing, non-directory, or
 * symlinked path is refused, never followed; the path's real path must also be
 * inside the root's real path, so a symlinked parent cannot point the tools
 * elsewhere. `root` and `key` must be usable because the artifact directory is
 * derived from them.
 * @param {{workspace: import('./manager.mjs').WorkspaceHandleLike}} arg0 -
 * @returns {{path: string, root: string, key: string, realRoot: string}}
 */
function assertWorkspaceHandle({ workspace }) {
    const path = workspace?.path;
    if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) {
        throw invalid({ message: 'workspace.path must be a non-empty absolute path.', option: 'workspace.path' });
    }
    const root = workspace?.root;
    if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
        throw invalid({ message: 'workspace.root must be a non-empty absolute path.', option: 'workspace.root' });
    }
    const key = workspace?.key;
    if (typeof key !== 'string' || key.trim() === '') {
        throw invalid({ message: 'workspace.key must be a non-empty string.', option: 'workspace.key' });
    }
    /** @type {import('node:fs').Stats} */
    let stats;
    try {
        stats = lstatSync(path);
    } catch (cause) {
        throw invalid({ message: `Workspace path does not exist: ${path}`, option: 'workspace.path', cause });
    }
    if (stats.isSymbolicLink()) {
        throw invalid({ message: `Workspace path is a symlink: ${path}`, option: 'workspace.path' });
    }
    if (!stats.isDirectory()) {
        throw invalid({ message: `Workspace path is not a directory: ${path}`, option: 'workspace.path' });
    }
    /** @type {string} */
    let realRoot;
    try {
        realRoot = realpathSync(root);
    } catch (cause) {
        throw invalid({ message: `Workspace root does not exist: ${root}`, option: 'workspace.root', cause });
    }
    const realPath = realpathSync(path);
    if (!isInsideRoot({ root: realRoot, path: realPath })) {
        throw invalid({
            message: `Workspace path resolves outside workspace.root: ${realPath}`,
            option: 'workspace.path'
        });
    }
    return { path, root, key, realRoot };
}

/**
 * Normalize and validate `include`. An unknown name is refused instead of
 * silently returning a partial tool set.
 * @param {{include: unknown}} arg0 -
 * @returns {Set<string>}
 */
function normalizeInclude({ include }) {
    if (!Array.isArray(include)) {
        throw invalid({ message: `include must be an array of: ${TOOL_GROUPS.join(', ')}.`, option: 'include' });
    }
    /** @type {Set<string>} */
    const groups = new Set();
    for (const name of include) {
        if (typeof name !== 'string' || !TOOL_GROUPS.includes(name)) {
            throw invalid({
                message: `Unknown tool group in include: ${String(name)}. Use: ${TOOL_GROUPS.join(', ')}.`,
                option: 'include'
            });
        }
        groups.add(name);
    }
    return groups;
}

/**
 * Resolve the artifact directory and prove it is inside the workspace root.
 *
 * A relative caller value resolves against `workspace.root`, never against
 * `process.cwd()`, so the same config means the same directory on every host.
 * A symlinked directory inside the root is refused when its real path leaves
 * the root's real path, so a save cannot physically land outside. The
 * directory is created lazily by the tool on the first save.
 * @param {{workspace: {root: string, key: string, realRoot: string}, artifactsDir: unknown}} arg0 -
 * @returns {string}
 */
function resolveArtifactsDir({ workspace, artifactsDir }) {
    if (artifactsDir !== null && artifactsDir !== undefined && typeof artifactsDir !== 'string') {
        throw invalid({ message: 'artifactsDir must be a string when given.', option: 'artifactsDir' });
    }
    if (typeof artifactsDir === 'string' && artifactsDir.trim() === '') {
        throw invalid({ message: 'artifactsDir must not be empty.', option: 'artifactsDir' });
    }
    const raw = typeof artifactsDir === 'string'
        ? (isAbsolute(artifactsDir) ? artifactsDir : resolve(workspace.root, artifactsDir))
        : join(workspace.root, `${workspace.key}.artifacts`);
    const dir = resolve(raw);
    if (!isAbsolute(dir) || !isInsideRoot({ root: workspace.root, path: dir })) {
        throw invalid({
            message: `Artifact directory must be inside the workspace root: ${dir}`,
            option: 'artifactsDir'
        });
    }
    const realDir = realpathAllowingMissingSync({ target: dir });
    if (!isInsideRoot({ root: workspace.realRoot, path: realDir })) {
        throw invalid({
            message: `Artifact directory resolves outside the workspace root: ${realDir}`,
            option: 'artifactsDir'
        });
    }
    return dir;
}


/**
 * Bind `read`/`grep`/`glob`, the shell tool, and the artifact tool to one
 * workspace handle. Omitted groups are `null`; no session is created.
 *
 * @param {{
 *   workspace: import('./manager.mjs').WorkspaceHandleLike,
 *   approvalCallback?: Function|{callback: Function, timeoutMs?: number}|{fn: Function, options?: {timeoutMs?: number}}|null,
 *   eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null,
 *   include?: Array<string>,
 *   artifactsDir?: string|null,
 *   context?: Record<string, unknown>,
 *   shell?: Record<string, unknown>,
 *   permissionMode?: import('../permissions.mjs').PermissionMode
 * }} arg0 -
 * @returns {{
 *   workspace: import('./manager.mjs').WorkspaceHandleLike,
 *   root: string,
 *   contextTools: Array<import('../../tools/tool-execution.mjs').ReadyTool>|null,
 *   shellTool: import('../../tools/tool-execution.mjs').ReadyTool|null,
 *   artifactTool: import('../artifacts.mjs').SaveArtifactTool|null
 * }} The bound tools; omitted groups are `null`.
 * @throws {ConfigurationError} When the workspace, `include`, the approval callback, or the artifact directory is invalid.
 */
export function createWorkspaceTools({
    workspace,
    approvalCallback = null,
    eventEmitter = null,
    include = ['context', 'shell', 'artifacts'],
    artifactsDir = null,
    context = {},
    shell = {},
    permissionMode = 'default'
}) {
    const target = assertWorkspaceHandle({ workspace });
    const groups = normalizeInclude({ include });

    // Unconditional: the workspace path is the boundary whether or not the
    // context group is built, so a config that widens it is always refused.
    if (context?.allowOutsideRoot === true) {
        throw invalid({
            message: 'createWorkspaceTools rejects context.allowOutsideRoot: the workspace path is the boundary.',
            option: 'context.allowOutsideRoot'
        });
    }

    /** @type {Array<import('../../tools/tool-execution.mjs').ReadyTool>|null} */
    let contextTools = null;
    if (groups.has('context')) {
        contextTools = createContextTools({ options: { ...context, root: target.path, eventEmitter } });
    }

    /** @type {import('../../tools/tool-execution.mjs').ReadyTool|null} */
    let shellTool = null;
    if (groups.has('shell')) {
        /** @type {Function|null} */
        let callback = null;
        try {
            callback = normalizeApproval({ value: approvalCallback, origin: 'createWorkspaceTools' })?.callback ?? null;
        } catch {
            // Any unusable shape fails closed with the existing approvalCallback error.
            callback = null;
        }
        if (callback === null && permissionMode !== 'bypassPermissions') {
            throw invalid({
                message: "Shell tools require an 'approvalCallback' function; outside-root operands are gated, not allowed.",
                option: 'approvalCallback'
            });
        }
        shellTool = createShellTool({
            options: {
                ...shell,
                cwd: target.path,
                roots: [target.path],
                ...(callback === null ? {} : { approvalCallback: callback }),
                eventEmitter,
                permissionMode
            }
        });
    }

    /** @type {import('../artifacts.mjs').SaveArtifactTool|null} */
    let artifactTool = null;
    if (groups.has('artifacts')) {
        const dir = resolveArtifactsDir({ workspace: target, artifactsDir });
        artifactTool = createSaveArtifactTool({ dir, eventEmitter });
    }

    return { workspace, root: target.path, contextTools, shellTool, artifactTool };
}
