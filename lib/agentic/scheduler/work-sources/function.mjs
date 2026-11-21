// @ts-check


/**
 * @file Host-function work source.
 * @version 0.12.0
 *
 * @description
 * The escape hatch for a real tracker (GitHub, Jira, Linear, A2A): the host
 * supplies the two fetch functions and this adapter supplies the contract —
 * validate them at construction, return `[]` for an empty query without calling
 * the host, wrap a plain throw in `WorkSourceError`, and apply the shared
 * list/refresh asymmetry to the returned records.
 *
 * A thrown `WorkSourceError` passes through unchanged, because the host's
 * category (`tracker_rate_limited`, `tracker_status`, ...) is more accurate
 * than anything this adapter could guess. A plain error becomes
 * `tracker_request` with the original attached as `cause`; its message is never
 * copied into ours, since a host error may quote a payload. An `AbortedError`
 * also passes through unchanged: cancellation is not a tracker failure. The
 * host receives exactly `{ states, signal }` / `{ ids, signal }`, and `signal`
 * is re-checked after the host resolves and once per returned record.
 *
 * The list result is not filtered by state: the host already received `states`
 * and its answer is authoritative, unlike the memory and JSON adapters that
 * hold every record and must filter locally. The scheduler re-checks state in
 * AC5 eligibility, so this is a documented deviation, not a gap.
 *
 * Ids are set semantics on the request side: a duplicate input id is sent to
 * the host once. On the refresh path, when two returned records share an id the
 * first wins and each extra record is reported as `duplicate_id`. The list path
 * does not dedupe returned records — the host's answer is authoritative, and
 * the scheduler's eligibility check applies.
 */
import { AbortedError, ConfigurationError, WorkSourceError } from '../../../core/errors.mjs';
import {
    emitSkippedRecord,
    normalizeListRecord,
    normalizeRequestedRecord
} from './records.mjs';

/** @typedef {import('../normalize.mjs').WorkItem} WorkItem */
/** @typedef {import('./records.mjs').WorkSourceEmitter} WorkSourceEmitter */

/**
 * One host fetch operation. The same shape covers both queries; each host
 * reads the field its operation was given.
 * @typedef {(arg0: {states?: Array<string>, ids?: Array<string>, signal?: AbortSignal}) => unknown} HostFetch
 */

/**
 * Throw when the caller's signal has fired. `AbortedError` is not a
 * `WorkSourceError` and is never wrapped as one.
 * @param {{signal?: AbortSignal}} arg0 -
 * @returns {void}
 * @throws {AbortedError} When `signal` is aborted.
 */
function throwIfAborted({ signal }) {
    if (signal?.aborted) {
        throw new AbortedError({ message: 'the function work source read was aborted', options: { cause: signal.reason } });
    }
}

/**
 * Call a host fetch and translate only the failure it cannot express.
 * @param {{host: HostFetch, label: string, arg: {states: Array<string>}|{ids: Array<string>}, signal?: AbortSignal}} arg0 -
 * @returns {Promise<unknown>}
 * @throws {WorkSourceError} `tracker_request` for a plain host error, unchanged for a `WorkSourceError`.
 * @throws {AbortedError} Unchanged when the host reports cancellation.
 */
async function callHost({ host, label, arg, signal }) {
    try {
        return await host({ ...arg, signal });
    } catch (error) {
        if (error instanceof WorkSourceError || error instanceof AbortedError) throw error;
        throw new WorkSourceError({
            message: `work source function "${label}" failed`,
            options: { category: 'tracker_request', source: 'function', cause: error }
        });
    }
}

/**
 * @param {{value: unknown, label: string}} arg0 -
 * @returns {ReadonlyArray<unknown>}
 * @throws {WorkSourceError} When the host did not return an array.
 */
function requireArray({ value, label }) {
    if (!Array.isArray(value)) {
        throw new WorkSourceError({
            message: `work source function "${label}" must resolve to an array`,
            options: { category: 'tracker_response', source: 'function' }
        });
    }
    return value;
}

/**
 * Create a work source backed by two host functions.
 * @param {{fetchByStates?: HostFetch, fetchByIds?: HostFetch, eventEmitter?: WorkSourceEmitter|null}} arg0 -
 * @returns {{
 *   fetchByStates: (arg0: { states: Array<string>, signal?: AbortSignal }) => Promise<ReadonlyArray<WorkItem>>,
 *   fetchByIds: (arg0: { ids: Array<string>, signal?: AbortSignal }) => Promise<ReadonlyArray<WorkItem>>
 * }}
 * @throws {ConfigurationError} When either operation is not a function.
 */
export function createFunctionWorkSource({ fetchByStates, fetchByIds, eventEmitter = null }) {
    if (typeof fetchByStates !== 'function') {
        throw new ConfigurationError({ message: 'createFunctionWorkSource requires a fetchByStates function.', options: { option: 'fetchByStates' } });
    }
    if (typeof fetchByIds !== 'function') {
        throw new ConfigurationError({ message: 'createFunctionWorkSource requires a fetchByIds function.', options: { option: 'fetchByIds' } });
    }
    // Runtime validation above; these are the narrowed closures.
    const listHost = /** @type {HostFetch} */ (fetchByStates);
    const refreshHost = /** @type {HostFetch} */ (fetchByIds);

    return {
        /**
         * @param {{states: Array<string>, signal?: AbortSignal}} arg0 -
         * @returns {Promise<ReadonlyArray<WorkItem>>}
         * @throws {AbortedError} When `signal` is aborted before or during the call.
         */
        async fetchByStates({ states, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(states) || states.length === 0) return [];
            const raw = requireArray({ value: await callHost({ host: listHost, label: 'fetchByStates', arg: { states }, signal }), label: 'fetchByStates' });
            throwIfAborted({ signal });
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            for (let index = 0; index < raw.length; index += 1) {
                throwIfAborted({ signal });
                // No state filter here: the host was given `states`, and AC5
                // re-checks the returned item against the scheduler's config.
                const item = normalizeListRecord({ raw: raw[index], source: 'function', index, file: null, eventEmitter });
                if (item) out.push(item);
            }
            return out;
        },

        /**
         * @param {{ids: Array<string>, signal?: AbortSignal}} arg0 -
         * @returns {Promise<ReadonlyArray<WorkItem>>}
         * @throws {AbortedError} When `signal` is aborted before or during the call.
         */
        async fetchByIds({ ids, signal }) {
            throwIfAborted({ signal });
            if (!Array.isArray(ids) || ids.length === 0) return [];
            // Set semantics (§3.4): the host sees each string id once.
            const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string'))];
            if (uniqueIds.length === 0) return [];
            const raw = requireArray({ value: await callHost({ host: refreshHost, label: 'fetchByIds', arg: { ids: uniqueIds }, signal }), label: 'fetchByIds' });
            throwIfAborted({ signal });
            /** @type {Readonly<WorkItem>[]} */
            const out = [];
            const seen = new Set();
            for (let index = 0; index < raw.length; index += 1) {
                throwIfAborted({ signal });
                const item = normalizeRequestedRecord({ raw: raw[index], source: 'function' });
                if (seen.has(item.id)) {
                    // The first record wins; each extra record is reported once.
                    emitSkippedRecord({ eventEmitter, source: 'function', index, file: null, reason: 'duplicate_id' });
                    continue;
                }
                seen.add(item.id);
                out.push(item);
            }
            return out;
        }
    };
}
