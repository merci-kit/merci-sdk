// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { WebScrapeComponent } from '../lib/agentic/webscrape/component.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { BackendError, ConfigurationError } from '../lib/core/errors.mjs';

/**
 * @param {{jsonBody: any, ok?: boolean, status?: number}} arg0
 */
function mockFetch({ jsonBody, ok = true, status = 200 }) {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok, status,
        headers: { get: () => 'application/json' },
        json: async () => jsonBody,
    }));
    return () => { global.fetch = orig; };
}

/** @param {any} emitter */
/** @param {{emitter: *}} arg0 */
/** @param {{emitter: *}} arg0 */
const events = ({ emitter }) => {
    /** @type {any[]} */
    const seen = [];
    for (const name of [EVENTS.WEB_SCRAPE.SCRAPE_START, EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS, EVENTS.WEB_SCRAPE.SCRAPE_ERROR]) {
        emitter.on(name, (/** @type {any} */ e) => seen.push({ name, e }));
    }
    return seen;
};

test('web_scrape tool exposes the unified name/description/parameters', () => {
    const comp = new WebScrapeComponent({ provider: 'openai', config: {} });
    const tool = /** @type {any} */ (comp.toWebScrapeTool());
    assert.equal(tool.name, 'web_scrape');
    assert.match(tool.description, /results/);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['format', 'maxChars', 'timeoutMs', 'url', 'urls']);
    assert.deepEqual(tool.parameters.properties.format.enum, ['text', 'markdown']);
    assert.equal(tool.parameters.properties.urls.type, 'array');
    assert.equal(tool.parameters.properties.urls.maxItems, 20);
    assert.deepEqual(tool.parameters.required, []);
});

test('fallback mode runs the Tavily engine and emits start/success', async () => {
    const restore = mockFetch({ jsonBody: { results: [{ url: 'https://example.com', raw_content: 'page body' }] } });
    try {
        const emitter = new EventEmitter();
        const seen = events({ emitter });
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'native_with_tavily_fallback', tavily: { apiKey: 'k' } },
            eventEmitter: emitter,
        });
        const { results, truncated } = JSON.parse(await comp.load({ url: 'https://example.com' }));
        assert.equal(results.length, 1);
        assert.equal(results[0].url, 'https://example.com');
        assert.equal(results[0].content, 'page body');
        assert.equal(truncated, false);
        assert.equal(seen[0].name, EVENTS.WEB_SCRAPE.SCRAPE_START);
        assert.equal(seen[1].name, EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS);
        assert.equal(seen[1].e.chars, 'page body'.length);
    } finally { restore(); }
});

test('component threads maxUses into the tavily engine (warning fires on tavily mode)', async () => {
    const restore = mockFetch({ jsonBody: { results: [{ url: 'https://example.com', raw_content: 'page body' }] } });
    try {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warned = [];
        emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warned.push(e));
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: 'k' }, maxUses: 5 },
            eventEmitter: emitter,
        });
        await comp.load({ url: 'https://example.com' });
        assert.equal(warned.length, 1);
        assert.equal(warned[0].parameter, 'maxUses');
    } finally { restore(); }
});

test('urls[] batch returns one result per URL', async () => {
    const restore = mockFetch({ jsonBody: { results: [
        { url: 'https://a.com', raw_content: 'AAA' },
        { url: 'https://b.com', raw_content: 'BBB' },
    ] } });
    try {
        const emitter = new EventEmitter();
        const seen = events({ emitter });
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: 'k' } },
            eventEmitter: emitter,
        });
        const { results, truncated } = JSON.parse(await comp.load({ urls: ['https://a.com', 'https://b.com'] }));
        assert.equal(results.length, 2);
        assert.equal(results[0].content, 'AAA');
        assert.equal(results[1].content, 'BBB');
        assert.equal(truncated, false);
        assert.equal(seen[0].name, EVENTS.WEB_SCRAPE.SCRAPE_START);
        assert.equal(seen.filter(e => e.name === EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS).length, results.length);
    } finally { restore(); }
});

test('over-limit urls slice to maxUrls and emit truncated + parameter warning', async () => {
    const restore = mockFetch({ jsonBody: { results: [
        { url: 'https://a.com', raw_content: 'AAA' },
        { url: 'https://b.com', raw_content: 'BBB' },
    ] } });
    try {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warned = [];
        emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warned.push(e));
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: 'k' }, maxUrls: 2 },
            eventEmitter: emitter,
        });
        const { results, truncated } = JSON.parse(await comp.load({ urls: ['https://a.com', 'https://b.com', 'https://c.com'] }));
        assert.equal(results.length, 2);
        assert.equal(truncated, true);
        assert.equal(warned.length, 1);
        assert.equal(warned[0].parameter, 'maxUrls');
    } finally { restore(); }
});

test('string urls is normalized to a single-URL batch', async () => {
    const restore = mockFetch({ jsonBody: { results: [{ url: 'https://example.com', raw_content: 'page body' }] } });
    try {
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: 'k' } },
        });
        const { results } = JSON.parse(await comp.load({ urls: 'https://example.com' }));
        assert.equal(results.length, 1);
        assert.equal(results[0].url, 'https://example.com');
    } finally { restore(); }
});

test('blank-only urls throw ConfigurationError', async () => {
    const comp = new WebScrapeComponent({ provider: 'openai', config: { mode: 'tavily', tavily: { apiKey: 'k' } } });
    await assert.rejects(() => comp.load({ urls: ['   ', '', '\t'] }), ConfigurationError);
});

test('invalid maxUrls falls back to the configured scrape cap', async () => {
    const restore = mockFetch({ jsonBody: { results: [
        { url: 'https://a.com', raw_content: 'AAA' },
        { url: 'https://b.com', raw_content: 'BBB' },
    ] } });
    try {
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: 'k' }, maxUrls: 0 },
        });
        const { results, truncated } = JSON.parse(await comp.load({ urls: ['https://a.com', 'https://b.com'] }));
        assert.equal(results.length, 2);
        assert.equal(truncated, false);
    } finally { restore(); }
});

test('empty input throws ConfigurationError', async () => {
    const comp = new WebScrapeComponent({ provider: 'openai', config: { mode: 'tavily', tavily: { apiKey: 'k' } } });
    await assert.rejects(() => comp.load({}), ConfigurationError);
});

test('curl fallback mode runs CurlEngine and emits start/success', async () => {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok: true, status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<p>curl body</p>',
    }));
    try {
        const emitter = new EventEmitter();
        const seen = events({ emitter });
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'native_with_curl_fallback', curl: { fetch: global.fetch } },
            eventEmitter: emitter,
        });
        const out = JSON.parse(await comp.load({ url: 'https://example.com' }));
        assert.equal(out.results[0].content, 'curl body');
        assert.equal(seen[1].name, EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS);
    } finally { global.fetch = orig; }
});

test('component threads format from config into the curl engine', async () => {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok: true, status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<h1>Hi</h1><p>body</p>',
    }));
    try {
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'native_with_curl_fallback', format: 'markdown', curl: { fetch: global.fetch } },
        });
        const out = JSON.parse(await comp.load({ url: 'https://example.com' }));
        assert.match(out.results[0].content, /^# Hi/);
    } finally { global.fetch = orig; }
});

test('error path emits web_scrape:error and rethrows', async () => {
    const restore = mockFetch({ jsonBody: {}, ok: false, status: 500 });
    try {
        const emitter = new EventEmitter();
        const seen = events({ emitter });
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: 'k' } },
            eventEmitter: emitter,
        });
        await assert.rejects(() => comp.load({ url: 'https://example.com' }), BackendError);
        assert.equal(seen[1].name, EVENTS.WEB_SCRAPE.SCRAPE_ERROR);
        assert.match(seen[1].e.error, /Tavily extract failed/);
    } finally { restore(); }
});

test('jai backend uses JaiScrapeEngine when no tavily config', async () => {
    let called = false;
    const taskApi = {
        /** @param {{taskId: *, parameters: *}} arg0 */
        async executeJson({ taskId, parameters }) {
            called = true;
            assert.equal(taskId, 'web-scrape');
            assert.equal(parameters.url, 'https://example.com');
            return { rawContent: 'jai body' };
        }
    };
    const comp = new WebScrapeComponent({
        provider: 'jai',
        config: { mode: 'native_with_tavily_fallback', tavily: null },
        taskApi,
    });
    const out = JSON.parse(await comp.load({ url: 'https://example.com' }));
    assert.ok(called);
    assert.equal(out.results[0].content, 'jai body');
});

test('explicit curl opts force CurlEngine even on jai', async () => {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok: true, status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<p>forced curl</p>',
    }));
    try {
        const comp = new WebScrapeComponent({
            provider: 'jai',
            config: { mode: 'native_with_tavily_fallback', curl: { fetch: global.fetch }, tavily: null },
        });
        const out = JSON.parse(await comp.load({ url: 'https://example.com' }));
        assert.equal(out.results[0].content, 'forced curl');
    } finally { global.fetch = orig; }
});

test('component threads config.timeoutMs into the curl engine as a signal', async () => {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ ((/** @type {any} */ url, /** @type {any} */ opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    }));
    // AbortSignal.timeout() is unref'd, so hold the loop open until it fires.
    const keepAlive = setTimeout(() => {}, 250);
    try {
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'native_with_curl_fallback', timeoutMs: 20, curl: { fetch: global.fetch } },
        });
        const out = JSON.parse(await comp.load({ url: 'https://example.com' }));
        assert.match(out.results[0].error, /timeout/i);
    } finally { clearTimeout(keepAlive); global.fetch = orig; }
});

test('pure native returns a JSON note instead of scraping', async () => {
    const comp = new WebScrapeComponent({ provider: 'anthropic', config: { mode: 'native' } });
    const out = JSON.parse(await comp.load({ url: 'https://example.com' }));
    assert.deepEqual(out.results, []);
    assert.equal(out.truncated, false);
    assert.match(out.note, /native/);
});