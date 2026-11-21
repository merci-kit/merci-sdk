// provenance re-verification — phase 1 fixes (A + E + L)
// The A1-F1 / A3-F1 checks below were observed failing on the pre-fix tree before their fix
// landed; the `redirect:error` check pins behaviour that already existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGuardrails } from '../lib/agentic/guardrails.mjs';
import { CurlEngine } from '../lib/agentic/webscrape/engines.mjs';

/** A public DNS answer, so these tests never depend on real DNS. */
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

test('A3-F1: a global or sticky guardrail pattern matches every time, not every other time', async () => {
    // A3-F1: `RegExp.prototype.test` advances `lastIndex` on a /g or /y pattern,
    // so a guardrail written `/AKIA[0-9]{4}/g` tripped on call 1, missed call 2,
    // tripped on call 3 — a silent bypass on every second check.
    for (const [label, rules] of [
        ['global', [{ name: 'key', pattern: /AKIA[0-9]{4}/g }]],
        ['sticky', [{ name: 'key', pattern: /AKIA/y }]],
    ]) {
        const guardrails = createGuardrails({ rules });
        for (let call = 0; call < 4; call++) {
            assert.equal(
                (await guardrails.check({ phase: 'input', text: 'AKIA1234' })).blocked,
                true,
                `${label}: call ${call} must trip — the pattern must not be left stateful`
            );
        }
    }
});

test('A3-F1: the caller’s regex object is not mutated by a check', async () => {
    const pattern = /AKIA/g;
    const guardrails = createGuardrails({ rules: [{ pattern }] });
    await guardrails.check({ phase: 'input', text: 'AKIA' });
    assert.equal(pattern.lastIndex, 0, 'the rule keeps its own lastIndex at 0');
});

test('A1-F1: a redirect to a private host is refused before the hop is requested', async () => {
    // A1-F1: with no domain policy the engine passed `redirect: 'follow'`, so the
    // runtime issued the next hop before the final-URL check could refuse it — a
    // 302 to 169.254.169.254 was a blind GET at the metadata endpoint.
    const orig = global.fetch;
    /** @type {string[]} */
    const fetched = [];
    // Emulate the runtime: with redirect:'follow' the *fetch implementation* issues
    // the next hop, which is exactly why the caller could not check it first.
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts = {}) => {
        fetched.push(String(url));
        if (String(url) === 'https://example.com/open') {
            const location = 'http://169.254.169.254/secret';
            if (opts.redirect === 'manual') {
                return {
                    ok: false,
                    status: 302,
                    headers: { get: (/** @type {string} */ k) => (k === 'location' ? location : 'text/html') },
                    text: async () => '',
                };
            }
            if (opts.redirect === 'error') throw new TypeError('unexpected redirect');
            return /** @type {any} */ (global.fetch)(location, opts);
        }
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => 'LEAKED' };
    });
    try {
        const [out] = /** @type {any[]} */ (await CurlEngine.fetch({ input: 'https://example.com/open', opts: { lookup: PUBLIC_LOOKUP, fetch: global.fetch } }));
        assert.deepEqual(fetched, ['https://example.com/open'], 'the private hop must never be requested');
        assert.equal(out.content, '');
        assert.match(out.error, /domain policy/i);
    } finally {
        global.fetch = orig;
    }
});

test('A1-F1: a safe redirect is still followed when no policy is set', async () => {
    const orig = global.fetch;
    /** @type {string[]} */
    const fetched = [];
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
        fetched.push(String(url));
        if (String(url) === 'https://example.com/one') {
            return {
                ok: false,
                status: 301,
                headers: { get: (/** @type {string} */ k) => (k === 'location' ? '/two' : 'text/html') },
                text: async () => '',
            };
        }
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>final page</p>' };
    });
    try {
        const [out] = /** @type {any[]} */ (await CurlEngine.fetch({ input: 'https://example.com/one', opts: { lookup: PUBLIC_LOOKUP, fetch: global.fetch } }));
        assert.deepEqual(fetched, ['https://example.com/one', 'https://example.com/two']);
        assert.match(String(out.content), /final page/);
    } finally {
        global.fetch = orig;
    }
});

test('A1-F1: redirect:error refuses a redirect without a second request', async () => {
    const orig = global.fetch;
    /** @type {string[]} */
    const fetched = [];
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
        fetched.push(String(url));
        if (opts?.redirect !== 'error') return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => 'followed' };
        return { ok: false, status: 302, headers: { get: (/** @type {string} */ k) => (k === 'location' ? 'https://elsewhere.example/' : 'text/html') }, text: async () => '' };
    });
    try {
        const [out] = /** @type {any[]} */ (await CurlEngine.fetch({ input: 'https://example.com/x', opts: { redirect: 'error', blockedDomains: ['elsewhere.example'], lookup: PUBLIC_LOOKUP, fetch: global.fetch } }));
        assert.deepEqual(fetched, ['https://example.com/x']);
        assert.notEqual(out.content, 'followed');
    } finally {
        global.fetch = orig;
    }
});

test('A1-F1: a redirect chain past the cap is refused, and the cap is the only limit', async () => {
    const orig = global.fetch;
    /** @type {string[]} */
    const fetched = [];
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
        fetched.push(String(url));
        return {
            ok: false,
            status: 302,
            headers: { get: (/** @type {string} */ k) => (k === 'location' ? '/again' : 'text/html') },
            text: async () => '',
        };
    });
    try {
        const [out] = /** @type {any[]} */ (await CurlEngine.fetch({ input: 'https://example.com/loop', opts: { lookup: PUBLIC_LOOKUP, fetch: global.fetch } }));
        assert.match(String(out.error), /too many redirects/i);
        assert.equal(fetched.length, 6, 'the cap is five hops, so six requests in total');
    } finally {
        global.fetch = orig;
    }
});

test('A3-F1: an exotic stateful RegExp subclass is still checked', async () => {
    class ThrowySource extends RegExp {
        get source() { throw new Error('boom-source'); }
    }
    const pattern = new ThrowySource('AKIA', 'g');
    const guardrails = createGuardrails({ rules: [{ name: 'key', pattern }] });
    assert.equal((await guardrails.check({ phase: 'input', text: 'AKIA' })).blocked, true, 'the check must not throw, and must block');
    assert.equal((await guardrails.check({ phase: 'input', text: 'AKIA' })).blocked, true, 'and it must stay stateless');
});
