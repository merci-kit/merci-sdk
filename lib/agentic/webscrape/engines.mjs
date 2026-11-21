// @ts-check


/**
 * @file Web-scrape engines + mode resolution.
 * @version 0.12.0
 *
 * @description
 * Three engines behind one unified result shape, and the tool/native/off mode
 * resolver. `TavilyExtractEngine` is a raw global `fetch` POST (no SDK, no new
 * deps); `CurlEngine` is a plain `fetch` that strips HTML down to text;
 * `JaiScrapeEngine` rides the JAI TaskAPI's `executeJson('web-scrape', …)`
 * contract.
 *
 * Unified result: `{ url, content, truncated, _vendor? }` (`_vendor` = the raw
 * vendor payload, present only when `includeVendorMetadata` is truthy).
 */
import { BackendError, wrapError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { redactUrl } from '../../support/redact.mjs';
import { warnWebUnsupported, resolveWebMode, hasDomainPolicy, urlPermitted, resolvePublicAddress, pinnedFetch, toUrls, webItemError, postJson, nativeProvidersFor } from '../web-shared.mjs';

/**
 * One scraped page in the unified shape both engines return.
 * @typedef {Object} UnifiedScrapeResult
 * @property {string} url
 * @property {string} content
 * @property {boolean} truncated
 * @property {string} [error]
 * @property {Record<string, unknown>} [_vendor] - The raw vendor payload, only with `includeVendorMetadata`.
 */

/**
 * The per-call options the scrape engines read. The scraper's config feeds it;
 * an engine warns about (and ignores) the knobs it does not support.
 * @typedef {Object} ScrapeEngineOptions
 * @property {string} [apiKey] - Tavily only.
 * @property {number} [timeout] - Request timeout in seconds (Tavily).
 * @property {number} [timeoutMs]
 * @property {number} [maxChars]
 * @property {string} [extract_depth]
 * @property {string} [extractDepth]
 * @property {string} [query]
 * @property {string} [format]
 * @property {boolean} [includeVendorMetadata]
 * @property {Array<string>} [allowedDomains]
 * @property {Array<string>} [blockedDomains]
 * @property {boolean} [allowPrivateNetwork]
 * @property {AbortSignal} [signal]
 * @property {import('node:events').EventEmitter<Record<string, unknown[]>>} [emitter]
 * @property {string} [model]
 * @property {string} [backend]
 * @property {number} [maxUses] - Not supported by either engine (warned).
 * @property {string} [location] - Not supported by either engine (warned).
 */

/**
 * `fetch` that cannot outrun the policy. With `redirect: 'follow'` the runtime
 * issues the next hop itself, so a `302` to a private address reached the
 * network before any caller could inspect it. This follows one hop at a time and
 * checks every hop (SSRF + domain policy) before requesting it.
 * @param {{url: string, opts: *, redirectMode: 'follow'|'error'|'manual', signal: *}} arg0
 * @returns {Promise<any>}
 */
async function fetchGuarded({ url, opts, redirectMode, signal }) {
    const policy = {
        allowedDomains: opts.allowedDomains ?? [],
        blockedDomains: opts.blockedDomains ?? [],
        allowPrivateNetwork: opts.allowPrivateNetwork,
        // Test seam: production leaves this undefined and uses dns.lookup.
        lookup: opts.lookup,
    };
    /**
     * Resolves once per hop and connects to that exact address. `opts.fetch`
     * is the test seam; production pins through `pinnedFetch`.
     * @param {{target: string, mode: string}} arg0
     */
    const request = async ({ target, mode }) => {
        const resolved = await resolvePublicAddress({ url: target, allowPrivateNetwork: policy.allowPrivateNetwork, lookup: policy.lookup });
        if (!resolved.ok) {
            // The origin only: a credentialed target must not be echoed (G2-8).
            throw new BackendError({ message: `Blocked: ${redactUrl({ url: target })} resolves to a private or reserved address.`, options: { provider: 'curl' } });
        }
        if (opts.fetch) return opts.fetch(target, { headers: { Accept: 'text/html' }, redirect: /** @type {any} */ (mode), signal });
        const res = await pinnedFetch({ url: target, headers: { Accept: 'text/html' }, signal, address: resolved.address, family: resolved.family });
        // `fetch` with redirect:'error' rejects a 3xx; pinnedFetch returns it.
        if (mode === 'error' && res.status >= 300 && res.status < 400) {
            throw new BackendError({ message: `Blocked: ${redactUrl({ url: target })} redirected while redirects are disabled.`, options: { provider: 'curl' } });
        }
        return res;
    };
    if (redirectMode !== 'follow') {
        return request({ target: url, mode: redirectMode });
    }
    let current = url;
    const maxRedirects = LIMITS.scrape_max_redirects;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const res = await request({ target: current, mode: 'manual' });
        const status = Number(res?.status ?? 0);
        if (status < 300 || status >= 400) return res;
        const location = res.headers?.get?.('location');
        if (!location) return res;
        let next;
        try {
            next = new URL(location, current).href;
        } catch {
            // The Location is attacker-controlled: keep only the fact, not its text.
            throw new BackendError({ message: `Blocked by the configured domain policy: unparseable redirect location '${redactUrl({ url: location })}'.`, options: { provider: 'curl' } });
        }
        if (!urlPermitted({ url: next, ...policy })) {
            throw new BackendError({ message: `Blocked by the configured domain policy: ${redactUrl({ url: next })}`, options: { provider: 'curl' } });
        }
        current = next;
    }
    throw new BackendError({ message: `Too many redirects (> ${maxRedirects}) for ${redactUrl({ url })}.`, options: { provider: 'curl' } });
}

/** @param {{opts: *, parameter: *, engine: *}} arg0 */
function warnUnsupported({ opts, parameter, engine }) {
    warnWebUnsupported({ opts, parameter, engine, kind: 'scrape' });
}

/** The providers with a native scrape leg. */
export const NATIVE_PROVIDERS = nativeProvidersFor({ capability: 'nativeWebScrape' });


/**
 * Resolves a session's web-scrape mode to 'tool' | 'native' | 'off'.
 * 'native_with_tavily_fallback' / 'native_with_curl_fallback' resolve to 'tool'
 * here — the adapters inject the native leg, this tool is the fallback leg.
 * @param {string} sessionProvider
 * @param {string} [mode] - 'native' | 'native_with_tavily_fallback' | 'native_with_curl_fallback' | 'tavily' | 'curl' | 'tool' | 'off' (undefined → off).
 * @returns {'tool'|'native'|'off'}
 */
const SCRAPE_TOOL_MODES = ['tavily', 'curl', 'tool', 'native_with_tavily_fallback', 'native_with_curl_fallback'];

/**
 * Resolves the scrape mode — the strategy the web scraper runs in.
  * @param {{sessionProvider: string|undefined, mode?: string}} arg0
 */
export function resolveScrapeMode({ sessionProvider, mode }) {
    return resolveWebMode({ nativeProviders: NATIVE_PROVIDERS, toolModes: SCRAPE_TOOL_MODES, sessionProvider, mode });
}


/**
 * Curl plain text) to the unified `{ url, content, truncated, _vendor? }` shape.
 * @param {{url: string, raw: Record<string, unknown>, includeVendorMetadata?: boolean}} arg0 -
 * @returns {UnifiedScrapeResult} The unified result.
 */
export function toUnifiedScrape({ url, raw, includeVendorMetadata = false }) {
    const content = /** @type {string} */ (raw?.content ?? raw?.rawContent ?? raw?.text ?? '');
    const result =  ({ url, content, truncated: false });
    if (raw?.error != null) /** @type {any} */ (result).error = raw.error;
    if (includeVendorMetadata) /** @type {any} */ (result)._vendor = raw;
    return result;
}

/**
 * Reads a fetch response body up to `maxBytes` without buffering an unbounded
 * stream in memory. Cancels the reader as soon as the cap is exceeded.
 * @param {{res: any, maxBytes?: number}} arg0
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function readBoundedText({ res, maxBytes = LIMITS.scrape_max_bytes }) {
    const contentLength = Number(res.headers?.get?.('content-length'));
    const body = res.body;
    if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        /** @type {Uint8Array[]} */
        const chunks = [];
        let total = 0;
        let truncated = false;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = value instanceof Uint8Array
                    ? value
                    : new TextEncoder().encode(String(value ?? ''));
                if (total + chunk.byteLength > maxBytes) {
                    const keep = maxBytes - total;
                    if (keep > 0) {
                        chunks.push(chunk.subarray(0, keep));
                        total += keep;
                    }
                    truncated = true;
                    await reader.cancel().catch(() => {});
                    break;
                }
                chunks.push(chunk);
                total += chunk.byteLength;
            }
        } finally {
            try { reader.releaseLock(); } catch {   }
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
        }
        return { text: new TextDecoder().decode(merged), truncated };
    }
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new BackendError({ message: `Curl scrape response content-length (${contentLength}) exceeds ${maxBytes} bytes.`, options: { status: res.status, provider: 'curl' } });
    }
    let text = await res.text();
    const truncated = text.length > maxBytes;
    if (truncated) text = text.slice(0, maxBytes);
    return { text, truncated };
}

/**
 * The strip/entity/whitespace tail `stripToText` and `markdownFromHtml` share.
 * Entity order matters: `&amp;` is decoded before the angle-bracket entities,
 * so `&amp;lt;` stays literal text. `keepLineBreaks` keeps the line structure
 * (markdown output) instead of collapsing it to one line (plain text).
 * @param {{text: *, keepLineBreaks?: boolean}} arg0
 * @returns {string}
 */
function htmlToText({ text, keepLineBreaks = false }) {
    const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
    if (!keepLineBreaks) return stripped.replace(/\s+/g, ' ').trim();
    return stripped
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** @param {{text: *}} arg0 */
function stripToText({ text }) {
    return htmlToText({ text });
}

/** @param {{html: *}} arg0 */
function markdownFromHtml({ html }) {
    let s = html;
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, /** @type {(...args: any[]) => any} */ ((m, n, b) => '#'.repeat(+n) + ' ' + b.trim() + '\n\n'));
    s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, /** @type {(...args: any[]) => any} */ ((m, b) => '\n```\n' + b.trim() + '\n```\n'));
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, /** @type {(...args: any[]) => any} */ ((m, b) => b.trim().split('\n').map( /** @type {(...args: any[]) => any} */ ((l) => '> ' + l)).join('\n') + '\n\n'));
    s = s.replace(/<hr[^>]*>/gi, '\n---\n');
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, /** @type {(...args: any[]) => any} */ ((m, b) => '- ' + b.trim() + '\n'));
    s = s.replace(/<(ul|ol)[^>]*>/gi, '\n').replace(/<\/(ul|ol)>/gi, '\n');
    s = s.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, /** @type {(...args: any[]) => any} */ ((m, src, alt) => `![${alt}](${src})`));
    s = s.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, /** @type {(...args: any[]) => any} */ ((m, alt, src) => `![${alt}](${src})`));
    s = s.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, /** @type {(...args: any[]) => any} */ ((m, href, t) => `[${t}](${href})`));
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, /** @type {(...args: any[]) => any} */ ((m, t) => `**${t}**`));
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, /** @type {(...args: any[]) => any} */ ((m, t) => `**${t}**`));
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, /** @type {(...args: any[]) => any} */ ((m, t) => `*${t}*`));
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, /** @type {(...args: any[]) => any} */ ((m, t) => `*${t}*`));
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, /** @type {(...args: any[]) => any} */ ((m, t) => '`' + t + '`'));
    s = s.replace(/<(br|p|div)[^>]*>/gi, '\n').replace(/<\/(p|div)>/gi, '\n');
    return htmlToText({ text: s, keepLineBreaks: true });
}


/**
 * Curl engine — plain `fetch`, strips HTML to text. No DOM parser, no deps.
 */
export class CurlEngine {
    
    /**
     * @returns {Promise<Array<UnifiedScrapeResult>>} One unified result per requested URL.
     * @param {{input: unknown, opts?: ScrapeEngineOptions}} arg0
     */
        static async fetch({ input, opts = {} }) {
        const optBag = /** @type {Record<string, unknown>} */ (opts);
        for (const parameter of ['maxUses', 'location']) {
            if (optBag[parameter] != null) warnUnsupported({ opts, parameter, engine: 'curl' });
        }
        const urls = toUrls({ input });
        const settled = await Promise.allSettled(urls.map((url) => CurlEngine.#fetchOne({ url, opts })));
        return settled.map((s, i) => s.status === 'fulfilled'
            ? s.value
            : webItemError({ url: urls[i], err: s.reason }));
    }

    
    /**
      * @param {{url: *, opts: *}} arg0
     */
        static async #fetchOne({ url, opts }) {
        const restricted = hasDomainPolicy({ allowedDomains: opts.allowedDomains, blockedDomains: opts.blockedDomains });
        if (!urlPermitted({ url, allowedDomains: opts.allowedDomains ?? [], blockedDomains: opts.blockedDomains ?? [], allowPrivateNetwork: opts.allowPrivateNetwork })) {
            throw new BackendError({ message: `Blocked by the configured domain policy: ${redactUrl({ url })}`, options: { provider: 'curl' } });
        }
        const timeoutSignal = opts.timeoutMs != null ? AbortSignal.timeout(opts.timeoutMs) : null;
        const signal = opts.signal && timeoutSignal
            ? AbortSignal.any([opts.signal, timeoutSignal])
            : (opts.signal ?? timeoutSignal ?? undefined);
        let res;
        try {
            const redirectMode = restricted ? 'error' : (opts.redirect ?? 'follow');
            res = await fetchGuarded({ url, opts, redirectMode, signal });
        } catch (err) {
            throw wrapError({ err, hints: { provider: 'curl' } });
        }
        const finalUrl = typeof res?.url === 'string' && res.url.trim() ? res.url.trim() : '';
        if (finalUrl && !urlPermitted({ url: finalUrl, allowedDomains: opts.allowedDomains ?? [], blockedDomains: opts.blockedDomains ?? [], allowPrivateNetwork: opts.allowPrivateNetwork })) {
            throw new BackendError({ message: `Blocked by the configured domain policy: ${redactUrl({ url: finalUrl })}`, options: { provider: 'curl' } });
        }
        const redirectLoc = res.headers?.get?.('location');
        if (redirectLoc) {
            let resolvedLoc = redirectLoc;
            try { resolvedLoc = new URL(redirectLoc, finalUrl || url).href; } catch {   }
            if (!urlPermitted({ url: resolvedLoc, allowedDomains: opts.allowedDomains ?? [], blockedDomains: opts.blockedDomains ?? [], allowPrivateNetwork: opts.allowPrivateNetwork })) {
                throw new BackendError({ message: `Blocked by the configured domain policy: ${redactUrl({ url: resolvedLoc })}`, options: { provider: 'curl' } });
            }
        }
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (ctype && !ctype.startsWith('text/') && !/html|json|xml/.test(ctype)) {
            throw new BackendError({ message: `Curl scrape refused non-text content-type '${ctype}'.`, options: { status: res.status, provider: 'curl' } });
        }

        let { text, truncated } = await readBoundedText({ res, maxBytes: LIMITS.scrape_max_bytes });
        text = opts.format === 'markdown' ? markdownFromHtml({ html: text }) : stripToText({ text });
        if (opts.maxChars && text.length > opts.maxChars) {
            text = text.slice(0, opts.maxChars);
            truncated = true;
        }
        const result = toUnifiedScrape({ url, raw: { content: text }, includeVendorMetadata: opts.includeVendorMetadata });
        if (truncated) ( (/** @type {any} */ (result))).truncated = true;
        return result;
    }
}


/**
 * Tavily extract engine — raw global `fetch` POST to https://api.tavily.com/extract.
 * Zero new dependencies; key from `opts.apiKey ?? process.env.TAVILY_API_KEY`.
 */
export class TavilyExtractEngine {
    
    /**
     * @returns {Promise<Array<UnifiedScrapeResult>>} One unified result per requested URL.
     * @param {{input: unknown, opts?: ScrapeEngineOptions}} arg0
     */
        static async extract({ input, opts = {} }) {
        const urls = toUrls({ input });
        const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
        if (!apiKey) throw new BackendError({ message: 'Tavily extract requires an API key (opts.apiKey or TAVILY_API_KEY).', options: { provider: 'tavily' } });
        const optBag = /** @type {Record<string, unknown>} */ (opts);
        for (const parameter of ['maxUses', 'location']) {
            if (optBag[parameter] != null) warnUnsupported({ opts, parameter, engine: 'tavily' });
        }

        const timeoutSec = opts.timeoutMs != null ? opts.timeoutMs / 1000 : opts.timeout;
        const body = /** @type {Record<string, any>} */ ({
            api_key: apiKey,
            urls,
            extract_depth: opts.extract_depth ?? opts.extractDepth,
            query: opts.query,
            timeout: timeoutSec != null
                ? Math.min(LIMITS.scrape_timeout_max_ms, Math.max(LIMITS.scrape_timeout_min_ms, timeoutSec * 1000)) / 1000
                : undefined,
            format: opts.format
        });

        const data = await postJson({ url: 'https://api.tavily.com/extract', body, signal: opts.signal, provider: 'tavily', label: 'Tavily extract failed' });
        const byUrl = new Map((/** @type {any} */ (data)?.results ?? []).map( /** @type {(...args: any[]) => any} */ ((r) => [r?.url, r])));
        return urls.map((url) => {
            const r = byUrl.get(url);
            if (!r) return webItemError({ url, err: new Error('Tavily returned no result for this URL.') });
            let content = String(r.raw_content ?? '');
            let truncated = false;
            if (opts.maxChars && content.length > opts.maxChars) {
                content = content.slice(0, opts.maxChars);
                truncated = true;
            }
            const raw = { ...(data && typeof data === 'object' ? data : {}), content };
            const result = toUnifiedScrape({ url, raw, includeVendorMetadata: opts.includeVendorMetadata });
            if (truncated) (/** @type {any} */ (result)).truncated = true;
            return result;
        });
    }
}


/**
 * JAI engine — rides `taskApi.executeJson('web-scrape', { url }, { version:'v4' })`.
 * @see lib/backends/jai-vendor/api.mjs TaskAPI#executeJson
 */
export class JaiScrapeEngine {
    
    /**
     *   and emit a `parameter_warning` (needs `opts.emitter`).
     * @returns {Promise<Array<UnifiedScrapeResult>>} One unified result per requested URL.
     * @param {{input: unknown, opts?: ScrapeEngineOptions, taskApi: {executeJson: Function}|null}} arg0
     */
        static async scrape({ input, opts = {}, taskApi }) {
        if (!taskApi?.executeJson) throw new BackendError({ message: 'JAI web scrape requires taskApi.executeJson.', options: { provider: 'jai' } });

        const optBag = /** @type {Record<string, unknown>} */ (opts);
        for (const parameter of ['maxUses', 'location', 'timeoutMs']) {
            if (optBag[parameter] != null) warnUnsupported({ opts, parameter, engine: 'jai' });
        }

        const urls = toUrls({ input });
        const results = [];
        for (const url of urls) {
            try {
                const params =  ({ url });
                if (opts.maxChars != null) /** @type {any} */ (params).maxChars = opts.maxChars;
                const raw = await ( (taskApi)).executeJson({ taskId: 'web-scrape', parameters: params, options: { version: 'v4', ...(opts.signal ? { signal: opts.signal } : {}) } });
                results.push(toUnifiedScrape({ url, raw, includeVendorMetadata: opts.includeVendorMetadata }));
            } catch (err) {
                results.push(webItemError({ url, err }));
            }
        }
        return results;
    }
}