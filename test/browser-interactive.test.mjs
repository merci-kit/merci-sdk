// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { BrowserComponent, INTERACTIVE_ACTIONS } from '../lib/agentic/browser/component.mjs';
import { PlaywrightSession } from '../lib/agentic/browser/engines.mjs';
import { ConfigurationError, BackendError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

// ponytail: minimal fake Playwright surface — records calls, returns canned
/** @param {{ title?: string, url?: string, snapshot?: any, evaluateImpl?: ((script: any) => any) | null }} [opts] @returns {any} */
function fakeStack({ title = 'T', url = 'https://x.test/', snapshot = null, evaluateImpl = null } = {}) {
    const calls = /** @type {Array<Array<any>>} */ ([]);
    const listeners = /** @type {Record<string, any[]>} */ ({});
    const locatorCalls = /** @type {Array<Array<any>>} */ ([]);
    /** @param {any} sel */
    const locator = (sel) => {
        const l = {
            sel,
            /** @param {any} o */
            click: async (o) => { locatorCalls.push(['click', sel, o]); },
            /** @param {{text: any, o: any}} arg0 */
            fill: async ({ text, o }) => { locatorCalls.push(['fill', sel, text, o]); },
            /** @param {any} text @param {any} o */
            pressSequentially: async (text, o) => { locatorCalls.push(['type', sel, text, o]); },
            /** @param {any} key @param {any} o */
            press: async (key, o) => { locatorCalls.push(['pressKey', sel, key, o]); },
            /** @param {any} opt @param {any} o */
            selectOption: async (opt, o) => { locatorCalls.push(['selectOption', sel, opt, o]); return ['v1']; },
        };
        return l;
    };
    const page = {
        _url: url,
        url: () => page._url,
        title: async () => title,
        /** @param {any} u */
        goto: async (u) => { calls.push(['goto', u]); page._url = u; },
        close: async () => { calls.push(['page.close']); },
        locator,
        /** @param {any} script */
        evaluate: async (script) => {
            calls.push(['evaluate', String(script).slice(0, 40)]);
            if (evaluateImpl) return evaluateImpl(script);
            if (String(script).includes('querySelectorAll')) return snapshot ?? { text: 'hello', elements: [{ tag: 'button', text: 'Go', selector: '#go' }] };
            if (String(script).includes('querySelector(')) return true;
            return { echo: true };
        },
        /**
 * @param {{sel: any}} arg0
 */
        waitForSelector: async ({ sel }) => { calls.push(['waitForSelector', sel]); },
        /** @param {{ path?: any }} param0 */
        screenshot: async ({ path }) => { calls.push(['screenshot', path]); },
        keyboard: /** @type {{ press: (key: any) => Promise<void> }} */ ({ press: async (key) => { calls.push(['keyboard.press', key]); } }),
        /** @param {any} ev @param {any} fn */
        on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
        /** @param {any} ev @param {any} payload */
        fire: (ev, payload) => { for (const fn of listeners[ev] ?? []) fn(payload); },
    };
    const browser = {
        newContext: async () => ({ newPage: async () => { calls.push(['newPage']); return page; } }),
        close: async () => { calls.push(['browser.close']); },
    };
    let connects = 0;
    /** @param {any} endpoint */
    const connect = async (endpoint) => { connects++; calls.push(['connect', endpoint]); return browser; };
    return { calls, locatorCalls, page, browser, connect, endpointOf: () => calls.find(c => c[0] === 'connect')?.[1], connects: () => connects };
}

/** @param {{emitter: import('node:events').EventEmitter}} arg0 */
/** @param {{emitter: *}} arg0 */
const events = ({ emitter }) => {
    const seen = /** @type {any[]} */ ([]);
    for (const name of [EVENTS.BROWSER.INTERACT_START, EVENTS.BROWSER.INTERACT_SUCCESS, EVENTS.BROWSER.INTERACT_ERROR]) {
        emitter.on(name, /** @type {(...args: any[]) => any} */ ((e) => seen.push({ name, e })));
    }
    return seen;
};

/** @param {{fake: any, extraConfig?: any}} arg0 */
/** @param {{fake: *, extraConfig?: *}} arg0 */
const compWith = ({ fake, extraConfig = {} }) => new BrowserComponent({
    provider: 'openai',
    config: { mode: 'playwright', playwright: { endpointURL: 'ws://test:1', connect: fake.connect }, ...extraConfig },
    eventEmitter: new EventEmitter(),
});

test('INTERACTIVE_ACTIONS covers the MCP parity set (no pdf/screencast)', () => {
    assert.deepEqual([...INTERACTIVE_ACTIONS], [
        'snapshot', 'click', 'fill', 'type', 'pressKey', 'selectOption',
        'evaluate', 'waitFor', 'networkRequests', 'consoleMessages', 'screenshot', 'close'
    ]);
});

test('snapshot returns url/title/text/refs and emits interact events', async () => {
    const fake = fakeStack();
    const emitter = new EventEmitter();
    const comp = new BrowserComponent({
        provider: 'openai',
        config: { mode: 'playwright', playwright: { connect: fake.connect } },
        eventEmitter: emitter,
    });
    const seen = events({ emitter });
    const out = JSON.parse(await comp.load({ action: 'snapshot' }));
    assert.equal(out.action, 'snapshot');
    assert.equal(out.title, 'T');
    assert.equal(out.bodyText, 'hello');
    assert.deepEqual(out.elements, [{ ref: 0, tag: 'button', text: 'Go', selector: '#go' }]);
    assert.equal(seen[0].name, EVENTS.BROWSER.INTERACT_START);
    assert.equal(seen[0].e.action, 'snapshot');
    assert.equal(seen[1].name, EVENTS.BROWSER.INTERACT_SUCCESS);
});

test('explicit navigate rides the session leg and shares the page', async () => {
    const fake = fakeStack({ url: 'https://start.test/' });
    const comp = compWith({ fake });
    const nav = JSON.parse(await comp.load({ action: 'navigate', url: 'https://x.test/login' }));
    assert.equal(nav.action, 'navigate');
    assert.equal(nav.url, 'https://x.test/login');
    assert.equal(nav.title, 'T');
    assert.deepEqual((/** @type {Array<Array<any>>} */ (fake.calls)).find(c => c[0] === 'goto'), ['goto', 'https://x.test/login']);
    const snap = JSON.parse(await comp.load({ action: 'snapshot' }));
    assert.equal(snap.url, 'https://x.test/login', 'snapshot sees the navigated page');
    assert.equal(fake.connects(), 1);
});

test('navigate always takes a fresh page (Obscura utility-world hygiene)', async () => {
    const fake = fakeStack({ url: 'https://start.test/' });
    const comp = compWith({ fake });
    await comp.load({ action: 'navigate', url: 'https://x.test/a' });
    await comp.load({ action: 'navigate', url: 'https://x.test/b' });
    assert.equal(fake.connects(), 1, 'one CDP connection');
    assert.equal((/** @type {Array<Array<any>>} */ (fake.calls)).filter(c => c[0] === 'newPage').length, 2, 'fresh page per navigate');
});

test('click heals a wedged page by recycling at the current URL', async () => {
    // ponytail: Obscura 0.2.2 wedges utility-world evaluates after a
    let wedged = false;
    const fake = fakeStack({
        evaluateImpl: (script) => {
            if (wedged) throw new Error('utilityScript.evaluate is not a function');
            if (String(script).includes('querySelectorAll')) return { text: 'hi', elements: [{ tag: 'button', text: 'Go', selector: '#go' }] };
            return true;
        },
    });
    const comp = compWith({ fake });
    await comp.load({ action: 'snapshot' });
    wedged = true;
    const out = JSON.parse(await comp.load({ action: 'click', ref: 0 }));
    assert.equal(out.ok, true);
    assert.ok((/** @type {Array<Array<any>>} */ (fake.calls)).some(c => c[0] === 'page.close'), 'old page closed');
    assert.ok((/** @type {Array<Array<any>>} */ (fake.calls)).some(c => c[0] === 'goto' && c[1] === 'https://x.test/'), 'recycled at current URL');
});

test('click by ref resolves the snapshot selector; session persists across calls', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    await comp.load({ action: 'snapshot' });
    const out = JSON.parse(await comp.load({ action: 'click', ref: 0 }));
    assert.equal(out.ok, true);
    assert.deepEqual(fake.locatorCalls[0].slice(0, 2), ['click', '#go']);
    assert.equal(fake.connects(), 1, 'one CDP connection for both calls');
});

test('click without ref or selector fails loudly', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    await assert.rejects(comp.load({ action: 'click' }), (err) => {
        assert.ok(err instanceof BackendError);
        assert.match(err.message, /ref.*selector|selector.*ref/);
        return true;
    });
});

test('fill requires text; type uses pressSequentially', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    await assert.rejects(comp.load({ action: 'fill', selector: '#u' }), /requires `text`/);
    const out = JSON.parse(await comp.load({ action: 'type', selector: '#u', text: 'hi' }));
    assert.equal(out.ok, true);
    assert.deepEqual(fake.locatorCalls[0].slice(0, 3), ['type', '#u', 'hi']);
});

test('pressKey without target uses the keyboard; evaluate returns values', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    const k = JSON.parse(await comp.load({ action: 'pressKey', key: 'Enter' }));
    assert.equal(k.ok, true);
    assert.deepEqual((/** @type {Array<Array<any>>} */ (fake.calls)).find(c => c[0] === 'keyboard.press'), ['keyboard.press', 'Enter']);
    const e = JSON.parse(await comp.load({ action: 'evaluate', expression: 'document.title' }));
    assert.deepEqual(e.value, { echo: true });
});

test('waitFor polls for the selector and returns the match', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    const out = JSON.parse(await comp.load({ action: 'waitFor', selector: '.quote' }));
    assert.deepEqual(out, { action: 'waitFor', found: true, selector: '.quote', url: 'https://x.test/' });
});

test('network/console reads replay the captured logs', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    await comp.load({ action: 'snapshot' });
    fake.page.fire('response', { url: () => 'https://x.test/a.js', request: () => ({ method: () => 'GET' }), status: () => 200 });
    fake.page.fire('console', { type: () => 'log', text: () => 'boot' });
    const net = JSON.parse(await comp.load({ action: 'networkRequests' }));
    assert.deepEqual(net.requests, [{ url: 'https://x.test/a.js', method: 'GET', status: 200 }]);
    const con = JSON.parse(await comp.load({ action: 'consoleMessages' }));
    assert.deepEqual(con.messages, [{ type: 'log', text: 'boot' }]);
});

test('screenshot writes into screenshotDir and returns the path', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake, extraConfig: { screenshotDir: '/tmp/shots' } });
    const out = JSON.parse(await comp.load({ action: 'screenshot' }));
    assert.match(out.path, /^\/tmp\/shots\/browser-.*\.png$/);
    assert.deepEqual((/** @type {Array<Array<any>>} */ (fake.calls)).find(c => c[0] === 'screenshot'), ['screenshot', out.path]);
});

test('close disconnects and resets the session', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    await comp.load({ action: 'snapshot' });
    const out = JSON.parse(await comp.load({ action: 'close' }));
    assert.equal(out.closed, true);
    assert.equal(out.wasConnected, true);
    assert.ok((/** @type {Array<Array<any>>} */ (fake.calls)).some(c => c[0] === 'browser.close'));
    await comp.load({ action: 'snapshot' });
    assert.equal(fake.connects(), 2, 'reconnects after close');
});

test('unknown action is a ConfigurationError; engine failure emits interact_error', async () => {
    const fake = fakeStack();
    const comp = compWith({ fake });
    await assert.rejects(comp.load({ action: 'teleport' }), err => err instanceof ConfigurationError && err.option === 'action');
    const bad = compWith({ fake: { connect: async () => { throw new Error('CDP down'); } } });
    const seen = /** @type {any[]} */ ([]);
    (/** @type {any} */ (bad.eventEmitter)).on(EVENTS.BROWSER.INTERACT_ERROR, /** @type {(e: any) => void} */ ((e) => seen.push(e)));
    await assert.rejects(bad.load({ action: 'snapshot' }), /CDP down/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].action, 'snapshot');
});

test('PlaywrightSession reports connected state and endpoint default', async () => {
    const s = new PlaywrightSession({ opts: { connect: fakeStack().connect } });
    assert.equal(s.connected, false);
    await s.act({ action: 'snapshot' });
    assert.equal(s.connected, true);
    const def = new PlaywrightSession({});
    assert.equal(def.endpointURL, 'ws://127.0.0.1:9222');
    await def.close();
    assert.deepEqual(await def.close(), { closed: true, wasConnected: false });
});
