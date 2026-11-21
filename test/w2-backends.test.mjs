// @ts-check

/**
 * @file Wave-2 backend capabilities (MerciSDK SOTA parity).
 * @description
 * Offline checks for the five wave-2 backend items:
 *   A1 `stream: false` on the OpenAI-compatible backend,
 *   A2 Gemini citations / refusal and the Anthropic refusal,
 *   A3 the Anthropic embeddings contract,
 *   A4 the vendor rate-limit headers,
 *   A5 the vendor-call retry on the OAI / AAI / GAI chat calls.
 * Every check uses a fake vendor client — no network, no sleeping backend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { MerciClient as AaiClient } from '../lib/backends/aai.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import {
    ExponentialBackoffPolicy,
    rateLimitDelayFromError,
    retryAfterFromError,
} from '../lib/support/retry-policy.mjs';

/** @type {any} */
const OAI = oaiAdapter;
/** @type {any} */
const GAI = gaiAdapter;
/** @type {any} */
const AAI = aaiAdapter;

/**
 * Drains an async generator into an array.
 * @param {{gen: any}} arg0
 * @returns {Promise<Array<any>>}
 */
async function collect({ gen }) {
    /** @type {Array<any>} */
    const out = [];
    let r = await gen.next();
    while (!r.done) {
        out.push(r.value);
        r = await gen.next();
    }
    return out;
}

/**
 * A chat-completions response object (the `stream: false` answer).
 * @param {{text?: string, toolCalls?: Array<any>}} [arg0]
 * @returns {Record<string, any>}
 */
function chatCompletion({ text = 'Hello there.', toolCalls = [] } = {}) {
    return {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: text,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
}

/**
 * A deterministic retry policy (no jitter, no sleeping).
 * @param {{maxRetries?: number, initialDelayMs?: number}} [arg0]
 * @returns {ExponentialBackoffPolicy}
 */
function fastPolicy({ maxRetries = 1, initialDelayMs = 1 } = {}) {
    return new ExponentialBackoffPolicy({ maxRetries, initialDelayMs, maxDelayMs: 5, jitterMs: 0 });
}

// ==================================================================================
// A1 — stream: false on the OpenAI-compatible backend
// ==================================================================================

test('A1 stream:false builds a non-streaming request (no stream_options on the wire)', () => {
    const { request } = OAI.buildVendorRequest({
        model: 'gpt-4o',
        parameters: { stream: false },
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'completions' },
    });
    assert.equal(request.stream, false, 'stream:false reaches the wire');
    assert.equal('stream_options' in request, false, 'stream_options is a streaming-only field');
});

test('A1 stream defaults to true when unset', () => {
    const { request } = OAI.buildVendorRequest({
        model: 'gpt-4o',
        parameters: {},
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'completions' },
    });
    assert.equal(request.stream, true);
});

test('A1 stream:false returns the assistant text', async () => {
    /** @type {Array<any>} */
    const bodies = [];
    const vendorClient = {
        chat: {
            completions: {
                create: async (/** @type {any} */ body) => {
                    bodies.push(body);
                    return chatCompletion({ text: 'Hello there.' });
                },
            },
        },
    };
    const { request } = OAI.buildVendorRequest({
        model: 'gpt-4o',
        parameters: { stream: false },
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'completions' },
    });
    const raw = await OAI.executeVendorRequest({ vendorClient, request, signal: undefined, session: {} });
    const events = await collect({ gen: OAI.consumeStream({ rawStream: raw, signal: undefined }) });

    assert.equal(bodies.length, 1, 'one vendor call');
    assert.equal(bodies[0].stream, false);
    assert.equal('stream_options' in bodies[0], false, 'the vendor rejects stream_options next to stream:false');

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    assert.equal(text, 'Hello there.', 'the assistant text reaches the unified stream');
    assert.ok(events.some((e) => e.type === 'first_token'), 'the first-token marker is emitted like in streaming mode');
    const quota = events.find((e) => e.type === 'quota');
    assert.equal(quota?.data?.spent?.amount, 15, 'the usage lands in the same quota event shape');
});

test('A1 stream:false returns the tool calls', async () => {
    const vendorClient = {
        chat: {
            completions: {
                create: async () => chatCompletion({
                    text: '',
                    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"x":1}' } }],
                }),
            },
        },
    };
    const request = { model: 'gpt-4o', messages: [], stream: false };
    const raw = await OAI.executeVendorRequest({ vendorClient, request, signal: undefined, session: {} });
    const events = await collect({ gen: OAI.consumeStream({ rawStream: raw, signal: undefined }) });

    const toolCalls = events.find((e) => e.type === 'tool_calls');
    assert.ok(toolCalls, 'a tool_calls event is emitted');
    assert.equal(toolCalls.calls[0].id, 'call_1');
    assert.equal(toolCalls.calls[0].type, 'function');
    assert.equal(toolCalls.calls[0].function.name, 'ping');
    assert.equal(toolCalls.calls[0].function.arguments, '{"x":1}');
});

test('A1 stream:false maps a Responses object onto the same unified events', async () => {
    const vendorClient = {
        responses: {
            create: async () => ({
                id: 'resp_1',
                object: 'response',
                status: 'completed',
                output: [
                    { type: 'reasoning', id: 'rs_1', summary: [] },
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'Responses text.', annotations: [] }],
                    },
                    { type: 'function_call', call_id: 'call_r1', name: 'lookup', arguments: '{"q":"x"}' },
                ],
                usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
            }),
        },
    };
    const request = { model: 'gpt-4o', input: [], stream: false, __merciProtocol: 'responses' };
    const raw = await OAI.executeVendorRequest({ vendorClient, request, signal: undefined, session: {} });
    const events = await collect({ gen: OAI.consumeStream({ rawStream: raw, signal: undefined }) });

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    assert.equal(text, 'Responses text.');
    assert.ok(events.some((e) => e.type === 'reasoning_item'), 'reasoning items survive');
    const toolCalls = events.find((e) => e.type === 'tool_calls');
    assert.equal(toolCalls.calls[0].id, 'call_r1');
    assert.equal(toolCalls.calls[0].function.name, 'lookup');
    assert.equal(toolCalls.calls[0].function.arguments, '{"q":"x"}');
    assert.equal(events.find((e) => e.type === 'quota')?.data?.spent?.amount, 10);
});

test('A1 stream:false drives the whole agentic step (the loop is unchanged)', async () => {
    const client = {
        chat: {
            completions: {
                create: async () => chatCompletion({ text: 'Hello there.' }),
            },
        },
    };
    const session = new OaiChatSession({ client, model: 'gpt-4o', eventEmitter: new EventEmitter() });
    session.withParameters({ params: { stream: false } });
    const gen = session.step({ messages: [{ role: 'user', content: 'hi' }] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const state = /** @type {any} */ (r.value);
    assert.equal(state.done, true);
    assert.equal(state.content, 'Hello there.');
});

// ==================================================================================
// A2 — Gemini citations / refusal, Anthropic refusal
// ==================================================================================

test('A2 a Gemini grounding chunk becomes a citation', async () => {
    const stream = (async function* () {
        yield {
            candidates: [{
                content: { parts: [{ text: 'Grounded answer.' }] },
                groundingMetadata: {
                    webSearchQueries: ['merci sdk'],
                    groundingChunks: [
                        { web: { uri: 'https://example.test/a', title: 'Example A' } },
                        { retrievedContext: { uri: 'https://example.test/b', title: 'Example B', text: 'the quoted passage' } },
                    ],
                },
            }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        };
    })();
    const events = await collect({ gen: GAI.consumeStream({ rawStream: stream, signal: undefined }) });

    const citations = events.find((e) => e.type === 'citations');
    assert.ok(citations, 'a citations event is emitted');
    assert.deepEqual(citations.data.citations, [
        { uri: 'https://example.test/a', title: 'Example A', text: '' },
        { uri: 'https://example.test/b', title: 'Example B', text: 'the quoted passage' },
    ]);
    const sources = events.find((e) => e.type === 'sources');
    assert.equal(sources.data.sources[0].url, 'https://example.test/a', 'the plain sources tail is emitted next to it');
});

test('A2 a Gemini blocked finish reason is a refusal', async () => {
    const stream = (async function* () {
        yield { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] };
    })();
    const events = await collect({ gen: GAI.consumeStream({ rawStream: stream, signal: undefined }) });
    const error = events.find((e) => e.type === 'error');
    assert.ok(error, 'a refusal is surfaced as an error event');
    assert.equal(error.error_type, 'SAFETY', 'the vendor reason stays in error_type');
    assert.equal(error.refusal, true, 'the machine-readable refusal flag is set');
    assert.equal(error.refusal_reason, 'SAFETY');
});

test('A2 every Gemini refusal finish reason sets the refusal flag (incl. the IMAGE_* pair)', async () => {
    for (const finishReason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']) {
        const stream = (async function* () {
            yield { candidates: [{ finishReason, content: { parts: [] } }] };
        })();
        const events = await collect({ gen: GAI.consumeStream({ rawStream: stream, signal: undefined }) });
        const error = events.find((e) => e.type === 'error');
        assert.ok(error, `${finishReason} is surfaced as an error event`);
        assert.equal(error.refusal, true, `${finishReason} is a refusal`);
        assert.equal(error.refusal_reason, finishReason);
        assert.equal(error.error_type, finishReason, 'the vendor reason stays in error_type');
    }
});

test('A2 a non-refusal Gemini finish reason is not a refusal (IMAGE_OTHER)', async () => {
    const stream = (async function* () {
        yield { candidates: [{ finishReason: 'IMAGE_OTHER', content: { parts: [] } }] };
    })();
    const events = await collect({ gen: GAI.consumeStream({ rawStream: stream, signal: undefined }) });
    const error = events.find((e) => e.type === 'error');
    assert.ok(error, 'the reason still surfaces as an error event');
    assert.equal(error.error_type, 'IMAGE_OTHER');
    assert.equal(error.refusal, undefined, 'IMAGE_OTHER is not a safety refusal');
});

test('A2 a blocked Gemini promptFeedback.blockReason is a refusal', async () => {
    for (const blockReason of ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY']) {
        const stream = (async function* () {
            yield { promptFeedback: { blockReason }, candidates: [{ content: { parts: [] } }] };
        })();
        const events = await collect({ gen: GAI.consumeStream({ rawStream: stream, signal: undefined }) });
        const error = events.find((e) => e.type === 'error');
        assert.ok(error, `${blockReason} is surfaced as an error event`);
        assert.equal(error.refusal, true, `${blockReason} is a refusal`);
        assert.equal(error.refusal_reason, blockReason);
    }
    const other = (async function* () {
        yield { promptFeedback: { blockReason: 'OTHER' }, candidates: [{ content: { parts: [] } }] };
    })();
    const otherEvents = await collect({ gen: GAI.consumeStream({ rawStream: other, signal: undefined }) });
    assert.equal(otherEvents.find((e) => e.type === 'error')?.refusal, undefined, 'OTHER is not a safety refusal');
});

test('A2 an Anthropic stop_reason refusal is a refusal', async () => {
    const stream = (async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } };
        yield { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 3 } };
    })();
    const events = await collect({ gen: AAI.consumeStream({ rawStream: stream, signal: undefined }) });
    const error = events.find((e) => e.type === 'error');
    assert.ok(error, 'a refusal is surfaced as an error event');
    assert.equal(error.error_type, 'refusal');
    assert.equal(error.refusal, true);
    assert.equal(error.refusal_reason, 'refusal');
});

test('A2 an Anthropic citation becomes a citation with the quoted text', async () => {
    const stream = (async function* () {
        yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
                type: 'citations_delta',
                citation: {
                    type: 'web_search_result_location',
                    url: 'https://example.test/doc',
                    title: 'The doc',
                    cited_text: 'the cited sentence',
                },
            },
        };
    })();
    const events = await collect({ gen: AAI.consumeStream({ rawStream: stream, signal: undefined }) });
    const citations = events.find((e) => e.type === 'citations');
    assert.ok(citations, 'a citations event is emitted');
    assert.deepEqual(citations.data.citations, [
        { uri: 'https://example.test/doc', title: 'The doc', text: 'the cited sentence' },
    ]);
});

test('A2 the Anthropic max_tokens stop reason still truncates (unchanged)', async () => {
    const stream = (async function* () {
        yield { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
    })();
    const events = await collect({ gen: AAI.consumeStream({ rawStream: stream, signal: undefined }) });
    assert.ok(events.some((e) => e.type === 'truncated'));
    assert.equal(events.some((e) => e.type === 'error'), false, 'a truncation is not a refusal');
});

// ==================================================================================
// A3 — Anthropic embeddings
// ==================================================================================

test('A3 the Anthropic embed() throws a typed ConfigurationError naming the providers that embed', async () => {
    const client = new AaiClient({ options: { apiKey: 'sk-test' } });
    await assert.rejects(
        () => /** @type {any} */ (client).embed({ input: 'hello', model: 'text-embedding-3-small' }),
        (/** @type {any} */ err) => {
            assert.ok(err instanceof ConfigurationError, 'a typed ConfigurationError, not a TypeError');
            assert.match(err.message, /Anthropic provides no embeddings endpoint/);
            assert.match(err.message, /OpenAI or Google/);
            return true;
        },
    );
});

// ==================================================================================
// A4 — the vendor rate-limit headers
// ==================================================================================

test('A4 a rate-limit header becomes the retry delay (OpenAI x-ratelimit-reset-*)', () => {
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'x-ratelimit-reset-requests': '2' },
    });
    assert.equal(rateLimitDelayFromError({ error }), 2000);
});

test('A4 the Anthropic rate-limit reset timestamp becomes the retry delay', () => {
    const reset = new Date(Date.now() + 5000).toISOString();
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'anthropic-ratelimit-requests-reset': reset } },
    });
    const delay = rateLimitDelayFromError({ error });
    assert.ok(delay !== null && delay > 3000 && delay <= 5000, `expected ~5s, got ${delay}`);
});

test('A4 an exhausted Anthropic tokens bucket waits for its reset', () => {
    const reset = new Date(Date.now() + 4000).toISOString();
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: {
            'anthropic-ratelimit-tokens-remaining': '0',
            'anthropic-ratelimit-tokens-reset': reset,
        },
    });
    const delay = rateLimitDelayFromError({ error });
    assert.ok(delay !== null && delay > 2000 && delay <= 4000, `expected ~4s, got ${delay}`);
});

test('A4 retry-after-ms wins over the vendor rate-limit headers', () => {
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after-ms': '1500', 'x-ratelimit-reset-requests': '30' },
    });
    assert.equal(rateLimitDelayFromError({ error }), 1500);
});

test('A4 the headers are read from a Headers instance, a plain object and the cause chain', () => {
    const headers = new Headers({ 'x-ratelimit-reset-tokens': '3' });
    const error = Object.assign(new Error('fetch failed'), { status: 429, response: { headers } });
    assert.equal(rateLimitDelayFromError({ error }), 3000);

    const chained = Object.assign(new Error('fetch failed'), { status: 429 });
    chained.cause = Object.assign(new Error('429'), { headers: { 'x-ratelimit-reset-requests': '4' } });
    assert.equal(rateLimitDelayFromError({ error: chained }), 4000);
});

test('A4 the retry policy waits for the vendor rate-limit header', () => {
    const policy = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'x-ratelimit-reset-requests': '2' },
    });
    const decision = policy.shouldRetry({ error, attempt: 0 });
    assert.equal(decision.retry, true);
    assert.equal(decision.delayMs, 2000, 'the vendor hint wins over the exponential window');
});

test('A4 retryAfterFromError keeps its old contract (retry-after only)', () => {
    const withRetryAfter = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': '2' },
    });
    assert.equal(retryAfterFromError({ error: withRetryAfter }), 2000);
    const withVendorHeader = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'x-ratelimit-reset-requests': '2' },
    });
    assert.equal(retryAfterFromError({ error: withVendorHeader }), null, 'the old helper ignores the vendor headers');
});

// ==================================================================================
// A5 — the vendor-call retry on the OAI / AAI / GAI chat calls
// ==================================================================================

test('A5 a transient 429 is retried once (OAI chat)', async () => {
    let calls = 0;
    const vendorClient = {
        chat: {
            completions: {
                create: async () => {
                    calls++;
                    if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
                    return (async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; })();
                },
            },
        },
    };
    const session = { _retryPolicy: fastPolicy({ maxRetries: 1 }) };
    const raw = await OAI.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: true },
        signal: undefined,
        session,
    });
    assert.equal(calls, 2, 'the vendor call is retried once');
    const events = await collect({ gen: OAI.consumeStream({ rawStream: raw, signal: undefined }) });
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.content).join(''), 'ok');
});

test('A5 a transient 429 is retried once (AAI messages)', async () => {
    let calls = 0;
    const vendorClient = {
        messages: {
            stream: async () => {
                calls++;
                if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
                return (async function* () { yield { type: 'message_start', message: { usage: {} } }; })();
            },
        },
    };
    await AAI.executeVendorRequest({
        vendorClient,
        request: { model: 'claude', messages: [], stream: true },
        signal: undefined,
        session: { _retryPolicy: fastPolicy({ maxRetries: 1 }) },
    });
    assert.equal(calls, 2, 'the vendor call is retried once');
});

test('A5 a transient 429 is retried once (GAI generateContentStream)', async () => {
    let calls = 0;
    const vendorClient = {
        models: {
            generateContentStream: async () => {
                calls++;
                if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
                return (async function* () { yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }; })();
            },
        },
    };
    await GAI.executeVendorRequest({
        vendorClient,
        request: { model: 'gemini-2.0-flash', contents: [], config: {} },
        signal: undefined,
        session: { _retryPolicy: fastPolicy({ maxRetries: 1 }) },
    });
    assert.equal(calls, 2, 'the vendor call is retried once');
});

test('A5 a 400 is not retried (OAI chat)', async () => {
    let calls = 0;
    const vendorClient = {
        chat: {
            completions: {
                create: async () => {
                    calls++;
                    throw Object.assign(new Error('bad request'), { status: 400 });
                },
            },
        },
    };
    await assert.rejects(() => OAI.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: true },
        signal: undefined,
        session: { _retryPolicy: fastPolicy({ maxRetries: 3 }) },
    }), /bad request/);
    assert.equal(calls, 1, 'a non-retryable 4xx fails the call at once');
});

test('A5 a session without a policy is not retried (unchanged behavior)', async () => {
    let calls = 0;
    const vendorClient = {
        chat: {
            completions: {
                create: async () => {
                    calls++;
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                },
            },
        },
    };
    await assert.rejects(() => OAI.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: true },
        signal: undefined,
        session: {},
    }), /rate limited/);
    assert.equal(calls, 1, 'no policy configured means no retry');
});

test('A5 the retry respects the session elapsed budget', async () => {
    let calls = 0;
    const vendorClient = {
        chat: {
            completions: {
                create: async () => {
                    calls++;
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                },
            },
        },
    };
    await assert.rejects(() => OAI.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: true },
        signal: undefined,
        session: {
            _retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 5000, maxDelayMs: 5000, jitterMs: 0 }),
            _maxElapsedMs: 10,
        },
    }), /rate limited/);
    assert.equal(calls, 1, 'a backoff that would overshoot the budget is skipped');
});

test('A5 the retry never runs after an abort', async () => {
    let calls = 0;
    const controller = new AbortController();
    const vendorClient = {
        chat: {
            completions: {
                create: async () => {
                    calls++;
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                },
            },
        },
    };
    const pending = OAI.executeVendorRequest({
        vendorClient,
        request: { model: 'gpt-4o', messages: [], stream: true },
        signal: controller.signal,
        session: {
            _retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 5000, maxDelayMs: 5000, jitterMs: 0 }),
        },
    });
    setTimeout(() => controller.abort(new Error('user cancel')), 10);
    await assert.rejects(() => pending, (/** @type {any} */ err) => err.name === 'AbortedError' || err.name === 'AbortError');
    assert.equal(calls, 1, 'the aborted backoff is not retried');
});
