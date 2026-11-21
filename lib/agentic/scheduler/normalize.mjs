// @ts-check


/**
 * @file Normalization and deterministic ordering for external work items.
 * @version 0.12.0
 *
 * @description
 * Turns an adapter's raw payload into the record the scheduler dispatches on.
 * The rules are strict on purpose: a missing or wrongly typed required field is
 * malformed, never silently coerced, so a broken board fails closed instead of
 * scheduling garbage. Message strings never carry a field value (a title or
 * description is prompt text, not telemetry).
 *
 * The record, its arrays and each `blockedBy` entry are frozen. `nativeRef` and
 * `metadata` are validated for JSON safety, then stored as detached deep copies
 * (`JSON.parse(JSON.stringify(...))`) that the caller may read but that are not
 * frozen, so a caller that keeps mutating its own object cannot change them.
 */
import { WorkSourceError } from '../../core/errors.mjs';
import { isPlainObject } from '../../support/validation.mjs';

/**
 * One entry of `blockedBy`. Best-effort and never interpreted by the scheduler.
 * @typedef {Object} WorkItemBlockedByRef
 * @property {string|null} id
 * @property {string|null} identifier
 * @property {string|null} state
 */

/**
 * A normalized work item. The record, its arrays and each `blockedBy` entry are
 * frozen; `nativeRef` and `metadata` are detached JSON-safe copies that the
 * caller may read but that are not frozen.
 * @typedef {Object} WorkItem
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string} state
 * @property {boolean} dispatchable
 * @property {ReadonlyArray<string>} labels
 * @property {number|null} priority
 * @property {number|null} createdAt
 * @property {number|null} updatedAt
 * @property {string} lane
 * @property {Record<string, unknown>|null} nativeRef
 * @property {Record<string, unknown>|null} metadata
 * @property {ReadonlyArray<WorkItemBlockedByRef>} blockedBy
 * @property {string|null} description
 * @property {string|null} url
 */

/**
 * A work item plus its original array position, for a stable sort tiebreaker.
 * @typedef {Object} IndexedWorkItem
 * @property {WorkItem} item
 * @property {number} index
 */

/**
 * Date-time shape only: `YYYY-MM-DD`, `T`/`t`, `HH:MM:SS`, optional fraction,
 * and an explicit `Z`/`z` or `±HH:MM` offset. Range validity (`24:00:00`,
 * `2026-02-30`) is the ECMAScript parser's job — see `toEpochMs`.
 */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Build the malformed-record error. It names the field and the source only —
 * never the offending value, which may be prose or a provider payload.
 * @param {{source: string, field: string, detail: string}} arg0 -
 * @returns {WorkSourceError}
 */
function malformed({ source, field, detail }) {
    return new WorkSourceError({
        message: `malformed work item from "${source}" ("${field}" ${detail})`,
        options: { category: 'tracker_response', source }
    });
}

/**
 * Walk a value and report whether `JSON.stringify` can round-trip it: plain
 * objects, arrays, finite numbers, strings, booleans, and null. A `WeakSet`
 * on the current path rejects cycles; shared non-cyclic references are allowed.
 * @param {{value: unknown, seen: WeakSet<object>}} arg0 -
 * @returns {boolean}
 */
function isJsonSafeValue({ value, seen }) {
    if (value === null) return true;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(value);
    if (type !== 'object') return false;
    const object = /** @type {object} */ (value);
    // Defense in depth: reject a cycle here instead of letting recursion end in
    // a stack overflow that `toJsonSafeObject` would only turn into null.
    if (seen.has(object)) return false;
    seen.add(object);
    try {
        if (Array.isArray(object)) {
            for (const entry of object) {
                if (!isJsonSafeValue({ value: entry, seen })) return false;
            }
            return true;
        }
        if (!isPlainObject(object)) return false;
        for (const entry of Object.values(/** @type {Record<string, unknown>} */ (object))) {
            if (!isJsonSafeValue({ value: entry, seen })) return false;
        }
        return true;
    } finally {
        seen.delete(object);
    }
}

/**
 * Validate a JSON-safe plain object and return a detached deep copy, or null.
 * Bad JSON-safety is never a record error: the other fields decide validity.
 * @param {{value: unknown}} arg0 -
 * @returns {Record<string, unknown>|null}
 */
function toJsonSafeObject({ value }) {
    if (!isPlainObject(value)) return null;
    try {
        if (!isJsonSafeValue({ value, seen: new WeakSet() })) return null;
        return /** @type {Record<string, unknown>} */ (JSON.parse(/** @type {string} */ (JSON.stringify(value))));
    } catch {
        // A RangeError from deep nesting and a throwing getter both land here.
        return null;
    }
}

/**
 * @param {{value: unknown}} arg0 -
 * @returns {string|null} The trimmed non-empty string, or null.
 */
function trimmedOrNull({ value }) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * @param {{value: unknown}} arg0 -
 * @returns {string[]} Lowercased labels, blanks and duplicates dropped.
 */
function normalizeLabels({ value }) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    try {
        for (const entry of value) {
            if (typeof entry !== 'string') continue;
            const label = entry.trim().toLowerCase();
            if (label === '' || seen.has(label)) continue;
            seen.add(label);
            out.push(label);
        }
    } catch {
        // An unreadable array index (getter or Proxy trap) may carry prompt
        // text in its message; labels are best-effort, so fail closed.
        return [];
    }
    return out;
}

/**
 * @param {{value: unknown}} arg0 -
 * @returns {ReadonlyArray<WorkItemBlockedByRef>} Frozen object entries only;
 * fields trimmed or null.
 */
function normalizeBlockedBy({ value }) {
    if (!Array.isArray(value)) return [];
    /** @type {Readonly<WorkItemBlockedByRef>[]} */
    const out = [];
    try {
        for (const entry of value) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
            const record = /** @type {Record<string, unknown>} */ (entry);
            // One read pass per entry. A getter or Proxy trap on the entry can
            // throw, and its message may be prompt text. `blockedBy` is
            // best-effort and never interpreted, so a throw drops that entry
            // instead of failing the record; the original error is never kept.
            /** @type {string|null} */
            let id;
            /** @type {string|null} */
            let identifier;
            /** @type {string|null} */
            let state;
            try {
                id = trimmedOrNull({ value: record.id });
                identifier = trimmedOrNull({ value: record.identifier });
                state = trimmedOrNull({ value: record.state });
            } catch {
                continue;
            }
            out.push(Object.freeze({ id, identifier, state }));
        }
    } catch {
        // An unreadable array index (getter or Proxy trap) may carry prompt
        // text in its message; `blockedBy` is best-effort, so fail closed.
        return [];
    }
    return out;
}

/**
 * Parse a timestamp as epoch milliseconds. Accepts a valid `Date`, a finite
 * number, or a full RFC 3339 date-time string with an explicit offset. A
 * syntactically valid date-time is handed to the ECMAScript parser, whose own
 * rollover applies to an impossible calendar date (`2026-02-30T00:00:00Z`
 * lands on March 2); a bare date, a date without seconds, and a non-parsing
 * string are null.
 * @param {{value: unknown}} arg0 -
 * @returns {number|null}
 */
export function toEpochMs({ value }) {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && RFC3339_RE.test(value)) {
        // RFC 3339 allows lowercase `t`/`z`; the ECMAScript parser does not.
        const parsed = Date.parse(value.replace('t', 'T').replace(/z$/, 'Z'));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * Normalize one raw adapter record into a frozen `WorkItem`.
 *
 * Required fields (`id`, `identifier`, `title`, `state`) must be non-empty
 * strings after trimming; `dispatchable` must be an explicit boolean. Unknown
 * keys are dropped. Any violation throws `WorkSourceError` with
 * `category: 'tracker_response'`; the message names the field and the source
 * but never a value, so prompt text and provider payloads never leak.
 *
 * @param {{raw: unknown, source?: string}} arg0 -
 * @returns {Readonly<WorkItem>}
 * @throws {WorkSourceError} When the record is not a suitable object or a required field is malformed.
 */
export function normalizeWorkItem({ raw, source = 'unknown' }) {
    // The record is untrusted input, so no foreign error may escape: a revoked
    // Proxy, a throwing trap, or a getter on a host object must surface as a
    // WorkSourceError with a fixed message. The original error is never
    // attached as `cause`, since its text may be prompt or provider payload.
    try {
        return toWorkItem({ raw, source });
    } catch (err) {
        if (err instanceof WorkSourceError) throw err;
        throw malformed({ source, field: 'record', detail: 'could not be read' });
    }
}

/**
 * The body of `normalizeWorkItem`, without the safety net.
 * @param {{raw: unknown, source: string}} arg0 -
 * @returns {Readonly<WorkItem>}
 * @throws {WorkSourceError} When the record is not a suitable object or a required field is malformed.
 */
function toWorkItem({ raw, source }) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw malformed({ source, field: 'raw', detail: 'must be a non-null, non-array object' });
    }
    const record = /** @type {Record<string, unknown>} */ (raw);

    // One read pass. A getter or Proxy trap on the raw record can throw; the
    // caller's safety net turns that into the same fixed message without ever
    // attaching the original error (its text may be prompt or payload).
    /** @type {Record<string, unknown>} */
    const fields = {
        id: record.id,
        identifier: record.identifier,
        title: record.title,
        state: record.state,
        dispatchable: record.dispatchable,
        labels: record.labels,
        priority: record.priority,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lane: record.lane,
        nativeRef: record.nativeRef,
        metadata: record.metadata,
        blockedBy: record.blockedBy,
        description: record.description,
        url: record.url
    };

    /** @param {string} field */
    const requireString = (field) => {
        const value = fields[field];
        if (typeof value !== 'string' || value.trim() === '') {
            throw malformed({ source, field, detail: 'must be a non-empty string' });
        }
        return value.trim();
    };

    const id = requireString('id');
    const identifier = requireString('identifier');
    const title = requireString('title');
    const state = requireString('state');

    if (typeof fields.dispatchable !== 'boolean') {
        throw malformed({ source, field: 'dispatchable', detail: 'must be a boolean' });
    }
    const dispatchable = fields.dispatchable;

    const labels = normalizeLabels({ value: fields.labels });
    const priority = Number.isInteger(fields.priority) ? /** @type {number} */ (fields.priority) : null;
    const lane = trimmedOrNull({ value: fields.lane }) ?? 'default';
    const description = typeof fields.description === 'string' ? fields.description : null;

    /** @type {WorkItem} */
    const item = {
        id,
        identifier,
        title,
        state,
        dispatchable,
        labels: Object.freeze(labels),
        priority,
        createdAt: toEpochMs({ value: fields.createdAt }),
        updatedAt: toEpochMs({ value: fields.updatedAt }),
        lane,
        nativeRef: toJsonSafeObject({ value: fields.nativeRef }),
        metadata: toJsonSafeObject({ value: fields.metadata }),
        blockedBy: Object.freeze(normalizeBlockedBy({ value: fields.blockedBy })),
        description,
        url: trimmedOrNull({ value: fields.url })
    };
    return Object.freeze(item);
}

/**
 * The dispatch bucket: priority `1..4` keeps its number; every other integer,
 * `null`, and a non-number share bucket `5`.
 * @param {{priority: WorkItem['priority']}} arg0 -
 * @returns {number}
 */
function priorityBucket({ priority }) {
    if (typeof priority === 'number' && priority >= 1 && priority <= 4) return priority;
    return 5;
}

/**
 * Compare two indexed items for dispatch: priority bucket, then `createdAt`
 * oldest first with null last, then `identifier` in code-unit order (never
 * `localeCompare`, which is locale-dependent), then the original index.
 * @param {{a: IndexedWorkItem, b: IndexedWorkItem}} arg0 -
 * @returns {number}
 */
function compareDispatch({ a, b }) {
    const bucketDelta = priorityBucket({ priority: a.item.priority }) - priorityBucket({ priority: b.item.priority });
    if (bucketDelta !== 0) return bucketDelta;

    const aCreated = a.item.createdAt;
    const bCreated = b.item.createdAt;
    const aHas = typeof aCreated === 'number' && Number.isFinite(aCreated);
    const bHas = typeof bCreated === 'number' && Number.isFinite(bCreated);
    if (aHas && bHas && aCreated !== bCreated) return /** @type {number} */ (aCreated) - /** @type {number} */ (bCreated);
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;

    if (a.item.identifier < b.item.identifier) return -1;
    if (a.item.identifier > b.item.identifier) return 1;
    // Spec-mandated (§3.3): the explicit index tiebreaker is required, not a
    // substitute for an assumed engine stable sort.
    return a.index - b.index;
}

/**
 * Order items for dispatch without mutating the input. Returns a new array.
 * @param {{items: ReadonlyArray<WorkItem>}} arg0 -
 * @returns {WorkItem[]}
 */
export function sortForDispatch({ items }) {
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => compareDispatch({ a, b }))
        .map((entry) => entry.item);
}

/**
 * The accepted state configuration: a raw list normalized on the fly, or a
 * precomputed set the caller has already trimmed and lowercased. §3.3 expects
 * the precomputed form on the scheduler's hot path.
 * @typedef {ReadonlyArray<string>|ReadonlySet<string>} StateList
 */

/**
 * Resolve a state configuration to a set. An array is trimmed and lowercased
 * here; a `Set` is assumed already normalized and used as-is. Any other value
 * is null.
 * @param {{states: unknown}} arg0 -
 * @returns {ReadonlySet<string>|null}
 */
function stateSet({ states }) {
    if (states instanceof Set) return /** @type {ReadonlySet<string>} */ (states);
    if (!Array.isArray(states)) return null;
    const set = new Set();
    for (const entry of states) {
        if (typeof entry === 'string') set.add(entry.trim().toLowerCase());
    }
    return set;
}

/**
 * Whether a state name matches one of the configured states. Comparison is
 * trim + lowercase; a `Set` must already be normalized. A non-string state or
 * a non-array/non-set list is false.
 * @param {{state: unknown, states: StateList}} arg0 -
 * @returns {boolean}
 */
function stateMatches({ state, states }) {
    if (typeof state !== 'string') return false;
    const set = stateSet({ states });
    return set !== null && set.has(state.trim().toLowerCase());
}

/**
 * Whether `state` is one of the configured states. `states` accepts a
 * `StateList`; a non-string state or any other value is false.
 * @param {{state: unknown, states: StateList}} arg0 -
 * @returns {boolean}
 */
export function isActiveState({ state, states }) {
    return stateMatches({ state, states });
}

/**
 * Whether `state` is one of the terminal states. `states` accepts a
 * `StateList`; a non-string state or any other value is false.
 * @param {{state: unknown, states: StateList}} arg0 -
 * @returns {boolean}
 */
export function isTerminalState({ state, states }) {
    return stateMatches({ state, states });
}
