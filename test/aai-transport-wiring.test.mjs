// @ts-check
/**
 * @file MerciClient construction wires the native Anthropic transport.
 * @version 0.22.0
 *
 * @description
 * The client builds `createAaiTransport` — not `@anthropic-ai/sdk` — with the
 * same closed `transportOptions` surface as the OAI client, the documented
 * base-URL precedence, and the vendor option bag refused by name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MerciClient } from '../lib/backends/aai.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { DEFAULT_ANTHROPIC_URL } from '../lib/core/constants/index.mjs';

const ENV_KEY = 'ANTHROPIC_BASE_URL';

/**
 * A fetch that records each URL and answers one empty models page.
 * @returns {{fetch: typeof fetch, urls: Array<string>, headers: Array<Headers>}}
 */
function urlRecorder() {
    /** @type {Array<string>} */
    const urls = [];
    /** @type {Array<Headers>} */
    const headers = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
        urls.push(String(url));
        headers.push(new Headers(/** @type {any} */ (init).headers));
        return new Response('{"data":[],"has_more":false,"first_id":null,"last_id":null}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetch: fetchImpl, urls, headers };
}

/**
 * Runs `fn` with `ANTHROPIC_BASE_URL` set to `baseURL` (deleted when undefined),
 * restoring the ambient value afterwards.
 * @param {{baseURL?: string, fn: () => Promise<void>|void}} arg0
 * @returns {Promise<void>}
 */
async function withAnthropicEnv({ baseURL, fn }) {
    const saved = process.env[ENV_KEY];
    if (baseURL === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = baseURL;
    try {
        await fn();
    } finally {
        if (saved === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = saved;
    }
}

test('client: builds the native transport, non-enumerably', () => {
    const client = /** @type {any} */ (new MerciClient({ options: { apiKey: 'test-key' } }));
    const descriptor = Object.getOwnPropertyDescriptor(client, 'transport');
    assert.ok(descriptor, 'transport is an own property');
    assert.equal(descriptor.enumerable, false, 'non-enumerable');
    assert.equal(descriptor.writable, true, 'replaceable');
    assert.equal(descriptor.configurable, true, 'configurable');
    assert.equal(typeof client.transport.messages.stream, 'function', 'messages.stream');
    assert.equal(typeof client.transport.models.list, 'function', 'models.list');
    assert.equal(client.transport.maxRetries, 0, 'the transport never retries');
    assert.equal(client.transport.baseURL, DEFAULT_ANTHROPIC_URL);
});

test('client: anthropicOptions is a ConfigurationError pointing at baseURL and transportOptions', () => {
    assert.throws(() => new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test',
        anthropicOptions: { timeout: 5_000 },
    } }), (/** @type {any} */ error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /anthropicOptions/);
        assert.match(error.message, /baseURL/);
        assert.match(error.message, /transportOptions/);
        return true;
    });
});

test('client: transportOptions.maxRetries 2 is a ConfigurationError', () => {
    assert.throws(() => new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test',
        transportOptions: { maxRetries: 2 },
    } }), ConfigurationError);
});

test('client: an unknown transportOptions key throws naming the key', () => {
    assert.throws(() => new MerciClient({ options: {
        apiKey: 'test-key',
        baseURL: 'https://example.test',
        transportOptions: { retry: 1 },
    } }), (/** @type {any} */ error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /Unknown transportOptions key 'retry'/);
        return true;
    });
});

test('client: baseURL precedence is explicit > env > default', async () => {
    await withAnthropicEnv({ fn: async () => {
        const explicit = urlRecorder();
        const client = /** @type {any} */ (new MerciClient({ options: {
            apiKey: 'test-key',
            baseURL: 'https://explicit.example',
            transportOptions: { fetch: explicit.fetch },
        } }));
        assert.equal(client.transport.baseURL, 'https://explicit.example');
        await client.transport.models.list();
        assert.equal(explicit.urls[0], 'https://explicit.example/v1/models');
    } });

    await withAnthropicEnv({ baseURL: 'https://env.example', fn: async () => {
        const fromEnv = urlRecorder();
        const client = /** @type {any} */ (new MerciClient({ options: {
            apiKey: 'test-key',
            transportOptions: { fetch: fromEnv.fetch },
        } }));
        assert.equal(client.transport.baseURL, 'https://env.example');
        await client.transport.models.list();
        assert.equal(fromEnv.urls[0], 'https://env.example/v1/models');
    } });

    await withAnthropicEnv({ baseURL: '  ', fn: async () => {
        const blankEnv = urlRecorder();
        const client = /** @type {any} */ (new MerciClient({ options: {
            apiKey: 'test-key',
            transportOptions: { fetch: blankEnv.fetch },
        } }));
        assert.equal(client.transport.baseURL, DEFAULT_ANTHROPIC_URL, 'a blank env key is ignored');
        await client.transport.models.list();
        assert.equal(blankEnv.urls[0], `${DEFAULT_ANTHROPIC_URL}/v1/models`);
    } });
});

test('client: transportOptions.defaultHeaders reach the wire', async () => {
    const recorder = urlRecorder();
    const client = /** @type {any} */ (new MerciClient({ options: {
        apiKey: 'test-key',
        transportOptions: { fetch: recorder.fetch, defaultHeaders: { 'x-merci-test': 'yes' } },
    } }));
    await client.transport.models.list();
    assert.equal(recorder.headers[0].get('x-merci-test'), 'yes');
    assert.equal(recorder.headers[0].get('authorization'), 'Bearer test-key');
    assert.equal(recorder.headers[0].get('anthropic-version'), '2026-10-21');
});

test('client: transport stays replaceable and session() uses the replacement', () => {
    const client = /** @type {any} */ (new MerciClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test' } }));
    const stub = { messages: { stream: async () => ({}) } };
    client.transport = stub;
    assert.equal(client.transport, stub);
    assert.equal(client.session('claude-sonnet-4-5')._vendorClient, stub);
});
