// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const USER_MSG = [{ type: 'user_message', role: 'user', content: 'ping' }];

function makeHangingAdapter() {
    return {
        vendorName: 'STUB',
        
        /** @param {{ model?: any }} p */
                buildVendorRequest({ model }) { return { request: { model }, observability: { model } }; },
        
        /** @param {{signal: *}} arg0 */
        executeVendorRequest({ signal }) {
            return (async function* () {
                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, 10_000);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(t);
                            reject(signal.reason ?? new Error('aborted'));
                        }, { once: true });
                    }
                });
                yield { text: 'never' };
            })();
        },
        
        /** @param {{rawStream: *}} arg0 */
        consumeStream({ rawStream }) {
            return (async function* () {
                for await (const chunk of rawStream) {
                    if (chunk && typeof chunk.text === 'string') yield { type: 'text', content: chunk.text };
                }
            })();
        },
        extractXmlToolCalls() { return []; },
        
        /** @param {{call: *}} arg0 */
        formatToolCall({ call }) { return { id: call.id, name: call.name, args: call.args }; },
    };
}

class StubSession extends AbstractChatSession {
    
    /** @param {{adapter: *}} arg0 */
    constructor({ adapter }) {
        super({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: new EventEmitter(), client: null, vendorClient: {} });
        this._adapter = adapter;
    }
}

/**
 * `promise`'s outcome, or a rejection naming the call after `ms`, so a wedged
 * step fails the test instead of hanging the whole run.
 * @param {{promise: Promise<unknown>, ms: number, label: string}} arg0
 * @returns {Promise<unknown>}
 */
async function settledWithin({ promise, ms, label }) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} still pending after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, deadline]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

test('withTimeout: maps a number and an object onto the stream policy + total cap', () => {
    const s =  (new StubSession({ adapter: makeHangingAdapter() }));

    s.withTimeout({ timeout: 1234 });
    assert.equal(s._streamTimeoutPolicy.timeoutMs, 1234);
    assert.equal(s._streamTimeoutPolicy.firstChunkMs, 0);
    assert.equal(s._totalTimeoutMs, 0);

    s.withTimeout({ timeout: { firstChunkMs: 200, chunkMs: 5000, totalMs: 9000 } });
    assert.equal(s._streamTimeoutPolicy.timeoutMs, 5000);
    assert.equal(s._streamTimeoutPolicy.firstChunkMs, 200);
    assert.equal(s._totalTimeoutMs, 9000);
    assert.equal(s._headerTimeoutMs, 200, 'JAI header (TTFB) budget mirrors firstChunkMs');
});

test('a request phase that ignores its signal still ends at totalMs', async () => {
    const adapter = /** @type {any} */ (makeHangingAdapter());
    // The A-2 shape: a request that never settles and never reads its signal.
    adapter.executeVendorRequest = () => new Promise(() => {});
    const s = (new StubSession({ adapter }));
    s._retryPolicy = null;
    s.withTimeout({ timeout: { totalMs: 120, chunkMs: 60_000 } });

    const started = Date.now();
    const outcome = await settledWithin({
        promise: (async () => {
            for await (const _ of s.step({ messages: USER_MSG })) { /* drain */ }
            return null;
        })().then(() => null, (error) => error),
        ms: 2000,
        label: 'a step whose request phase ignores its signal',
    });
    const elapsed = Date.now() - started;
    assert.ok(outcome instanceof Error, 'the step must reject instead of waiting forever');
    assert.equal(/** @type {any} */ (outcome).code, 'STEP_TIMEOUT');
    assert.ok(elapsed < 1500, `ended at its own deadline, not never (${elapsed}ms)`);
});

test('a total-timeout on the continuation path keeps the STEP_TIMEOUT code', async () => {
    const adapter = /** @type {any} */ (makeHangingAdapter());
    // First chunk arrives; the continuation never does, so the stream guard,
    // not the request race, surfaces the total deadline.
    adapter.executeVendorRequest = () => (async function* () {
        yield { text: 'first' };
        await new Promise(() => { /* the rest of the stream never arrives */ });
    })();
    const s = (new StubSession({ adapter }));
    s._retryPolicy = null;
    s.withTimeout({ timeout: { totalMs: 150, chunkMs: 60_000 } });

    const outcome = await settledWithin({
        promise: (async () => {
            for await (const _ of s.step({ messages: USER_MSG })) { /* drain */ }
            return null;
        })().then(() => null, (error) => error),
        ms: 2500,
        label: 'a step whose continuation never arrives',
    });
    assert.ok(outcome instanceof Error, 'the step must reject instead of waiting forever');
    assert.equal(/** @type {any} */ (outcome).code, 'STEP_TIMEOUT', 'one deadline has one error shape on every path');
});

test('withTimeout({ totalMs }): a hanging step aborts instead of waiting forever', async () => {
    const s =  (new StubSession({ adapter: makeHangingAdapter() }));
    s._retryPolicy = null;
    s.withTimeout({ timeout: { totalMs: 40, chunkMs: 60_000 } });

    let err =  (null);
    const started = Date.now();
    try {
        for await (const _ of s.step({ messages: USER_MSG })) { /* drain */ }
    } catch (e) { err = e; }
    assert.ok(err, 'the step must abort');
    assert.ok(Date.now() - started < 5000, 'aborted promptly, not after the 10s hang');
    assert.match(String(/** @type {any} */ (err).message), /abort|timeout/i);
});
