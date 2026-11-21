// @ts-check
/**
 * The transport's error surfaces: Google errors expose their response headers
 * (A-5), a local pre-send failure is a ConfigurationError rather than a
 * connection error (A-9), and an oversized error body is marked truncated
 * without hiding a retryable status (A-14).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGaiTransport } from '../lib/backends/transport/gai-client.mjs';
import { postJson } from '../lib/backends/transport/http.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import { ExponentialBackoffPolicy, isNonRetryable, isTransientError } from '../lib/support/retry-policy.mjs';

const encoder = new TextEncoder();

/**
 * A response whose body runs past `max_error_body_bytes`, so the shared reader
 * cuts it and reports `truncated`.
 * @param {{status: number, headers?: Record<string, string>}} arg0 -
 * @returns {Response}
 */
function truncatedResponse({ status, headers = {} }) {
    const payload = JSON.stringify({ error: { message: 'x'.repeat(200_000), code: 'invalid_prompt' } });
    const body = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(payload)); },
    });
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Runs `check` with the error-body cap at 1 KiB, restoring the limits after.
 * @param {() => Promise<void>} check -
 * @returns {Promise<void>}
 */
async function withSmallErrorBody(check) {
    setLimits({ values: { max_error_body_bytes: 1_024 } });
    try {
        await check();
    } finally {
        resetLimits();
    }
}

test('A-5 a Google 429 exposes retry-after', async () => {
    const transport = createGaiTransport({
        apiKey: 'test-key',
        fetch: async () => new Response(
            JSON.stringify({ error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } },
        ),
    });
    await assert.rejects(
        transport.models.embedContent({ model: 'gemini-embedding-001', contents: ['hi'] }),
        (/** @type {any} */ error) => {
            assert.equal(error.status, 429);
            assert.equal(error.headers?.get('retry-after'), '3', 'the response headers reach the error');
            assert.equal(Object.keys(error).includes('headers'), false, 'headers stay non-enumerable');
            const decision = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 }).shouldRetry({ error, attempt: 0 });
            assert.equal(decision.delayMs, 3000, 'the retry policy can read the hint');
            return true;
        },
    );
});

test('A-9 a non-Latin1 API key is a ConfigurationError and never fetched', async () => {
    let called = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async () => { called += 1; return new Response('{}'); };
    await assert.rejects(
        postJson({ url: 'http://127.0.0.1:1/x', apiKey: 'ключ', body: {}, fetchImpl }),
        (/** @type {any} */ error) => {
            assert.ok(error instanceof ConfigurationError, `a ConfigurationError, got ${error?.name}`);
            assert.equal(error.option, 'headers');
            assert.notEqual(error.message, 'Connection error.', 'a caller mistake is not a connection failure');
            return true;
        },
    );
    assert.equal(called, 0, 'nothing reaches the wire');
});

test('A-9 an unserialisable body is a ConfigurationError and never fetched', async () => {
    let called = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async () => { called += 1; return new Response('{}'); };
    await assert.rejects(
        postJson({ url: 'http://127.0.0.1:1/x', body: { n: 1n }, fetchImpl }),
        (/** @type {any} */ error) => {
            assert.ok(error instanceof ConfigurationError, `a ConfigurationError, got ${error?.name}`);
            assert.equal(error.option, 'body');
            assert.equal(isNonRetryable({ error }), true, 'a caller mistake is never retried');
            return true;
        },
    );
    assert.equal(called, 0, 'nothing reaches the wire');
});

test('A-14 a truncated 4xx body is not retried', async () => {
    // Only `max_error_body_bytes` is used: it exists on every tree, so the RED
    // for this finding is the behaviour (a cut body stays retryable on base),
    // never a missing limit key.
    await withSmallErrorBody(async () => {
        /** @type {typeof fetch} */
        const fetchImpl = async () => truncatedResponse({ status: 400 });
        await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
            assert.equal(error.status, 400);
            assert.equal(
                new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 }).shouldRetry({ error, attempt: 0 }).retry,
                false,
                'a 4xx is final, and a body we could not read cannot lift that',
            );
            assert.equal(isNonRetryable({ error }), true, 'the cut body is final for every policy');
            assert.equal(isTransientError({ error }), false);
            assert.equal(error.bodyTruncated, true, 'the capped read is reported');
            assert.equal(error.code, undefined, 'the vendor code was outside the cap');
            return true;
        });
    });
});

test('A-14 a truncated 429 body keeps its retry and the retry-after hint', async () => {
    // A-14 was over-broad: a cut body says nothing about a rate limit, and the
    // vendor's `retry-after` was readable before the cut.
    await withSmallErrorBody(async () => {
        /** @type {typeof fetch} */
        const fetchImpl = async () => truncatedResponse({ status: 429, headers: { 'retry-after': '2' } });
        await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
            assert.equal(error.status, 429);
            assert.equal(error.bodyTruncated, true);
            assert.equal(isNonRetryable({ error }), false, 'a 429 is retryable on its status alone');
            const decision = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 }).shouldRetry({ error, attempt: 0 });
            assert.equal(decision.retry, true, 'a rate limit is still retried');
            assert.equal(decision.delayMs, 2000, 'and the server’s hint sets the delay');
            return true;
        });
    });
});

test('A-14 a truncated 503 body stays retryable', async () => {
    await withSmallErrorBody(async () => {
        /** @type {typeof fetch} */
        const fetchImpl = async () => truncatedResponse({ status: 503 });
        await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
            assert.equal(error.status, 503);
            assert.equal(error.bodyTruncated, true);
            assert.equal(isNonRetryable({ error }), false, 'a 5xx is retried; the policy owns the attempt budget');
            assert.equal(isTransientError({ error }), true);
            assert.equal(new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 }).shouldRetry({ error, attempt: 0 }).retry, true);
            return true;
        });
    });
});

test('A-14 a long message is cut with the truncation marker', async () => {
    // A complete body (well under the byte cap) whose message alone is long: the
    // message cap keeps it readable and says it was cut.
    /** @type {typeof fetch} */
    const fetchImpl = async () => new Response('x'.repeat(3_000), { status: 500, headers: { 'content-type': 'text/plain' } });
    await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
        assert.equal(error.status, 500);
        assert.equal(error.bodyTruncated, undefined, 'the body itself was read whole');
        assert.match(error.message, /…\[truncated\]$/, 'the message says it was cut');
        assert.ok(error.message.length < 3_000, `the message is capped, got ${error.message.length} chars`);
        return true;
    });
});

test('W1-7 a body that exactly fills the cap is complete, not truncated', async () => {
    setLimits({ values: { max_error_body_bytes: 1_024 } });
    try {
        /** @type {typeof fetch} */
        const fetchImpl = async () => new Response('x'.repeat(1_024), { status: 503, headers: { 'content-type': 'text/plain' } });
        await assert.rejects(postJson({ url: 'http://127.0.0.1:1/x', body: {}, fetchImpl }), (/** @type {any} */ error) => {
            assert.equal(error.status, 503);
            assert.equal(error.bodyTruncated, undefined, 'an exactly-full body was read whole');
            assert.equal(isNonRetryable({ error }), false);
            assert.equal(isTransientError({ error }), true);
            assert.equal(new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 }).shouldRetry({ error, attempt: 0 }).retry, true, 'a readable 503 still retries');
            return true;
        });
    } finally {
        resetLimits();
    }
});
