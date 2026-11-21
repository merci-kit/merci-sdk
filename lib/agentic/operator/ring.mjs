// @ts-check


/**
 * @file Bounded in-memory ring over the orchestration event namespaces.
 * @version 0.12.0
 *
 * @description
 * The ring subscribes once through `MerciEventEmitter.onAny` (a plain
 * `EventEmitter` cannot glob namespaces) and keeps the last `limit` projected
 * records for `scheduler:*`, `work_item:*`, `workspace:*`, and
 * `workflow_policy:*` events. Each record is frozen at insert and built by
 * `projectEventRecord`, the single allowlist projection that the detail route
 * also applies to a host-supplied `recentEvents` provider — so a payload with
 * `prompt`, `description`, or `toolArgs` cannot leak through either path.
 *
 * `workflow_policy:*` is in the default set because a broken `WORKFLOW.md`
 * blocks dispatch: an operator that cannot see the reload failure sees a
 * healthy-looking, idle system.
 *
 * The ring emits nothing and never mutates a record after insert.
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';

/**
 * The fields a record may carry (§3.5). Anything else — prose, tool
 * arguments, provider payloads — is dropped.
 * @type {ReadonlyArray<string>}
 */
const RECORD_FIELDS = Object.freeze([
    'event', 'sessionId', 'workItemId', 'identifier', 'attempt', 'owner', 'lane', 'state',
    'priority', 'reason', 'failureClass', 'errorName', 'errorCode', 'idleMs',
    'delayMs', 'dueAtMs', 'nextCheckAt', 'attempts', 'continuations', 'cleanup',
    'durationMs', 'runId', 'parentRunId', 'outcome', 'fetched', 'dispatched', 'running',
    'retrying', 'parked', 'claimed', 'drained', 'op', 'category', 'source',
    'index', 'file', 'name', 'success', 'limit', 'totals', 'usage', 'errors', 'changed',
    'concurrency', 'activeStates', 'terminalStates', 'pollIntervalMs',
    'stallTimeoutMs', 'key', 'path', 'strategy', 'branch', 'createdNow',
    'forced', 'hook', 'exitCode', 'timedOut', 'fatal',
    // `workflow_policy:*`: stable codes only — a reason, a warning class, a
    // field name, and the prompt size. Never prompt text.
    'promptChars', 'reasons', 'warnings'
]);

/** The orchestrator namespaces the ring records by default. */
export const DEFAULT_PREFIXES = Object.freeze(['scheduler:', 'work_item:', 'workspace:', 'workflow_policy:']);

/** Structured payload fields that keep only number entries, plus booleans. */
const NUMBER_OR_BOOLEAN_MAP_FIELDS = Object.freeze(['usage', 'totals']);

/** Structured payload fields that keep only strings. */
const STRING_ARRAY_FIELDS = Object.freeze(['errors', 'changed', 'activeStates', 'terminalStates', 'reasons', 'warnings']);

/**
 * A finite number, or `null`.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A plain object reduced to finite-number entries (and booleans when allowed).
 * A non-object or an array is dropped: neither is a documented payload.
 * @param {{ value: unknown, booleans: boolean }} arg0
 * @returns {Record<string, unknown>|undefined}
 */
function toPrimitiveMap({ value, booleans }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, entry] of Object.entries(value)) {
        if (typeof entry === 'number' && Number.isFinite(entry)) out[name] = entry;
        else if (booleans && typeof entry === 'boolean') out[name] = entry;
    }
    return out;
}

/**
 * A fresh array of its string entries, or `undefined` for a non-array.
 * @param {unknown} value
 * @returns {Array<string>|undefined}
 */
function toStringArray(value) {
    if (!Array.isArray(value)) return undefined;
    return value.filter((entry) => typeof entry === 'string');
}

/**
 * The concurrency settings: finite-number entries, plus the documented
 * `byLane` map one level down, so `scheduler:start` keeps its lane caps.
 * @param {unknown} value
 * @returns {Record<string, unknown>|undefined}
 */
function toConcurrency(value) {
    const out = toPrimitiveMap({ value, booleans: false });
    if (!out) return undefined;
    const lanes = toPrimitiveMap({ value: /** @type {{byLane?: unknown}} */ (value).byLane, booleans: false });
    if (lanes && Object.keys(lanes).length > 0) out.byLane = lanes;
    return out;
}

/**
 * Structured payload fields are normalized, so a host provider cannot nest a
 * prompt inside an allowlisted object. Other fields are documented scalars.
 * @param {{ field: string, event: string, value: unknown }} arg0
 * @returns {unknown}
 */
function normalizeField({ field, event, value }) {
    if (NUMBER_OR_BOOLEAN_MAP_FIELDS.includes(field)) return toPrimitiveMap({ value, booleans: true });
    if (field === 'concurrency') return toConcurrency(value);
    if (STRING_ARRAY_FIELDS.includes(field)) return toStringArray(value);
    // Only a `tool:*` record carries a tool name; any other `name` is payload.
    if (field === 'name') {
        return event.startsWith('tool:') && typeof value === 'string'
            ? value.slice(0, LIMITS.operator_max_field_chars)
            : undefined;
    }
    // A session id is a bounded non-empty string; a provider's null is not a value.
    if (field === 'sessionId') {
        return typeof value === 'string' && value !== ''
            ? value.slice(0, LIMITS.operator_max_field_chars)
            : undefined;
    }
    if (field === 'success') return typeof value === 'boolean' ? value : undefined;
    // The real tick emits a count; the plan also documents an id array.
    if (field === 'claimed') {
        return typeof value === 'number' && Number.isFinite(value) ? value : toStringArray(value);
    }
    // The remaining fields are documented scalars (a name, a reason, a path).
    // A host provider that sends an object there is malformed data, not text:
    // drop it rather than store a nested payload.
    return typeof value === 'object' && value !== null ? undefined : value;
}

/**
 * The allowlist projection, applied both at insert and at the API boundary.
 * Accepts a full envelope (`ts`) or an already-projected record (`at`).
 * @param {{ envelope?: unknown, event?: string, now?: () => number }} [arg0]
 * @returns {Record<string, unknown>}
 */
export function projectEventRecord({ envelope, event: eventName, now = Date.now } = {}) {
    const source = envelope && typeof envelope === 'object'
        ? /** @type {Record<string, unknown>} */ (envelope)
        : {};
    const event = typeof eventName === 'string'
        ? eventName
        : (typeof source.event === 'string' ? source.event : '');
    const at = toNumber(source.ts) ?? toNumber(source.at) ?? now();
    /** @type {Record<string, unknown>} */
    const record = { at };
    for (const field of RECORD_FIELDS) {
        const value = normalizeField({ field, event, value: source[field] });
        if (value !== undefined) record[field] = value;
    }
    return record;
}

/**
 * @param {{
 *   emitter?: unknown,
 *   limit?: number,
 *   prefixes?: ReadonlyArray<string>,
 *   now?: () => number
 * }} [arg0]
 * @returns {{ list: (arg0?: {identifier?: string|null, limit?: number|null}) => Array<Record<string, unknown>>, clear: () => void, stop: () => void }}
 */
export function createEventRing({
    emitter,
    limit = LIMITS.operator_ring_limit,
    prefixes = DEFAULT_PREFIXES,
    now = () => Date.now()
} = {}) {
    const candidate = /** @type {{ onAny?: unknown }} */ (emitter);
    if (!candidate || typeof candidate.onAny !== 'function') {
        throw new ConfigurationError({
            message: 'createEventRing requires a MerciEventEmitter with onAny()',
            options: { option: 'invalid_emitter' }
        });
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        throw new ConfigurationError({
            message: 'createEventRing requires limit to be an integer >= 1',
            options: { option: 'invalid_limit' }
        });
    }
    if (!Array.isArray(prefixes) || prefixes.length === 0
        || prefixes.some((prefix) => typeof prefix !== 'string' || prefix === '')) {
        throw new ConfigurationError({
            message: 'createEventRing requires prefixes to be a non-empty string array',
            options: { option: 'invalid_prefixes' }
        });
    }
    if (typeof now !== 'function') {
        throw new ConfigurationError({
            message: 'createEventRing requires now to be a function',
            options: { option: 'invalid_now' }
        });
    }

    /** @type {Array<Record<string, unknown>>} */
    const records = [];
    let stopped = false;

    /**
     * `emitSafe(name, envelope)` delivers the envelope alone; accept an
     * `(eventName, envelope)` pair too.
     * @param {...unknown} args
     */
    const listener = (...args) => {
        if (stopped) return;
        const [first, second] = args;
        const envelope = typeof first === 'string' ? second : first;
        const source = envelope && typeof envelope === 'object'
            ? /** @type {Record<string, unknown>} */ (envelope)
            : {};
        const event = typeof source.event === 'string'
            ? source.event
            : (typeof first === 'string' ? first : '');
        const name = String(event);
        if (!prefixes.some((prefix) => name.startsWith(prefix))) return;

        const projected = projectEventRecord({ envelope, event: name, now });
        records.push(Object.freeze(
            projected.event === undefined && typeof first === 'string'
                ? { ...projected, event: first }
                : projected
        ));
        if (records.length > limit) records.shift();
    };

    const source = /** @type {{ onAny: (arg0: (...args: Array<unknown>) => void) => () => void }} */ (/** @type {unknown} */ (candidate));
    const unsubscribe = source.onAny(listener);

    /**
     * @param {{ identifier?: string|null, limit?: number|null }} [arg0]
     * @returns {Array<Record<string, unknown>>}
     */
    function list({ identifier = null, limit: cap = null } = {}) {
        const selected = identifier === null
            ? records
            : records.filter((record) => record.identifier === identifier);
        const take = typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : limit;
        return selected.slice(-take);
    }

    function clear() {
        records.length = 0;
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        if (typeof unsubscribe === 'function') unsubscribe();
    }

    return { list, clear, stop };
}
