// @ts-check
/**
 * @file `initializeClient` hands the caller's options to the backend constructor.
 * @version 0.23.0
 *
 * @description
 * A2-1: the client was built from credentials only, so `transportOptions.fetch`
 * never reached the transport and every option a constructor refuses was
 * accepted silently. Both facts are asserted here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initializeClient } from '../lib/index.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

const SSE_BODY = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"}}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
].join('\n');

/**
 * A fetch that answers one SSE completion and never opens a socket.
 * @returns {{fetch: typeof fetch, calls: Array<string>}}
 */
function stubFetch() {
    /** @type {Array<string>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
        calls.push(String(url));
        return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    return { fetch: fetchImpl, calls };
}

/**
 * Drains a `step()` generator and returns its final state.
 * @param {AsyncGenerator<Object, any, Array<Object>|null|undefined>} gen
 * @returns {Promise<any>}
 */
async function drain(gen) {
    let result = await gen.next();
    while (!result.done) result = await gen.next();
    return result.value;
}

test('initializeClient refuses anthropicOptions and forwards transportOptions.fetch', async () => {
    await assert.rejects(
        () => initializeClient({ provider: 'anthropic', options: { apiKey: 'k', anthropicOptions: {} } }),
        (/** @type {any} */ error) => {
            assert.ok(error instanceof ConfigurationError, 'the refusal is a ConfigurationError');
            assert.match(error.message, /anthropicOptions is no longer supported/);
            return true;
        },
    );

    const { fetch, calls } = stubFetch();
    const { client } = await initializeClient({
        provider: 'openai',
        options: { apiKey: 'k', baseURL: 'http://127.0.0.1:9/v1', transportOptions: { fetch } },
    });
    const state = await drain(client.session('gpt-test').step({ messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(calls.length, 1, 'the stub received the request');
    assert.match(calls[0], /\/chat\/completions$/, 'the request went to the configured baseURL');
    assert.equal(state.content, 'ok', 'the stubbed stream is the answer');
});
