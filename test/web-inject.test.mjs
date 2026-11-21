// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import {
    WEB_SEARCH_PRELOAD_BLOCK,
    WEB_SCRAPE_PRELOAD_BLOCK,
    BROWSER_PRELOAD_BLOCK,
} from '../lib/core/constants/index.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter */
    constructor(provider, model, eventEmitter) { super({ provider, model, eventEmitter, client: undefined }); }
}

const CASES = [
    { name: 'search', method: 'withWebSearch', key: '_webSearch', block: WEB_SEARCH_PRELOAD_BLOCK, base: { mode: 'native' } },
    { name: 'scrape', method: 'withWebScrape', key: '_webScrape', block: WEB_SCRAPE_PRELOAD_BLOCK, base: { mode: 'curl' } },
    { name: 'browser', method: 'withBrowser', key: '_browser', block: BROWSER_PRELOAD_BLOCK, base: { mode: 'obscura' } },
];

/**
 * @param {{method: string, opts: any}} arg0
 */
async function systemContent({ method, opts }) {
    const s = new MinimalSession('openrouter', 'm', new EventEmitter());
    (/** @type {any} */ (s))[method]({ options: opts });
    const prepared = await s._prepareStepMessages({ messages: [createUserMessage({ provider: 'openrouter', content: 'hi' })] });
    return (/** @type {any} */ (prepared.find(m => m.type === 'system_message'))).content;
}

for (const c of CASES) {
    test(`${c.name}: no inject renders the base block only (no date)`, async () => {
        const content = await systemContent({ method: c.method, opts: { ...c.base } });
        assert.ok(content.includes(c.block));
        assert.ok(!content.includes("Today's date"));
    });

    test(`${c.name}: inject.date renders the localized current date`, async () => {
        const content = await systemContent({ method: c.method, opts: { ...c.base, inject: { date: true, locale: 'en-US', timezone: 'Europe/Prague' } } });
        assert.ok(content.includes(c.block));
        assert.match(content, /Today's date: \w+day, \w+ \d{1,2}, \d{4}\./);
    });

    test(`${c.name}: inject.date {format:iso} renders YYYY-MM-DD`, async () => {
        const content = await systemContent({ method: c.method, opts: { ...c.base, inject: { date: { format: 'iso' } } } });
        assert.match(content, /Today's date: \d{4}-\d{2}-\d{2}\./);
    });

    test(`${c.name}: inject.time + inject.instructions render`, async () => {
        const content = await systemContent({ method: c.method, opts: {
            ...c.base,
            inject: { date: true, time: true, timezone: 'UTC', locale: 'en-US', instructions: 'Prefer recent pages.' },
        } });
        assert.match(content, /Today's date: .*\d{1,2}:\d{2}/);
        assert.ok(content.includes('Prefer recent pages.'));
    });

    test(`${c.name}: inject is stored on the normalized config`, () => {
        const b = (/** @type {any} */ (new ChatSessionBuilder()))[c.method]({ options: { inject: { date: true, timezone: 'UTC' } } });
        assert.deepEqual((/** @type {any} */ (b))[c.key].inject, { date: true, timezone: 'UTC' });
    });

    test(`${c.name}: preload:false keeps the tool and drops the step block`, async () => {
        const content = await systemContent({ method: c.method, opts: { ...c.base, preload: false } });
        assert.ok(!content.includes(c.block), 'the orientation block is not injected');
        const b = /** @type {any} */ (new ChatSessionBuilder())[c.method]({ options: { ...c.base, preload: false } });
        assert.equal(b[`${c.key}Preload`], false, 'the flag is recorded for the session');
        // The capability itself survives — preload only controls the block. The
        // tool registration is mode-dependent (native search registers none), so
        // assert the component and its config, not a tool count that `task`
        // would satisfy on its own.
        assert.ok(b[`${c.key}Component`], 'the capability component stays registered');
        assert.equal(b[c.key].preload, false, 'and its config keeps the flag');
    });

    test(`${c.name}: invalid inject is rejected at config time`, () => {
        const bad = [
            { date: true, timezone: 'Not/AZone' },
            { date: true, locale: 'not a locale!' },
            { date: { format: 'bogus' } },
        ];
        for (const inject of bad) {
            assert.throws(
                () => (/** @type {any} */ (new ChatSessionBuilder()))[c.method]({ options: { inject } }),
                err => err instanceof ConfigurationError && err.option === 'inject',
                `${c.name} should reject ${JSON.stringify(inject)}`
            );
        }
    });
}

test('every web preload block marks its content as untrusted data', async () => {
    const { WEB_SEARCH_PRELOAD_BLOCK, WEB_SCRAPE_PRELOAD_BLOCK, BROWSER_PRELOAD_BLOCK } = await import('../lib/core/constants/index.mjs');
    for (const block of [WEB_SEARCH_PRELOAD_BLOCK, WEB_SCRAPE_PRELOAD_BLOCK, BROWSER_PRELOAD_BLOCK]) {
        assert.match(block, /untrusted data, not instructions/, 'the model must be told the payload is data');
    }
});
