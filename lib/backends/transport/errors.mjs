// @ts-check
/**
 * @file Error factories for the shared fetch transport.
 * @version 0.22.0
 *
 * @description
 * Builds the plain `Error` shapes the OpenAI SDK produced — `APIError.makeMessage`
 * under `makeStatusError` for a non-2xx response, `new APIError(...)` for a
 * stream error chunk: an API error whose message, `status`, `headers`,
 * `requestID`, `error`, `code`, `type` and `param` are own properties, plus the
 * connection, abort and timeout errors. The API errors keep `name` `'Error'` so
 * `isAbortError` in `lib/core/errors.mjs` classifies on the cause chain; only
 * the abort error carries `name: 'AbortError'`.
 *
 * The Anthropic and Google factories reproduce those clients' own error
 * surfaces (`@anthropic-ai/sdk@1.5.0`, `@google/genai@2.32.0`) without touching
 * the OpenAI one.
 */

import { STATUS_CODES } from 'node:http';
import { asRecord } from '../../support/object.mjs';

/**
 * The own-property surface of an API error.
 * @typedef {Error & {status?: number, headers?: Headers, requestID?: string|null, error?: unknown, code?: unknown, type?: unknown, param?: unknown}} ApiErrorShape
 */

/**
 * The message `APIError.makeMessage` built: the error field's `message` (a
 * string as is, anything else JSON), else the whole field as JSON, else the raw
 * text body.
 * @param {{status?: number, errorField?: unknown, text?: string}} arg0
 * @returns {string}
 */
function apiErrorMessage({ status, errorField, text }) {
    const fieldMessage = errorField && typeof errorField === 'object'
        ? /** @type {Record<string, unknown>} */ (errorField).message
        : undefined;
    const message = fieldMessage
        ? (typeof fieldMessage === 'string' ? fieldMessage : JSON.stringify(fieldMessage))
        : errorField != null
            ? JSON.stringify(errorField)
            : text;
    if (status && message) return `${status} ${message}`;
    if (status) return `${status} status code (no body)`;
    if (message) return message;
    return '(no status code or body)';
}

/**
 * Assembles the error the SDK's `APIError` constructor produced, own properties
 * included. Exported so the vendor factories below can share the OpenAI shape.
 * @param {{status?: number, headers?: Headers, errorField?: unknown, text?: string}} arg0
 * @returns {ApiErrorShape}
 */
export function buildApiError({ status, headers, errorField, text }) {
    const error = /** @type {ApiErrorShape} */ (new Error(apiErrorMessage({ status, errorField, text })));
    if (status !== undefined) error.status = status;
    if (headers) {
        error.headers = headers;
        error.requestID = headers.get('x-request-id');
    }
    if (errorField !== undefined) {
        error.error = errorField;
        if (errorField && typeof errorField === 'object') {
            const record = /** @type {Record<string, unknown>} */ (errorField);
            if (record.code !== undefined) error.code = record.code;
            if (record.type !== undefined) error.type = record.type;
            if (record.param !== undefined) error.param = record.param;
        }
    }
    return error;
}

/**
 * Builds the API error a non-2xx response produced: `makeStatusError` wraps a
 * parsed body that has no `error` field as `{ error: body }`, then `APIError`
 * reads `error`, `code`, `type` and `param` from that field. A body that never
 * parsed is the text message (`null` when there was none).
 * @param {{status?: number, headers?: Headers, body?: unknown, text?: string}} arg0
 * @returns {ApiErrorShape}
 */
export function createApiErrorFromBody({ status, headers, body, text } = {}) {
    const record = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : undefined;
    const normalized = record && record.error == null ? { error: body } : body;
    const errorField = normalized == null ? undefined : /** @type {Record<string, unknown>} */ (normalized)['error'];
    return buildApiError({ status, headers, errorField, text });
}

/**
 * Builds the error a stream error chunk raised, exactly as
 * `new APIError(undefined, data?.error ?? data, undefined, response.headers)`.
 * @param {{error?: unknown, headers?: Headers}} arg0
 * @returns {ApiErrorShape}
 */
export function createStreamApiError({ error, headers } = {}) {
    return buildApiError({ status: undefined, headers, errorField: error, text: undefined });
}

/**
 * The own-property surface of an Anthropic API error: no `code`, no `param`.
 * @typedef {Error & {status?: number, headers?: Headers, requestID?: string|null, error?: unknown, apiMessage?: unknown, type?: unknown, errorCode?: string|null, details?: unknown}} AnthropicApiErrorShape
 */

/**
 * Builds the error `@anthropic-ai/sdk@1.5.0`'s `APIError` constructor produced:
 * the message from the whole body (a text body is the message, an empty one is
 * `'<status> status code (no body)'`), and the Anthropic-only own properties
 * `apiMessage`, `type`, `errorCode` and `details`. It reads `request-id`, never
 * `x-request-id`, and has no `code` or `param`.
 * @param {{status?: number, headers?: Headers, body?: unknown, text?: string, type?: unknown}} arg0
 * @returns {AnthropicApiErrorShape}
 */
export function createAnthropicApiError({ status, headers, body, text, type } = {}) {
    const record = asRecord({ value: body });
    const errorField = asRecord({ value: record?.error });
    const rawDetails = errorField?.details;
    const errorCode = asRecord({ value: rawDetails })?.error_code;
    const error = /** @type {AnthropicApiErrorShape} */ (new Error(
        apiErrorMessage({ status, errorField: body || undefined, text }),
    ));
    error.status = status;
    error.headers = headers;
    error.requestID = headers?.get('request-id');
    error.error = body;
    error.apiMessage = errorField?.message ?? null;
    error.type = type ?? errorField?.type ?? null;
    error.errorCode = typeof errorCode === 'string' ? errorCode : null;
    error.details = rawDetails ?? null;
    return error;
}

/**
 * Builds the error `@google/genai@2.32.0`'s `ApiError` produced: `name`
 * `'ApiError'`, the status, and the whole body as JSON in the message. A body
 * that never parsed becomes the SDK's synthesized
 * `{error: {message, code, status}}` first. `message` overrides the JSON body
 * message for the one caller whose wording is not the body: a stream error
 * frame (`got status: <status>. <body>`). No `code`. The response `headers` are
 * attached non-enumerably when given — the vendor error carried none, and the
 * retry policy reads `retry-after` / `x-should-retry` from them.
 * @param {{status?: number, statusText?: string, body?: unknown, text?: string, message?: string, headers?: Headers}} arg0
 * @returns {Error & {status?: number, headers?: Headers}}
 */
export function createGoogleApiError({ status, statusText, body, text, message, headers } = {}) {
    const errorBody = body === undefined
        ? { error: { message: text ?? '', code: status, status: statusText ?? (status === undefined ? '' : (STATUS_CODES[status] ?? '')) } }
        : body;
    const error = /** @type {Error & {status?: number, headers?: Headers}} */ (new Error(message ?? JSON.stringify(errorBody)));
    error.name = 'ApiError';
    error.status = status;
    if (headers) Object.defineProperty(error, 'headers', { value: headers, enumerable: false });
    return error;
}

/**
 * Builds the error for a failed `fetch` (DNS, refused connection, reset).
 * @param {{cause?: unknown}} arg0
 * @returns {Error}
 */
export function createConnectionError({ cause } = {}) {
    const error = new Error('Connection error.');
    if (cause !== undefined) error.cause = cause;
    return error;
}

/**
 * Builds the error for a caller abort. The name is `'AbortError'` so
 * `isAbortError` in `lib/core/errors.mjs` classifies it even when the signal
 * reason is a plain `Error`; the reason stays the cause.
 * @param {{cause?: unknown}} arg0
 * @returns {Error}
 */
export function createAbortError({ cause } = {}) {
    const error = new Error('Request was aborted.');
    error.name = 'AbortError';
    if (cause !== undefined) error.cause = cause;
    return error;
}

/**
 * Builds the error a 3xx response raises: model calls never follow a redirect,
 * because the request body and header credentials would reach the target
 * origin. The message names only that target's origin — never its path, query,
 * fragment or userinfo — and invents none when `Location` is missing or
 * unparsable. A relative `Location` is resolved against the request URL.
 * @param {{location?: string|null, requestUrl?: string}} arg0
 * @returns {Error & {nonRetryable: boolean}}
 */
export function createRedirectRefusedError({ location, requestUrl } = {}) {
    /** @type {string|undefined} */
    let origin;
    if (location) {
        try {
            origin = new URL(location, requestUrl).origin;
        } catch {
            origin = undefined;
        }
    }
    const error = /** @type {Error & {nonRetryable: boolean}} */ (
        new Error(`Requests do not follow redirects; the endpoint answered with a redirect ${origin ? `to ${origin}` : 'without a usable Location'}.`)
    );
    error.nonRetryable = true;
    return error;
}

/**
 * Builds the error for the request deadline elapsing before the response
 * headers (or, for a non-streaming call, its body) arrived. The message is the
 * OpenAI SDK's; `code` is ours so the retry classifier sees the timeout
 * structurally instead of matching the wording (`timed out`, not `timeout`).
 * @returns {Error}
 */
export function createTimeoutError() {
    const error = /** @type {Error & {code?: string}} */ (new Error('Request timed out.'));
    error.code = 'HEADER_TIMEOUT';
    return error;
}
