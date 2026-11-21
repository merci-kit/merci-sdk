// @ts-check


/**
 * @file Read-only JSON directory work source.
 * @version 0.12.0
 *
 * @description
 * One item per `*.json` file, and **the file stem is the item id**
 * (`MER-1.json` must contain `id: 'MER-1'`). The stem is therefore the only
 * key: a refresh is a direct `<id>.json` read, and a file that is missing is
 * exactly "no longer visible". A record whose id differs from its stem is
 * malformed (`id_filename_mismatch` on the list path, a throw on refresh),
 * because otherwise two keys would drift apart.
 *
 * Requested ids are trimmed before the stem lookup, the same normalization
 * `normalizeWorkItem` applies to a record id, so `' MER-1 '` and `'MER-1'` name
 * the same file and dedupe as one id. An unsafe stem is refused on both paths
 * (`unsafe_id` / omission) after that trim, before any IO.
 *
 * Cancellation is cooperative: `signal` is checked at entry, after `stat`,
 * after `readdir`, and after every file read. An aborted signal throws
 * `AbortedError` unchanged; it is never a `WorkSourceError`.
 *
 * The adapter never writes, locks, or creates the directory: it is a viewer for
 * a board another process owns. Non-JSON entries are ignored, including a
 * subdirectory whose name happens to end in `.json` (reading it is EISDIR, and
 * it is skipped like any unreadable record).
 *
 * Durability caveat: a writer must publish each file atomically (write a
 * `.tmp`, rename it), or a poll can read a truncated file. A torn read is
 * skipped on the list path and throws on refresh; it is never repaired.
 *
 * Files are read through `support/fs-store.mjs` (`readStoredJson`), the repo's
 * durable-JSON primitive. The LLM structured-output parser in
 * `support/json.mjs` is deliberately not used: it repairs near-valid JSON by
 * default, and a corrupt board file must be rejected, not healed.
 *
 * Error causes: a read failure (`EACCES`, `EISDIR`, ...) attaches the original
 * error because it names the path only. A corrupt file attaches no cause: the
 * primitive's `reason` carries the parser message, which quotes content, so it
 * is never attached or logged. The id/stem mismatch has no underlying error
 * and its detail carries no content.
 */
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AbortedError, ConfigurationError, WorkSourceError } from '../../../core/errors.mjs';
import { readStoredJson } from '../../../support/fs-store.mjs';
import { isActiveState } from '../normalize.mjs';
import {
    emitSkippedRecord,
    normalizeListRecord,
    normalizeRequestedRecord
} from './records.mjs';

/** @typedef {import('../normalize.mjs').WorkItem} WorkItem */
/** @typedef {import('./records.mjs').WorkSourceEmitter} WorkSourceEmitter */

/** Only files with this suffix are candidates. */
const ITEM_FILE_RE = /\.json$/;

/**
 * A refresh failure. The message names the file and never a field value. Pass
 * `cause` only when its text cannot quote the file content: a read error does
 * not, a `JSON.parse` error does.
 * @param {{file: string, cause?: unknown, detail?: string}} arg0 -
 * @returns {WorkSourceError}
 */
function unreadable({ file, cause, detail = 'could not be read' }) {
    return new WorkSourceError({
        message: `work item file "${file}" in the json work source ${detail}`,
        options: { category: 'tracker_response', source: 'json', cause }
    });
}

/**
 * Whether an id can name a file directly under `dir`. A separator, a NUL, the
 * dot entries, or a resolved path that escapes `dir` is refused before any IO.
 * @param {{dir: string, id: string}} arg0 -
 * @returns {boolean}
 */
function isSafeId({ dir, id }) {
    if (typeof id !== 'string' || id === '' || id === '.' || id === '..') return false;
    if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false;
    const target = resolve(dir, `${id}.json`);
    const rel = relative(dir, target);
    // Refuse only the real parent entry (`..`) and anything below it; a legal
    // name that merely starts with dots (`..backlog.json`) stays contained.
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/**
 * Whether a parsed record's id matches the file stem. A record with no readable
 * string id is left to the normalizer, which reports it as malformed.
 * @param {{value: unknown, stem: string}} arg0 -
 * @returns {boolean}
 */
function idMatchesStem({ value, stem }) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
    const id = /** @type {Record<string, unknown>} */ (value).id;
    return typeof id !== 'string' || id.trim() === stem;
}

/**
 * Throw when the caller's signal has fired, after an awaited filesystem step.
 * `AbortedError` is not a `WorkSourceError` and is never wrapped as one.
 * @param {{signal?: AbortSignal}} arg0 -
 * @returns {void}
 * @throws {AbortedError} When `signal` is aborted.
 */
function throwIfAborted({ signal }) {
    if (signal?.aborted) {
        throw new AbortedError({ message: 'the json work source read was aborted', options: { cause: signal.reason } });
    }
}

/**
 * Fail a refresh when the board directory itself is gone or is no longer a
 * directory. Without this check every requested file looks missing, so an
 * unmounted board would read as "everything is no longer visible".
 * @param {{root: string, signal?: AbortSignal}} arg0 -
 * @returns {Promise<void>}
 * @throws {WorkSourceError} `tracker_request` when the directory cannot be read.
 * @throws {AbortedError} When `signal` is aborted after `stat`.
 */
async function requireReadableDirectory({ root, signal }) {
    let stats;
    try {
        stats = await stat(root);
    } catch (error) {
        throw new WorkSourceError({
            message: 'the json work source directory could not be read',
            options: { category: 'tracker_request', source: 'json', cause: error }
        });
    }
    throwIfAborted({ signal });
    if (!stats.isDirectory()) {
        throw new WorkSourceError({
            message: 'the json work source path is no longer a directory',
            options: { category: 'tracker_request', source: 'json' }
        });
    }
}

/**
 * Create a read-only work source over a directory of `*.json` files.
 * @param {{dir: unknown, eventEmitter?: WorkSourceEmitter|null}} arg0 -
 * @returns {Promise<{
 *   fetchByStates: (arg0: { states: unknown, signal?: AbortSignal }) => Promise<ReadonlyArray<WorkItem>>,
 *   fetchByIds: (arg0: { ids: unknown, signal?: AbortSignal }) => Promise<ReadonlyArray<WorkItem>>
 * }>}
 * @throws {ConfigurationError} When `dir` is not an existing directory.
 */
export async function createJsonFileWorkSource({ dir, eventEmitter = null }) {
    if (typeof dir !== 'string' || dir.trim() === '') {
        throw new ConfigurationError({ message: 'createJsonFileWorkSource requires a directory path.', options: { option: 'dir' } });
    }
    const root = resolve(dir);
    let stats;
    try {
        stats = await stat(root);
    } catch (error) {
        // Fail at construction, never at tick time: a typo in the path is a
        // configuration error, not a board that briefly went away.
        throw new ConfigurationError({ message: `The json work source directory does not exist: ${root}`, options: { option: 'dir', cause: error } });
    }
    if (!stats.isDirectory()) {
        throw new ConfigurationError({ message: `The json work source path is not a directory: ${root}`, options: { option: 'dir' } });
    }

    return {
        /**
         * @param {{states: unknown, signal?: AbortSignal}} arg0 -
         * @returns {Promise<ReadonlyArray<WorkItem>>}
         * @throws {WorkSourceError} When the directory itself cannot be listed.
         * @throws {AbortedError} When `signal` is aborted before or during the listing.
         */
        async fetchByStates({ states, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(states) || states.length === 0) return [];
            let names;
            try {
                names = await readdir(root);
            } catch (error) {
                throw new WorkSourceError({
                    message: 'the json work source directory could not be listed',
                    options: { category: 'tracker_request', source: 'json', cause: error }
                });
            }
            throwIfAborted({ signal });
            // Sorted for a deterministic order and a stable event `index`
            // (the position within this candidate list). This is the documented
            // determinism guarantee, not a behavior a test can distinguish,
            // because `readdir` is already name-ordered on this runtime.
            const files = names.filter((name) => ITEM_FILE_RE.test(name)).sort();
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            for (let index = 0; index < files.length; index += 1) {
                const file = files[index];
                const stem = file.slice(0, -'.json'.length);
                // A stem the refresh path would refuse can never be requested,
                // so listing it would emit an item that can only go stale.
                if (!isSafeId({ dir: root, id: stem })) {
                    emitSkippedRecord({ eventEmitter, source: 'json', index, file, reason: 'unsafe_id' });
                    continue;
                }
                let stored;
                try {
                    stored = await readStoredJson({ filePath: join(root, file) });
                } catch {
                    // EISDIR, EACCES, ENAMETOOLONG: the file is unusable this
                    // tick.
                    emitSkippedRecord({ eventEmitter, source: 'json', index, file, reason: 'malformed' });
                    continue;
                }
                // An abort wins over a corrupt or missing outcome below.
                throwIfAborted({ signal });
                // `missing` (deleted between readdir and read) and `corrupt`
                // are both skips; the primitive's `reason` is never used.
                if (stored.status !== 'ok') {
                    emitSkippedRecord({ eventEmitter, source: 'json', index, file, reason: 'malformed' });
                    continue;
                }
                const parsed = stored.value;
                if (!idMatchesStem({ value: parsed, stem })) {
                    emitSkippedRecord({ eventEmitter, source: 'json', index, file, reason: 'id_filename_mismatch' });
                    continue;
                }
                const item = normalizeListRecord({ raw: parsed, source: 'json', index, file, eventEmitter });
                if (item && isActiveState({ state: item.state, states })) out.push(item);
            }
            return out;
        },

        /**
         * Requested ids are trimmed before the stem lookup and deduped as a
         * set, matching the id `normalizeWorkItem` would produce.
         * @param {{ids: unknown, signal?: AbortSignal}} arg0 -
         * @returns {Promise<ReadonlyArray<WorkItem>>}
         * @throws {WorkSourceError} When a present requested file is unusable.
         * @throws {AbortedError} When `signal` is aborted before or during the reads.
         */
        async fetchByIds({ ids, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(ids) || ids.length === 0) return [];
            // An unsafe id can never name a file; omit it rather than fail the
            // whole refresh over a caller's stale or hostile key.
            /** @type {string[]} */
            const safeIds = [];
            const seen = new Set();
            for (const id of ids) {
                if (typeof id !== 'string') continue;
                const trimmed = id.trim();
                if (seen.has(trimmed)) continue;
                seen.add(trimmed);
                if (isSafeId({ dir: root, id: trimmed })) safeIds.push(trimmed);
            }
            if (safeIds.length === 0) return [];
            // A gone or unmounted board must not read as "nothing is visible".
            await requireReadableDirectory({ root, signal });
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            for (const id of safeIds) {
                const file = `${id}.json`;
                let stored;
                try {
                    stored = await readStoredJson({ filePath: join(root, file) });
                } catch (error) {
                    const code = /** @type {{code?: string}} */ (error).code;
                    // `missing` already covers ENOENT below; a name the OS
                    // cannot address at all is omitted for the same reason
                    // instead of failing the whole refresh over one stale key.
                    if (code === 'ENAMETOOLONG' || code === 'EINVAL') continue;
                    throw unreadable({ file, cause: error });
                }
                throwIfAborted({ signal });
                // `missing` is the "no longer visible" rule.
                if (stored.status === 'missing') continue;
                // Corrupt: no cause — the primitive's `reason` quotes content.
                if (stored.status !== 'ok') {
                    throw unreadable({ file, detail: 'is not valid JSON' });
                }
                const parsed = stored.value;
                if (!idMatchesStem({ value: parsed, stem: id })) {
                    throw unreadable({ file, detail: 'does not match its file name' });
                }
                out.push(normalizeRequestedRecord({ raw: parsed, source: 'json' }));
            }
            return out;
        }
    };
}
