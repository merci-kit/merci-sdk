// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { nativeProvidersFor, postJson, preferJaiEngine, toUrls, webItemError } from '../lib/agentic/web-shared.mjs';
import { BackendError } from '../lib/core/errors.mjs';

/**
 * A `fetch` stub that records the request and answers with a canned response.
 * @param {{body?: any, ok?: boolean, status?: number, throws?: Error|null}} arg0
 */
function stubFetch({ body = {}, ok = true, status = 200, throws = null } = {}) {
    const orig = global.fetch;
    /** @type {any} */
    let lastArgs = null;
    global.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
        lastArgs = { url, opts };
        if (throws) throw throws;
        return { ok, status, json: async () => body };
    }));
    return { restore: () => { global.fetch = orig; }, lastArgs: () => lastArgs };
}

test('toUrls normalizes string, array, mixed, empty and whitespace input', () => {
    assert.deepEqual(toUrls({ input: 'https://a.com' }), ['https://a.com']);
    assert.deepEqual(toUrls({ input: ['https://a.com', 'https://b.com'] }), ['https://a.com', 'https://b.com']);
    assert.deepEqual(toUrls({ input: ['https://a.com', 42, '', '   ', null, 'https://b.com'] }), ['https://a.com', 'https://b.com']);
    assert.deepEqual(toUrls({ input: undefined }), []);
    assert.deepEqual(toUrls({ input: null }), []);
    assert.deepEqual(toUrls({ input: '' }), []);
    assert.deepEqual(toUrls({ input: [] }), []);
    assert.deepEqual(toUrls({ input: [[ 'https://a.com' ]] }), []);
});

test('webItemError builds the empty per-URL failure item', () => {
    assert.deepEqual(webItemError({ url: 'https://a.com', err: new Error('boom') }), {
        url: 'https://a.com', content: '', truncated: false, error: 'boom',
    });
    assert.deepEqual(webItemError({ url: 'https://a.com', err: 'plain' }), {
        url: 'https://a.com', content: '', truncated: false, error: 'plain',
    });
    assert.deepEqual(webItemError({ url: 'https://a.com', err: null }), {
        url: 'https://a.com', content: '', truncated: false, error: 'null',
    });
});

test('preferJaiEngine: JAI without a Tavily config or an explicit tavily mode', () => {
    assert.equal(preferJaiEngine({ provider: 'jai', config: {} }), true);
    assert.equal(preferJaiEngine({ provider: 'jai', config: { mode: 'tool' } }), true);
    assert.equal(preferJaiEngine({ provider: 'jai', config: { mode: 'native' } }), true);
    assert.equal(preferJaiEngine({ provider: 'jai', config: { tavily: {} } }), false);
    assert.equal(preferJaiEngine({ provider: 'jai', config: { mode: 'tavily' } }), false);
    assert.equal(preferJaiEngine({ provider: 'anthropic', config: {} }), false);
    assert.equal(preferJaiEngine({ config: {} }), false);
});

test('nativeProvidersFor reads the capability flag off the provider registry', () => {
    assert.deepEqual([...nativeProvidersFor({ capability: 'nativeWebSearch' })].sort(), ['anthropic', 'google_genai', 'openai', 'openrouter', 'vertex']);
    assert.deepEqual([...nativeProvidersFor({ capability: 'nativeWebScrape' })].sort(), ['anthropic', 'google_genai', 'jai', 'openrouter', 'vertex']);
    assert.deepEqual([...nativeProvidersFor({ capability: 'nativeNothing' })], []);
});

test('postJson posts JSON, drops undefined keys, and returns the parsed body', async () => {
    const m = stubFetch({ body: { answer: 'a' } });
    try {
        const out = await postJson({ url: 'https://api.tavily.com/search', body: { api_key: 'k', query: 'q', missing: undefined }, signal: undefined, provider: 'tavily', label: 'Tavily search failed' });
        const { url, opts } = m.lastArgs();
        assert.equal(url, 'https://api.tavily.com/search');
        assert.equal(opts.method, 'POST');
        assert.equal(opts.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(opts.body), { api_key: 'k', query: 'q' });
        assert.deepEqual(out, { answer: 'a' });
    } finally { m.restore(); }
});

test('postJson forwards the caller signal', async () => {
    const m = stubFetch({ body: {} });
    try {
        const controller = new AbortController();
        await postJson({ url: 'https://api.tavily.com/x', body: {}, signal: controller.signal, provider: 'tavily', label: 'Tavily extract failed' });
        assert.equal(m.lastArgs().opts.signal, controller.signal);
    } finally { m.restore(); }
});

test('postJson raises a BackendError naming the label and status on a non-2xx answer', async () => {
    const search = stubFetch({ ok: false, status: 429 });
    try {
        await assert.rejects(
            () => postJson({ url: 'https://api.tavily.com/search', body: {}, provider: 'tavily', label: 'Tavily search failed' }),
            (/** @type {any} */ err) => {
                assert.ok(err instanceof BackendError);
                assert.equal(err.message, 'Tavily search failed (HTTP 429).');
                assert.equal(err.status, 429);
                assert.equal(err.provider, 'tavily');
                return true;
            }
        );
    } finally { search.restore(); }
    const extract = stubFetch({ ok: false, status: 500 });
    try {
        await assert.rejects(
            () => postJson({ url: 'https://api.tavily.com/extract', body: {}, provider: 'tavily', label: 'Tavily extract failed' }),
            /^BackendError: Tavily extract failed \(HTTP 500\)\.$/
        );
    } finally { extract.restore(); }
});

test('postJson wraps a thrown fetch failure with the provider hint', async () => {
    const m = stubFetch({ throws: new Error('network down') });
    try {
        await assert.rejects(
            () => postJson({ url: 'https://api.tavily.com/search', body: {}, provider: 'tavily', label: 'Tavily search failed' }),
            (/** @type {any} */ err) => {
                assert.equal(err.message, 'network down');
                assert.notEqual(err.name, 'BackendError');
                return true;
            }
        );
    } finally { m.restore(); }
});
