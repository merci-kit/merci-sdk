// @ts-check
/**
 * @file MerciClient construction wires the native OAI transport.
 * @version 0.21.0
 *
 * @description
 * The client builds `createOaiTransport` — not the OpenAI SDK — with the same
 * resolution block, a closed `transportOptions` surface, and the opencode
 * session header on the wire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MerciClient } from '../lib/backends/oai.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import {
    DEFAULT_OPENAI_URL,
    DEFAULT_OPENROUTER_URL,
    DEFAULT_OPENCODE_URL,
    DEFAULT_LOCAL_URL,
} from '../lib/core/constants/index.mjs';

/**
 * A fetch that records each request's headers and answers an empty model list.
 * @returns {{fetch: typeof fetch, calls: Array<Headers>}}
 */
function headerRecorder() {
    /** @type {Array<Headers>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (_url, init) => {
        calls.push(new Headers(/** @type {any} */ (init).headers));
        return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetch: fetchImpl, calls };
}

const PROVIDERS = [
    ['openai', DEFAULT_OPENAI_URL],
    ['openrouter', DEFAULT_OPENROUTER_URL],
    ['opencode', DEFAULT_OPENCODE_URL],
    ['local', DEFAULT_LOCAL_URL],
];

test('client: every provider builds the native transport, non-enumerably', () => {
    for (const [provider, baseURL] of PROVIDERS) {
        const client = /** @type {any} */ (new MerciClient({ options: { provider, apiKey: 'test-key' } }));
        const descriptor = Object.getOwnPropertyDescriptor(client, 'transport');
        assert.ok(descriptor, `${provider}: transport is an own property`);
        assert.equal(descriptor.enumerable, false, `${provider}: transport is non-enumerable`);
        assert.equal(descriptor.writable, true, `${provider}: transport is replaceable`);
        assert.equal(descriptor.configurable, true, `${provider}: transport is configurable`);
        const transport = client.transport;
        assert.equal(typeof transport.chat.completions.create, 'function', `${provider}: chat.completions.create`);
        assert.equal(typeof transport.responses.create, 'function', `${provider}: responses.create`);
        assert.equal(typeof transport.embeddings.create, 'function', `${provider}: embeddings.create`);
        assert.equal(typeof transport.models.list, 'function', `${provider}: models.list`);
        assert.equal(transport.maxRetries, 0, `${provider}: the transport never retries`);
        assert.equal(transport.baseURL, baseURL, `${provider}: baseURL`);
    }
});

test('client: transportOptions.maxRetries 2 is a ConfigurationError', () => {
    assert.throws(() => new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test/v1',
        transportOptions: { maxRetries: 2 },
    } }), ConfigurationError);
});

test('client: an unknown transportOptions key throws naming the key', () => {
    assert.throws(() => new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test/v1',
        transportOptions: { retry: 1 },
    } }), (/** @type {any} */ error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /Unknown transportOptions key 'retry'/);
        return true;
    });
});

test('client: a non-object transportOptions is a ConfigurationError', () => {
    for (const value of ['fast', 5, []]) {
        assert.throws(() => new MerciClient({ options: {
            apiKey: 'test-key',
            baseURL: 'https://example.test/v1',
            transportOptions: value,
        } }), ConfigurationError);
    }
});

test('client: openaiOptions is a ConfigurationError pointing at transportOptions', () => {
    assert.throws(() => new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test/v1',
        openaiOptions: { timeout: 5_000 },
    } }), (/** @type {any} */ error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /openaiOptions/);
        assert.match(error.message, /transportOptions/);
        return true;
    });
});

test('client: transportOptions value shapes are validated', () => {
    for (const transportOptions of [
        { fetch: 'not a function' },
        { defaultHeaders: 'not an object' },
        { defaultHeaders: { 'x-a': 1 } },
        { defaultHeaders: [['x-a', 'v']] },
        { timeout: '5000' },
        { timeout: Number.POSITIVE_INFINITY },
        { timeout: Number.NaN },
    ]) {
        assert.throws(() => new MerciClient({ options: {
            apiKey: 'test-key',
            baseURL: 'https://example.test/v1',
            transportOptions,
        } }), ConfigurationError);
    }
});

test('client: transportOptions.defaultHeaders reach the wire', async () => {
    const { fetch, calls } = headerRecorder();
    const client = /** @type {any} */ (new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test/v1',
        transportOptions: { fetch, defaultHeaders: { 'x-merci-test': 'yes' } },
    } }));
    await client.transport.models.list();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get('x-merci-test'), 'yes');
});

test('client: opencode sends x-opencode-session and a user defaultHeaders value wins', async () => {
    const { fetch, calls } = headerRecorder();
    const defaults = /** @type {any} */ (new MerciClient({ options: {
        provider: 'opencode', apiKey: 'test-key', opencodeSessionId: 'sess-default',
        transportOptions: { fetch },
    } }));
    await defaults.transport.models.list();
    assert.equal(calls[0].get('x-opencode-session'), 'sess-default');

    const overridden = /** @type {any} */ (new MerciClient({ options: {
        provider: 'opencode', apiKey: 'test-key', opencodeSessionId: 'sess-default',
        transportOptions: { fetch, defaultHeaders: { 'x-opencode-session': 'sess-user' } },
    } }));
    await overridden.transport.models.list();
    assert.equal(calls[1].get('x-opencode-session'), 'sess-user');
});

test('client: transport stays replaceable and session() uses the replacement', () => {
    const client = /** @type {any} */ (new MerciClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1' } }));
    const stub = { chat: { completions: { create: async () => ({}) } } };
    client.transport = stub;
    assert.equal(client.transport, stub);
    assert.equal(client.session('gpt-test')._vendorClient, stub);
});
