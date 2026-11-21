// @ts-check


/**
 * @file Event→logger bridges — turn the SDK's observe surfaces into log lines.
 * @version 0.12.0
 *
 * @description
 * Two opt-in, level-gated adapters that make the event layer visible without
 * hand-enumerating event names:
 *
 *   - `attachEventLogger({ emitter })` — logs every canonical event emitted on
 *     a client/session emitter (the `api_*` / `run:*` / `session:*` / `tool:*` /
 *     `phase:*` envelope). Uses `onAny` when the emitter has it
 *     (`MerciEventEmitter`) and otherwise subscribes to every name in the
 *     `EVENTS` registry — so a new event is logged the day it is registered,
 *     unlike the hand-written lists it replaces.
 *   - `createStreamLogger()` — returns an `onEvent` handler for the
 *     `session.run({ options: { onEvent } })` step stream, logging the events
 *     `defaultDisplay` does not render (quota, tool_calls, compaction,
 *     truncated, …). Compose it via `defaultDisplay({ also })`.
 *
 * Both summarize payloads by default (scalars + collection sizes) and dump the
 * full redacted envelope only at `level: 'trace'`. Neither ever throws into the
 * observed run.
 */
import { EVENTS } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { log as defaultLog } from './logger.mjs';


/** Envelope fields never repeated in a summary (correlation is shown separately). */
const META_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);
/** Stream events carry their name in `type`; drop it so `stream:x` is not doubled. */
const STREAM_META_KEYS = new Set([...META_KEYS, 'type']);


/**
 * Every unique canonical event name in the `EVENTS` registry. Excludes the
 * bare `'error'` name: subscribing to it would change Node's throw-on-unhandled
 * semantics on a plain EventEmitter. Errors stay visible via `api_error` and
 * `error:thrown`.
 * @returns {string[]}
 */
export function canonicalEventNames() {
    const names = new Set();
    /** @param {Record<string, any>} node */
    const walk = (node) => {
        for (const v of Object.values(node)) {
            if (typeof v === 'string') names.add(v);
            else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(EVENTS);
    names.delete(EVENTS.CLIENT.ERROR);
    return [...names];
}


/**
 * One compact value: scalars pass through (strings truncated), arrays become
 * `[n]`, and small plain objects stay inline (JSON-ified + redacted by the
 * logger); anything larger becomes `{n}`.
 * @param {*} v
 * @returns {*}
 */
function compactValue(v) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        const maxChars = LIMITS.event_log_value_chars;
        return v.length > maxChars ? `${v.slice(0, maxChars)}…` : v;
    }
    if (Array.isArray(v)) return `[${v.length}]`;
    if (typeof v === 'object') {
        const keys = Object.keys(v).length;
        let json = null;
        try { json = JSON.stringify(v); } catch { json = null; }
        if (json !== null && json.length <= LIMITS.event_log_object_chars && keys <= LIMITS.event_log_object_keys) return v;
        return `{${keys}}`;
    }
    return String(v);
}


/**
 * Builds the compact payload logged for an event (envelope metadata omitted).
 * @param {{payload: *, omit?: Set<string>}} arg0
 * @returns {Record<string, *>}
 */
function summarize({ payload, omit = META_KEYS }) {
    if (payload instanceof Error) return { name: payload.name, message: payload.message };
    if (!payload || typeof payload !== 'object') return {};
    /** @type {Record<string, *>} */
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
        if (omit.has(k)) continue;
        out[k] = compactValue(v);
    }
    return out;
}


/**
 * Subscribes a catch-all logger to an emitter. Logs at `level` (default
 * `debug`; full redacted envelopes at `trace`). Returns an unsubscribe fn.
 * @param {{emitter?: Object|null, log?: import('./logger.mjs').Logger, level?: string, filter?: ((arg0: {name: string, envelope: Record<string, unknown>}) => boolean)|null}} arg0 -
 *   The emitter is a Node `EventEmitter` or any object with `on`/`off` (the SDK's clients); it is probed at runtime (`on` is required, `onAny` is used when present).
 * @returns {() => void}
 */
export function attachEventLogger({ emitter, log = defaultLog, level = 'debug', filter = null } = {}) {
    const em = /** @type {any} */ (emitter);
    if (!em || typeof em.on !== 'function') return () => {};
    /** @param {Record<string, unknown>} envelope */
    const handler = (envelope) => {
        try {
            if (!log.isLevelEnabled({ level })) return;
            const name = envelope && envelope.event ? String(envelope.event) : 'event';
            if (filter && !filter({ name, envelope })) return;
            if (level === 'trace') {
                // The full envelope, structured: `{ event, payload }` on the record (plus the
                // ambient correlation the logger stamps). This is the durable-ledger shape —
                // no truncation, no `{n}` collapse.
                log.event({ type: name, payload: envelope, fields: { event: name, payload: envelope } });
                return;
            }
            const summary = summarize({ payload: envelope });
            log.event({ type: name, payload: Object.keys(summary).length ? summary : undefined });
        } catch { /* a logging bridge must never break the observed run */ }
    };
    if (typeof em.onAny === 'function') return em.onAny(handler);
    const names = canonicalEventNames();
    for (const name of names) em.on(name, handler);
    return () => {
        for (const name of names) {
            if (typeof em.off === 'function') em.off(name, handler);
            else if (typeof em.removeListener === 'function') em.removeListener(name, handler);
        }
    };
}


/**
 * Returns an `onEvent` handler for the agentic step stream that logs every
 * event except those already rendered (`text`, `thought`). Compose it with the
 * default renderer: `defaultDisplay({ also: createStreamLogger() })`.
 * @param {{log?: import('./logger.mjs').Logger, level?: string, ignore?: string[]}} arg0
 * @returns {(event: Record<string, unknown>) => void}
 */
export function createStreamLogger({ log = defaultLog, level = 'debug', ignore = ['text', 'thought'] } = {}) {
    const skip = new Set(ignore);
    return (event) => {
        try {
            if (!event || (typeof event.type === 'string' && skip.has(event.type))) return;
            if (!log.isLevelEnabled({ level })) return;
            const type = String(event.type ?? 'event');
            if (level === 'trace') { log.dump({ label: `stream:${type}`, value: event }); return; }
            const summary = summarize({ payload: event, omit: STREAM_META_KEYS });
            log.event({ type: `stream:${type}`, payload: Object.keys(summary).length ? summary : undefined });
        } catch { /* a logging bridge must never break the observed run */ }
    };
}
