// @ts-check


/**
 * @file Obscura browser engines + mode resolution (read + interactive).
 * @version 0.12.0
 *
 * @description
 * `ObscuraEngine` drives the standalone `obscura fetch` binary (read leg, no
 * Playwright) via an injectable runner; `CurlEngine` (REUSE from webscrape) is
 * the read fallback. `PlaywrightSession` drives `obscura serve` over CDP via
 * playwright-core `connectOverCDP` (interactive leg: MCP parity minus
 * PDF/screencast) with an injectable `connect` factory for tests.
 *
 * Spike decision (Obscura 0.2.2, 2026-09-09): Obscura operates standalone —
 * `obscura fetch --dump text|markdown`, `obscura serve --port 9222` (CDP),
 * `obscura mcp`. Playwright connects optionally over CDP and is the client
 * for interactive control (verified: connect/newContext/newPage/goto/fill/
 * click/login-redirect/screenshot/evaluate against live `serve`).
 */
import { runCommand } from '../../support/run-command.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendError, AbortedError } from '../../core/errors.mjs';
import { LIMIT_DEFAULTS } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { redactUrl } from '../../support/redact.mjs';
import { CurlEngine } from '../webscrape/engines.mjs';
import { resolvesToPublicHost, toUrls, urlPermitted, webItemError } from '../web-shared.mjs';

/**
 * One URL's fetch result.
 * @typedef {Object} BrowserFetchResult
 * @property {string} url
 * @property {string} content
 * @property {boolean} truncated
 * @property {string} [error]
 */

/**
 * Options accepted by `ObscuraEngine.fetch(...)`.
 * @typedef {Object} ObscuraFetchOptions
 * @property {string} [binaryPath]
 * @property {Function} [run] - Injectable runner (tests); defaults to `runCommand` (the safe env allowlist).
 * @property {string[]} [allowedDomains]
 * @property {string[]} [blockedDomains]
 * @property {boolean} [allowPrivateNetwork]
 * @property {number} [timeoutMs]
 * @property {'text'|'markdown'} [format]
 * @property {number} [maxChars]
 * @property {boolean} [includeVendorMetadata]
 * @property {AbortSignal|null} [signal]
 * @property {boolean} [inheritEnv] - Give the binary the whole parent environment (proxy / TLS variables included); by default it gets only the safe allowlist.
 * @property {Record<string, string>|null} [env] - Variables to pass on top of the allowlist (e.g. `HTTPS_PROXY`).
 */

/**
 * One element a snapshot captured.
 * @typedef {Object} SnapshotElement
 * @property {string} [tag]
 * @property {string} [text]
 * @property {string} selector
 */

/**
 * One intercepted network response.
 * @typedef {Object} NetworkEvent
 * @property {string} [url]
 * @property {string|null} [method]
 * @property {number} [status]
 */

/**
 * One captured console message.
 * @typedef {Object} ConsoleEvent
 * @property {string} [type]
 * @property {string} [text]
 */

/**
 * The element locator surface this session drives.
 * @typedef {Object} BrowserLocator
 * @property {Function} click
 * @property {Function} fill
 * @property {Function} pressSequentially
 * @property {Function} press
 * @property {Function} selectOption
 */

/**
 * The page surface this session drives (a subset of Playwright's Page).
 * @typedef {Object} BrowserPage
 * @property {() => string} url
 * @property {() => Promise<string>} title
 * @property {() => Promise<void>} close
 * @property {(event: string, handler: Function) => void} on
 * @property {(script: string) => Promise<unknown>} evaluate
 * @property {(selector: string) => BrowserLocator} locator
 * @property {{press: Function}} keyboard
 * @property {(arg0: Record<string, unknown>) => Promise<void>} screenshot
 * @property {(url: string, arg0?: Object) => Promise<unknown>} goto
 */

/**
 * The request a route handler inspects.
 * @typedef {Object} BrowserRouteRequest
 * @property {() => string} url
 */

/**
 * One intercepted request.
 * @typedef {Object} BrowserRoute
 * @property {() => BrowserRouteRequest} request
 * @property {() => Promise<void>} continue
 * @property {() => Promise<void>} abort
 */

/**
 * One routed WebSocket.
 * @typedef {Object} BrowserSocketRoute
 * @property {() => string} url
 * @property {() => Promise<void>} connectToServer
 * @property {() => Promise<void>} close
 */

/**
 * The browser context this session drives.
 * @typedef {Object} BrowserContext
 * @property {() => Promise<BrowserPage>} newPage
 * @property {(pattern: string, handler: (route: BrowserRoute) => Promise<void>) => Promise<void>} [route]
 * @property {(pattern: string, handler: (socket: BrowserSocketRoute) => Promise<void>) => Promise<void>} [routeWebSocket]
 */

/**
 * The options this session passes to `newContext` (a subset of Playwright's).
 * `serviceWorkers: 'block'` is the init override that stops a page registering
 * a worker, whose fetch handler would answer under the context route.
 * @typedef {Object} BrowserContextOptions
 * @property {'allow'|'block'} [serviceWorkers]
 */

/**
 * The CDP connection this session drives.
 * @typedef {Object} BrowserConnection
 * @property {(options?: BrowserContextOptions) => Promise<BrowserContext>} newContext
 * @property {Function} [close]
 */

/**
 * Options accepted by `new PlaywrightSession(...)`.
 * @typedef {Object} PlaywrightSessionOptions
 * @property {string} [endpointURL]
 * @property {(endpointURL: string) => Promise<BrowserConnection>} [connect]
 * @property {string|null} [screenshotDir]
 * @property {number|null} [timeoutMs]
 * @property {number} [maxChars]
 * @property {string[]} [allowedDomains]
 * @property {string[]} [blockedDomains]
 * @property {boolean} [allowPrivateNetwork]
 */

/**
 * The parameter bag an interactive action accepts.
 * @typedef {Object} BrowserActionParams
 * @property {string} [url]
 * @property {string|number} [ref]
 * @property {string} [selector]
 * @property {string|number} [text]
 * @property {string|number} [value]
 * @property {string|number} [key]
 * @property {string} [expression]
 */

/**
 * How many URLs one browser turn may open. The code default; the effective
 * value is `LIMITS.browser_max_urls` (see `getLimits()`).
 * shortcut: kept as a compatibility constant for consumers outside this module;
 * they should read LIMITS.browser_max_urls per call. Remove with the export.
 */
export const MAX_BROWSER_URLS = LIMIT_DEFAULTS.browser_max_urls;


/**
 * Resolves the browser mode — the strategy the browser tool runs in.
  * @param {{_sessionProvider?: string|null, mode?: string|null}} arg0
 */
export function resolveBrowserMode({ _sessionProvider, mode }) {
    if (!mode || mode === 'off') return 'off';
    return 'tool';
}

/**
 * Runs the engine binary through the SDK's one spawn choke point. A missing binary
 * rejects with the raw ENOENT error; a non-zero exit (or an output overflow) rejects.
 * @param {{binaryPath: string, args: string[], timeoutMs?: number, signal?: AbortSignal|null, inheritEnv?: boolean, env?: Record<string, string>|null}} arg0
 * @returns {Promise<string>} stdout
 */
async function defaultRun({ binaryPath, args, timeoutMs, signal = null, inheritEnv = false, env = null }) {
    const { code, stdout, stderr, truncated } = await runCommand({ command: binaryPath, args, timeoutMs: timeoutMs ?? LIMITS.browser_engine_timeout_ms, signal, inheritEnv, env });
    if (code !== 0 || truncated) {
        throw Object.assign(new Error(truncated ? `${binaryPath} output exceeded the buffer` : `${binaryPath} exited with code ${code}`), { code, stderr: String(stderr ?? '').slice(0, LIMITS.webscrape_stderr_tail_chars) });
    }
    return stdout;
}


/**
 * Obscura engine — standalone `obscura fetch <url> --dump <text|markdown>`.
 * Zero new dependencies; binary from `opts.binaryPath ?? OBSCURA_BINARY`.
 */
export class ObscuraEngine {
    
    /**
     * @returns {Promise<Array<BrowserFetchResult>>} One `{ url, content, truncated, error? }` per URL.
      * @param {{input?: string|Array<string>|null, opts?: ObscuraFetchOptions}} arg0
     */
        static async fetch({ input, opts = {} }) {
        const binaryPath = opts.binaryPath ?? process.env.OBSCURA_BINARY ?? 'obscura';
        const urls = toUrls({ input });
        const run = opts.run ?? defaultRun;
        /** @type {Array<BrowserFetchResult>} */
        const results = [];
        for (const url of urls) {
            try {
                if (!urlPermitted({ url, allowedDomains: opts.allowedDomains ?? [], blockedDomains: opts.blockedDomains ?? [], allowPrivateNetwork: opts.allowPrivateNetwork })) {
                    throw new BackendError({ message: `Blocked by the configured domain policy: ${redactUrl({ url })}`, options: { provider: 'obscura' } });
                }
                const timeoutSec = Math.max(1, Math.ceil((opts.timeoutMs ?? LIMITS.browser_engine_timeout_ms) / 1000));
                const dump = opts.format === 'markdown' ? 'markdown' : 'text';
                const args = ['fetch', url, '--dump', dump, '--timeout', String(timeoutSec), '--quiet'];
                let content = await run({ binaryPath, args, timeoutMs: opts.timeoutMs, signal: opts.signal, inheritEnv: opts.inheritEnv === true, env: opts.env ?? null });
                content = String(content ?? '').replace(/^Fetching .*?\n/, '').replace(/^Page loaded: .*?\n/, '').trimStart();
                let truncated = false;
                if (opts.maxChars != null && content.length > opts.maxChars) {
                    content = content.slice(0, opts.maxChars);
                    truncated = true;
                }
                const result =  ({ url, content, truncated });
                if (opts.includeVendorMetadata) /** @type {any} */ (result)._vendor = { engine: 'obscura', dump };
                results.push(result);
            } catch (err) {
                results.push(webItemError({ url, err: (/** @type {any} */ (err)).code === 'ENOENT' ? new BackendError({ message: `Obscura binary not found at '${binaryPath}'. Set config.binaryPath or OBSCURA_BINARY.`, options: { provider: 'obscura' } }) : err }));
            }
        }
        return results;
    }
}

export { CurlEngine };

/** @param {string} endpointURL */
async function defaultConnect( endpointURL) {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch {
        throw new BackendError({ message: 'Interactive browser actions require playwright-core (pnpm add playwright-core).', options: { provider: 'playwright' } });
    }
    return /** @type {BrowserConnection} */ (/** @type {unknown} */ (await chromium.connectOverCDP({ endpointURL })));
}

/**
 * The snapshot script, rebuilt per call so its bounds come from the limit registry.
 * @returns {string}
 */
function snapshotScript() {
    return `() => {
    const els = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]')) {
        if (els.length >= ${LIMITS.browser_snapshot_elements}) break;
        if (!el.isConnected || seen.has(el)) continue;
        seen.add(el);
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.value || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, ${LIMITS.element_label_chars});
        const rect = el.getBoundingClientRect?.();
        if (rect && (rect.width === 0 && rect.height === 0) && !text) continue;
        let selector;
        if (el.id) selector = '#' + CSS.escape(el.id);
        else {
            const parts = [];
            let node = el;
            for (let d = 0; d < ${LIMITS.selector_ancestor_depth} && node && node !== document.body; d++) {
                const name = node.tagName.toLowerCase();
                let idx = 1;
                for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
                    if (s.tagName === node.tagName) idx++;
                }
                parts.unshift(idx > 1 ? name + ':nth-of-type(' + idx + ')' : name);
                node = node.parentElement;
            }
            selector = parts.join(' > ');
        }
        els.push({ tag, text, selector });
    }
    return { text: (document.body?.innerText ?? '').trim(), elements: els };
}`;
}


/**
 * The policy URL of a WebSocket: the http(s) form of the same origin, so the
 * shared SSRF and domain helpers — which read only http/https — can decide it.
 * @param {string} url
 * @returns {string}
 */
function policyUrlForSocket(url) {
    return String(url ?? '').replace(/^ws(s?):/i, 'http$1:');
}


/**
 * Interactive session over `obscura serve` CDP via Playwright.
 * One persistent page per instance (mirrors Obscura MCP's persistent page);
 * the owning component caches the instance and drops it on `close`.
 */
export class PlaywrightSession {
    
    /**
      * @param {{opts?: PlaywrightSessionOptions}} arg0
     */
        constructor({ opts = {} } = {}) {
        this.endpointURL = /** @type {string} */ (opts.endpointURL ?? process.env.OBSCURA_CDP ?? 'ws://127.0.0.1:9222');
        this._connect = /** @type {(endpointURL: string) => Promise<BrowserConnection>} */ (opts.connect ?? defaultConnect);
        this._screenshotDir = /** @type {string|null} */ (opts.screenshotDir ?? null);
        this._timeoutMs = /** @type {number|null} */ (opts.timeoutMs ?? null);
        this._maxChars = /** @type {number} */ (opts.maxChars ?? LIMITS.browser_content_max_chars);
        this._allowedDomains = /** @type {string[]} */ (opts.allowedDomains ?? []);
        this._blockedDomains = /** @type {string[]} */ (opts.blockedDomains ?? []);
        this._allowPrivateNetwork = !!opts.allowPrivateNetwork;
        this._browser = /** @type {BrowserConnection|null} */ (null);
        this._ctx = /** @type {BrowserContext|null} */ (null);
        this._page = /** @type {BrowserPage|null} */ (null);
        
        /** @type {Array<SnapshotElement>} */
                this._snapshot = [];
        
        /** @type {Array<NetworkEvent>} */
                this._network = [];
        
        /** @type {Array<ConsoleEvent>} */
                this._console = [];
    }

    get connected() {
        return !!this._page;
    }

    /**
     * One URL — an HTTP request or a WebSocket origin — passes the host policy.
     * @param {{url: string}} arg0
     * @returns {Promise<boolean>}
     */
    async _permitted({ url }) {
        if (typeof url !== 'string' || url === '') return false;
        if (!(await resolvesToPublicHost({ url, allowPrivateNetwork: this._allowPrivateNetwork }))) return false;
        return urlPermitted({
            url,
            allowedDomains: this._allowedDomains,
            blockedDomains: this._blockedDomains,
            allowPrivateNetwork: this._allowPrivateNetwork,
        });
    }

    /**
     * shortcut: the route resolves the hostname, then Chromium resolves it again,
     * so the browser leg is check-then-connect (G2-6c). A CDP-connected remote
     * browser takes no launch args and no resolver rules, so the address cannot
     * be pinned the way the scrape leg pins it (pinnedFetch); closing this needs
     * a local proxy in front of the browser. The literal-host guard and the
     * per-hop policy check still apply. Upgrade when a launchable/bundled
     * Chromium with a resolver rule becomes an option.
     * @returns {Promise<BrowserContext>}
     */
    async _ensureContext() {
        if (this._ctx) return this._ctx;
        this._browser = await this._connect(this.endpointURL);
        // `serviceWorkers: 'block'` is Playwright's init override of
        // ServiceWorkerContainer.register: it stops a page installing a worker,
        // whose fetch handler would answer under the context route. A worker
        // registered earlier in a reused CDP profile still controls its origin —
        // a residual this release cannot close (docs/MIGRATION.md §16).
        const ctx = /** @type {BrowserContext} */ (await this._browser.newContext({ serviceWorkers: 'block' }));
        const routesHttp = typeof ctx.route === 'function';
        const routesSockets = typeof ctx.routeWebSocket === 'function';
        // Both legs must exist together (W2-11). A context with `route` alone —
        // playwright-core before 1.48 — would leave every WebSocket unpoliced,
        // so that shape fails closed instead of skipping the guard. A context
        // with neither routes nothing at all: it is a test double, not a browser.
        if (routesHttp !== routesSockets) {
            throw new BackendError({
                message: `The browser context cannot be policed: ${routesHttp ? 'routeWebSocket()' : 'route()'} is missing, and both route() and routeWebSocket() are required (playwright-core >= 1.48).`,
                options: { provider: 'playwright' }
            });
        }
        // Narrowed inline: the boolean above is not a type guard, and a `?.` call
        // would silently skip a leg the check just proved present.
        if (typeof ctx.route === 'function' && typeof ctx.routeWebSocket === 'function') {
            // Every request the context makes — navigation, click, evaluate,
            // pressKey and subresources — passes this one policy check.
            await ctx.route('**/*', async (route) => {
                const url = String(route.request()?.url?.() ?? '');
                if (await this._permitted({ url })) await route.continue();
                else await route.abort();
            });
            // A WebSocket is not an HTTP request either: `route` never sees it,
            // so the same policy runs here and a refused socket is closed.
            await ctx.routeWebSocket('**/*', async (socket) => {
                const url = policyUrlForSocket(String(socket.url?.() ?? ''));
                if (await this._permitted({ url })) await socket.connectToServer();
                else await socket.close();
            });
        }
        // Assigned last: a context that failed to install its guards must not be
        // cached as if it had, or the retry would run unpoliced.
        this._ctx = ctx;
        return this._ctx;
    }

    /** @returns {Promise<BrowserPage>} */
    async _ensurePage() {
        if (this._page) return this._page;
        await this._ensureContext();
        this._page = await this._freshPage();
        return this._page;
    }

    /** @returns {Promise<BrowserPage>} */
    async _freshPage() {
        const ctx = await this._ensureContext();
        const page = await ctx.newPage();
        page.on('response', /** @type {(...args: any[]) => any} */ (( res) => {
            if (this._network.length >= LIMITS.browser_event_log_cap) this._network.shift();
            this._network.push({ url: res.url(), method: res.request()?.method() ?? null, status: res.status() });
        }));
        page.on('console', /** @type {(...args: any[]) => any} */ (( msg) => {
            if (this._console.length >= LIMITS.browser_event_log_cap) this._console.shift();
            this._console.push({ type: msg.type(), text: msg.text().slice(0, LIMITS.browser_console_text_chars) });
        }));
        return page;
    }

    /** @param {{url: string}} arg0 @returns {Promise<BrowserPage>} */
    async _recycle({ url }) {
        if (url !== 'about:blank' && !urlPermitted({ url: String(url ?? ''), allowedDomains: this._allowedDomains, blockedDomains: this._blockedDomains, allowPrivateNetwork: this._allowPrivateNetwork })) {
            throw new BackendError({ message: `Blocked by the configured domain policy: ${redactUrl({ url })}`, options: { provider: 'playwright' } });
        }
        try {
            await this._page?.close?.();
        } catch {   }
        this._page = await this._freshPage();
        this._snapshot = [];
        await this._page.goto(url, this._withTimeout({ extra: { waitUntil: 'load' } }));
        return this._page;
    }

    /** @param {{page: BrowserPage}} arg0 @returns {Promise<BrowserPage>} */
    async _heal({ page }) {
        try {
            await page.evaluate('1+1');
            return page;
        } catch {
            return this._recycle({ url: page.url() });
        }
    }

    /** @param {{p?: BrowserActionParams}} arg0 @returns {string} */
    _target({ p = {} } = {}) {
        if (p.ref != null) {
            const el = this._snapshot[Number(p.ref)];
            if (!el) throw new BackendError({ message: `Unknown element ref '${p.ref}'. Take a snapshot first.`, options: { provider: 'playwright' } });
            return el.selector;
        }
        if (typeof p.selector === 'string' && p.selector.trim()) return p.selector.trim();
        throw new BackendError({ message: 'An interactive action needs `ref` (from snapshot) or `selector`.', options: { provider: 'playwright' } });
    }

    /** @param {{extra?: Object}} arg0 @returns {Object} */
    _withTimeout({ extra = {} } = {}) {
        return this._timeoutMs != null ? { ...extra, timeout: this._timeoutMs } : extra;
    }

    
    /**
     * @param {{action: string, p?: BrowserActionParams, signal?: AbortSignal|null}} arg0 - navigate|snapshot|click|fill|type|pressKey|selectOption|evaluate|waitFor|networkRequests|consoleMessages|screenshot|close.
     * @returns {Promise<Record<string, unknown>>} Plain JSON-serializable result.
     */
        async act({ action, p = {}, signal = null }) {
        if (signal?.aborted) {
            throw new AbortedError({ message: `Browser action '${action}' aborted before it started.`, options: { cause: signal.reason } });
        }
        if (action === 'close') return this.close();
        // Navigate owns its page (a fresh one); every other action uses the
        // session's current page.
        if (action === 'navigate') {
            if (!p.url) throw new BackendError({ message: 'navigate requires `url`.', options: { provider: 'playwright' } });
            await this._ensureContext();
            const fresh = await this._recycle({ url: p.url });
            return { url: fresh.url(), title: await fresh.title() };
        }
        const page = await this._ensurePage();
        switch (action) {
            case 'snapshot': {
                const { text, elements } = /** @type {{text?: string, elements: Array<SnapshotElement>}} */ (await page.evaluate(`(${snapshotScript()})()`));
                this._snapshot = elements;
                const body = String(text ?? '');
                const truncated = body.length > this._maxChars;
                return {
                    url: page.url(), title: await page.title(),
                    bodyText: truncated ? body.slice(0, this._maxChars) : body, truncated,
                    elements: elements.map(/** @type {(...args: any[]) => any} */ (( e,  i) => ({ ref: i, ...e }))),
                };
            }
            case 'click': {
                await page.locator(this._target({ p })).click(this._withTimeout());
                const healed = await this._heal({ page });
                return { ok: true, url: healed.url() };
            }
            case 'fill': {
                if (p.text == null) throw new BackendError({ message: 'fill requires `text`.', options: { provider: 'playwright' } });
                await page.locator(this._target({ p })).fill(String(p.text), this._withTimeout());
                return { ok: true, url: page.url() };
            }
            case 'type': {
                if (p.text == null) throw new BackendError({ message: 'type requires `text`.', options: { provider: 'playwright' } });
                await page.locator(this._target({ p })).pressSequentially(String(p.text), this._withTimeout());
                return { ok: true, url: page.url() };
            }
            case 'pressKey': {
                if (!p.key) throw new BackendError({ message: 'pressKey requires `key`.', options: { provider: 'playwright' } });
                if (p.ref != null || p.selector) await page.locator(this._target({ p })).press(String(p.key), this._withTimeout());
                else await page.keyboard.press(String(p.key));
                const healed = await this._heal({ page });
                return { ok: true, url: healed.url() };
            }
            case 'selectOption': {
                if (p.value == null && p.text == null) throw new BackendError({ message: 'selectOption requires `value` or `text`.', options: { provider: 'playwright' } });
                const values = await page.locator(this._target({ p })).selectOption(
                    p.value != null ? { value: String(p.value) } : { label: String(p.text) },
                    this._withTimeout()
                );
                const healed = await this._heal({ page });
                return { ok: true, selected: values, url: healed.url() };
            }
            case 'evaluate': {
                if (p.expression == null) throw new BackendError({ message: 'evaluate requires `expression`.', options: { provider: 'playwright' } });
                const value = await page.evaluate(`(() => { const v = (${String(p.expression)}); return v; })()`);
                try {
                    return { value: JSON.parse(JSON.stringify(value)) };
                } catch {
                    return { value: String(value), note: 'non-serializable value stringified' };
                }
            }
            case 'waitFor': {
                const selector = this._target({ p });
                const budget = this._timeoutMs ?? LIMITS.browser_wait_timeout_ms;
                const deadline = Date.now() + budget;
                for (;;) {
                    try {
                        const found = await page.evaluate(`(!!document.querySelector(${JSON.stringify(selector)}))`);
                        if (found) break;
                    } catch {
                    }
                    if (Date.now() >= deadline) {
                        throw new BackendError({ message: `waitFor timed out waiting for '${selector}'.`, options: { provider: 'playwright' } });
                    }
                    await new Promise((r) => setTimeout(r, LIMITS.browser_wait_poll_ms));
                }
                return { found: true, selector, url: page.url() };
            }
            case 'networkRequests':
                return { requests: [...this._network] };
            case 'consoleMessages':
                return { messages: [...this._console] };
            case 'screenshot': {
                const path = join(this._screenshotDir ?? tmpdir(), `browser-${Date.now()}.png`);
                await page.screenshot({ path });
                return { path, url: page.url() };
            }
            default:
                throw new BackendError({ message: `Unknown browser action '${action}'.`, options: { provider: 'playwright' } });
        }
    }

    
    /** Disconnects and resets session state (idempotent). */
        async close() {
        const was = this.connected;
        try {
            await this._browser?.close?.();
        } catch {   }
        this._browser = null;
        this._ctx = null;
        this._page = null;
        this._snapshot = [];
        this._network = [];
        this._console = [];
        return { closed: true, wasConnected: was };
    }
}
