// @ts-check
/**
 * @file OAI (OpenAI-compatible) backend adapter.
 * @version 0.12.0
 *
 * @description
 * Maps unified SDK requests onto the OpenAI wire shape for both chat
 * completions and the Responses API (strict-schema enforcement, JSON-mode
 * prompt injection, OPENCODE tool_choice downgrade), executes the vendor
 * stream, and consumes stream events into unified events (incl. DeepSeek
 * reasoning_content and o-series cache/thinking usage).
 *
 * `stream: false` is supported: the vendor call is issued without the
 * `stream` flag and the complete response object (a chat-completions object
 * or a Responses object) is mapped onto the SAME unified events the
 * streaming path produces — `first_token`, `text`, `thought`, `tool_calls`,
 * `quota`, `truncated`, `error`, `reasoning_item`, `sources` — so the rest
 * of the agentic loop is unchanged. `stream` still defaults to `true`.
 */

import { randomUUID } from 'node:crypto';
import { normalizeToOAI, getNative } from '../../messaging/messages.mjs';
import { extractXmlToolCalls as _extractXmlToolCalls } from '../../tools/tool-execution.mjs';
import { ProviderType, StandardType } from '../../core/constants/index.mjs';
import { BackendError } from '../../core/errors.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { runVendorCallWithRetry } from '../../support/retry-policy.mjs';
import { hasNativeLeg, createFirstTokenEmitter, hasAnyDeclaredTools, mergeToolsByName, quotaEvent, sourcesEvent, toolCallIdentity, truncationCheck, vendorCostUsd, warnSession as warnSessionCommon } from './adapter-common.mjs';

/**
 * @typedef {{ opencodeSessionId?: string, sessionId?: string, _sessionRunCtx?: { runId?: string }, provider?: string, protocol?: string, responsesAssistantPartType?: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, _webSearch?: OaiWebSearch, _webScrape?: OaiWebScrape }} OaiSession
 * @typedef {{ mode?: string, maxResults?: number, maxUses?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, location?: Object|null, force?: boolean }} OaiWebSearch
 * @typedef {{ mode?: string, maxChars?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, force?: boolean }} OaiWebScrape
 */

/**
 * The vendor's own message, however the frame carried it: the error object
 * itself, a plain string, or one extra `{ error: ... }` wrapper.
 * @param {{errObj: any, fallbackMessage: string}} arg0
 * @returns {string}
 */
function errorMessageOf({ errObj, fallbackMessage }) {
    const unwrapped = errObj && typeof errObj === 'object' && errObj.error ? errObj.error : errObj;
    const message = typeof unwrapped === 'string' ? unwrapped : unwrapped?.message;
    return message || fallbackMessage;
}

/**
 * @param {{errObj: any, fallbackMessage?: string}} arg0
 * @returns {Record<string, any>}
 */
function buildResponsesErrorEvent({ errObj, fallbackMessage = 'OpenAI Responses stream error' }) {
    const code = errObj?.code ?? errObj?.type ?? null;
    const isInvalid = typeof code === 'string' && /invalid|schema|bad_request|unsupported|unknown_parameter|context_length/i.test(code);
    const status = typeof errObj?.status === 'number' ? errObj.status : (isInvalid ? 400 : undefined);
    const error_type = isInvalid ? (code || 'invalid_request_error') : (code || 'error');
    const error_message = errorMessageOf({ errObj, fallbackMessage });
    return {
        type: 'error',
        error_message,
        error_type,
        ...(status !== undefined ? { status } : {}),
        data: errObj ?? {},
    };
}

/**
 * @param {{session: *, model: string, parameter: string, message: string}} arg0
 */
function warnSession({ session, model, parameter, message }) {
    warnSessionCommon({ session, model, parameter, message, provider: ProviderType.OPENAI, standard: StandardType.OAI });
}


/**
 * Whether a chunk is a COMPLETE (non-streaming) vendor response rather than
 * a stream event: a Responses object (`object: 'response'` / `output[]`) or a
 * chat-completions object (`choices[].message`). The streaming chunks carry
 * `choices[].delta` or a `response.*` event type instead.
 * @param {{chunk: any}} arg0 -
 * @returns {boolean}
 */
function isFullResponse({ chunk }) {
    if (!chunk || typeof chunk !== 'object') return false;
    if (chunk.object === 'response' || Array.isArray(chunk.output)) return true;
    const choices = chunk.choices;
    return Array.isArray(choices) && choices.some((/** @type {any} */ c) => c && c.message);
}

/**
 * The loud failure for a vendor answer that is not a JSON object — a proxy,
 * WAF or login page answering 200 with HTML. A silent empty success would look
 * like a finished turn, so this throws instead. The message carries a bounded
 * prefix of the body (never the whole page) so the failure names what arrived.
 * @param {{body: unknown}} arg0 - The non-object body the vendor returned.
 * @returns {BackendError} A non-retryable (400-shaped) backend error.
 */
function nonJsonResponseError({ body }) {
    const text = typeof body === 'string' ? body : String(body ?? '');
    const prefix = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    return new BackendError({
        message: prefix
            ? `OAI vendor answered with non-JSON content instead of a JSON response (body starts with: ${JSON.stringify(prefix)}). A proxy, WAF or login page may be intercepting the API endpoint.`
            : 'OAI vendor answered with non-JSON content instead of a JSON response (empty body). A proxy, WAF or login page may be intercepting the API endpoint.',
        options: { status: 400, context: { bodyPrefix: prefix } },
    });
}


/**
 * The `quota` event for an OAI/Responses usage object, or `null` when it
 * reports no tokens. The three wire positions (a complete response, a
 * `response.completed` event, a chat chunk) carry the same fields under the
 * two API dialects' names. A body carries one dialect only, so the
 * chat-completions names lead and the Responses names are the fallback.
 * @param {{usage: any}} arg0 - The vendor's usage object.
 * @returns {{type: 'quota', data: Record<string, unknown>}|null} The quota event, or `null`.
 */
function openAIQuota({ usage }) {
    const u = usage;
    if (!u) return null;
    const total = u.total_tokens ?? ((u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0));
    if (total <= 0) return null;
    return quotaEvent({
        amount: total,
        prompt: u.prompt_tokens ?? u.input_tokens,
        completion: u.completion_tokens ?? u.output_tokens,
        cached: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens,
        costUsd: vendorCostUsd({ usage: u }),
    });
}

/**
 * Maps a complete (non-streaming) vendor response onto the unified event
 * stream — the same events, in the same order, the streaming path yields.
 * @param {{response: any}} arg0 - The vendor response object.
 * @returns {AsyncGenerator<Record<string, any>>} Unified stream events.
 */
async function* consumeFullResponse({ response }) {
    const { maybeFirstToken } = createFirstTokenEmitter();
    const body = /** @type {any} */ (response);
    if (body === null || body === undefined) return;
    if (typeof body !== 'object') throw nonJsonResponseError({ body });

    /** @type {Array<Record<string, any>>} */
    const calls = [];
    /** @type {Array<any>} */
    const citations = [];
    /** @type {Array<any>} */
    const reasoningItems = [];
    let text = '';
    let refusal = '';

    const isResponses = body.object === 'response' || Array.isArray(body.output);
    if (isResponses) {
        for (const item of body.output ?? []) {
            if (item?.type === 'function_call') {
                calls.push({
                    id: item.call_id || item.id || `call_${calls.length}`,
                    type: 'function',
                    function: {
                        name: item.name || '',
                        arguments: typeof item.arguments === 'string'
                            ? item.arguments
                            : JSON.stringify(item.arguments ?? {}),
                    },
                });
            } else if (item?.type === 'reasoning') {
                reasoningItems.push(item);
            } else if (item?.type === 'message') {
                for (const part of item.content ?? []) {
                    if (part?.type === 'output_text' && part.text) text += part.text;
                    else if (part?.type === 'refusal' && part.refusal) refusal += part.refusal;
                    if (Array.isArray(part?.annotations)) citations.push(...part.annotations);
                }
            }
        }
    } else {
        const choice = body.choices?.[0];
        const message = choice?.message ?? {};
        const content = message.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
            text = content
                .filter((/** @type {any} */ p) => p?.type === 'text')
                .map((/** @type {any} */ p) => p.text || '')
                .join('');
        }
        if (typeof message.refusal === 'string') refusal = message.refusal;
        for (const tc of message.tool_calls ?? []) {
            calls.push({
                id: tc.id || `call_${calls.length}`,
                type: 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
            });
        }
    }

    if (text) {
        yield* maybeFirstToken();
        yield { type: 'text', content: text };
    }
    if (refusal) {
        yield* maybeFirstToken();
        yield { type: 'text', content: refusal };
        yield { type: 'error', error_message: refusal, error_type: 'refusal' };
    }
    for (const item of reasoningItems) {
        yield { type: 'reasoning_item', protocol: 'responses', item };
    }

    if (isResponses) {
        if (body.status === 'incomplete') {
            const reason = body.incomplete_details?.reason;
            if (reason === 'max_output_tokens') {
                yield { type: 'truncated' };
            } else if (body.error) {
                yield buildResponsesErrorEvent({ errObj: body.error, fallbackMessage: 'Responses response incomplete' });
            } else if (reason) {
                yield { type: 'error', error_message: `Responses response incomplete: ${reason}`, error_type: reason };
            } else {
                yield { type: 'error', error_message: 'Responses response incomplete with no reason.', error_type: 'incomplete' };
            }
        } else if (body.status === 'failed' || body.error) {
            yield buildResponsesErrorEvent({ errObj: body.error, fallbackMessage: 'OpenAI Responses call failed' });
        }
    } else {
        const finishReason = body.choices?.[0]?.finish_reason;
        if (finishReason === 'length') {
            yield { type: 'truncated' };
        } else if (finishReason && finishReason !== 'stop'
            && finishReason !== 'tool_calls' && finishReason !== 'function_call') {
            yield { type: 'error', error_message: `OpenAI stream finished with reason: ${finishReason}`, error_type: finishReason };
        }
    }

    const quota = openAIQuota({ usage: body.usage });
    if (quota) yield quota;

    if (calls.length > 0) yield { type: 'tool_calls', calls };

    const sourcesEv = sourcesEvent({ citations });
    if (sourcesEv) yield sourcesEv;
}

/**
 * The Responses API assistant text part type used by default. `input_text` is
 * the only text variant `EasyInputMessage.content` (a request input item) puts
 * in its union: `output_text` belongs to `ResponseOutputMessage`, which is an
 * *output* item and requires `id`, `status` and annotated parts. A host that
 * needs that other shape sets `session.responsesAssistantPartType`.
 *
 * @type {string}
 */
export const DEFAULT_RESPONSES_ASSISTANT_PART = 'input_text';

/**
 * The URL a chat-shape image part carries: OpenRouter/chat gives an object
 * (`{ url }`), the Responses shape gives the string itself.
 * @param {{part: any}} arg0
 * @returns {string|undefined}
 */
function imagePartUrl({ part }) {
  return typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
}

/**
 * Converts chat-shape messages into Responses API input items.
 * @param {{messages: Array<import('../../messaging/unified-message.mjs').MessageRow>, assistantPartType?: string, nativeProvider?: string}} arg0
 * @returns {Array<Record<string, any>>} Responses API input items.
 */
function toResponsesInput({ messages, assistantPartType = DEFAULT_RESPONSES_ASSISTANT_PART, nativeProvider }) {
  const input = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const native = getNative({ row: m });
    if (native && native.protocol === 'responses' && native.provider === nativeProvider) {
      for (const item of native.items) {
        if (item && typeof item === 'object' && item.type === 'reasoning'
            && (typeof item.encrypted_content === 'string' || Array.isArray(item.summary))) {
          input.push(item);
        }
      }
    }
    if (m.role === 'tool') {
      // A Responses function-call output may be a list of content parts, so an
      // image survives here (a chat-completions tool message is text-only).
      const output = Array.isArray(m.content)
        ? m.content.map((/** @type {any} */ part) => (part?.type === 'image_url'
            ? { type: 'input_image', image_url: imagePartUrl({ part }), detail: 'auto' }
            : { type: 'input_text', text: String(part?.text ?? '') }))
        : (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m.result ?? ''));
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || m.id || '',
        output,
      });
      continue;
    }
    const partType = m.role === 'assistant' ? assistantPartType : 'input_text';
    /** @param {{content: *}} arg0 */
    /** @param {{content: *}} arg0 */
    const toParts = ({ content }) => {
      if (typeof content !== 'string' && Array.isArray(content)) {
        return content.map((part) => {
          if (part?.type === 'image_url') return { type: 'input_image', image_url: imagePartUrl({ part }), detail: 'auto' };
          if (part?.type === 'file' && part.file?.file_data) {
            return { type: 'input_file', filename: part.file.filename, file_data: part.file.file_data };
          }
          if (part?.type === 'file' && part.file?.file_id) {
            return { type: 'input_file', file_id: part.file.file_id };
          }
          if (part?.type === 'text') return { type: partType, text: part.text };
          return { type: partType, text: JSON.stringify(part ?? '') };
        });
      }
      return [{ type: partType, text: typeof content === 'string' ? content : JSON.stringify(content ?? '') }];
    };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const parts = m.content ? toParts({ content: m.content }) : [];
      if (parts.length > 0) input.push({ type: 'message', role: 'assistant', content: parts });
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name ?? tc.name ?? '',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
      continue;
    }
    const role = String(m.role ?? '');
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) continue;
    const parts = toParts({ content: m.content });
    if (parts.length === 0) continue;
    input.push({ type: 'message', role, content: parts });
  }
  return input;
}

/**
 * Recursively enforces the Responses API strict-JSON-schema rules at every
 * object level (additionalProperties:false + full `required`).
 * @param {Record<string, any>} node - JSON schema node.
 * @returns {Record<string, any>|Array<Record<string, any>>} The strict-enforced schema.
 */
function enforceStrictSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(enforceStrictSchema);
  /** @type {Record<string, any>} */
  const out = { ...node };
  const hasProps = out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties);
  if (out.type === 'object' || (hasProps && !out.type)) {
    if (!out.type) out.type = 'object';
    out.additionalProperties = false;
    if (hasProps) {
      out.properties = { ...out.properties };
      const keys = Object.keys(out.properties);
      out.required = [...new Set([...(out.required || []), ...keys])];
      for (const key of keys) {
        out.properties[key] = enforceStrictSchema(out.properties[key]);
      }
    }
  }
  if (Array.isArray(out.items)) out.items = out.items.map(enforceStrictSchema);
  else if (out.items) out.items = enforceStrictSchema(out.items);
  if (Array.isArray(out.allOf)) out.allOf = out.allOf.map(enforceStrictSchema);
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(enforceStrictSchema);
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map(enforceStrictSchema);
  for (const defsKey of ['$defs', 'definitions']) {
    if (out[defsKey] && typeof out[defsKey] === 'object' && !Array.isArray(out[defsKey])) {
      const mappedDefs = /** @type {Record<string, any>} */ ({});
      for (const [k, v] of Object.entries(out[defsKey])) {
        mappedDefs[k] = enforceStrictSchema(v);
      }
      out[defsKey] = mappedDefs;
    }
  }
  return out;
}

/**
 * The OPENCODE gateway upstreams only `auto` for `tool_choice`: `none`,
 * `required` and named choices answer 400 `invalid_request_error`. A text-only
 * step keeps its guarantee by offering no tools at all, so the model cannot be
 * forced into a tool call the wire cannot forbid.
 * @param {{body: Record<string, any>, forceTextResponse?: boolean}} arg0
 * @returns {void}
 */
function degradeOpencodeToolChoice({ body, forceTextResponse }) {
  if (forceTextResponse || body.tool_choice === 'none') {
    delete body.tools;
    delete body.parallel_tool_calls;
    delete body.tool_choice;
    return;
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto') body.tool_choice = 'auto';
}

/**
 * An OpenRouter server tool. OpenRouter documents `{ type }` for the bare form
 * and `{ type, parameters }` for a configured one — parameters are never flat.
 * @param {{type: string, parameters: Record<string, unknown>}} arg0
 * @returns {Record<string, unknown>}
 */
function openRouterServerTool({ type, parameters }) {
  return Object.keys(parameters).length > 0 ? { type, parameters } : { type };
}

/**
 * OAI backend adapter — implements the shared adapter contract for the
 * agentic loop: request building (chat completions + Responses API), vendor
 * stream execution, stream consumption, and tool-call extraction /
 * formatting.
 * @type {import('./adapter-common.mjs').AdapterContract}
 */
export const oaiAdapter = {
    vendorName: 'OAI',

    /**
 * Builds the OpenAI-compatible request (chat completions or Responses API).
 * @param {{model: string, parameters: Record<string, any>, tools: Array<Record<string, any>>, preparedMessages: Array<Record<string, any>>, forceTextResponse?: boolean, toolChoiceRequired?: boolean, session?: OaiSession}} arg0
 * @returns {{request: Record<string, any>, observability: Record<string, any>}}
 */
    buildVendorRequest({ model, parameters, tools, preparedMessages, forceTextResponse, toolChoiceRequired, session }) {
        let allMessages = normalizeToOAI({ model, msgs: preparedMessages, opts: { keepNative: session?.protocol === 'responses' } });

        if (parameters.response_format?.type === 'json_object') {
            /** @param {{m: *}} arg0 */
            /** @param {{m: *}} arg0 */
            const textOf = ({ m }) => (typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                    ? m.content.filter((/** @type {any} */ p) => p?.type === 'text').map((/** @type {any} */ p) => p.text || '').join(' ')
                    : '');
            const hasJson = allMessages.some(m => textOf({ m }).toLowerCase().includes('json'));
            if (!hasJson) {
                for (let i = allMessages.length - 1; i >= 0; i--) {
                    const m = allMessages[i];
                    if (m.role !== 'user' || !m.content) continue;
                    allMessages = [...allMessages];
                    allMessages[i] = typeof m.content === 'string'
                        ? { ...m, content: m.content + '\n\n# Return your answer as JSON.' }
                        : { ...m, content: [...m.content, { type: 'text', text: '\n\n# Return your answer as JSON.' }] };
                    break;
                }
            }
        }

        const hasCallerTools = hasAnyDeclaredTools({ tools, specTools: parameters.tools });

        if (session?.protocol === 'responses') {
            /** @type {Record<string, any>} */
            const body = {
                model,
                input: toResponsesInput({ messages: allMessages, assistantPartType: session.responsesAssistantPartType, nativeProvider: session.provider }),
                stream: parameters.stream ?? true,
            };
            if (parameters.temperature !== undefined) body.temperature = parameters.temperature;
            if (parameters.top_p !== undefined) body.top_p = parameters.top_p;
            // `CreateResponse` defines neither field; OpenRouter's `/responses`
            // does define `stop`, so only that provider keeps it.
            if (parameters.stop !== undefined) {
                if (session?.provider === ProviderType.OPENROUTER) body.stop = parameters.stop;
                else warnSession({ session, model, parameter: 'stop', message: "The OpenAI Responses API does not define 'stop'; it is dropped from the Responses body." });
            }
            if (parameters.seed !== undefined) {
                warnSession({ session, model, parameter: 'seed', message: "The OpenAI Responses API does not define 'seed'; it is dropped from the Responses body." });
            }
            if (parameters.max_tokens !== undefined) body.max_output_tokens = parameters.max_tokens;
            if (parameters.parallel_tool_calls !== undefined) body.parallel_tool_calls = parameters.parallel_tool_calls;
            if (parameters.reasoning_effort !== undefined || parameters.reasoning_summary !== undefined) {
                body.reasoning = {
                    ...(body.reasoning ?? {}),
                    ...(parameters.reasoning_effort !== undefined ? { effort: parameters.reasoning_effort } : {}),
                    ...(parameters.reasoning_summary !== undefined ? { summary: parameters.reasoning_summary } : {}),
                };
            }
            // The vendor request keys the unified builder carries.
            if (parameters.service_tier !== undefined) body.service_tier = parameters.service_tier;
            if (parameters.store !== undefined) body.store = parameters.store;
            // A stateless response drops the reasoning items unless they are
            // returned encrypted; asking for them lets a later turn replay them.
            if (parameters.store === false) body.include = [...(body.include ?? []), 'reasoning.encrypted_content'];
            if (parameters.previous_response_id !== undefined) body.previous_response_id = parameters.previous_response_id;
            if (parameters.prompt_cache_key !== undefined) body.prompt_cache_key = parameters.prompt_cache_key;
            // The Responses API has no boolean `logprobs` field: it asks for
            // the log probabilities through `include` (the chat completions
            // endpoint is the one with the boolean). That include value is
            // OpenAI's alone — OpenRouter's enum does not carry it.
            if (parameters.logprobs !== undefined) {
                if (session?.provider === ProviderType.OPENAI) {
                    body.include = [...(body.include ?? []), 'message.output_text.logprobs'];
                } else {
                    warnSession({ session, model, parameter: 'logprobs', message: "Only OpenAI's Responses API defines the 'message.output_text.logprobs' include; logprobs is dropped from this Responses body." });
                }
            }
            if (parameters.top_logprobs !== undefined) body.top_logprobs = parameters.top_logprobs;
            const respTools = mergeToolsByName({ tools, specTools: parameters.tools }).map((t) => ({
                type: 'function',
                name: t.function?.name ?? t.name,
                description: t.function?.description ?? t.description ?? '',
                parameters: t.function?.parameters ?? t.parameters ?? { type: 'object', properties: {} },
                // `FunctionTool.required` names `strict`: omit it and
                // `CreateResponse` rejects the whole tool. The caller's
                // value always wins.
                strict: t.function?.strict ?? t.strict ?? false,
            }));
            if (respTools.length > 0) {
                body.tools = respTools;
            }
            if (parameters.tool_choice !== undefined) {
                if (typeof parameters.tool_choice === 'string') body.tool_choice = parameters.tool_choice;
                else if (parameters.tool_choice?.type === 'function') {
                    body.tool_choice = { type: 'function', name: parameters.tool_choice.function?.name ?? parameters.tool_choice.name };
                } else {
                    warnSession({ session, model, parameter: 'tool_choice', message: 'Unrecognized tool_choice object shape passed through verbatim — OpenAI expects a string or { type: "function", function: { name } }.' });
                }
            }
            if (forceTextResponse) body.tool_choice = 'none';
            else if (toolChoiceRequired) body.tool_choice = 'required';
            if (parameters.response_format?.type === 'json_object' && !hasCallerTools && parameters.tool_choice === undefined && !toolChoiceRequired && !forceTextResponse) {
                body.tool_choice = 'none';
            }
            if (parameters.response_format?.type === 'json_schema') {
                body.text = {
                    format: {
                        type: 'json_schema',
                        name: parameters.response_format.json_schema?.name ?? 'output',
                        schema: enforceStrictSchema(parameters.response_format.json_schema?.schema ?? {}),
                    },
                };
            } else if (parameters.response_format?.type === 'json_object') {
                body.text = { format: { type: 'json_object' } };
            }
            if (parameters.verbosity !== undefined) {
                body.text = { ...(body.text ?? {}), verbosity: parameters.verbosity };
            }
            if (hasNativeLeg({ session, cap: 'webSearch' })) {
                const ws = /** @type {OaiWebSearch} */ (session?._webSearch);
                if (session?.provider === ProviderType.OPENCODE) {
                } else {
                    body.tools = body.tools || [];
                    if (session?.provider === ProviderType.OPENROUTER) {
                        body.tools.push(openRouterServerTool({
                            type: 'openrouter:web_search',
                            parameters: {
                                ...(ws.maxResults != null ? { max_results: ws.maxResults } : {}),
                                ...(ws.allowedDomains?.length ? { allowed_domains: ws.allowedDomains } : {}),
                                ...(ws.blockedDomains?.length ? { excluded_domains: ws.blockedDomains } : {}),
                                ...(ws.location ? { user_location: ws.location } : {}),
                            },
                        }));
                    } else {
                        body.tools.push({
                            type: 'web_search',
                            ...(ws.allowedDomains?.length ? { filters: { allowed_domains: ws.allowedDomains } } : {}),
                            ...(ws.location ? { user_location: ws.location } : {}),
                        });
                    }
                    if (ws.force && !forceTextResponse) body.tool_choice = 'required';
                }
            }
            if (hasNativeLeg({ session, cap: 'webScrape' })) {
                const wsc = /** @type {OaiWebScrape} */ (session?._webScrape);
                if (session?.provider === ProviderType.OPENROUTER) {
                    body.tools = body.tools || [];
                    body.tools.push(openRouterServerTool({
                        type: 'openrouter:web_fetch',
                        parameters: {
                            ...(wsc.maxChars != null ? { max_content_tokens: wsc.maxChars } : {}),
                            ...(wsc.allowedDomains?.length ? { allowed_domains: wsc.allowedDomains } : {}),
                            ...(wsc.blockedDomains?.length ? { blocked_domains: wsc.blockedDomains } : {}),
                        },
                    }));
                } else {
                    warnSession({ session, model, parameter: 'web_fetch', message: 'Native server-side web scraping is unavailable on this provider — no web_fetch leg injected.' });
                }
                if (wsc.force && !forceTextResponse && body.tool_choice === undefined) body.tool_choice = 'required';
            }
            body.__merciProtocol = 'responses';
            if (session?.provider === ProviderType.OPENCODE) degradeOpencodeToolChoice({ body, forceTextResponse });
            return { request: body, observability: { model, messages: allMessages, params: body } };
        }

        /** @type {Record<string, any>} */
        const params = {
            model,
            messages: allMessages,
            ...parameters,
        };

        if (params.stream === undefined) {
            params.stream = true;
        }
        if (params.stream === false) {
            // A non-streaming call returns the complete response object; the
            // usage-bearing `stream_options` is a streaming-only field and
            // the vendor rejects it next to `stream: false`.
            delete params.stream_options;
        }
        // `previous_response_id` belongs to the Responses API only; the chat
        // completions endpoint answers 400 on an unknown parameter.
        delete params.previous_response_id;
        // `ChatRequest` defines no `store` either; OpenAI's chat schema does.
        if (session?.provider === ProviderType.OPENROUTER) {
            delete params.store;
        }

        const sessionTools = new Set(tools);
        const mergedCompTools = mergeToolsByName({ tools, specTools: parameters.tools }).map((t) => (t.type === 'function' && t.function ? t : {
            type: 'function',
            function: {
                name: t.function?.name ?? t.name,
                description: t.description,
                // A caller's parameter-map tool may carry the Anthropic
                // `input_schema` name; a session tool keeps its own field.
                parameters: sessionTools.has(t) ? t.parameters : (t.parameters ?? t.input_schema ?? { type: 'object', properties: {} }),
                ...(t.strict !== undefined ? { strict: t.strict } : {})
            }
        }));
        if (mergedCompTools.length > 0) {
            params.tools = mergedCompTools;
        } else {
            delete params.tools;
        }

        if (forceTextResponse) {
            params.tool_choice = 'none';
        } else if (toolChoiceRequired) {
            params.tool_choice = 'required';
        } else if (parameters.tool_choice !== undefined && typeof parameters.tool_choice !== 'string'
            && parameters.tool_choice?.type !== 'function') {
            warnSession({ session, model, parameter: 'tool_choice', message: 'Unrecognized tool_choice object shape passed through verbatim — OpenAI expects a string or { type: "function", function: { name } }.' });
        }

        if (parameters.response_format?.type === 'json_object' && !hasCallerTools && parameters.tool_choice === undefined && !toolChoiceRequired && !forceTextResponse) {
            params.tool_choice = 'none';
        }

        // `reasoning_summary` is Responses-only, so the chat-completions wire
        // says it was dropped. `verbosity` is in OpenAI's chat schema but not
        // OpenRouter's, so only OpenRouter loses it.
        if (parameters.reasoning_summary !== undefined) {
            delete params.reasoning_summary;
            warnSession({ session, model, parameter: 'reasoningSummary', message: "Parameter 'reasoningSummary' is only sent on the Responses API; 'reasoning_summary' is removed from the chat-completions body." });
        }
        if (parameters.verbosity !== undefined && session?.provider === ProviderType.OPENROUTER) {
            delete params.verbosity;
            warnSession({ session, model, parameter: 'verbosity', message: "OpenRouter's chat-completions schema does not define 'verbosity'; it is removed from the chat-completions body." });
        }

        if (hasNativeLeg({ session, cap: 'webSearch' })) {
            const ws = /** @type {OaiWebSearch} */ (session?._webSearch);
            if (session?.provider === ProviderType.OPENROUTER) {
                params.tools = params.tools ? [...params.tools] : [];
                params.tools.push(openRouterServerTool({
                    type: 'openrouter:web_search',
                    parameters: {
                        ...(ws.maxResults != null ? { max_results: ws.maxResults } : {}),
                        ...(ws.allowedDomains?.length ? { allowed_domains: ws.allowedDomains } : {}),
                        ...(ws.blockedDomains?.length ? { excluded_domains: ws.blockedDomains } : {}),
                        ...(ws.location ? { user_location: ws.location } : {}),
                    },
                }));
                if (ws.force && !forceTextResponse) params.tool_choice = 'required';
            } else {
                // Measured, not assumed: `web_search_options` exists on the chat
                // request but carries only `user_location` and
                // `search_context_size` — no domain filters, no result cap — and
                // the models that accepted it are deprecated. So the native leg
                // is a no-op here; `parameters.web_search_options` remains the
                // escape hatch for a gateway that does honour it.
                warnSession({ session, model, parameter: 'web_search', message: "Native web search is unavailable on the OpenAI chat-completions wire: `web_search_options` carries only `user_location` and `search_context_size` (no domain filters, no result cap) and the models that accepted it are deprecated. Pass `parameters.web_search_options` yourself for a gateway that honours it; nothing is injected here." });
            }
        }

        if (hasNativeLeg({ session, cap: 'webScrape' })) {
            const wsc = /** @type {OaiWebScrape} */ (session?._webScrape);
            if (session?.provider === ProviderType.OPENROUTER) {
                params.tools = params.tools ? [...params.tools] : [];
                params.tools.push(openRouterServerTool({
                    type: 'openrouter:web_fetch',
                    parameters: {
                        ...(wsc.maxChars != null ? { max_content_tokens: wsc.maxChars } : {}),
                        ...(wsc.allowedDomains?.length ? { allowed_domains: wsc.allowedDomains } : {}),
                        ...(wsc.blockedDomains?.length ? { blocked_domains: wsc.blockedDomains } : {}),
                    },
                }));
            } else {
                warnSession({ session, model, parameter: 'web_fetch', message: 'Native server-side web scraping is unavailable on the OpenAI chat-completions wire.' });
            }
            if (wsc.force && !forceTextResponse && params.tool_choice === undefined) params.tool_choice = 'required';
        }

        // Last word on tool_choice: the OPENCODE gateway rejects anything but
        // `auto`, and a later leg (webSearch/webScrape force) must not leak a
        // value it cannot accept.
        if (session?.provider === ProviderType.OPENCODE) degradeOpencodeToolChoice({ body: params, forceTextResponse });

        return {
            request: params,
            observability: { model, messages: allMessages, params }
        };
    },

    /**
 * Executes the vendor stream (Responses API or chat completions). The call
 * runs under the session's retry policy (`session._retryPolicy`), so a
 * transient 429 / 5xx / network failure is retried with the existing
 * backoff instead of failing the run; the operation is re-runnable, so a
 * retry always opens a fresh vendor stream. With `stream: false` the vendor
 * answers with the complete response object instead of a stream — it is
 * wrapped in a one-chunk iterable so the consumer sees the same contract.
 * @param {{vendorClient: Record<string, any>, request: Record<string, any>, signal?: AbortSignal, session?: OaiSession}} arg0
 * @returns {Promise<Record<string, any>>} The raw vendor stream.
 */
    async executeVendorRequest({ vendorClient, request, signal, session }) {
        const sid = session?.opencodeSessionId || session?.sessionId || session?._sessionRunCtx?.runId || null;
        const headers = session?.provider === ProviderType.OPENCODE && sid ? { 'x-opencode-session': sid } : null;
        const opts = headers ? { signal, headers } : { signal };
        const streaming = request.stream !== false;
        const call = async () => {
            if (request.__merciProtocol === 'responses') {
                const { __merciProtocol, ...body } = request;
                return vendorClient.responses.create(body, opts);
            }
            if (!streaming) {
                const { stream_options: _ignored, ...body } = request;
                return vendorClient.chat.completions.create(body, opts);
            }
            const streamOpts = { ...request, stream_options: request.stream_options ?? { include_usage: true } };
            return vendorClient.chat.completions.create(streamOpts, opts);
        };
        const raw = await runVendorCallWithRetry({ operation: call, session: /** @type {import('../../support/retry-policy.mjs').RetrySession} */ (session), vendorName: 'OAI', signal });
        if (streaming) return raw;
        return (async function* singleChunk() { yield raw; })();
    },

    /**
 * Consumes the OpenAI stream into unified stream events (Responses API
 * output-item events and chat-completions deltas).
 * @param {{rawStream: *, signal: *}} arg0
 * @returns {AsyncGenerator<Record<string, any>>} Unified stream events (text/thought/tool_calls/quota/truncated/error/...).
 */
    async *consumeStream({ rawStream, signal }) {
        // A `stream: false` vendor call returns the body itself; a non-JSON 200
        // (a proxy or login page) is a string here, and iterating it would
        // yield characters and then a silent empty answer.
        if (typeof rawStream === 'string') throw nonJsonResponseError({ body: rawStream });
        const { maybeFirstToken } = createFirstTokenEmitter();

        const toolCallsAccum = [];
        const responsesCalls = new Map();
        const nativeCitations = [];
        let finishReasonEmitted = false;
        let refusalDeltaSeen = false;
        /** A protocol terminal signal was seen (finish_reason, completed, ...). */
        let terminalSignalSeen = false;
        /** A terminal event (truncated/error) was already yielded. */
        let terminalEventEmitted = false;
        /** Text, refusal or tool calls reached the consumer. */
        let producedOutput = false;
        const warnedUnknown = new Set();

        for await (const chunk of rawStream) {
            if (chunk === null || chunk === undefined) continue;
            if (typeof chunk !== 'object') throw nonJsonResponseError({ body: chunk });
            if (isFullResponse({ chunk })) {
                // `stream: false` — the vendor answered with the complete
                // response object instead of a stream.
                yield* consumeFullResponse({ response: chunk });
                return;
            }
            if (chunk && chunk.type === 'error') {
                terminalEventEmitted = true;
                yield { type: 'error', error_message: chunk.message || 'OpenAI stream error', error_type: chunk.code ?? 'error', data: chunk };
                continue;
            }
            if (chunk && typeof chunk.type === 'string' && chunk.type.startsWith('response.')) {
                switch (chunk.type) {
                    case 'response.output_text.delta':
                        if (chunk.delta) producedOutput = true;
                        yield* maybeFirstToken();
                        yield { type: 'text', content: chunk.delta };
                        break;
                    case 'response.reasoning_text.delta':
                    case 'response.reasoning_summary_text.delta':
                    case 'response.reasoning.delta':
                    case 'response.summary_text.delta':
                        yield* maybeFirstToken();
                        yield { type: 'thought', content: chunk.delta };
                        break;
                    case 'response.function_call_arguments.delta': {
                        if (chunk.delta) producedOutput = true;
                        const idx = chunk.output_index;
                        let entry = responsesCalls.get(idx);
                        if (!entry) {
                            entry = { id: `call_${idx}`, type: 'function', function: { name: '', arguments: '' }, confirmed: false };
                            responsesCalls.set(idx, entry);
                        }
                        entry.function.arguments += chunk.delta;
                        break;
                    }
                    case 'response.output_text.annotation.added':
                        if (chunk.annotation) nativeCitations.push(chunk.annotation);
                        break;
                    case 'response.refusal.delta':
                        refusalDeltaSeen = true;
                        if (chunk.delta) producedOutput = true;
                        yield* maybeFirstToken();
                        yield { type: 'text', content: chunk.delta };
                        break;
                    case 'response.refusal.done':
                        if (!refusalDeltaSeen && chunk.refusal) {
                            producedOutput = true;
                            yield* maybeFirstToken();
                            yield { type: 'text', content: chunk.refusal };
                        }
                        terminalEventEmitted = true;
                        yield { type: 'error', error_message: chunk.refusal || 'Model refused the request.', error_type: 'refusal' };
                        break;
                    case 'response.output_item.added': {
                        const item = chunk.item;
                        if (item?.type === 'function_call') {
                            producedOutput = true;
                            const idx = chunk.output_index ?? responsesCalls.size;
                            const prior = responsesCalls.get(idx);
                            responsesCalls.set(idx, {
                                id: item.call_id || prior?.id || `call_${idx}`,
                                type: 'function',
                                function: {
                                    name: item.name || prior?.function?.name || '',
                                    arguments: prior?.function?.arguments || '',
                                },
                                confirmed: prior?.confirmed ?? false,
                            });
                        }
                        break;
                    }
                    case 'response.output_item.done': {
                        const item = chunk.item;
                        if (item?.type === 'function_call') {
                            producedOutput = true;
                            const idx = chunk.output_index ?? responsesCalls.size;
                            const prior = responsesCalls.get(idx);
                            responsesCalls.set(idx, {
                                id: item.call_id || prior?.id || `call_${idx}`,
                                type: 'function',
                                function: {
                                    name: item.name || prior?.function?.name || '',
                                    arguments: typeof item.arguments === 'string'
                                        ? item.arguments
                                        : (prior?.function?.arguments || JSON.stringify(item.arguments ?? {})),
                                },
                                confirmed: true
                            });
                        } else if (item?.type === 'reasoning') {
                            yield { type: 'reasoning_item', protocol: 'responses', item };
                        } else if (item?.type === 'web_search_call') {
                            nativeCitations.push(
                                ...(Array.isArray(item.action?.sources) ? item.action.sources : []),
                                ...(Array.isArray(item.results) ? item.results : []),
                            );
                        }
                        break;
                    }
                    case 'response.completed': {
                        terminalSignalSeen = true;
                        const quota = openAIQuota({ usage: chunk.response?.usage });
                        if (quota) yield quota;
                        break;
                    }
                    case 'response.failed':
                        terminalSignalSeen = true;
                        terminalEventEmitted = true;
                        yield buildResponsesErrorEvent({ errObj: chunk.response?.error ?? chunk.error, fallbackMessage: 'OpenAI Responses stream failed' });
                        break;
                    case 'response.incomplete': {
                        terminalSignalSeen = true;
                        const reason = chunk.response?.incomplete_details?.reason;
                        if (reason === 'max_output_tokens') {
                            if (!finishReasonEmitted) {
                                finishReasonEmitted = true;
                                terminalEventEmitted = true;
                                yield { type: 'truncated' };
                            }
                        } else if (chunk.response?.error) {
                            terminalEventEmitted = true;
                            yield buildResponsesErrorEvent({ errObj: chunk.response.error, fallbackMessage: 'Responses stream incomplete' });
                        } else if (reason) {
                            terminalEventEmitted = true;
                            yield { type: 'error', error_message: `Responses stream incomplete: ${reason}`, error_type: reason };
                        } else {
                            terminalEventEmitted = true;
                            yield { type: 'error', error_message: 'Responses stream incomplete with no reason.', error_type: 'incomplete' };
                        }
                        break;
                    }
                    case 'response.error':
                        terminalSignalSeen = true;
                        terminalEventEmitted = true;
                        yield buildResponsesErrorEvent({ errObj: chunk.error ?? chunk.response?.error, fallbackMessage: 'OpenAI Responses stream error' });
                        break;
                    default:
                        if (!warnedUnknown.has(chunk.type)) {
                            warnedUnknown.add(chunk.type);
                            sdkWarn({ prefix: 'OAI', args: [`Unhandled Responses event type '${chunk.type}' — ignored.`] });
                        }
                        break;
                }
                continue;
            }

            if (chunk.usage) {
                const quota = openAIQuota({ usage: chunk.usage });
                if (quota) yield quota;
            }

            // A gateway can answer 200 with an error object instead of a
            // stream (A-11); this is its typed, terminal form.
            if (chunk.error) {
                terminalEventEmitted = true;
                yield buildResponsesErrorEvent({ errObj: chunk.error });
                continue;
            }

            if (!chunk.choices || chunk.choices.length === 0) {
                continue;
            }

            const finishReason = chunk.choices[0]?.finish_reason;
            if (chunk.choices.some((/** @type {any} */ choice) => choice?.finish_reason)) terminalSignalSeen = true;
            if (finishReason === 'length' && !finishReasonEmitted) {
                finishReasonEmitted = true;
                terminalEventEmitted = true;
                yield { type: 'truncated' };
            } else if (finishReason && finishReason !== 'stop'
                && finishReason !== 'tool_calls' && finishReason !== 'function_call'
                && !finishReasonEmitted) {
                finishReasonEmitted = true;
                terminalEventEmitted = true;
                yield { type: 'error', error_message: `OpenAI stream finished with reason: ${finishReason}`, error_type: finishReason };
            }

            const delta = chunk.choices[0]?.delta;
            if (!delta) {
                continue;
            }

            if (delta.reasoning_content != null) {
                const content = String(delta.reasoning_content);
                if (content) {
                    yield* maybeFirstToken();
                    yield { type: 'thought', content, reasoning_content: true };
                }
            } else if (delta.reasoning != null) {
                const r = Array.isArray(delta.reasoning)
                    ? delta.reasoning.map((/** @type {any} */ x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('')
                    : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
                if (r) {
                    yield* maybeFirstToken();
                    yield { type: 'thought', content: r };
                }
            } else if (Array.isArray(delta.reasoning_details)) {
                // OpenRouter's reasoning_details: only `text`-bearing entries
                // are model-visible thoughts; encrypted/tool entries are not.
                const r = delta.reasoning_details
                    .map((/** @type {any} */ entry) => (typeof entry?.text === 'string' ? entry.text : ''))
                    .join('');
                if (r) {
                    yield* maybeFirstToken();
                    yield { type: 'thought', content: r };
                }
            }

            if (delta.content) {
                producedOutput = true;
                yield* maybeFirstToken();
                yield { type: 'text', content: delta.content };
            }

            if (typeof delta.refusal === 'string' && delta.refusal) {
                producedOutput = true;
                terminalEventEmitted = true;
                yield* maybeFirstToken();
                yield { type: 'text', content: delta.refusal };
                yield { type: 'error', error_type: 'refusal', error_message: delta.refusal };
            }

            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                producedOutput = true;
                for (const toolCallDelta of delta.tool_calls) {
                    const index = toolCallDelta.index ?? 0;
                    if (!toolCallsAccum[index]) {
                        toolCallsAccum[index] = {
                            id: toolCallDelta.id,
                            type: 'function',
                            function: { name: '', arguments: '' }
                        };
                    }
                    if (toolCallDelta.id) toolCallsAccum[index].id = toolCallDelta.id;
                    if (toolCallDelta.function?.name) toolCallsAccum[index].function.name += toolCallDelta.function.name;
                    if (toolCallDelta.function?.arguments) toolCallsAccum[index].function.arguments += toolCallDelta.function.arguments;
                }
            }
        }

        // A stream that delivered content but no terminal signal was cut short.
        // The transport strips `[DONE]` from the event stream, so the sentinel
        // it recorded on the iterable (`streamState.sawDone`) is the other
        // terminal fact; a caller's abort (`streamState.sawAbort`) ended the
        // stream on purpose and is not truncation. Without either one a clean
        // end is a truncated answer. Never turn an empty answer or an
        // already-reported failure into a second terminal event.
        const state = /** @type {{streamState?: {sawDone?: boolean, sawAbort?: boolean}}|null} */ (/** @type {unknown} */ (rawStream))?.streamState;
        const sawAbort = state?.sawAbort === true || signal?.aborted === true;
        const sawTerminal = state?.sawDone === true || terminalSignalSeen || terminalEventEmitted;
        if (truncationCheck({ producedOutput, sawTerminal, sawAbort })) {
            terminalEventEmitted = true;
            yield { type: 'truncated' };
        }

        if (responsesCalls.size > 0) {
            const calls = [...responsesCalls.values()].filter(c => c.confirmed || c.function.name);
            if (calls.length > 0) yield { type: 'tool_calls', calls };
        } else if (toolCallsAccum.length > 0) {
            const calls = toolCallsAccum.filter(Boolean);
            if (calls.length > 0) yield { type: 'tool_calls', calls };
        }

        const sourcesEv = sourcesEvent({ citations: nativeCitations });
        if (sourcesEv) yield sourcesEv;
    },

    /**
 * Extracts `<tool_call>` rows from raw assistant text.
 * @param {{text: string}} arg0
 * @returns {Array<Record<string, any>>} Normalized function calls.
 */
    extractXmlToolCalls({ text }) {
        return _extractXmlToolCalls({ text }).map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
        }));
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
            args: call.function?.arguments ?? call.arguments ?? '{}'
        };
    }
};
