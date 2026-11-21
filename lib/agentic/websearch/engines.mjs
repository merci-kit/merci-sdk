// @ts-check


/**
 * @file Web-search engines + mode resolution.
 * @version 0.12.0
 *
 * @description
 * Two engines behind one unified result shape, and the tool/native/off mode
 * resolver. `TavilyEngine` is a raw global `fetch` POST (no SDK, no new deps);
 * `JaiEngine` rides the JAI TaskAPI's `executeJson('web-search', …)` contract.
 *
 * Unified result: `{ query, answer?, sources: [{ title, url }], _vendor? }`
 * (`_vendor` = the raw vendor payload, present only when
 * `includeVendorMetadata` is truthy).
 */
import { BackendError } from '../../core/errors.mjs';
import { nativeProvidersFor, postJson, warnWebUnsupported, resolveWebMode } from '../web-shared.mjs';

/** @param {{opts: *, parameter: *, engine: *}} arg0 */
function warnUnsupported({ opts, parameter, engine }) {
    warnWebUnsupported({ opts, parameter, engine, kind: 'search' });
}


/**
 * One search hit in the unified shape both engines return.
 * @typedef {Object} UnifiedSearchResult
 * @property {string} query
 * @property {string} [answer] - The vendor's synthesized answer, when it gave one.
 * @property {Array<{title: string, url: string}>} sources
 * @property {Record<string, unknown>} [_vendor] - The raw vendor payload, only with `includeVendorMetadata`.
 */

/**
 * The per-call options the search engines read. The search component's config
 * feeds it; an engine warns about (and ignores) the knobs it does not support.
 * @typedef {Object} SearchEngineOptions
 * @property {string} [apiKey] - Tavily only.
 * @property {number} [maxResults]
 * @property {string} [search_depth]
 * @property {string} [searchDepth]
 * @property {string} [topic]
 * @property {string} [time_range]
 * @property {string} [timeRange]
 * @property {string} [start_date]
 * @property {string} [startDate]
 * @property {string} [end_date]
 * @property {string} [endDate]
 * @property {Array<string>} [include_domains]
 * @property {Array<string>} [includeDomains]
 * @property {Array<string>} [exclude_domains]
 * @property {Array<string>} [excludeDomains]
 * @property {boolean} [include_answer]
 * @property {boolean} [includeAnswer]
 * @property {string} [country]
 * @property {string} [language]
 * @property {boolean} [includeVendorMetadata]
 * @property {AbortSignal} [signal]
 * @property {import('node:events').EventEmitter<Record<string, unknown[]>>} [emitter]
 * @property {string} [model]
 * @property {string} [backend]
 * @property {number} [maxUses] - Not supported by either engine (warned).
 * @property {unknown} [location] - Not supported by either engine (warned).
 * @property {Array<string>} [blockedDomains] - Not supported by the JAI engine (warned).
 */

/**
 * `{ title, url }` source shape, deduped by url (annotation events can repeat).
 * Accepts the flat shapes the native legs surface: Responses `url_citation`
 * annotations / `web_search_call` results and Anthropic `web_search_result`
 * blocks.
 * @param {{citations: Array<Record<string, unknown>>}} arg0 -
 * @returns {Array<{title: string, url: string}>}
 */
export function normalizeCitations({ citations }) {
    const seen = new Set();
    const sources = [];
    for (const c of Array.isArray(citations) ? citations : []) {
        if (!c) continue;
        const url = /** @type {string} */ (c.url ?? c.uri ?? '');
        const title = /** @type {string} */ (c.title ?? c.name ?? '');
        const key = url || title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        sources.push({ title, url });
    }
    return sources;
}

/**
 * The providers with a native search leg.
 * @type {Set<string>}
 */
export const NATIVE_PROVIDERS = nativeProvidersFor({ capability: 'nativeWebSearch' });


/**
 * Resolves a session's web-search mode to 'tool' | 'native' | 'off'.
 * 'native_with_tavily_fallback' resolves to 'tool' here — the adapters inject
 * the native leg, this tool is the fallback leg. Both are registered.
 * @param {string} sessionProvider
 * @param {string} [mode] - 'native' | 'native_with_tavily_fallback' | 'tavily' | 'tool' | 'off' (undefined → off).
 * @returns {'tool'|'native'|'off'}
 */
const SEARCH_TOOL_MODES = ['tavily', 'tool', 'native_with_tavily_fallback'];

/**
 * Resolves the search mode — the engine the web search runs on.
  * @param {{sessionProvider: string|undefined, mode?: string}} arg0
 */
export function resolveSearchMode({ sessionProvider, mode }) {
    return resolveWebMode({ nativeProviders: NATIVE_PROVIDERS, toolModes: SEARCH_TOOL_MODES, sessionProvider, mode });
}


/**
 * `{ query, answer?, sources: [{ title, url }] }` shape.
 * @param {{query: string, raw: Record<string, unknown>, includeVendorMetadata?: boolean}} arg0 -
 * @returns {UnifiedSearchResult} The unified result.
 */
export function toUnified({ query, raw, includeVendorMetadata = false }) {
    const list = raw?.sources ?? raw?.results ?? [];
    const sources = (Array.isArray(list) ? list : [])
        .map((s) => /** @type {{title: string, url: string}} */ ({ title: /** @type {string} */ (s?.title ?? s?.name ?? ''), url: /** @type {string} */ (s?.url ?? '') }))
        .filter((s) => s.url || s.title);
    /** @type {UnifiedSearchResult} */
    const result = { query, sources };
    if (raw?.answer) result.answer = /** @type {string} */ (raw.answer);
    if (includeVendorMetadata) result._vendor = raw;
    return result;
}


/**
 * Tavily engine — raw global `fetch` POST to https://api.tavily.com/search.
 * Zero new dependencies; key from `opts.apiKey ?? process.env.TAVILY_API_KEY`.
 */
export class TavilyEngine {
    
    /**
     * @returns {Promise<UnifiedSearchResult>} The unified result.
     * @param {{query: string, opts?: SearchEngineOptions}} arg0
     */
        static async search({ query, opts = {} }) {
        const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
        if (!apiKey) throw new BackendError({ message: 'Tavily search requires an API key (opts.apiKey or TAVILY_API_KEY).', options: { provider: 'tavily' } });
        const optBag = /** @type {Record<string, unknown>} */ (opts);
        for (const parameter of ['location', 'maxUses']) {
            if (optBag[parameter] != null) warnUnsupported({ opts, parameter, engine: 'tavily' });
        }

        const body = /** @type {Record<string, any>} */ ({
            api_key: apiKey,
            query,
            max_results: opts.maxResults,
            search_depth: opts.search_depth ?? opts.searchDepth,
            topic: opts.topic,
            time_range: opts.time_range ?? opts.timeRange,
            start_date: opts.start_date ?? opts.startDate,
            end_date: opts.end_date ?? opts.endDate,
            include_domains: opts.include_domains ?? opts.includeDomains,
            exclude_domains: opts.exclude_domains ?? opts.excludeDomains,
            include_answer: opts.include_answer ?? opts.includeAnswer ?? true,
            country: opts.country,
            language: opts.language
        });
        const data = await postJson({ url: 'https://api.tavily.com/search', body, signal: opts.signal, provider: 'tavily', label: 'Tavily search failed' });
        return toUnified({ query, raw: /** @type {Record<string, any>} */ (data), includeVendorMetadata: opts.includeVendorMetadata });
    }
}


/**
 * JAI engine — rides `taskApi.executeJson('web-search', params, { version:'v4' })`.
 * @see lib/backends/jai-vendor/api.mjs TaskAPI#executeJson
 */
export class JaiEngine {
    
    /**
     *   are unsupported and emit a `parameter_warning` (needs `opts.emitter`).
     * @returns {Promise<UnifiedSearchResult>} The unified result.
     * @param {{query: string, opts?: SearchEngineOptions, taskApi: {executeJson: Function}|null}} arg0
     */
        static async search({ query, opts = {}, taskApi }) {
        if (!taskApi?.executeJson) throw new BackendError({ message: 'JAI web search requires taskApi.executeJson.', options: { provider: 'jai' } });

        const optBag = /** @type {Record<string, unknown>} */ (opts);
        for (const parameter of ['blockedDomains', 'topic', 'time_range', 'location', 'maxUses']) {
            if (optBag[parameter] != null) warnUnsupported({ opts, parameter, engine: 'jai' });
        }

        /** @type {Record<string, unknown>} */
        const params = { query };
        if (opts.maxResults != null) params.maxResults = opts.maxResults;
        if (opts.includeAnswer != null) params.includeAnswer = opts.includeAnswer;
        if (opts.includeDomains?.length) params.includeDomains = opts.includeDomains;

        const raw = /** @type {Record<string, unknown>} */ (await taskApi.executeJson({ taskId: 'web-search', parameters: params, options: { version: 'v4', ...(opts.signal ? { signal: opts.signal } : {}) } }));
        return toUnified({ query, raw, includeVendorMetadata: opts.includeVendorMetadata });
    }
}