// @ts-check


/**
 * @file Workspace path containment: the root resolver and the guards that keep
 * every workspace path inside it.
 * @version 0.12.0
 *
 * @description
 * Isolation is a path invariant, not an OS sandbox: a workspace path must
 * resolve inside the configured root even when a sibling has a shared prefix
 * (`/root2`), a target is a symlink, an intermediate component is a symlink
 * that points away, the target is a file, or the target does not exist yet but
 * its nearest existing ancestor links away. The checks are split so the manager
 * can run the cheap string check before any IO and the real-path check after
 * creation.
 *
 * The string prefix is always `root + sep`, never a bare prefix.
 */
import { promises as fs, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { ConfigurationError, WorkspaceError } from '../../core/errors.mjs';
import { isInsideRoot } from '../../support/path-safety.mjs';

export { isInsideRoot };

/**
 * Validate a root option and normalize it to an absolute path.
 * @param {{root: unknown}} arg0 -
 * @returns {string}
 */
export const normalizeRoot = ({ root }) => {
    if (typeof root !== 'string' || root.trim() === '') {
        throw new ConfigurationError({ message: 'root must be a non-empty string.', options: { option: 'root' } });
    }
    return resolve(root);
};

/**
 * Validate a path option that must already be absolute. A relative path would
 * resolve against `process.cwd()`, not against the root, so it is refused
 * instead of guessed.
 * @param {{path: string}} arg0 -
 * @returns {string}
 */
const normalizeAbsolute = ({ path }) => {
    if (typeof path !== 'string' || path.trim() === '') {
        throw new ConfigurationError({ message: 'path must be a non-empty string.', options: { option: 'path' } });
    }
    if (!isAbsolute(path)) {
        throw new ConfigurationError({
            message: `path must be absolute: ${path}`,
            options: { option: 'path' }
        });
    }
    return resolve(path);
};

/**
 * `lstat` where a missing path, or a path whose parent component is not a
 * directory, is simply absent instead of an error.
 * @param {{path: string}} arg0 -
 * @returns {Promise<import('node:fs').Stats|null>}
 */
export const lstatOrNull = async ({ path }) => {
    try {
        return await fs.lstat(path);
    } catch (error) {
        const code = /** @type {{code?: string}} */ (error).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
    }
};

/**
 * `realpath` under the same absent-is-null rule as `lstatOrNull`.
 * @param {{path: string}} arg0 -
 * @returns {Promise<string|null>}
 */
export const realpathOrNull = async ({ path }) => {
    try {
        return await fs.realpath(path);
    } catch (error) {
        const code = /** @type {{code?: string}} */ (error).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
    }
};

/**
 * The one `outside_root` rejection, so every caller reports the same reason.
 * @param {{path: string}} arg0 -
 * @returns {WorkspaceError}
 */
const outsideRoot = ({ path }) => new WorkspaceError({
    message: `Workspace path escapes the root: ${path}`,
    options: { reason: 'outside_root', path }
});

/**
 * Real path of a target whose trailing components may not exist yet: realpath
 * the nearest existing ancestor and append the missing components.
 *
 * A plain `realpath` on a not-yet-created workspace either fails or, worse,
 * tells a caller nothing, so a parent symlink that leaves the root would only
 * be caught after the directory was created outside.
 *
 * @param {{target: string}} arg0 - An absolute path.
 * @returns {Promise<string>}
 *
 * Internal helper (not part of the `workspace` barrel): the manager uses it to
 * compare a missing handle path and its derived path through the nearest
 * existing ancestor's realpath, so a promoted root's spelling change does not
 * look like an escape.
 */
export const realpathAllowingMissing = async ({ target }) => {
    /** @type {string[]} */
    const missing = [];
    let current = target;
    while (true) {
        try {
            const real = await fs.realpath(current);
            return missing.length > 0 ? join(real, ...missing) : real;
        } catch (error) {
            if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') throw error;
            const parent = dirname(current);
            // Nothing exists above this point; the absolute path is all there is to compare.
            if (parent === current) return target;
            missing.unshift(basename(current));
            current = parent;
        }
    }
};

/**
 * Synchronous twin of `realpathAllowingMissing` for callers that must return
 * without yielding — the tool binder validates a workspace before it hands
 * back the tools, and it resolves a not-yet-created artifact directory through
 * its nearest existing ancestor.
 *
 * Same algorithm, same answer: the realpath of the nearest existing ancestor
 * with the missing components appended.
 *
 * @param {{target: string}} arg0 - An absolute path.
 * @returns {string}
 */
export const realpathAllowingMissingSync = ({ target }) => {
    /** @type {string[]} */
    const missing = [];
    let current = target;
    while (true) {
        try {
            const real = realpathSync(current);
            return missing.length > 0 ? join(real, ...missing) : real;
        } catch (error) {
            if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') throw error;
            const parent = dirname(current);
            // Nothing exists above this point; the absolute path is all there is to compare.
            if (parent === current) return target;
            missing.unshift(basename(current));
            current = parent;
        }
    }
};

/**
 * Create the workspace root when missing and return its real path.
 *
 * The returned real path is the identity every later check compares against, so
 * a configured root that is itself a symlink works and `workspace.root` is
 * always the physical directory. The filesystem-root check runs again on the
 * real path: a symlink that resolves to `/` would otherwise hide that a
 * workspace root of `/` makes containment meaningless.
 *
 * @param {{root: string, allowFilesystemRoot?: boolean}} arg0 -
 * @returns {Promise<string>} The real path of the root.
 * @throws {ConfigurationError} When the root is invalid, cannot be created, is not a directory, or is the filesystem root without opt-in.
 */
export async function resolveWorkspaceRoot({ root, allowFilesystemRoot = false }) {
    const base = normalizeRoot({ root });
    if (!allowFilesystemRoot && base === parse(base).root) {
        throw new ConfigurationError({
            message: `Refusing the filesystem root as a workspace root: ${base}`,
            options: { option: 'root' }
        });
    }
    try {
        await fs.mkdir(base, { recursive: true });
    } catch (error) {
        throw new ConfigurationError({
            message: `Cannot create the workspace root: ${base}`,
            options: { option: 'root', cause: error }
        });
    }
    const real = await fs.realpath(base);
    if (!allowFilesystemRoot && real === parse(real).root) {
        throw new ConfigurationError({
            message: `Refusing a workspace root that resolves to the filesystem root: ${real}`,
            options: { option: 'root' }
        });
    }
    const stats = await fs.stat(real);
    if (!stats.isDirectory()) {
        throw new ConfigurationError({
            message: `Workspace root is not a directory: ${real}`,
            options: { option: 'root' }
        });
    }
    return real;
}

/**
 * Resolve one workspace path under a root and assert containment, without IO.
 * @param {{root: string, key: string}} arg0 -
 * @returns {string} The absolute workspace path.
 * @throws {ConfigurationError} When `root` or `key` is invalid.
 * @throws {WorkspaceError} `outside_root` when the key escapes the root.
 */
export function resolveWorkspacePath({ root, key }) {
    const base = normalizeRoot({ root });
    if (typeof key !== 'string' || key.trim() === '') {
        throw new ConfigurationError({ message: 'key must be a non-empty string.', options: { option: 'key' } });
    }
    const target = resolve(base, key);
    if (!isInsideRoot({ root: base, path: target })) throw outsideRoot({ path: target });
    return target;
}

/**
 * Check the target before creation: it must be inside the root and, when it
 * exists, a real directory. A symlink is rejected, never followed, and a
 * non-directory is rejected, never deleted. A missing target is the normal
 * "create it" case and is not an error — but its nearest existing ancestor is
 * still resolved, so a missing target under a parent symlink that leaves the
 * root is refused before anything is created there.
 *
 * `path` must be absolute; a relative path is a `ConfigurationError`, because it
 * would otherwise resolve against the caller's working directory.
 *
 * @param {{root: string, path: string}} arg0 -
 * @returns {Promise<void>}
 * @throws {ConfigurationError} When `root` or `path` is invalid or `path` is relative.
 * @throws {WorkspaceError} `outside_root`, `symlink`, or `not_directory`.
 */
export async function assertDirectoryTarget({ root, path }) {
    const base = normalizeRoot({ root });
    const target = normalizeAbsolute({ path });
    if (!isInsideRoot({ root: base, path: target })) throw outsideRoot({ path: target });

    let stats = null;
    try {
        stats = await fs.lstat(target);
    } catch (error) {
        const code = /** @type {{code?: string}} */ (error).code;
        if (code === 'ENOTDIR') {
            throw new WorkspaceError({
                message: `Workspace target is not a directory: ${target}`,
                options: { reason: 'not_directory', path: target }
            });
        }
        if (code !== 'ENOENT') throw error;
    }
    if (stats && stats.isSymbolicLink()) {
        throw new WorkspaceError({
            message: `Workspace target is a symlink: ${target}`,
            options: { reason: 'symlink', path: target }
        });
    }
    if (stats && !stats.isDirectory()) {
        throw new WorkspaceError({
            message: `Workspace target is not a directory: ${target}`,
            options: { reason: 'not_directory', path: target }
        });
    }

    const realRoot = await realpathAllowingMissing({ target: base });
    const realTarget = await realpathAllowingMissing({ target });
    if (!isInsideRoot({ root: realRoot, path: realTarget })) throw outsideRoot({ path: realTarget });
}

/**
 * Assert the target's real path is still inside the root.
 *
 * This closes the symlinked-parent escape: a target whose final component is a
 * plain directory can still live outside the root when an intermediate
 * component links away. A missing target is resolved through its nearest
 * existing ancestor, so a path that does not exist yet is checked too rather
 * than skipped.
 *
 * `path` must be absolute; a relative path is a `ConfigurationError`, because it
 * would otherwise resolve against the caller's working directory.
 *
 * @param {{root: string, path: string}} arg0 -
 * @returns {Promise<void>}
 * @throws {ConfigurationError} When `root` or `path` is invalid or `path` is relative.
 * @throws {WorkspaceError} `outside_root`.
 */
export async function assertRealPathInsideRoot({ root, path }) {
    const base = normalizeRoot({ root });
    const target = normalizeAbsolute({ path });
    const realRoot = await realpathAllowingMissing({ target: base });
    const realTarget = await realpathAllowingMissing({ target });
    if (!isInsideRoot({ root: realRoot, path: realTarget })) throw outsideRoot({ path: realTarget });
}
