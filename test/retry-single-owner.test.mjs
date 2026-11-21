// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MerciClient as OaiClient } from '../lib/backends/oai.mjs';
import { MerciClient as AaiClient } from '../lib/backends/aai.mjs';
import { MerciClient as GaiClient } from '../lib/backends/gai.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';

test('OAI: the vendor retry layer is disabled (Merci is the single owner)', () => {
    const client = new OaiClient({ options: { apiKey: 'x', baseURL: 'https://example.test/v1' } });
    assert.equal(/** @type {any} */ (client).transport.maxRetries, 0);
});

test('OAI: a positive transport maxRetries is refused (Merci is the single owner)', () => {
    assert.throws(() => new OaiClient({ options: {
        apiKey: 'x',
        baseURL: 'https://example.test/v1',
        transportOptions: { maxRetries: 2 },
    } }), (/** @type {any} */ error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /Merci owns retries/);
        return true;
    });
});

test('AAI: the vendor retry layer is disabled', () => {
    const client = new AaiClient({ options: { apiKey: 'x', baseURL: 'https://example.test' } });
    assert.equal(/** @type {any} */ (client).transport.maxRetries, 0);
});

test('GAI: constructs without a vendor retry layer', () => {
    const client = new GaiClient({ options: { apiKey: 'x' } });
    assert.ok(/** @type {any} */ (client).transport, 'genai client is present');
});

test('session default retry policy is the streaming preset (retries ON)', () => {
    const client = new OaiClient({ options: { apiKey: 'x', baseURL: 'https://example.test/v1' } });
    const session = /** @type {any} */ (client).session('gpt-4o-mini');
    assert.equal(session._retryPolicy.maxRetries, 2);
    assert.equal(session._retryPolicy.initialDelayMs, 500);
    assert.equal(session._retryPolicy.maxDelayMs, 30_000);
});

test('NoRetryPolicy remains available for explicit opt-out', () => {
    assert.equal(new NoRetryPolicy().shouldRetry({ error: new Error('x'), attempt: 0 }).retry, false);
});
