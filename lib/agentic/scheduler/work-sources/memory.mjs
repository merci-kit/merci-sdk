// @ts-check


/**
 * @file In-memory work source.
 * @version 0.12.0
 *
 * @description
 * The cheapest adapter: a host-supplied array that is captured **by
 * reference**, so a test or a host can change an item's state between ticks
 * and the next fetch sees it. Records are normalized on every call; nothing is
 * cached, because a cached snapshot would hide exactly the state change the
 * scheduler is waiting for.
 *
 * The list path skips a malformed record and reports it; the refresh path
 * throws for the requested one. An unrequested malformed record is never
 * normalized and cannot fail a refresh.
 */
import { AbortedError, ConfigurationError, WorkSourceError } from '../../../core/errors.mjs';
import { isActiveState } from '../normalize.mjs';
import {
    emitSkippedRecord,
    normalizeListRecord,
    normalizeRequestedRecord
} from './records.mjs';

/** @typedef {import('../normalize.mjs').WorkItem} WorkItem */
/** @typedef {import('./records.mjs').WorkSourceEmitter} WorkSourceEmitter */

/**
 * Read one raw record's id, trimmed exactly as the normalizer trims it, without
 * letting a hostile getter escape. A record whose id cannot be read cannot be
 * attributed to a requested id, so it is ignored on the refresh path. The trim
 * is what makes a refreshable id equal the id the list path returned.
 * @param {{raw: unknown}} arg0 -
 * @returns {string|null}
 */
function readableId({ raw }) {
    if (typeof raw !== 'object' || raw === null) return null;
    try {
        const id = /** @type {Record<string, unknown>} */ (raw).id;
        return typeof id === 'string' ? id.trim() : null;
    } catch {
        return null;
    }
}

/**
 * Throw when the caller's signal has fired, before a record is touched.
 * `AbortedError` is not a `WorkSourceError` and is never wrapped as one.
 * @param {{signal?: AbortSignal}} arg0 -
 * @returns {void}
 * @throws {AbortedError} When `signal` is aborted.
 */
function throwIfAborted({ signal }) {
    if (signal?.aborted) {
        throw new AbortedError({ message: 'the memory work source read was aborted', options: { cause: signal.reason } });
    }
}

/**
 * Create a work source over an in-memory array.
 *
 * Requested ids are compared after `trim()` — the same normalization
 * `normalizeWorkItem` applies — so `' MER-1 '` and `'MER-1'` are one id, and two
 * raw records whose ids differ only in surrounding whitespace are one id (the
 * extra is reported as `duplicate_id`).
 * @param {{items: unknown, eventEmitter?: WorkSourceEmitter|null}} arg0 -
 * @returns {{
 *   fetchByStates: (arg0: { states: unknown, signal?: AbortSignal }) => ReadonlyArray<WorkItem>,
 *   fetchByIds: (arg0: { ids: unknown, signal?: AbortSignal }) => ReadonlyArray<WorkItem>
 * }}
 * @throws {ConfigurationError} When `items` is not an array.
 */
export function createMemoryWorkSource({ items, eventEmitter = null }) {
    if (!Array.isArray(items)) {
        throw new ConfigurationError({
            message: 'createMemoryWorkSource requires an items array.',
            options: { option: 'items' }
        });
    }
    // By reference on purpose: the host may mutate the array between ticks.
    const records = /** @type {ReadonlyArray<unknown>} */ (items);

    return {
        /**
         * @param {{states: unknown, signal?: AbortSignal}} arg0 -
         * @returns {ReadonlyArray<WorkItem>}
         */
        fetchByStates({ states, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(states) || states.length === 0) return [];
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            const seen = new Set();
            for (let index = 0; index < records.length; index += 1) {
                throwIfAborted({ signal });
                const item = normalizeListRecord({ raw: records[index], source: 'memory', index, file: null, eventEmitter });
                if (!item) continue;
                // Filter before dedupe: an out-of-state record must not shadow a
                // later in-state record with the same id, nor count as a
                // duplicate of the result set.
                if (!isActiveState({ state: item.state, states })) continue;
                if (seen.has(item.id)) {
                    // Two in-state records share an id: the first wins, and each
                    // extra record is reported once.
                    emitSkippedRecord({ eventEmitter, source: 'memory', index, file: null, reason: 'duplicate_id' });
                    continue;
                }
                seen.add(item.id);
                out.push(item);
            }
            return out;
        },

        /**
         * @param {{ids: unknown, signal?: AbortSignal}} arg0 -
         * @returns {ReadonlyArray<WorkItem>}
         * @throws {WorkSourceError} When a requested record is malformed.
         */
        fetchByIds({ ids, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(ids) || ids.length === 0) return [];
            // Set semantics: a trimmed id, matching what `readableId` and the
            // normalizer produce, so a padded request still hits the item.
            /** @type {Set<string>} */
            const wanted = new Set();
            for (const id of ids) if (typeof id === 'string') wanted.add(id.trim());
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            const seen = new Set();
            for (let index = 0; index < records.length; index += 1) {
                throwIfAborted({ signal });
                const id = readableId({ raw: records[index] });
                if (id === null || !wanted.has(id)) continue;
                if (seen.has(id)) {
                    // Two source records share a requested id: the first wins,
                    // and each extra record is reported once.
                    emitSkippedRecord({ eventEmitter, source: 'memory', index, file: null, reason: 'duplicate_id' });
                    continue;
                }
                seen.add(id);
                out.push(normalizeRequestedRecord({ raw: records[index], source: 'memory' }));
            }
            return out;
        }
    };
}
