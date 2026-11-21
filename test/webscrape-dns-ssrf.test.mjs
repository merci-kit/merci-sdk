// @ts-check
/**
 * SSRF through DNS: the literal-host guard cannot see a hostname that resolves
 * to a private address, and `fetchGuarded` follows redirects one hop at a time,
 * so the DNS check has to run on every hop, not only on the first URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvesToPublicHost } from '../lib/agentic/web-shared.mjs';
import { CurlEngine } from '../lib/agentic/webscrape/engines.mjs';

/**
 * A `dns.lookup`-shaped stub.
 * @param {Array<{address: string, family?: number}>|Error} result
 * @param {string[]} [seen]
 */
function lookupStub(result, seen = []) {
    return async (/** @type {string} */ host) => {
        seen.push(host);
        if (result instanceof Error) throw result;
        return result;
    };
}

test('resolvesToPublicHost: a loopback DNS answer is refused', async () => {
    assert.equal(await resolvesToPublicHost({
        url: 'http://private.test/',
        lookup: lookupStub([{ address: '127.0.0.1', family: 4 }]),
    }), false);
});

test('resolvesToPublicHost: all-public answers pass', async () => {
    assert.equal(await resolvesToPublicHost({
        url: 'http://public.test/',
        lookup: lookupStub([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]),
    }), true);
});

test('resolvesToPublicHost: one private answer in a mixed set is refused', async () => {
    assert.equal(await resolvesToPublicHost({
        url: 'http://mixed.test/',
        lookup: lookupStub([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]),
    }), false);
});

test('resolvesToPublicHost: an IPv4-mapped loopback answer is refused', async () => {
    assert.equal(await resolvesToPublicHost({
        url: 'http://mapped.test/',
        lookup: lookupStub([{ address: '::ffff:127.0.0.1', family: 6 }]),
    }), false);
});

test('resolvesToPublicHost: reserved IPv4 and IPv6 ranges are refused (G2-8)', async () => {
    for (const url of [
        'http://[fec0::1]/',
        'http://192.0.0.192/',
        'http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/',
    ]) {
        assert.equal(await resolvesToPublicHost({ url, lookup: lookupStub([]) }), false, url);
    }
});

test('resolvesToPublicHost: every IPv4-mapped form of a loopback answer is refused', async () => {
    for (const address of ['::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:127.0.0.1']) {
        assert.equal(await resolvesToPublicHost({ url: 'http://mapped.test/', lookup: lookupStub([{ address, family: 6 }]) }), false, address);
    }
    assert.equal(await resolvesToPublicHost({ url: 'http://mapped.test/', lookup: lookupStub([{ address: '::ffff:808:808', family: 6 }]) }), true,
        'a mapped public address is not blocked by the ::ffff:0:0/96 prefix');
});

test('resolvesToPublicHost: public example addresses stay allowed', async () => {
    assert.equal(await resolvesToPublicHost({ url: 'http://example.com/', lookup: lookupStub([{ address: '93.184.216.34', family: 4 }]) }), true);
    assert.equal(await resolvesToPublicHost({ url: 'http://8.8.8.8/', lookup: lookupStub([]) }), true);
});

test('resolvesToPublicHost: a lookup failure or an empty answer fails closed', async () => {
    assert.equal(await resolvesToPublicHost({ url: 'http://down.test/', lookup: lookupStub(new Error('ENOTFOUND')) }), false);
    assert.equal(await resolvesToPublicHost({ url: 'http://empty.test/', lookup: lookupStub([]) }), false);
});

test('resolvesToPublicHost: IP literals are decided without a lookup', async () => {
    const seen = /** @type {string[]} */ ([]);
    assert.equal(await resolvesToPublicHost({ url: 'http://127.0.0.1/', lookup: lookupStub([], seen) }), false);
    assert.equal(await resolvesToPublicHost({ url: 'http://93.184.216.34/', lookup: lookupStub([], seen) }), true);
    assert.deepEqual(seen, []);
});

test('resolvesToPublicHost: allowPrivateNetwork bypasses the lookup', async () => {
    assert.equal(await resolvesToPublicHost({
        url: 'http://private.test/',
        allowPrivateNetwork: true,
        lookup: lookupStub(new Error('must not be called')),
    }), true);
});

test('resolvesToPublicHost: a non-http or invalid URL is refused', async () => {
    assert.equal(await resolvesToPublicHost({ url: 'file:///etc/passwd', lookup: lookupStub([]) }), false);
    assert.equal(await resolvesToPublicHost({ url: 'not a url', lookup: lookupStub([]) }), false);
});

test('CurlEngine: a hostname resolving to loopback is blocked before fetch', async () => {
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => { calls += 1; return new Response('never'); };
    try {
        const [result] = await CurlEngine.fetch({
            input: 'http://private.test/',
            opts: /** @type {any} */ ({ lookup: lookupStub([{ address: '127.0.0.1', family: 4 }]) }),
        });
        assert.match(String(result.error), /Blocked/);
        assert.equal(calls, 0, 'no request may leave before the DNS verdict');
    } finally {
        global.fetch = original;
    }
});

test('CurlEngine: a redirect to a hostname resolving to loopback is blocked on the hop', async () => {
    let calls = 0;
    const seen = /** @type {string[]} */ ([]);
    const lookup = async (/** @type {string} */ host) => {
        seen.push(host);
        if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
        if (host === 'private.test') return [{ address: '127.0.0.1', family: 4 }];
        throw new Error(`unexpected host ${host}`);
    };
    const original = global.fetch;
    global.fetch = async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'http://private.test/' } });
    };
    try {
        const [result] = await CurlEngine.fetch({ input: 'http://public.test/', opts: /** @type {any} */ ({ lookup, fetch: global.fetch }) });
        assert.match(String(result.error), /Blocked/);
        assert.equal(calls, 1, 'the redirect target must be refused before the second request');
        assert.deepEqual(seen, ['public.test', 'private.test']);
    } finally {
        global.fetch = original;
    }
});

test('CurlEngine: the non-follow redirect path is guarded too', async () => {
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => { calls += 1; return new Response('never'); };
    try {
        const [result] = await CurlEngine.fetch({
            input: 'http://private.test/',
            opts: /** @type {any} */ ({ redirect: 'error', lookup: lookupStub([{ address: '10.0.0.7', family: 4 }]) }),
        });
        assert.match(String(result.error), /Blocked/);
        assert.equal(calls, 0);
    } finally {
        global.fetch = original;
    }
});

test('CurlEngine: allowPrivateNetwork lets the loopback host through', async () => {
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => {
        calls += 1;
        return new Response('<html><body>ok</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    try {
        const [result] = await CurlEngine.fetch({
            input: 'http://private.test/',
            opts: /** @type {any} */ ({ allowPrivateNetwork: true, fetch: global.fetch, lookup: lookupStub(new Error('must not be called')) }),
        });
        assert.equal(result.error, undefined);
        assert.match(String(result.content), /ok/);
        assert.equal(calls, 1);
    } finally {
        global.fetch = original;
    }
});
