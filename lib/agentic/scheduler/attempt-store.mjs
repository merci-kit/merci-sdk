// @ts-check


/**
 * @file Attempt stores: the counters and park state a restart must not lose.
 * @version 0.12.0
 *
 * @description
 * The scheduler's `#attempts`, `#continuations`, and `#parked` maps are
 * process-local, and `stop()` releases the claims of queued and parked items,
 * so the claim file cannot carry a park across a restart. This store persists
 * exactly those three facts per identifier. A queued retry is deliberately not
 * persisted: it is transient, and a crash mid-retry re-queues the item at the
 * same failure count, which is what `attempts` records.
 *
 * `inFlight` is the one exception: the marker an attempt writes before it
 * starts. A process that dies mid-attempt leaves it behind, and the next start
 * counts it as one consumed attempt, so a crash cannot reset the retry budget.
 *
 * `createMemoryAttemptStore()` is the default and dies with the process;
 * `createFileAttemptStore({ dir })` is one JSON file per identifier at
 * `<dir>/<slug>.<hash>.json`. The hash suffix is what keeps two identifiers
 * that slug to the same stem in separate files. One directory belongs to one
 * scheduler process; two schedulers over it are uncoordinated. Writes go
 * through `writeJsonAtomic`; reads go through `readStoredJson` with the version
 * guard, so a corrupt record is rejected, never healed. A corrupt, unreadable,
 * or wrong-version record is skipped with a warning and reads as absent; the
 * next start then begins that item at attempt 0. `id` is the source record id,
 * so a re-created identifier is not mistaken for the old work item.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { readStoredJson, writeJsonAtomic } from '../../support/fs-store.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { assertNonEmptyString } from '../../support/validation.mjs';

/** The record format discriminator. */
export const ATTEMPT_RECORD_VERSION = 1;

/**
 * One parked row, as persisted. `at` is when the item parked; `nextCheckAt` is
 * the due time the parked re-check must respect after a restart.
 * @typedef {Object} AttemptParked
 * @property {string} reason
 * @property {number} at
 * @property {number} nextCheckAt
 */

/**
 * The crash marker: an attempt that started and never settled. A leftover on
 * load is one failure the crash consumed.
 * @typedef {Object} AttemptInFlight
 * @property {string} attemptId
 * @property {number} startedAt
 */

/**
 * The on-disk record. `version` is the store's format discriminator; `id` is
 * the source record id, so a re-created identifier is not mistaken for the old
 * work item. `inFlight` is absent (or null) when no attempt is in flight.
 * @typedef {Object} AttemptRecord
 * @property {1} version
 * @property {string} identifier
 * @property {string} id
 * @property {number} attempts
 * @property {number} continuations
 * @property {AttemptParked|null} parked
 * @property {AttemptInFlight|null} [inFlight]
 * @property {number} updatedAt
 */

/**
 * The persisted-state seam the scheduler hydrates from at `start()`.
 * @typedef {Object} AttemptStore
 * @property {(arg0: {identifier: string}) => Promise<AttemptRecord|null>} load
 * @property {(arg0: {record: AttemptRecord}) => Promise<void>} save
 * @property {(arg0: {identifier: string}) => Promise<void>} clear
 * @property {() => Promise<AttemptRecord[]>} list
 */

/**
 * @param {{identifier: unknown}} arg0 -
 * @returns {void}
 * @throws {ConfigurationError} When `identifier` is not a non-empty string.
 */
function assertIdentifier({ identifier }) {
    assertNonEmptyString({ value: identifier, name: 'identifier' });
}

/**
 * The single shape every write and every accepted read goes through.
 * @param {{value: unknown, identifier?: string|null}} arg0 -
 * @returns {boolean}
 */
function isAttemptRecord({ value, identifier = null }) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.version !== ATTEMPT_RECORD_VERSION) return false;
    if (typeof record.identifier !== 'string') return false;
    if (identifier !== null && record.identifier !== identifier) return false;
    if (typeof record.id !== 'string' || record.id.trim() === '') return false;
    if (!Number.isInteger(record.attempts) || /** @type {number} */ (record.attempts) < 0) return false;
    if (!Number.isInteger(record.continuations) || /** @type {number} */ (record.continuations) < 0) return false;
    if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return false;
    if (record.parked !== null) {
        if (typeof record.parked !== 'object' || Array.isArray(record.parked)) return false;
        const parked = /** @type {Record<string, unknown>} */ (record.parked);
        if (!(typeof parked.reason === 'string'
            && typeof parked.at === 'number' && Number.isFinite(parked.at)
            && typeof parked.nextCheckAt === 'number' && Number.isFinite(parked.nextCheckAt))) return false;
    }
    // Optional: a record written before the marker existed, or a settle that
    // cleared it, omits the key. A present marker must be complete.
    if (record.inFlight === undefined || record.inFlight === null) return true;
    if (typeof record.inFlight !== 'object' || Array.isArray(record.inFlight)) return false;
    const inFlight = /** @type {Record<string, unknown>} */ (record.inFlight);
    return typeof inFlight.attemptId === 'string' && inFlight.attemptId !== ''
        && typeof inFlight.startedAt === 'number' && Number.isFinite(inFlight.startedAt);
}

/**
 * @param {{record: AttemptRecord}} arg0 -
 * @returns {AttemptRecord}
 */
function copyRecord({ record }) {
    const parked = record.parked;
    const inFlight = record.inFlight ?? null;
    return {
        version: ATTEMPT_RECORD_VERSION,
        identifier: record.identifier,
        id: record.id,
        attempts: record.attempts,
        continuations: record.continuations,
        parked: parked ? { ...parked } : null,
        inFlight: inFlight ? { ...inFlight } : null,
        updatedAt: record.updatedAt
    };
}

/**
 * A path-safe stem plus a hash of the full identifier. Two different
 * identifiers can share the stem; only the hash decides the file.
 * @param {{dir: string, identifier: string}} arg0 -
 * @returns {string}
 */
function fileFor({ dir, identifier }) {
    const slug = identifier
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+/, '')
        .slice(0, LIMITS.attempt_slug_chars) || 'item';
    const suffix = createHash('sha256').update(identifier).digest('hex').slice(0, LIMITS.attempt_hash_chars);
    return join(dir, `${slug}.${suffix}.json`);
}

/**
 * In-process attempt store. The default; nothing survives the process.
 * @returns {AttemptStore}
 */
export function createMemoryAttemptStore() {
    /** @type {Map<string, AttemptRecord>} */
    const records = new Map();
    return {
        async load({ identifier }) {
            assertIdentifier({ identifier });
            const record = records.get(identifier);
            return record === undefined ? null : copyRecord({ record });
        },
        async save({ record }) {
            assertIdentifier({ identifier: record.identifier });
            records.set(record.identifier, copyRecord({ record }));
        },
        async clear({ identifier }) {
            assertIdentifier({ identifier });
            records.delete(identifier);
        },
        async list() {
            return [...records.values()].map((record) => copyRecord({ record }));
        }
    };
}

/**
 * File-backed attempt store: one `<slug>.<hash>.json` per identifier.
 * @param {{dir?: unknown}} [arg0] -
 * @returns {AttemptStore}
 * @throws {ConfigurationError} When `dir` is not a non-empty string.
 */
export function createFileAttemptStore({ dir } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
        throw new ConfigurationError({ message: 'dir must be a non-empty string.', options: { option: 'dir' } });
    }

    /**
     * A missing file is null; anything corrupt or unreadable is a warning and
     * null, because a lost record must degrade to a fresh attempt count rather
     * than fail the restart.
     * @param {{filePath: string, identifier?: string|null}} arg0 -
     * @returns {Promise<AttemptRecord|null>}
     */
    async function readRecord({ filePath, identifier = null }) {
        let stored;
        try {
            stored = await readStoredJson({ filePath, version: ATTEMPT_RECORD_VERSION });
        } catch {
            sdkWarn({ prefix: 'AttemptStore', args: [`Attempt record '${filePath}' could not be read; starting without it.`] });
            return null;
        }
        if (stored.status === 'missing') return null;
        if (stored.status !== 'ok' || !isAttemptRecord({ value: stored.value, identifier })) {
            sdkWarn({ prefix: 'AttemptStore', args: [`Attempt record '${filePath}' is unreadable; starting without it.`] });
            return null;
        }
        return /** @type {AttemptRecord} */ (stored.value);
    }

    return {
        async load({ identifier }) {
            assertIdentifier({ identifier });
            return readRecord({ filePath: fileFor({ dir, identifier }), identifier });
        },
        async save({ record }) {
            assertIdentifier({ identifier: record.identifier });
            // `save` is the format owner: the version is stamped, never trusted.
            await writeJsonAtomic({ filePath: fileFor({ dir, identifier: record.identifier }), data: copyRecord({ record }) });
        },
        async clear({ identifier }) {
            assertIdentifier({ identifier });
            try {
                await fs.unlink(fileFor({ dir, identifier }));
            } catch (error) {
                if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
            }
        },
        async list() {
            /** @type {string[]} */
            let names;
            try {
                names = await fs.readdir(dir);
            } catch (error) {
                if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
                throw error;
            }
            /** @type {AttemptRecord[]} */
            const records = [];
            for (const name of names) {
                if (!name.endsWith('.json')) continue;
                const filePath = join(dir, name);
                const record = await readRecord({ filePath });
                if (record === null) continue;
                if (fileFor({ dir, identifier: record.identifier }) !== filePath) {
                    sdkWarn({ prefix: 'AttemptStore', args: [`Attempt record '${filePath}' does not match its file name; skipping.`] });
                    continue;
                }
                records.push(record);
            }
            return records;
        }
    };
}
