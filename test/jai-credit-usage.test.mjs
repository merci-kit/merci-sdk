// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';
import { drainStepWithHooks, runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { log } from '../lib/support/logger.mjs';
import { QuotaAPI } from '../lib/backends/jai-vendor/api.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

const CREDIT_EVENT = { type: 'quota', data: { updated: { license: 'demo', current: { amount: 99.5 }, maximum: { amount: 100 } }, spent: { amount: 0.5 } } };

test('jai consumeStream forwards credit quota events verbatim and adds no token estimate', async () => {
    const raw = {
        [Symbol.asyncIterator]: async function* () {
            yield { type: 'text', content: 'hi' };
            yield CREDIT_EVENT;
        }
    };
    const events = /** @type {any[]} */ ([]);
    for await (const e of /** @type {any} */ (jaiAdapter).consumeStream({ rawStream: raw })) events.push(e);
    assert.equal(events[0].type, 'first_token');
    assert.equal(typeof events[0].latencyMs, 'number');
    assert.deepEqual(events.slice(1), [{ type: 'text', content: 'hi' }, CREDIT_EVENT], 'quota payload passes through unchanged, nothing appended');
});

test('drainStepWithHooks accumulates the last credit payload into usage.credits', async () => {
    async function* step() {
        yield { type: 'text', content: 'answer' };
        yield CREDIT_EVENT;
        yield { type: 'quota', data: { updated: { license: 'demo', current: { amount: 99 }, maximum: { amount: 100 } }, spent: { amount: 0.4 } } };
    }
    const out = await drainStepWithHooks({ gen: step(), tools: [] });
    assert.ok(out.usage.credits, 'usage carries a credits payload');
    assert.equal(/** @type {any} */ (out.usage.credits).updated.current.amount, 99, 'LAST payload wins (post-request snapshot)');
    assert.equal(/** @type {any} */ (out.usage.credits).spent.amount, 0.4);
    assert.equal(out.usage.prompt_tokens, 0, 'no token fields are fabricated for JAI');
});

test('logger.credits renders spent/current/maximum and skips absent fields', () => {
    const out = /** @type {any[]} */ ([]);
    const originalSink = log._sink;
    log.configure({ sink: /** @type {any} */ ({ log: (/** @type {string} */ t) => { out.push(t); }, error: (/** @type {any} */ t) => { out.push(t); }, write: () => {} }) });
    try {
        log.credits({ u: CREDIT_EVENT.data });
        assert.equal(out.at(-1).includes('[CREDITS]'), true);
        assert.equal(out.at(-1).includes('spent=0.5'), true);
        assert.equal(out.at(-1).includes('current=99.5'), true);
        assert.equal(out.at(-1).includes('maximum=100'), true);
        assert.equal(out.at(-1).includes('license=demo'), true);

        const before = out.length;
        log.credits({ u: null });
        log.credits({ u: { updated: { current: {} } } });
        assert.equal(out.length, before, 'nothing printed when no amounts are present');
    } finally {
        log.configure({ sink: originalSink });
    }
});

test('QuotaAPI.get hits POST /quota/get and returns the current Quota payload', async () => {
    let seenPath = null;
    let seenMethod = null;
    const api = new QuotaAPI({ httpClient: {
        streamTimeout: 0,
        /** @param {{path: any, options: any}} arg0 */
        _fetchWithRetry: async ({ path, options }) => {
            seenPath = path;
            seenMethod = options.method;
            return { json: async () => ({ current: { license: 'demo', until: 0, current: { amount: 50 }, maximum: { amount: 100 } } }) };
        }
    } });
    const quota = /** @type {any} */ (await api.get());
    assert.equal(seenPath, '/quota/get');
    assert.equal(seenMethod, 'POST');
    assert.equal(quota.license, 'demo');
    assert.equal(quota.current.amount, 50);
    assert.equal(quota.maximum.amount, 100);
});

test('runAgenticLoop RUN_END usage carries the credits payload for JAI', async () => {
    const events = /** @type {any[]} */ ([]);
    const session = {
        provider: ProviderType.JAI,
        model: 'test-model',
        _tools: [],
        eventEmitter: { emit: (/** @type {any} */ name, /** @type {any} */ payload) => events.push({ name, payload }) },
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            yield { type: 'text', content: 'answer' };
            yield CREDIT_EVENT;
            return { done: true, content: 'answer', messages };
        },
    };
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: ProviderType.JAI, content: 'hi' })], opts: { maxIterations: 1 } });
    assert.equal(out, 'answer');
    const runEnd = events.find(e => e.name === EVENTS.CLIENT.RUN_END);
    assert.ok(runEnd, 'run:end event is emitted');
    assert.deepEqual(runEnd.payload.usage.credits, CREDIT_EVENT.data, 'credits ride the RUN_END usage');
    assert.equal(runEnd.payload.usage.prompt_tokens, 0, 'no fabricated token fields for JAI');
});
