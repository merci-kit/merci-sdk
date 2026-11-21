// @ts-check
/**
 * @file The GAI client's transport wiring.
 * @version 0.22.0
 *
 * @description
 * The construction surface the connector tests do not cover: `transport` is a
 * non-enumerable own property, `genaiOptions` is a closed bag, `transportOptions`
 * is the shared four-key bag (`baseURL` is a flat option), the provider follows
 * `vertexai`/`enterprise`, an explicit `baseURL` wins over the derived host, and
 * a Vertex service-account client sends a bearer token it requested exactly once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { MerciClient } from '../lib/backends/gai.mjs';
import { createGaiTransport } from '../lib/backends/transport/gai-client.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {Record<string, any>} options @returns {any} */
function clientWith(options) {
    return new MerciClient({ options });
}

/**
 * Drains a transport stream, returning the chunks it yielded.
 * @param {AsyncIterable<any>} stream
 * @returns {Promise<Array<any>>}
 */
async function collect(stream) {
    /** @type {Array<any>} */
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
}

test('wiring: transport is a non-enumerable own property', () => {
    const client = clientWith({ apiKey: 'test-key' });
    assert.equal(Object.keys(client).includes('transport'), false, 'not enumerable');
    const descriptor = Object.getOwnPropertyDescriptor(client, 'transport');
    assert.equal(descriptor?.enumerable, false);
    assert.equal(descriptor?.writable, true);
    assert.equal(descriptor?.configurable, true);
    assert.equal(typeof client.transport.models.generateContentStream, 'function');
});

test('wiring: unknown genaiOptions key is refused with the supported list', () => {
    assert.throws(
        () => clientWith({ apiKey: 'test-key', genaiOptions: { foo: 1 } }),
        /Unknown genaiOptions key 'foo'\. Supported: vertexai, enterprise, project, location, apiVersion, googleAuthOptions\./,
    );
});

test('wiring: genaiOptions.httpOptions points at transportOptions', () => {
    assert.throws(
        () => clientWith({ apiKey: 'test-key', genaiOptions: { httpOptions: { timeout: 10 } } }),
        /genaiOptions\.httpOptions is not supported: pass options\.transportOptions/,
    );
});

test('wiring: unknown googleAuthOptions key is refused', () => {
    assert.throws(
        () => clientWith({ apiKey: 'test-key', genaiOptions: { googleAuthOptions: { wrong: 1 } } }),
        /Unknown googleAuthOptions key 'wrong'\. Supported: credentials, keyFile, scopes\./,
    );
});

test('wiring: transportOptions stays the shared four-key bag', () => {
    assert.throws(
        () => clientWith({ apiKey: 'test-key', transportOptions: { baseURL: 'http://x' } }),
        /Unknown transportOptions key 'baseURL'\./,
    );
    assert.throws(
        () => clientWith({ apiKey: 'test-key', transportOptions: { maxRetries: 2 } }),
        /maxRetries is not supported/,
    );
});

test('wiring: Gemini vs Vertex provider selection', () => {
    const gemini = clientWith({ apiKey: 'test-key' });
    assert.equal(gemini.provider, ProviderType.GOOGLE_GENAI);
    assert.equal(gemini.transport.vertexai, false);
    assert.equal(gemini.transport.auth, undefined);
    assert.equal(gemini.transport.apiKey, 'test-key');

    const vertex = clientWith({ genaiOptions: { vertexai: true, project: 'p', location: 'global' }, apiKey: 'test-key' });
    assert.equal(vertex.provider, ProviderType.VERTEX);
    assert.equal(vertex.transport.vertexai, true);

    const enterprise = clientWith({ genaiOptions: { enterprise: true, project: 'p', location: 'global' }, apiKey: 'test-key' });
    assert.equal(enterprise.provider, ProviderType.VERTEX, 'enterprise is the historical spelling of vertexai');
    assert.equal(enterprise.transport.vertexai, true);
});

test('wiring: explicit baseURL wins, a blank one throws, the default follows the mode', () => {
    const explicit = clientWith({ apiKey: 'test-key', baseURL: 'http://127.0.0.1:9' });
    assert.equal(explicit.transport.baseURL, 'http://127.0.0.1:9');

    assert.throws(() => clientWith({ apiKey: 'test-key', baseURL: '   ' }), /baseURL must be a non-empty URL string/);

    const gemini = clientWith({ apiKey: 'test-key' });
    assert.equal(gemini.transport.baseURL, 'https://generativelanguage.googleapis.com');

    const global = clientWith({ genaiOptions: { vertexai: true, project: 'p' }, apiKey: 'test-key' });
    assert.equal(global.transport.baseURL, 'https://aiplatform.googleapis.com', 'location defaults to global');

    const regional = clientWith({ genaiOptions: { vertexai: true, project: 'p', location: 'europe-west4' }, apiKey: 'test-key' });
    assert.equal(regional.transport.baseURL, 'https://europe-west4-aiplatform.googleapis.com');
});

test('wiring: Vertex service-account credentials send a bearer token requested once', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const credentials = {
        type: 'service_account',
        client_email: 'svc@merci-project.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    /** @type {Array<{url: string, init: any}>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        const body = String(url).startsWith('https://oauth2.googleapis.com/')
            ? { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 }
            : { models: [] };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = clientWith({
        genaiOptions: {
            vertexai: true,
            project: 'merci-project',
            location: 'global',
            googleAuthOptions: { credentials },
        },
        transportOptions: { fetch: fetchImpl },
    });

    await client.transport.models.list();
    await client.transport.models.list();

    const tokenCalls = calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token');
    const apiCalls = calls.filter((call) => call.url.startsWith('https://aiplatform.googleapis.com/'));
    assert.equal(tokenCalls.length, 1, 'two API calls share one token request');
    assert.equal(apiCalls.length, 2, 'both API calls reached the Vertex host');
    for (const call of apiCalls) {
        const headers = new Headers(call.init.headers);
        assert.equal(headers.get('authorization'), 'Bearer tok-1');
        assert.equal(headers.get('x-goog-api-key'), null, 'a bearer client sends no API key header');
    }
    assert.equal(client.transport.auth.source, 'credentials');
});

test('decodeSse caps each frame, not the read: many small frames in one chunk are all delivered', async () => {
    setLimits({ values: { sse_max_line_bytes: 1_024 } });
    try {
        const body = Array.from({ length: 40 }, (_, i) => `data: ${JSON.stringify({ i, pad: 'x'.repeat(48) })}\n\n`).join('');
        assert.ok(Buffer.byteLength(body, 'utf8') > 1_024, 'the read is larger than the cap');
        /** @type {typeof fetch} */
        const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        const transport = createGaiTransport({ apiKey: 'test-key', fetch: fetchImpl });
        const stream = await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
        const chunks = await collect(stream);
        assert.equal(chunks.length, 40, 'every frame below the cap is delivered');
    } finally {
        resetLimits();
    }
});

test('decodeSse caps a Gemini frame: a 3 MB frame at sse_max_line_bytes raises SSE_LINE_TOO_LONG', async () => {
    setLimits({ values: { sse_max_line_bytes: 1_024 } });
    try {
        const frame = `data: ${JSON.stringify({ t: 'x'.repeat(3 * 1024 * 1024) })}\n\n`;
        /** @type {typeof fetch} */
        const fetchImpl = async () => new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        const transport = createGaiTransport({ apiKey: 'test-key', fetch: fetchImpl });
        const stream = await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
        await assert.rejects(collect(stream), (/** @type {any} */ error) => {
            assert.equal(error.code, 'SSE_LINE_TOO_LONG');
            assert.equal(error.nonRetryable, true);
            assert.match(error.message, /1024/);
            return true;
        });
    } finally {
        resetLimits();
    }
});

