// @ts-check
/**
 * @file Merci SDK 0.7.2 GAI (Google GenAI)
 * @version 0.12.0
 * @author Lukas Michna (Mobeetle)
 * @license Apache-2.0 — see the LICENSE file at the repository root.
 *
 * @description
 * A fluent and event-driven client for the Gemini and Vertex wire APIs, over
 * the SDK's built-in native `fetch` transport (`./transport/gai-client.mjs`).
 */

import { EventEmitter } from 'node:events';
import { BaseChatSession } from '../agentic/chat-session.mjs';
import { buildParameterMapForGai } from '../messaging/unified-parameter.mjs';
import { sdkWarn, mapProfileListError, getErrorStatus, isEmbeddingUnsupportedStatus, grpcToHttpStatus, resolveBaseUrl, resolveProtocol, ensureEnvLoaded, getEmbeddingModel } from '../support/utils.mjs';
import { embedRetryPolicyFrom, runWithRetry } from '../support/retry-policy.mjs';
import {
    EnvKey,
    ProviderType,
    StandardType,
} from '../core/constants/index.mjs';
import { gaiAdapter } from './adapters/gai-adapter.mjs';
import { createGaiTransport, gaiBaseURL } from './transport/gai-client.mjs';
import { createDecisionsClient } from './decisions/index.mjs';
import { createGoogleAuth } from './transport/google-auth.mjs';
import { readTransportOptions } from './transport/options.mjs';
import { readClosedOptions } from '../support/options.mjs';
import { isRecordObject } from '../support/validation.mjs';
import { EVENTS, stampEvent } from '../core/events.mjs';
import { ConfigurationError } from '../core/errors.mjs';

/**
 * Manages a chat session with an LLM.
 */
export class ChatSession extends BaseChatSession {
    /**
 * Accepts a single options object (`{ client, model, eventEmitter, protocol, provider }`).
 * @param {{client?: Object, model?: string, eventEmitter?: EventEmitter, protocol?: string|null, provider?: string, sessionId?: string|null}} arg0
 */
    constructor({ client, model, eventEmitter, protocol = null, provider = ProviderType.GOOGLE_GENAI, sessionId = null } = {}) {
        super({ vendorClient: client ?? null, model: /** @type {string} */ (model), eventEmitter, provider, builderStandard: StandardType.GAI, adapter: /** @type {any} */ (gaiAdapter), buildParameters: buildParameterMapForGai, sessionId });
        this.protocol = /** @type {string} */ (resolveProtocol({ provider, protocol: protocol ?? undefined, session: true }));
    }
}

/**
 * A parsed Google credential JSON the auth module reads.
 * @typedef {Record<string, unknown>} GoogleCredential
 */

/**
 * The `googleAuthOptions` bag `createGoogleAuth` reads.
 * @typedef {Object} GoogleAuthOptions
 * @property {GoogleCredential} [credentials]
 * @property {string} [keyFile]
 * @property {Array<string>} [scopes]
 */

/**
 * The validated `genaiOptions` bag. `enterprise` is treated as `vertexai`.
 * @typedef {Object} GenaiOptions
 * @property {boolean} [vertexai]
 * @property {boolean} [enterprise]
 * @property {string} [project]
 * @property {string} [location]
 * @property {string} [apiVersion]
 * @property {GoogleAuthOptions} googleAuthOptions
 */

/**
 * The `options` object this client reads.
 * @typedef {Object} GaiClientOptions
 * @property {string} [apiKey]
 * @property {string} [baseURL]
 * @property {string} [protocol]
 * @property {unknown} [genaiOptions]
 * @property {{fetch?: typeof fetch, defaultHeaders?: Record<string, string|null|undefined>, timeout?: number, maxRetries?: number}} [transportOptions]
 */

/**
 * The `genaiOptions` keys the native transport understands, and the
 * `googleAuthOptions` bag nested under it.
 */
const GENAI_OPTION_KEYS = ['vertexai', 'enterprise', 'project', 'location', 'apiVersion', 'googleAuthOptions'];
const GOOGLE_AUTH_OPTION_KEYS = ['credentials', 'keyFile', 'scopes'];

/**
 * Validates `options.genaiOptions.googleAuthOptions`: the three values
 * `createGoogleAuth` reads. Unknown keys are refused instead of ignored.
 * @param {{value?: unknown}} arg0
 * @returns {GoogleAuthOptions}
 */
function readGoogleAuthOptions({ value } = {}) {
    const record = readClosedOptions({
        value,
        allowed: GOOGLE_AUTH_OPTION_KEYS,
        name: 'googleAuthOptions',
        label: 'options.genaiOptions.googleAuthOptions'
    });
    if (record === null) return {};
    return /** @type {GoogleAuthOptions} */ (record);
}

/**
 * Validates `options.genaiOptions`: the closed Vertex/Gemini bag the transport
 * consumes. `enterprise` is the historical spelling of `vertexai`;
 * `httpOptions` points at `options.transportOptions` because it was the SDK's
 * per-client HTTP seam and must not be mistaken for one now.
 * @param {{value?: unknown}} arg0
 * @returns {GenaiOptions}
 */
function readGenaiOptions({ value } = {}) {
    // Before the closed-key loop: `httpOptions` is a known key with its own
    // migration message, not an unknown one. The record test is the shared one,
    // so a non-object still gets the shape message from `readClosedOptions`.
    if (isRecordObject(value) && 'httpOptions' in value) {
        throw new ConfigurationError({ message: 'options.genaiOptions.httpOptions is not supported: pass options.transportOptions (fetch, defaultHeaders, timeout) instead. A per-call config.httpOptions still works.', options: { option: 'genaiOptions.httpOptions' } });
    }
    const record = readClosedOptions({
        value,
        allowed: GENAI_OPTION_KEYS,
        name: 'genaiOptions',
        label: 'options.genaiOptions'
    });
    if (record === null) return { googleAuthOptions: {} };
    return /** @type {GenaiOptions} */ ({
        ...record,
        googleAuthOptions: readGoogleAuthOptions({ value: record.googleAuthOptions }),
    });
}

/**
 * Main Merci SDK client for Google GenAI.
 * @property {Object} transport - The call-level transport (the seven-method contract the adapter consumes).
 * @property {import('./decisions/client.mjs').DecisionsClient} decisions - Typed judgment calls (Gemini Decisions on the Gemini Developer API); see `lib/backends/decisions/`.
 * @property {import('../support/retry-policy.mjs').RetryPolicy} embedRetryPolicy - The shared `embed()` retry policy.
 */
export class MerciClient extends EventEmitter {
    /**
 * @param {{options?: Object}} arg0
 *   (e.g. `{ vertexai: true, project, location, googleAuthOptions: { credentials } }` inside
 *   `genaiOptions` for Vertex).
 */
    constructor({ options = {} } = {}) {
        super();
        const callOptions = /** @type {GaiClientOptions} */ (options);
        const genaiOptions = readGenaiOptions({ value: callOptions.genaiOptions });
        const transportOptions = readTransportOptions({ value: callOptions.transportOptions });
        const isVertex = genaiOptions.vertexai === true || genaiOptions.enterprise === true;
        const apiKey = isVertex
            ? callOptions.apiKey || undefined
            : callOptions.apiKey || process.env[EnvKey.GEMINI_API_KEY];
        if (!isVertex && !apiKey) {
            throw new ConfigurationError({ message: "API Key is required. Provide it via options.apiKey or GEMINI_API_KEY env variable." });
        }

        const location = genaiOptions.location ?? 'global';
        const defaultBaseURL = gaiBaseURL({ vertexai: isVertex, location });
        const baseURL = resolveBaseUrl({ explicit: callOptions.baseURL, envKey: null, fallback: defaultBaseURL }) ?? defaultBaseURL;
        // Vertex Express keeps the API key; every other Vertex client resolves
        // ADC lazily on its first request, so a missing credential surfaces there.
        const auth = isVertex && !apiKey
            ? createGoogleAuth({
                credentials: genaiOptions.googleAuthOptions.credentials,
                keyFile: genaiOptions.googleAuthOptions.keyFile,
                scopes: genaiOptions.googleAuthOptions.scopes,
                fetch: transportOptions.fetch,
            })
            : undefined;

        this.provider = isVertex ? ProviderType.VERTEX : ProviderType.GOOGLE_GENAI;
        this.standard = StandardType.GAI;
        this.vertexai = isVertex;
        this.protocol = /** @type {string} */ (resolveProtocol({ provider: this.provider, protocol: callOptions.protocol, session: true }));
        this.embedRetryPolicy = embedRetryPolicyFrom({ options: /** @type {any} */ (options) });

        Object.defineProperty(this, 'transport', {
            value: createGaiTransport({
                apiKey,
                auth,
                vertexai: isVertex,
                project: genaiOptions.project,
                location,
                apiVersion: genaiOptions.apiVersion,
                baseURL,
                defaultHeaders: transportOptions.defaultHeaders,
                fetch: transportOptions.fetch,
                timeoutMs: transportOptions.timeout,
                maxRetries: 0,
            }),
            writable: true,
            configurable: true,
            enumerable: false
        });

        // Gemini Decision 1 lives on the Gemini Developer API; `ask()` names the
        // provider when it is Vertex instead of failing at construction.
        this.decisions = createDecisionsClient({
            provider: this.provider,
            apiKey,
            baseURL,
            defaultHeaders: transportOptions.defaultHeaders,
            fetchImpl: transportOptions.fetch,
            timeoutMs: transportOptions.timeout,
            emitter: this
        });
    }

    /**
     * Creates a new chat session.
     * @param {string|{model: string, sessionId?: string|null}} modelOrOptions - The model identifier, or `{ model, sessionId }`.
     * @returns {ChatSession}
     */
    session(modelOrOptions) {
        const options = modelOrOptions && typeof modelOrOptions === 'object' ? modelOrOptions : { model: /** @type {string} */ (modelOrOptions) };
        return new ChatSession({ client: /** @type {any} */ (this).transport, model: options.model, eventEmitter: this, protocol: this.protocol, provider: this.provider, sessionId: options.sessionId ?? null });
    }

    /**
     * @param {{model: string, sessionId?: string|null}} arg0
     * @returns {ChatSession}
     */
    sessionWithId({ model, sessionId = null }) {
        return this.session({ model, sessionId });
    }

    /**
     * Retrieves the list of available models.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getProfiles() {
        try {
            const response = await (/** @type {any} */ (this)).transport.models.list();
            const models = [];
            for await (const model of response) {
                models.push({ id: model.name, name: model.displayName || model.name });
            }
            return models;
        } catch (error) {
            return mapProfileListError({ error: /** @type {Error} */ (error) });
        }
    }

    /**
 * Generates embeddings for input. The retry policy is the one
 * `embedRetryPolicyFrom()` builds for this client (maxRetries / delays from
 * the limit registry); the policy decides whether each failed attempt is
 * retried and how long to wait. `signal` aborts the backoff sleep and the
 * request itself, exactly like the OpenAI `embed()`.
 * @param {{input: string|string[], model?: string, signal?: AbortSignal|null}} arg0
 * @returns {Promise<Array<number>|Array<Array<number>|null>|null>} One vector for a
 *   string input; an ordered array aligned with the input for an array input
 *   (a failed item is `null`); null on graceful failure.
 */
    async embed({ input, model, signal = null }) {
        ensureEnvLoaded();
        model = model || getEmbeddingModel({ provider: this.provider });
        if (!model) {
            sdkWarn({ prefix: 'MerciClient', args: [`No embedding model configured for backend '${this.provider}'. Set DEFAULT_${String(this.provider).toUpperCase()}_EMBEDDING_MODEL (or DEFAULT_GEMINI_EMBEDDING_MODEL) in secret.env. Vector features disabled.`] });
            return null;
        }
        const isBatch = Array.isArray(input);
        if (isBatch && this.vertexai) {
            return /** @type {any} */ (Promise.all(input.map((text) => this.embed({ input: text, model, signal }))));
        }
        const inputLen = isBatch ? input.length : String(input ?? '').length;
        const startTs = Date.now();
        let retries = 0;
        this.emit(EVENTS.CLIENT.EMBED_START, stampEvent({ name: EVENTS.CLIENT.EMBED_START, payload: { model, inputLen } }));
        try {
            const response = await runWithRetry({
                operation: async () => (/** @type {any} */ (this)).transport.models.embedContent({
                    model,
                    contents: isBatch ? input.map((text) => ({ parts: [{ text }] })) : input,
                    config: { abortSignal: signal ?? undefined }
                }),
                policy: this.embedRetryPolicy,
                signal,
                onRetry: /** @type {(...args: any[]) => any} */ ((meta) => {
                    retries += 1;
                    sdkWarn({ prefix: 'MerciClient', args: [`Embedding failed: ${meta.error.message}. Retrying in ${Math.round(meta.nextDelayMs)}ms...`] });
                })
            });
            if (isBatch) {
                const vectors = (response.embeddings ?? []).map((/** @type {any} */ e) => e?.values ?? null);
                this.emit(EVENTS.CLIENT.EMBED_FINISH, stampEvent({ name: EVENTS.CLIENT.EMBED_FINISH, payload: {
                    model, inputLen, vectorLen: vectors[0]?.length ?? 0, durationMs: Date.now() - startTs, retries
                } }));
                return vectors.length ? vectors : null;
            }
            const embedding = response.embeddings?.[0]?.values;
            if (!embedding) {
                sdkWarn({ prefix: 'MerciClient', args: [`Google GenAI returned no embedding for model '${model}'.`] });
                this.emit(EVENTS.CLIENT.EMBED_FINISH, stampEvent({ name: EVENTS.CLIENT.EMBED_FINISH, payload: {
                    model, inputLen, vectorLen: 0, durationMs: Date.now() - startTs, retries
                } }));
                return null;
            }
            const isAllZeros = embedding.every((/** @type {number} */ v) => v === 0);
            if (isAllZeros) {
                sdkWarn({ prefix: 'MerciClient', args: [`Model '${model}' returned an all-zero embedding vector.`] });
            }
            this.emit(EVENTS.CLIENT.EMBED_FINISH, stampEvent({ name: EVENTS.CLIENT.EMBED_FINISH, payload: {
                model, inputLen, vectorLen: embedding.length, durationMs: Date.now() - startTs, retries
            } }));
            return embedding;
        } catch (error) {
            const errObj = /** @type {{ code?: string, message?: string }} */ (error);
            const status = getErrorStatus({ error }) ?? grpcToHttpStatus({ code: errObj.code });
            if (isEmbeddingUnsupportedStatus({ status, message: errObj.message })) {
                sdkWarn({ prefix: 'MerciClient', args: [`Embedding unavailable on this endpoint (HTTP ${status}) for model '${model}'. Vector features disabled; lexical search still works.`] });
                this.emit(EVENTS.CLIENT.EMBED_FINISH, stampEvent({ name: EVENTS.CLIENT.EMBED_FINISH, payload: {
                    model, inputLen, vectorLen: 0, durationMs: Date.now() - startTs, retries
                } }));
                return null;
            }
            this.emit(EVENTS.CLIENT.EMBED_ERROR, stampEvent({ name: EVENTS.CLIENT.EMBED_ERROR, payload: {
                model, inputLen, durationMs: Date.now() - startTs, retries, error: errObj.message ?? String(error)
            } }));
            if (this.listenerCount('error') > 0) this.emit('error', error);
            throw error;
        }
    }
}