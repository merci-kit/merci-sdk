// @ts-check
/**
 * @file JAI Task V5 API + quota API clients.
 * @version 0.12.0
 *
 * @description
 * Drives the JAI `/task/*` endpoints: roster listing, streaming task
 * execution with an inactivity timeout, and the buffered `execute()` that
 * aggregates stream events into a single result. Also the `/quota/get`
 * credit snapshot (QuotaAPI).
 */

import { TextDecoderStream } from 'node:stream/web';
import { TaskSSEParserV5, readSSELines } from './sse-parser.mjs';
import { InactivityTimeoutPolicy } from '../../support/stream-timeout.mjs';
import { connectTimeoutMs } from './http-client.mjs';
import { ProviderType, ERROR_CODES } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { ConfigurationError, BackendError } from '../../core/errors.mjs';

const bodyTimeoutMs = () => connectTimeoutMs();

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/;

/**
 * The HTTP client the task/quota APIs drive: retry-aware fetch plus the
 * stream-inactivity budget the caller configured.
 * @typedef {Object} TaskHttpClient
 * @property {number} streamTimeout
 * @property {Function} _fetchWithRetry - `({path, options, attempts}) => Promise<{json, body}>`; the transport owns the exact shapes.
 */

/**
 * The per-call knobs `stream`/`execute`/`executeJson` take.
 * @typedef {Object} TaskStreamOptions
 * @property {AbortSignal|null} [signal]
 * @property {string} [version]
 */

/**
 * One SSE event of a task stream (the parser's shapes, flattened).
 * @typedef {Object} TaskStreamEvent
 * @property {string} [type]
 * @property {string} [content]
 * @property {string|null} [thoughtSignature]
 * @property {string} [reason]
 * @property {string} [message]
 * @property {Record<string, unknown>|null} [data] - The event's metadata payload.
 */

/**
 * JAI Task V5 API — task roster and streamed task execution.
 */
export class TaskAPI {
    /**
     * @type {TaskHttpClient}
     */
    #httpClient;

    /**
 * @param {{httpClient: TaskHttpClient}} arg0
 */
    constructor({ httpClient }) { this.#httpClient = httpClient; }

    /**
     * Lists available task definitions.
     * @returns {Promise<Record<string, unknown>>} The roster JSON payload.
     */
    async roster() {
        const timeoutMs = bodyTimeoutMs();
        const response = await this.#httpClient._fetchWithRetry({ path: '/task/roster', options: { method: 'GET', headerTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs } });
        return response.json();
    }

    /**
     * Shared task SSE transport: caller policy validates ids/versions and builds
     * parameters; this owns headers, abort bridging, retry, parsing, timeout,
     * raw event yields, and the final thought-signature event.
     * @param {{taskId: string, tag: string|null, version: string, parameters: Record<string, unknown>, signal?: AbortSignal|null, omitEmptyHeaders?: boolean}} arg0
     * @returns {AsyncGenerator<TaskStreamEvent>}
     */
    async* #taskEvents({ taskId, tag, version, parameters, signal = null, omitEmptyHeaders = false }) {
        const headers = {};
        if (tag) headers['Grazie-Task-Tag'] = tag;
        const requestBody = { parameters };
        const controller = new AbortController();
        const abortFromSignal = () => controller.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) controller.abort(signal.reason);
            else signal.addEventListener('abort', abortFromSignal, { once: true });
        }
        try {
            const response = await this.#httpClient._fetchWithRetry({ path: `/task/stream/${version}/${taskId}`, options: {
                method: 'POST',
                body: JSON.stringify(requestBody),
                ...(tag || !omitEmptyHeaders ? { headers } : {}),
                signal: controller.signal
            } });
            const parser = new TaskSSEParserV5();
            const stream = response.body.pipeThrough(new TextDecoderStream());
            const guardedStream = new InactivityTimeoutPolicy({ timeoutMs: this.#httpClient.streamTimeout })
                /** @param {{err: *}} arg0 */
                /** @param {{err: *}} arg0 */
                .wrapStream({ stream, signal, onTimeoutAbort: /** @type {(...args: any[]) => any} */ (({ err }) => controller.abort(err)) });
            for await (const event of readSSELines({ stream: guardedStream, parser })) yield event;
            const finalResult = parser.getFinalResult();
            if (finalResult.thoughtSignature) {
                yield { type: 'metadata', thoughtSignature: finalResult.thoughtSignature };
            }
        } finally {
            if (signal) signal.removeEventListener('abort', abortFromSignal);
        }
    }

    /**
 * Streams a task execution over SSE.
 * @param {{id: string, parameters: Record<string, unknown>, options?: TaskStreamOptions}} arg0
 * @returns {AsyncGenerator<TaskStreamEvent>} Streamed task events (plus a final metadata event with the thought signature).
 */
    async* stream({ id, parameters, options = {} }) {
        this.#validateId({ id });
        const { signal, version = 'v5' } = options;
        this.#validateId({ id: version, label: 'version' });
        const { taskId, tag } = this.#splitId({ id });
        yield* this.#taskEvents({ taskId, tag, version, parameters, signal });
    }

    /**
 * Runs a task to completion, buffering stream events into a single result.
 * @param {{id: string, parameters: Record<string, unknown>, options?: TaskStreamOptions}} arg0
 * @returns {Promise<Record<string, unknown>>} Aggregated result (content + all metadata + thought signature).
 */
    async execute({ id, parameters, options = {} }) {
        const stream = this.stream({ id, parameters, options });
        let content = '';
        const executionMetadata = [];
        const functionCallMetadata = [];
        const reasoningData = [];
        let quotaMetadata = null, finishMetadata = null, unknownMetadata = null;
        let thoughtSignature = null;
        for await (const event of stream) {
            if (event.thoughtSignature) thoughtSignature = event.thoughtSignature;
            switch (event.type) {
                case 'Content': content += event.content ?? ''; break;
                case 'QuotaMetadata': quotaMetadata = event.data; break;
                case 'ExecutionMetadata': executionMetadata.push(event.data); break;
                case 'FinishMetadata': finishMetadata = event.data; break;
                case 'UnknownMetadata': unknownMetadata = event.data; break;
                case 'FunctionCallMetadata': functionCallMetadata.push(event.data); break;
                case 'ReasoningData':
                    reasoningData.push(event.data);
                    break;
                case 'Error':
                    throw new BackendError({
                        message: `Task V5 stream failed: ${event.data?.error_message || event.data?.message || 'unknown task error'}`,
                        options: { provider: ProviderType.JAI, code: /** @type {any} */ (ERROR_CODES.BACKEND)?.INVALID_RESPONSE ?? ERROR_CODES.BACKEND },
                    });
                case 'PrematureEnd':
                    throw new BackendError({
                        message: `Task V5 stream ended prematurely: ${event.reason || 'unknown'}`,
                        options: { provider: ProviderType.JAI, code: /** @type {any} */ (ERROR_CODES.BACKEND)?.INVALID_RESPONSE ?? ERROR_CODES.BACKEND },
                    });
                case 'parse_error':
                    throw new BackendError({
                        message: event.message || 'Task V5 stream returned malformed SSE frame',
                        options: { provider: ProviderType.JAI, code: /** @type {any} */ (ERROR_CODES.BACKEND)?.INVALID_RESPONSE ?? ERROR_CODES.BACKEND },
                    });
                case 'metadata': thoughtSignature = event.thoughtSignature; break;
            }
        }
        return { content, quotaMetadata, executionMetadata, finishMetadata, unknownMetadata, functionCallMetadata, reasoningData, thoughtSignature };
    }

    /**
 * Runs a JSON task (e.g. web-search, web-scrape) to completion and returns
 * its parsed result. Streams the same SSE events as stream(), accumulates
 * the `Content` payload (a JSON string like `{answer, results[]}`), and
 * captures `QuotaMetadata.spent.amount` as quotaSpent. Throws on `Error`
 * events.
 * The caller owns the task's parameter shape. The `web-search` task gets
 * its required/default params filled in here (`maxResults` required;
 * `includeAnswer`/`includeDomains` defaulted); every other task (e.g.
 * `web-scrape`, which requires `url`) is passed through untouched.
 * @param {{taskId: string, parameters: Record<string, unknown>, options?: TaskStreamOptions}} arg0
 * @returns {Promise<Record<string, unknown>>}
 */
    async executeJson({ taskId, parameters, options = {} }) {
        this.#validateId({ id: taskId });
        const version = options.version ?? 'v4';
        this.#validateId({ id: version, label: 'version' });
        const { taskId: name, tag } = this.#splitId({ id: taskId });
        const params = /** @type {Record<string, any>} */ ({ ...(parameters ?? {}) });
        if (name === 'web-search') {
            params.maxResults ??= LIMITS.web_search_max_results;
            params.includeAnswer ??= 'basic';
            params.includeDomains ??= [];
        }
        const signal = options.signal ?? null;
        let raw = '';
        let quotaSpent = null;
        for await (const event of this.#taskEvents({ taskId: name, tag, version, parameters: params, signal, omitEmptyHeaders: true })) {
            switch (event.type) {
                case 'Content': raw += event.content ?? ''; break;
                case 'QuotaMetadata': quotaSpent = /** @type {any} */ (event.data)?.spent?.amount ?? null; break;
                case 'Error':
                    throw new BackendError({
                        message: `Task stream failed: ${event.data?.error_message || event.data?.message || 'unknown task error'}`,
                        options: { provider: ProviderType.JAI, code: /** @type {any} */ (ERROR_CODES.BACKEND)?.INVALID_RESPONSE ?? ERROR_CODES.BACKEND },
                    });
                case 'PrematureEnd':
                    throw new BackendError({
                        message: `Task stream ended prematurely: ${event.reason || 'unknown'}`,
                        options: { provider: ProviderType.JAI, code: /** @type {any} */ (ERROR_CODES.BACKEND)?.INVALID_RESPONSE ?? ERROR_CODES.BACKEND },
                    });
                case 'parse_error':
                    throw new BackendError({
                        message: event.message || 'Task stream returned malformed SSE frame',
                        options: { provider: ProviderType.JAI, code: /** @type {any} */ (ERROR_CODES.BACKEND)?.INVALID_RESPONSE ?? ERROR_CODES.BACKEND },
                    });
            }
        }

        let data = null;
        if (raw.trim() !== '') {
            try {
                data = JSON.parse(raw);
            } catch (err) {
                throw new BackendError({
                    message: `Task stream returned a malformed JSON payload: ${(/** @type {any} */ (err)).message}`,
                    options: { provider: 'jai', cause: err },
                });
            }
        }
        const result = /** @type {Record<string, any>} */ (data && typeof data === 'object' ? data : {});
        if (quotaSpent !== null) result.quotaSpent = quotaSpent;
        return result;
    }

    /**
     * Rejects ids that would inject path segments (J6) — the id is interpolated
     * raw into `/task/stream/…/<id>`.
     * @param {{id: string, label?: string}} arg0
     */
    #validateId({ id, label = 'task id' }) {
        if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
            throw new ConfigurationError({ message: `Invalid ${label} '${String(id)}'. Expected [A-Za-z0-9_-]+ with an optional :tag.` });
        }
    }

    /**
     * @param {{id: string}} arg0
     */
    #splitId({ id }) {
        const parts = id.split(':', 2);
        return { taskId: parts[0], tag: parts[1] || null };
    }
}

/**
 * JAI quota API — the account's credit snapshot (`/quota/get`).
 * The response shape mirrors the reference Java client (api-gateway 0.8.125):
 * `{ current: Quota }` with `Quota = { license, until, current: {amount},
 * maximum: {amount}, quotaID }`.
 */
export class QuotaAPI {
    /**
     * @type {TaskHttpClient}
     */
    #httpClient;

    /**
 * @param {{httpClient: TaskHttpClient}} arg0
 */
    constructor({ httpClient }) { this.#httpClient = httpClient; }

    /**
     * Fetches the account's current quota/credit snapshot.
     * @returns {Promise<Record<string, unknown>|null>} The `current` Quota payload, or null when absent.
     */
    async get() {
        const timeoutMs = bodyTimeoutMs();
        const response = await this.#httpClient._fetchWithRetry({ path: '/quota/get', options: { method: 'POST', headerTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs } });
        const data = await response.json();
        return data?.current ?? null;
    }
}
