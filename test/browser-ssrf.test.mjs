// @ts-check
/**
 * The browser leg has to enforce the same host policy as the scrape leg. A
 * Playwright context intercepts every request — navigation, click, evaluate,
 * pressKey and subresources — so one catch-all route handler covers them all
 * before the request leaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlaywrightSession } from '../lib/agentic/browser/engines.mjs';
import { BackendError } from '../lib/core/errors.mjs';

/**
 * A session over a fake CDP connection whose context captures the route
 * handler. No browser and no network.
 * @param {{allowPrivateNetwork?: boolean, allowedDomains?: string[], blockedDomains?: string[]}} [options]
 */
function fakeSession(options = {}) {
    /** @type {any} */
    let handler = null;
    /** @type {any} */
    let socketHandler = null;
    /** @type {string[]} */
    const patterns = [];
    /** @type {string[]} */
    const socketPatterns = [];
    /** @type {Array<Record<string, unknown>>} */
    const contextOptions = [];
    const context = {
        /** @param {string} pattern @param {any} fn */
        route: async (pattern, fn) => { patterns.push(pattern); handler = fn; },
        /** @param {string} pattern @param {any} fn */
        routeWebSocket: async (pattern, fn) => { socketPatterns.push(pattern); socketHandler = fn; },
        newPage: async () => { throw new Error('the route test never opens a page'); },
    };
    const connect = async () => ({ newContext: async (/** @type {Record<string, unknown>|undefined} */ opts) => { contextOptions.push(opts ?? {}); return context; } });
    const session = new PlaywrightSession({ opts: { connect, ...options } });
    return { session, patterns, socketPatterns, contextOptions, handler: () => handler, socketHandler: () => socketHandler };
}

/** @param {string} url */
function fakeRoute(url) {
    /** @type {string[]} */
    const calls = [];
    return {
        calls,
        request: () => ({ url: () => url }),
        continue: async () => { calls.push('continue'); },
        abort: async () => { calls.push('abort'); },
    };
}

test('the context installs one route handler for every request', async () => {
    const fake = fakeSession();
    await fake.session._ensureContext();
    assert.deepEqual(fake.patterns, ['**/*']);
    assert.equal(typeof fake.handler(), 'function');
});

test('the route blocks loopback, private and reserved literals', async () => {
    const fake = fakeSession();
    await fake.session._ensureContext();
    const handler = fake.handler();
    for (const url of ['http://127.0.0.1/secret', 'http://10.0.0.7/', 'http://169.254.169.254/latest']) {
        const route = fakeRoute(url);
        await handler(route);
        assert.deepEqual(route.calls, ['abort'], `${url} must be aborted`);
    }
});

test('the route blocks a hostname that resolves to loopback', async () => {
    const fake = fakeSession();
    await fake.session._ensureContext();
    const route = fakeRoute('http://localhost/');
    await fake.handler()(route);
    assert.deepEqual(route.calls, ['abort']);
});

test('the route continues a public literal', async () => {
    const fake = fakeSession();
    await fake.session._ensureContext();
    const route = fakeRoute('http://93.184.216.34/');
    await fake.handler()(route);
    assert.deepEqual(route.calls, ['continue']);
});

test('allowPrivateNetwork lets a loopback request through', async () => {
    const fake = fakeSession({ allowPrivateNetwork: true });
    await fake.session._ensureContext();
    const route = fakeRoute('http://127.0.0.1/');
    await fake.handler()(route);
    assert.deepEqual(route.calls, ['continue']);
});

test('the session domain policy still applies inside the route', async () => {
    const blocked = fakeSession({ blockedDomains: ['93.184.216.34'] });
    await blocked.session._ensureContext();
    const blockedRoute = fakeRoute('http://93.184.216.34/');
    await blocked.handler()(blockedRoute);
    assert.deepEqual(blockedRoute.calls, ['abort']);

    const allowed = fakeSession({ allowedDomains: ['93.184.216.34'] });
    await allowed.session._ensureContext();
    const allowedRoute = fakeRoute('http://93.184.216.34/');
    await allowed.handler()(allowedRoute);
    assert.deepEqual(allowedRoute.calls, ['continue']);
});

test('the context blocks service workers', async () => {
    // A service worker answers a request from its own fetch handler, which the
    // context route never sees — the guard would be bypassed.
    const fake = fakeSession();
    await fake.session._ensureContext();
    assert.deepEqual(fake.contextOptions, [{ serviceWorkers: 'block' }]);
});

/** @param {string} url */
function fakeSocket(url) {
    /** @type {string[]} */
    const calls = [];
    return {
        calls,
        url: () => url,
        connectToServer: async () => { calls.push('connect'); },
        close: async () => { calls.push('close'); },
    };
}

test('a WebSocket to a private host is closed', async () => {
    // WebSockets are not HTTP requests, so `ctx.route` never sees them.
    const fake = fakeSession();
    await fake.session._ensureContext();
    assert.deepEqual(fake.socketPatterns, ['**/*']);
    for (const url of ['ws://127.0.0.1:9000/socket', 'wss://10.0.0.7/socket', 'ws://169.254.169.254/latest']) {
        const socket = fakeSocket(url);
        await fake.socketHandler()(socket);
        assert.deepEqual(socket.calls, ['close'], `${url} must be closed`);
    }
});

test('a WebSocket to a public host connects', async () => {
    const fake = fakeSession();
    await fake.session._ensureContext();
    const socket = fakeSocket('wss://93.184.216.34/socket');
    await fake.socketHandler()(socket);
    assert.deepEqual(socket.calls, ['connect']);

    const blocked = fakeSession({ blockedDomains: ['93.184.216.34'] });
    await blocked.session._ensureContext();
    const denied = fakeSocket('wss://93.184.216.34/socket');
    await blocked.socketHandler()(denied);
    assert.deepEqual(denied.calls, ['close'], 'the session domain policy applies to sockets too');
});

/**
 * A session over a context that offers only one of the two routing legs.
 * @param {{leg: 'route'|'routeWebSocket'}} arg0
 */
function partialContext({ leg }) {
    const context = {
        newPage: async () => { throw new Error('the guard test never opens a page'); },
        [leg]: async () => {},
    };
    return new PlaywrightSession({ opts: { connect: async () => ({ newContext: async () => context }) } });
}

/**
 * A predicate for `assert.rejects`: the session refused because the context is
 * missing one routing leg, named by `missing`.
 * @param {{missing: string}} arg0
 * @returns {(error: unknown) => boolean}
 */
function refusesUnpolicedContext({ missing }) {
    return (error) => {
        if (!(error instanceof BackendError) || error.provider !== 'playwright') return false;
        return error.message.includes(`${missing}() is missing`);
    };
}

test('a context that routes one leg but not the other fails closed', async () => {
    // A context with `route` but no `routeWebSocket` (playwright-core before
    // 1.48) would leave every socket unpoliced, silently.
    await assert.rejects(
        partialContext({ leg: 'route' })._ensureContext(),
        refusesUnpolicedContext({ missing: 'routeWebSocket' })
    );
    await assert.rejects(
        partialContext({ leg: 'routeWebSocket' })._ensureContext(),
        refusesUnpolicedContext({ missing: 'route' })
    );
});
