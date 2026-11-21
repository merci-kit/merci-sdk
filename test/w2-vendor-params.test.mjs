// @ts-check

/**
 * Wave 2 — the vendor request surface: the unified parameter keys and the
 * prompt-cache breakpoints have to reach the **wire**, not just the unified
 * spec. These tests read the built vendor request, so they fail the moment a
 * translator stops feeding the adapter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import {
    UnifiedParameterBuilder,
    buildParameterMapForOai,
    buildParameterMapForAai,
    buildParameterMapForGai
} from '../lib/messaging/unified-parameter.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/**
 * Builds the unified spec for a backend.
 * @param {{provider: string, apply: (b: any) => any}} arg0
 * @returns {Record<string, any>}
 */
function specFor({ provider, apply }) {
    const builder = new UnifiedParameterBuilder({ model: 'm', provider });
    apply(builder);
    return builder._build();
}

// ── the unified spec ─────────────────────────────────────────────────────────

test('the unified spec carries the vendor request keys', () => {
    const spec = specFor({
        provider: ProviderType.OPENAI,
        apply: (b) => b.serviceTier({ v: 'priority' }).logprobs({ v: true }).logprobsTopK({ v: 3 })
            .previousResponseId({ v: 'resp_1' }).store({ v: true }).promptCacheKey({ v: 'cache-key' })
    });
    assert.equal(spec.serviceTier, 'priority');
    assert.equal(spec.logprobs, true);
    assert.equal(spec.logprobsTopK, 3);
    assert.equal(spec.previousResponseId, 'resp_1');
    assert.equal(spec.store, true);
    assert.equal(spec.promptCacheKey, 'cache-key');
});

test('the OAI translator maps the vendor request keys to their wire names', () => {
    const map = buildParameterMapForOai({ spec: specFor({
        provider: ProviderType.OPENAI,
        apply: (b) => b.serviceTier({ v: 'priority' }).logprobs({ v: true }).logprobsTopK({ v: 3 })
            .previousResponseId({ v: 'resp_1' }).store({ v: true }).promptCacheKey({ v: 'cache-key' })
    }) });
    assert.equal(map.service_tier, 'priority');
    assert.equal(map.logprobs, true);
    assert.equal(map.top_logprobs, 3);
    assert.equal(map.previous_response_id, 'resp_1');
    assert.equal(map.store, true);
    assert.equal(map.prompt_cache_key, 'cache-key');
});

test('a backend that does not support a key warns instead of dropping it silently', () => {
    /** @type {any[]} */
    const warnings = [];
    const emitter = { emit: (/** @type {any} */ name, /** @type {any} */ payload) => { warnings.push(payload); } };
    const builder = new UnifiedParameterBuilder({ model: 'm', provider: ProviderType.ANTHROPIC, eventEmitter: /** @type {any} */ (emitter) });
    builder.store({ v: true });
    builder.previousResponseId({ v: 'resp_1' });
    assert.equal(builder._build().store, undefined);
    assert.equal(warnings.length, 2, 'both unsupported keys warn');
});

// ── the wire ─────────────────────────────────────────────────────────────────

test('the OpenAI request carries the vendor request keys', () => {
    const parameters = buildParameterMapForOai({ spec: specFor({
        provider: ProviderType.OPENAI,
        apply: (b) => b.serviceTier({ v: 'priority' }).logprobs({ v: true }).logprobsTopK({ v: 3 })
            .promptCacheKey({ v: 'cache-key' })
    }) });
    const built = /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'm',
        parameters,
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'completions', provider: ProviderType.OPENAI }
    });
    assert.equal(built.request.service_tier, 'priority');
    assert.equal(built.request.logprobs, true);
    assert.equal(built.request.top_logprobs, 3);
    assert.equal(built.request.prompt_cache_key, 'cache-key');
});

test('the OpenAI Responses request carries the store and the previous response', () => {
    const parameters = buildParameterMapForOai({ spec: specFor({
        provider: ProviderType.OPENAI,
        apply: (b) => b.store({ v: true }).previousResponseId({ v: 'resp_1' }).serviceTier({ v: 'flex' })
    }) });
    const built = /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'm',
        parameters,
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'responses', provider: ProviderType.OPENAI }
    });
    assert.equal(built.request.store, true);
    assert.equal(built.request.previous_response_id, 'resp_1');
    assert.equal(built.request.service_tier, 'flex');
});

test('the Anthropic request marks the stable anchor, never the tail', () => {
    const parameters = buildParameterMapForAai({ spec: specFor({
        provider: ProviderType.ANTHROPIC,
        apply: (b) => b.cachePoints({ v: 2 })
    }) });
    /** @param {Record<string, any>} extra */
    const build = (extra) => /** @type {any} */ (aaiAdapter).buildVendorRequest({
        model: 'm',
        parameters: { ...parameters, ...extra },
        tools: [],
        preparedMessages: [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' }
        ],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { provider: ProviderType.ANTHROPIC }
    }).request;
    /** @param {any} request */
    const markedTexts = (request) => (request.messages ?? [])
        .flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : []))
        .filter((/** @type {any} */ b) => b?.cache_control)
        .map((/** @type {any} */ b) => String(b.text ?? ''));

    // Wave 4: without the session's anchor there is nothing safe to mark. The
    // old contract (mark `slice(-cachePoints)`) marked the volatile tail.
    assert.deepEqual(markedTexts(build({})), [], 'no anchor, no breakpoint');

    // With the anchor the stable block is marked; the tail after it never is.
    const anchored = markedTexts(build({ _cacheAnchor: { text: 'two' } }));
    assert.deepEqual(anchored, ['one', 'two'], 'breakpoints sit on the stable prefix');
    assert.ok(!anchored.includes('three'), 'the tail after the anchor is not marked');
    assert.equal(build({ _cacheAnchor: { text: 'two' } }).messages[1].content[0].cache_control.type, 'ephemeral');
});

test('the Gemini request reports and drops log probabilities (its transport is stream-only)', () => {
    const map = buildParameterMapForGai({ spec: specFor({
        provider: ProviderType.GOOGLE_GENAI,
        apply: (b) => b.logprobs({ v: true }).logprobsTopK({ v: 5 })
    }) });
    // The unified map still carries the request: the parameter layer does not
    // silently forget what the caller asked for.
    assert.equal(map.responseLogprobs, true);
    assert.equal(map.logprobs, 5);
    /** @type {Array<{parameter: string, message: string}>} */
    const warnings = [];
    const built = /** @type {any} */ (gaiAdapter).buildVendorRequest({
        model: 'm',
        parameters: map,
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { provider: ProviderType.GOOGLE_GENAI, eventEmitter: { emit: (/** @type {string} */ name, /** @type {any} */ payload) => { if (name === 'parameter_warning') warnings.push(payload); } } }
    });
    // The wire body must not carry a knob Gemini rejects in streaming mode.
    assert.equal(built.request.config.responseLogprobs, undefined);
    assert.equal(built.request.config.logprobs, undefined);
    assert.equal(warnings.length, 1, 'one warning names the dropped knob');
    assert.equal(warnings[0].parameter, 'logprobs');
});
