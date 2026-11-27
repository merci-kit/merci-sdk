// @ts-check


/**
 * The interactive actions the browser tool understands — the vocabulary of a page interaction.
 * @file BrowserComponent — the `browser` function-tool surface (read-only slice).
 * @version 0.12.0
 *
 * @description
 * A LoadableComponent (REUSE of lib/core/loadable.mjs via `toLoadTool()`) that
 * exposes a single `browser` tool. Its execute runs ObscuraEngine (standalone
 * `obscura fetch` binary — no Playwright) or CurlEngine per the resolved
 * mode/config and returns the web_scrape-shaped result as a compact JSON
 * string (one format — machine-readable).
 *
 * Reads the session config contract `session._browser` (written by
 * ChatSessionBuilder.withBrowser): `{ mode, force, binaryPath, maxChars,
 * maxUrls, timeoutMs, format, includeVendorMetadata, curl, obscura }`.
 */
import { LoadableComponent } from '../../core/loadable.mjs';
import { BROWSER_PRELOAD_BLOCK, BROWSER_TOOL_NAME, CAPABILITY, CAPABILITY_REGISTRY, standardFor } from '../../core/constants/index.mjs';
import { EVENTS } from '../../core/events.mjs';
import { ConfigurationError, AbortedError } from '../../core/errors.mjs';
import { emitParameterWarning } from '../../support/utils.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { ObscuraEngine, CurlEngine, PlaywrightSession, resolveBrowserMode } from './engines.mjs';
import { resolveCapabilityMode, renderWebContextBlock, splitUrlsByDomainPolicy, hasDomainPolicy, urlPermitted, runWebBatch } from '../web-shared.mjs';


/**
 * The browser component's config bag: the knobs this component reads (the
 * browser engines and the scrape/search engines share the same object).
 * @typedef {Object} BrowserConfig
 * @property {string} [mode]
 * @property {Record<string, unknown>|null} [inject] - The web-context injection options.
 * @property {Object|null} [curl]
 * @property {Object|null} [obscura]
 * @property {string} [model]
 * @property {number} [maxUrls]
 * @property {boolean} [force]
 * @property {boolean} [preload]
 * @property {boolean} [includeVendorMetadata]
 * @property {string} [format]
 * @property {boolean} [allowUnpolicedObscura]
 * @property {string|null} [binaryPath]
 * @property {boolean} [inheritEnv] - The obscura binary gets the whole parent environment (default: the safe allowlist).
 * @property {Record<string, string>|null} [env] - Variables passed to the obscura binary on top of the allowlist.
 * @property {number} [timeoutMs]
 * @property {number} [maxChars]
 * @property {Array<string>} [allowedDomains]
 * @property {Array<string>} [blockedDomains]
 * @property {boolean} [allowPrivateNetwork]
 * @property {string|null} [endpointURL]
 * @property {string} [connect]
 * @property {string|null} [screenshotDir]
 * @property {{endpointURL?: string, connect?: string|boolean|Function, screenshotDir?: string}|null} [playwright] - The Playwright session options (or a connect factory).
 */

/**
 * The interactive actions the browser tool understands — the vocabulary of a
 * page interaction.
 */
export const INTERACTIVE_ACTIONS = Object.freeze([
    'snapshot', 'click', 'fill', 'type', 'pressKey', 'selectOption',
    'evaluate', 'waitFor', 'networkRequests', 'consoleMessages', 'screenshot', 'close'
]);

/**
 * Which read engine `#run` uses. A1-F3: curl is the guarded leg (its redirects
 * are checked hop by hop); the obscura leg follows redirects and reports no
 * final URL, so it cannot be held to a policy. Obscura is therefore opt-in for
 * an unpoliced read.
 * @param {{policy?: boolean, mode?: string, curl?: Object|null, allowUnpolicedObscura?: boolean}} arg0
 * @returns {'curl'|'obscura'}
 */
export function resolveReadEngine({ policy = false, mode, curl = null, allowUnpolicedObscura = false }) {
    const useCurl = policy === true || mode === 'curl' || curl != null || allowUnpolicedObscura !== true;
    return useCurl ? 'curl' : 'obscura';
}


/**
 * Browser capability surfaced as a `browser` function tool: `navigate`
 * (read leg, no action needed) plus the interactive actions (Playwright over
 * `obscura serve` CDP). PDF export and screencast are out of scope.
 * @extends {LoadableComponent}
 */
export class BrowserComponent extends LoadableComponent {
    
    /**
 * @param {{provider?: string, config?: BrowserConfig, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 */
        constructor({ provider, config = {}, eventEmitter = null } = {}) {
        super({
            id: CAPABILITY.BROWSER,
            loadToolName: BROWSER_TOOL_NAME,
            announce: CAPABILITY_REGISTRY[CAPABILITY.BROWSER]?.announce ?? null,
            loadDescription: 'Drive the headless browser. Omit action (or use navigate) to load page content; use an interactive action for control. Returns a JSON object.',
            loadParameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['navigate', ...INTERACTIVE_ACTIONS], description: 'Browser action (default navigate). Interactive actions drive the persistent page over CDP.' },
                    url: { type: 'string', description: 'A single URL to load (alternative to urls; navigate only).' },
                    urls: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.browser_max_urls, description: 'URLs to load (max ' + LIMITS.browser_max_urls + '; navigate only).' },
                    maxChars: { type: 'number', description: 'Optional maximum number of characters to return per page.' },
                    timeoutMs: { type: 'number', description: 'Optional navigation/action timeout in milliseconds.' },
                    format: { type: 'string', enum: ['text', 'markdown'], description: 'Content format (navigate only).' },
                    selector: { type: 'string', description: 'CSS selector target (click/fill/type/pressKey/selectOption/waitFor).' },
                    ref: { type: 'number', description: 'Element ref from the last snapshot (alternative to selector).' },
                    text: { type: 'string', description: 'Text to fill/type/select (fill/type/selectOption).' },
                    key: { type: 'string', description: 'Key to press (pressKey, e.g. Enter).' },
                    value: { type: 'string', description: 'Option value to select (selectOption, alternative to text).' },
                    expression: { type: 'string', description: 'JavaScript expression to evaluate (evaluate).' },
                    waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0'], description: 'Navigation wait condition (navigate).' }
                },
                required: []
            },
            eventEmitter
        });
        this.provider = provider;
        this.config = config;
        this._pw = null;
        // A1-F3: the engine-substitution warning is a configuration fact, not a
        // per-call event — warn once, not on every navigate.
        this._engineWarned = false;
    }

    
    /**
     * The unified `browser` tool definition (name/description/parameters/execute).
     * @returns {Object|null} The tool, or null.
     */
        toBrowserTool() {
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
        return renderWebContextBlock({ baseBlock: BROWSER_PRELOAD_BLOCK, inject: this.config?.inject });
    }

    
    /**
     * Loads the page(s) and returns the uniform `{ results, truncated }` shape
     * as a JSON string. Non-tool modes (off) are handled outside this tool —
     * return a short JSON note instead of erroring.
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
        const mode = resolveCapabilityMode({ resolveMode: resolveBrowserMode, sessionProvider: this.provider, config });
        if (mode !== 'tool') {
            return JSON.stringify({ results: [], truncated: false, note: `browser mode '${mode}' is handled outside this tool.` });
        }
        const action = typeof args?.action === 'string' ? args.action : 'navigate';
        if (INTERACTIVE_ACTIONS.includes(action) || (action === 'navigate' && args?.action === 'navigate')) {
            const target = typeof args?.url === 'string' ? args.url.trim() : '';
            if (target) {
                const { denied } = splitUrlsByDomainPolicy({ urls: [target], allowedDomains: config.allowedDomains, blockedDomains: config.blockedDomains, allowPrivateNetwork: config.allowPrivateNetwork });
                if (denied.length > 0) {
                    throw new ConfigurationError({ message: `browser: URL '${target}' is blocked by the configured domain policy.`, options: { option: 'url' } });
                }
            }
            return this.#interact({ action, args, config, signal });
        }
        if (action !== 'navigate') {
            throw new ConfigurationError({ message: `browser: unknown action '${action}'.`, options: { option: 'action' } });
        }
        return JSON.stringify(await runWebBatch({
            input: args,
            config,
            provider: this.provider,
            eventEmitter: this.eventEmitter,
            signal,
            limit: LIMITS.browser_max_urls,
            emptyMessage: 'browser requires a url or urls argument.',
            eventNames: {
                start: EVENTS.BROWSER.NAVIGATE_START,
                success: EVENTS.BROWSER.NAVIGATE_SUCCESS,
                error: EVENTS.BROWSER.NAVIGATE_ERROR
            },
            extraPayload: () => ({ engine: this.#engine(config) }),
            emit: (arg0) => this._emit(arg0),
            run: (arg0) => this.#run(arg0)
        }));
    }

    
    /**
      * @param {{config: BrowserConfig}} arg0
     */
        _session({ config: rawConfig }) {
        const config = /** @type {any} */ (rawConfig);
        if (!this._pw) {
            this._pw = new PlaywrightSession({ opts: {
                endpointURL: config.endpointURL ?? config.playwright?.endpointURL,
                connect: config.playwright?.connect ?? config.connect,
                screenshotDir: config.screenshotDir ?? config.playwright?.screenshotDir,
                timeoutMs: config.timeoutMs,
                maxChars: config.maxChars,
                allowedDomains: config.allowedDomains,
                blockedDomains: config.blockedDomains,
                allowPrivateNetwork: config.allowPrivateNetwork,
            } });
        }
        return this._pw;
    }

    
    /**
      * @param {{action: *, args: *, config: *, signal?: AbortSignal|null}} arg0
     */
        async #interact({ action, args, config, signal = null }) {
        if (signal?.aborted) {
            throw new AbortedError({ message: `browser: action '${action}' aborted before it started.`, options: { cause: signal.reason } });
        }
        const startTs = Date.now();
        this._emit({ name: EVENTS.BROWSER.INTERACT_START, payload: { action, provider: this.provider, mode: config.mode } });
        try {
            const session = this._session({ config });
            const result = await session.act({ action, p: args ?? {}, signal });
            if (action === 'close') this._pw = null;
            if (action === 'navigate') {
                const finalUrl = typeof result?.url === 'string' ? result.url : '';
                if (finalUrl && !urlPermitted({ url: finalUrl, allowedDomains: config.allowedDomains ?? [], blockedDomains: config.blockedDomains ?? [], allowPrivateNetwork: config.allowPrivateNetwork })) {
                    try { await session._page?.goto?.('about:blank'); } catch {   }
                    try { await session.close?.(); } catch {   }
                    this._pw = null;
                    throw new ConfigurationError({ message: `browser: navigate to '${String(args?.url ?? '')}' redirected to '${finalUrl}', which the configured domain policy blocks.`, options: { option: 'url' } });
                }
            }
            this._emit({ name: EVENTS.BROWSER.INTERACT_SUCCESS, payload: {
                action, provider: this.provider, mode: config.mode,
                url: ( (result))?.url ?? null, durationMs: Date.now() - startTs,
            } });
            return JSON.stringify({ action, ...result });
        } catch (err) {
            this._emit({ name: EVENTS.BROWSER.INTERACT_ERROR, payload: {
                action, provider: this.provider, mode: config.mode,
                durationMs: Date.now() - startTs, error: ( (/** @type {any} */ (err)))?.message ?? String(err),
            } });
            throw err;
        }
    }

    
    /**
     * The read engine this config resolves to. Curl is the guarded leg; obscura
     * follows redirects and cannot be constrained, so it needs the explicit opt-in.
     * @param {any} config
     * @returns {'curl'|'obscura'}
     */
    #engine(config) {
        return resolveReadEngine({
            policy: hasDomainPolicy({ allowedDomains: config.allowedDomains, blockedDomains: config.blockedDomains }),
            mode: config.mode,
            curl: config.curl,
            allowUnpolicedObscura: config.allowUnpolicedObscura,
        });
    }

    /**
      * @param {{urls: *, config: *, args: *, signal?: AbortSignal|null}} arg0
     */
        async #run({ urls, config, args, signal }) {
        const opts = {
            binaryPath: config.binaryPath ?? config.obscura?.binaryPath,
            maxChars: args?.maxChars ?? config.maxChars,
            timeoutMs: args?.timeoutMs ?? config.timeoutMs,
            format: args?.format ?? config.format ?? 'text',
            includeVendorMetadata: config.includeVendorMetadata,
            run: config.obscura?.run ?? config.run,
            inheritEnv: config.obscura?.inheritEnv ?? config.inheritEnv,
            env: config.obscura?.env ?? config.env,
            allowedDomains: config.allowedDomains,
            blockedDomains: config.blockedDomains,
            allowPrivateNetwork: config.allowPrivateNetwork,
            fetch: config.curl?.fetch,
            signal,
            emitter: this.eventEmitter,
            model: config.model,
            provider: this.provider
        };
        const policy = hasDomainPolicy({ allowedDomains: config.allowedDomains, blockedDomains: config.blockedDomains });
        // A1-F3: an unpoliced read goes through curl unless the caller has
        // explicitly accepted obscura's unconstrained redirects.
        const engine = this.#engine(config);
        if (engine === 'curl' && config.curl == null && config.mode !== 'curl' && this._engineWarned !== true) {
            this._engineWarned = true;
            emitParameterWarning({
                emitter: this.eventEmitter,
                model: config.model ?? '',
                parameter: policy ? 'allowedDomains' : 'mode',
                provider: this.provider,
                standard: standardFor({ provider: this.provider }) ?? '',
                message: policy
                    ? 'Domain policy is enforced with the curl fallback; the obscura read leg cannot be constrained to it (it follows redirects).'
                    : 'The obscura read leg follows redirects and cannot be constrained, so an unpoliced read uses curl. Pass { allowUnpolicedObscura: true } to opt in.',
            });
        }
        // The scrape engines read a subset of this bag (their own knobs); the
        // browser-only extras (binaryPath/run) ride along untouched.
        const scrapeOpts = /** @type {import('../webscrape/engines.mjs').ScrapeEngineOptions} */ (opts);
        return engine === 'curl'
            ? CurlEngine.fetch({ input: urls, opts: scrapeOpts })
            : ObscuraEngine.fetch({ input: urls, opts });
    }
}
