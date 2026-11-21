// @ts-check
/**
 * @file Merci SDK 0.7.2 AAI (Anthropic AI)
 * @version 0.12.0
 * @author Lukáš Michna (Mobeetle)
 * @license Apache-2.0 — see the LICENSE file at the repository root.
 *
 * @description
 * A fluent and event-driven client for the Anthropic Messages API, over the
 * SDK's built-in native `fetch` transport (`./transport/aai-client.mjs`).
 *
 * Embeddings: the Anthropic Messages API is the only inference surface
 * Anthropic exposes — there is NO embeddings endpoint, so this client does
 * not fake one. `embed()` therefore throws a typed `ConfigurationError`
 * naming the providers that do embed (OpenAI, Google) instead of silently
 * degrading. The memory layer treats a throwing embedder as "no vector
 * tier" and keeps working with lexical recall.
 */

import { EventEmitter } from 'node:events';
import { BaseChatSession } from '../agentic/chat-session.mjs';
import { buildParameterMapForAai } from '../messaging/unified-parameter.mjs';
import {
    EnvKey,
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_ANTHROPIC_URL,
    ProviderType,
    StandardType,
} from '../core/constants/index.mjs';
import { mapProfileListError, resolveBaseUrl, resolveProtocol } from '../support/utils.mjs';
import { aaiAdapter } from './adapters/aai-adapter.mjs';
import { createAaiTransport } from './transport/aai-client.mjs';
import { readTransportOptions } from './transport/options.mjs';
import { ConfigurationError } from '../core/errors.mjs';

/**
 * Manages a chat session with an Anthropic LLM.
 */
export class ChatSession extends BaseChatSession {
    /**
 * Accepts a single options object (`{ client, model, eventEmitter, protocol }`).
 * @param {{client?: Object, model?: string, eventEmitter?: EventEmitter, protocol?: string|null, sessionId?: string|null}} arg0
 */
    constructor({ client, model, eventEmitter, protocol = null, sessionId = null } = {}) {
        super({ vendorClient: client ?? null, model: /** @type {string} */ (model), eventEmitter, provider: ProviderType.ANTHROPIC, builderStandard: StandardType.AAI, adapter: /** @type {any} */ (aaiAdapter), buildParameters: buildParameterMapForAai, sessionId });
        this.protocol = /** @type {string} */ (resolveProtocol({ provider: ProviderType.ANTHROPIC, protocol: protocol ?? undefined, session: true }));
    }
}

/**
 * Main Merci SDK client for Anthropic.
 * @property {ReturnType<typeof createAaiTransport>} transport - The native fetch connector (`createAaiTransport`), not the Anthropic SDK.
 */
export class MerciClient extends EventEmitter {
    /**
 * @param {{options?: Object}} arg0
 */
    constructor({ options = {} } = {}) {
        super();
        if (/** @type {any} */ (options).anthropicOptions !== undefined) {
            throw new ConfigurationError({ message: "options.anthropicOptions is no longer supported: the Anthropic transport is a native fetch connector. Pass the endpoint as options.baseURL and the transport values as options.transportOptions (fetch, defaultHeaders, timeout).", options: { option: 'anthropicOptions' } });
        }
        const apiKey = /** @type {any} */ (options).apiKey || process.env[EnvKey.ANTHROPIC_API_KEY];
        if (!apiKey) {
            throw new ConfigurationError({ message: "API Key is required. Provide it via options.apiKey or ANTHROPIC_API_KEY env variable." });
        }

        this.provider = ProviderType.ANTHROPIC;
        this.standard = StandardType.AAI;
        this.protocol = /** @type {string} */ (resolveProtocol({ provider: ProviderType.ANTHROPIC, protocol: /** @type {any} */ (options).protocol, session: true }));

        // Explicit option > trimmed ANTHROPIC_BASE_URL (blank ignored) > the
        // Anthropic API default.
        const baseURL = resolveBaseUrl({ explicit: /** @type {any} */ (options).baseURL, envKey: EnvKey.ANTHROPIC_BASE_URL, fallback: DEFAULT_ANTHROPIC_URL }) ?? DEFAULT_ANTHROPIC_URL;
        const transportOptions = readTransportOptions({ value: /** @type {any} */ (options).transportOptions });

        Object.defineProperty(this, 'transport', {
            value: createAaiTransport({
                apiKey,
                baseURL,
                defaultHeaders: transportOptions.defaultHeaders,
                fetch: transportOptions.fetch,
                timeoutMs: transportOptions.timeout,
                maxRetries: 0
            }),
            writable: true,
            configurable: true,
            enumerable: false
        });
    }

    /**
     * Creates a new chat session.
     * @param {string|{model?: string, sessionId?: string|null}} modelOrOptions - The model identifier, or `{ model, sessionId }`.
     * @returns {ChatSession}
     */
    session(modelOrOptions) {
        const options = modelOrOptions && typeof modelOrOptions === 'object' ? modelOrOptions : { model: /** @type {string|undefined} */ (modelOrOptions) };
        return new ChatSession({ client: /** @type {any} */ (this).transport, model: options.model || DEFAULT_ANTHROPIC_MODEL, eventEmitter: this, protocol: this.protocol, sessionId: options.sessionId ?? null });
    }

    /**
     * @param {{model?: string, sessionId?: string|null}} arg0
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
                models.push({ id: model.id, name: model.display_name || model.id });
            }
            return models;
        } catch (error) {
            return mapProfileListError({ error: /** @type {Error} */ (error) });
        }
    }

    /**
     * Anthropic has no embeddings endpoint, so this call always fails with a
     * typed `ConfigurationError` that points at the providers that do embed
     * (the OpenAI and Google backends). It exists so every backend answers
     * the same `embed()` contract — a missing method would surface as a
     * `TypeError` deep inside the memory layer instead.
     * @param {{input: string|Array<string>, model?: string}} arg0 - The text to embed.
     * @returns {Promise<Array<number>|Array<Array<number>|null>|null>} Never
     *   resolves — the call always throws.
     */
    async embed({ input, model }) {
        throw new ConfigurationError({
            message: `Anthropic provides no embeddings endpoint — the Messages API cannot embed text. Use the OpenAI or Google provider for embeddings (requested model: ${model ?? 'unset'}).`,
            options: { option: 'embed' },
        });
    }
}
