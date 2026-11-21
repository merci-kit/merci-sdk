// @ts-check
/**
 * @file Agentic annex for the JAI transport.
 * @version 0.12.0
 * @license Apache-2.0 — see the LICENSE file at the repository root.
 */

import { MerciClient as BaseMerciClient } from './jai-vendor/client.mjs';
import { ChatSession as BaseChatSession } from './jai-vendor/chat-session.mjs';
import { LLMParameters } from './jai-vendor/types.mjs';
import { ProfileManager } from './jai-vendor/profiles.mjs';

import { sdkLog, mapProfileListError, resolveProtocol, emitParameterWarning, getEmbeddingDimensions } from '../support/utils.mjs';
import { mapToolsToConfig } from '../tools/tool-execution.mjs';
import { declaresParam } from './jai-vendor/profiles.mjs';
import { UnifiedParameterBuilder, buildParameterMapForJai, warnRefusedSpecKeys } from '../messaging/unified-parameter.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import {
    isGoogleProvider,
    isAnthropicProvider,
    ProviderType,
    StandardType
} from '../core/constants/index.mjs';
import { jaiAdapter } from './adapters/jai-adapter.mjs';
import { mergeToolsByName } from './adapters/adapter-common.mjs';
import { EVENTS, stampEvent, emitEvent } from '../core/events.mjs';

/**
 * JAI V9 wire keys → the public unified parameter names. The profile filter
 * works in V9 keys; leaking those into `parameter_warning.parameter` made
 * public consumers see `CACHE_POINTS` while the builder saw `cachePoints`.
 * @type {Record<string, string>}
 */
const JAI_PUBLIC_PARAMETER_NAMES = {
  TEMPERATURE: 'temperature',
  TOP_P: 'topP',
  TOP_K: 'topK',
  LENGTH: 'maxTokens',
  STOP_TOKEN: 'stop',
  SEED: 'seed',
  RESPONSE_FORMAT: 'responseFormat',
  TOOL_CHOICE_AUTO: 'toolChoice',
  TOOL_CHOICE_NONE: 'toolChoice',
  TOOL_CHOICE_REQUIRED: 'toolChoice',
  TOOL_CHOICE_NAMED: 'toolChoice',
  PARALLEL_TOOL_CALLS: 'parallelToolCalls',
  REASONING_EFFORT: 'reasoningEffort',
  REASONING_SUMMARY: 'reasoningSummary',
  PREDICTED_OUTPUT: 'predictedOutput',
  CACHE_POINTS: 'cachePoints',
  PROMPT_CACHE_KEY: 'promptCacheKey',
  THINKING_BUDGET: 'thinkingBudget',
  NUMBER_OF_CHOICES: 'numberOfChoices',
  VERBOSITY: 'verbosity',
};

/**
 * Maps a JAI V9 key to the public unified parameter name, leaving unknown keys
 * untouched (fail-open for new vendor fields).
 * @param {{key: string}} arg0
 * @returns {string}
 */
function jaiPublicParameterName({ key }) {
  return JAI_PUBLIC_PARAMETER_NAMES[key] ?? key;
}

/**
 * Builds V9 parameters using dynamic profiles when available.
 * @param {{params: Record<string, any>, tools?: Array<any>, profile?: string, eventEmitter?: import('node:events').EventEmitter|null, profileManager?: import('./jai-vendor/profiles.mjs').ProfileManager|null, protocol?: string}} arg0
 * @returns {Record<string, any>|null}
 */
function buildParametersV9({ params, tools = [], profile = '', eventEmitter = null, profileManager = null, protocol = 'chat' }) {
    sdkLog({ prefix: 'JAI', args: [`── buildParametersV9 ──`] });
    sdkLog({ prefix: 'JAI', args: [`  profile=${profile}, toolCount=${tools.length}, paramKeys=${Object.keys(params).join(',') || 'none'}`] });
    /** @type {Record<string, any>} */
    const config = {};

    const resolvedProfile = /** @type {any} */ (profileManager ? profileManager.getProfile({ profileId: profile }) : null);

    sdkLog({ prefix: 'JAI', args: [`  resolvedProfile=${resolvedProfile ? `provider=${resolvedProfile.provider}, params=[${[...resolvedProfile.params || []].join(',')}]` : 'null'}`] });
    if (tools.length > 0 || (Array.isArray(params._tools) && params._tools.length > 0)) {
        const toolConfig = buildToolConfig({ params, tools, modelProfile: resolvedProfile, eventEmitter, profile });
        if (toolConfig) {
            config.toolConfig = toolConfig;
            sdkLog({ prefix: 'JAI', args: [`  toolConfig: tools=${toolConfig.tools?.length}, toolChoice=${JSON.stringify(toolConfig.toolChoice || {})}`] });
        } else {
            sdkLog({ prefix: 'JAI', args: [`  toolConfig: null (no config generated)`] });
        }
    }

    for (const [key, value] of Object.entries(params)) {
        const paramDef = /** @type {Record<string, import('./jai-vendor/types.mjs').LLMParamDef|undefined>} */ (LLMParameters)[key];
        if (!paramDef || paramDef.toolConfig) continue;

        if (paramDef.protocol && paramDef.protocol !== protocol) {
            const publicKey = jaiPublicParameterName({ key });
            emitParameterWarning({ emitter: eventEmitter, model: profile, parameter: publicKey, provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter '${publicKey}' is only supported on the '${paramDef.protocol}' protocol and will be ignored on '${protocol}'.` });
            continue;
        }

        if (resolvedProfile && !declaresParam({ params: resolvedProfile.params, key: paramDef.key })) {
            const publicKey = jaiPublicParameterName({ key });
            emitParameterWarning({ emitter: eventEmitter, model: profile, parameter: publicKey, provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter '${publicKey}' is not supported by model profile '${profile}' and will be ignored.` });
            continue;
        }

        config[paramDef.key] = value;
    }

    const finalConfig = Object.keys(config).length > 0 ? config : null;
    sdkLog({ prefix: 'JAI', args: [`  finalConfig keys=${finalConfig ? Object.keys(finalConfig).join(',') : 'null'}`] });
    return finalConfig;
}

/**
 * Builds the JAI toolConfig for a spec.
 * @param {{params: Record<string, any>, tools: Array<any>, modelProfile: any, eventEmitter: import('node:events').EventEmitter|null, profile?: string}} arg0
 * @returns {Record<string, any>}
 */
function buildToolConfig({ params, tools, modelProfile, eventEmitter, profile = '' }) {
    sdkLog({ prefix: 'JAI', args: [`── buildToolConfig ──`] });
    sdkLog({ prefix: 'JAI', args: [`  tools: ${tools.map((/** @type {any} */ t) => t.name).join(', ')}`] });
    sdkLog({ prefix: 'JAI', args: [`  params: TOOL_CHOICE_AUTO=${!!params.TOOL_CHOICE_AUTO}, TOOL_CHOICE_NONE=${!!params.TOOL_CHOICE_NONE}, TOOL_CHOICE_REQUIRED=${!!params.TOOL_CHOICE_REQUIRED}, TOOL_CHOICE_NAMED=${params.TOOL_CHOICE_NAMED || false}`] });
    const sessionTools = new Set(tools);
    const declaredTools = mergeToolsByName({ tools, specTools: params._tools }).map((t) => (sessionTools.has(t) ? t : {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? t.parameters ?? { type: 'object', properties: {} },
    }));
    /** @type {Record<string, any>} */
    const toolConfig = {
        tools: mapToolsToConfig({ tools: declaredTools })
    };

    /** @type {Record<string, any>} */
    const toolChoice = {};

    if (params.TOOL_CHOICE_AUTO) {
        if (modelProfile && !declaresParam({ params: modelProfile?.params, key: LLMParameters.TOOL_CHOICE_AUTO.key })) {
            emitParameterWarning({ emitter: eventEmitter, model: modelProfile?.id ?? profile, parameter: jaiPublicParameterName({ key: 'TOOL_CHOICE_AUTO' }), provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter 'toolChoice.auto' is not supported by this model and will be ignored.` });
        } else {
            toolChoice.auto = true;
        }
    }

    if (params.TOOL_CHOICE_NONE) {
        if (modelProfile && !declaresParam({ params: modelProfile?.params, key: LLMParameters.TOOL_CHOICE_NONE.key })) {
            emitParameterWarning({ emitter: eventEmitter, model: modelProfile?.id ?? profile, parameter: jaiPublicParameterName({ key: 'TOOL_CHOICE_NONE' }), provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter 'toolChoice.none' is not supported by this model and will be ignored.` });
        } else {
            toolChoice.none = true;
        }
    }

    if (params.TOOL_CHOICE_REQUIRED) {
        const isAnthropic = isAnthropicProvider({ modelProfile, profile });

        if (isAnthropic) {
        } else if (modelProfile && !declaresParam({ params: modelProfile?.params, key: LLMParameters.TOOL_CHOICE_REQUIRED.key })) {
            emitParameterWarning({ emitter: eventEmitter, model: modelProfile?.id ?? profile, parameter: jaiPublicParameterName({ key: 'TOOL_CHOICE_REQUIRED' }), provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter 'toolChoice.required' is not supported by this model and will be ignored.` });
        } else {
            toolChoice.required = true;
        }
    }

    if (params.TOOL_CHOICE_NAMED) {
        if (modelProfile && !declaresParam({ params: modelProfile?.params, key: LLMParameters.TOOL_CHOICE_NAMED.key })) {
            emitParameterWarning({ emitter: eventEmitter, model: modelProfile?.id ?? profile, parameter: jaiPublicParameterName({ key: 'TOOL_CHOICE_NAMED' }), provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter 'toolChoice.named' is not supported by this model and will be ignored.` });
        } else {
            toolChoice.named = params.TOOL_CHOICE_NAMED;
        }
    }

    const choiceOrder = ['named', 'required', 'none', 'auto'];
    const chosenChoices = choiceOrder.filter((k) => toolChoice[k] !== undefined);
    if (chosenChoices.length > 1) {
        for (const extra of chosenChoices.slice(1)) delete toolChoice[extra];
        emitParameterWarning({ emitter: eventEmitter, model: modelProfile?.id ?? profile, parameter: 'toolChoice', provider: ProviderType.JAI, standard: StandardType.JAI,
            message: `Multiple tool choices requested (${chosenChoices.join(', ')}) — keeping '${chosenChoices[0]}' (the native protocol allows exactly one).` });
    }

    if (Object.keys(toolChoice).length > 0) {
        toolConfig.toolChoice = toolChoice;
    }

    if (params.PARALLEL_TOOL_CALLS !== undefined) {
        const parallelToolCallsParam = LLMParameters.PARALLEL_TOOL_CALLS;
        const isGoogle = isGoogleProvider({ modelProfile, profile });

        if (isGoogle) {
        } else if (modelProfile && !declaresParam({ params: modelProfile?.params, key: parallelToolCallsParam.key })) {
            emitParameterWarning({ emitter: eventEmitter, model: modelProfile?.id ?? profile, parameter: jaiPublicParameterName({ key: 'PARALLEL_TOOL_CALLS' }), provider: ProviderType.JAI, standard: StandardType.JAI,
                message: `Parameter 'parallelToolCalls' is not supported by this model and will be ignored.` });
        } else {
            toolConfig.parallelToolCalls = params.PARALLEL_TOOL_CALLS;
        }
    }

    return toolConfig;
}

/**
 * Agentic chat session with automatic tool execution support.
 */
export class ChatSession extends BaseChatSession {
    #httpClient; #profile; #eventEmitter; #profileManager;
    /** @type {Record<string, unknown>} */
    _jaiSpec = {};

    /**
 * @param {{httpClient: import('./jai-vendor/http-client.mjs').InternalHttpClient, profile: string, eventEmitter?: import('node:events').EventEmitter|null, profileManager?: import('./jai-vendor/profiles.mjs').ProfileManager, protocol?: string|null, builderStandard?: string, sessionId?: string|null}} arg0
 */
    constructor({ httpClient, profile, eventEmitter = null, profileManager, protocol = null, builderStandard = StandardType.JAI, sessionId = null }) {
        super({ httpClient, profile, profileManager, builderStandard, sessionId });
        this.#httpClient = httpClient;
        this.#profile = profile;
        this.#eventEmitter = eventEmitter;
        this.#profileManager = profileManager;
        this.protocol = /** @type {string} */ (resolveProtocol({ provider: ProviderType.JAI, protocol: protocol ?? undefined, session: true }));

        // JAI passes its MerciClient as the emitter; that object is the session's
        // client too (it implements session/sessionWithId), not a bare emitter.
        this.client = /** @type {import('../agentic/chat-session.mjs').SessionClient} */ (eventEmitter);
        this.eventEmitter = eventEmitter;
        this.model = profile;
        this.provider = ProviderType.JAI;

        this._apiObserver = {
            onRequest() {},
            onResponse() {},
            onError() {},
            /** @param {{meta: import('../support/api-observer.mjs').ApiRetryMeta}} arg0 */
            onRetry({ meta }) {
                /** @type {any} */ (eventEmitter)?.emit(EVENTS.CLIENT.API_RETRY, stampEvent({ name: EVENTS.CLIENT.API_RETRY, payload: meta }));
            }
        };
        // The JAI adapter module is still typed as a record; the session's contract
        // is `StepAdapter`, which the module satisfies at runtime.
        this._adapter = /** @type {import('../agentic/chat-session.mjs').StepAdapter} */ (jaiAdapter);
        // The vendor base constructs with a null emitter (it has no event
        // stream yet), so the one session:start for JAI is emitted here once
        // the real emitter and the final session id are known.
        this._sessionRunCtx.emit({ emitter: eventEmitter ?? null, name: EVENTS.CLIENT.SESSION_START, payload: { provider: this.provider, model: this.model, sessionId: this.sessionId } });
    }

    /**
 * @param {{messages: Array<import('../agentic/chat-session.mjs').ChatRow>, options: import('../agentic/chat-session.mjs').StepOptions}} arg0
 * @returns {{ messages: Array<import('../agentic/chat-session.mjs').ChatRow>, options: import('../agentic/chat-session.mjs').StepOptions }}
 */
    _onStepWillStart({ messages, options }) {
        const { thoughtSignature } = options;
        if (!thoughtSignature || messages.length === 0) return { messages, options };
        const modified = [...messages];
        /** @param {{i: *}} arg0 */
        const stamp = ({ i }) => {
            const msg = modified[i];
            if (msg.type === 'assistant_message_tool' && !msg.thoughtSignature && !msg.thought_signature) {
                modified[i] = { ...msg, thoughtSignature };
            }
        };
        let sawToolTurn = false;
        for (let i = modified.length - 1; i >= 0; i--) {
            const msg = modified[i];
            if (msg.type === 'assistant_message_text') {
                break;
            } else if (msg.type === 'assistant_message_tool') {
                stamp({ i });
                sawToolTurn = true;
            } else if (msg.type === 'tool_message') {
                for (let j = i - 1; j >= 0; j--) {
                    const pMsg = modified[j];
                    if (pMsg.type === 'assistant_message_tool' && pMsg.id === msg.id) {
                        stamp({ i: j });
                        break;
                    }
                }
                sawToolTurn = true;
            } else if (sawToolTurn) {
                break;
            }
        }
        return { messages: modified, options };
    }

    _onStepShouldPrepare() {
        return false;
    }

    /**
 * @param {{forceTextResponse: boolean, toolChoiceRequired: boolean}} arg0
 * @returns {{ session: ChatSession }}
 */
    _onStepBuildContext({ forceTextResponse, toolChoiceRequired }) {
        if (!forceTextResponse && !toolChoiceRequired) {
            return { session: this };
        }
        const cloned = new ChatSession({ httpClient: this.#httpClient, profile: this.#profile, eventEmitter: this.#eventEmitter, profileManager: this.#profileManager });
        Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(this));
        const spec = { ...cloned._jaiSpec };
        if (forceTextResponse) {
            for (const k of ['TOOL_CHOICE_AUTO', 'TOOL_CHOICE_REQUIRED', 'TOOL_CHOICE_NAMED']) delete spec[k];
            spec.TOOL_CHOICE_NONE = true;
        } else if (toolChoiceRequired) {
            for (const k of ['TOOL_CHOICE_AUTO', 'TOOL_CHOICE_NONE', 'TOOL_CHOICE_NAMED']) delete spec[k];
            spec.TOOL_CHOICE_REQUIRED = true;
        }
        cloned._parameters = /** @type {any} */ (buildParametersV9({ params: spec, tools: cloned._tools, profile: this.#profile, eventEmitter: this.#eventEmitter, profileManager: this.#profileManager, protocol: this.protocol }));
        return { session: cloned };
    }

    /**
 * @param {{result: import('../agentic/chat-session.mjs').StepFinalState}} arg0
 * @returns {import('../agentic/chat-session.mjs').StepFinalState}
 */
    _onStepComplete({ result }) {
        if (result.content) {
            const responseFormat = /** @type {{type?: string}|undefined} */ (this._jaiSpec.RESPONSE_FORMAT);
            const isJsonMode = responseFormat?.type === 'json' || responseFormat?.type === 'json_object';
            if (isJsonMode) result.content = result.content.trim();
        }
        sdkLog({ prefix: 'JAI', args: [`  step complete: done=${result.done}, contentLen=${(result.content || '').length}${result.streamError ? `, streamError=${result.streamError.error_message}` : ''}`] });
        return result;
    }

    /**
 * Configure session parameters using a builder function or a plain object.
 * The function form is given a `UnifiedParameterBuilder`; its `_build()`
 * returns the unified spec, which the JAI translator converts to the
 * V9-keyed spec stored in `this._jaiSpec` (mirrors BaseChatSession's
 * `_buildParameters` slot — the spec stays public so the per-call
 * tool-choice clone can overlay it). `buildParametersV9` then converts the
 * V9 spec to the profile-filtered wire format stored in `this._parameters`.
 * @param {{params: Object|Function}} arg0
 * @returns {this}
 */
    withParameters({ params }) {
        if (typeof params === 'function') {
            const builder = new UnifiedParameterBuilder({ model: this.#profile, eventEmitter: this.#eventEmitter, provider: ProviderType.JAI });
            const spec = buildParameterMapForJai({ spec: (/** @type {UnifiedParameterBuilder} */ (params(builder))).build() });
            this._jaiSpec = { ...(this._jaiSpec ?? {}), ...spec };
        } else if (params && typeof params === 'object') {
            warnRefusedSpecKeys({ standard: StandardType.JAI, spec: /** @type {Record<string, unknown>} */ (params), eventEmitter: this.#eventEmitter, model: this.#profile, provider: ProviderType.JAI });
            this._jaiSpec = { ...(this._jaiSpec ?? {}), ...buildParameterMapForJai({ spec: params }) };
        }
        this._parameters = /** @type {any} */ (buildParametersV9({ params: this._jaiSpec, tools: this._tools, profile: this.#profile, eventEmitter: this.#eventEmitter, profileManager: this.#profileManager, protocol: this.protocol }));
        emitEvent({ emitter: this.#eventEmitter ?? null, name: EVENTS.CLIENT.SESSION_PARAMS_APPLIED, payload: {
            model: this.#profile ?? null, provider: ProviderType.JAI, keys: Object.keys(this._parameters ?? {})
        } });
        return this;
    }

    /**
     * @param {{tools: Array<Object>}} arg0
     * @returns {this}
     */
    withTools({ tools }) {
        super.withTools({ tools });
        if (this._jaiSpec && Object.keys(this._jaiSpec).length > 0) {
            this._parameters = /** @type {any} */ (buildParametersV9({ params: this._jaiSpec, tools: this._tools, profile: this.#profile, eventEmitter: this.#eventEmitter, profileManager: this.#profileManager, protocol: this.protocol }));
        }
        return this;
    }

    /**
 * Switches the wire protocol and rebuilds the wire parameters — a
 * protocol-scoped parameter (reasoningSummary) set BEFORE the switch must
 * not stay silently dropped just because of call order.
 * @param {{protocol: string}} arg0
 * @returns {this}
 */
    withProtocol({ protocol }) {
        super.withProtocol({ protocol });
        this._parameters = /** @type {any} */ (buildParametersV9({ params: this._jaiSpec, tools: this._tools, profile: this.#profile, eventEmitter: this.#eventEmitter, profileManager: this.#profileManager, protocol: this.protocol }));
        return this;
    }
}

/**
 * Main Agentic Merci SDK client for JAI transport.
 */
export class MerciClient extends BaseMerciClient {
    /**
 * @param {{options?: import('./jai-vendor/client.mjs').MerciClientOptions}} arg0
 */
    constructor({ options = {} } = {}) {
        super({ options });
        this.standard = StandardType.JAI;
    }

    /**
     * Retrieves the list of available models.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getProfiles() {
        try {
            const profileMap = await this.profiles.getProfiles();
            return Object.values(profileMap).map(p => ({
                id: p.id,
                name: p.name || p.id
            }));
        } catch (error) {
            return mapProfileListError({ error: /** @type {Error} */ (error) });
        }
    }

    /**
     * Generates embeddings via the JAI embedding service
     * (`POST /indexing/embeddings/qwen/compute`). It is model-less — the
     * platform serves a fixed Qwen3-Embedding-4B — so there is no model id to
     * pass; the configurable knob is the output dimensionality
     * (`DEFAULT_JAI_EMBEDDING_DIMENSIONS`, default 1024). The `model` argument
     * is accepted for signature parity with the other backends and ignored.
     * @param {{input: string|Array<string>, model?: string, signal?: AbortSignal|null}} arg0
     * @returns {Promise<Array<number>|Array<Array<number>|null>|null>} One vector for a
     *   string input; an ordered array aligned with the input for an array input
     *   (a failed item is `null`).
     */
    async embed({ input, model }) {
        const dimensions = getEmbeddingDimensions({ provider: ProviderType.JAI });
        const isBatch = Array.isArray(input);
        const texts = isBatch ? input : [input];
        const inputLen = isBatch ? texts.length : String(input ?? '').length;
        const startTs = Date.now();
        this.emit(EVENTS.CLIENT.EMBED_START, stampEvent({ name: EVENTS.CLIENT.EMBED_START, payload: { model: 'jai', dimensions, inputLen } }));
        try {
            const response = await this.httpClient._fetchWithRetry({
                path: '/indexing/embeddings/qwen/compute',
                options: { method: 'POST', body: JSON.stringify({ input: texts, dimensions, task: 'compute' }) }
            });
            const data = /** @type {{embeddings?: Array<{values?: Array<number>}>}} */ (await response.json());
            const vectors = (data.embeddings ?? []).map((/** @type {any} */ e) => Array.isArray(e?.values) ? e.values : null);
            this.emit(EVENTS.CLIENT.EMBED_FINISH, stampEvent({ name: EVENTS.CLIENT.EMBED_FINISH, payload: {
                model: 'jai', dimensions, inputLen, vectorLen: vectors[0]?.length ?? 0, durationMs: Date.now() - startTs, retries: 0
            } }));
            if (isBatch) return vectors.length ? vectors : null;
            return vectors[0] ?? null;
        } catch (error) {
            this.emit(EVENTS.CLIENT.EMBED_ERROR, stampEvent({ name: EVENTS.CLIENT.EMBED_ERROR, payload: {
                model: 'jai', dimensions, inputLen, durationMs: Date.now() - startTs, retries: 0, error: /** @type {any} */ (error)?.message ?? String(error)
            } }));
            if (this.listenerCount('error') > 0) this.emit('error', error);
            throw error;
        }
    }

    /**
     * Creates a new agentic chat session.
     * @param {string|{model?: string, profile?: string, sessionId?: string|null}} modelOrOptions - The model profile, or `{ model|profile, sessionId }`.
     * @returns {ChatSession}
     */
    session(modelOrOptions) {
        const options = modelOrOptions && typeof modelOrOptions === 'object' ? modelOrOptions : { model: /** @type {string} */ (modelOrOptions) };
        const profile = options.profile ?? options.model;
        if (!profile || typeof profile !== 'string') throw new ConfigurationError({ message: 'A valid model profile string is required to start a chat session.' });
        return new ChatSession({ httpClient: this.httpClient, profile, eventEmitter: this, profileManager: this.profiles, protocol: /** @type {any} */ (this).protocol ?? null, sessionId: options.sessionId ?? null });
    }

    /**
     * @param {{model?: string, profile?: string, sessionId?: string|null}} arg0
     * @returns {ChatSession}
     */
    sessionWithId({ model, profile, sessionId = null }) {
        return this.session({ model, profile, sessionId });
    }

    /**
     * Proactively refresh the JAI token.
     * @returns {Promise<string>} The new token.
     */
    async refreshToken() {
        return this.httpClient.refreshToken();
    }

    /**
     * The account's current quota/credit snapshot (JAI `/quota/get`).
     * @returns {Promise<Object|null>} `{ license, until, current: {amount}, maximum: {amount}, quotaID }`.
     */
    async getQuota() {
        return this.quota.get();
    }

    /**
     * The current JAI token. Safe to read for persistence — the
     * `token_refresh_success` event deliberately does NOT carry it.
     * @returns {string}
     */
    get token() {
        return this.httpClient.token;
    }
}