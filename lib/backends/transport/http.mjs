// @ts-check
/**
 * @file Native fetch transport for the shared fetch/SSE layer the OAI, Anthropic and Google connectors use.
 * @version 0.22.0
 *
 * @description
 * The HTTP half of the OAI transport: URL and header construction, the
 * request deadline, response parsing with OpenAI SDK parity, and the error
 * mapping the OAI backend classifies on. Retries are the caller's policy —
 * this module never retries.
 */

import { SDK_VERSION } from '../../core/constants/index.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { TRUNCATION_MARKER } from '../../core/constants/limits/transport.mjs';
import { readBodyTextCappedResult } from '../../support/body.mjs';
import { redactUrl } from '../../support/redact.mjs';
import { isAbortFailure } from './abort.mjs';
import { createAbortError, createApiErrorFromBody, createConnectionError, createRedirectRefusedError, createTimeoutError } from './errors.mjs';

/**
 * The first-headers (connect + headers) deadline, not an inactivity timer, read
 * per request so `setLimits()` takes effect. The default reproduces the OpenAI
 * SDK's 600 s; `transportOptions.timeout` or the
 * `MERCI_LIMIT_OAI_REQUEST_TIMEOUT_MS` env key overrides it.
 * @returns {number}
 */
export function defaultRequestTimeoutMs() {
    return LIMITS.oai_request_timeout_ms;
}

/**
 * Joins a base URL and an API path with exactly one slash between them, keeping
 * a query the base URL carries. The path is joined to the query-less URL and the
 * base query is appended last, so `https://gw/openai?api-version=1` plus
 * `/chat/completions` is `https://gw/openai/chat/completions?api-version=1`.
 * A base URL that is not absolute, or that carries userinfo, is a
 * configuration error — whose message names the origin only, never the
 * credential (A-13).
 * @param {{baseURL: string, path: string}} arg0
 * @returns {string}
 */
export function joinUrl({ baseURL, path }) {
    /** @type {URL} */
    let parsed;
    try {
        parsed = new URL(baseURL);
    } catch {
        throw new ConfigurationError({ message: `Invalid baseURL '${redactUrl({ url: baseURL })}': an absolute URL is required.`, options: { option: 'baseURL' } });
    }
    if (parsed.username || parsed.password) {
        throw new ConfigurationError({ message: `Invalid baseURL '${redactUrl({ url: baseURL })}': userinfo in the URL is not supported.`, options: { option: 'baseURL' } });
    }
    const query = parsed.search;
    parsed.search = '';
    parsed.hash = '';
    const joined = parsed.href.replace(/\/+$/, '') + path;
    if (!query) return joined;
    return joined + (joined.includes('?') ? '&' : '?') + query.slice(1);
}

/**
 * The header a vendor sends instead of the bearer token (Anthropic's
 * `x-api-key`, Google's `x-goog-api-key`).
 * @typedef {{name: string, value: string}} AuthHeader
 */

/**
 * Builds the request headers: bearer auth (or the vendor's `auth` header), JSON
 * content type (POST only), accept, this SDK's user agent, then any
 * `sdkHeaders`, then the client's default headers, then the per-call headers
 * (last wins). A `null` or `undefined` value deletes the header instead of
 * sending it, as the vendor client did. `accept: null` leaves the header off
 * (Google sends none); `userAgent` overrides the SDK-shaped agent.
 * @param {{apiKey?: string, auth?: AuthHeader, defaultHeaders?: Record<string, string|null|undefined>, headers?: Record<string, string|null|undefined>, json?: boolean, accept?: string|null, userAgent?: string, sdkHeaders?: Record<string, string|null|undefined>}} arg0
 * @returns {Headers}
 */
export function buildHeaders({ apiKey, auth, defaultHeaders, headers, json = true, accept = 'application/json', userAgent = `merci-sdk/${SDK_VERSION}`, sdkHeaders } = {}) {
    const result = new Headers();
    if (auth) result.set(auth.name, auth.value);
    else if (apiKey) result.set('Authorization', `Bearer ${apiKey}`);
    if (json) result.set('Content-Type', 'application/json');
    if (accept !== null) result.set('Accept', accept);
    result.set('User-Agent', userAgent);
    for (const layer of [sdkHeaders, defaultHeaders, headers]) {
        for (const [name, value] of Object.entries(layer ?? {})) {
            if (value === null || value === undefined) result.delete(name);
            else result.set(name, value);
        }
    }
    return result;
}

/**
 * Parses JSON, or gives `undefined` when the text is not JSON (the SDK's
 * `safeJSON`).
 * @param {{text: string}} arg0
 * @returns {unknown}
 */
function safeJsonText({ text }) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * The statuses retried on their own, mirroring the retry policy's set: a 4xx
 * outside it is final even when its body was cut (A-14).
 */
const RETRYABLE_ERROR_STATUSES = new Set([408, 409, 429]);

/**
 * Reads an error body as the SDK split it: the parsed JSON when it parses and is
 * truthy, else the raw text (`errJSON` / `errMessage`). `text` is `''` for an
 * empty body. `truncated` is the reader's own verdict — bytes remained beyond
 * the byte cap — so a complete body that fills the cap is not mistaken for a
 * cut one.
 * @param {{response: Response}} arg0
 * @returns {Promise<{body?: unknown, text?: string, truncated: boolean}>}
 */
async function readErrorBody({ response }) {
    const { text, truncated } = await readErrorBodyText({ response }).catch(() => ({ text: '', truncated: false }));
    const parsed = text ? safeJsonText({ text }) : undefined;
    return { body: parsed, text: parsed ? undefined : text, truncated };
}

/**
 * Reads an error response body up to the current `max_error_body_bytes` through
 * the shared bounded reader, which cancels the rest so a huge or endless body
 * cannot be buffered. The cap is read per request so `setLimits()` takes effect.
 * @param {{response: Response}} arg0
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function readErrorBodyText({ response }) {
    return readBodyTextCappedResult({ response, maxBytes: LIMITS.max_error_body_bytes });
}

/**
 * The effective deadline: an explicit positive finite `timeoutMs`, else the
 * current limit.
 * @param {{timeoutMs?: number}} arg0
 * @returns {number}
 */
function resolveTimeoutMs({ timeoutMs }) {
    const explicit = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    return explicit || defaultRequestTimeoutMs();
}

/**
 * Classifies a failure that happened while the deadline was armed: the caller's
 * abort first, then the request deadline, else the original error. Only a
 * failure shaped like the abort may be relabelled, so a malformed body keeps
 * its `SyntaxError`.
 * @param {{cause: unknown, controller: AbortController, signal?: AbortSignal}} arg0
 * @returns {unknown}
 */
function deadlineError({ cause, controller, signal }) {
    if (isAbortFailure({ error: cause, signal })) return createAbortError({ cause: signal?.reason });
    if (isAbortFailure({ error: cause, signal: controller.signal })) return createTimeoutError();
    return cause;
}

/**
 * Marks a parsed JSON body with the response's `x-request-id`, non-enumerably
 * and only for a non-array object, as the SDK's `addRequestID` did.
 * @param {{value: unknown, response: Response}} arg0
 * @returns {unknown}
 */
function addRequestId({ value, response }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    Object.defineProperty(value, '_request_id', { value: response.headers.get('x-request-id'), enumerable: false });
    return value;
}

/**
 * Sends one request and returns the response once its status is 2xx, keeping
 * the deadline armed until the optional `read` (the body read and parse for a
 * non-streaming call) settles, so a stalled body is `Request timed out.` A
 * non-positive or non-finite `timeoutMs` uses {@link defaultRequestTimeoutMs}.
 *
 * The caller's signal is linked through one `abort` listener (never
 * `AbortSignal.any`, whose dependents outlive the request), removed on every
 * path. With `keepSignalLink` the link survives the return so a later abort
 * still cancels the body; the caller then owns `_releaseSignal`.
 *
 * `errorFactory` builds the error a non-2xx response raises, from the same
 * `{status, statusText, headers, body, text}`; a vendor connector passes its own
 * surface and the default stays the OpenAI one. A message longer than
 * `max_error_message_chars` is cut with a `…[truncated]` marker. An error body
 * the byte cap cut is marked `bodyTruncated`; it is also `nonRetryable` only
 * when its status is a 4xx outside 408/409/429 — a cut 429 or 5xx keeps the
 * retry policy and `retry-after` in charge.
 * @param {{method: string, url: string, apiKey?: string, auth?: AuthHeader, body?: unknown, defaultHeaders?: Record<string, string|null|undefined>, headers?: Record<string, string|null|undefined>, accept?: string|null, userAgent?: string, sdkHeaders?: Record<string, string|null|undefined>, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number, read?: (arg0: {response: Response}) => Promise<unknown>, keepSignalLink?: boolean, errorFactory?: (arg0: {status?: number, statusText?: string, headers?: Headers, body?: unknown, text?: string}) => Error}} arg0
 * @returns {Promise<unknown>}
 */
async function sendRequest({ method, url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl = fetch, timeoutMs, read, keepSignalLink = false, errorFactory = createApiErrorFromBody }) {
    // A signal aborted before the call is the caller's abort: no timer, no fetch.
    if (signal?.aborted) throw createAbortError({ cause: signal.reason });
    // A header value HTTP cannot carry (a non-Latin-1 key, an invalid name) or a
    // body JSON cannot express is a caller mistake: it is raised before the
    // request exists, so nothing is sent and no retry can multiply it. Left in
    // the fetch `try`, it surfaced as `Connection error.` and was retried.
    /** @type {Headers} */
    let requestHeaders;
    try {
        requestHeaders = buildHeaders({ apiKey, auth, accept, userAgent, sdkHeaders, defaultHeaders, headers, json: method !== 'GET' });
    } catch (cause) {
        throw new ConfigurationError({ message: 'Cannot build the request headers: a name or value is not a valid HTTP header.', options: { option: 'headers', cause, nonRetryable: true } });
    }
    /** @type {string|undefined} */
    let requestBody;
    if (body !== undefined) {
        try {
            requestBody = JSON.stringify(body);
        } catch (cause) {
            throw new ConfigurationError({ message: 'The request body is not JSON-serialisable.', options: { option: 'body', cause, nonRetryable: true } });
        }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolveTimeoutMs({ timeoutMs }));
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    /** Clears the deadline and unlinks the caller's signal. */
    const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    };
    /** @type {Response} */
    let response;
    try {
        response = await fetchImpl(url, {
            method,
            headers: requestHeaders,
            ...(requestBody === undefined ? {} : { body: requestBody }),
            signal: controller.signal,
            redirect: 'manual',
        });
    } catch (cause) {
        release();
        if (isAbortFailure({ error: cause, signal })) throw createAbortError({ cause: signal?.reason });
        if (isAbortFailure({ error: cause, signal: controller.signal })) throw createTimeoutError();
        // An abort-shaped failure is the only one this state explains; anything
        // else keeps its own identity instead of claiming a cancel or timeout.
        if (signal?.aborted || controller.signal.aborted) throw cause;
        throw createConnectionError({ cause });
    }
    // Refused before any body read: following would re-POST the body and header
    // credentials to the target origin. The body is cancelled first so the
    // refused keep-alive connection is not parked in the pool.
    if (response.status >= 300 && response.status <= 399) {
        release();
        await response.body?.cancel?.().catch(() => {});
        throw createRedirectRefusedError({ location: response.headers.get('location'), requestUrl: url });
    }
    try {
        if (!response.ok) {
            const errorBody = await readErrorBody({ response });
            const error = /** @type {Error & {bodyTruncated?: boolean, nonRetryable?: boolean}} */ (errorFactory({
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: errorBody.body,
                text: errorBody.text,
            }));
            if (error.message.length > LIMITS.max_error_message_chars) {
                error.message = `${error.message.slice(0, LIMITS.max_error_message_chars)}${TRUNCATION_MARKER}`;
            }
            if (errorBody.truncated) {
                // A-14: the vendor's verdict (a fatal code, `x-should-retry`) may
                // have been past the cap, so a status that is not retryable by
                // itself is final. 408/409/429 and every 5xx stay retryable: a
                // rate limit or an outage is decided by the policy and
                // `retry-after`, not by a body we could not read whole.
                error.bodyTruncated = true;
                if (response.status >= 400 && response.status < 500
                    && !RETRYABLE_ERROR_STATUSES.has(response.status)) error.nonRetryable = true;
            }
            throw error;
        }
        if (read) return await read({ response });
    } catch (cause) {
        release();
        throw deadlineError({ cause, controller, signal });
    } finally {
        if (!keepSignalLink) release();
    }
    // Streaming handoff: the deadline covered the headers only, and the abort
    // link must outlive this call so a later caller abort still cancels the read.
    clearTimeout(timer);
    Object.defineProperty(response, '_releaseSignal', { value: release, enumerable: false });
    return response;
}

/**
 * Decides the parsed value from the status and the content type, as the SDK
 * did: 204 is null, a non-JSON media type is its raw text (`''` when empty), a
 * JSON media type is `undefined` for `content-length: 0` or empty text and is
 * otherwise parsed (malformed JSON throws the raw `SyntaxError`).
 * @param {{response: Response}} arg0
 * @returns {Promise<unknown>}
 */
async function readJsonBody({ response }) {
    if (response.status === 204) return null;
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const isJson = mediaType.includes('application/json') || mediaType.endsWith('+json');
    if (!isJson) return response.text();
    if (response.headers.get('content-length') === '0') return undefined;
    const text = await response.text();
    if (!text) return undefined;
    return addRequestId({ value: JSON.parse(text), response });
}

/**
 * Posts a JSON body and returns the parsed answer.
 * @param {{url: string, apiKey?: string, auth?: AuthHeader, body?: unknown, defaultHeaders?: Record<string, string|null|undefined>, headers?: Record<string, string|null|undefined>, accept?: string|null, userAgent?: string, sdkHeaders?: Record<string, string|null|undefined>, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number, errorFactory?: (arg0: {status?: number, statusText?: string, headers?: Headers, body?: unknown, text?: string}) => Error}} arg0
 * @returns {Promise<unknown>}
 */
export async function postJson({ url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory }) {
    return sendRequest({ method: 'POST', url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory, read: readJsonBody });
}

/**
 * Performs a GET and returns the parsed answer.
 * @param {{url: string, apiKey?: string, auth?: AuthHeader, defaultHeaders?: Record<string, string|null|undefined>, headers?: Record<string, string|null|undefined>, accept?: string|null, userAgent?: string, sdkHeaders?: Record<string, string|null|undefined>, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number, errorFactory?: (arg0: {status?: number, statusText?: string, headers?: Headers, body?: unknown, text?: string}) => Error}} arg0
 * @returns {Promise<unknown>}
 */
export async function getJson({ url, apiKey, auth, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory }) {
    return sendRequest({ method: 'GET', url, apiKey, auth, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory, read: readJsonBody });
}

/**
 * Posts a JSON body and returns the streaming response after the status check.
 * The deadline covers the wait for headers only, then the caller owns the body.
 * The response carries a non-enumerable `_releaseSignal` the reader must call
 * once the body is consumed, so the caller's abort stays linked until then.
 *
 * `raw` hands the `Response` over exactly as received: no body check, no media
 * type handling, the caller decodes it and raises its own empty-body error. The
 * Google connector needs that — it parses SSE frames itself and must see a bare
 * JSON answer unchanged. The OpenAI connector's HTML/JSON media-type special
 * casing lives in `oai-client.mjs` and never runs for a `raw` caller.
 * @param {{url: string, apiKey?: string, auth?: AuthHeader, body?: unknown, defaultHeaders?: Record<string, string|null|undefined>, headers?: Record<string, string|null|undefined>, accept?: string|null, userAgent?: string, sdkHeaders?: Record<string, string|null|undefined>, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number, raw?: boolean, errorFactory?: (arg0: {status?: number, statusText?: string, headers?: Headers, body?: unknown, text?: string}) => Error}} arg0
 * @returns {Promise<Response & {body: ReadableStream<Uint8Array>, _releaseSignal?: () => void}>}
 */
export async function postStream({ url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, raw = false, errorFactory }) {
    const response = /** @type {Response & {body: ReadableStream<Uint8Array>, _releaseSignal?: () => void}} */ (
        await sendRequest({ method: 'POST', url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory, keepSignalLink: true })
    );
    if (raw) return response;
    if (!response.body) {
        response._releaseSignal?.();
        throw new Error('Response body is null');
    }
    return response;
}
