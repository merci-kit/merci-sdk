// @ts-check
/**
 * @file JAI vendor chat session (standalone transport).
 * @version 0.12.0
 *
 * @description
 * The wire-level JAI `/llm/chat/stream/v9` session: builds the request body
 * (JAI message shaping, profile parameter filtering), streams SSE events with
 * an inactivity timeout, and salvages partial responses on timeout/abort.
 */

import { TextDecoderStream } from 'node:stream/web';
import { ProviderType, ProtocolType, StandardType } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { EVENTS } from '../../core/events.mjs';
import { createUserMessage, normalizeHistory } from '../../messaging/messages.mjs';
import { AbstractChatSession, isContentFilterReason } from '../../agentic/chat-session.mjs';
import { InactivityTimeoutPolicy } from '../../support/stream-timeout.mjs';
import { sleepAbortable } from '../../support/retry-policy.mjs';
import { mapToolsToConfig } from '../../tools/tool-execution.mjs';
import { SSEParser, readSSELines } from './sse-parser.mjs';
import { SSEError } from './types.mjs';
import { formatJaiMessages } from './messages.mjs';
import { UnifiedParameterBuilder, buildParameterMapForJai, warnRefusedSpecKeys } from '../../messaging/unified-parameter.mjs';

/**
 * @typedef {Object} JaiProfileManager
 * @property {() => Promise<Object>} getProfiles
 * @property {(arg0: { profileId: string, paramKey: string }) => boolean} isSupported
 */

/**
 * @typedef {Object} ChatStreamOptions
 * @property {AbortSignal} [signal] - Abort signal.
 * @property {boolean} [isLastIteration=false] - Final tool-loop turn marker.
 * @property {import('../../core/events.mjs').RunContext|null} [runContext] - Step correlation context (emissions).
 * @property {number|null} [headerTimeoutMs] - Per-session header budget override (withHeaderTimeout).
 * @property {Record<string, string>} [headers] - Extra request headers.
 */

/**
 * Wire-level JAI chat session used by the JAI adapter and the agentic client.
 */
export class ChatSession extends AbstractChatSession {
    /**
     * @type {import('./http-client.mjs').InternalHttpClient}
     */
    #httpClient;
    #profile;
    /**
     * @type {JaiProfileManager|null}
     */
    #profileManager;
    #endpointPath;

    /**
 * @param {{httpClient: import('./http-client.mjs').InternalHttpClient, profile: string, profileManager?: JaiProfileManager|null, endpointPath?: string|null, builderStandard?: string, sessionId?: string|null}} arg0
 */
    constructor({ httpClient, profile, profileManager = null, endpointPath = null, builderStandard, sessionId = null }) {
        super({ provider: ProviderType.JAI, model: profile, eventEmitter: null, client: /** @type {any} */ (httpClient), vendorClient: null, builderStandard, sessionId });
        this.#httpClient = httpClient;
        this.#profile = profile;
        this.#profileManager = profileManager;
        this.#endpointPath = endpointPath;
        this.withStreamTimeout({ policy: new InactivityTimeoutPolicy({ timeoutMs: this.#httpClient.streamTimeout }) });
    }

    /**
     * Configure the wire parameters from a `UnifiedParameterBuilder` function or
     * a plain spec object. The function form is the same contract every other
     * concrete session offers; the builder's unified spec is translated to the
     * V9 keys this wire expects. An object is taken as V9 keys already (the
     * agentic JAI session layers the unified translation on top).
     * @param {{params: Object|Function}} arg0
     * @returns {this}
     */
    withParameters({ params }) {
        if (typeof params === 'function') {
            const builder = new UnifiedParameterBuilder({ model: this.#profile, eventEmitter: this.#emitter(), provider: ProviderType.JAI });
            const spec = /** @type {{build: () => Record<string, unknown>}} */ (params(builder)).build();
            this._parameters = /** @type {Record<string, Object|null>} */ ({ ...this._parameters, ...buildParameterMapForJai({ spec }) });
        } else if (params && typeof params === 'object') {
            warnRefusedSpecKeys({ standard: StandardType.JAI, spec: /** @type {Record<string, unknown>} */ (params), eventEmitter: this.#emitter(), model: this.#profile, provider: ProviderType.JAI });
            this._parameters = /** @type {Record<string, Object|null>} */ ({ ...this._parameters, ...params });
        }
        return this;
    }

    /**
     * The client emitter, when the transport exposes one. Test doubles and
     * embedded transports may omit it; warnings are advisory, never fatal.
     * @returns {import('node:events').EventEmitter|null}
     */
    #emitter() {
        return this.#httpClient.getEventEmitter?.() ?? null;
    }

    /**
 * Streams a chat completion over SSE, yielding unified stream events.
 * @param {{initialInput: string|Array<Object>, options?: ChatStreamOptions, headers?: Record<string, string>}} arg0
 * @returns {AsyncGenerator<Object>} Unified stream events (text/tool_calls/metadata/error/...).
 */
    async* stream({ initialInput, options = {}, headers: topHeaders }) {
        const { signal, isLastIteration = false, runContext = null, headerTimeoutMs = null, headers = topHeaders } = options;
        const protocol = this.protocol || ProtocolType.CHAT;
        const endpointPath = this.#endpointPath
            || (protocol === ProtocolType.RESPONSES ? '/llm/responses/stream/v9' : '/llm/chat/stream/v9');
        if (this.#profileManager) {
            await this.#profileManager.getProfiles().catch((/** @type {any} */ error) => {
                runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.WARNING, payload: {
                    code: 'PROFILE_FETCH_FAILED',
                    message: `Model profile list could not be loaded: ${error?.message || error}. Parameter filtering is disabled for this session.`
                } });
            });
        }

        const initialMessages = Array.isArray(initialInput) ? initialInput : [createUserMessage({ provider: ProviderType.JAI, content: initialInput })];
        const messages = await this._prepareStepMessages({ messages: initialMessages, options: { signal, isLastIteration, runContext } });
        const requestBody = this.#buildRequestBody({ messages, runContext, protocol });

        const MAX_PREMATURE_ATTEMPTS = LIMITS.max_premature_attempts;
        /** @type {AbortController|null} */
        let currentController = null;
        /** @type {(() => void)|undefined} */
        let onAbort;
        if (signal) {
            onAbort = () => currentController?.abort(signal.reason);
            if (!signal.aborted) signal.addEventListener('abort', onAbort);
        }

        try {
            /** The previous attempt's cut signature, for the deterministic-cut guard. */
            let previousCut = null;
            for (let attempt = 0; ; attempt++) {
                const controller = new AbortController();
                currentController = controller;
                if (signal?.aborted) controller.abort(signal.reason);
                const response = await this.#httpClient._fetchWithRetry({ path: endpointPath, options: {
                    method: 'POST',
                    body: JSON.stringify(requestBody),
                    signal: controller.signal,
                    ...(headers ? { headers } : {}),
                    ...(Number.isFinite(headerTimeoutMs) && /** @type {number} */ (headerTimeoutMs) > 0 ? { headerTimeoutMs: /** @type {number} */ (headerTimeoutMs) } : {}),
                } });
                const traceId = /** @type {any} */ (response)?.headers?.get?.('grazie-trace-id') ?? null;
                const parser = new SSEParser({ protocol });
                const textStream = (/** @type {any} */ (response.body)).pipeThrough(new TextDecoderStream());
                /** @param {{err: *}} arg0 */
                const guardedStream = this._streamTimeoutPolicy.wrapStream?.({ stream: textStream, signal, onTimeoutAbort: /** @type {(...args: any[]) => any} */ (({ err }) => controller.abort(err)) }) ?? textStream;

                let partialText = 0;
                let partialHash = 0x811c9dc5;
                let yieldedText = 0;
                let sawToolDelta = false;
                let sawError = false;
                let timedOut = false;
                /** @type {any} */
                let prematureEnd = null;
                try {
                    for await (const event of readSSELines({ stream: guardedStream, parser })) {
                        if (event?.type === 'error') sawError = true;
                        if (event?.type === 'premature_end') { prematureEnd = event; continue; }
                        if (event?.type === 'text') {
                            const chunk = String(event.content ?? '');
                            partialText += chunk.length;
                            for (let i = 0; i < chunk.length; i++) {
                                partialHash ^= chunk.charCodeAt(i);
                                partialHash = Math.imul(partialHash, 0x01000193);
                            }
                            yieldedText += chunk.length;
                        }
                        if (event?.type === 'tool_call_delta') sawToolDelta = true;
                        yield event;
                    }
                } catch (streamError) {
                    const err = /** @type {any} */ (streamError);
                    if (err instanceof SSEError) {
                        runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.STREAM_PARSE_ERROR, payload: { message: err.message } });
                        throw streamError;
                    }
                    if (signal && signal.aborted) {
                        throw streamError;
                    }
                    const errMsg = String(err?.message ?? err);
                    if (err?.name === 'AbortError' || errMsg.includes('timeout')) {
                        timedOut = true;
                        controller.abort(streamError);
                        runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.WARNING, payload: {
                            message: `Stream interrupted/timeout: ${errMsg}. Yielding partial response salvaged from buffer.`
                        } });
                        runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.SESSION_STREAM_TIMEOUT, payload: {
                            message: errMsg,
                            partialLength: partialText,
                        } });
                        yield { type: 'error', error_message: errMsg, error_type: 'timeout' };
                    } else {
                        throw streamError;
                    }
                }

                // A clean EOF without the terminal FinishMetadata is an early
                // stop too: JAI always sends FinishMetadata before `end`, so a
                // stream that produced content and then vanished must not be
                // reported as a complete answer.
                if (!prematureEnd && !timedOut && !sawError && !parser.sawFinishMetadata && (partialText > 0 || sawToolDelta)) {
                    prematureEnd = { type: 'premature_end', reason: 'missing_finish', choiceIndex: 0 };
                }

                if (prematureEnd || timedOut) parser.discardInProgress();
                const finalResult = parser.getFinalResult();
                if (finalResult.thoughtSignature) { yield { type: 'metadata', thoughtSignature: finalResult.thoughtSignature }; }
                if (finalResult.toolCalls.length > 0) { yield { type: 'tool_calls', calls: finalResult.toolCalls }; }

                const filtered = prematureEnd ? isContentFilterReason({ reason: prematureEnd.reason }) : false;
                // The same prompt cut at the same offset twice is deterministic,
                // not flaky: a third identical request would buy the same answer.
                const cutKey = prematureEnd && partialText > 0 ? `${prematureEnd.reason}:${partialText}:${partialHash >>> 0}` : null;
                const deterministicCut = cutKey !== null && cutKey === previousCut;
                if (cutKey) previousCut = cutKey;
                const finalEvent = prematureEnd
                    ? { ...prematureEnd, ...(traceId ? { traceId } : {}) }
                    : null;

                if (!prematureEnd || filtered || deterministicCut || attempt >= MAX_PREMATURE_ATTEMPTS - 1 || signal?.aborted) {
                    if (finalEvent) {
                        if (filtered || deterministicCut) {
                            runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.WARNING, payload: {
                                code: 'STREAM_PREMATURE_NO_RETRY',
                                message: filtered
                                    ? 'Provider stopped the stream for content moderation; not retrying the same request.'
                                    : `Provider cut the stream again after ${partialText} characters; not retrying a deterministic cut.`,
                                reason: prematureEnd.reason ?? 'unknown',
                                ...(traceId ? { traceId } : {}),
                            } });
                        }
                        yield finalEvent;
                    }
                    break;
                }

                runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.WARNING, payload: {
                    code: 'STREAM_PREMATURE_RETRY',
                    message: `Provider closed the stream before finishing (PrematureEnd, reason: ${prematureEnd.reason ?? 'unknown'}). Retrying (attempt ${attempt + 2}/${MAX_PREMATURE_ATTEMPTS}).`,
                    ...(traceId ? { traceId } : {}),
                    ...(prematureEnd.message ? { detail: prematureEnd.message } : {}),
                } });
                try {
                    await sleepAbortable({ ms: LIMITS.premature_retry_backoff_ms * (attempt + 1), signal });
                } catch (abortErr) {
                    if (signal?.aborted) throw abortErr;
                    if (finalEvent) yield finalEvent;
                    break;
                }
                if (yieldedText > 0 || sawToolDelta) yield { type: 'restart', reason: 'premature_end' };
            }
        } finally {
            if (signal) signal.removeEventListener('abort', /** @type {any} */ (onAbort));
        }
    }

    /**
 * @param {{messages: Array<Object>, runContext?: import('../../core/events.mjs').RunContext|null, protocol?: string}} arg0
 */
    #buildRequestBody({ messages, runContext = null, protocol = ProtocolType.CHAT }) {
        const chatMessages = formatJaiMessages({ messages: normalizeHistory({ provider: ProviderType.JAI, messages, options: { protocol } }) });

        const requestData = { profile: this.#profile, prompt: `js-sdk-prompt-${Date.now()}`, chat: { messages: chatMessages }, parameters: /** @type {Record<string, any>} */ ({}) };

        const omitted = [];
        const filteredParameters = /** @type {Record<string, any>} */ ({});
        if (this._parameters && Object.keys(this._parameters).length > 0) {
            for (const [key, value] of Object.entries(this._parameters)) {
                if (this.#profileManager?.isSupported({ profileId: this.#profile, paramKey: key })) {
                    filteredParameters[key] = value;
                } else if (this.#profileManager) {
                    omitted.push(key);
                } else {
                    filteredParameters[key] = value;
                }
            }
        }

        Object.assign(requestData.parameters, filteredParameters);

        const sharedToolConfig = requestData.parameters.toolConfig;
        if (sharedToolConfig) {
            requestData.parameters.toolConfig = {
                ...sharedToolConfig,
                ...(sharedToolConfig.toolChoice ? { toolChoice: { ...sharedToolConfig.toolChoice } } : {}),
            };
        }

        if (this._tools && this._tools.length > 0) {
            if (!requestData.parameters.toolConfig) requestData.parameters.toolConfig = {};
            // The request site decides what the model sees: a deferred tool
            // stays out until `tool_search` activates it. `_parameters` was
            // built from the full `_tools` list, so it is replaced, not merged.
            requestData.parameters.toolConfig.tools = mapToolsToConfig({ tools: this._requestTools() });

            const toolConfig = requestData.parameters.toolConfig;
            if (Object.prototype.hasOwnProperty.call(toolConfig, 'parallelToolCalls')
                && this.#profileManager && !this.#profileManager.isSupported({ profileId: this.#profile, paramKey: 'parallelToolCalls' })) {
                delete toolConfig.parallelToolCalls;
                omitted.push('parallelToolCalls');
            }
            for (const param of Object.keys(toolConfig.toolChoice || {})) {
                if (this.#profileManager && !this.#profileManager.isSupported({ profileId: this.#profile, paramKey: param })) {
                    delete toolConfig.toolChoice[param];
                    omitted.push(param);
                }
            }
        }

        if (omitted.length > 0) {
            runContext?.emit({ emitter: this.#emitter(), name: EVENTS.CLIENT.SESSION_PARAMS_FILTERED, payload: { profile: this.#profile, omitted } });
        }

        return requestData;
    }
}
