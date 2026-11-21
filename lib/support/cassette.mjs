// @ts-check


/**
 * @file Cassette — record a session's vendor calls once, replay them offline.
 * @version 0.12.0
 *
 * @description
 * A cassette sits between the session and its backend adapter:
 *
 *   - **record** runs the real call and stores the *normalized* stream events
 *     (the unified `text` / `thought` / `tool_calls` / `quota` … events every
 *     backend produces), keyed by the sha256 of the canonical vendor request;
 *   - **replay** answers the same request from the recording and never calls
 *     the vendor (a request with no recording fails, non-retryable).
 *
 * The key covers the request's JSON data only (sorted keys; a class instance
 * such as a run context, and the SDK's per-row `merciId`, are left out), so a
 * replay matches across processes. A
 * request that embeds the date (`withAutoContext`, a web preload block)
 * changes its key from day to day: record those per run, or leave them off.
 * Identical requests recorded several times replay in order (the last one
 * repeats). Only a call whose stream completed is recorded.
 *
 * Tools are not part of a cassette: a replayed turn still runs its tools, and
 * their side effects stay at-most-once through the execution journal.
 *
 * `createCassette({ script })` is the test double: the Nth vendor call replays
 * the Nth hand-written event array (the last one repeats, and an empty script
 * answers every call with the missing-recording error). No vendor client has to
 * be patched, and no file is read or written.
 */
import { createHash } from 'node:crypto';
import { ConfigurationError } from '../core/errors.mjs';
import { readStoredJson, writeJsonAtomic } from './fs-store.mjs';
import { canonicalJson } from './utils.mjs';
import { MERCI_ID_KEY } from '../core/constants/index.mjs';


/** The cassette modes. */
export const CASSETTE_MODES = Object.freeze(['record', 'replay']);

/** The on-disk format version. */
export const CASSETTE_VERSION = 1;

/** SDK-internal row keys a backend may carry on its request (JAI sends the rows raw): random per row, so never part of a key. */
const UNKEYED = new Set([MERCI_ID_KEY]);

/** The tool-call ids the SDK mints (`call_` + a v4 UUID). */
const MINTED_CALL_ID = /call_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;


/**
 * The adapter surface a cassette wraps: the two calls between a session and its vendor.
 * @typedef {Object} CassetteAdapter
 * @property {(arg0: {vendorClient?: unknown, request: unknown, signal?: AbortSignal|null, session?: unknown}) => Promise<unknown>} executeVendorRequest
 * @property {(arg0: {rawStream: unknown, signal?: AbortSignal|null}) => AsyncIterable<unknown>} consumeStream
 */

/**
 * A recording of vendor calls.
 * @typedef {Object} Cassette
 * @property {string|null} path - The JSON file it persists to (null: in memory).
 * @property {Array<Array<unknown>>|null} script - Hand-written event arrays (a test double), or null.
 * @property {<A extends CassetteAdapter>(arg0: {adapter: A, mode: 'record'|'replay'}) => A} wrap - The adapter, recording or replaying.
 * @property {() => Promise<number>} size - How many requests it holds a recording for.
 */


/**
 * The cassette key of a vendor request.
 * @param {{request: unknown}} arg0
 * @returns {string} 64 hex chars
 */
export function cassetteKey({ request }) {
    // A tool-call id the SDK mints itself (`call_<uuid>`, e.g. for a tool call recovered
    // from text) is random per run: it is keyed by the order it first appears instead.
    /** @type {Map<string, string>} */
    const minted = new Map();
    const canonical = canonicalJson({ value: request, plainOnly: true, omitKeys: UNKEYED })
        .replace(MINTED_CALL_ID, (id) => {
            if (!minted.has(id)) minted.set(id, `call_#${minted.size}`);
            return /** @type {string} */ (minted.get(id));
        });
    return createHash('sha256').update(canonical).digest('hex');
}


/**
 * Creates a cassette. With `path` it loads that file on first use and saves
 * after every recorded call (atomically); without, it lives in memory.
 * `script` turns it into a replay-only test double: an array of normalized
 * event arrays, one per vendor call.
 * @param {{path?: string|null, script?: Array<Array<unknown>>|null}} [arg0]
 * @returns {Cassette}
 */
export function createCassette({ path = null, script = null } = {}) {
    if (script !== null) {
        if (path) {
            throw new ConfigurationError({ message: 'createCassette: pass either `path` (a recording file) or `script` (hand-written events), not both.', options: { option: 'script' } });
        }
        if (!Array.isArray(script) || script.some((entry) => !Array.isArray(entry))) {
            throw new ConfigurationError({ message: 'createCassette: `script` must be an array of event arrays.', options: { option: 'script' } });
        }
    }
    /** One load, shared by every concurrent first use: two sessions never read the file into two maps. */
    /** @type {Promise<Record<string, Array<Array<unknown>>>>|null} */
    let loading = null;
    /** Writes run one after another, each with the full map. */
    /** @type {Promise<void>} */
    let saving = Promise.resolve();
    /** Keys recorded by this process: the first recording replaces an older one. */
    const recorded = new Set();
    /** @type {Map<string, number>} */
    const cursor = new Map();

    /** @returns {Promise<Record<string, Array<Array<unknown>>>>} */
    function load() {
        loading ??= (async () => {
            if (!path) return {};
            const read = await readStoredJson({ filePath: path });
            if (read.status === 'missing') return {};
            const value = /** @type {any} */ (read.value);
            // A cassette that cannot be read is refused, never re-recorded over.
            if (read.status !== 'ok' || value?.version !== CASSETTE_VERSION || !value?.entries || typeof value.entries !== 'object') {
                throw new ConfigurationError({ message: `Cassette ${path} is unreadable (${read.reason ?? `version ${value?.version}`}).`, options: { option: 'withCassette' } });
            }
            return /** @type {Record<string, Array<Array<unknown>>>} */ (value.entries);
        })();
        return loading;
    }

    /**
     * @param {{key: string, events: Array<unknown>}} arg0
     * @returns {Promise<void>}
     */
    async function record({ key, events }) {
        const all = await load();
        if (!recorded.has(key)) {
            recorded.add(key);
            all[key] = [];
        }
        all[key].push(events);
        if (!path) return;
        const filePath = path;
        saving = saving.catch(() => {}).then(() => writeJsonAtomic({ filePath, data: { version: CASSETTE_VERSION, entries: all } }));
        await saving;
    }

    /**
     * @param {{key: string}} arg0
     * @returns {Promise<Array<unknown>|null>}
     */
    async function replay({ key }) {
        const list = (await load())[key];
        if (!Array.isArray(list) || list.length === 0) return null;
        const at = cursor.get(key) ?? 0;
        cursor.set(key, at + 1);
        return list[Math.min(at, list.length - 1)];
    }

    /** @param {unknown} event @returns {unknown} the event as it is stored (plain JSON) */
    const stored = (event) => JSON.parse(JSON.stringify(event ?? null));

    /** @param {string} detail @returns {Error} */
    function missingRecording(detail) {
        const err = new ConfigurationError({ message: `The cassette has no recording for this request (${detail}): record it first.`, options: { option: 'withCassette' } });
        /** @type {any} */ (err).nonRetryable = true;
        return err;
    }

    return {
        path,
        script,
        async size() { return script ? script.length : Object.keys(await load()).length; },
        wrap({ adapter, mode }) {
            if (!CASSETTE_MODES.includes(mode)) {
                throw new ConfigurationError({ message: `withCassette: mode must be one of ${CASSETTE_MODES.join(', ')} (got ${String(mode)}).`, options: { option: 'mode' } });
            }
            if (!adapter || typeof adapter.executeVendorRequest !== 'function' || typeof adapter.consumeStream !== 'function') {
                throw new ConfigurationError({ message: 'withCassette: the session has no provider adapter to wrap.', options: { option: 'withCassette' } });
            }
            if (mode === 'record') {
                if (script) {
                    throw new ConfigurationError({ message: "createCassette({ script }) is a replay-only test double: use mode 'replay'.", options: { option: 'mode' } });
                }
                // The raw stream goes back to the session untouched, so its inactivity timeout
                // still watches the vendor's chunks; the events are recorded as they are consumed.
                // One wrap serves one session, and a session runs one call at a time.
                /** @type {string|null} */
                let pendingKey = null;
                return {
                    ...adapter,
                    async executeVendorRequest(args) {
                        const raw = await adapter.executeVendorRequest(args);
                        pendingKey = cassetteKey({ request: args.request });
                        return raw;
                    },
                    consumeStream({ rawStream, signal = null }) {
                        const key = pendingKey;
                        pendingKey = null;
                        const live = adapter.consumeStream({ rawStream, signal });
                        if (!key) return live;
                        return (async function* () {
                            /** @type {Array<unknown>} */
                            const events = [];
                            for await (const event of live) {
                                events.push(stored(event));
                                yield event;
                            }
                            await record({ key, events });
                        })();
                    },
                };
            }
            // Replay answers already-normalized events, so the stream consumer passes them through.
            if (script) {
                // The test double: the Nth call replays the Nth script entry and
                // the last one repeats, so one entry can serve a loop.
                let calls = 0;
                return {
                    ...adapter,
                    async executeVendorRequest() {
                        const index = calls++;
                        if (script.length === 0) throw missingRecording('the script is empty');
                        const events = script[Math.min(index, script.length - 1)];
                        return (async function* () { for (const event of events) yield stored(event); })();
                    },
                    consumeStream: ({ rawStream }) => /** @type {AsyncIterable<unknown>} */ (rawStream),
                };
            }
            return {
                ...adapter,
                async executeVendorRequest(args) {
                    const key = cassetteKey({ request: args.request });
                    const events = await replay({ key });
                    if (!events) throw missingRecording(`key ${key.slice(0, 12)}…`);
                    return (async function* () { for (const event of events) yield stored(event); })();
                },
                consumeStream: ({ rawStream }) => /** @type {AsyncIterable<unknown>} */ (rawStream),
            };
        },
    };
}
