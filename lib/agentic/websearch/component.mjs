// @ts-check


/**
 * @file WebSearchComponent — the `web_search` function-tool surface.
 * @version 0.12.0
 *
 * @description
 * A LoadableComponent (REUSE of lib/core/loadable.mjs via `toLoadTool()`) that
 * exposes a single `web_search` tool. Its execute runs TavilyEngine or
 * JaiEngine per the resolved mode/backend and returns the unified result as a
 * compact JSON string (one format — machine-readable).
 *
 * Reads the session config contract `session._webSearch` (written elsewhere):
 * `{ mode, force, maxResults, allowedDomains, blockedDomains, location,
 *   includeVendorMetadata, tavily: { ... } }`.
 */
import { LoadableComponent } from '../../core/loadable.mjs';
import { CAPABILITY, CAPABILITY_REGISTRY, WEB_SEARCH_PRELOAD_BLOCK, WEB_SEARCH_TOOL_NAME } from '../../core/constants/index.mjs';
import { EVENTS } from '../../core/events.mjs';
import { JaiEngine, TavilyEngine, resolveSearchMode } from './engines.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { preferJaiEngine, resolveCapabilityMode, renderWebContextBlock } from '../web-shared.mjs';


/**
 * The web-search config bag: the knobs this component reads (the session writes
 * it as `session._webSearch`), plus the injection block it forwards.
 * @typedef {Object} WebSearchConfig
 * @property {string} [mode]
 * @property {boolean} [force]
 * @property {string} [model]
 * @property {number} [maxResults]
 * @property {number} [maxUses]
 * @property {Object|null} [location] - Passed through (neither engine supports it).
 * @property {Array<string>} [allowedDomains]
 * @property {Array<string>} [blockedDomains]
 * @property {boolean} [includeVendorMetadata]
 * @property {number} [cacheTtlMs]
 * @property {Record<string, unknown>|null} [tavily] - Passed through to the Tavily engine (apiKey plus its own knobs).
 * @property {import('../web-shared.mjs').WebInjectOptions|null} [inject]
 */

/**
 * Web-search capability surfaced as a `web_search` function tool.
 * @extends {LoadableComponent}
 */
export class WebSearchComponent extends LoadableComponent {
    
    /**
 * @param {{provider?: string, config?: WebSearchConfig, taskApi?: {executeJson: Function}|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 */
        constructor({ provider, config = {}, taskApi = null, eventEmitter = null } = {}) {
        super({
            id: CAPABILITY.WEB_SEARCH,
            loadToolName: WEB_SEARCH_TOOL_NAME,
            announce: CAPABILITY_REGISTRY[CAPABILITY.WEB_SEARCH]?.announce ?? null,
            loadDescription: 'Search the web for current information. Returns a JSON object: { query, answer?, sources: [{ title, url }] }.',
            loadParameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'The search query.' } },
                required: ['query']
            },
            eventEmitter
        });
        this.provider = provider;
        this.config = config;
        this.taskApi = taskApi;
        /** @type {Map<string, {at: number, value: import('./engines.mjs').UnifiedSearchResult}>} */
        this._cache = new Map();
    }

    
    /**
     * The unified `web_search` tool definition (name/description/parameters/execute).
     * @returns {Object|null} The tool, or null.
     */
        toWebSearchTool() {
        return this.toLoadTool();
    }

    async shouldInjectStep( ctx = {}) {
        // m18: `preload` is a per-capability decision (the session passes it in
        // the step context), not a hard-coded true. Disabling it keeps the tool
        // and drops the per-step orientation block.
        if ((/** @type {any} */ (ctx)).preload === false) return false;
        return (/** @type {any} */ (ctx).mode ?? this.config?.mode) !== 'off';
    }

    async stepBlock() {
        return renderWebContextBlock({ baseBlock: WEB_SEARCH_PRELOAD_BLOCK, inject: this.config?.inject });
    }

    
    /**
     * Runs the search and returns the unified result as a JSON string.
     * Non-tool modes (native/off) are handled outside this tool — return a
     * short JSON note instead of erroring.
     * @param {Record<string, unknown>} [args]
     * @returns {Promise<string>}
     */
        async load(args = {}) {
        return this.loadWithSignal({ args });
    }

    
    /**
     * Tool-surface load carrying the caller's abort signal.
     * @param {{args?: Record<string, unknown>, signal?: AbortSignal|null}} arg0
     * @returns {Promise<string>}
     */
        async loadWithSignal({ args = {}, signal = null } = {}) {
        const config = /** @type {any} */ (this.config ?? {});
        const query = args?.query ?? '';
        const mode = resolveCapabilityMode({ resolveMode: resolveSearchMode, sessionProvider: this.provider, config });
        if (mode !== 'tool') {
            return JSON.stringify({ query, answer: null, sources: [], note: `web search mode '${mode}' is handled outside this tool.` });
        }
        this._emit({ name: EVENTS.WEB_SEARCH.SEARCH_START, payload: { query, provider: this.provider, mode: config.mode } });
        const startTs = Date.now();
        try {
            const result = await this.#run({ query, config, signal });
            this._emit({ name: EVENTS.WEB_SEARCH.SEARCH_SUCCESS, payload: {
                query, provider: this.provider, mode: config.mode,
                resultCount: result.sources.length, sources: result.sources,
                durationMs: Date.now() - startTs,
            } });
            return JSON.stringify(result);
        } catch (err) {
            this._emit({ name: EVENTS.WEB_SEARCH.SEARCH_ERROR, payload: {
                query, provider: this.provider, mode: config.mode,
                durationMs: Date.now() - startTs, error: ( (/** @type {any} */ (err)))?.message ?? String(err),
            } });
            throw err;
        }
    }

    
    /**
      * @param {{query: *, config: *, signal?: AbortSignal|null}} arg0
     */
        async #run({ query, config, signal = null }) {
        const key = `${this.provider}\u0000${query}\u0000${JSON.stringify(config ?? {})}`;
        const cached = this._cache.get(key);
        const ttl = config?.cacheTtlMs ?? LIMITS.search_cache_ttl_ms;
        if (cached && ttl > 0 && Date.now() - cached.at < ttl) return cached.value;

        const opts = {
            ...(config.tavily ?? {}),
            ...(config.maxResults !== undefined ? { maxResults: config.maxResults } : {}),
            ...(config.maxUses !== undefined ? { maxUses: config.maxUses } : {}),
            ...(config.location !== undefined ? { location: config.location } : {}),
            ...(config.allowedDomains?.length ? { includeDomains: config.allowedDomains } : {}),
            blockedDomains: config.blockedDomains,
            ...(config.blockedDomains?.length ? { excludeDomains: config.blockedDomains } : {}),
            includeVendorMetadata: config.includeVendorMetadata,
            apiKey: config.tavily?.apiKey,
            signal,
            emitter: this.eventEmitter,
            model: config.model,
            provider: this.provider
        };
        const useJai = preferJaiEngine({ provider: this.provider, config });
        const result = useJai
            ? await JaiEngine.search({ query, opts, taskApi: this.taskApi })
            : await TavilyEngine.search({ query, opts });
        if (ttl > 0) {
            if (this._cache.has(key)) this._cache.delete(key);
            else if (this._cache.size >= LIMITS.search_cache_entries) {
                const oldest = this._cache.keys().next().value;
                if (oldest !== undefined) this._cache.delete(oldest);
            }
            this._cache.set(key, { at: Date.now(), value: result });
        }
        return result;
    }
}