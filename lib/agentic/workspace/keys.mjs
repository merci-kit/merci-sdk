// @ts-check


/**
 * @file Deterministic workspace keys for per-item workspace directories.
 * @version 0.12.0
 *
 * @description
 * One workspace per work item, named by a key a caller can derive again
 * without IO. The sanitized id is only a readable prefix; a 64-bit sha256
 * suffix disambiguates ids that sanitize to the same text (`a/b` vs `a b`),
 * case-only differences (`Foo` vs `foo`, which collide on a case-insensitive
 * host), and long ids that share a prefix past the truncation point.
 */
import { createHash } from 'node:crypto';

import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';

/** Prefix used when sanitization leaves nothing usable; the hash still disambiguates. */
const FALLBACK_PREFIX = 'item';

/**
 * Derive the workspace directory name for a work item id.
 *
 * Deterministic: the same id always yields the same key, on any host. Always
 * hashed: the suffix is present even when the id needs no sanitization, so a
 * case-insensitive filesystem and a sanitization collision cannot merge two
 * items into one workspace.
 *
 * @param {{workItemId: string|number}} arg0 - Stable external work-item id.
 * @returns {string} `${sanitized}-${hash}`.
 * @throws {ConfigurationError} When the id is not a string/number or is empty, `.` or `..`.
 */
export function workspaceKeyFor({ workItemId }) {
    if (typeof workItemId !== 'string' && typeof workItemId !== 'number') {
        throw new ConfigurationError({
            message: `workItemId must be a string or number, got ${workItemId === null ? 'null' : typeof workItemId}.`,
            options: { option: 'workItemId' }
        });
    }
    if (typeof workItemId === 'number' && !Number.isFinite(workItemId)) {
        throw new ConfigurationError({
            message: `workItemId must be a finite number, got ${String(workItemId)}.`,
            options: { option: 'workItemId' }
        });
    }
    // NFC first: the precomposed and decomposed forms of one name must not split
    // into two workspaces.
    const normalized = String(workItemId).trim().normalize('NFC');
    if (normalized === '' || normalized === '.' || normalized === '..') {
        throw new ConfigurationError({
            message: 'workItemId must be a non-empty identifier.',
            options: { option: 'workItemId' }
        });
    }
    const rawPrefix = normalized.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, LIMITS.workspace_key_prefix_chars);
    const prefix = rawPrefix === '' || rawPrefix === '.' || rawPrefix === '..' ? FALLBACK_PREFIX : rawPrefix;
    const hash = createHash('sha256').update(normalized).digest('hex').slice(0, LIMITS.workspace_key_hash_chars);
    return `${prefix}-${hash}`;
}
