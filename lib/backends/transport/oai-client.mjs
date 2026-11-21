// @ts-check
/**
 * @file OAI wire client rebuilt on the native fetch transport.
 * @version 0.22.0
 *
 * @description
 * The call surface the OAI adapter consumes from the `openai` SDK —
 * `chat.completions.create`, `responses.create`, `embeddings.create` and
 * `models.list` — over `./http.mjs` and `./sse.mjs`. The namespaces are plain
 * writable data properties so a host or test can replace them wholesale.
 */

import { getJson, joinUrl, postJson, postStream } from './http.mjs';
import { iterateSseJson } from './sse.mjs';
import { isStreamIterable, nonJsonStreamError, readBodyPrefix, requireStreamFrames, singleUse } from './stream.mjs';

/**
 * The transport's construction options.
 * @typedef {Object} OaiTransportOptions
 * @property {string} apiKey - Sent as a bearer token (never omitted when set, even a local placeholder).
 * @property {string} baseURL - API root, e.g. `https://api.openai.com/v1`.
 * @property {Record<string, string|null|undefined>} [defaultHeaders] - Headers under the per-call ones; a `null`/`undefined` value deletes that header.
 * @property {typeof fetch} [fetch] - Fetch implementation (defaults to the global).
 * @property {number} [timeoutMs] - Deadline for headers and, for a non-streaming call, the body; `0` or a negative value uses the current `oai_request_timeout_ms` limit.
 * @property {number} [maxRetries] - Retained for surface parity; this transport never retries.
 */

/**
 * Per-call options.
 * @typedef {Object} OaiCallOptions
 * @property {AbortSignal} [signal]
 * @property {Record<string, string|null|undefined>} [headers]
 */

/**
 * A body that cannot be a `{ data: [...] }` model list (a raw string, number or
 * array). Non-retryable, and loud instead of spreading a string into numbered
 * keys and an empty list.
 * @param {{body: unknown}} arg0
 * @returns {TypeError & {code: string, nonRetryable: boolean}}
 */
function modelsBodyError({ body }) {
    const observed = body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body;
    const text = typeof body === 'string' ? body : (body === null || body === undefined ? '' : JSON.stringify(body));
    const prefix = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const error = /** @type {TypeError & {code: string, nonRetryable: boolean}} */ (
        new TypeError(`OAI /models answered with ${observed} instead of a JSON object${prefix ? ` (body starts with: ${JSON.stringify(prefix)})` : ''}.`)
    );
    error.code = 'NON_OBJECT_MODELS_BODY';
    error.nonRetryable = true;
    return error;
}

/**
 * The SDK's chat-chunk normalisation: a chunk that has `choices` gets
 * `finish_reason: null` where the vendor omitted it, and no key is added or
 * dropped otherwise.
 * @param {{chunk: unknown}} arg0
 * @returns {unknown}
 */
function normalizeChatChunk({ chunk }) {
    const record = /** @type {Record<string, unknown>} */ (chunk);
    if (!Array.isArray(record?.choices)) return chunk;
    return {
        ...record,
        choices: record.choices.map((choice) => ({
            .../** @type {Record<string, unknown>} */ (choice),
            finish_reason: /** @type {Record<string, unknown>} */ (choice).finish_reason ?? null,
        })),
    };
}

/**
 * Whether a non-stream JSON answer is a complete vendor object (the gateway
 * ignored `stream: true`) rather than a body the SSE path cannot use.
 * @param {{body: unknown}} arg0
 * @returns {boolean}
 */
function isFullResponseBody({ body }) {
    if (!body || typeof body !== 'object') return false;
    const record = /** @type {Record<string, unknown>} */ (body);
    if (record.object === 'response' || Array.isArray(record.output)) return true;
    return Array.isArray(record.choices) && record.choices.some((/** @type {any} */ c) => c && c.message);
}

/**
 * Yields every chat chunk through {@link normalizeChatChunk}.
 * @param {{source: AsyncIterable<unknown>}} arg0
 * @returns {AsyncGenerator<unknown, void, unknown>}
 */
async function* normalizedChatChunks({ source }) {
    for await (const chunk of source) yield normalizeChatChunk({ chunk });
}

/**
 * Builds the aggregated `output_text` of a Responses object, as the SDK's
 * `addOutputText` did: every `message` output item's `output_text` parts joined
 * in order, always set — in place, so the non-enumerable `_request_id` survives.
 * A missing or non-iterable `output` throws exactly as the SDK's `for…of` did.
 * @param {{body: unknown}} arg0
 * @returns {unknown}
 */
function withOutputText({ body }) {
    if (!body || typeof body !== 'object') return body;
    // Named `rsp` on purpose: the SDK's own iterable guard surfaces as
    // `TypeError: rsp.output is not iterable`, and the parity fixtures pin it.
    const rsp = /** @type {Record<string, unknown>} */ (body);
    if (rsp.object !== 'response') return body;
    /** @type {Array<string>} */
    const texts = [];
    for (const item of /** @type {Array<Record<string, unknown>>} */ (rsp.output)) {
        if (item?.type !== 'message') continue;
        for (const part of /** @type {Array<Record<string, unknown>>} */ (item.content)) {
            if (part?.type === 'output_text') texts.push(String(part.text));
        }
    }
    rsp.output_text = texts.join('');
    return rsp;
}

/**
 * The caller's `encoding_format`, if it is truthy (the SDK's
 * `hasUserProvidedEncodingFormat`).
 * @param {{body: unknown}} arg0
 * @returns {unknown}
 */
function userEncodingFormat({ body }) {
    return (body && typeof body === 'object') ? /** @type {Record<string, unknown>} */ (body).encoding_format : undefined;
}

/**
 * Forces base64 embeddings on the wire when the caller did not pick a format,
 * without touching the caller's object.
 * @param {{body: unknown}} arg0
 * @returns {Record<string, unknown>}
 */
function embeddingsBody({ body }) {
    const record = /** @type {Record<string, unknown>} */ (body);
    return { ...record, encoding_format: userEncodingFormat({ body }) || 'base64' };
}

/**
 * Decodes one base64 wire vector into a Float32 array of numbers.
 * @param {{base64: string}} arg0
 * @returns {Array<number>}
 */
function decodeBase64Embedding({ base64 }) {
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    if (bytes.byteLength % 4 !== 0) throw new RangeError('Invalid base64-encoded float32 array: byte length must be a multiple of 4');
    return Array.from(new Float32Array(bytes.buffer));
}

/**
 * Decodes every base64 embedding in a response, in place so the non-enumerable
 * `_request_id` survives, skipping entries whose `embedding` is already an array.
 * @param {{body: unknown}} arg0
 * @returns {unknown}
 */
function decodeEmbeddings({ body }) {
    if (!body || typeof body !== 'object') return body;
    const record = /** @type {Record<string, unknown>} */ (body);
    if (record.data === undefined) return body;
    if (!Array.isArray(record.data)) throw new TypeError('Expected embeddings response data to be an array');
    record.data = record.data.map((item) => {
        const entry = /** @type {Record<string, unknown>} */ (item);
        if (entry && typeof entry === 'object' && !Array.isArray(entry.embedding)) {
            entry.embedding = decodeBase64Embedding({ base64: /** @type {string} */ (entry.embedding) });
        }
        return entry;
    });
    return record;
}

/**
 * Creates the OAI transport.
 * @param {OaiTransportOptions} arg0
 * @returns {{
 *   apiKey: string,
 *   baseURL: string,
 *   maxRetries: number,
 *   chat: {completions: {create: (body: Record<string, unknown>, opts?: OaiCallOptions) => Promise<unknown>}},
 *   responses: {create: (body: Record<string, unknown>, opts?: OaiCallOptions) => Promise<unknown>},
 *   embeddings: {create: (body: Record<string, unknown>, opts?: OaiCallOptions) => Promise<unknown>},
 *   models: {list: () => Promise<unknown>}
 * }}
 */
export function createOaiTransport({ apiKey, baseURL, defaultHeaders, fetch: fetchImpl, timeoutMs, maxRetries = 0 }) {
    /**
     * @param {{path: string, body: Record<string, unknown>, opts?: OaiCallOptions}} arg0
     * @returns {Promise<unknown>}
     */
    const post = ({ path, body, opts }) => postJson({
        url: joinUrl({ baseURL, path }), apiKey, body, defaultHeaders, headers: opts?.headers, signal: opts?.signal, fetchImpl, timeoutMs,
    });

    /**
     * @param {{path: string, body: Record<string, unknown>, opts?: OaiCallOptions}} arg0
     * @returns {Promise<(Response & {body: ReadableStream<Uint8Array>, _releaseSignal?: () => void, _mediaType?: string}) | AsyncIterable<unknown>>}
     */
    const stream = async ({ path, body, opts }) => {
        const response = await postStream({
            url: joinUrl({ baseURL, path }), apiKey, body, defaultHeaders, headers: opts?.headers, signal: opts?.signal, fetchImpl, timeoutMs,
        });
        // Compare the media type, not the whole header: `text/event-stream;
        // charset=utf-8` is SSE, `text/plain` is what a FastAPI/Flask proxy
        // serves, and an absent type stays tolerated.
        const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        Object.defineProperty(response, '_mediaType', { value: mediaType, enumerable: false });
        if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
            let prefix = '';
            try { prefix = await readBodyPrefix({ response }); } catch { /* nothing to name */ }
            response._releaseSignal?.();
            throw nonJsonStreamError({ mediaType, prefix: prefix.replace(/\s+/g, ' ').trim().slice(0, 120) });
        }
        // A gateway that ignores `stream: true` answers with the complete
        // object. Yield it once, marked terminal, so the adapter's
        // `isFullResponse` path consumes it instead of failing the call. A
        // JSON body that is neither a complete object nor an `error` envelope
        // (A-11) cannot produce a frame and is a non-stream answer.
        if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
            let text;
            try {
                text = await response.text();
            } finally {
                response._releaseSignal?.();
            }
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                throw nonJsonStreamError({ mediaType });
            }
            const envelope = parsed && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : null;
            if (!isFullResponseBody({ body: parsed }) && !envelope?.error) throw nonJsonStreamError({ mediaType });
            const state = { sawDone: true };
            return singleUse({ source: (async function* () { yield parsed; })(), state });
        }
        return response;
    };

    return {
        apiKey,
        baseURL,
        maxRetries,
        chat: {
            completions: {
                /**
                 * The SDK's positional `create(body, opts)` surface, called that
                 * way by the OAI adapter (scripts/guideline-exceptions.json).
                 * @param {Record<string, unknown>} body
                 * @param {OaiCallOptions} [opts]
                 * @returns {Promise<unknown>}
                 */
                async create(body, opts) {
                    if (body?.stream) {
                        const response = await stream({ path: '/chat/completions', body, opts });
                        if (isStreamIterable({ value: response })) return response;
                        const sse = /** @type {Response & {body: ReadableStream<Uint8Array>, _releaseSignal?: () => void, _mediaType?: string}} */ (response);
                        const state = { sawDone: false };
                        return singleUse({
                            source: requireStreamFrames({
                                source: normalizedChatChunks({
                                    source: iterateSseJson({ stream: sse.body, signal: opts?.signal, headers: sse.headers, cleanup: sse._releaseSignal, state }),
                                }),
                                mediaType: sse._mediaType ?? '',
                                state,
                            }),
                            state,
                        });
                    }
                    return post({ path: '/chat/completions', body, opts });
                },
            },
        },
        responses: {
            /**
             * Positional `create(body, opts)`, as above.
             * @param {Record<string, unknown>} body
             * @param {OaiCallOptions} [opts]
             * @returns {Promise<unknown>}
             */
            async create(body, opts) {
                if (body?.stream) {
                    const response = await stream({ path: '/responses', body, opts });
                    if (isStreamIterable({ value: response })) return response;
                    const sse = /** @type {Response & {body: ReadableStream<Uint8Array>, _releaseSignal?: () => void, _mediaType?: string}} */ (response);
                    const state = { sawDone: false };
                    return singleUse({
                        source: requireStreamFrames({
                            source: iterateSseJson({ stream: sse.body, signal: opts?.signal, headers: sse.headers, cleanup: sse._releaseSignal, state }),
                            mediaType: sse._mediaType ?? '',
                            state,
                        }),
                        state,
                    });
                }
                return withOutputText({ body: await post({ path: '/responses', body, opts }) });
            },
        },
        embeddings: {
            /**
             * Positional `create(body, opts)`, as above.
             * @param {Record<string, unknown>} body
             * @param {OaiCallOptions} [opts]
             * @returns {Promise<unknown>}
             */
            async create(body, opts) {
                const parsed = await post({ path: '/embeddings', body: embeddingsBody({ body }), opts });
                return userEncodingFormat({ body }) ? parsed : decodeEmbeddings({ body: parsed });
            },
        },
        models: {
            /**
             * Positional `list(options)`, as the SDK: per-call headers and
             * signal reach the request.
             * @param {OaiCallOptions} [opts]
             * @returns {Promise<unknown>}
             */
            async list(opts) {
                const parsed = await getJson({
                    url: joinUrl({ baseURL, path: '/models' }), apiKey, defaultHeaders, headers: opts?.headers, signal: opts?.signal, fetchImpl, timeoutMs,
                });
                // A string, number or array spread into numbered keys is a
                // silent empty model list; name the wrong body instead. A
                // `null`/`undefined` body already fails loudly on `.data`, and
                // its recorded error stays untouched.
                if (typeof parsed === 'string' || typeof parsed === 'number' || Array.isArray(parsed)) {
                    throw modelsBodyError({ body: parsed });
                }
                const list = /** @type {Record<string, unknown>} */ (parsed);
                // In place, so the non-enumerable `_request_id` survives.
                if (list.data === undefined) list.data = [];
                return list;
            },
        },
    };
}
