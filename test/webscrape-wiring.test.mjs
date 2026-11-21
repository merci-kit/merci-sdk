// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import {
    ProviderType,
    WEB_SCRAPE_TOOL_NAME,
    WEB_SCRAPE_MODES,
    isNativeMode,
} from '../lib/core/constants/index.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';

/** @param {{b: any}} arg0 */
/** @param {{b: *}} arg0 */
const registered = ({ b }) => b._tools.some((/** @type {any} */ t) => t.name === WEB_SCRAPE_TOOL_NAME);

test('WEB_SCRAPE_MODES lists every supported mode', () => {
    assert.deepEqual([...WEB_SCRAPE_MODES], [
        'off', 'native', 'tavily', 'curl', 'native_with_tavily_fallback', 'native_with_curl_fallback',
    ]);
});

test('isNativeMode recognizes the native family only', () => {
    for (const mode of ['native', 'native_with_tavily_fallback', 'native_with_curl_fallback']) {
        assert.equal(isNativeMode({ mode }), true, mode);
    }
    for (const mode of ['off', 'tavily', 'curl', 'tool', 'obscura', 'playwright']) {
        assert.equal(isNativeMode({ mode }), false, mode);
    }
    assert.equal(isNativeMode({ mode: undefined }), false);
    assert.equal(isNativeMode({}), false, 'absent mode is not native');
    assert.equal(isNativeMode({ mode: /** @type {any} */ (5) }), false, 'non-string mode is not native');
    assert.deepEqual(
        WEB_SCRAPE_MODES.filter((/** @type {string} */ m) => isNativeMode({ mode: m })),
        ['native', 'native_with_tavily_fallback', 'native_with_curl_fallback'],
        'native subset of the scrape modes is exactly the native family'
    );
});

test('EVENTS.WEB_SCRAPE exposes SCRAPE_START/SUCCESS/ERROR', () => {
    assert.equal(EVENTS.WEB_SCRAPE.SCRAPE_START, 'web_scrape:start');
    assert.equal(EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS, 'web_scrape:success');
    assert.equal(EVENTS.WEB_SCRAPE.SCRAPE_ERROR, 'web_scrape:error');
});

test('fallback modes register the web_scrape tool', () => {
    for (const mode of ['native_with_tavily_fallback', 'native_with_curl_fallback', 'tavily', 'curl']) {
        const b = new ChatSessionBuilder();
        b.provider = ProviderType.OPENAI;
        b.withWebScrape({ options: { mode } });
        assert.ok(registered({ b }), mode);
    }
});

test('pure native and off register no web_scrape tool', () => {
    const native = new ChatSessionBuilder();
    native.provider = ProviderType.ANTHROPIC;
    native.withWebScrape({ options: { mode: 'native' } });
    assert.ok(!registered({ b: native }));

    const off = new ChatSessionBuilder();
    off.provider = ProviderType.OPENAI;
    off.withWebScrape({ options: { mode: 'off' } });
    assert.ok(!registered({ b: off }));
});

test('withWebScrape rejects an unknown mode with ConfigurationError', () => {
    assert.throws(
        () => new ChatSessionBuilder().withWebScrape({ options: { mode: 'bogus' } }),
        err => err instanceof ConfigurationError && err.option === 'mode'
    );
});

test('backends without a native leg downgrade native modes to tavily with a warning', () => {
    for (const provider of [ProviderType.OPENAI, ProviderType.LOCAL, ProviderType.OPENCODE]) {
        const b = new ChatSessionBuilder();
        b.provider = provider;
        b.eventEmitter = new EventEmitter();
        /** @type {any[]} */
        const warned = [];
        b.eventEmitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warned.push(e));
        b.withWebScrape({ options: { mode: 'native' } });
        assert.equal((/** @type {any} */ (b))._webScrape.mode, 'tavily', provider);
        assert.equal(warned.length, 1, provider);
        assert.equal(warned[0].parameter, 'web_scrape', provider);
    }
});

test('jai native stays native (JAI-native tool leg) and registers no tool', () => {
    const b = new ChatSessionBuilder();
    b.provider = ProviderType.JAI;
    b.withWebScrape({ options: { mode: 'native' } });
    assert.equal((/** @type {any} */ (b))._webScrape.mode, 'native');
    assert.ok(!registered({ b }));
});

test('withWebScrape returns the builder for chaining', () => {
    const b = new ChatSessionBuilder();
    assert.equal(b.withWebScrape(), b);
});

test('withWebScrape defaults maxUrls to the scrape cap and stores an explicit value', () => {
    const d = new ChatSessionBuilder();
    d.withWebScrape({});
    assert.equal((/** @type {any} */ (d))._webScrape.maxUrls, LIMITS.scrape_max_urls);

    const e = new ChatSessionBuilder();
    e.withWebScrape({ options: { maxUrls: 5 } });
    assert.equal((/** @type {any} */ (e))._webScrape.maxUrls, 5);
});

test('withWebScrape stores allowPrivateNetwork and forwards it to the component', () => {
    const off = new ChatSessionBuilder();
    off.provider = ProviderType.OPENAI;
    off.withWebScrape({ options: { mode: 'curl' } });
    assert.equal((/** @type {any} */ (off))._webScrape.allowPrivateNetwork, false, 'private network is off by default');
    assert.equal((/** @type {any} */ (off))._webScrapeComponent?.config.allowPrivateNetwork, false);

    const on = new ChatSessionBuilder();
    on.provider = ProviderType.OPENAI;
    on.withWebScrape({ options: { mode: 'curl', allowPrivateNetwork: true } });
    assert.equal((/** @type {any} */ (on))._webScrape.allowPrivateNetwork, true);
    assert.equal((/** @type {any} */ (on))._webScrapeComponent?.config.allowPrivateNetwork, true);
});

test('withWebScrape rejects a non-positive or non-integer maxUrls', () => {
    for (const bad of [0, -1, 1.5, '5']) {
        assert.throws(
            () => new ChatSessionBuilder().withWebScrape({ options: { maxUrls: /** @type {any} */ (bad) } }),
            err => err instanceof ConfigurationError && err.option === 'maxUrls',
            String(bad)
        );
    }
});

test('withWebScrape stores format defaulting to text', () => {
    const d = new ChatSessionBuilder();
    d.withWebScrape({});
    assert.equal((/** @type {any} */ (d))._webScrape.format, 'text');
    const m = new ChatSessionBuilder();
    m.withWebScrape({ options: { format: 'markdown' } });
    assert.equal((/** @type {any} */ (m))._webScrape.format, 'markdown');
});

test('withWebScrape rejects an unknown format with ConfigurationError', () => {
    for (const bad of ['bogus', 'html', 1]) {
        assert.throws(
            () => new ChatSessionBuilder().withWebScrape({ options: { format: /** @type {any} */ (bad) } }),
            err => err instanceof ConfigurationError && err.option === 'format',
            String(bad)
        );
    }
});

test('withWebScrape defaults maxUses to undefined and stores an explicit value', () => {
    const d = new ChatSessionBuilder();
    d.withWebScrape({});
    assert.equal((/** @type {any} */ (d))._webScrape.maxUses, undefined);

    const e = new ChatSessionBuilder();
    e.withWebScrape({ options: { maxUses: 4 } });
    assert.equal((/** @type {any} */ (e))._webScrape.maxUses, 4);
});

test('withWebScrape rejects a non-positive or non-integer maxUses when present', () => {
    for (const bad of [0, -1, 1.5, '4']) {
        assert.throws(
            () => new ChatSessionBuilder().withWebScrape({ options: { maxUses: /** @type {any} */ (bad) } }),
            err => err instanceof ConfigurationError && err.option === 'maxUses',
            String(bad)
        );
    }
});
