// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { BrowserComponent, resolveReadEngine } from '../lib/agentic/browser/component.mjs';
import { ObscuraEngine, resolveBrowserMode, MAX_BROWSER_URLS } from '../lib/agentic/browser/engines.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import {
    ProviderType,
    BROWSER_TOOL_NAME,
    BROWSER_MODES,
} from '../lib/core/constants/index.mjs';

/** @param {{emitter: EventEmitter}} arg0 @returns {any[]} */
/** @param {{emitter: *}} arg0 */
const events = ({ emitter }) => {
    /** @type {any[]} */
    const seen = [];
    for (const name of [EVENTS.BROWSER.NAVIGATE_START, EVENTS.BROWSER.NAVIGATE_SUCCESS, EVENTS.BROWSER.NAVIGATE_ERROR]) {
        emitter.on(name, (/** @type {any} */ e) => seen.push({ name, e }));
    }
    return seen;
};

test('browser tool exposes the unified name/description/parameters', () => {
    const comp = new BrowserComponent({ provider: 'openai', config: {} });
    const tool = /** @type {any} */ (comp.toBrowserTool());
    assert.equal(tool.name, 'browser');
    assert.match(tool.description, /navigate/);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['action', 'expression', 'format', 'key', 'maxChars', 'ref', 'selector', 'text', 'timeoutMs', 'url', 'urls', 'value', 'waitUntil']);
    assert.deepEqual(tool.parameters.properties.format.enum, ['text', 'markdown']);
    assert.equal(tool.parameters.properties.urls.type, 'array');
    assert.equal(tool.parameters.properties.urls.maxItems, MAX_BROWSER_URLS);
    assert.deepEqual(tool.parameters.required, []);
});

test('resolveBrowserMode: off is off, everything else is the tool', () => {
    assert.equal(resolveBrowserMode({ _sessionProvider: 'openai', mode: 'off' }), 'off');
    assert.equal(resolveBrowserMode({ _sessionProvider: 'openai', mode: undefined }), 'off');
    for (const mode of ['obscura', 'curl', 'tool', 'native']) {
        assert.equal(resolveBrowserMode({ _sessionProvider: 'openai', mode }), 'tool', mode);
    }
});

test('A1-F3: an unpoliced read resolves to curl; obscura needs the explicit opt-in', () => {
    // The obscura leg follows redirects and reports no final URL, so a public
    // URL can land on a private one after the pre-fetch guard passed. Curl is
    // the guarded leg (per-hop checks).
    assert.equal(resolveReadEngine({ mode: 'obscura' }), 'curl', 'no policy, no opt-in -> curl');
    assert.equal(resolveReadEngine({ mode: 'tool' }), 'curl');
    assert.equal(resolveReadEngine({ mode: 'obscura', allowUnpolicedObscura: true }), 'obscura', 'explicit opt-in');
    assert.equal(resolveReadEngine({ mode: 'obscura', policy: true }), 'curl', 'a policy selects the guarded leg');
    assert.equal(resolveReadEngine({ mode: 'curl' }), 'curl');
});

test('obscura mode runs the standalone binary via injected run and emits start/success', async () => {
    /** @type {any[]} */
    const calls = [];
    /** @param {{binaryPath: string, args: string[]}} arg0 */
    /** @param {{binaryPath: *, args: *}} arg0 */
    const run = async ({ binaryPath, args }) => { calls.push([binaryPath, args]); return 'hello page'; };
    const emitter = new EventEmitter();
    const seen = events({ emitter });
    const comp = new BrowserComponent({
        provider: 'openai',
        config: { mode: 'obscura', allowUnpolicedObscura: true, obscura: { binaryPath: '/tmp/obscura-demo/obscura', run } },
        eventEmitter: emitter,
    });
    const { results, truncated } = JSON.parse(await comp.load({ url: 'https://example.com' }));
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://example.com');
    assert.equal(results[0].content, 'hello page');
    assert.equal(truncated, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/tmp/obscura-demo/obscura');
    assert.deepEqual(calls[0][1].slice(0, 4), ['fetch', 'https://example.com', '--dump', 'text']);
    assert.equal(seen[0].name, EVENTS.BROWSER.NAVIGATE_START);
    assert.equal(seen[1].name, EVENTS.BROWSER.NAVIGATE_SUCCESS);
    assert.equal(seen[1].e.chars, 'hello page'.length);
});

test('maxChars truncates and flags the result', async () => {
    const run = async () => 'abcdefghij';
    const comp = new BrowserComponent({
        provider: 'openai',
        config: { mode: 'obscura', allowUnpolicedObscura: true, maxChars: 4, obscura: { run } },
    });
    const { results } = JSON.parse(await comp.load({ url: 'https://example.com' }));
    assert.equal(results[0].content, 'abcd');
    assert.equal(results[0].truncated, true);
});

test('missing binary surfaces a per-item error, never a thrown batch', async () => {
    const run = async () => { const err = new Error('spawn ENOENT'); /** @type {any} */ (err).code = 'ENOENT'; throw err; };
    const comp = new BrowserComponent({
        provider: 'openai',
        config: { mode: 'obscura', allowUnpolicedObscura: true, obscura: { binaryPath: '/nonexistent/obscura', run } },
    });
    const { results } = JSON.parse(await comp.load({ url: 'https://example.com' }));
    assert.equal(results.length, 1);
    assert.match(results[0].error, /binary not found/);
});

test('browser requires a url or urls argument', async () => {
    const comp = new BrowserComponent({ provider: 'openai', config: { mode: 'obscura' } });
    await assert.rejects(comp.load({}), err => err instanceof ConfigurationError && err.option === 'url');
});

test('off mode returns a JSON note instead of erroring', async () => {
    const comp = new BrowserComponent({ provider: 'openai', config: { mode: 'off' } });
    const parsed = JSON.parse(await comp.load({ url: 'https://example.com' }));
    assert.deepEqual(parsed.results, []);
    assert.match(parsed.note, /off/);
});

test('BROWSER_MODES lists every supported mode', () => {
    assert.deepEqual([...BROWSER_MODES], ['off', 'obscura', 'playwright', 'curl', 'tool']);
});

test('EVENTS.BROWSER exposes NAVIGATE_START/SUCCESS/ERROR', () => {
    assert.equal(EVENTS.BROWSER.NAVIGATE_START, 'browser:navigate_start');
    assert.equal(EVENTS.BROWSER.NAVIGATE_SUCCESS, 'browser:navigate_success');
    assert.equal(EVENTS.BROWSER.NAVIGATE_ERROR, 'browser:navigate_error');
});

test('tool modes register the browser tool, off registers nothing', () => {
    for (const mode of ['obscura', 'playwright', 'curl', 'tool']) {
        const b = new ChatSessionBuilder();
        b.provider = ProviderType.OPENAI;
        b.withBrowser({ options: { mode } });
        assert.ok(b._tools.some((/** @type {any} */ t) => t.name === BROWSER_TOOL_NAME), mode);
    }
    const off = new ChatSessionBuilder();
    off.provider = ProviderType.OPENAI;
    off.withBrowser({ options: { mode: 'off' } });
    assert.ok(!off._tools.some((/** @type {any} */ t) => t.name === BROWSER_TOOL_NAME));
});

test('withBrowser rejects unknown mode/format with ConfigurationError', () => {
    assert.throws(
        () => new ChatSessionBuilder().withBrowser({ options: { mode: 'bogus' } }),
        err => err instanceof ConfigurationError && err.option === 'mode'
    );
    for (const bad of ['html', 'pdf', '']) {
        assert.throws(
            () => new ChatSessionBuilder().withBrowser({ options: { format: /** @type {any} */ (bad) } }),
            err => err instanceof ConfigurationError && err.option === 'format'
        );
    }
});

test('withBrowser stores the config contract and returns the builder', () => {
    const b = new ChatSessionBuilder();
    assert.equal(b.withBrowser({}), b);
    assert.equal((/** @type {any} */ (b))._browser.mode, 'obscura');
    assert.equal((/** @type {any} */ (b))._browser.format, 'text');
    assert.equal((/** @type {any} */ (b))._browser.maxChars, 20000);
    assert.equal((/** @type {any} */ (b))._browser.maxUrls, MAX_BROWSER_URLS);
    const c = new ChatSessionBuilder();
    c.withBrowser({ options: { mode: 'curl', format: 'markdown', binaryPath: '/x/obscura', timeoutMs: 5000, allowPrivateNetwork: true } });
    assert.equal((/** @type {any} */ (c))._browser.mode, 'curl');
    assert.equal((/** @type {any} */ (c))._browser.binaryPath, '/x/obscura');
    assert.equal((/** @type {any} */ (c))._browser.allowPrivateNetwork, true, 'private network is opt-in');
    assert.equal((/** @type {any} */ (c))._browserComponent?.config.allowPrivateNetwork, true);
    assert.equal((/** @type {any} */ (b))._browser.allowPrivateNetwork, false, 'private network is off by default');
});

test('allowPrivateNetwork is forwarded to the curl read leg (opt-in only)', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (async () => {
        calls += 1;
        return new Response('<html><body><p>local page</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    try {
        const on = new BrowserComponent({
            provider: 'openai',
            config: { mode: 'curl', allowPrivateNetwork: true, curl: { fetch: globalThis.fetch } },
        });
        const ok = JSON.parse(await on.load({ url: 'http://127.0.0.1:54321/graphql' }));
        assert.match(ok.results[0].content, /local page/);
        assert.equal(calls, 1);

        const off = new BrowserComponent({
            provider: 'openai',
            config: { mode: 'curl', allowPrivateNetwork: false, curl: { fetch: globalThis.fetch } },
        });
        const blocked = JSON.parse(await off.load({ url: 'http://127.0.0.1:54321/graphql' }));
        assert.match(blocked.results[0].error, /Blocked by the configured domain policy/);
        assert.equal(calls, 1, 'the blocked URL never reaches the engine');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
