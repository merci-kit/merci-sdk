// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { runAgenticLoop, drainStepWithHooks } from '../lib/agentic/agentic-core.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { truncateForPrompt } from '../lib/support/utils.mjs';

/**
 * @param {{gen: any}} arg0
 */
async function collect({ gen }) {
    const events = [];
    for await (const e of gen) events.push(e);
    return events;
}

describe('OAI adapter truncation signal', () => {
    it("emits a 'truncated' event on finish_reason 'length' (was silent)", async () => {
        const events = await collect({ gen: (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { choices: [{ delta: { content: 'partial answer' }, finish_reason: 'length' }] };
        })() }) });
        assert.ok(events.some(e => e.type === 'text' && e.content === 'partial answer'));
        assert.ok(events.some(e => e.type === 'truncated'),
            'a length finish_reason must surface a truncated event, not a silent done');
    });

    it("does NOT emit 'truncated' on a normal 'stop'", async () => {
        const events = await collect({ gen: (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
        })() }) });
        assert.equal(events.some(e => e.type === 'truncated'), false);
    });

    it("still surfaces non-normal reasons (content_filter) as errors", async () => {
        const events = await collect({ gen: (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { choices: [{ delta: {}, finish_reason: 'content_filter' }] };
        })() }) });
        assert.ok(events.some(e => e.type === 'error'));
    });

    it('a chunk carrying error yields an error event, not silence', async () => {
        const events = await collect({ gen: (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { error: { message: 'quota exceeded', code: 'insufficient_quota' } };
        })() }) });
        assert.equal(events.length, 1, 'an error chunk must not be dropped');
        assert.equal(events[0].type, 'error');
        assert.equal(events[0].error_message, 'quota exceeded');
    });
});

describe('AAI adapter truncation signal', () => {
    it("text without message_stop is 'truncated', not a complete answer", async () => {
        const events = await collect({ gen: (/** @type {any} */ (aaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } };
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer is partial' } };
        })() }) });
        assert.ok(events.some(e => e.type === 'text' && e.content === 'The answer is partial'));
        assert.ok(events.some(e => e.type === 'truncated'),
            'a stream that never reached message_stop must be flagged');
    });

    it('a cut tool_use block is truncated and emits no tool_calls', async () => {
        const events = await collect({ gen: (/** @type {any} */ (aaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { type: 'message_start', message: {} };
            yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } };
        })() }) });
        assert.ok(events.some(e => e.type === 'truncated'));
        assert.equal(events.some(e => e.type === 'tool_calls'), false, 'a half-built tool call must not execute');
    });

    it("does NOT emit 'truncated' after message_stop", async () => {
        const events = await collect({ gen: (/** @type {any} */ (aaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { type: 'message_start', message: {} };
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } };
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
            yield { type: 'message_stop' };
        })() }) });
        assert.equal(events.some(e => e.type === 'truncated'), false);
    });
});

describe('GAI adapter truncation signal', () => {
    it("emits a 'truncated' event on finishReason 'MAX_TOKENS' (was silent)", async () => {
        const events = await collect({ gen: (/** @type {any} */ (gaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial answer' }] } }] };
        })() }) });
        assert.ok(events.some(e => e.type === 'text' && e.content === 'partial answer'));
        assert.ok(events.some(e => e.type === 'truncated'));
    });

    it("does NOT emit 'truncated' on a normal 'STOP'", async () => {
        const events = await collect({ gen: (/** @type {any} */ (gaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } }] };
        })() }) });
        assert.equal(events.some(e => e.type === 'truncated'), false);
    });

    it("text with no finishReason is 'truncated'", async () => {
        const events = await collect({ gen: (/** @type {any} */ (gaiAdapter)).consumeStream({ rawStream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'The answer is partial' }] } }] };
        })() }) });
        assert.ok(events.some(e => e.type === 'text' && e.content === 'The answer is partial'));
        assert.ok(events.some(e => e.type === 'truncated'),
            'a stream that never reported a finishReason must be flagged');
    });
});

describe('runAgenticLoop truncation surfacing', () => {
    /** @returns {any} */
    function makeFakeSession() {
        const session = {
            provider: 'OAI',
            model: 'test-model',
            _tools: [],
            eventEmitter: { emit: () => {} },
            /** @param {{messages: any[], options?: any}} arg0 */
            async *step({ messages }) {
                yield { type: 'text', content: 'partial answer' };
                yield { type: 'quota', data: { prompt_tokens: 100, completion_tokens: 40 } };
                return { done: true, content: 'partial answer', messages, truncated: true };
            },
        };
        return session;
    }

    it('surfaces a truncated final state to the caller', async () => {
        const events = /** @type {any[]} */ ([]);
        const session = makeFakeSession();
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 1,
            onEvent: /** @type {(e: any) => void} */ ((e) => events.push(e)),
        } });
        assert.ok(out.includes('partial answer'));
        assert.ok(out.includes('truncated'), 'the caller must be told the response was truncated');
        assert.ok(events.some(e => e.type === 'truncated'));
    });

    it('accumulates quota usage into the drained final state', async () => {
        const session = makeFakeSession();
        const result = await drainStepWithHooks({ gen: session.step({ messages: [], options: {} }), tools: [] });
        assert.deepEqual(result.usage, {
            prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 0
        });
    });

    it('a TRUNCATED tool round is not terminal — the loop continues with its tool calls', async () => {
        const toolCall = {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        };
        let calls = 0;
        const session = {
            provider: 'OAI',
            model: 'test-model',
            _tools: [],
            eventEmitter: { emit: () => {} },
            /** @param {{messages: any[], options?: any}} arg0 */
            async *step({ messages }) {
                calls++;
                if (calls === 1) {
                    return { done: false, messages: [...messages, toolCall], truncated: true };
                }
                return { done: true, content: 'final answer', messages };
            },
        };
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 3 } });
        assert.equal(calls, 2, 'a truncated tool round must still run its tool calls and continue');
        assert.equal(out, 'final answer');
        assert.ok(!out.includes('truncated'), 'no truncation note when the loop recovered');
    });

    it('JAI: a truncated partial after a tool round retries synthesis instead of returning the fragment', async () => {
        let calls = 0;
        const parameterCalls = [];
        const session = {
            provider: 'jai',
            model: 'test-model',
            _tools: [{ name: 'noop', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }],
            eventEmitter: new EventEmitter(),
            /** @param {{params: any}} arg0 */
            withParameters({ params }) { parameterCalls.push(params); return this; },
            /** @param {{messages: any[]}} arg0 */
            async *step({ messages }) {
                calls++;
                if (calls === 1) {
                    yield { type: 'tool_request', calls: [{ id: 'c1', name: 'noop', args: '{}' }] };
                    return { done: true, content: '', messages: [...messages,
                        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
                        { role: 'tool', tool_call_id: 'c1', name: 'noop', content: 'ok' }] };
                }
                if (calls === 2) {
                    yield { type: 'text', content: 'The deployment' };
                    return { done: true, content: 'The deployment', truncated: true, messages };
                }
                return { done: true, content: 'complete answer', messages };
            },
        };
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'jai', content: 'hi' })], opts: {
            maxIterations: 5,
            maxConsecutiveEmpty: 2,
        } });
        assert.equal(calls, 3, 'the truncated synthesis is retried once');
        assert.equal(out, 'complete answer');
        assert.ok(!out.includes('truncated'), 'the partial fragment is not returned');
        assert.ok(parameterCalls.length >= 1, 'the JAI retry lowers reasoning effort');
    });
});

describe('truncateForPrompt (prompt-data bounding)', () => {
    it('leaves text at exactly the cap intact', () => {
        const at = 'x'.repeat(8000);
        assert.equal(truncateForPrompt({ text: at, maxChars: 8000 }), at);
    });

    it('marks the first character over the cap with exact counts', () => {
        assert.equal(truncateForPrompt({ text: 'x'.repeat(8001), maxChars: 8000 }), `${'x'.repeat(8000)}\n…[truncated 1 of 8001 chars]`);
    });

    it('is a no-op for non-finite/zero caps', () => {
        assert.equal(truncateForPrompt({ text: 'abc', maxChars: 0 }), 'abc');
        assert.equal(truncateForPrompt({ text: 'abc', maxChars: NaN }), 'abc');
    });
});
