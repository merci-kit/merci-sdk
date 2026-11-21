// @ts-check


/**
 * @file Work source over the SDK's own todo store.
 * @version 0.12.0
 *
 * @description
 * `TodoComponent` already keeps a shared `Map` of `{ id, title, status }`, so a
 * host should not have to write an adapter to feed the scheduler. A todo is
 * dispatchable until it is terminal (`completed`/`failed`), because the
 * component's own lifecycle flips `pending` to `in_progress` when work starts
 * and the scheduler must not read that as an inactive item. The list path
 * filters with the caller's `states`, exactly like the memory adapter, so the
 * scheduler's own `activeStates` owns the vocabulary.
 *
 * The store is read on every call and never snapshotted, so a todo that is
 * completed between ticks disappears from the next list. Records go through the
 * shared `records.mjs` helpers: a malformed todo is skipped and reported on the
 * list path, and fails the refresh for that id. A string id is trimmed; a finite
 * number becomes its string form; anything else is malformed rather than a
 * collision-prone `'undefined'`.
 *
 * `PlanningExecutor` mirrors its DAG steps into the same store as `dag:<id>`
 * rows. Those are internal bookkeeping, not host work, so they are skipped
 * unless the host opts in with `includeInternal: true`.
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
 * A mapped todo row, shaped for `normalizeWorkItem`.
 * @typedef {Object} RawTodoRecord
 * @property {string} id
 * @property {string} identifier
 * @property {unknown} title
 * @property {unknown} state
 * @property {boolean} dispatchable
 */

const SOURCE = 'todos';

/** The prefix `PlanningExecutor` uses for its internal step mirrors. */
const INTERNAL_ID_PREFIX = 'dag:';

/** A todo in one of these states is finished and never dispatched again. */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * Throw when the caller's signal has fired, before a record is touched.
 * `AbortedError` is not a `WorkSourceError` and is never wrapped as one.
 * @param {{signal?: AbortSignal}} arg0 -
 * @returns {void}
 * @throws {AbortedError} When `signal` is aborted.
 */
function throwIfAborted({ signal }) {
    if (signal?.aborted) {
        throw new AbortedError({ message: 'the todo work source read was aborted', options: { cause: signal.reason } });
    }
}

/**
 * The work id a todo contributes, or null when it cannot be one. Accepting only
 * a non-empty string or a finite number keeps `undefined`, `true`, an array, or
 * a bigint from becoming a colliding string id.
 * @param {{value: unknown}} arg0 -
 * @returns {string|null}
 */
function todoId({ value }) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

/**
 * Map one todo to a raw work record, or null when it cannot be read. A null
 * record is a malformed row to the shared normalizer, so both paths agree.
 * @param {{todo: unknown}} arg0 -
 * @returns {RawTodoRecord|null}
 */
function rawTodo({ todo }) {
    if (typeof todo !== 'object' || todo === null) return null;
    try {
        const record = /** @type {Record<string, unknown>} */ (todo);
        const id = todoId({ value: record.id });
        if (id === null) return null;
        // One normalized status decides both the state match and dispatch.
        const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
        return {
            id,
            identifier: id,
            title: record.title,
            state: status,
            dispatchable: !TERMINAL_STATUSES.has(status)
        };
    } catch {
        return null;
    }
}

/**
 * Read a raw record's id, trimmed exactly as the normalizer trims it. A record
 * whose id cannot be read cannot be attributed to a requested id, so it is
 * ignored on the refresh path.
 * @param {{raw: RawTodoRecord|null}} arg0 -
 * @returns {string|null}
 */
function readableId({ raw }) {
    return raw === null ? null : raw.id.trim();
}

/**
 * Whether `store` is safe to read: an object whose `values()` returns an
 * iterator and whose `size` is a number. The probe runs once here so a broken
 * reader fails at construction, not in a tick.
 * @param {{store: unknown}} arg0 -
 * @returns {boolean}
 */
function isStoreLike({ store }) {
    if (typeof store !== 'object' || store === null) return false;
    try {
        const candidate = /** @type {Record<string, unknown>} */ (store);
        if (typeof candidate.values !== 'function' || typeof candidate.size !== 'number') return false;
        const iterator = /** @type {{next?: unknown, [Symbol.iterator]?: unknown}} */ (candidate.values.call(store));
        return typeof iterator?.next === 'function' && typeof iterator[Symbol.iterator] === 'function';
    } catch {
        return false;
    }
}

/**
 * Whether an id names an SDK-internal mirror row rather than host work.
 * @param {{id: string}} arg0 -
 * @returns {boolean}
 */
function isInternalId({ id }) {
    return id.startsWith(INTERNAL_ID_PREFIX);
}

/**
 * Create a read-only work source over a `TodoComponent`-style store.
 * @param {{store: unknown, includeInternal?: boolean, eventEmitter?: WorkSourceEmitter|null}} arg0 -
 * @returns {{
 *   fetchByStates: (arg0: { states: unknown, signal?: AbortSignal }) => ReadonlyArray<WorkItem>,
 *   fetchByIds: (arg0: { ids: unknown, signal?: AbortSignal }) => ReadonlyArray<WorkItem>
 * }}
 * @throws {ConfigurationError} When `store` has no callable `values()` returning an iterator.
 */
export function createTodoWorkSource({ store, includeInternal = false, eventEmitter = null }) {
    if (!isStoreLike({ store })) {
        throw new ConfigurationError({
            message: 'createTodoWorkSource requires a Map-like todo store.',
            options: { option: 'store' }
        });
    }
    const todoStore = /** @type {Map<unknown, unknown>} */ (store);

    return {
        /**
         * The caller's `states` is the scheduler's vocabulary and the only
         * filter here; `dispatchable` stays a property of the todo status.
         * @param {{states: unknown, signal?: AbortSignal}} arg0 -
         * @returns {ReadonlyArray<WorkItem>}
         */
        fetchByStates({ states, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(states) || states.length === 0) return [];
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            const seen = new Set();
            let index = 0;
            for (const todo of todoStore.values()) {
                throwIfAborted({ signal });
                const current = index;
                index += 1;
                const raw = rawTodo({ todo });
                if (!includeInternal && raw !== null && isInternalId({ id: raw.id })) continue;
                const item = normalizeListRecord({ raw, source: SOURCE, index: current, file: null, eventEmitter });
                if (!item) continue;
                // Filter before dedupe: an out-of-state todo must not shadow a
                // later in-state todo with the same id.
                if (!isActiveState({ state: item.state, states })) continue;
                if (seen.has(item.id)) {
                    emitSkippedRecord({ eventEmitter, source: SOURCE, index: current, file: null, reason: 'duplicate_id' });
                    continue;
                }
                seen.add(item.id);
                out.push(item);
            }
            return out;
        },

        /**
         * A requested id is matched against the live store; a missing id is
         * omitted, because the scheduler handles a vanished item.
         * @param {{ids: unknown, signal?: AbortSignal}} arg0 -
         * @returns {ReadonlyArray<WorkItem>}
         * @throws {WorkSourceError} When a requested todo is malformed.
         */
        fetchByIds({ ids, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(ids) || ids.length === 0) return [];
            /** @type {Set<string>} */
            const wanted = new Set();
            for (const id of ids) {
                const wantedId = todoId({ value: id });
                if (wantedId !== null) wanted.add(wantedId);
            }
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            const seen = new Set();
            let index = 0;
            for (const todo of todoStore.values()) {
                throwIfAborted({ signal });
                const current = index;
                index += 1;
                const raw = rawTodo({ todo });
                const id = readableId({ raw });
                if (id === null || !wanted.has(id)) continue;
                if (!includeInternal && isInternalId({ id })) continue;
                if (seen.has(id)) {
                    emitSkippedRecord({ eventEmitter, source: SOURCE, index: current, file: null, reason: 'duplicate_id' });
                    continue;
                }
                seen.add(id);
                out.push(normalizeRequestedRecord({ raw, source: SOURCE }));
            }
            return out;
        }
    };
}
