// @ts-check
/**
 * The DNS guard resolves once and the request connects to that exact address.
 * These tests pin the seam: the resolver's answer is what the socket uses, and
 * the URL hostname is still the Host header and the TLS server name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import { resolvePublicAddress, pinnedFetch } from '../lib/agentic/web-shared.mjs';

/** @param {Array<{address: string, family?: number}>|Error} result */
function lookupStub(result) {
    return async () => {
        if (result instanceof Error) throw result;
        return result;
    };
}

test('resolvePublicAddress returns the first public address and its family', async () => {
    const resolved = await resolvePublicAddress({
        url: 'http://public.test/',
        lookup: lookupStub([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]),
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ok && resolved.address, '93.184.216.34');
    assert.equal(resolved.ok && resolved.family, 4);
    assert.equal(resolved.host, 'public.test');
});

test('resolvePublicAddress refuses a mixed set before any address is pinned', async () => {
    const resolved = await resolvePublicAddress({
        url: 'http://mixed.test/',
        lookup: lookupStub([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]),
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.reason, 'private-address');
});

test('resolvePublicAddress leaves allowPrivateNetwork unpinned', async () => {
    const resolved = await resolvePublicAddress({
        url: 'http://private.test/',
        allowPrivateNetwork: true,
        lookup: lookupStub(new Error('must not be called')),
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ok && resolved.address, null);
});

test('pinnedFetch connects to the pinned address and keeps the URL host', async () => {
    /** @type {string|null} */
    let seenHost = null;
    const server = createServer((req, res) => {
        seenHost = req.headers.host ?? null;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>pinned</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    try {
        const res = await pinnedFetch({
            url: `http://pinned.test:${port}/`,
            address: '127.0.0.1',
            family: 4,
            headers: { Accept: 'text/html' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.ok, true);
        assert.equal(await res.text(), '<html><body>pinned</body></html>');
        assert.equal(seenHost, `pinned.test:${port}`, 'the URL hostname is the Host header, not the IP');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('pinnedFetch passes the pinned lookup and the TLS server name to the request', async () => {
    /** @type {any} */
    let options = null;
    const fakeRequest = (/** @type {any} */ target, /** @type {any} */ opts, /** @type {any} */ callback) => {
        options = opts;
        const res = Readable.from([Buffer.from('ok')]);
        Object.assign(res, { statusCode: 200, headers: { 'content-type': 'text/plain' } });
        callback(res);
        return { on: () => {}, end: () => {} };
    };
    const res = await pinnedFetch({
        url: 'https://pinned.test/',
        address: '93.184.216.34',
        family: 4,
        request: fakeRequest,
    });
    assert.equal(await res.text(), 'ok');
    assert.equal(options.servername, 'pinned.test');
    let answer = /** @type {any} */ (null);
    options.lookup('pinned.test', {}, (/** @type {any} */ err, /** @type {any} */ address, /** @type {any} */ family) => {
        assert.equal(err, null);
        answer = { address, family };
    });
    assert.deepEqual(answer, { address: '93.184.216.34', family: 4 });
    let all = /** @type {any} */ (null);
    options.lookup('pinned.test', { all: true }, (/** @type {any} */ err, /** @type {any} */ addresses) => {
        assert.equal(err, null);
        all = addresses;
    });
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
});
