// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { EventEmitter } from 'node:events';
import { CurlEngine, JaiScrapeEngine, TavilyExtractEngine, resolveScrapeMode, toUnifiedScrape } from '../lib/agentic/webscrape/engines.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { BackendError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const MAX_SCRAPE_BYTES = 5 * 1024 * 1024;

/** A public DNS answer, so these tests never depend on real DNS. */
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

/** @param {{input: any, opts?: any}} arg0 */
const curlFetch = ({ input, opts = {} }) => CurlEngine.fetch.call(CurlEngine, { input, opts: { ...opts, lookup: PUBLIC_LOOKUP, fetch: global.fetch } });

/**
 * @param {{handler: any}} arg0
 * @returns {any}
 */
function mockFetch({ handler }) {
    const orig = global.fetch;
    /** @type {any} */
    let lastArgs = null;
    global.fetch = async (/** @type {any} */ url, /** @type {any} */ opts) => {
        lastArgs = { url, opts };
        return handler(url, opts);
    };
    const restore = () => { global.fetch = orig; };
    return { restore, lastArgs: () => lastArgs };
}

/**
 * @param {{body: any, ok?: *, status?: *, ctype?: *}} arg0
 */
function mockFetchBody({ body, ok = true, status = 200, ctype = 'text/html' }) {
    return mockFetch({ handler: async () => ({
        ok, status,
        headers: { get: () => ctype },
        text: async () => body,
        json: async () => body,
    }) });
}

test('resolveScrapeMode classifies modes across native-capable and tool-only backends', () => {
    const nativeProviders = ['anthropic', 'google_genai', 'vertex', 'openrouter', 'jai'];
    const toolOnly = ['openai', 'opencode', 'local'];
    for (const b of nativeProviders) assert.equal(resolveScrapeMode({ sessionProvider: b, mode: 'native' }), 'native', `${b} native`);
    for (const b of toolOnly) assert.equal(resolveScrapeMode({ sessionProvider: b, mode: 'native' }), 'tool', `${b} native`);

    const toolModes = ['tavily', 'curl', 'tool', 'native_with_tavily_fallback', 'native_with_curl_fallback'];
    for (const b of [...nativeProviders, ...toolOnly]) {
        for (const m of toolModes) assert.equal(resolveScrapeMode({ sessionProvider: b, mode: m }), 'tool', `${b}/${m}`);
        assert.equal(resolveScrapeMode({ sessionProvider: b, mode: 'off' }), 'off', `${b}/off`);
        assert.equal(resolveScrapeMode({ sessionProvider: b, mode: undefined }), 'off', `${b}/undefined`);
        assert.equal(resolveScrapeMode({ sessionProvider: b, mode: 'bogus' }), 'tool', `${b}/bogus`);
    }
});

test('the scrape cap sets the 20-URL ceiling', () => {
    assert.equal(LIMITS.scrape_max_urls, 20);
});

test('toUnifiedScrape picks content, then rawContent, then text', () => {
    assert.equal((/** @type {any} */ (toUnifiedScrape({ url: 'u', raw: { content: 'a', rawContent: 'b', text: 'c' } }))).content, 'a');
    assert.equal((/** @type {any} */ (toUnifiedScrape({ url: 'u', raw: { rawContent: 'b' } }))).content, 'b');
    assert.equal((/** @type {any} */ (toUnifiedScrape({ url: 'u', raw: { text: 'c' } }))).content, 'c');
    assert.equal((/** @type {any} */ (toUnifiedScrape({ url: 'u', raw: {} }))).content, '');
    assert.deepEqual(toUnifiedScrape({ url: 'u', raw: { content: 'a' } }), { url: 'u', content: 'a', truncated: false });
    assert.ok((/** @type {any} */ (toUnifiedScrape({ url: 'u', raw: { content: 'a' }, includeVendorMetadata: true })))._vendor.content === 'a');
    assert.equal((/** @type {any} */ (toUnifiedScrape({ url: 'u', raw: { content: '', error: 'boom' } }))).error, 'boom');
    assert.ok(!('error' in toUnifiedScrape({ url: 'u', raw: { content: 'a' } })));
});

test('TavilyExtractEngine posts to /extract with urls:[url] and unifies raw_content', async () => {
    const m = mockFetchBody({ body: { results: [{ url: 'https://example.com', raw_content: 'page body' }] } });
    try {
        const [out] = /** @type {any[]} */ (await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', extractDepth: 'advanced' } }));
        const { url, opts } = m.lastArgs();
        assert.equal(url, 'https://api.tavily.com/extract');
        const body = JSON.parse(opts.body);
        assert.equal(body.api_key, 'k');
        assert.deepEqual(body.urls, ['https://example.com']);
        assert.equal(body.extract_depth, 'advanced');
        assert.equal(out.content, 'page body');
        assert.equal(out.truncated, false);
    } finally { m.restore(); }
});

test('TavilyExtractEngine passes format through the POST body (and omits it when unset)', async () => {
    const m = mockFetchBody({ body: { results: [{ url: 'https://example.com', raw_content: 'x' }] } });
    try {
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', format: 'markdown' } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).format, 'markdown');
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k' } });
        assert.ok(!('format' in JSON.parse(m.lastArgs().opts.body)));
    } finally { m.restore(); }
});

test('TavilyExtractEngine batch: one POST, maps results back per URL, missing URL becomes an error item', async () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    const m = mockFetchBody({ body: { results: [
        { url: 'https://a.com', raw_content: 'AAA' },
        { url: 'https://c.com', raw_content: 'CCC' },
    ] } });
    try {
        const out = /** @type {any[]} */ (await TavilyExtractEngine.extract({ input: urls, opts: { apiKey: 'k' } }));
        assert.deepEqual(JSON.parse(m.lastArgs().opts.body).urls, urls);
        assert.equal(out.length, 3);
        assert.equal(out[0].content, 'AAA');
        assert.equal(out[1].error, 'Tavily returned no result for this URL.');
        assert.equal(out[1].content, '');
        assert.equal(out[2].content, 'CCC');
    } finally { m.restore(); }
});

test('TavilyExtractEngine throws typed BackendError without an API key', async () => {
    delete process.env.TAVILY_API_KEY;
    await assert.rejects(() => TavilyExtractEngine.extract({ input: 'https://example.com', opts: {} }), BackendError);
});

test('TavilyExtractEngine throws BackendError on non-OK HTTP', async () => {
    const m = mockFetchBody({ body: { error: 'nope' }, ok: false, status: 429 });
    try {
        await assert.rejects(() => TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k' } }), BackendError);
    } finally { m.restore(); }
});

test('JaiScrapeEngine calls executeJson("web-scrape", { url }, { version: "v4" })', async () => {
    const taskApi = {
        /** @param {{taskId: *, parameters: *, options: *}} arg0 */
        async executeJson({ taskId, parameters, options }) {
            assert.equal(taskId, 'web-scrape');
            assert.deepEqual(options, { version: 'v4' });
            assert.equal(parameters.url, 'https://example.com');
            assert.equal(parameters.maxChars, 500);
            return { rawContent: 'jai body' };
        }
    };
    const out = /** @type {any[]} */ (await JaiScrapeEngine.scrape({ input: 'https://example.com', opts: { maxChars: 500 }, taskApi }));
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'jai body');
    assert.equal(out[0].truncated, false);
});

test('JaiScrapeEngine batch: sequential loop, per-item try/catch yields error items', async () => {
    /** @type {any[]} */
    const calls = [];
    const taskApi = {
        /** @param {{parameters: *}} arg0 */
        async executeJson({ parameters }) {
            calls.push(parameters.url);
            if (parameters.url === 'https://fail.com') throw new Error('boom');
            return { rawContent: `body:${parameters.url}` };
        }
    };
    const out = /** @type {any[]} */ (await JaiScrapeEngine.scrape({ input: ['https://a.com', 'https://fail.com', 'https://b.com'], opts: {}, taskApi }));
    assert.deepEqual(calls, ['https://a.com', 'https://fail.com', 'https://b.com']);
    assert.equal(out.length, 3);
    assert.equal(out[0].content, 'body:https://a.com');
    assert.equal(out[1].error, 'boom');
    assert.equal(out[2].content, 'body:https://b.com');
});

test('JaiScrapeEngine throws BackendError without taskApi', async () => {
    await assert.rejects(() => JaiScrapeEngine.scrape({ input: 'https://example.com', opts: {}, taskApi: null }), BackendError);
});

test('CurlEngine strips markup and decodes entities', async () => {
    const html = '<html><head><style>.a{}</style><script>var x=1</script></head>' +
        '<body><p>Hello&nbsp;&amp;&lt;World&gt;</p></body></html>';
    const m = mockFetchBody({ body: html });
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com' }));
        assert.equal(out.content, 'Hello &<World>');
        assert.equal(out.truncated, false);
    } finally { m.restore(); }
});

test('CurlEngine default text path is byte-identical to today', async () => {
    const html = '<h1>Hi</h1><p><a href="https://x.com">link</a> &amp; <strong>bold</strong></p>';
    const m = mockFetchBody({ body: html });
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com' }));
        assert.equal(out.content, 'Hi link & bold');
    } finally { m.restore(); }
});

test('CurlEngine markdown converts headings/links/lists/code and decodes entities', async () => {
    const html = '<h1>Title</h1><p>Hello&nbsp;&amp;<strong>bold</strong> and <em>it</em></p>' +
        '<a href="https://x.com">link</a>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<pre>const a = 1;</pre>' +
        '<img src="https://x.com/i.png" alt="pic">';
    const m = mockFetchBody({ body: html });
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com', opts: { format: 'markdown' } }));
        assert.match(out.content, /^# Title/);
        assert.match(out.content, /Hello &\*\*bold\*\* and \*it\*/);
        assert.match(out.content, /\[link\]\(https:\/\/x\.com\)/);        assert.match(out.content, /- one/);
        assert.match(out.content, /- two/);
        assert.match(out.content, /```\s*const a = 1;\s*```/);
        assert.match(out.content, /!\[pic\]\(https:\/\/x\.com\/i\.png\)/);
    } finally { m.restore(); }
});

test('CurlEngine truncates to maxChars and marks truncated', async () => {
    const m = mockFetchBody({ body: '<p>' + 'x'.repeat(200) + '</p>' });
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com', opts: { maxChars: 10 } }));
        assert.equal(out.content, 'x'.repeat(10));
        assert.equal(out.truncated, true);
    } finally { m.restore(); }
});

test('CurlEngine caps oversized payloads at 5MB', async () => {
    const big = 'x'.repeat(MAX_SCRAPE_BYTES + 1);
    const m = mockFetchBody({ body: big });
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com' }));
        assert.equal(out.content.length, MAX_SCRAPE_BYTES);
        assert.equal(out.truncated, true);
    } finally { m.restore(); }
});

test('CurlEngine rejects non-text content-types as per-item errors, never throws the batch', async () => {
    for (const ctype of ['application/octet-stream', 'image/png', 'application/pdf']) {
        const m = mockFetchBody({ body: 'binary', ctype });
        try {
            const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com' }));
            assert.match(out.error, /non-text content-type/, ctype);
        } finally { m.restore(); }
    }
    const m = mockFetchBody({ body: '{}', ctype: 'application/json' });
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com' }));
        assert.ok(!('error' in out));
    } finally { m.restore(); }
});

test('CurlEngine honours timeoutMs by passing an aborting signal', async () => {
    const m = mockFetch({ handler: (/** @type {any} */ url, /** @type {any} */ opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    }) });
    // AbortSignal.timeout() is unref'd, so without another handle node 22 drains
    // the loop before the abort can fire and the test runner cancels the file.
    const keepAlive = setTimeout(() => {}, 250);
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com', opts: { timeoutMs: 20 } }));
        assert.match(out.error, /timeout/i);
    } finally { clearTimeout(keepAlive); m.restore(); }
});

test('TavilyExtractEngine maps timeoutMs to body timeout seconds (clamped 1..60)', async () => {
    const m = mockFetchBody({ body: { results: [{ url: 'https://example.com', raw_content: 'x' }] } });
    try {
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', timeoutMs: 1500 } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).timeout, 1.5);
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', timeoutMs: 100000 } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).timeout, 60);
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', timeoutMs: 500 } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).timeout, 1);
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k' } });
        assert.ok(!('timeout' in JSON.parse(m.lastArgs().opts.body)));
    } finally { m.restore(); }
});

test('TavilyExtractEngine clamps legacy opts.timeout to the same 1..60 range', async () => {
    const m = mockFetchBody({ body: { results: [{ url: 'https://example.com', raw_content: 'x' }] } });
    try {
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', timeout: 500 } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).timeout, 60);
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', timeout: 0.5 } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).timeout, 1);
        await TavilyExtractEngine.extract({ input: 'https://example.com', opts: { apiKey: 'k', timeout: 5 } });
        assert.equal(JSON.parse(m.lastArgs().opts.body).timeout, 5);
    } finally { m.restore(); }
});

test('JaiScrapeEngine warns and skips timeoutMs (executeJson takes no signal)', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const warned = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (e) => warned.push(e));
    const taskApi = {
        async executeJson(/** @type {any} */ id, /** @type {any} */ params) { return { rawContent: 'jai body' }; }
    };
    const out = /** @type {any[]} */ (await JaiScrapeEngine.scrape({ input: 'https://example.com', opts: { timeoutMs: 2000, emitter }, taskApi }));
    assert.equal(out[0].content, 'jai body');
    assert.equal(warned.length, 1);
    assert.equal(warned[0].parameter, 'timeoutMs');
});

test('CurlEngine batch: allSettled — a rejected URL becomes an error item, the batch never throws', async () => {
    const m = mockFetch({ handler: async (/** @type {any} */ url) => {
        if (url === 'https://fail.com') throw new Error('network down');
        return {
            ok: true, status: 200,
            headers: { get: () => 'text/html' },
            text: async () => `<p>${url}</p>`,
            json: async () => ({}),
        };
    } });
    try {
        const out = /** @type {any[]} */ (await curlFetch({ input: ['https://a.com', 'https://fail.com', 'https://b.com'] }));
        assert.equal(out.length, 3);
        assert.equal(out[0].content, 'https://a.com');
        assert.equal(out[1].error, 'network down');
        assert.equal(out[2].content, 'https://b.com');
    } finally { m.restore(); }
});