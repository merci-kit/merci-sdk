// @ts-check
/**
 * @file Shared helpers for the backend adapters (OAI / GAI / AAI / JAI).
 * @version 0.12.0
 *
 * @description
 * Peer helpers extracted from the four vendor adapters so the native-leg
 * predicate, the stream first-token prologue, the quota mapping, the
 * sources tail and the session parameter warning live in one place. Kept in
 * `lib/backends/adapters/` (the peer
 * layer); the only `backends → agentic` edge is the pre-existing
 * `normalizeCitations` import the OAI/AAI adapters already used.
 */

import { normalizeCitations } from '../../agentic/websearch/engines.mjs';
import { getToolCallName } from '../../messaging/messages.mjs';
import { emitParameterWarning } from '../../support/utils.mjs';
import { standardFor } from '../../core/constants/index.mjs';

/**
 * The members every backend adapter exposes: the four the agentic loop calls
 * (`buildVendorRequest`, `executeVendorRequest`, `consumeStream`,
 * `formatToolCall`) plus the XML tool-call extractor the session falls back to.
 *
 * The members are typed `Function` on purpose: each vendor declares the exact
 * parameter and return shapes on its own implementation (Anthropic's stream
 * envelope is not Gemini's), and the loop calls them through this one interface.
 * What a contract must guarantee is that the member exists — which is what this
 * names, and what `Record<string, any>` did not.
 * @typedef {Object} AdapterCore
 * @property {string} vendorName
 * @property {Function} buildVendorRequest
 * @property {Function} executeVendorRequest
 * @property {Function} consumeStream
 * @property {Function} extractXmlToolCalls
 * @property {Function} formatToolCall
 */

/**
 * An adapter object: the contract members above, plus whatever a vendor adds
 * (the index signature keeps the vendor-specific members open).
 * @typedef {Record<string, unknown> & AdapterCore} AdapterContract
 */

/**
 * Modes that mean "inject the native search/scrape leg". The `_with_*_fallback`
 * modes still inject the native leg — the fallback is a retry path on top.
 * @type {Record<string, Array<string>>}
 */
const NATIVE_LEG_MODES = {
    webSearch: ['native', 'native_with_tavily_fallback'],
    webScrape: ['native', 'native_with_tavily_fallback', 'native_with_curl_fallback'],
};

/**
 * Whether the session's search/scrape capability requested a native leg.
 * Reproduces the verbatim OAI/GAI/AAI predicate for `webSearch` and `webScrape`.
 * @param {{session?: Object|null, cap: 'webSearch'|'webScrape'}} arg0 -
 * @returns {boolean}
 */
export function hasNativeLeg({ session, cap }) {
    const s = /** @type {Record<string, {mode?: string}|null|undefined>} */ (session ?? {});
    const mode = s[`_${cap}`]?.mode;
    // An unset mode is never one of the native ones.
    return NATIVE_LEG_MODES[cap].includes(mode ?? '');
}

/**
 * One-shot first-token prologue for a stream consumer. Returns the generator
 * the consumer `yield*`s at every candidate first output; only the first call
 * emits, carrying the latency from emitter creation.
 * @returns {{maybeFirstToken: () => Generator<{type: string, latencyMs: number}>}}
 */
export function createFirstTokenEmitter() {
    const startTs = Date.now();
    let emitted = false;
    return {
        *maybeFirstToken() {
            if (!emitted) {
                emitted = true;
                yield { type: 'first_token', latencyMs: Date.now() - startTs };
            }
        },
    };
}

/**
 * Whether a stream that ended without its terminal fact was cut short.
 *
 * A clean end after output, with no terminal fact, is a truncated answer; an
 * empty answer or a caller abort is not. Each adapter supplies the facts it
 * tracks: what reached the consumer, its protocol terminal (DONE,
 * `message_stop`, any `finishReason`), and the abort flag
 * (`rawStream.streamState?.sawAbort === true || signal?.aborted === true`).
 * @param {{producedOutput: boolean, sawTerminal: boolean, sawAbort: boolean}} arg0 -
 * @returns {boolean}
 */
export function truncationCheck({ producedOutput, sawTerminal, sawAbort }) {
    return producedOutput && !sawTerminal && !sawAbort;
}

/**
 * The cost a vendor **reported** with its usage (USD), or `null` when it
 * reported none.
 *
 * The SDK never computes a price: it only passes on what the backend
 * answered. An OpenAI-compatible gateway (OpenRouter, LiteLLM, a private
 * gateway) reports the money it charged as `usage.cost`; the direct vendor
 * APIs report tokens only, and then there is no cost — an unknown cost, never
 * zero.
 *
 * @param {{usage: unknown}} arg0 - The vendor's usage object.
 * @returns {number|null} The reported cost in USD, or `null`.
 */
export function vendorCostUsd({ usage }) {
    if (!usage || typeof usage !== 'object') return null;
    const u = /** @type {Record<string, unknown>} */ (usage);
    for (const key of ['cost_usd', 'cost', 'total_cost']) {
        const value = u[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
}


/**
 * The quota event's payload: the vendor's own token names.
 * @typedef {Object} QuotaData
 * @property {{amount: number}} spent
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [reasoning_tokens]
 * @property {number} [cost_usd]
 */

/**
 * Builds a unified `quota` stream event. Cache/reasoning fields are omitted
 * when absent, matching the adapters' conditional-spread payloads; `spent`
 * defaults to `prompt + completion` when the vendor gives no total.
 *
 * `costUsd` is the cost the **backend reported** — it is carried through
 * untouched and omitted when the backend reported none.
 * @param {{prompt?: number, completion?: number, amount?: number, cached?: number|null, cacheCreation?: number|null, reasoning?: number|null, costUsd?: number|null}} arg0 -
 * @returns {{type: 'quota', data: QuotaData}}
 */
export function quotaEvent({ prompt, completion, amount, cached = null, cacheCreation = null, reasoning = null, costUsd = null }) {
    return {
        type: 'quota',
        data: {
            spent: { amount: amount ?? ((prompt || 0) + (completion || 0)) },
            prompt_tokens: prompt,
            completion_tokens: completion,
            ...(cacheCreation != null ? { cache_creation_input_tokens: cacheCreation } : {}),
            ...(cached != null ? { cache_read_input_tokens: cached } : {}),
            ...(reasoning != null ? { reasoning_tokens: reasoning } : {}),
            ...(costUsd != null ? { cost_usd: costUsd } : {}),
        },
    };
}

/**
 * Builds a unified `sources` stream event from raw vendor citations, or `null`
 * when nothing normalizes (mirrors the `if (sources.length > 0)` guards).
 * @param {{citations: Array<Record<string, unknown>>}} arg0 -
 * @returns {{type: 'sources', data: {sources: Array<{title: string, url: string}>}}|null}
 */
export function sourcesEvent({ citations }) {
    const sources = normalizeCitations({ citations });
    return sources.length > 0 ? { type: 'sources', data: { sources } } : null;
}

/**
 * The name a declared tool is addressed by: OpenAI's nested `function.name`
 * first, the flat unified `name` otherwise.
 * @param {{tool: unknown}} arg0 -
 * @returns {string|undefined}
 */
function declaredToolName({ tool }) {
    const declared = /** @type {{name?: string, function?: {name?: string}}|null} */ (tool);
    return declared?.function?.name ?? declared?.name;
}

/**
 * Merges the tools two sources declare, first-wins: every `tools` entry in
 * order, then each `specTools` entry whose name is not already taken.
 *
 * Returns the ORIGINAL entries — each adapter keeps its own wire projection
 * (shape, rename, defaults) after this. A later duplicate of a name replaces
 * the earlier one in place, as the per-adapter `Map.set` did. An entry with no
 * name is skipped: a call cannot address it.
 * @template T
 * @param {{tools?: Array<T>, specTools?: Array<unknown>}} arg0 -
 * @returns {Array<T>} The merged entries, in declaration order.
 */
export function mergeToolsByName({ tools, specTools } = {}) {
    /** @type {Map<string, T>} */
    const byName = new Map();
    for (const t of (Array.isArray(tools) ? tools : [])) {
        const name = declaredToolName({ tool: t });
        if (name) byName.set(name, t);
    }
    for (const t of (Array.isArray(specTools) ? specTools : [])) {
        const name = declaredToolName({ tool: t });
        if (name && !byName.has(name)) byName.set(name, /** @type {T} */ (t));
    }
    return [...byName.values()];
}

/**
 * Whether the step declared a tool a tool_choice would bind to: a parameter
 * tool at all, or a session tool other than the built-in `task` delegate.
 * @param {{tools?: Array<{name?: string, description?: string}>, specTools?: Array<{name?: string, description?: string}>}} arg0 -
 * @returns {boolean}
 */
export function hasAnyDeclaredTools({ tools, specTools } = {}) {
    return (Array.isArray(specTools) && specTools.length > 0)
        || (Array.isArray(tools) && tools.some((t) => t?.name !== 'task' || t?.description !== 'delegate'));
}

/**
 * The display row's identity for a tool call: its own id, else the result's,
 * else a caller fallback; the name read in any vendor shape.
 * @param {{call?: {id?: string, tool_call_id?: string, name?: string, function?: {name?: string}}|null, result?: {id?: string, tool_call_id?: string, name?: string}|null, fallbackId?: string}} arg0 -
 * @returns {{id: string|undefined, name: string}}
 */
export function toolCallIdentity({ call, result, fallbackId } = {}) {
    return {
        id: call?.id || result?.id || result?.tool_call_id || fallbackId,
        name: getToolCallName({ call: /** @type {import('../../messaging/messages.mjs').MessageRow} */ (call) }) || '',
    };
}

/**
 * The value of the vendor session header: the public session id, else the
 * current run id. Header names stay with the call sites.
 * @param {{session?: {sessionId?: string, _sessionRunCtx?: {runId?: string}}|null}} arg0 -
 * @returns {string|undefined}
 */
export function sessionIdOf({ session } = {}) {
    return session?.sessionId ?? session?._sessionRunCtx?.runId;
}

/**
 * Emits a session parameter-warning, defaulting the provider to the adapter's
 * own when the session carries none. OAI/GAI bind their default via a thin
 * local wrapper; the body (and null-safety) lives here once.
 * @param {{session?: Object|null, provider: string, standard?: string, model?: string, parameter: string, message: string}} arg0 -
 */
export function warnSession({ session, provider, standard, model, parameter, message }) {
    const s = /** @type {{eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, provider?: string, standard?: string}|null} */ (session ?? null);
    const effectiveProvider = s?.provider ?? provider;
    emitParameterWarning({ emitter: s?.eventEmitter ?? null, model, parameter, message, provider: effectiveProvider, standard: s?.standard ?? standard ?? standardFor({ provider: effectiveProvider }) ?? '' });
}
