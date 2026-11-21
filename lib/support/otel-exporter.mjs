// @ts-check


/**
 * @file OTLP exporter — the SDK event stream as OpenTelemetry spans.
 * @version 0.12.0
 *
 * @description
 * The SDK emits every leaf event in `lib/core/events.mjs` and every vendor
 * call is observable through the `ApiObserver` seam
 * (`lib/support/api-observer.mjs`). Until now a consumer had to wire both by
 * hand; this module is the first-class bridge to an OpenTelemetry collector.
 *
 * Span model: the OpenTelemetry **gen_ai** semantic conventions.
 *
 *   - `invoke_agent` — one per run (`run:start` → `run:end`), with the run's usage.
 *   - `chat {model}` — one CLIENT span per vendor call, opened at `onRequest` and
 *     closed by the call's terminal `onResponse` / `onError` (the stream's end),
 *     with `gen_ai.usage.input_tokens` / `output_tokens`.
 *   - `execute_tool {name}` — one per tool call (`tool:call_start` → `tool:call_end`).
 *
 * Children hang off their run's span (a child run off its parent's), so a run is
 * one trace. Every other event becomes a span event on the open span of its run;
 * an event with nothing open to land on stays a zero-length span of its own.
 *
 * Wire format: **OTLP/HTTP JSON** — `POST <endpoint>` with
 * `Content-Type: application/json` and the body
 *
 *   { resourceSpans: [ { resource: { attributes: [...] },
 *                        scopeSpans: [ { scope: { name, version },
 *                                         spans: [ ... ] } ] } ] }
 *
 * Privacy: only scalar payload fields (string / number / boolean) become span
 * attributes, and only under an allowlisted key (ids, names, counts, durations,
 * statuses, operation/model/provider, `gen_ai` identity and usage keys). Free
 * text — a query, a reason, an error message — never becomes an attribute.
 * Objects, arrays and Errors are dropped, an embedded URL keeps its origin
 * only, every string is run through `scrubSecrets`, and every attribute value
 * is capped at 256 characters — telemetry never carries a conversation, a
 * query, a path or a credential.
 *
 * Failure policy: an exporter must never break a run. A failed POST is caught
 * and reported through `sdkWarn({ prefix: 'OTEL', args: [...] })`; the batch is
 * dropped rather than requeued (no unbounded retry queue).
 *
 * @example
 * import { createOtlpExporter } from './support/otel-exporter.mjs';
 * import { EventEmitterApiObserver, CompositeApiObserver } from './support/api-observer.mjs';
 *
 * const exporter = createOtlpExporter({
 *   endpoint: 'http://localhost:4318/v1/traces',
 *   serviceName: 'my-app',
 *   serviceVersion: '1.0.0'
 * });
 *
 * // 1. the runs, tool calls and events of the session
 * const detach = exporter.attach({ emitter: session.eventEmitter });
 *
 * // 2. every vendor call becomes one `chat {model}` span (or use session.withTelemetry({ exporter }))
 * session.withApiObserver({
 *   observer: new CompositeApiObserver({
 *     observers: [new EventEmitterApiObserver({ emitter: session.eventEmitter }), exporter]
 *   })
 * });
 *
 * await exporter.close();  // flush + stop the timer
 * detach();
 */
import { createHash, randomBytes } from 'node:crypto';

import { SDK_VERSION } from '../core/constants/index.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { EVENTS } from '../core/events.mjs';
import { canonicalEventNames } from './event-logger.mjs';
import { redactUrl, scrubSecrets } from './redact.mjs';
import { sdkWarn } from './utils.mjs';


/** OTLP span kind — INTERNAL. */
const KIND_INTERNAL = 1;

/** OTLP span kind — CLIENT (an outbound call). */
const KIND_CLIENT = 3;

/** OTLP status code — OK. */
const STATUS_OK = 1;

/** OTLP status code — ERROR. */
const STATUS_ERROR = 2;

/** OTLP status code — UNSET (a span exported before it ended). */
const STATUS_UNSET = 0;

/**
 * `gen_ai.provider.name` for the SDK's backends: the semantic convention's
 * well-known values where one exists, the backend id otherwise.
 * @type {Record<string, string>}
 */
const GEN_AI_PROVIDERS = {
    openai: 'openai',
    anthropic: 'anthropic',
    google_genai: 'gcp.gemini',
    vertex: 'gcp.vertex_ai'
};

/**
 * Payload keys exported as span attributes. A positive allowlist of ids, names,
 * counts, durations and statuses: the SDK's event vocabulary made the old
 * denylist incomplete (`query`, `url`, `reason`, `evidence` all carried user
 * text), so a key is telemetry only when it is listed here. Free text never is.
 */
const ALLOWED_KEYS = new Set([
    // identity and correlation
    'runId', 'parentRunId', 'sessionId', 'threadId', 'id', 'callId', 'itemId', 'stepId', 'attemptId', 'toolCallId',
    // what the span is about (`name` is per-event: see TOOL_NAME_EVENTS)
    'op', 'operation', 'tool', 'model', 'provider', 'vendor', 'era', 'protocol', 'protocolVersion',
    // statuses
    'status', 'ok', 'success', 'failed', 'aborted', 'finishReason', 'truncated',
    // counts and durations
    'durationMs', 'latencyMs', 'attempt', 'attempts', 'retryCount', 'index', 'round', 'count', 'tokens',
    'prompt_tokens', 'completion_tokens', 'total_tokens'
]);

/**
 * The computed attributes the exporter emits itself. `error.message` and any
 * other free text stay out: a failure is diagnosable by type, code and
 * permanence instead (W2E-6). The gen_ai names are the semantic convention's
 * identity and usage keys — no tool name, no payload.
 */
const ALLOWED_COMPUTED_KEYS = new Set([
    'error.type', 'error.code', 'error.permanent',
    'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.response.model',
    'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens',
    // Identity and counts the exporter derives itself: a tool span names its
    // tool and call, a retried call reports the attempt, and every span may
    // carry a measured duration. None of these is free text.
    'gen_ai.tool.name', 'gen_ai.tool.call.id', 'retryCount', 'durationMs'
]);

/** A URL inside free text: the scheme, then everything up to a delimiter. */
const URL_IN_TEXT_RE = /[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`]{1,2048}/gi;

/**
 * The events whose `name` is a tool name, not an artifact filename or other
 * user text. `artifact:saved { name }` carries a filename, so its `name` never
 * becomes an attribute.
 */
const TOOL_NAME_EVENTS = new Set([EVENTS.TOOL.CALL_START, EVENTS.TOOL.CALL_END]);

/** A conservative tool-name shape: one word, at most two dots, no separators. */
const TECHNICAL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Whether a tool name is technical enough to export: a programmatic identifier,
 * never a path or a filename (`../../etc/passwd`, `report.final.v2.md`).
 * @param {{value: unknown}} arg0
 * @returns {boolean}
 */
function isTechnicalName({ value }) {
    if (typeof value !== 'string' || !TECHNICAL_NAME_RE.test(value)) return false;
    return (value.match(/\./g) ?? []).length <= 2;
}


/**
 * A string made safe for an attribute: an embedded URL keeps only its origin,
 * then the credential shapes are scrubbed from what remains.
 *
 * @param {{text: string}} arg0 - The candidate attribute value.
 * @returns {string} The value without a path, a query or a secret.
 */
function scrubAttributeText({ text }) {
    return scrubSecrets({ text: text.replace(URL_IN_TEXT_RE, (url) => redactUrl({ url })) });
}

/**
 * The client API lifecycle events. When the exporter is also wired as an
 * `ApiObserver` these arrive through the observer path (one duration-carrying
 * span per call) and are skipped here, so a call is never counted twice.
 */
const API_EVENT_NAMES = new Set([
    EVENTS.CLIENT.API_REQUEST,
    EVENTS.CLIENT.API_RESPONSE,
    EVENTS.CLIENT.API_ERROR,
    EVENTS.CLIENT.API_RETRY
]);


/**
 * One OTLP attribute value: the JSON encoding of a single scalar.
 * @typedef {Object} OtlpAttributeValue
 * @property {string} [stringValue]
 * @property {string} [intValue]
 * @property {number} [doubleValue]
 * @property {boolean} [boolValue]
 */

/**
 * One OTLP attribute.
 * @typedef {Object} OtlpAttribute
 * @property {string} key
 * @property {OtlpAttributeValue} value
 */

/**
 * One buffered span — the JSON shape the collector receives.
 * @typedef {Object} OtlpSpan
 * @property {string} traceId
 * @property {string} spanId
 * @property {string} [parentSpanId]
 * @property {string} name
 * @property {number} kind
 * @property {string} startTimeUnixNano
 * @property {string} endTimeUnixNano
 * @property {Array<OtlpAttribute>} attributes
 * @property {Array<{timeUnixNano: string, name: string, attributes: Array<OtlpAttribute>}>} [events] - The run's other events, as span events.
 * @property {{code: number}} status
 */

/**
 * What an injected `fetch` must answer: success and status are all the exporter reads.
 * @typedef {Object} FetchResult
 * @property {boolean} [ok]
 * @property {number} [status]
 */

/**
 * The exporter: an `ApiObserver` (the four vendor-call seams) plus the event
 * stream, the buffer and the flush lifecycle.
 * @typedef {object} OtlpExporter
 * @property {(arg0: {name: string, payload?: Record<string, unknown>}) => void} onEvent
 *   Maps one SDK event onto the span tree (a span, or a span event of its run).
 * @property {(arg0: {meta?: import('./api-observer.mjs').ApiRequestMeta, runContext?: import('./api-observer.mjs').ObserverRunContext|null}) => void} onRequest
 *   `ApiObserver` seam — opens the call's `chat {model}` span.
 * @property {(arg0: {meta?: import('./api-observer.mjs').ApiResponseMeta, runContext?: import('./api-observer.mjs').ObserverRunContext|null}) => void} onResponse
 *   `ApiObserver` seam — closes the `chat` span (the call's terminal signal, with its usage).
 * @property {(arg0: {meta?: import('./api-observer.mjs').ApiErrorMeta, runContext?: import('./api-observer.mjs').ObserverRunContext|null}) => void} onError
 *   `ApiObserver` seam — closes the `chat` span with an error status.
 * @property {(arg0: {meta?: import('./api-observer.mjs').ApiRetryMeta, runContext?: import('./api-observer.mjs').ObserverRunContext|null}) => void} onRetry
 *   `ApiObserver` seam — records a retry on the open API-call span.
 * @property {(arg0: {emitter?: import('./api-observer.mjs').ObserverEmitter}) => () => void} attach
 *   Subscribes to every event of an emitter; returns an unsubscribe fn.
 * @property {() => Promise<void>} flush - POSTs the buffered spans.
 * @property {() => Promise<void>} close - Flushes and stops the timer.
 * @property {() => Array<OtlpSpan>} getSpans - The currently buffered spans.
 */


/**
 * Encodes one OTLP attribute. Non-scalar values (objects, arrays, `null`,
 * `undefined`, `bigint`) yield `null`, so the caller skips them — a payload
 * can never smuggle a message history into telemetry.
 *
 * @param {{key: string, value: unknown}} arg0 - Attribute key and value.
 * @returns {OtlpAttribute|null} The OTLP attribute, or null for a non-scalar value.
 */
export function otelAttribute({ key, value }) {
    if (typeof value === 'boolean') return { key, value: { boolValue: value } };
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return Number.isInteger(value)
            ? { key, value: { intValue: String(value) } }
            : { key, value: { doubleValue: value } };
    }
    if (typeof value === 'string') {
        const maxChars = LIMITS.otel_attr_max_chars;
        return { key, value: { stringValue: value.length > maxChars ? value.slice(0, maxChars) : value } };
    }
    return null;
}


/**
 * Creates an OTLP/HTTP JSON exporter for the SDK event stream.
 *
 * @param {{endpoint?: string, serviceName?: string, serviceVersion?: string, headers?: Record<string, string>, batchSize?: number, flushIntervalMs?: number, resourceAttributes?: Record<string, unknown>, fetchImpl?: (url: string, init: Object) => Promise<FetchResult>}} arg0
 *   `endpoint` — collector traces URL. `serviceName` / `serviceVersion` —
 *   the `service.*` resource attributes (always exported). `headers` — extra
 *   request headers. `batchSize` — spans buffered before an automatic flush
 *   (default 64). `flushIntervalMs` — flush interval (default 5000, 0
 *   disables the timer). `resourceAttributes` — extra resource attributes.
 *   `fetchImpl` — injected `fetch` (tests never touch the network).
 * @returns {OtlpExporter} The exporter.
 */
export function createOtlpExporter({
    endpoint = 'http://localhost:4318/v1/traces',
    serviceName = 'merci-sdk',
    serviceVersion = '',
    headers = {},
    batchSize = LIMITS.otel_batch_size,
    flushIntervalMs = LIMITS.otel_flush_interval_ms,
    resourceAttributes = {},
    fetchImpl = globalThis.fetch
} = {}) {
    /** @type {Array<OtlpSpan>} */
    let spans = [];
    /** @type {any} */
    let timer = null;
    let closed = false;
    let observerActive = false;

    /** Resource attributes — `service.name` / `service.version` always win. */
    /** @type {Array<OtlpAttribute>} */
    const resourceAttrList = [
        { key: 'service.name', value: { stringValue: scrubAttributeText({ text: String(serviceName) }) } },
        { key: 'service.version', value: { stringValue: scrubAttributeText({ text: String(serviceVersion) }) } }
    ];
    for (const [key, value] of Object.entries(resourceAttributes)) {
        if (key === 'service.name' || key === 'service.version') continue;
        const attr = otelAttribute({ key, value: typeof value === 'string' ? scrubAttributeText({ text: value }) : value });
        if (attr) resourceAttrList.push(attr);
    }

    const scope = { name: 'merci-sdk', version: SDK_VERSION };

    /**
     * One payload value as an attribute: only an allowlisted key survives, and
     * a string is made safe before it is encoded. `name` is allowed only on a
     * tool event and only in its technical shape. `computed` selects the
     * exporter's own keys (error/gen_ai) instead of the payload vocabulary.
     * @param {{key: string, value: unknown, computed?: boolean, event?: string}} arg0
     * @returns {OtlpAttribute|null}
     */
    function toAttribute({ key, value, computed = false, event }) {
        const allowed = computed
            ? ALLOWED_COMPUTED_KEYS.has(key)
            : ALLOWED_KEYS.has(key) || (key === 'name' && TOOL_NAME_EVENTS.has(String(event)) && isTechnicalName({ value }));
        if (!allowed) return null;
        return otelAttribute({ key, value: typeof value === 'string' ? scrubAttributeText({ text: value }) : value });
    }

    /**
     * The scalar attributes of one or more payloads. Later payloads win on a
     * key collision (the response overrides the request).
     * @param {{payloads: Array<unknown>, event?: string}} arg0
     * @returns {Array<OtlpAttribute>}
     */
    function attributesFrom({ payloads, event }) {
        /** @type {Map<string, OtlpAttribute>} */
        const byKey = new Map();
        for (const payload of payloads) {
            if (!payload || typeof payload !== 'object') continue;
            for (const [key, value] of Object.entries(payload)) {
                const attr = toAttribute({ key, value, event });
                if (attr) byKey.set(key, attr);
            }
        }
        return [...byKey.values()];
    }

    /** Keep the indexes bounded: an exporter can be attached for a process lifetime. */
    let spanSeq = 0;

    /** @param {string} seed @returns {string} 32 hex chars */
    const hash32 = (seed) => createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, LIMITS.otel_row_hash_chars);
    /** @param {string} seed @returns {string} 16 hex chars */
    const hash16 = (seed) => hash32(seed).slice(0, LIMITS.otel_event_hash_chars);
    /** @returns {bigint} */
    const nowNs = () => BigInt(Date.now()) * 1_000_000n;
    /** @param {unknown} value @returns {string|null} */
    const idString = (value) => (typeof value === 'string' && value ? value : null);

    /**
     * An open span: its identity is fixed when it opens, so a child can name it as
     * its parent before it ends.
     * @typedef {{span: OtlpSpan, startMs: number, attempts: number}} OpenSpan
     */

    /** runId -> the span the run's children hang off (its `invoke_agent`, or a step's `chat`). */
    const spanOfRun = new Map();
    /** runId -> the open `invoke_agent` span of a run. */
    const openRuns = new Map();
    /** step runId -> the open `chat` span of a vendor call. */
    const openChats = new Map();
    /** Open `chat` calls whose caller passed no runContext (direct observer use): FIFO is all they get. */
    /** @type {Array<OpenSpan>} */
    const pending = [];
    /** `${runId}:${callId}` -> the open `execute_tool` span. */
    const openTools = new Map();

    /**
     * Bounded insert. `onEvict` receives the evicted value (an open span must still be exported).
     * @param {{map: Map<string, any>, key: string, value: unknown, onEvict?: ((value: any) => void)|null}} arg0
     * @returns {void}
     */
    function remember({ map, key, value, onEvict = null }) {
        map.set(key, value);
        if (map.size > LIMITS.otel_max_runs) {
            const [oldestKey, oldest] = map.entries().next().value ?? [];
            if (oldestKey !== undefined) {
                map.delete(oldestKey);
                onEvict?.(oldest);
            }
        }
    }

    /** @param {OtlpSpan} span */
    const endEvicted = (span) => endSpan({ span, status: STATUS_UNSET });

    /**
     * The OTLP identity of a new span. It hangs off the first span the exporter knows
     * among `parents` (run ids) and shares its trace; with none known, a correlated span
     * starts the trace of its first run id (so siblings still share one), an
     * uncorrelated one gets a random trace.
     * @param {{parents: Array<string|null>, seed: string|null}} arg0
     * @returns {{traceId: string, spanId: string, parentSpanId?: string}}
     */
    function identityFor({ parents, seed }) {
        // An open run or call is always a valid parent, even after spanOfRun's bound evicted it.
        const known = parents.map((id) => (id ? (spanOfRun.get(id) ?? openRuns.get(id) ?? openChats.get(id)?.span) : null)).find(Boolean) ?? null;
        const root = parents.find(Boolean) ?? seed;
        const traceId = known?.traceId ?? (root ? hash32(`trace:${root}`) : randomBytes(16).toString('hex'));
        const spanId = seed ? hash16(`span:${seed}:${spanSeq++}`) : randomBytes(8).toString('hex');
        return { traceId, spanId, ...(known ? { parentSpanId: known.spanId } : {}) };
    }

    /**
     * Replaces same-key attributes, appends new ones (a later value wins).
     * @param {{into: Array<OtlpAttribute>, add: Array<OtlpAttribute>}} arg0
     * @returns {Array<OtlpAttribute>}
     */
    function mergeAttributes({ into, add }) {
        for (const attr of add) {
            const at = into.findIndex((a) => a.key === attr.key);
            if (at === -1) into.push(attr);
            else into[at] = attr;
        }
        return into;
    }

    /**
     * Scalar key/value pairs as attributes (non-scalars skipped).
     * @param {{pairs: Record<string, unknown>}} arg0
     * @returns {Array<OtlpAttribute>}
     */
    function attrs({ pairs }) {
        return Object.entries(pairs).map(([key, value]) => toAttribute({ key, value, computed: true })).filter((a) => a !== null);
    }

    /**
     * The gen_ai semantic-convention attributes of an operation.
     * @param {{operation: string, provider?: unknown, model?: unknown}} arg0
     * @returns {Array<OtlpAttribute>}
     */
    function genAi({ operation, provider, model }) {
        const providerName = typeof provider === 'string' && provider ? (GEN_AI_PROVIDERS[provider] ?? provider) : null;
        return attrs({ pairs: { 'gen_ai.operation.name': operation, 'gen_ai.provider.name': providerName, 'gen_ai.request.model': model } });
    }

    /**
     * `gen_ai.usage.*` from the SDK's usage vocabulary.
     * @param {{usage: any}} arg0
     * @returns {Array<OtlpAttribute>}
     */
    function usageAttributes({ usage }) {
        if (!usage || typeof usage !== 'object') return [];
        return attrs({ pairs: { 'gen_ai.usage.input_tokens': usage.prompt_tokens, 'gen_ai.usage.output_tokens': usage.completion_tokens } });
    }

    /**
     * @param {{name: string, kind: number, ids: {traceId: string, spanId: string, parentSpanId?: string}, startNs: bigint, attributes?: Array<OtlpAttribute>}} arg0
     * @returns {OtlpSpan} A span not yet buffered (its end and status are set by `endSpan`).
     */
    function openSpan({ name, kind, ids, startNs, attributes = [] }) {
        return {
            traceId: ids.traceId,
            spanId: ids.spanId,
            ...(ids.parentSpanId ? { parentSpanId: ids.parentSpanId } : {}),
            name,
            kind,
            startTimeUnixNano: startNs.toString(),
            endTimeUnixNano: startNs.toString(),
            attributes,
            events: [],
            status: { code: STATUS_UNSET }
        };
    }

    /**
     * Ends a span and buffers it.
     * @param {{span: OtlpSpan, status: number, endNs?: bigint, attributes?: Array<OtlpAttribute>}} arg0
     * @returns {void}
     */
    function endSpan({ span, status, endNs = nowNs(), attributes = [] }) {
        span.endTimeUnixNano = endNs.toString();
        span.status = { code: status };
        mergeAttributes({ into: span.attributes, add: attributes });
        if (span.events && span.events.length === 0) delete span.events;
        spans.push(span);
        scheduleFlush();
    }

    /**
     * @returns {Promise<void>} Resolves once the batch was POSTed (or dropped).
     */
    async function flush() {
        if (spans.length === 0) return;
        const batch = spans.splice(0, spans.length);
        const body = JSON.stringify({
            resourceSpans: [{
                resource: { attributes: resourceAttrList },
                scopeSpans: [{ scope, spans: batch }]
            }]
        });
        try {
            const res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body,
                // A collector that accepts the connection and never answers
                // must not keep flush()/close() pending forever.
                signal: AbortSignal.timeout(LIMITS.otel_post_timeout_ms)
            });
            if (res && res.ok === false) {
                sdkWarn({ prefix: 'OTEL', args: [`export failed: HTTP ${res.status ?? '?'}`] });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sdkWarn({ prefix: 'OTEL', args: [`export failed: ${message}`] });
        }
    }

    /**
     * @returns {void}
     */
    function scheduleFlush() {
        if (spans.length >= batchSize) void flush().catch(() => {});
    }

    /**
     * Maps one SDK event onto the span tree: `run:start`/`run:end` open and close an
     * `invoke_agent` span, `tool:call_start`/`tool:call_end` an `execute_tool` span,
     * and any other event becomes a span event on the open span of its run (or its
     * parent run). An event with no open span to land on stays a zero-length span.
     * @param {{name: string, payload?: Record<string, unknown>}} arg0
     * @returns {void}
     */
    function recordEvent({ name, payload }) {
        if (closed) return;
        const eventName = String(name ?? 'event');
        if (observerActive && API_EVENT_NAMES.has(eventName)) return;
        const p = /** @type {Record<string, any>} */ (payload && typeof payload === 'object' ? payload : {});
        const runId = idString(p.runId);
        const parentRunId = idString(p.parentRunId);
        const at = nowNs();

        if (eventName === EVENTS.CLIENT.RUN_START && runId) {
            const ids = identityFor({ parents: [parentRunId], seed: runId });
            const span = openSpan({ name: 'invoke_agent', kind: KIND_INTERNAL, ids, startNs: at, attributes: mergeAttributes({ into: attributesFrom({ payloads: [p], event: eventName }), add: genAi({ operation: 'invoke_agent', provider: p.provider, model: p.model }) }) });
            remember({ map: spanOfRun, key: runId, value: ids });
            remember({ map: openRuns, key: runId, value: span, onEvict: endEvicted });
            return;
        }
        if (eventName === EVENTS.CLIENT.RUN_END && runId && openRuns.has(runId)) {
            const span = openRuns.get(runId);
            openRuns.delete(runId);
            const failed = p.failed === true || p.finishReason === 'error' || p.finishReason === 'aborted';
            // A tool call cut off by an abort never reports its end: the run's end ends it.
            for (const [key, toolSpan] of [...openTools]) {
                if (!key.startsWith(`${runId}:`)) continue;
                openTools.delete(key);
                endSpan({ span: toolSpan, status: failed ? STATUS_ERROR : STATUS_UNSET, endNs: at });
            }
            endSpan({ span, status: failed ? STATUS_ERROR : STATUS_OK, endNs: at, attributes: [...attributesFrom({ payloads: [p], event: eventName }), ...usageAttributes({ usage: p.usage })] });
            return;
        }
        if ((eventName === EVENTS.TOOL.CALL_START || eventName === EVENTS.TOOL.CALL_END) && runId) {
            const key = `${runId}:${idString(p.id) ?? idString(p.name) ?? 'tool'}`;
            const toolName = idString(p.name);
            const exportedToolName = isTechnicalName({ value: toolName }) ? toolName : null;
            if (eventName === EVENTS.TOOL.CALL_START) {
                const ids = identityFor({ parents: [runId, parentRunId], seed: runId });
                const span = openSpan({ name: exportedToolName ? `execute_tool ${exportedToolName}` : 'execute_tool', kind: KIND_INTERNAL, ids, startNs: at, attributes: [
                    ...attributesFrom({ payloads: [p], event: eventName }),
                    ...genAi({ operation: 'execute_tool' }),
                    ...attrs({ pairs: { 'gen_ai.tool.name': exportedToolName, 'gen_ai.tool.call.id': idString(p.id) } })
                ] });
                remember({ map: openTools, key, value: span, onEvict: endEvicted });
                return;
            }
            // A call refused before it started (blocked, replayed) ends without a start.
            const durationNs = BigInt(Math.max(0, Math.round(Number(p.durationMs) || 0))) * 1_000_000n;
            const span = openTools.get(key) ?? openSpan({ name: exportedToolName ? `execute_tool ${exportedToolName}` : 'execute_tool', kind: KIND_INTERNAL, ids: identityFor({ parents: [runId, parentRunId], seed: runId }), startNs: at - durationNs, attributes: [
                ...genAi({ operation: 'execute_tool' }),
                ...attrs({ pairs: { 'gen_ai.tool.name': exportedToolName, 'gen_ai.tool.call.id': idString(p.id) } })
            ] });
            openTools.delete(key);
            const failed = p.success === false;
            endSpan({ span, status: failed ? STATUS_ERROR : STATUS_OK, endNs: at, attributes: [...attributesFrom({ payloads: [p], event: eventName }), ...(failed ? attrs({ pairs: { 'error.type': 'tool_error' } }) : [])] });
            return;
        }

        const owner = (runId && (openChats.get(runId)?.span ?? openRuns.get(runId)))
            || (parentRunId && (openChats.get(parentRunId)?.span ?? openRuns.get(parentRunId)))
            || null;
        if (owner) {
            owner.events?.push({ timeUnixNano: at.toString(), name: eventName, attributes: attributesFrom({ payloads: [p], event: eventName }) });
            return;
        }
        const ids = identityFor({ parents: [runId, parentRunId], seed: runId });
        // The first loose span of a run is the parent of its later ones.
        if (runId && !spanOfRun.has(runId)) remember({ map: spanOfRun, key: runId, value: ids });
        const span = openSpan({ name: eventName, kind: KIND_INTERNAL, ids, startNs: at, attributes: attributesFrom({ payloads: [p], event: eventName }) });
        endSpan({ span, status: STATUS_OK, endNs: at });
    }

    /**
     * The open `chat` call a notification belongs to: by the step's runId, FIFO only
     * for a caller with no runContext. `take` removes it (the call ends).
     * @param {{runContext?: any, take?: boolean}} arg0
     * @returns {OpenSpan|null}
     */
    function chatCall({ runContext = null, take = false }) {
        const runId = idString(runContext?.runId);
        if (!runId) {
            // No run to match on: FIFO, first over context-less calls, then over the oldest correlated one.
            const oldest = pending.length > 0 ? null : openChats.entries().next().value ?? null;
            if (oldest && take) openChats.delete(oldest[0]);
            return (take ? (pending.shift() ?? oldest?.[1]) : (pending[pending.length - 1] ?? oldest?.[1])) ?? null;
        }
        const call = openChats.get(runId) ?? null;
        if (take) openChats.delete(runId);
        return call;
    }

    /**
     * Opens a `chat {model}` CLIENT span for one vendor call.
     * @param {{meta?: any, runContext?: any}} arg0
     * @returns {OpenSpan}
     */
    function openChat({ meta = null, runContext = null }) {
        const runId = idString(runContext?.runId);
        const parentRunId = idString(runContext?.parentRunId);
        const startMs = Date.now();
        const model = idString(meta?.model);
        const ids = identityFor({ parents: [runId, parentRunId], seed: runId });
        const span = openSpan({ name: model ? `chat ${model}` : 'chat', kind: KIND_CLIENT, ids, startNs: BigInt(startMs) * 1_000_000n, attributes: mergeAttributes({
            into: attributesFrom({ payloads: [meta, { runId, parentRunId }] }),
            add: genAi({ operation: 'chat', provider: meta?.provider, model })
        }) });
        if (runId && !spanOfRun.has(runId)) remember({ map: spanOfRun, key: runId, value: ids });
        return { span, startMs, attempts: 0 };
    }

    /**
     * Ends a `chat` call: on its terminal `onResponse` / `onError`.
     * @param {{meta?: any, runContext?: any, error?: boolean}} arg0
     * @returns {void}
     */
    function endChat({ meta = null, runContext = null, error = false }) {
        // A response with no open call (direct observer use) still records the call it reports.
        const call = chatCall({ runContext, take: true }) ?? (error ? null : openChat({ meta: null, runContext }));
        if (!call) return;
        const endMs = Date.now();
        const added = attributesFrom({ payloads: [meta] });
        if (typeof meta?.durationMs !== 'number') added.push(...attrs({ pairs: { durationMs: endMs - call.startMs } }));
        if (call.attempts > 0) added.push(...attrs({ pairs: { retryCount: call.attempts } }));
        added.push(...usageAttributes({ usage: meta?.usage }));
        if (error) {
            const err = meta?.error;
            // The message is free text: a failure is diagnosable by type, code and
            // permanence, which are bounded values (W2E-6).
            added.push(...attrs({ pairs: {
                'error.type': err?.name ?? 'Error',
                'error.code': err?.code,
                'error.permanent': err?.nonRetryable
            } }));
        } else if (meta?.aborted) {
            added.push(...attrs({ pairs: { 'error.type': 'aborted' } }));
        }
        endSpan({ span: call.span, status: error || meta?.ok === false ? STATUS_ERROR : STATUS_OK, endNs: BigInt(endMs) * 1_000_000n, attributes: added });
    }

    if (flushIntervalMs > 0) {
        timer = setInterval(() => { void flush().catch(() => {}); }, flushIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    /** @type {OtlpExporter} */
    const exporter = {
        onEvent({ name, payload }) {
            recordEvent({ name, payload });
        },

        onRequest({ meta, runContext = null }) {
            if (closed) return;
            observerActive = true;
            const call = openChat({ meta, runContext });
            const runId = idString(/** @type {any} */ (runContext)?.runId);
            if (runId) remember({ map: openChats, key: runId, value: call, onEvict: (/** @type {OpenSpan} */ evicted) => endEvicted(evicted.span) });
            else pending.push(call);
        },

        onResponse({ meta, runContext = null }) {
            if (closed) return;
            observerActive = true;
            endChat({ meta, runContext });
        },

        onError({ meta, runContext = null }) {
            if (closed) return;
            observerActive = true;
            // Nothing open: the call already ended — no second span.
            endChat({ meta, runContext, error: true });
        },

        onRetry({ runContext = null }) {
            if (closed) return;
            observerActive = true;
            const call = chatCall({ runContext });
            if (!call) return;
            call.attempts += 1;
        },

        attach({ emitter }) {
            if (!emitter || typeof emitter.on !== 'function') return () => {};
            /** @param {any} envelope */
            const handler = (envelope) => {
                try {
                    const name = envelope?.event ?? envelope?.type;
                    if (!name) return;
                    recordEvent({ name: String(name), payload: envelope });
                } catch { /* telemetry must never break the observed run */ }
            };
            const anyEmitter = /** @type {any} */ (emitter);
            if (typeof anyEmitter.onAny === 'function') return anyEmitter.onAny(handler);
            const names = canonicalEventNames();
            for (const name of names) emitter.on(name, handler);
            return () => {
                for (const name of names) {
                    if (typeof emitter.off === 'function') emitter.off(name, handler);
                    else if (typeof emitter.removeListener === 'function') emitter.removeListener(name, handler);
                }
            };
        },

        async flush() {
            await flush();
        },

        async close() {
            // A span still open at close (a run or call that never ended) is exported as
            // it stands, its status unset, rather than lost.
            for (const span of [...openRuns.values(), ...openTools.values(), ...[...openChats.values(), ...pending].map((c) => c.span)]) {
                endSpan({ span, status: STATUS_UNSET });
            }
            openRuns.clear(); openTools.clear(); openChats.clear(); pending.length = 0;
            closed = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            await flush();
        },

        getSpans() {
            return [...spans];
        }
    };

    return exporter;
}
