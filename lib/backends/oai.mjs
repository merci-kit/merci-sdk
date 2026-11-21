// @ts-check
/**
 * @file Merci SDK 0.7.2 OAI
 * @version 0.12.0
 * @author Lukáš Michna (Mobeetle)
 * @license Apache-2.0 — see the LICENSE file at the repository root.
 *
 * @description
 * A fluent and event-driven client for the OpenAI wire protocol, over the
 * SDK's built-in native `fetch` transport (`./transport/`).
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BaseChatSession } from '../agentic/chat-session.mjs';
import { buildParameterMapForOai } from '../messaging/unified-parameter.mjs';
import { sdkWarn, mapProfileListError, getErrorStatus, isEmbeddingUnsupportedStatus, grpcToHttpStatus, resolveBaseUrl, resolveProtocol, ensureEnvLoaded, getEmbeddingModel } from '../support/utils.mjs';
import { embedRetryPolicyFrom, runWithRetry } from '../support/retry-policy.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import {
    DEFAULT_OPENROUTER_URL,
    DEFAULT_OPENAI_URL,
    DEFAULT_OPENCODE_URL,
    EnvKey,
    ProviderType,
    StandardType,
    providerDescriptorFor,
} from '../core/constants/index.mjs';
import { oaiAdapter, DEFAULT_RESPONSES_ASSISTANT_PART } from './adapters/oai-adapter.mjs';
import { createOaiTransport } from './transport/oai-client.mjs';
import { createDecisionsClient } from './decisions/index.mjs';
import { readTransportOptions } from './transport/options.mjs';
import { EVENTS, stampEvent } from '../core/events.mjs';

/**
 * Manages a chat session with an LLM.
 */
export class ChatSession extends BaseChatSession {
    /**
 * Accepts a single options object
 * (`{ client, model, eventEmitter, provider?, protocol?, responsesAssistantPartType?, opencodeSessionId? }`).
 * @param {{client?: Object, model?: string, eventEmitter?: EventEmitter, provider?: string, protocol?: string, responsesAssistantPartType?: string, opencodeSessionId?: string, sessionId?: string|null}} arg0
 */
    constructor({ client, model, eventEmitter, provider = ProviderType.OPENAI, protocol = 'completions', responsesAssistantPartType = DEFAULT_RESPONSES_ASSISTANT_PART, opencodeSessionId = undefined, sessionId = null } = {}) {
        super({ vendorClient: client ?? null, model: /** @type {string} */ (model), eventEmitter, provider: /** @type {string} */ (provider), builderStandard: StandardType.OAI, adapter: /** @type {any} */ (oaiAdapter), buildParameters: buildParameterMapForOai, sessionId });
        this.protocol = /** @type {string} */ (resolveProtocol({ provider, protocol, session: true }));
        this.responsesAssistantPartType = responsesAssistantPartType;
        if (opencodeSessionId) this.opencodeSessionId = opencodeSessionId;
    }
}

/**
 * Main Merci SDK client.
 * @property {ReturnType<typeof createOaiTransport>} transport - The native fetch connector (`createOaiTransport`), not the OpenAI SDK.
 * @property {import('./decisions/client.mjs').DecisionsClient} decisions - Typed judgment calls (OpenAI / OpenRouter decision wires); see `lib/backends/decisions/`.
 */
export class MerciClient extends EventEmitter {
    /** @type {string} */
    provider;
    /** @type {string} */
    standard;
    /** @type {string} */
    responsesAssistantPartType;
    /** @type {string|undefined} */
    opencodeSessionId;
    /** @type {import('../support/retry-policy.mjs').RetryPolicy} */
    embedRetryPolicy;

    /**
 * @param {{options?: Object}} arg0
 */
    constructor({ options = {} } = {}) {
        super();
        if (/** @type {any} */ (options).openaiOptions !== undefined) {
            throw new ConfigurationError({ message: "options.openaiOptions is no longer supported: the OAI transport is a native fetch connector. Pass the same values as options.transportOptions (fetch, defaultHeaders, timeout).", options: { option: 'openaiOptions' } });
        }
        const explicitBackend = /** @type {any} */ (options).provider;
        this.provider = explicitBackend || ProviderType.OPENAI;
        this.standard = StandardType.OAI;
        const descriptor = providerDescriptorFor({ provider: this.provider });
        const defaultBaseURL = (!explicitBackend && !/** @type {any} */ (options).apiKey && process.env[EnvKey.OPENROUTER_API_KEY])
            ? DEFAULT_OPENROUTER_URL
            : (descriptor?.baseURL ?? DEFAULT_OPENAI_URL);
        const baseURL = resolveBaseUrl({ explicit: /** @type {any} */ (options).baseURL, envKey: descriptor?.baseURLKey ?? null, fallback: defaultBaseURL }) ?? defaultBaseURL;
        const normalizedBaseURL = String(baseURL).replace(/\/+$/, '');
        let apiKey = /** @type {any} */ (options).apiKey;
        if (!apiKey && (normalizedBaseURL === DEFAULT_OPENROUTER_URL || explicitBackend === ProviderType.OPENROUTER)) {
            apiKey = process.env[EnvKey.OPENROUTER_API_KEY] || process.env[EnvKey.OPENAI_API_KEY];
        }
        if (!apiKey && (normalizedBaseURL === DEFAULT_OPENAI_URL || explicitBackend === ProviderType.OPENAI)) {
            apiKey = process.env[EnvKey.OPENAI_API_KEY];
        }
        if (!apiKey && (normalizedBaseURL === DEFAULT_OPENCODE_URL || explicitBackend === ProviderType.OPENCODE)) {
            apiKey = process.env[EnvKey.OPENCODE_API_KEY];
        }
        // Last resort: a no-provider client with no explicit URL used to infer
        // OpenRouter from OPENROUTER_API_KEY. A stray URL env key must not lose
        // that key; an explicit custom URL still never borrows it (C7).
        if (!apiKey && !explicitBackend && !/** @type {any} */ (options).baseURL && process.env[EnvKey.OPENROUTER_API_KEY]) {
            apiKey = process.env[EnvKey.OPENROUTER_API_KEY];
        }
        if (!apiKey) {
            throw new ConfigurationError({ message: "API Key is required. Provide it via options.apiKey, OPENROUTER_API_KEY, or OPENAI_API_KEY." });
        }

        this.protocol = /** @type {string} */ (resolveProtocol({ provider: this.provider, protocol: /** @type {any} */ (options).protocol, session: true }));
        this.responsesAssistantPartType = /** @type {any} */ (options).responsesAssistantPartType || DEFAULT_RESPONSES_ASSISTANT_PART;

        if (this.provider === ProviderType.OPENCODE) {
            this.opencodeSessionId = /** @type {any} */ (options).opencodeSessionId ?? /** @type {any} */ (options).sessionId ?? randomUUID();
        }

        const transportOptions = readTransportOptions({ value: /** @type {any} */ (options).transportOptions });
        const defaultHeaders = this.provider === ProviderType.OPENCODE
            ? { 'x-opencode-session': this.opencodeSessionId, ...transportOptions.defaultHeaders }
            : transportOptions.defaultHeaders;

        Object.defineProperty(this, 'transport', {
            value: createOaiTransport({
                apiKey,
                baseURL,
                defaultHeaders,
                fetch: transportOptions.fetch,
                timeoutMs: transportOptions.timeout,
                maxRetries: 0
            }),
            writable: true,
            configurable: true,
            enumerable: false
        });

        this.embedRetryPolicy = embedRetryPolicyFrom({ options: /** @type {any} */ (options) });

        // Decisions are stateless judgments, not sessions: the client reuses the
        // credentials and fetch it already resolved instead of a second config.
        this.decisions = createDecisionsClient({
            provider: this.provider,
            apiKey,
            baseURL,
            // Not `defaultHeaders`: the opencode session header is chat affinity,
            // and the decisions endpoint takes no session.
            defaultHeaders: transportOptions.defaultHeaders,
            fetchImpl: transportOptions.fetch,
            timeoutMs: transportOptions.timeout,
            emitter: this
        });
    }

    /**
 * Replaces the current `embed()` retry policy.
 * @param {{policy: import('../support/retry-policy.mjs').RetryPolicy}} arg0
 */
    withEmbedRetryPolicy({ policy }) {
        this.embedRetryPolicy = policy;
        return this;
    }

    /**
     * Creates a new chat session.
     * @param {string|{model: string, sessionId?: string|null}} modelOrOptions - The model identifier, or `{ model, sessionId }`.
     * @returns {ChatSession}
     */
    session(modelOrOptions) {
        const options = modelOrOptions && typeof modelOrOptions === 'object' ? modelOrOptions : { model: /** @type {string} */ (modelOrOptions) };
        return new ChatSession({ client: /** @type {any} */ (this).transport, model: options.model, eventEmitter: this, provider: this.provider, protocol: this.protocol, responsesAssistantPartType: this.responsesAssistantPartType, opencodeSessionId: this.opencodeSessionId, sessionId: options.sessionId ?? null });
    }

    /**
     * Creates a session with an explicit conversation id at construction, so
     * the one `session:start` carries the same id as the run events.
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
            const response = /** @type {{ data: Array<{ id: string }> }} */ (await (/** @type {any} */ (this)).transport.models.list());
            return response.data.map(model => ({ id: model.id, name: model.id }));
        } catch (error) {
            return mapProfileListError({ error: /** @type {Error} */ (error) });
        }
    }

    /**
 * Generates embeddings for input. The retry policy is the
 * `ExponentialBackoffPolicy` set on this client (or via
 * `withEmbedRetryPolicy()`); the policy decides whether each failed
 * attempt should be retried and how long to wait. An optional `signal`
 * makes the backoff sleep abort-aware.
 * @param {{input: string|Array<string>, model?: string, signal?: AbortSignal|null}} arg0
 * @returns {Promise<Array<number>|Array<Array<number>|null>|null>} One vector for a
 *   string input; an ordered array aligned with the input for an array input
 *   (a failed item is `null`); null if the whole call failed gracefully.
 */
    async embed({ input, model, signal = null }) {
        ensureEnvLoaded();
        model = model || getEmbeddingModel({ provider: this.provider });
        if (!model) {
            sdkWarn({ prefix: 'MerciClient', args: [`No embedding model configured for provider '${this.provider}'. Set DEFAULT_${String(this.provider).toUpperCase()}_EMBEDDING_MODEL (or DEFAULT_EMBEDDING_MODEL) in secret.env. Vector features disabled.`] });
            return null;
        }
        const lmStudioBlocked = Symbol('lm-studio');
        const isBatch = Array.isArray(input);
        const inputLen = isBatch ? input.length : String(input ?? '').length;
        const startTs = Date.now();
        let retries = 0;
        this.emit(EVENTS.CLIENT.EMBED_START, stampEvent({ name: EVENTS.CLIENT.EMBED_START, payload: { model, inputLen } }));
        try {
            const result = await runWithRetry({ operation: async () => {
                try {
                    const response = await (/** @type {any} */ (this)).transport.embeddings.create({
                        model,
                        input,
                    });
                    /** @param {{embedding: *}} arg0 */
                    const checkVector = ({ embedding }) => {
                        if (!embedding) return null;
                        if (embedding.every(/** @type {(...args: any[]) => any} */ (v => v === 0))) {
                            sdkWarn({ prefix: 'MerciClient', args: [`Warning: Model '${model}' returned an all-zero embedding vector. Vector search may not work correctly.`] });
                        }
                        return embedding;
                    };

                    if (isBatch) {
                        return [...response.data]
                            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                            .map(item => checkVector({ embedding: item.embedding }));
                    }

                    const embedding = checkVector({ embedding: response.data[0]?.embedding });
                    if (!embedding) {
                        sdkWarn({ prefix: 'MerciClient', args: [`Model '${model}' returned no embedding vector.`] });
                        return null;
                    }

                    return embedding;
                } catch (error) {
                    const e = /** @type {{ status?: number, message?: string }} */ (error);
                    if (e.status === 400 && e.message?.toLowerCase().includes('no models loaded')) {
                        sdkWarn({ prefix: 'MerciClient', args: [`Embedding failed: LM Studio has no embedding models loaded. Vector features will be disabled.`] });
                        return lmStudioBlocked;
                    }
                    throw error;
                }
            }, policy: this.embedRetryPolicy, signal, onRetry: /** @type {(...args: any[]) => any} */ ((meta) => { retries += 1; sdkWarn({ prefix: 'MerciClient', args: [`Embedding failed: ${meta.error.message}. Retrying in ${Math.round(meta.nextDelayMs)}ms...`] }); }) });
            const vector = result === lmStudioBlocked ? null : result;
            this.emit(EVENTS.CLIENT.EMBED_FINISH, stampEvent({ name: EVENTS.CLIENT.EMBED_FINISH, payload: {
                model, inputLen, vectorLen: Array.isArray(vector) ? (Array.isArray(vector[0]) ? vector[0].length : vector.length) : 0, durationMs: Date.now() - startTs, retries
            } }));
            return vector;
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