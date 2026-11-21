// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { EventEmitter } from 'node:events';
import { JaiEngine, TavilyEngine, resolveSearchMode, toUnified, normalizeCitations } from '../lib/agentic/websearch/engines.mjs';
import { BackendError } from '../lib/core/errors.mjs';

const TAVILY_URL = 'https://api.tavily.com/search';

/**
 * @param {{jsonBody: any, ok?: boolean, status?: number}} arg0
 */
function mockFetch({ jsonBody, ok = true, status = 200 }) {
    const orig = global.fetch;
    let lastArgs = /** @type {any} */ (null);
    global.fetch = /** @type {(input: any, init?: any) => Promise<any>} */ (async (url, opts) => {
        lastArgs = { url, opts };
        return {
            ok,
            status,
            json: async () => jsonBody,
            url,
            opts
        };
    });
    const restore = () => { global.fetch = orig; };
    return { restore, lastArgs: () => lastArgs };
}

/**
 * @param {{fetchArgs: any}} arg0
 */
function bodyOf({ fetchArgs }) {
    return JSON.parse(fetchArgs.opts.body);
}

test('TavilyEngine maps full-parity opts and normalizes to unified shape', async () => {
    const m = mockFetch({ jsonBody: {
        answer: 'the answer',
        results: [{ title: 'T', url: 'https://example.com', content: 'body' }]
    } });
    try {
        const out = await TavilyEngine.search({ query: 'query', opts: {
            apiKey: 'k',
            maxResults: 5,
            search_depth: 'advanced',
            topic: 'news',
            time_range: 'week',
            includeDomains: ['https://a.com'],
            excludeDomains: ['https://b.com'],
            includeAnswer: true,
            country: 'us',
            language: 'en'
        } });
        const body = bodyOf({ fetchArgs: m.lastArgs() });
        assert.equal(body.api_key, 'k');
        assert.equal(body.max_results, 5);
        assert.equal(body.search_depth, 'advanced');
        assert.equal(body.topic, 'news');
        assert.equal(body.time_range, 'week');
        assert.deepEqual(body.include_domains, ['https://a.com']);
        assert.deepEqual(body.exclude_domains, ['https://b.com']);
        assert.equal(body.include_answer, true);
        assert.equal(body.country, 'us');
        assert.equal(body.language, 'en');
        assert.equal((/** @type {any} */ (out)).answer, 'the answer');
        assert.deepEqual((/** @type {any} */ (out)).sources, [{ title: 'T', url: 'https://example.com' }]);
        assert.ok(!('_vendor' in out));
    } finally { m.restore(); }
});

test('TavilyEngine includes _vendor only when includeVendorMetadata', async () => {
    const m = mockFetch({ jsonBody: { answer: 'a', results: [{ title: 'T', url: 'u' }] } });
    try {
        const out = await TavilyEngine.search({ query: 'q', opts: { apiKey: 'k', includeVendorMetadata: true } });
        assert.ok((/** @type {any} */ (out))._vendor && (/** @type {any} */ (out))._vendor.answer === 'a');
    } finally { m.restore(); }
});

test('TavilyEngine throws typed BackendError on non-OK HTTP', async () => {
    const m = mockFetch({ jsonBody: { error: 'nope' }, ok: false, status: 401 });
    try {
        await assert.rejects(() => TavilyEngine.search({ query: 'q', opts: { apiKey: 'k' } }), BackendError);
    } finally { m.restore(); }
});

test('TavilyEngine throws BackendError when no API key', async () => {
    delete process.env.TAVILY_API_KEY;
    await assert.rejects(() => TavilyEngine.search({ query: 'q', opts: {} }), BackendError);
});

test('JaiEngine maps params, warns on unsupported opts, returns unified', async () => {
    const emitter = new EventEmitter();
    const warnings = /** @type {any[]} */ ([]);
    emitter.on('parameter_warning', (e) => warnings.push(e.parameter));
    const taskApi = {
        /** @param {{taskId: *, parameters: *, options: *}} arg0 */
        async executeJson({ taskId, parameters, options }) {
            assert.equal(taskId, 'web-search');
            assert.deepEqual(options, { version: 'v4' });
            assert.equal(parameters.query, 'q');
            assert.equal(parameters.maxResults, 3);
            assert.deepEqual(parameters.includeDomains, ['https://a.com']);
            return { answer: 'a', results: [{ title: 'T', url: 'u' }] };
        }
    };
    const out = await JaiEngine.search({ query: 'q', opts: {
        maxResults: 3,
        includeDomains: ['https://a.com'],
        blockedDomains: ['https://b.com'],
        topic: 'news',
        time_range: 'week',
        emitter
    }, taskApi });
    assert.deepEqual(warnings.sort(), ['blockedDomains', 'time_range', 'topic']);
    assert.equal((/** @type {any} */ (out)).answer, 'a');
    assert.deepEqual((/** @type {any} */ (out)).sources, [{ title: 'T', url: 'u' }]);
});

test('JaiEngine throws BackendError without taskApi', async () => {
    await assert.rejects(() => JaiEngine.search({ query: 'q', opts: {}, taskApi: null }), BackendError);
});

test('resolveSearchMode classifies backends and modes', () => {
    assert.equal(resolveSearchMode({ sessionProvider: 'anthropic', mode: 'native' }), 'native');
    assert.equal(resolveSearchMode({ sessionProvider: 'openai', mode: 'native' }), 'native');
    assert.equal(resolveSearchMode({ sessionProvider: 'jai', mode: 'native' }), 'tool');
    assert.equal(resolveSearchMode({ sessionProvider: 'opencode', mode: 'native' }), 'tool');
    assert.equal(resolveSearchMode({ sessionProvider: 'openai', mode: 'tool' }), 'tool');
    assert.equal(resolveSearchMode({ sessionProvider: 'openai', mode: 'off' }), 'off');
    assert.equal(resolveSearchMode({ sessionProvider: 'openai', mode: undefined }), 'off');
    assert.equal(resolveSearchMode({ sessionProvider: 'openai', mode: 'bogus' }), 'tool');
});

test('toUnified tolerates missing sources and non-array payloads', () => {
    assert.deepEqual(toUnified({ query: 'q', raw: {} }), { query: 'q', sources: [] });
    assert.deepEqual((/** @type {any} */ (toUnified({ query: 'q', raw: { answer: 'x' } }))).answer, 'x');
});
test('normalizeCitations maps and dedupes native citation objects', () => {
    assert.deepEqual(
        normalizeCitations({ citations: [
            { type: 'url_citation', url: 'https://a.com', title: 'A' },
            { url: 'https://a.com', title: 'A (dup)' },
            { uri: 'https://b.com', name: 'B' },
            /** @type {any} */ (null),
            { type: 'web_search_result' },
        ] }),
        [{ title: 'A', url: 'https://a.com' }, { title: 'B', url: 'https://b.com' }]
    );
    assert.deepEqual(normalizeCitations({ citations: /** @type {any} */ (undefined) }), []);
});
