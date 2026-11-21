// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { WebScrapeComponent } from '../lib/agentic/webscrape/component.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const FAKE_KEY = 'tvly-REGRESSION-SECRET-abc123';

/**
 * @param {{response: any}} arg0
 */
function stubFetch({ response }) {
    const orig = global.fetch;
    global.fetch = async () => response;
    return () => { global.fetch = orig; };
}

/**
 * @param {{emitter: any}} arg0
 */
function capture({ emitter }) {
    /** @type {any[]} */
    const payloads = [];
    for (const name of [
        EVENTS.WEB_SCRAPE.SCRAPE_START,
        EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS,
        EVENTS.WEB_SCRAPE.SCRAPE_ERROR,
        EVENTS.CLIENT.PARAMETER_WARNING,
    ]) {
        emitter.on(name, (/** @type {any} */ e) => payloads.push(JSON.stringify(e)));
    }
    return payloads;
}

/** @param {{payloads: any[], label: string}} arg0 */
function assertNoKey({ payloads, label }) {
    for (const p of payloads) assert.ok(!p.includes(FAKE_KEY), `${label} leaked the API key: ${p}`);
}

test('Tavily scrape success emits no API key in any payload', async () => {
    const restore = stubFetch({ response: {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ results: [{ url: 'https://example.com', raw_content: 'page body' }] }),
    } });
    try {
        const emitter = new EventEmitter();
        const payloads = capture({ emitter });
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: FAKE_KEY }, format: 'markdown' },
            eventEmitter: emitter,
        });
        await comp.load({ url: 'https://example.com' });
        assertNoKey({ payloads, label: 'Tavily success' });
    } finally { restore(); }
});

test('Tavily scrape error leaks no API key in the error payload or thrown message', async () => {
    const restore = stubFetch({ response: {
        ok: false, status: 429,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'nope' }),
    } });
    try {
        const emitter = new EventEmitter();
        const payloads = capture({ emitter });
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', tavily: { apiKey: FAKE_KEY } },
            eventEmitter: emitter,
        });
        let thrown = '';
        try { await comp.load({ url: 'https://example.com' }); }
        catch (err) { thrown = (/** @type {any} */ (err))?.message ?? String(err); }
        assertNoKey({ payloads, label: 'Tavily error payload' });
        assert.ok(!thrown.includes(FAKE_KEY), `Tavily error message leaked the API key: ${thrown}`);
    } finally { restore(); }
});

test('JAI scrape emits no API key in any payload', async () => {
    const taskApi = {
        /** @param {{taskId: any, parameters: any}} arg0 */
        async executeJson({ taskId, parameters }) {
            assert.equal(taskId, 'web-scrape');
            return { rawContent: 'jai body' };
        }
    };
    const emitter = new EventEmitter();
    const payloads = capture({ emitter });
    const comp = new WebScrapeComponent({
        provider: 'jai',
        config: { mode: 'native_with_tavily_fallback', tavily: null },
        taskApi,
        eventEmitter: emitter,
    });
    await comp.load({ urls: ['https://a.com', 'https://b.com'] });
    assertNoKey({ payloads, label: 'JAI' });
});