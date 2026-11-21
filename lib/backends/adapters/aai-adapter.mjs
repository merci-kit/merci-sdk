// @ts-check
/**
 * @file AAI (Anthropic) backend adapter.
 * @version 0.12.0
 *
 * @description
 * Maps unified SDK requests onto the Anthropic messages wire shape (thinking
 * budget clamping, tool / JSON-mode tool_choice), executes the vendor stream,
 * and consumes message-stream events into unified stream events.
 *
 * Unified citation / refusal shape (shared with the Gemini adapter):
 *   - citations: `{ type: 'citations', data: { citations: [{ uri, title,
 *     text }] } }` — `text` is the quoted passage when the vendor provides
 *     one (Anthropic `citations_delta.citation.cited_text`), otherwise an
 *     empty string. The plain `{ type: 'sources', data: { sources: [{ title,
 *     url }] } }` tail is emitted next to it, like on the OAI/GAI adapters.
 *   - refusal: a `type: 'error'` event with `error_type: 'refusal'` plus the
 *     additive `refusal: true` flag and the vendor's own reason in
 *     `refusal_reason` (Anthropic `stop_reason: 'refusal'`; Gemini
 *     `finishReason`). The flag is the machine-readable signal.
 */

import { randomUUID } from 'node:crypto';
import { normalizeToAAI } from '../../messaging/messages.mjs';
import { extractXmlToolCalls as _extractXmlToolCalls, EMPTY_OBJECT_SCHEMA } from '../../tools/tool-execution.mjs';
import { guardedParse } from '../../support/json.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { runVendorCallWithRetry } from '../../support/retry-policy.mjs';
import { hasNativeLeg, createFirstTokenEmitter, hasAnyDeclaredTools, mergeToolsByName, quotaEvent, sessionIdOf, sourcesEvent, toolCallIdentity, truncationCheck, vendorCostUsd } from './adapter-common.mjs';
/**
 * @typedef {{ _webSearch?: AaiWebSearch, _webScrape?: AaiWebScrape, _retryPolicy?: {shouldRetry: Function}|null, _maxElapsedMs?: number }} AaiSession
 * @typedef {{ mode?: string, maxUses?: number, maxResults?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, location?: Object|null, force?: boolean }} AaiWebSearch
 * @typedef {{ mode?: string, maxUses?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, force?: boolean }} AaiWebScrape
 */




/**
 * Maps an Anthropic citation onto the unified citation shape
 * (`{ uri, title, text }`). The vendor field names:
 *   - `web_search_result_location`: `url`, `title`, `cited_text`.
 *   - `char_location` / `content_block_location`: `document_title`,
 *     `cited_text` (no url).
 *   - `web_search_result` (a server-tool result): `url`, `title`.
 * @param {{citation: unknown}} arg0 - The vendor citation object.
 * @returns {{uri: string, title: string, text: string}} The unified citation.
 */
export function aaiCitation({ citation }) {
    const c = /** @type {any} */ (citation) ?? {};
    return {
        uri: c.url ?? c.uri ?? '',
        title: c.title ?? c.document_title ?? c.name ?? '',
        text: c.cited_text ?? c.text ?? '',
    };
}

/**
 * AAI backend adapter — implements the shared adapter contract for the
 * agentic loop: request building, vendor stream execution, stream
 * consumption, and tool-call extraction / formatting.
 * @type {import('./adapter-common.mjs').AdapterContract}
 */
export const aaiAdapter = {
    vendorName: 'AAI',

    /**
 * Builds the Anthropic messages request.
 * @param {{model: string, parameters: Record<string, any>, tools: Array<Record<string, any>>, preparedMessages: Array<Record<string, any>>, forceTextResponse?: boolean, toolChoiceRequired?: boolean, session?: AaiSession}} arg0
 * @returns {{request: Record<string, any>, observability: Record<string, any>}}
 */
    buildVendorRequest({ model, parameters, tools, preparedMessages, forceTextResponse, toolChoiceRequired, session }) {
        const { messages: normalizedMsgs, system: normalizedSystem } = normalizeToAAI({ msgs: preparedMessages });

        /** @type {Record<string, any>} */
        const params = {
            model,
            max_tokens: parameters.max_tokens || LIMITS.anthropic_max_tokens,
            messages: normalizedMsgs,
            stream: true
        };

        if (normalizedSystem) params.system = normalizedSystem;

        // Anthropic marks a cache breakpoint on a content block, not on a request
        // parameter. The SESSION hands us the last block of the cached prefix
        // (`_cacheAnchor`: `{text}` or `{toolUseId}`). Without an anchor we mark
        // nothing: marking the tail is the documented antipattern (fix-plan §0.5)
        // — it writes a fresh entry every iteration and never reads one.
        const cachePoints = Number(parameters._cachePoints) > 0 ? Number(parameters._cachePoints) : 0;
        if (cachePoints > 0) {
            const cacheType = parameters._cachePointType || 'ephemeral';
            const cacheTtl = typeof parameters._cachePointTtl === 'string' && parameters._cachePointTtl
                ? parameters._cachePointTtl
                : null;
            const cacheControl = { type: cacheType, ...(cacheTtl ? { ttl: cacheTtl } : {}) };
            /** @param {{message: any, blockIndex: number}} arg0 */
            const markBlock = ({ message, blockIndex }) => {
                // Clone the blocks: `normalizeToAAI` passes the caller's block
                // objects straight through, so writing `cache_control` in place
                // would leave it in the session history and every later iteration
                // would resend it (N markers by request N, >4 breaks the vendor).
                const blocks = Array.isArray(message.content)
                    ? message.content.map((/** @type {any} */ b) => (b && typeof b === 'object' ? { ...b } : b))
                    : [{ type: 'text', text: String(message.content ?? '') }];
                const block = blocks[blockIndex < 0 ? blocks.length - 1 : blockIndex];
                if (block && typeof block === 'object') block.cache_control = cacheControl;
                message.content = blocks;
            };
            const anchor = parameters._cacheAnchor;
            const anchorText = anchor && typeof anchor.text === 'string' && anchor.text ? anchor.text : null;
            const anchorToolId = anchor && typeof anchor.toolUseId === 'string' && anchor.toolUseId ? anchor.toolUseId : null;
            /** @param {any} block */
            const matchesAnchor = (block) => {
                if (!block || typeof block !== 'object') return false;
                if (anchorText != null) return String(block.text ?? '') === anchorText;
                if (anchorToolId != null) {
                    return String(block.tool_use_id ?? block.id ?? '') === anchorToolId;
                }
                return false;
            };
            let anchoredAt = -1;
            if (anchorText || anchorToolId) {
                // Walk backwards: the LAST matching block ends the stable prefix (the
                // volatile block follows it when the adapter merged the two rows).
                for (let i = params.messages.length - 1; i >= 0 && anchoredAt < 0; i--) {
                    const message = params.messages[i];
                    const blocks = Array.isArray(message.content)
                        ? message.content
                        : [{ type: 'text', text: String(message.content ?? '') }];
                    for (let j = blocks.length - 1; j >= 0; j--) {
                        if (matchesAnchor(blocks[j])) {
                            markBlock({ message, blockIndex: j });
                            anchoredAt = i;
                            break;
                        }
                    }
                }
            }
            if (anchoredAt >= 0 && cachePoints > 1) {
                // Extra breakpoints help only when a prefix behind the anchor stays
                // still; spread them backwards and keep them off the volatile tail.
                let remaining = cachePoints - 1;
                const stride = Math.max(1, Math.floor(anchoredAt / (remaining + 1)));
                for (let i = anchoredAt - stride; i >= 0 && remaining > 0; i -= stride) {
                    const message = params.messages[i];
                    const blocks = Array.isArray(message.content) ? message.content : null;
                    if (!blocks || blocks.length === 0) continue;
                    const block = blocks[blocks.length - 1];
                    if (block && typeof block === 'object' && !block.cache_control) {
                        markBlock({ message, blockIndex: -1 });
                        remaining--;
                    }
                }
            }
        }

        const passthrough = ['temperature', 'top_p', 'top_k', 'stop_sequences', 'thinking', 'metadata', 'service_tier', 'output_config'];
        for (const key of passthrough) {
            if (parameters[key] !== undefined) params[key] = parameters[key];
        }

        if (params.thinking && params.thinking.type === 'enabled' && typeof params.thinking.budget_tokens === 'number') {
            const minBudget = LIMITS.anthropic_min_thinking_budget;
            const maxTokens = parameters.max_tokens || LIMITS.anthropic_max_tokens;
            let budget = params.thinking.budget_tokens;
            if (budget < minBudget) {
                sdkWarn({ prefix: 'AAI', args: [`thinking budget ${budget} below the ${minBudget} minimum — clamping to ${minBudget}`] });
                budget = minBudget;
            }
            if (budget >= maxTokens) {
                if (maxTokens - 1 >= minBudget) {
                    sdkWarn({ prefix: 'AAI', args: [`thinking budget ${budget} must be < max_tokens (${maxTokens}) — clamping to ${maxTokens - 1}`] });
                    budget = maxTokens - 1;
                } else {
                    budget = minBudget;
                    params.max_tokens = budget + 1;
                    sdkWarn({ prefix: 'AAI', args: [`max_tokens (${maxTokens}) cannot fit the ${minBudget}-token minimum thinking budget — raising max_tokens to ${params.max_tokens}`] });
                }
            }
            if (budget !== params.thinking.budget_tokens) {
                params.thinking = { ...params.thinking, budget_tokens: budget };
            }
        }

        const declaredTools = mergeToolsByName({ tools, specTools: parameters._tools });
        if (declaredTools.length > 0) {
            params.tools = declaredTools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters || t.input_schema || EMPTY_OBJECT_SCHEMA
            }));
        }

        if (parameters._toolChoice) {
            const tc = parameters._toolChoice;
            if (tc === 'auto') params.tool_choice = { type: 'auto' };
            else if (tc === 'any' || tc === 'required') params.tool_choice = { type: 'any' };
            else if (tc === 'none') params.tool_choice = { type: 'none' };
            else if (tc && typeof tc === 'object') {
                if (tc.type === 'named' && tc.name) params.tool_choice = { type: 'tool', name: tc.name };
                else params.tool_choice = tc;
            }
        }

        const disableParallel = parameters?._parallelToolCalls === false || parameters?.parallelToolCalls === false;
        if (disableParallel) {
            if (params.tool_choice && params.tool_choice.type !== 'none') {
                params.tool_choice = { ...params.tool_choice, disable_parallel_tool_use: true };
            } else if (!params.tool_choice && Array.isArray(params.tools) && params.tools.length > 0) {
                params.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
            }
        }

        if (forceTextResponse) {
            params.tool_choice = { type: 'none' };
        } else if (toolChoiceRequired) {
            params.tool_choice = { type: 'any', ...(disableParallel ? { disable_parallel_tool_use: true } : {}) };
        }

        const hasAnyTools = hasAnyDeclaredTools({ tools, specTools: parameters._tools });
        if (parameters._jsonMode && !hasAnyTools && !parameters._toolChoice && !toolChoiceRequired && !forceTextResponse) {
            if (parameters._jsonSchema) {
                // Native structured output: the answer arrives as text that
                // matches the schema, so `_validateDeliverable` reads it
                // unchanged. The forced `json_output` tool was rejected as an
                // unknown tool when the caller declared none.
                params.output_config = {
                    ...(params.output_config ?? {}),
                    format: { type: 'json_schema', schema: parameters._jsonSchema },
                };
            } else {
                params.tool_choice = { type: 'none' };
            }
        }

        if (hasNativeLeg({ session, cap: 'webSearch' })) {
            const ws = /** @type {AaiWebSearch} */ (session?._webSearch);
            /** @type {Record<string, any>} */
            const webTool = {
                type: 'web_search_20260209',
                name: 'web_search',
                allowed_callers: ['direct'],
            };
            const maxUses = ws.maxUses ?? ws.maxResults;
            if (maxUses != null) webTool.max_uses = maxUses;
            if (ws.allowedDomains?.length) webTool.allowed_domains = ws.allowedDomains;
            else if (ws.blockedDomains?.length) webTool.blocked_domains = ws.blockedDomains;
            if (ws.location) webTool.user_location = ws.location;
            params.tools = params.tools || [];
            params.tools.push(webTool);
            if (ws.force && !forceTextResponse) {
                params.tool_choice = { type: 'any', ...(disableParallel ? { disable_parallel_tool_use: true } : {}) };
            }
        }

        if (hasNativeLeg({ session, cap: 'webScrape' })) {
            const wsc = /** @type {AaiWebScrape} */ (session?._webScrape);
            /** @type {Record<string, any>} */
            const fetchTool = {
                type: 'web_fetch_20260209',
                name: 'web_fetch',
                allowed_callers: ['direct'],
            };
            const maxUses = wsc.maxUses;
            if (maxUses != null) fetchTool.max_uses = maxUses;
            if (wsc.allowedDomains?.length) fetchTool.allowed_domains = wsc.allowedDomains;
            else if (wsc.blockedDomains?.length) fetchTool.blocked_domains = wsc.blockedDomains;
            params.tools = params.tools || [];
            params.tools.push(fetchTool);
            if (wsc.force && !forceTextResponse && !params.tool_choice) {
                params.tool_choice = { type: 'any', ...(disableParallel ? { disable_parallel_tool_use: true } : {}) };
            }
        }

        return {
            request: params,
            observability: { model, messages: normalizedMsgs, params }
        };
    },

    /**
 * Opens the Anthropic message stream. The call runs under the session's
 * retry policy (`session._retryPolicy`), so a transient 429 / 5xx / network
 * failure is retried with the existing backoff instead of failing the run;
 * the operation is re-runnable, so a retry always opens a fresh stream.
 * @param {{vendorClient: Record<string, any>, request: Record<string, any>, signal?: AbortSignal, session: *}} arg0
 * @returns {Promise<Record<string, any>>} The raw vendor message stream.
 */
    async executeVendorRequest({ vendorClient, request, signal, session }) {
        const sid = sessionIdOf({ session });
        return runVendorCallWithRetry({
            operation: async () => {
                if (sid) {
                    return vendorClient.messages.stream(request, { signal, headers: { 'x-merci-session-id': sid } });
                }
                return vendorClient.messages.stream(request, { signal });
            },
            session,
            vendorName: 'AAI',
            signal,
        });
    },

    /**
 * Consumes Anthropic message-stream events into unified stream events.
 * @param {{rawStream: *, signal: *}} arg0
 * @returns {AsyncGenerator<Record<string, any>>} Unified stream events (text/thought/tool_calls/quota/truncated/...).
 */
    async *consumeStream({ rawStream, signal }) {
        const { maybeFirstToken } = createFirstTokenEmitter();

        let toolCalls = [];
        let lastSignature = null;
        let usage = null;
        let truncationEmitted = false;
        let refusalEmitted = false;
        let pauseEmitted = false;
        /** A protocol terminal fact was seen (`message_stop`/`stop_reason`). */
        let sawTerminal = false;
        /** A content block started (or text was yielded). */
        let producedOutput = false;
        const pendingBlocks = new Map();
        /** @type {Array<any>} */
        const nativeCitations = [];
        /** @type {Array<{uri: string, title: string, text: string}>} */
        const citations = [];
        const redactedThinking = [];
        const thinkingBlocks = [];

        /**
         * @param {{citation: any}} arg0
         */
        const addCitation = ({ citation }) => {
            nativeCitations.push(citation);
            const unified = aaiCitation({ citation });
            if (!unified.uri && !unified.title) return;
            if (citations.some((c) => c.uri === unified.uri && c.title === unified.title)) return;
            citations.push(unified);
        };

        for await (const event of rawStream) {
            if (!event || !event.type) continue;

            switch (event.type) {
                case 'message_start':
                    if (event.message && event.message.usage) {
                        usage = event.message.usage;
                    }
                    break;
                case 'content_block_start': {
                    const block = event.content_block;
                    const idx = event.index;
                    if (!block) break;
                    producedOutput = true;
                    if (block.type === 'text') {
                        pendingBlocks.set(idx, { type: 'text', text: block.text || '' });
                    } else if (block.type === 'tool_use') {
                        pendingBlocks.set(idx, {
                            type: 'tool_use',
                            id: block.id,
                            name: block.name,
                            inputJson: ''
                        });
                    } else if (block.type === 'thinking') {
                        pendingBlocks.set(idx, { type: 'thinking', text: block.thinking || '' });
                    } else if (block.type === 'redacted_thinking') {
                        pendingBlocks.set(idx, { type: 'redacted_thinking', data: block.data || '' });
                    } else if (block.type === 'web_search_tool_result' || block.type === 'server_tool_result') {
                        for (const citation of (Array.isArray(block.content) ? block.content : [])) {
                            addCitation({ citation });
                        }
                    }
                    break;
                }
                case 'content_block_delta': {
                    const delta = event.delta;
                    const idx = event.index;
                    if (!delta) break;
                    const pending = pendingBlocks.get(idx);
                    if (delta.type === 'text_delta') {
                        const chunk = delta.text || '';
                        if (pending && pending.type === 'text') pending.text += chunk;
                        yield* maybeFirstToken();
                        yield { type: 'text', content: chunk };
                    } else if (delta.type === 'input_json_delta') {
                        if (pending && pending.type === 'tool_use') {
                            pending.inputJson += delta.partial_json || '';
                        }
                    } else if (delta.type === 'thinking_delta') {
                        const chunk = delta.thinking || '';
                        if (pending && pending.type === 'thinking') pending.text += chunk;
                        if (chunk) {
                            yield* maybeFirstToken();
                            yield { type: 'thought', content: chunk };
                        }
                    } else if (delta.type === 'signature_delta') {
                        lastSignature = delta.signature || lastSignature;
                        if (pending && pending.type === 'thinking' && delta.signature) pending.signature = delta.signature;
                    } else if (delta.type === 'citations_delta' && delta.citation) {
                        addCitation({ citation: delta.citation });
                    }
                    break;
                }
                case 'content_block_stop': {
                    const idx = event.index;
                    const pending = pendingBlocks.get(idx);
                    if (!pending) break;
                    if (pending.type === 'tool_use') {
                        const raw = pending.inputJson || '{}';
                        const parsed = guardedParse({ input: raw });
                        toolCalls.push({
                            id: pending.id,
                            type: 'tool_use',
                            name: pending.name,
                            input: parsed.success ? (parsed.data ?? {}) : raw
                        });
                    } else if (pending.type === 'redacted_thinking' && pending.data) {
                        redactedThinking.push(pending.data);
                        thinkingBlocks.push({ type: 'redacted_thinking', data: pending.data });
                    } else if (pending.type === 'thinking') {
                        thinkingBlocks.push({
                            type: 'thinking',
                            thinking: pending.text ?? '',
                            ...(pending.signature ?? lastSignature ? { signature: pending.signature ?? lastSignature } : {}),
                        });
                    }
                    pendingBlocks.delete(idx);
                    break;
                }
                case 'message_delta': {
                    if (event.usage) usage = { ...(usage || {}), ...event.usage };
                    const stopReason = event.delta?.stop_reason;
                    if (stopReason) sawTerminal = true;
                    if ((stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') && !truncationEmitted) {
                        truncationEmitted = true;
                        yield { type: 'truncated' };
                    } else if (stopReason === 'refusal' && !refusalEmitted) {
                        refusalEmitted = true;
                        yield {
                            type: 'error',
                            error_message: 'Anthropic refused the request (stop_reason: refusal).',
                            error_type: 'refusal',
                            refusal: true,
                            refusal_reason: 'refusal',
                        };
                    } else if (stopReason === 'pause_turn' && !pauseEmitted) {
                        pauseEmitted = true;
                        yield {
                            type: 'error',
                            error_message: 'Anthropic paused the turn (stop_reason: pause_turn); resend the conversation to continue.',
                            error_type: 'pause_turn',
                        };
                    }
                    break;
                }
                case 'message_stop':
                    sawTerminal = true;
                    break;
            }
        }

        // A message that ended before its terminal fact was cut short; a
        // half-built tool_use block (no content_block_stop) is dropped above
        // and must never execute.
        const state = /** @type {{streamState?: {sawAbort?: boolean}}|null} */ (/** @type {unknown} */ (rawStream))?.streamState;
        const sawAbort = state?.sawAbort === true || signal?.aborted === true;
        if (truncationCheck({ producedOutput, sawTerminal, sawAbort })) {
            yield { type: 'truncated' };
        }

        if (usage && (usage.input_tokens || usage.output_tokens)) {
            yield quotaEvent({
                prompt: usage.input_tokens,
                completion: usage.output_tokens,
                cacheCreation: usage.cache_creation_input_tokens,
                cached: usage.cache_read_input_tokens,
                costUsd: vendorCostUsd({ usage }),
            });
        }

        if (thinkingBlocks.length > 0) {
            yield { type: 'thinking_blocks', blocks: thinkingBlocks };
        }
        if (redactedThinking.length > 0) {
            yield { type: 'redacted_thinking', blocks: redactedThinking };
        }
        if (lastSignature) {
            yield { type: 'thought_signature', signature: lastSignature };
        }
        if (toolCalls.length > 0) {
            yield { type: 'tool_calls', calls: toolCalls };
        }
        if (citations.length > 0) {
            yield { type: 'citations', data: { citations } };
        }
        const sourcesEv = sourcesEvent({ citations: nativeCitations });
        if (sourcesEv) yield sourcesEv;
    },

    /**
 * Extracts `<tool_call>` rows from raw assistant text.
 * @param {{text: string}} arg0
 * @returns {Array<Record<string, any>>} Normalized tool_use calls.
 */
    extractXmlToolCalls({ text }) {
        return _extractXmlToolCalls({ text }).map(tc => {
            const parsed = guardedParse({ input: tc.arguments });
            return {
                id: tc.id,
                type: 'tool_use',
                name: tc.name,
                input: parsed.success ? (parsed.data ?? {}) : tc.arguments
            };
        });
    },

    /**
 * Formats a tool call into a display row.
 * @param {{call: *, result: Record<string, any>, index: number}} arg0
 * @returns {Record<string, any>} Display row (id/name/args).
 */
    formatToolCall({ call, result, index }) {
        const identity = toolCallIdentity({ call, result, fallbackId: `call_${randomUUID()}` });
        return {
            id: identity.id,
            name: identity.name,
            args: typeof call.input === 'string'
                ? call.input
                : JSON.stringify(call.input ?? call.arguments ?? {})
        };
    }
};
