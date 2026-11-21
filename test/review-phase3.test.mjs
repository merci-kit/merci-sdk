// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebScrapeComponent } from '../lib/agentic/webscrape/component.mjs';
import { WebSearchComponent } from '../lib/agentic/websearch/component.mjs';
import { BrowserComponent } from '../lib/agentic/browser/component.mjs';

/** A public DNS answer, so these tests never depend on real DNS. */
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

/** @param {{input: any, opts?: any}} arg0 */
const curlFetch = ({ input, opts = {} }) => CurlEngine.fetch.call(CurlEngine, { input, opts: { ...opts, lookup: PUBLIC_LOOKUP, fetch: global.fetch } });
import { CurlEngine, JaiScrapeEngine } from '../lib/agentic/webscrape/engines.mjs';
import { JaiEngine } from '../lib/agentic/websearch/engines.mjs';
import { hostMatchesDomain, urlPermitted } from '../lib/agentic/web-shared.mjs';
import { loadSkillsFromDirectory } from '../lib/tools/skills.mjs';
import { loadA2ATool } from '../lib/tools/a2a.mjs';
import { InternalHttpClient } from '../lib/backends/jai-vendor/http-client.mjs';

/** @returns {{ rec: { signal: AbortSignal|null }, restore: () => void }} */
function hangingFetch() {
    const orig = global.fetch;
    const rec = { signal: /** @type {AbortSignal|null} */ (null) };
    global.fetch = /** @type {any} */ ((/** @type {any} */ url, /** @type {any} */ opts) => {
        rec.signal = opts?.signal ?? null;
        return new Promise((_, reject) => { opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason)); });
    });
    return { rec, restore: () => { global.fetch = orig; } };
}

/** @returns {{ lastArgs: () => { url: string, opts: any }, restore: () => void }} */
function mockFetch() {
    const orig = global.fetch;
    /** @type {any} */
    let last = null;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
        last = { url: String(url), opts };
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>ok</p>' };
    });
    return { lastArgs: () => last, restore: () => { global.fetch = orig; } };
}

test('P3-1 the web_scrape tool forwards the caller abort signal into fetch', { timeout: 2500 }, async () => {
    const { rec, restore } = hangingFetch();
    try {
        const comp = new WebScrapeComponent({ provider: 'openai', config: { mode: 'curl', curl: { lookup: PUBLIC_LOOKUP, fetch: global.fetch } } });
        const ac = new AbortController();
        const p = (/** @type {any} */ (comp.toWebScrapeTool())).execute({ args: { url: 'https://example.com' }, signal: ac.signal });
        setTimeout(() => ac.abort(new Error('cancelled-by-test')), 20);
        const parsed = JSON.parse(await p);
        assert.equal(rec.signal?.aborted, true, 'fetch must receive the caller signal and see the abort');
        assert.match(parsed.results[0].error, /cancelled-by-test/);
    } finally { restore(); }
});

test('P3-1 the web_search tool forwards the caller abort signal into fetch', { timeout: 2500 }, async () => {
    const { rec, restore } = hangingFetch();
    try {
        const comp = new WebSearchComponent({ provider: 'openai', config: { mode: 'tavily', tavily: { apiKey: 'k' } } });
        const ac = new AbortController();
        const p = (/** @type {any} */ (comp.toWebSearchTool())).execute({ args: { query: 'x' }, signal: ac.signal });
        setTimeout(() => ac.abort(new Error('cancelled-by-test')), 20);
        await assert.rejects(p, /cancelled-by-test/);
        assert.equal(rec.signal?.aborted, true);
    } finally { restore(); }
});

test('P3-1 the browser tool forwards the caller abort signal into fetch', { timeout: 2500 }, async () => {
    const { rec, restore } = hangingFetch();
    try {
        const comp = new BrowserComponent({ provider: 'openai', config: { mode: 'curl', curl: { fetch: global.fetch } } });
        const ac = new AbortController();
        const p = (/** @type {any} */ (comp.toBrowserTool())).execute({ args: { url: 'https://93.184.216.34/' }, signal: ac.signal });
        setTimeout(() => ac.abort(new Error('cancelled-by-test')), 20);
        const parsed = JSON.parse(await p);
        assert.equal(rec.signal?.aborted, true);
        assert.match(parsed.results[0].error, /cancelled-by-test/);
    } finally { restore(); }
});

test('P3-2 web_scrape enforces the allowedDomains policy client-side', async () => {
    const fetched = /** @type {string[]} */ ([]);
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url) => { fetched.push(String(url)); return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>ok</p>' }; });
    try {
        const comp = new WebScrapeComponent({ provider: 'openai', config: { mode: 'curl', allowedDomains: ['example.com'], curl: { lookup: PUBLIC_LOOKUP, fetch: global.fetch } } });
        const parsed = JSON.parse(await (/** @type {any} */ (comp.toWebScrapeTool())).execute({ args: { urls: ['https://example.com/a', 'https://evil.com/b'] } }));
        assert.deepEqual(fetched, ['https://example.com/a'], 'a non-allowlisted host must never be fetched');
        assert.equal(parsed.results.length, 2, 'the batch keeps one entry per requested URL');
        assert.match(parsed.results[1].error, /domain policy/i);
    } finally { global.fetch = orig; }
});

test('P3-2 web_scrape enforces blockedDomains client-side', async () => {
    const fetched = /** @type {string[]} */ ([]);
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url) => { fetched.push(String(url)); return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>ok</p>' }; });
    try {
        const comp = new WebScrapeComponent({ provider: 'openai', config: { mode: 'curl', blockedDomains: ['evil.com'], curl: { lookup: PUBLIC_LOOKUP, fetch: global.fetch } } });
        const parsed = JSON.parse(await (/** @type {any} */ (comp.toWebScrapeTool())).execute({ args: { urls: ['https://ok.com/a', 'https://evil.com/b'] } }));
        assert.deepEqual(fetched, ['https://ok.com/a']);
        assert.match(parsed.results[1].error, /domain policy/i);
    } finally { global.fetch = orig; }
});

test('P3-2 the curl engine refuses to follow redirects once a domain policy is set', async () => {
    const m = mockFetch();
    try {
        await curlFetch({ input: 'https://example.com', opts: { allowedDomains: ['example.com'], lookup: PUBLIC_LOOKUP } });
        assert.equal(m.lastArgs().opts.redirect, 'error', 'a redirect could leave the allowlist (SSRF bypass)');
        await curlFetch({ input: 'https://example.com', opts: { lookup: PUBLIC_LOOKUP } });
        assert.equal(m.lastArgs().opts.redirect, 'manual', 'no policy → the engine follows a hop only after checking it');
    } finally { m.restore(); }
});

test('P3-3 skills run a named script under its real interpreter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-skill-'));
    try {
        const skillDir = join(dir, 'cjs-skill');
        mkdirSync(join(skillDir, 'scripts'), { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: cjs-skill\n---\nRuns a Node script.\n');
        writeFileSync(join(skillDir, 'scripts', '000-notes.txt'), 'NOT A SCRIPT\n');
        writeFileSync(join(skillDir, 'scripts', 'run.cjs'), 'console.log("CJS-OK " + (process.argv[2] || ""));');

        const tools = await loadSkillsFromDirectory({ directory: dir });
        assert.equal(tools.length, 1);
        const listing = String(await tools[0].execute({ args: {} }));
        assert.doesNotMatch(listing, /CJS-OK/, 'reading the skill runs nothing');
        assert.match(listing, /run\.cjs/, 'the instructions name the only runnable script');
        const out = await tools[0].execute({ args: { script: 'run.cjs', n: 1 } });
        assert.match(String(out), /CJS-OK/, 'a .cjs script must run under node, not bash');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P3-4 the A2A body cap rejects before buffering an oversized body', async () => {
    const orig = global.fetch;
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    global.fetch = /** @type {any} */ (async () => new Response(new ReadableStream({
        pull(controller) {
            if (sent >= 64 * 1024 * 1024) { controller.close(); return; }
            controller.enqueue(chunk);
            sent += chunk.byteLength;
        }
    }), { status: 200 }));
    try {
        const tools = await loadA2ATool({ agentUrl: 'https://agent.example.com' });
        assert.deepEqual(tools, [], 'an oversized card degrades to no tools');
        assert.ok(sent <= 16 * 1024 * 1024, `must stop near the cap, pulled ${sent} bytes`);
    } finally { global.fetch = orig; }
});

test('P3-5 the JAI body timer is cleared once the body has been delivered', async () => {
    const orig = global.fetch;
    let aborted = false;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":1}')); c.close(); } });
        opts.signal.addEventListener('abort', () => { aborted = true; });
        return new Response(body, { status: 200 });
    });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        const res = await c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET', bodyTimeoutMs: 30 } });
        assert.deepEqual(await res.json(), { ok: 1 });
        await new Promise((r) => setTimeout(r, 90));
        assert.equal(aborted, false, 'the timer must not fire after a completed body read');
    } finally { global.fetch = orig; }
});

test('P3-2 host matching canonicalizes trailing dots, IDN and IPv6 literals', () => {
    assert.equal(hostMatchesDomain({ host: 'example.com.', domain: 'example.com' }), true, 'a root-label dot must not bypass a blocklist');
    assert.equal(hostMatchesDomain({ host: 'example.com', domain: 'example.com.' }), true);
    assert.equal(hostMatchesDomain({ host: 'a.example.com', domain: 'example.com' }), true);
    assert.equal(hostMatchesDomain({ host: 'notexample.com', domain: 'example.com' }), false);
    assert.equal(hostMatchesDomain({ host: 'example.com.evil.com', domain: 'example.com' }), false);
    assert.equal(urlPermitted({ url: 'http://example.com./', allowedDomains: [], blockedDomains: ['example.com'] }), false);
    assert.equal(urlPermitted({ url: 'https://\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444/', allowedDomains: [], blockedDomains: ['\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444'] }), false, 'IDN policy vs punycode host');
    assert.equal(urlPermitted({ url: 'http://[::1]:8080/', allowedDomains: [], blockedDomains: ['::1'] }), false, 'bracketed IPv6 host');
    assert.equal(urlPermitted({ url: 'https://example.com/', allowedDomains: ['example.com'], blockedDomains: [] }), true);
});

test('P3-2 a trailing-dot host is refused by the curl engine policy', async () => {
    const fetched = /** @type {string[]} */ ([]);
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url) => { fetched.push(String(url)); return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>ok</p>' }; });
    try {
        const out = await curlFetch({ input: 'http://example.com./', opts: { blockedDomains: ['example.com'], lookup: PUBLIC_LOOKUP } });
        assert.deepEqual(fetched, [], 'a blocked trailing-dot host must never be fetched');
        assert.match((/** @type {any} */ (out[0])).error, /domain policy/i);
    } finally { global.fetch = orig; }
});

test('P3-1 the JAI task legs forward the abort signal into executeJson', async () => {
    /** @type {Array<Record<string, any>>} */
    const seen = [];
    const taskApi = { /** @param {{options: any}} arg0 */ async executeJson(/** @type {{options: any}} */ { options }) { seen.push(options); return { rawContent: 'x' }; } };
    const ac = new AbortController();
    await JaiScrapeEngine.scrape({ input: 'https://a.com', opts: { signal: ac.signal }, taskApi });
    await JaiEngine.search({ query: 'q', opts: { signal: ac.signal }, taskApi });
    assert.equal(seen[0].signal, ac.signal, 'scrape must pass the caller signal');
    assert.equal(seen[1].signal, ac.signal, 'search must pass the caller signal');
    await JaiEngine.search({ query: 'q', opts: {}, taskApi });
    assert.deepEqual(seen[2], { version: 'v4' }, 'no signal → the options shape is unchanged');
});

test('P3-1/2 an explicit browser navigate is policy-checked and honours a pre-aborted signal', async () => {
    const comp = new BrowserComponent({ provider: 'openai', config: { mode: 'obscura', allowedDomains: ['example.com'], obscura: { run: async () => { throw new Error('must not run'); } } } });
    await assert.rejects((/** @type {any} */ (comp.toBrowserTool())).execute({ args: { action: 'navigate', url: 'http://evil.com/pwn' } }), /domain policy/);

    const comp2 = new BrowserComponent({ provider: 'openai', config: { mode: 'obscura', obscura: { run: async () => { throw new Error('must not run'); } } } });
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await assert.rejects(
        (/** @type {any} */ (comp2.toBrowserTool())).execute({ args: { action: 'navigate', url: 'http://ok.com/' }, signal: ac.signal }),
        (/** @type {any} */ e) => e.name === 'AbortedError',
        'a pre-aborted signal must stop an explicit navigate'
    );
    await assert.rejects(
        (/** @type {any} */ (comp2.toBrowserTool())).execute({ args: { action: 'click', selector: '#x' }, signal: ac.signal }),
        (/** @type {any} */ e) => e.name === 'AbortedError',
        'a pre-aborted signal must stop an interactive action'
    );
});

test('P3-2 an IPv4-mapped IPv6 host cannot bypass the domain policy', () => {
    assert.equal(hostMatchesDomain({ host: '::ffff:7f00:1', domain: '127.0.0.1' }), true, 'WHATWG canonicalizes [::ffff:127.0.0.1] to ::ffff:7f00:1');
    assert.equal(urlPermitted({ url: 'http://[::ffff:127.0.0.1]:8080/', allowedDomains: [], blockedDomains: ['127.0.0.1'] }), false);
    assert.equal(urlPermitted({ url: 'http://[0:0:0:0:0:ffff:127.0.0.1]/', allowedDomains: [], blockedDomains: ['127.0.0.1'] }), false);
    assert.equal(urlPermitted({ url: 'http://127.0.0.1/', allowedDomains: [], blockedDomains: ['::ffff:127.0.0.1'] }), false, 'a mapped-form policy entry still blocks the dotted host');
});

test('P3-2 the obscura read leg falls back to the guarded curl engine under a policy', async () => {
    const orig = global.fetch;
    const fetched = /** @type {string[]} */ ([]);
    let obscuraRan = false;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url) => { fetched.push(String(url)); return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>ok</p>' }; });
    try {
        const comp = new BrowserComponent({ provider: 'openai', config: { mode: 'obscura', allowedDomains: ['93.184.216.34'], obscura: { run: async () => { obscuraRan = true; return 'OBSCURA'; } }, curl: { fetch: global.fetch } } });
        const parsed = JSON.parse(await (/** @type {any} */ (comp.toBrowserTool())).execute({ args: { urls: ['https://93.184.216.34/'] } }));
        assert.equal(obscuraRan, false, 'obscura follows redirects and cannot honor the policy');
        assert.deepEqual(fetched, ['https://93.184.216.34/'], 'the guarded curl engine performs the read');
        assert.match(parsed.results[0].content, /ok/);
    } finally { global.fetch = orig; }
});

test('P3-2 an explicit navigate that redirects off-policy is refused', async () => {
    const comp = new BrowserComponent({ provider: 'openai', config: { mode: 'obscura', allowedDomains: ['93.184.216.34'], obscura: { run: async () => 'X' } } });
    (/** @type {any} */ (comp))._pw = { act: async () => ({ url: 'https://evil.example/final', title: 'T' }) };
    await assert.rejects(
        (/** @type {any} */ (comp.toBrowserTool())).execute({ args: { action: 'navigate', url: 'https://93.184.216.34/' } }),
        /domain policy/
    );
});
