// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { WebSearchComponent } from '../lib/agentic/websearch/component.mjs';

function mockTavily() {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answer: 'a', results: [{ title: 'T', url: 'u' }] })
    }));
    return () => { global.fetch = orig; };
}

test('web_search tool executes Tavily and returns unified JSON string', async () => {
    const restore = mockTavily();
    try {
        const comp = new WebSearchComponent({
            provider: 'openai',
            config: { mode: 'tool', tavily: { apiKey: 'k' }, maxResults: 4 }
        });
        const tool = /** @type {any} */ (comp.toWebSearchTool());
        assert.equal(tool.name, 'web_search');
        assert.equal(typeof tool.execute, 'function');
        const out = await tool.execute({ args: { query: 'q' } });
        const parsed = JSON.parse(out);
        assert.equal(parsed.query, 'q');
        assert.equal(parsed.answer, 'a');
        assert.deepEqual(parsed.sources, [{ title: 'T', url: 'u' }]);
    } finally { restore(); }
});

test('jai path uses taskApi.executeJson when no tavily config', async () => {
    let called = false;
    const taskApi = {
        /** @param {{taskId: *, parameters: *}} arg0 */
        async executeJson({ taskId, parameters }) {
            called = true;
            assert.equal(taskId, 'web-search');
            assert.equal(parameters.query, 'q');
            return { results: [{ title: 'T', url: 'u' }] };
        }
    };
    const comp = new WebSearchComponent({ provider: 'jai', config: { mode: 'tool' }, taskApi });
    const out = JSON.parse(await comp.load({ query: 'q' }));
    assert.ok(called);
    assert.deepEqual(out.sources, [{ title: 'T', url: 'u' }]);
});

test('native and off modes short-circuit to a note instead of searching', async () => {
    const comp = new WebSearchComponent({ provider: 'anthropic', config: { mode: 'native' } });
    const out = JSON.parse(await comp.load({ query: 'q' }));
    assert.equal(out.sources.length, 0);
    assert.match(out.note, /native/);

    const off = new WebSearchComponent({ provider: 'jai', config: { mode: 'off' } });
    const offOut = JSON.parse(await off.load({ query: 'q' }));
    assert.match(offOut.note, /off/);
});

test('force overrides native resolution to the tool path', async () => {
    const restore = mockTavily();
    try {
        const comp = new WebSearchComponent({
            provider: 'anthropic',
            config: { mode: 'native', force: true, tavily: { apiKey: 'k' } }
        });
        const out = JSON.parse(await comp.load({ query: 'q' }));
        assert.equal(out.answer, 'a');
    } finally { restore(); }
});
test('identical searches hit the in-memory cache (one engine call)', async () => {
    const restore = mockTavily();
    let calls = 0;
    const orig = global.fetch;
    global.fetch = async (...args) => { calls++; return orig(...args); };
    try {
        const comp = new WebSearchComponent({ provider: 'openai', config: { mode: 'tool', tavily: { apiKey: 'k' } } });
        await comp.load({ query: 'same' });
        await comp.load({ query: 'same' });
        assert.equal(calls, 1, 'a repeated identical search must reuse the cached result');
        await comp.load({ query: 'other' });
        assert.equal(calls, 2, 'a different query is a cache miss');
    } finally { restore(); }
});

test('cacheTtlMs:0 disables the cache', async () => {
    const restore = mockTavily();
    let calls = 0;
    const orig = global.fetch;
    global.fetch = async (...args) => { calls++; return orig(...args); };
    try {
        const comp = new WebSearchComponent({ provider: 'openai', config: { mode: 'tool', tavily: { apiKey: 'k' }, cacheTtlMs: 0 } });
        await comp.load({ query: 'same' });
        await comp.load({ query: 'same' });
        assert.equal(calls, 2);
    } finally { restore(); }
});
