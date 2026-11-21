// @ts-check
/**
 * @file Anthropic wire client rebuilt on the native fetch transport.
 * @version 0.22.0
 *
 * @description
 * The call surface the AAI adapter consumes from `@anthropic-ai/sdk@1.5.0` —
 * `messages.stream` and `models.list` — over `./http.mjs` and `./sse.mjs`, with
 * the SDK's event rules: a data-only frame and `ping` are dropped, an `error`
 * event becomes an Anthropic API error carrying the response headers, a
 * malformed frame is rethrown as a plain `Error`, a second `message_start`
 * before `message_stop` is an event-order failure, and a stream that never
 * started is `request ended without sending any chunks`.
 *
 * `models.list()` keeps the SDK's `PagePromise`: awaiting it gives one `Page`,
 * and iterating the promise itself auto-paginates with `?after_id=`.
 */

import { asRecord } from '../../support/object.mjs';
import { isAbortFailure } from './abort.mjs';
import { createAnthropicApiError } from './errors.mjs';
import { getJson, joinUrl, postStream } from './http.mjs';
import { iterateSseEvents } from './sse.mjs';

/** The API version header every Anthropic request carries. */
const ANTHROPIC_VERSION = '2026-10-21';

/** The OpenAI/Anthropic SSE `event:` name an error frame uses. */
const ERROR_EVENT = 'error';

/**
 * Parses a frame's `data` as JSON, or gives the raw string back (the SDK's
 * `safeJSON` fallback).
 * @param {{text: string}} arg0
 * @returns {unknown}
 */
function parseJsonOrRaw({ text }) {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * One page of `GET /v1/models`, with the pagination surface the Anthropic SDK's
 * `Page` exposed: `has_more` plus a `last_id` cursor, an empty page never has a
 * next one, and this page's own iterator walks every following page.
 */
class AaiPage {
    /**
     * @param {{body?: Record<string, unknown>|null, fetchPage: (afterId: string) => Promise<AaiPage>}} arg0
     */
    constructor({ body, fetchPage }) {
        /** @type {Array<Record<string, unknown>>} */
        this.data = Array.isArray(body?.data) ? /** @type {Array<Record<string, unknown>>} */ (body.data) : [];
        /** @type {boolean} */
        this.has_more = Boolean(body?.has_more);
        /** @type {string|null} */
        this.first_id = typeof body?.first_id === 'string' ? body.first_id : null;
        /** @type {string|null} */
        this.last_id = typeof body?.last_id === 'string' ? body.last_id : null;
        this.fetchPage = fetchPage;
    }

    /**
     * Whether a next page exists: `has_more`, at least one item, and a cursor.
     * @returns {boolean}
     */
    hasNextPage() {
        if (this.has_more === false) return false;
        return this.data.length > 0 && this.last_id !== null;
    }

    /**
     * Requests the page after this one.
     * @returns {Promise<AaiPage>}
     */
    async getNextPage() {
        if (!this.last_id) {
            throw new Error('No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.');
        }
        return this.fetchPage(this.last_id);
    }

    /**
     * Yields every item from this page onwards, requesting each next page.
     * @returns {AsyncGenerator<Record<string, unknown>, void, unknown>}
     */
    async *[Symbol.asyncIterator]() {
        /** @type {AaiPage|null} */
        let page = this;
        while (page) {
            for (const item of page.data) yield item;
            page = page.hasNextPage() ? await page.getNextPage() : null;
        }
    }
}

/**
 * The SDK's `models.list()` return value: a promise of one page that is itself
 * async-iterable and auto-paginates.
 * @typedef {Promise<AaiPage> & AsyncIterable<Record<string, unknown>>} AaiPagePromise
 */

/**
 * The transport's construction options.
 * @typedef {Object} AaiTransportOptions
 * @property {string} apiKey - Sent as `Authorization: Bearer <apiKey>`.
 * @property {string} baseURL - API root, e.g. `https://api.anthropic.com`.
 * @property {Record<string, string|null|undefined>} [defaultHeaders] - Under the per-call headers; a `null`/`undefined` value deletes that header.
 * @property {typeof fetch} [fetch] - Fetch implementation (defaults to the global).
 * @property {number} [timeoutMs] - Deadline for the response headers; `0` or a negative value uses the current `oai_request_timeout_ms` limit.
 * @property {number} [maxRetries] - Retained for surface parity; this transport never retries.
 */

/**
 * Per-call options: the caller's abort and headers (`x-merci-session-id`).
 * @typedef {Object} AaiCallOptions
 * @property {AbortSignal} [signal]
 * @property {Record<string, string|null|undefined>} [headers]
 */

/**
 * The SDK raised every fetch failure as an `APIError` with the same null vendor
 * fields; the shared transport's connection failure is recognisable by its
 * message, so the connector restores that surface for the stream reader.
 * @param {{error: unknown}} arg0
 * @returns {Error|null}
 */
function vendorTransportError({ error }) {
    const failure = /** @type {{message?: string}} */ (error);
    if (failure?.message === 'Connection error.') return createAnthropicApiError({ text: 'Connection error.' });
    return null;
}

/**
 * Reads the message events of an opened stream, applying the SDK's rules.
 * @param {{opened: Promise<Response & {body: ReadableStream<Uint8Array>, _releaseSignal?: () => void}>, signal?: AbortSignal}} arg0
 * @returns {AsyncGenerator<Record<string, unknown>, void, unknown>}
 */
async function* readMessageEvents({ opened, signal }) {
    try {
        const response = await opened;
        let sawMessageStart = false;
        for await (const frame of iterateSseEvents({ stream: response.body, cleanup: response._releaseSignal })) {
            if (frame.event === null || frame.event === 'ping') continue;
            if (frame.event === ERROR_EVENT) {
                const body = parseJsonOrRaw({ text: frame.data });
                throw createAnthropicApiError({ headers: response.headers, body, type: asRecord({ value: asRecord({ value: body })?.error })?.type });
            }
            if (!frame.data) continue;
            /** @type {Record<string, unknown>} */
            let event;
            try {
                event = /** @type {Record<string, unknown>} */ (JSON.parse(frame.data));
            } catch (error) {
                throw new Error(/** @type {Error} */ (error).message);
            }
            if (event.type === 'message_start') {
                if (sawMessageStart) throw new Error('Unexpected event order, got message_start before receiving "message_stop"');
                sawMessageStart = true;
            }
            yield event;
        }
        if (signal?.aborted) throw createAnthropicApiError({ text: 'Request was aborted.' });
        if (!sawMessageStart) throw new Error('request ended without sending any chunks');
    } catch (error) {
        if (isAbortFailure({ error, signal })) throw createAnthropicApiError({ text: 'Request was aborted.' });
        throw vendorTransportError({ error }) ?? error;
    }
}

/**
 * Creates the Anthropic transport.
 * @param {AaiTransportOptions} arg0
 * @returns {{
 *   apiKey: string,
 *   baseURL: string,
 *   maxRetries: number,
 *   messages: {stream: (body: Record<string, unknown>, opts?: AaiCallOptions) => AsyncIterable<Record<string, unknown>>},
 *   models: {list: () => AaiPagePromise}
 * }}
 */
export function createAaiTransport({ apiKey, baseURL, defaultHeaders, fetch: fetchImpl, timeoutMs, maxRetries = 0 }) {
    const auth = { name: 'Authorization', value: `Bearer ${apiKey}` };
    const sdkHeaders = { 'anthropic-version': ANTHROPIC_VERSION };
    /** @param {{status?: number, headers?: Headers, body?: unknown, text?: string}} arg0 @returns {Error} */
    const errorFactory = ({ status, headers, body, text }) => createAnthropicApiError({ status, headers, body, text });

    /**
     * Requests one models page, the first when `afterId` is null.
     * @param {{afterId: string|null}} arg0
     * @returns {Promise<AaiPage>}
     */
    const requestPage = async ({ afterId }) => {
        const path = afterId === null ? '/v1/models' : `/v1/models?after_id=${encodeURIComponent(afterId)}`;
        const body = /** @type {Record<string, unknown>|null} */ (await getJson({
            url: joinUrl({ baseURL, path }), auth, accept: 'application/json', sdkHeaders, defaultHeaders, fetchImpl, timeoutMs, errorFactory,
        }));
        return new AaiPage({ body, fetchPage: (nextAfterId) => requestPage({ afterId: nextAfterId }) });
    };

    return {
        apiKey,
        baseURL,
        maxRetries,
        messages: {
            /**
             * Opens the stream on call, as the SDK did; a failed open surfaces on
             * the first `next()`, never as a synchronous throw.
             * @param {Record<string, unknown>} body
             * @param {AaiCallOptions} [opts]
             * @returns {AsyncIterable<Record<string, unknown>>}
             */
            stream(body, opts) {
                const opened = postStream({
                    url: joinUrl({ baseURL, path: '/v1/messages' }), auth, accept: 'application/json', sdkHeaders, body,
                    defaultHeaders, headers: opts?.headers, signal: opts?.signal, fetchImpl, timeoutMs, errorFactory,
                });
                // A stream nobody consumes must not raise an unhandled rejection;
                // the reader still awaits this promise and throws.
                opened.catch(() => {});
                return { [Symbol.asyncIterator]: () => readMessageEvents({ opened, signal: opts?.signal }) };
            },
        },
        models: {
            /**
             * The SDK's `PagePromise`: `await` gives one page, iterating the
             * promise auto-paginates.
             * @returns {AaiPagePromise}
             */
            list() {
                const first = requestPage({ afterId: null });
                const pagePromise = /** @type {AaiPagePromise} */ (first);
                pagePromise[Symbol.asyncIterator] = async function* () {
                    for await (const item of await first) yield item;
                };
                return pagePromise;
            },
        },
    };
}
