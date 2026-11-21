// @ts-check
/**
 * @file Gemini embeddings retry and honour the caller's signal, like OpenAI's.
 * @version 0.22.0
 *
 * @description
 * `embed()` is the one call whose retry policy lives in the client, not the
 * transport. The Google client must use the same policy (a 503 is retried) and
 * the same abort-aware loop (an aborted signal sends no request at all).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MerciClient } from '../lib/backends/gai.mjs';

/**
 * A fetch answering a queue of responses and counting the calls.
 * @param {Array<Response>} responses
 * @returns {{fetch: typeof fetch, calls: Array<string>}}
 */
function queuedFetch(responses) {
    /** @type {Array<string>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
        calls.push(String(url));
        return responses[Math.min(calls.length - 1, responses.length - 1)];
    };
    return { fetch: fetchImpl, calls };
}

/** @param {unknown} body @param {number} status */
function json(body, status) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('gai embed retries a 503', async () => {
    const { fetch, calls } = queuedFetch([
        json({ error: { code: 503, status: 'UNAVAILABLE', message: 'try again' } }, 503),
        json({ embeddings: [{ values: [0.1, 0.2] }] }, 200),
    ]);
    const client = new MerciClient({ options: { apiKey: 'test-key', embedMaxRetries: 1, embedInitialDelay: 0, transportOptions: { fetch } } });

    const vector = await client.embed({ input: 'hello', model: 'text-embedding-004' });

    assert.deepEqual(vector, [0.1, 0.2]);
    assert.equal(calls.length, 2, 'one retry after the 503');
});

test('gai embed honours an aborted signal', async () => {
    const { fetch, calls } = queuedFetch([json({ embeddings: [{ values: [0.1] }] }, 200)]);
    const client = new MerciClient({ options: { apiKey: 'test-key', transportOptions: { fetch } } });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    await assert.rejects(
        () => client.embed({ input: 'hello', model: 'text-embedding-004', signal: controller.signal }),
        (/** @type {any} */ error) => {
            assert.equal(error.name, 'AbortedError');
            return true;
        },
    );
    assert.equal(calls.length, 0, 'an aborted call sends nothing');
});
