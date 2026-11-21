// @ts-check


/**
 * @file The list/refresh asymmetry shared by every work source.
 * @version 0.12.0
 *
 * @description
 * One malformed record means two different things. On the list path a broken
 * row must not stop the scan, so it is skipped and reported; on the refresh
 * path the caller asked for that exact id, so a broken row fails the call. The
 * adapters all funnel through the two functions here so the rule exists once.
 *
 * The skip event carries `{ source, index, file, reason }` and nothing else. It
 * never carries the error message, the record id, title, or description: a
 * board row's prose is prompt text, not telemetry. `index` is the record's
 * position in the adapter's own enumeration, or null when it has none; `file`
 * is a base file name, or null for in-memory and host results.
 */
import { EVENTS, emitEvent } from '../../../core/events.mjs';
import { WorkSourceError } from '../../../core/errors.mjs';
import { normalizeWorkItem } from '../normalize.mjs';

/** @typedef {import('../normalize.mjs').WorkItem} WorkItem */

/**
 * The minimum an event sink must provide; a `MerciEventEmitter` and a plain
 * `{ emit }` object both qualify.
 * @typedef {Object} WorkSourceEmitter
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 */

/**
 * The reason a record did not become a work item. `malformed` covers an
 * unreadable or invalid record; `unsafe_id` means the file name cannot name an
 * id on every platform; the other two are adapter-level failures.
 * @typedef {'malformed'|'id_filename_mismatch'|'duplicate_id'|'unsafe_id'} SkipReason
 */

/**
 * Emit one `work_item:skipped` event with the documented four-field payload.
 * @param {{eventEmitter: WorkSourceEmitter|null, source: string, index: number|null, file: string|null, reason: SkipReason}} arg0 -
 * @returns {void}
 */
export function emitSkippedRecord({ eventEmitter, source, index, file, reason }) {
    if (!eventEmitter) return;
    emitEvent({
        emitter: /** @type {import('node:events').EventEmitter} */ (eventEmitter),
        name: EVENTS.WORK_ITEM.SKIPPED,
        payload: { source, index, file, reason }
    });
}

/**
 * Normalize one record on the list path: skip and report on a malformed record,
 * return null. Any non-`WorkSourceError` is rethrown — `normalizeWorkItem`'s
 * own safety net already turns a hostile getter into one, so a leak here would
 * be a bug, not a skip.
 * @param {{raw: unknown, source: string, index: number|null, file: string|null, eventEmitter: WorkSourceEmitter|null}} arg0 -
 * @returns {Readonly<WorkItem>|null}
 */
export function normalizeListRecord({ raw, source, index, file, eventEmitter }) {
    try {
        return normalizeWorkItem({ raw, source });
    } catch (error) {
        if (!(error instanceof WorkSourceError)) throw error;
        emitSkippedRecord({ eventEmitter, source, index, file, reason: 'malformed' });
        return null;
    }
}

/**
 * Normalize one requested record on the refresh path: throw the
 * `WorkSourceError` unchanged, because the caller asked for this exact id.
 * @param {{raw: unknown, source: string}} arg0 -
 * @returns {Readonly<WorkItem>}
 * @throws {WorkSourceError} When the record is malformed.
 */
export function normalizeRequestedRecord({ raw, source }) {
    return normalizeWorkItem({ raw, source });
}
