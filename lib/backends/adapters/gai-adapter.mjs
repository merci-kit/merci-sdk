// @ts-check
/**
 * @file GAI (Google GenAI) backend adapter.
 * @version 0.12.0
 *
 * @description
 * Maps unified SDK requests onto the Google Gemini wire shape (function
 * declaration + toolConfig modes, session/_tools merge), executes the
 * generateContentStream, and consumes stream chunks into unified events
 * (incl. per-call thought signatures and non-normal finish reasons).
 *
 * Unified citation / refusal shape (shared with the Anthropic adapter):
 *   - citations: `{ type: 'citations', data: { citations: [{ uri, title,
 *     text }] } }` — `text` is the quoted passage when the vendor provides
 *     one (Gemini `groundingChunks[].retrievedContext.text`, Anthropic
 *     `citations_delta.cited_text`), otherwise an empty string. The plain
 *     `{ type: 'sources', data: { sources: [{ title, url }] } }` tail is
 *     emitted next to it, like on the OAI/AAI adapters.
 *   - refusal: a `type: 'error'` event with `refusal: true`, the vendor reason
 *     kept in `error_type` (`SAFETY`, `BLOCKLIST`, `IMAGE_RECITATION`, …) and the
 *     additive `refusal: true` flag and the vendor's own reason in
 *     `refusal_reason` (Gemini `finishReason`, e.g. `SAFETY`; Anthropic
 *     `stop_reason`). The flag is the machine-readable signal — the
 *     vendor reason stays in `error_type` so the existing per-vendor
 *     classification keeps working.
 */

import { FunctionCallingConfigMode } from '../transport/gai-constants.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeToGAI } from '../../messaging/messages.mjs';
import { extractXmlToolCalls as _extractXmlToolCalls } from '../../tools/tool-execution.mjs';
import { guardedParse } from '../../support/json.mjs';
import { ProviderType, StandardType } from '../../core/constants/index.mjs';
import { runVendorCallWithRetry } from '../../support/retry-policy.mjs';
import { hasNativeLeg, createFirstTokenEmitter, hasAnyDeclaredTools, mergeToolsByName, quotaEvent, sessionIdOf, sourcesEvent, toolCallIdentity, truncationCheck, vendorCostUsd, warnSession as warnSessionCommon } from './adapter-common.mjs';
/**
 * @typedef {{ eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, provider?: string, _webSearch?: GaiWebSearch, _webScrape?: GaiWebScrape, _retryPolicy?: {shouldRetry: Function}|null, _maxElapsedMs?: number }} GaiSession
 * @typedef {{ mode?: string, maxResults?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, force?: boolean }} GaiWebSearch
 * @typedef {{ mode?: string, allowedDomains?: Array<string>, force?: boolean }} GaiWebScrape
 */

/**
 * Gemini finish reasons that mean the model refused to answer (the content
 * was blocked by the safety layer). They surface as a refusal, not as a
 * transport failure. Every refusal `promptFeedback.blockReason` the API
 * defines (SAFETY, BLOCKLIST, PROHIBITED_CONTENT, IMAGE_SAFETY) is also a
 * finish reason, so the block-reason path reads this same set.
 * @type {Set<string>}
 */
const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']);




/**
 * @param {{session: *, model: string, parameter: string, message: string}} arg0
 */
function warnSession({ session, model, parameter, message }) {
    warnSessionCommon({ session, model, parameter, message, provider: ProviderType.GOOGLE_GENAI, standard: StandardType.GAI });
}


/**
 * Maps Gemini's `groundingMetadata` onto the unified citation shape
 * (`{ uri, title, text }`). The vendor field names:
 *   - `groundingChunks[].web.uri` / `.web.title` — a web-search result
 *     (no quoted passage).
 *   - `groundingChunks[].retrievedContext.uri` / `.title` / `.text` — a
 *     retrieved passage (the quoted text).
 * @param {{grounding: Record<string, unknown>|null|undefined}} arg0 - The candidate's `groundingMetadata`.
 * @returns {Array<{uri: string, title: string, text: string}>} The citations.
 */
export function groundingCitations({ grounding }) {
    /** @type {Array<{uri: string, title: string, text: string}>} */
    const out = [];
    const chunks = /** @type {{groundingChunks?: Array<{web?: {uri?: string, title?: string}, retrievedContext?: {uri?: string, title?: string, text?: string}}>}} */ (grounding ?? {});
    for (const chunk of chunks.groundingChunks ?? []) {
        const web = chunk?.web;
        const ctx = chunk?.retrievedContext;
        if (web) {
            out.push({ uri: web.uri ?? '', title: web.title ?? '', text: '' });
        } else if (ctx) {
            out.push({ uri: ctx.uri ?? '', title: ctx.title ?? '', text: ctx.text ?? '' });
        }
    }
    return out;
}

/**
 * GAI backend adapter — implements the shared adapter contract for the
 * agentic loop: request building, vendor stream execution, stream
 * consumption, and tool-call extraction / formatting.
 * @type {import('./adapter-common.mjs').AdapterContract}
 */
export const gaiAdapter = {
    vendorName: 'GAI',

    /**
 * Builds the Gemini generateContent request.
 * @param {{model: string, parameters: Record<string, any>, tools: Array<Record<string, any>>, preparedMessages: Array<Record<string, any>>, forceTextResponse?: boolean, toolChoiceRequired?: boolean, thoughtSignature?: string, session?: GaiSession}} arg0
 * @returns {{request: Record<string, any>, observability: Record<string, any>}}
 */
    buildVendorRequest({ model, parameters, tools, preparedMessages, forceTextResponse, toolChoiceRequired, thoughtSignature, session }) {
        const { contents, systemInstruction } = normalizeToGAI({ msgs: preparedMessages, effectiveThoughtSignature: thoughtSignature });
        /** @type {Record<string, any>} */
        const config = {};

        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }

        // The GAI transport is stream-only (`streamGenerateContent?alt=sse`), and
        // Gemini rejects log probabilities there with 400 INVALID_ARGUMENT
        // ("LogProbs is not supported in streaming mode"). A knob must warn, not
        // kill the turn, so the pair is reported and dropped — the same shape the
        // oai adapter uses for a knob the Responses endpoint cannot carry.
        if (parameters.responseLogprobs !== undefined || parameters.logprobs !== undefined) {
            warnSession({ session, model, parameter: 'logprobs', message: 'GAI streams every request and Gemini rejects log probabilities in streaming mode; responseLogprobs/logprobs are dropped from this request.' });
        }

        const paramKeys = ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stopSequences', 'seed',
            'responseMimeType', 'responseJsonSchema', 'presencePenalty', 'frequencyPenalty', 'thinkingConfig',
            'cachedContent'];
        for (const key of paramKeys) {
            if (parameters[key] !== undefined) {
                config[key] = parameters[key];
            }
        }
        // The unified builder accepts lowercase; the vendor enum is uppercase.
        if (config.thinkingConfig?.thinkingLevel) {
            config.thinkingConfig = {
                ...config.thinkingConfig,
                thinkingLevel: String(config.thinkingConfig.thinkingLevel).toUpperCase(),
            };
        }

        const hasTools = tools.length > 0 || (parameters._tools && parameters._tools.length > 0);
        if (hasTools && !forceTextResponse) {
            const toolDefs = mergeToolsByName({ tools, specTools: parameters._tools });
            config.tools = [{
                functionDeclarations: toolDefs.map(t => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters || t.parametersJsonSchema
                }))
            }];

            const toolChoice = parameters._toolConfig;
            if (toolChoiceRequired) {
                config.toolConfig = {
                    functionCallingConfig: { mode: FunctionCallingConfigMode.ANY }
                };
            } else if (toolChoice) {
                if (toolChoice === 'auto') {
                    config.toolConfig = {
                        functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO }
                    };
                } else if (toolChoice === 'required') {
                    config.toolConfig = {
                        functionCallingConfig: { mode: FunctionCallingConfigMode.ANY }
                    };
                } else if (toolChoice === 'none') {
                    config.toolConfig = {
                        functionCallingConfig: { mode: FunctionCallingConfigMode.NONE }
                    };
                } else if (toolChoice.type === 'named' && toolChoice.name) {
                    config.toolConfig = {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.ANY,
                            allowedFunctionNames: [toolChoice.name]
                        }
                    };
                }
            }
        }

        const hasAnyTools = hasAnyDeclaredTools({ tools, specTools: parameters._tools });
        if (parameters.responseMimeType === 'application/json' && !parameters._toolConfig && !toolChoiceRequired && !hasAnyTools) {
            config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
        }

        if (hasNativeLeg({ session, cap: 'webSearch' })) {
            const ws = /** @type {GaiWebSearch} */ (session?._webSearch);
            config.tools = config.tools || [];
            /** @type {Record<string, any>} */
            const gs = { googleSearch: {} };
            if (ws.blockedDomains?.length) {
                if (session?.provider === ProviderType.VERTEX) {
                    gs.googleSearch.excludeDomains = ws.blockedDomains;
                } else {
                    warnSession({ session, model, parameter: 'webSearch.blockedDomains', message: 'Google Search excludeDomains is only supported on Vertex AI — no domain filters are injected on the Gemini API tier.' });
                }
            }
            config.tools.push(gs);
            if (ws.allowedDomains) {
                warnSession({ session, model, parameter: 'webSearch.allowedDomains', message: 'Google Search does not support allow-listed domains — only block-listed domains are injected.' });
            }
            if (ws.force && !forceTextResponse) {
                config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
            }
        }

        if (hasNativeLeg({ session, cap: 'webScrape' })) {
            const wsc = /** @type {GaiWebScrape} */ (session?._webScrape);
            config.tools = config.tools || [];
            config.tools.push({ urlContext: {} });
            if (wsc.allowedDomains?.length) {
                warnSession({ session, model, parameter: 'webScrape.allowedDomains', message: 'Google URL Context does not support allow-listed domains — no domain filters are injected.' });
            }
            if (wsc.force && !forceTextResponse && !config.toolConfig) {
                config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
            }
        }

        return {
            request: { model, contents, config },
            observability: { model, contents, config }
        };
    },

    /**
 * Opens the Gemini generateContentStream. The call runs under the session's
 * retry policy (`session._retryPolicy`), so a transient 429 / 5xx / network
 * failure is retried with the existing backoff instead of failing the run;
 * the operation is re-runnable, so a retry always opens a fresh stream.
 * @param {{vendorClient: Record<string, any>, request: Record<string, any>, signal?: AbortSignal, session: *}} arg0
 * @returns {Promise<Record<string, any>>} The raw vendor stream.
 */
    async executeVendorRequest({ vendorClient, request, signal, session }) {
        const sid = sessionIdOf({ session });
        const config = { ...request.config };
        if (signal) config.abortSignal = signal;
        if (sid) {
            config.httpOptions = { ...(config.httpOptions || {}), headers: { 'X-Merci-Session-Id': sid } };
        }
        return runVendorCallWithRetry({
            operation: async () => vendorClient.models.generateContentStream({
                model: request.model,
                contents: request.contents,
                config
            }),
            session,
            vendorName: 'GAI',
            signal,
        });
    },

    /**
 * Consumes Gemini stream chunks into unified stream events.
 * @param {{rawStream: *, signal: *}} arg0
 * @returns {AsyncGenerator<Record<string, any>>} Unified stream events (text/thought/tool_calls/quota/truncated/error/...).
 */
    async *consumeStream({ rawStream, signal }) {
        const { maybeFirstToken } = createFirstTokenEmitter();

        let toolCalls = [];
        let responseThoughtSignature = null;
        let finishReasonEmitted = false;
        /** A `finishReason` was reported (STOP included). */
        let sawTerminal = false;
        /** Text or tool calls reached the consumer. */
        let producedOutput = false;
        /** @type {Array<any>} */
        const thoughtParts = [];
        /** @type {Array<{uri: string, title: string, text: string}>} */
        const citations = [];
        const sigById = new Map();
        const seenCallIndexById = new Map();

        for await (const chunk of rawStream) {
            if (chunk.usageMetadata) {
                const u = chunk.usageMetadata;
                const total = u.totalTokenCount ?? ((u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0));
                if (total > 0) {
                    yield quotaEvent({
                        amount: total,
                        prompt: u.promptTokenCount,
                        completion: u.candidatesTokenCount,
                        costUsd: vendorCostUsd({ usage: u }),
                        cached: u.cachedContentTokenCount,
                        reasoning: u.thoughtsTokenCount,
                    });
                }
            }

            for (const citation of groundingCitations({ grounding: chunk.candidates?.[0]?.groundingMetadata })) {
                if (!citation.uri && !citation.title) continue;
                if (citations.some((c) => c.uri === citation.uri && c.title === citation.title)) continue;
                citations.push(citation);
            }

            const finishReason = chunk.candidates?.[0]?.finishReason;
            if (finishReason) sawTerminal = true;
            if (finishReason === 'MAX_TOKENS' && !finishReasonEmitted) {
                finishReasonEmitted = true;
                yield { type: 'truncated' };
            } else if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS' && !finishReasonEmitted) {
                finishReasonEmitted = true;
                const blocked = BLOCKED_FINISH_REASONS.has(finishReason);
                yield {
                    type: 'error',
                    error_message: blocked
                        ? `Gemini refused the request (finish reason: ${finishReason}).`
                        : `Gemini stream finished with reason: ${finishReason}`,
                    error_type: finishReason,
                    ...(blocked ? { refusal: true, refusal_reason: finishReason } : {}),
                };
            }

            const blockReason = chunk.promptFeedback?.blockReason;
            if (blockReason && !finishReasonEmitted) {
                finishReasonEmitted = true;
                const detail = chunk.promptFeedback?.blockReasonMessage;
                const blocked = BLOCKED_FINISH_REASONS.has(blockReason);
                yield {
                    type: 'error',
                    error_message: `Gemini prompt blocked: ${blockReason}${detail ? ` (${detail})` : ''}`,
                    error_type: blockReason,
                    ...(blocked ? { refusal: true, refusal_reason: blockReason } : {}),
                };
            }

            /** @type {Array<any>} */
            const rawParts = chunk.candidates?.[0]?.content?.parts || [];
            for (const part of rawParts) {
                if (part?.thoughtSignature) {
                    responseThoughtSignature = part.thoughtSignature;
                    if (part.functionCall?.id) sigById.set(part.functionCall.id, part.thoughtSignature);
                }
            }
            const thoughtText = rawParts.filter(p => p.text && p.thought).map(p => p.text).join('');
            if (thoughtText) {
                yield* maybeFirstToken();
                yield { type: 'thought', content: thoughtText };
            }
            for (const part of rawParts) {
                if (part?.text && part.thought) {
                    thoughtParts.push({
                        text: part.text,
                        thought: true,
                        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
                    });
                }
            }

            const chunkText = rawParts.filter(p => p.text && !p.thought).map(p => p.text).join('');
            if (chunkText) {
                producedOutput = true;
                yield* maybeFirstToken();
                yield { type: 'text', content: chunkText };
            }

            if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                producedOutput = true;
                for (const fc of chunk.functionCalls) {
                    const entry = {
                        id: fc.id || `call_${randomUUID()}`,
                        name: fc.name,
                        args: fc.args || {},
                        thoughtSignature: (fc.id && sigById.get(fc.id)) || null
                    };
                    if (fc.id && seenCallIndexById.has(fc.id)) {
                        toolCalls[seenCallIndexById.get(fc.id)] = entry;
                    } else {
                        if (fc.id) seenCallIndexById.set(fc.id, toolCalls.length);
                        toolCalls.push(entry);
                    }
                }
            }
        }

        // A candidate stream that never reported a finishReason was cut short.
        const state = /** @type {{streamState?: {sawAbort?: boolean}}|null} */ (/** @type {unknown} */ (rawStream))?.streamState;
        const sawAbort = state?.sawAbort === true || signal?.aborted === true;
        if (truncationCheck({ producedOutput, sawTerminal, sawAbort })) {
            yield { type: 'truncated' };
        }

        if (thoughtParts.length > 0) {
            yield { type: 'thought_parts', parts: thoughtParts };
        }
        if (responseThoughtSignature) {
            yield { type: 'thought_signature', signature: responseThoughtSignature };
        }
        if (toolCalls.length > 0) {
            yield { type: 'tool_calls', calls: toolCalls };
        }
        if (citations.length > 0) {
            yield { type: 'citations', data: { citations } };
            const sourcesEv = sourcesEvent({ citations });
            if (sourcesEv) yield sourcesEv;
        }
    },

    /**
 * Extracts `<tool_call>` rows from raw assistant text.
 * @param {{text: string}} arg0
 * @returns {Array<Record<string, any>>} Normalized function calls.
 */
    extractXmlToolCalls({ text }) {
        return _extractXmlToolCalls({ text }).map(tc => {
            const parsed = typeof tc.arguments === 'string' ? guardedParse({ input: tc.arguments }) : null;
            return {
                id: tc.id,
                name: tc.name,
                args: parsed ? (parsed.success ? parsed.data : tc.arguments) : tc.arguments
            };
        });
    },

    /**
 * Formats a tool call into a display row.
 * @param {{call: *, result: Record<string, any>, index: number}} arg0
 * @returns {Record<string, any>} Display row (id/name/args/thoughtSignature).
 */
    formatToolCall({ call, result, index }) {
        const identity = toolCallIdentity({ call, result, fallbackId: `call_${randomUUID()}` });
        return {
            id: identity.id,
            name: identity.name,
            args: typeof call.args === 'string'
                ? call.args
                : (call.args ?? (typeof call.function?.arguments === 'string' ? call.function.arguments : (call.function?.arguments ?? {}))),
            thoughtSignature: call.thoughtSignature || null
        };
    }
};
