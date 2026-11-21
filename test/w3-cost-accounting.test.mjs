// @ts-check

/**
 * Wave 3.1 — the price table is gone.
 *
 * The SDK never estimates a price: a static table of list prices is a
 * snapshot that drifts, and a budget computed from a stale snapshot silently
 * under- or over-states itself. The money budget follows the amount **the
 * backend reported** with its usage; the token budget is the budget
 * mechanism.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { vendorCostUsd, quotaEvent } from '../lib/backends/adapters/adapter-common.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { createStreamingRetryPolicy } from '../lib/support/retry-policy.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

test('W3.1: the price table is gone from the public surface', async () => {
    const sdk = await import('../lib/index.mjs');
    for (const name of ['MODEL_PRICING', 'PRICING_SNAPSHOT_DATE', 'PRICING_CURRENCY', 'estimateCostUsd', 'resolveModelPricing', 'mergePricingTable']) {
        assert.equal(name in sdk, false, `${name} must not be exported any more`);
    }
    assert.equal(typeof (/** @type {any} */ (sdk.ChatSessionBuilder.prototype)).withPricing, 'undefined', 'the price-table override is gone');
});

test('W3.1: the vendor cost is read from what the backend reported', () => {
    assert.equal(vendorCostUsd({ usage: { cost: 0.0123 } }), 0.0123);
    assert.equal(vendorCostUsd({ usage: { cost_usd: 0.5 } }), 0.5);
    assert.equal(vendorCostUsd({ usage: { total_cost: 2 } }), 2);
    assert.equal(vendorCostUsd({ usage: { prompt_tokens: 10 } }), null, 'no reported cost is unknown');
    assert.equal(vendorCostUsd({ usage: null }), null);
    assert.equal(vendorCostUsd({ usage: { cost: 'free' } }), null, 'a non-numeric cost is not a cost');
    assert.equal(vendorCostUsd({ usage: { cost: Number.NaN } }), null, 'a NaN cost is not a cost');
});

test('W3.1: the quota event carries the reported cost and omits it otherwise', () => {
    assert.equal(quotaEvent({ prompt: 1, completion: 2, costUsd: 0.25 }).data.cost_usd, 0.25);
    assert.equal('cost_usd' in quotaEvent({ prompt: 1, completion: 2 }).data, false, 'an unreported cost is omitted, not zero');
});

test('W3.1: the OpenAI-compatible adapter carries the gateway-reported cost', async () => {
    const vendorClient = {
        chat: {
            completions: {
                create: async () => ({
                    id: 'chatcmpl-1',
                    object: 'chat.completion',
                    created: 1,
                    model: 'gpt-4o',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
                    // A gateway (OpenRouter, LiteLLM, a private gateway) reports
                    // the money it charged next to the tokens.
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.007 },
                }),
            },
        },
    };
    const raw = await oaiAdapter.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: false },
        signal: undefined,
        session: {}
    });
    /** @type {any[]} */
    const events = [];
    for await (const event of oaiAdapter.consumeStream({ rawStream: raw, signal: undefined })) events.push(event);
    const quota = events.find((e) => e.type === 'quota');
    assert.equal(quota?.data?.cost_usd, 0.007, 'the gateway-reported cost reaches the quota event');
});

test('W3.1: a vendor that reports no cost produces no cost', async () => {
    const vendorClient = {
        chat: {
            completions: {
                create: async () => ({
                    id: 'chatcmpl-1',
                    object: 'chat.completion',
                    created: 1,
                    model: 'gpt-4o',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }),
            },
        },
    };
    const raw = await oaiAdapter.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: false },
        signal: undefined,
        session: {}
    });
    /** @type {any[]} */
    const events = [];
    for await (const event of oaiAdapter.consumeStream({ rawStream: raw, signal: undefined })) events.push(event);
    const quota = events.find((e) => e.type === 'quota');
    assert.equal('cost_usd' in (quota?.data ?? {}), false, 'the SDK never invents a cost');
});

test('W3.1: the run cost is the SUM of the steps that reported one', async () => {
    let round = 0;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'gpt-4o',
        _tools: [{ name: 'noop', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }],
        eventEmitter: new EventEmitter(),
        /**
         * @param {{messages: any[]}} arg0
         */
        async *step({ messages }) {
            round += 1;
            yield { type: 'quota', data: { prompt_tokens: 10, completion_tokens: 5, cost_usd: round === 1 ? 0.5 : 0.75 } };
            if (round === 1) {
                yield { type: 'tool_request', calls: [{ id: 'c1', name: 'noop', args: '{}' }] };
                return { done: true, content: '', messages: [...messages] };
            }
            return { done: true, content: 'hi', messages: [...messages, { role: 'assistant', content: 'hi' }] };
        }
    };
    /** @type {any[]} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(round, 2, 'the tool round made two steps');
    assert.equal(ends[0].usage.cost_usd, 1.25, 'the run cost is the sum of the steps, not the largest one');
});

test('W3.1: the unenforceable-budget notice fires once per run, not once per retry', async () => {
    let calls = 0;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'gpt-4o',
        _tools: [{ name: 'noop', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }],
        _budget: { maxBudgetUsd: 1 },
        eventEmitter: new EventEmitter(),
        /**
         * @param {{messages: any[]}} arg0
         */
        async *step({ messages }) {
            calls += 1;
            if (calls === 2) {
                const err = new Error('transient vendor failure');
                /** @type {any} */ (err).status = 503;
                throw err;
            }
            yield { type: 'quota', data: { prompt_tokens: 10, completion_tokens: 5 } };
            if (calls === 1 || calls === 3) {
                yield { type: 'tool_request', calls: [{ id: `c${calls}`, name: 'noop', args: '{}' }] };
                return { done: true, content: '', messages: [...messages] };
            }
            return { done: true, content: 'hi', messages: [...messages, { role: 'assistant', content: 'hi' }] };
        }
    };
    /** @type {any} */ (session)._retryPolicy = createStreamingRetryPolicy({ overrides: { initialDelayMs: 1, jitterMs: 0 } });
    /** @type {any[]} */
    const notices = [];
    session.eventEmitter.on(EVENTS.CLIENT.BUDGET_UNREPORTED, (/** @type {any} */ e) => notices.push(e));
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(calls > 2, true, `the step was retried (calls: ${calls})`);
    assert.equal(notices.length, 1, 'the notice fires once for the whole run, not once per attempt');
});

test('W3.1: the Anthropic adapter carries a reported cost and invents none', async () => {
    // The direct Anthropic API reports tokens only — the adapter must not
    // turn them into money.
    const raw = [{
        type: 'message_start',
        message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
    }];
    /** @type {any[]} */
    const events = [];
    for await (const event of aaiAdapter.consumeStream({ rawStream: raw, signal: undefined })) events.push(event);
    const quota = events.find((e) => e.type === 'quota');
    assert.ok(quota, 'the usage still lands in a quota event');
    assert.equal('cost_usd' in quota.data, false, 'no reported cost means no cost');
});
