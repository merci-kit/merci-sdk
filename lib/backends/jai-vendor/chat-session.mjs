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
import { ProviderType, ProtocolType, SYSTEM_MESSAGE_MERGE_SEPARATOR } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { EVENTS } from '../../core/events.mjs';
import { createUserMessage, normalizeHistory } from '../../messaging/messages.mjs';
import { AbstractChatSession } from '../../agentic/chat-session.mjs';
import { InactivityTimeoutPolicy } from '../../support/stream-timeout.mjs';
import { sleepAbortable } from '../../support/retry-policy.mjs';
import { mapToolsToConfig } from '../../tools/tool-execution.mjs';
import { SSEParser, readSSELines } from './sse-parser.mjs';
import { SSEError } from './types.mjs';
import { formatJaiMessages } from './messages.mjs';

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
                runContext?.emit({ emitter: this.#httpClient.getEventEmitter(), name: EVENTS.CLIENT.WARNING, payload: {
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
                const parser = new SSEParser({ protocol });
                const textStream = (/** @type {any} */ (response.body)).pipeThrough(new TextDecoderStream());
                /** @param {{err: *}} arg0 */
                const guardedStream = this._streamTimeoutPolicy.wrapStream?.({ stream: textStream, signal, onTimeoutAbort: /** @type {(...args: any[]) => any} */ (({ err }) => controller.abort(err)) }) ?? textStream;

                let partialText = 0;
                let yieldedText = 0;
                let sawToolDelta = false;
                let timedOut = false;
                /** @type {any} */
                let prematureEnd = null;
                try {
                    for await (const event of readSSELines({ stream: guardedStream, parser })) {
                        if (event?.type === 'premature_end') { prematureEnd = event; continue; }
                        if (event?.type === 'text') {
                            partialText += String(event.content ?? '').length;
                            yieldedText += String(event.content ?? '').length;
                        }
                        if (event?.type === 'tool_call_delta') sawToolDelta = true;
                        yield event;
                    }
                } catch (streamError) {
                    const err = /** @type {any} */ (streamError);
                    if (err instanceof SSEError) {
                        runContext?.emit({ emitter: this.#httpClient.getEventEmitter(), name: EVENTS.CLIENT.STREAM_PARSE_ERROR, payload: { message: err.message } });
                        throw streamError;
                    }
                    if (signal && signal.aborted) {
                        throw streamError;
                    }
                    const errMsg = String(err?.message ?? err);
                    if (err?.name === 'AbortError' || errMsg.includes('timeout')) {
                        timedOut = true;
                        controller.abort(streamError);
                        runContext?.emit({ emitter: this.#httpClient.getEventEmitter(), name: EVENTS.CLIENT.WARNING, payload: {
                            message: `Stream interrupted/timeout: ${errMsg}. Yielding partial response salvaged from buffer.`
                        } });
                        runContext?.emit({ emitter: this.#httpClient.getEventEmitter(), name: EVENTS.CLIENT.SESSION_STREAM_TIMEOUT, payload: {
                            message: errMsg,
                            partialLength: partialText,
                        } });
                        yield { type: 'error', error_message: errMsg, error_type: 'timeout' };
                    } else {
                        throw streamError;
                    }
                }

                if (prematureEnd || timedOut) parser.discardInProgress();
                const finalResult = parser.getFinalResult();
                if (finalResult.thoughtSignature) { yield { type: 'metadata', thoughtSignature: finalResult.thoughtSignature }; }
                if (finalResult.toolCalls.length > 0) { yield { type: 'tool_calls', calls: finalResult.toolCalls }; }

                if (!prematureEnd || attempt >= MAX_PREMATURE_ATTEMPTS - 1 || signal?.aborted) {
                    if (prematureEnd) yield prematureEnd;
                    break;
                }

                runContext?.emit({ emitter: this.#httpClient.getEventEmitter(), name: EVENTS.CLIENT.WARNING, payload: {
                    code: 'STREAM_PREMATURE_RETRY',
                    message: `Provider closed the stream before finishing (PrematureEnd, reason: ${prematureEnd.reason ?? 'unknown'}). Retrying (attempt ${attempt + 2}/${MAX_PREMATURE_ATTEMPTS}).`
                } });
                try {
                    await sleepAbortable({ ms: LIMITS.premature_retry_backoff_ms * (attempt + 1), signal });
                } catch (abortErr) {
                    if (signal?.aborted) throw abortErr;
                    if (prematureEnd) yield prematureEnd;
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
            runContext?.emit({ emitter: this.#httpClient.getEventEmitter(), name: EVENTS.CLIENT.SESSION_PARAMS_FILTERED, payload: { profile: this.#profile, omitted } });
        }

        return requestData;
    }
}
