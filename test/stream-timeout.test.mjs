// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InactivityTimeoutPolicy } from '../lib/support/stream-timeout.mjs';
import { DEFAULT_STREAM_TIMEOUT_MS } from '../lib/core/constants/index.mjs';

// ==================================================================================
// ==================================================================================

/**
 * @param {{chunks: string[], delayMs?: *}} arg0
 */
async function* chunksWithDelay({ chunks, delayMs = 0 }) {
    for (const c of chunks) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        yield c;
    }
}

// ==================================================================================
// Configuration / property tests
// ==================================================================================

test('InactivityTimeoutPolicy: default timeoutMs is DEFAULT_STREAM_TIMEOUT_MS (150_000)', () => {
    const p = new InactivityTimeoutPolicy();
    assert.equal(p.timeoutMs, DEFAULT_STREAM_TIMEOUT_MS);
    assert.equal(p.timeoutMs, 150_000);
});

test('InactivityTimeoutPolicy: respects custom timeoutMs', () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 5000 });
    assert.equal(p.timeoutMs, 5000);
});

test('InactivityTimeoutPolicy: exposes timeoutMs as a public property (StreamTimeoutPolicy contract)', () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1234 });
    assert.equal(p.timeoutMs, 1234);
});

// ==================================================================================
// Pass-through behavior
// ==================================================================================

test('InactivityTimeoutPolicy: yields every chunk from the source stream when fast', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1000 });
    const out = [];
    for await (const c of p.wrapStream({ stream: chunksWithDelay({ chunks: ['a', 'b', 'c'] }) })) out.push(c);
    assert.deepEqual(out, ['a', 'b', 'c']);
});

test('InactivityTimeoutPolicy: works with empty source stream', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1000 });
    const out = [];
    for await (const c of p.wrapStream({ stream: chunksWithDelay({ chunks: [] }) })) out.push(c);
    assert.deepEqual(out, []);
});

test('InactivityTimeoutPolicy: no external signal is the default (signal=null)', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1000 });
    const out = [];
    for await (const c of p.wrapStream({ stream: chunksWithDelay({ chunks: ['x'] }) })) out.push(c);
    assert.deepEqual(out, ['x']);
});

// ==================================================================================
// Inactivity timeout fires when no chunk arrives
// ==================================================================================

test('InactivityTimeoutPolicy: aborts the wrapped stream when no chunk arrives within timeoutMs', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 50 });
    const slow = chunksWithDelay({ chunks: ['a', 'b'], delayMs: 200 });
    const out = [];
    let err = /** @type {any} */ (null);
    try {
        for await (const c of p.wrapStream({ stream: slow })) out.push(c);
    } catch (e) { err = e; }
    assert.equal(err !== null, true, 'wrapped stream should throw on inactivity');
    assert.equal(err.name, 'AbortError');
    assert.match(err.message, /timeout/i);
});

test('InactivityTimeoutPolicy: timer is reset on each chunk (sliding-window behavior)', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 80 });
    const out = [];
    for await (const c of p.wrapStream({ stream: chunksWithDelay({ chunks: ['a', 'b', 'c', 'd', 'e'], delayMs: 40 }) })) out.push(c);
    assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e']);
});

test('InactivityTimeoutPolicy: onTimeout callback fires exactly once with the timeout Error', async () => {
    const fired = /** @type {any[]} */ ([]);
    const p = new InactivityTimeoutPolicy({
        timeoutMs: 30,
        onTimeout: (err) => fired.push(err)
    });
    const slow = chunksWithDelay({ chunks: ['x'], delayMs: 100 });
    try { for await (const _ of p.wrapStream({ stream: slow })) {} } catch (_) {}
    assert.equal(fired.length, 1, 'onTimeout should fire exactly once');
    assert.equal(fired[0].name, 'AbortError');
    assert.match(fired[0].message, /timeout/i);
});

// ==================================================================================
// External AbortSignal handling
// ==================================================================================

test('InactivityTimeoutPolicy: external AbortSignal (already aborted) propagates immediately', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1000 });
    const ac = new AbortController();
    ac.abort(new Error('user cancelled'));
    const out = [];
    let err = /** @type {any} */ (null);
    try {
        for await (const c of p.wrapStream({ stream: chunksWithDelay({ chunks: ['a', 'b', 'c'] }), signal: ac.signal })) out.push(c);
    } catch (e) { err = e; }
    assert.ok(out.length <= 3, 'should not yield more than source has');
    assert.ok(err === null || err.message === 'user cancelled' || err.name === 'AbortError');
});

test('InactivityTimeoutPolicy: external AbortSignal (mid-stream abort) propagates', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1000 });
    const ac = new AbortController();
    let abortTriggered = false;
    const slow = chunksWithDelay({ chunks: ['a', 'b', 'c'], delayMs: 30 });
    const wrapper = (async () => {
        const out = [];
        try {
            for await (const c of p.wrapStream({ stream: slow, signal: ac.signal })) {
                out.push(c);
                if (c === 'a' && !abortTriggered) {
                    abortTriggered = true;
                    setTimeout(() => ac.abort(new Error('stop now')), 5);
                }
            }
        } catch (_) { /* expected */ }
        return out;
    })();
    const out = await wrapper;
    assert.ok(out.length <= 2, 'should not yield all 3 chunks after external abort');
    assert.equal(abortTriggered, true, 'abort was triggered');
});

test('InactivityTimeoutPolicy: works with no external signal (omitted arg)', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 1000 });
    const out = [];
    for await (const c of p.wrapStream({ stream: chunksWithDelay({ chunks: ['x', 'y'] }) })) out.push(c);
    assert.deepEqual(out, ['x', 'y']);
});

// ==================================================================================
// ==================================================================================

test('InactivityTimeoutPolicy: firstChunkMs gives the first chunk a longer window than the inter-chunk idle', async () => {
    /** @param {{ms: *}} arg0 */
    /** @param {{ms: *}} arg0 */
    const sleep = ({ ms }) => new Promise((r) => setTimeout(r, ms));
    async function* firstSlow() {
        await sleep({ ms: 120 });
        yield 'a';
        await sleep({ ms: 10 });
        yield 'b';
    }
    const p = new InactivityTimeoutPolicy({ timeoutMs: 40, firstChunkMs: 500 });
    const out = [];
    for await (const c of p.wrapStream({ stream: firstSlow() })) out.push(c);
    assert.deepEqual(out, ['a', 'b'], 'the first-chunk window absorbs the slow start; idle applies after');
});

test('InactivityTimeoutPolicy: a first chunk slower than firstChunkMs aborts and names the phase', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 5000, firstChunkMs: 30 });
    let err = /** @type {any} */ (null);
    try {
        for await (const _ of p.wrapStream({ stream: chunksWithDelay({ chunks: ['late'], delayMs: 200 }) })) {}
    } catch (e) { err = e; }
    assert.ok(err, 'the stream must abort before the first chunk');
    assert.equal(err.name, 'AbortError');
    assert.match(err.message, /before first chunk/);
});

test('InactivityTimeoutPolicy: firstChunkMs=0 reuses timeoutMs for the first window (back-compat)', async () => {
    const p = new InactivityTimeoutPolicy({ timeoutMs: 40 });
    assert.equal(p.firstChunkMs, 0);
    let err = /** @type {any} */ (null);
    try {
        for await (const _ of p.wrapStream({ stream: chunksWithDelay({ chunks: ['late'], delayMs: 200 }) })) {}
    } catch (e) { err = e; }
    assert.ok(err);
    assert.doesNotMatch(err.message, /before first chunk/);
});
