// @ts-check


/**
 * @file Shared web tool helpers (search + scrape + browser).
 * @version 0.12.0
 *
 * @description
 * One copy of the logic the web components mirror: unsupported-parameter
 * warnings, the tool/native/off mode resolver, the per-URL item shape, the
 * engine-selection predicates, the shared Tavily POST-JSON prologue, and the
 * opt-in `inject` context (validation + preload-block rendering). Engines keep
 * thin named wrappers so their public imports stay unchanged.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

import { emitParameterWarning } from '../support/utils.mjs';
import { PROVIDERS, ProviderType, standardFor } from '../core/constants/index.mjs';
import { BackendError, ConfigurationError, wrapError } from '../core/errors.mjs';
import { formatPromptDate } from './context.mjs';


/**
 * The opt-in context injection block: the date/time format, the locale, and the
 * free-text instructions appended to the preload block.
 * @typedef {Object} WebInjectOptions
 * @property {{format?: 'full'|'iso'}} [date]
 * @property {boolean} [time]
 * @property {string} [locale]
 * @property {string} [timezone]
 * @property {string} [instructions]
 */

/**
 * @param {{opts: {emitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, model?: string, provider?: string}, parameter: string, engine: string, kind: string}} arg0
 */
export function warnWebUnsupported({ opts, parameter, engine, kind }) {
    const provider = opts.provider ?? engine;
    emitParameterWarning({ emitter: opts.emitter ?? null, model: opts.model ?? '', parameter, provider, standard: standardFor({ provider }) ?? '', message: `Parameter '${parameter}' is ignored by the ${engine} web ${kind}.` });
}


/**
 * @param {{nativeProviders: Set<string>, toolModes: string[], sessionProvider: string|undefined, mode?: string}} arg0
 * @returns {string}
 */
export function resolveWebMode({ nativeProviders, toolModes, sessionProvider, mode }) {
    if (!mode || mode === 'off') return 'off';
    if (toolModes.includes(mode)) return 'tool';
    // An undefined backend is never one of the native ones.
    if (mode === 'native') return nativeProviders.has(sessionProvider ?? '') ? 'native' : 'tool';
    return 'tool';
}


/**
 * @param {{resolveMode: (arg0: {sessionProvider: string|undefined, mode?: string}) => string, sessionProvider: string|undefined, config: {force?: boolean, mode?: string}|null|undefined}} arg0
 * @returns {string}
 */
export function resolveCapabilityMode({ resolveMode, sessionProvider, config }) {
    if (config?.force) return 'tool';
    return resolveMode({ sessionProvider, mode: config?.mode });
}


/**
 * Normalizes a tool's `url`/`urls` argument to the list of non-blank strings a
 * batched engine reads. A single string is one URL; anything else is ignored.
 * @param {{input: unknown}} arg0
 * @returns {Array<string>}
 */
export function toUrls({ input }) {
    const list = Array.isArray(input) ? input : input ? [input] : [];
    return list.filter((u) => typeof u === 'string' && u.trim());
}


/**
 * @typedef {Object} WebBatchConfig
 * @property {unknown} [maxUrls]
 * @property {string} [model]
 * @property {string} [mode]
 * @property {Array<string>} [allowedDomains]
 * @property {Array<string>} [blockedDomains]
 * @property {boolean} [allowPrivateNetwork]
 */

/**
 * @typedef {Object} WebBatchResult
 * @property {string} url
 * @property {string} content
 * @property {boolean} truncated
 * @property {string} [error]
 */

/**
 * Runs the shared read-batch prologue and epilogue used by browser and scrape.
 * Engine selection stays with the caller; this owns normalization, caps, domain
 * policy, event order, result mapping, and the uniform return shape.
 * @param {{input: Record<string, unknown>, config: WebBatchConfig, provider?: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, signal?: AbortSignal|null, limit: number, emptyMessage: string, eventNames: {start: string, success: string, error: string}, extraPayload?: Record<string, unknown>|(() => Record<string, unknown>), emit: (arg0: {name: string, payload: Record<string, unknown>}) => void, run: (arg0: {urls: string[], config: WebBatchConfig, args: Record<string, unknown>, signal?: AbortSignal|null}) => Promise<Array<WebBatchResult>>}} arg0
 * @returns {Promise<{results: Array<WebBatchResult>, truncated: boolean}>}
 */
export async function runWebBatch({ input, config, provider, eventEmitter = null, signal = null, limit, emptyMessage, eventNames, extraPayload = {}, emit, run }) {
    const eventExtra = () => typeof extraPayload === 'function' ? extraPayload() : extraPayload;
    const raw = input?.urls ?? (input?.url ? [input.url] : []);
    const urls = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
    if (urls.length === 0) {
        throw new ConfigurationError({ message: emptyMessage, options: { option: 'url' } });
    }
    const configuredMaxUrls = config.maxUrls;
    const maxUrls = Number.isInteger(configuredMaxUrls) && /** @type {number} */ (configuredMaxUrls) >= 1 ? /** @type {number} */ (configuredMaxUrls) : limit;
    const effective = Math.min(maxUrls, limit);
    let targets = urls;
    let truncated = false;
    if (targets.length > effective) {
        truncated = true;
        targets = targets.slice(0, effective);
        emitParameterWarning({ emitter: eventEmitter, model: config.model ?? '', parameter: 'maxUrls', provider, standard: standardFor({ provider }) ?? '', message: `Parameter 'maxUrls' capped to ${effective} — ${urls.length} URLs requested.` });
    }
    const startTs = Date.now();
    for (const url of targets) {
        emit({ name: eventNames.start, payload: { url, provider, mode: config.mode, ...eventExtra() } });
    }
    const { permitted, denied } = splitUrlsByDomainPolicy({ urls: targets, allowedDomains: config.allowedDomains, blockedDomains: config.blockedDomains, allowPrivateNetwork: config.allowPrivateNetwork });
    if (denied.length > 0) {
        emitParameterWarning({ emitter: eventEmitter, model: config.model ?? '', parameter: 'allowedDomains', provider, standard: standardFor({ provider }) ?? '', message: `Domain policy blocked ${denied.length} URL(s): ${denied.join(', ')}.` });
    }
    try {
        const permittedResults = permitted.length > 0 ? await run({ urls: permitted, config, args: input, signal }) : [];
        const byUrl = new Map(permittedResults.map((r) => [r.url, r]));
        const results = targets.map((url) => byUrl.get(url) ?? webItemError({ url, err: 'Blocked by the configured domain policy.' }));
        for (const r of results) {
            emit({ name: eventNames.success, payload: {
                url: r.url, provider, mode: config.mode, ...eventExtra(),
                chars: r.content.length, truncated: !!r.truncated, error: r.error,
                durationMs: Date.now() - startTs,
            } });
        }
        return { results, truncated };
    } catch (err) {
        emit({ name: eventNames.error, payload: {
            provider, mode: config.mode, ...eventExtra(),
            durationMs: Date.now() - startTs, error: /** @type {{message?: string}} */ (err)?.message ?? String(err),
        } });
        throw err;
    }
}


/**
 * The per-URL failure item every web engine returns: no content, no
 * truncation, and the error message.
 * @param {{url: string, err: unknown}} arg0
 * @returns {{url: string, content: string, truncated: boolean, error: string}}
 */
export function webItemError({ url, err }) {
    return { url, content: '', truncated: false, error: /** @type {{message?: string}|null|undefined} */ (err)?.message ?? String(err) };
}


/**
 * Whether the session provider takes the JAI engine: it is the JAI
 * backend, no Tavily config was given, and the mode is not explicitly
 * `tavily`.
 * @param {{provider?: string, config: {tavily?: unknown, mode?: string}}} arg0
 * @returns {boolean}
 */
export function preferJaiEngine({ provider, config }) {
    return provider === ProviderType.JAI && config.tavily == null && config.mode !== 'tavily';
}


/**
 * The provider ids with a native (vendor) leg for one capability flag —
 * `nativeWebSearch` or `nativeWebScrape`.
 * @param {{capability: string}} arg0
 * @returns {Set<string>}
 */
export function nativeProvidersFor({ capability }) {
    return new Set(Object.values(PROVIDERS).filter((d) => (/** @type {Record<string, boolean>} */ (d.capabilities))[capability]).map((d) => d.id));
}


/**
 * The POST-JSON prologue the Tavily engine legs share: undefined body keys are
 * dropped, the request carries `Content-Type: application/json` and the
 * caller's signal, a thrown `fetch` failure is wrapped with the provider hint,
 * and a non-2xx answer raises a `BackendError` whose message is
 * `"<label> (HTTP <status>)."`.
 * @param {{url: string, body: Record<string, unknown>, signal?: AbortSignal, provider: string, label: string}} arg0
 * @returns {Promise<unknown>}
 */
export async function postJson({ url, body, signal, provider, label }) {
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
        });
    } catch (err) {
        throw wrapError({ err, hints: { provider } });
    }
    if (!res.ok) {
        throw new BackendError({ message: `${label} (HTTP ${res.status}).`, options: { status: res.status, provider } });
    }
    return res.json();
}


/**
 * True when any domain policy was configured (so callers can skip the work).
 * @param {{allowedDomains?: Array<string>|null, blockedDomains?: Array<string>|null}} arg0
 * @returns {boolean}
 */
export function hasDomainPolicy({ allowedDomains, blockedDomains }) {
    return !!(allowedDomains?.length || blockedDomains?.length);
}


/**
 * Rewrites an IPv6 host that embeds an IPv4 address to its dotted quad:
 * `::ffff:7f00:1` (mapped), `0:0:0:0:0:ffff:7f00:1` (uncompressed),
 * `::ffff:127.0.0.1`, `::127.0.0.1` (IPv4-compatible) and
 * `::ffff:0:127.0.0.1` (SIIT). Any other host is returned unchanged, so a
 * public embedded address (`::ffff:808:808`) stays public.
 * @param {{host: string}} arg0
 * @returns {string}
 */
function normalizeIpv4Mapped({ host }) {
    if (isIP(host) !== 6) return host;
    const [head, tail] = host.split('::');
    /** @param {Array<string>} groups */
    const withDottedTail = (groups) => {
        const last = groups[groups.length - 1];
        if (!last?.includes('.')) return groups;
        const quad = last.split('.').map(Number);
        if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return groups;
        return [...groups.slice(0, -1), (((quad[0] << 8) | quad[1]).toString(16)), (((quad[2] << 8) | quad[3]).toString(16))];
    };
    const left = head ? head.split(':') : [];
    const right = withDottedTail(tail === undefined ? [] : (tail ? tail.split(':') : []));
    const groups = tail === undefined
        ? left
        : [...left, .../** @type {Array<string>} */ (Array(8 - left.length - right.length).fill('0')), ...right];
    if (groups.length !== 8) return host;
    const g = groups.map((group) => parseInt(group, 16));
    if (g.some((n) => !Number.isFinite(n))) return host;
    const firstFiveZero = g.slice(0, 5).every((n) => n === 0);
    const firstFourZero = g.slice(0, 4).every((n) => n === 0);
    // `::a.b.c.d` (compatible), `::ffff:a.b.c.d` (mapped), `::ffff:0:a.b.c.d` (SIIT).
    const embedsV4 = (firstFiveZero && (g[5] === 0 || g[5] === 0xffff))
        || (firstFourZero && g[4] === 0xffff && g[5] === 0);
    if (!embedsV4) return host;
    return `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
}


/**
 * Lowercased hostname of an http(s) URL, or null for an invalid/non-http URL.
 * Canonicalized like the URL parser's host: bracketed IPv6 loses its brackets
 * and a root-label trailing dot is stripped, so it compares against policy
 * entries in the same form. An IPv4-mapped IPv6 host is reduced to its embedded
 * dotted quad so `[::ffff:127.0.0.1]` and `127.0.0.1` are the same host.
 * @param {{url: string}} arg0
 * @returns {string|null}
 */
export function httpHost({ url }) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        // Credentials in a URL are never needed here, and a runtime `fetch` rejects
        // such a URL with a TypeError that echoes them (A-13). Refuse it at the
        // policy check so no request is built and no error can quote it.
        if (u.username || u.password) return null;
        let host = u.hostname.toLowerCase();
        if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
        if (host.endsWith('.')) host = host.slice(0, -1);
        return host ? normalizeIpv4Mapped({ host }) : null;
    } catch {
        return null;
    }
}


/**
 * Canonicalizes a policy domain the same way `httpHost` canonicalizes a URL
 * host (IDN → punycode, IPv6 brackets stripped, trailing dot removed,
 * IPv4-mapped IPv6 reduced to its dotted quad).
 * @param {{domain: string}} arg0
 * @returns {string}
 */
function canonicalDomain({ domain }) {
    const raw = String(domain).trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!raw) return '';
    let host;
    try {
        host = new URL(`http://${raw}`).hostname.toLowerCase();
    } catch {
        host = raw.replace(/^\./, '').replace(/\.$/, '');
        return normalizeIpv4Mapped({ host });
    }
    host = host.replace(/^\[|\]$/g, '');
    if (host.endsWith('.')) host = host.slice(0, -1);
    return normalizeIpv4Mapped({ host });
}


/**
 * Suffix match: `a.example.com` is in `example.com`; `notexample.com` is not.
 * Both sides are canonicalized, so a trailing dot, an IDN policy entry or a
 * bracketed IPv6 literal cannot slip past a blocklist.
 * @param {{host: string, domain: string}} arg0
 * @returns {boolean}
 */
export function hostMatchesDomain({ host, domain }) {
    const d = canonicalDomain({ domain });
    if (!d) return false;
    const h = canonicalDomain({ domain: host });
    return h === d || h.endsWith('.' + d);
}


/**
 * Every IPv4 range the SSRF policy refuses: unspecified, private, loopback,
 * link-local, shared CGNAT, documentation, benchmarking, multicast, reserved,
 * and the cloud metadata prefixes (192.0.0.0/24 is Oracle Cloud's metadata).
 * `net.BlockList` decides the containment, so a textual form cannot slip past.
 */
const BLOCKED_RANGES = new BlockList();
for (const [address, prefix] of /** @type {Array<[string, number]>} */ ([
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
])) BLOCKED_RANGES.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of /** @type {Array<[string, number]>} */ ([
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10],
    ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['64:ff9b::', 96],
])) BLOCKED_RANGES.addSubnet(address, prefix, 'ipv6');

/**
 * True when a canonicalized host (from `httpHost`) is loopback, link-local,
 * RFC1918 private, unspecified, a reserved range, or a cloud metadata endpoint.
 * An IPv4-mapped IPv6 address is classified as the IPv4 address it embeds; the
 * whole `::ffff:0:0/96` prefix is never blocked, so public mapped hosts pass.
 * @param {{host: string}} arg0
 * @returns {boolean}
 */
function isPrivateOrReservedHost({ host }) {
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal')) return true;
    const address = normalizeIpv4Mapped({ host });
    const family = isIP(address);
    if (family === 0) return false;
    return BLOCKED_RANGES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}


/**
 * A `dns.lookup`-shaped resolver. The default is `node:dns/promises`'s
 * `lookup`; tests inject a stub.
 * @typedef {(host: string, options: {all: true, verbatim: true}) => Promise<Array<{address: string, family?: number}|string>>} HostResolver
 */

/**
 * What a resolved URL yields: the address to pin, or the reason it was refused.
 * @typedef {{ok: true, host: string, address: string|null, family: number} | {ok: false, host: string|null, reason: string}} ResolvedHost
 */

/**
 * Resolves `url`'s hostname once and returns the address a request may pin.
 *
 * The literal-host guard (`isSafeHttpUrl`) cannot see DNS, so a hostname that
 * resolves to loopback or a private range slips through it. IP literals are
 * decided synchronously; a lookup failure or an empty answer fails closed.
 * `allowPrivateNetwork` skips the policy and returns `address: null`, so the
 * caller lets the runtime resolve normally.
 *
 * @param {{url: string, allowPrivateNetwork?: boolean, lookup?: HostResolver}} arg0
 * @returns {Promise<ResolvedHost>}
 */
export async function resolvePublicAddress({ url, allowPrivateNetwork = false, lookup = /** @type {HostResolver} */ (dnsLookup) }) {
    const host = httpHost({ url });
    if (host === null) return { ok: false, host: null, reason: 'invalid-url' };
    if (allowPrivateNetwork) return { ok: true, host, address: null, family: 0 };
    if (isIP(host) !== 0) {
        if (isPrivateOrReservedHost({ host })) return { ok: false, host, reason: 'private-address' };
        return { ok: true, host, address: host, family: isIP(host) };
    }
    /** @type {Array<{address: string, family?: number}|string>|null} */
    let answers = null;
    try {
        answers = await lookup(host, { all: true, verbatim: true });
    } catch {
        return { ok: false, host, reason: 'lookup-failed' };
    }
    if (!answers || answers.length === 0) return { ok: false, host, reason: 'no-answer' };
    /** @type {Array<{address: string, family: number}>} */
    const addresses = [];
    for (const entry of answers) {
        const address = typeof entry === 'string' ? entry : entry?.address;
        if (typeof address !== 'string' || address.length === 0) return { ok: false, host, reason: 'empty-answer' };
        if (isPrivateOrReservedHost({ host: normalizeIpv4Mapped({ host: address }) })) return { ok: false, host, reason: 'private-address' };
        addresses.push({ address, family: (typeof entry === 'string' ? isIP(entry) : (entry.family ?? isIP(entry.address))) || 4 });
    }
    return { ok: true, host, address: addresses[0].address, family: addresses[0].family };
}


/**
 * True when `url`'s hostname resolves only to public addresses.
 * @param {{url: string, allowPrivateNetwork?: boolean, lookup?: HostResolver}} arg0
 * @returns {Promise<boolean>}
 */
export async function resolvesToPublicHost({ url, allowPrivateNetwork = false, lookup = /** @type {HostResolver} */ (dnsLookup) }) {
    return (await resolvePublicAddress({ url, allowPrivateNetwork, lookup })).ok;
}


/**
 * A `net.connect`-shaped `lookup` that always returns the pinned address, so
 * the socket cannot resolve the name a second time.
 * @param {{address: string, family: number}} arg0
 * @returns {(hostname: string, options: any, callback: Function) => void}
 */
function pinnedLookup({ address, family }) {
    return (/** @type {string} */ hostname, /** @type {any} */ options, /** @type {Function} */ callback) => {
        let opts = options;
        let cb = callback;
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (opts?.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
    };
}


/**
 * A `fetch`-shaped GET over `node:http`/`node:https` that connects to a pinned
 * address while keeping the URL hostname for the Host header, SNI and
 * certificate validation. The returned object is the small surface the scrape
 * leg reads: `status`, `ok`, `url`, `headers.get`, `body` and `text()`.
 *
 * Redirects are not followed here; `fetchGuarded` walks them one hop at a time.
 * @param {{url: string, headers?: Record<string, string>, signal?: AbortSignal|null, address?: string|null, family?: number, request?: Function|null}} arg0
 * @returns {Promise<{status: number, ok: boolean, url: string, headers: {get: (name: string) => string|null}, body: ReadableStream<Uint8Array>, text: () => Promise<string>}>}
 */
export function pinnedFetch({ url, headers = {}, signal = null, address = null, family = 4, request = null }) {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const requestFn = request ?? (isHttps ? httpsRequest : httpRequest);
    return new Promise((resolve, reject) => {
        const req = requestFn(target, {
            method: 'GET',
            headers,
            ...(signal ? { signal } : {}),
            ...(address ? { lookup: pinnedLookup({ address, family }) } : {}),
            ...(isHttps ? { servername: target.hostname } : {}),
        }, (/** @type {import('node:http').IncomingMessage} */ res) => {
            const body = Readable.toWeb(res);
            const status = res.statusCode ?? 0;
            resolve({
                status,
                ok: status >= 200 && status < 300,
                url: target.href,
                headers: {
                    get: (/** @type {string} */ name) => {
                        const value = res.headers[String(name).toLowerCase()];
                        return Array.isArray(value) ? value.join(', ') : (value ?? null);
                    },
                },
                body,
                text: () => new Response(body).text(),
            });
        });
        req.on('error', reject);
        req.end();
    });
}


/**
 * Validates that `url` uses `http:` or `https:` and, unless
 * `allowPrivateNetwork === true`, does not target loopback, link-local,
 * private network, or cloud metadata hosts.
 * @param {{url: string, allowPrivateNetwork?: boolean}} arg0
 * @returns {boolean}
 */
export function isSafeHttpUrl({ url, allowPrivateNetwork = false }) {
    const host = httpHost({ url });
    if (host === null) return false;
    if (!allowPrivateNetwork && isPrivateOrReservedHost({ host })) return false;
    return true;
}


/**
 * Client-side domain policy for the tool legs (the native legs enforce it
 * vendor-side). A URL is permitted only when it is a safe http(s) URL, inside
 * the allowlist (when one is set), and outside the blocklist.
 * @param {{url: string, allowedDomains?: Array<string>, blockedDomains?: Array<string>, allowPrivateNetwork?: boolean}} arg0
 * @returns {boolean}
 */
export function urlPermitted({ url, allowedDomains = [], blockedDomains = [], allowPrivateNetwork = false }) {
    const host = httpHost({ url });
    if (host === null) return false;
    if (!isSafeHttpUrl({ url, allowPrivateNetwork })) return false;
    if (allowedDomains.length && !allowedDomains.some((domain) => hostMatchesDomain({ host, domain }))) return false;
    if (blockedDomains.some((domain) => hostMatchesDomain({ host, domain }))) return false;
    return true;
}


/**
 * Splits URLs into those the domain and SSRF policy permits and those it blocks.
 * @param {{urls: Array<string>, allowedDomains?: Array<string>|null, blockedDomains?: Array<string>|null, allowPrivateNetwork?: boolean}} arg0
 * @returns {{permitted: Array<string>, denied: Array<string>}}
 */
export function splitUrlsByDomainPolicy({ urls, allowedDomains, blockedDomains, allowPrivateNetwork = false }) {
    const allow = Array.isArray(allowedDomains) ? allowedDomains.filter(Boolean) : [];
    const block = Array.isArray(blockedDomains) ? blockedDomains.filter(Boolean) : [];
    /** @type {Array<string>} */ const permitted = [];
    /** @type {Array<string>} */ const denied = [];
    for (const url of urls) {
        (urlPermitted({ url, allowedDomains: allow, blockedDomains: block, allowPrivateNetwork }) ? permitted : denied).push(url);
    }
    return { permitted, denied };
}


/**
 * @param {{baseBlock: string, inject: WebInjectOptions|null|undefined}} arg0
 * @returns {string}
 */
export function renderWebContextBlock({ baseBlock, inject }) {
    if (!inject) return baseBlock;
    const lines = [baseBlock];
    if (inject.date || inject.time) {
        const format = typeof inject.date === 'object' && inject.date !== null ? inject.date.format : undefined;
        lines.push(`Today's date: ${formatPromptDate({
            locale: inject.locale,
            timezone: inject.timezone,
            format: format ?? 'full',
            includeTime: !!inject.time,
        })}.`);
    }
    if (inject.instructions) lines.push(String(inject.instructions));
    return lines.join('\n');
}


/**
 * @param {{inject: WebInjectOptions|null|undefined, label: string}} arg0
 * @returns {WebInjectOptions|null}
 */
export function normalizeInject({ inject, label }) {
    if (!inject) return null;
    const fmt = typeof inject.date === 'object' && inject.date !== null ? inject.date.format : undefined;
    if (fmt != null && fmt !== 'full' && fmt !== 'iso') {
        throw new ConfigurationError({ message: `${label}: unknown inject.date.format "${fmt}". Expected 'full' or 'iso'.`, options: { option: 'inject' } });
    }
    if (inject.locale != null || inject.timezone != null) {
        try {
            new Intl.DateTimeFormat(inject.locale ?? undefined, inject.timezone != null ? { timeZone: inject.timezone } : undefined);
        } catch (err) {
            throw new ConfigurationError({ message: `${label}: invalid inject locale/timezone — ${(/** @type {Error} */ (err))?.message ?? err}`, options: { option: 'inject' } });
        }
    }
    return inject;
}
