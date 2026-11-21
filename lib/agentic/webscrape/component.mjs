// @ts-check


/**
 * @file WebScrapeComponent — the `web_scrape` function-tool surface.
 * @version 0.12.0
 *
 * @description
 * A LoadableComponent (REUSE of lib/core/loadable.mjs via `toLoadTool()`) that
 * exposes a single `web_scrape` tool. Its execute runs JaiScrapeEngine,
 * CurlEngine, or TavilyExtractEngine per the resolved mode/backend and returns
 * the unified result as a compact JSON string (one format — machine-readable).
 *
 * Reads the session config contract `session._webScrape` (written elsewhere):
 * `{ mode, force, maxChars, timeoutMs, includeVendorMetadata, tavily: { ... },
 *   curl: { ... } }`.
 */
import { LoadableComponent } from '../../core/loadable.mjs';
import { CAPABILITY, CAPABILITY_REGISTRY, WEB_SCRAPE_PRELOAD_BLOCK, WEB_SCRAPE_TOOL_NAME, standardFor } from '../../core/constants/index.mjs';
import { EVENTS } from '../../core/events.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import { emitParameterWarning } from '../../support/utils.mjs';
import { JaiScrapeEngine, TavilyExtractEngine, CurlEngine, resolveScrapeMode } from './engines.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { preferJaiEngine, resolveCapabilityMode, renderWebContextBlock, splitUrlsByDomainPolicy, webItemError } from '../web-shared.mjs';


/**
 * The web-scrape config bag: the knobs this component reads (the session writes
 * it as `session._webScrape`).
 * @typedef {Object} WebScrapeConfig
 * @property {string} [mode]
 * @property {string} [model]
 * @property {number} [maxUrls]
 * @property {number} [maxChars]
 * @property {number} [maxUses]
 * @property {number} [timeoutMs]
 * @property {string} [format]
 * @property {string|null} [location] - Passed through (neither engine supports it).
 * @property {Array<string>} [allowedDomains]
 * @property {Array<string>} [blockedDomains]
 * @property {boolean} [allowPrivateNetwork]
 * @property {boolean} [includeVendorMetadata]
 * @property {Object|null} [tavily] - The Tavily engine's own options bag.
 * @property {Object|null} [curl] - Forces the curl leg when set.
 * @property {import('../web-shared.mjs').WebInjectOptions|null} [inject]
 */

/**
 * Web-scrape capability surfaced as a `web_scrape` function tool.
 * @extends {LoadableComponent}
 */
export class WebScrapeComponent extends LoadableComponent {
    
    /**
 * @param {{provider?: string, config?: WebScrapeConfig, taskApi?: {executeJson: Function}|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 */
        constructor({ provider, config = {}, taskApi = null, eventEmitter = null } = {}) {
        super({
            id: CAPABILITY.WEB_SCRAPE,
            loadToolName: WEB_SCRAPE_TOOL_NAME,
            announce: CAPABILITY_REGISTRY[CAPABILITY.WEB_SCRAPE]?.announce ?? null,
            loadDescription: 'Fetch the content of one or more web pages. Returns a JSON object: { results: [{ url, content, truncated, error? }], truncated }.',
            loadParameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'A single URL to scrape (alternative to urls).' },
                    urls: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.scrape_max_urls, description: 'URLs to scrape (max ' + LIMITS.scrape_max_urls + ').' },
                    maxChars: { type: 'number', description: 'Optional maximum number of characters to return per page.' },
                    timeoutMs: { type: 'number', description: 'Optional request timeout in milliseconds.' },
                    format: { type: 'string', enum: ['text', 'markdown'], description: 'Content format: curl renders markdown locally; Tavily uses native markdown; JAI returns plain text.' }
                },
                required: []
            },
            eventEmitter
        });
        this.provider = provider;
        this.config = config;
        this.taskApi = taskApi;
    }

    
    /**
     * The unified `web_scrape` tool definition (name/description/parameters/execute).
     * @returns {Object|null} The tool, or null.
     */
        toWebScrapeTool() {
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
        return renderWebContextBlock({ baseBlock: WEB_SCRAPE_PRELOAD_BLOCK, inject: this.config?.inject });
    }

    
    /**
     * Runs the scrape(s) and returns the uniform `{ results, truncated }` shape
     * as a JSON string. Non-tool modes (native/off) are handled outside this
     * tool — return a short JSON note instead of erroring.
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
        const config =  (this.config ?? {});
        const mode = resolveCapabilityMode({ resolveMode: resolveScrapeMode, sessionProvider: this.provider, config });
        if (mode !== 'tool') {
            return JSON.stringify({ results: [], truncated: false, note: `web scrape mode '${mode}' is handled outside this tool.` });
        }
        const raw = args?.urls ?? (args?.url ? [args.url] : []);
        const urls = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
        if (urls.length === 0) {
            throw new ConfigurationError({ message: 'web_scrape requires a url or urls argument.', options: { option: 'url' } });
        }
        const configuredMaxUrls = config.maxUrls;
        const maxUrls = Number.isInteger(configuredMaxUrls) && /** @type {number} */ (configuredMaxUrls) >= 1 ? /** @type {number} */ (configuredMaxUrls) : LIMITS.scrape_max_urls;
        const effective = Math.min(maxUrls, LIMITS.scrape_max_urls);
        let targets = urls;
        let truncated = false;
        if (targets.length > effective) {
            truncated = true;
            targets = targets.slice(0, effective);
            emitParameterWarning({ emitter: this.eventEmitter, model: config.model ?? '', parameter: 'maxUrls', provider: this.provider, standard: standardFor({ provider: this.provider }) ?? '', message: `Parameter 'maxUrls' capped to ${effective} — ${urls.length} URLs requested.` });
        }
        const startTs = Date.now();
        for (const url of targets) {
            this._emit({ name: EVENTS.WEB_SCRAPE.SCRAPE_START, payload: { url, provider: this.provider, mode: config.mode } });
        }
        const { permitted, denied } = splitUrlsByDomainPolicy({ urls: targets, allowedDomains: config.allowedDomains, blockedDomains: config.blockedDomains, allowPrivateNetwork: config.allowPrivateNetwork });
        if (denied.length > 0) {
            emitParameterWarning({ emitter: this.eventEmitter, model: config.model ?? '', parameter: 'allowedDomains', provider: this.provider, standard: standardFor({ provider: this.provider }) ?? '', message: `Domain policy blocked ${denied.length} URL(s): ${denied.join(', ')}.` });
        }
        try {
            const permittedResults = permitted.length > 0 ? (await this.#run({ urls: permitted, config, args, signal })) : [];
            const byUrl = new Map(permittedResults.map(/** @type {(...args: any[]) => any} */ (( r) => [/** @type {any} */ (r).url, r])));
            const results = targets.map((url) => byUrl.get(url) ?? webItemError({ url, err: 'Blocked by the configured domain policy.' }));
            for (const r of results) {
                this._emit({ name: EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS, payload: {
                    url: /** @type {any} */ (r).url, provider: this.provider, mode: config.mode,
                    chars: /** @type {any} */ (r).content.length, truncated: !!/** @type {any} */ (r).truncated, error: /** @type {any} */ (r).error,
                    durationMs: Date.now() - startTs,
                } });
            }
            return JSON.stringify({ results, truncated });
        } catch (err) {
            this._emit({ name: EVENTS.WEB_SCRAPE.SCRAPE_ERROR, payload: {
                provider: this.provider, mode: config.mode,
                durationMs: Date.now() - startTs, error: ( (/** @type {any} */ (err)))?.message ?? String(err),
            } });
            throw err;
        }
    }

    
    /**
      * @param {{urls: *, config: *, args: *, signal?: AbortSignal|null}} arg0
     */
        async #run({ urls, config, args, signal }) {
        const opts = {
            ...(config.tavily ?? {}),
            ...(config.curl ?? {}),
            maxChars: args?.maxChars ?? config.maxChars,
            maxUses: config.maxUses,
            location: config.location,
            timeoutMs: args?.timeoutMs ?? config.timeoutMs,
            includeVendorMetadata: config.includeVendorMetadata,
            format: args?.format ?? config.format ?? 'text',
            apiKey: config.tavily?.apiKey,
            allowedDomains: config.allowedDomains,
            blockedDomains: config.blockedDomains,
            allowPrivateNetwork: config.allowPrivateNetwork,
            signal,
            emitter: this.eventEmitter,
            model: config.model,
            provider: this.provider
        };
        const useCurl = config.mode === 'curl'
            || config.mode === 'native_with_curl_fallback'
            || config.curl != null;
        if (useCurl) return CurlEngine.fetch({ input: urls, opts });
        const useJai = preferJaiEngine({ provider: this.provider, config });
        return useJai
            ? JaiScrapeEngine.scrape({ input: urls, opts, taskApi: this.taskApi })
            : TavilyExtractEngine.extract({ input: urls, opts });
    }
}