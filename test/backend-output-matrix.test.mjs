// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { createOaiTransport } from '../lib/backends/transport/oai-client.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';
import { SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { ChatSession as JaiAgenticChatSession } from '../lib/backends/jai.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import {
    createAssistantMessage,
    normalizeToAAI,
    normalizeToOAI,
    normalizeToGAI
} from '../lib/messaging/messages.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { BackendError } from '../lib/core/errors.mjs';

const OAI =  (oaiAdapter);
const AAI =  (aaiAdapter);
const GAI =  (gaiAdapter);
const JAI =  (jaiAdapter);

/** @param {Array<any>} events */
/** @param {{events: *}} arg0 */
const feed = ({ events }) => (async function* () { for (const e of events) yield e; })();


/** @param {AsyncGenerator<any, any, any>|AsyncIterable<any>} gen @returns {Promise<Array<any>>} */
/** @param {{gen: *}} arg0 */
const collect = async ({ gen }) => { const out = []; for await (const e of gen) out.push(e); return out; };


/** @param {AsyncGenerator<any, any, any>} gen */
/** @param {{gen: *}} arg0 */
const drain = async ({ gen }) => { let r = await gen.next(); while (!r.done) r = await gen.next(); return r.value; };


/** @param {Array<any>} events */
/** @param {{events: *}} arg0 */
const types = ({ events }) => events.map(/** @type {(...args: any[]) => any} */ (e => e.type));

describe('OAI — Responses output events', () => {
    /** @param {{events: *}} arg0 */
    const run = ({ events }) => collect({ gen: OAI.consumeStream({ rawStream: feed({ events }) }) });

    test('incomplete(max_output_tokens) surfaces truncated, like finish_reason:length', async () => {
        const out = await run({ events: [
            { type: 'response.output_text.delta', delta: 'partial' },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }
        ] });
        assert.deepEqual(types({ events: out }), ['first_token', 'text', 'truncated']);
    });

    test('incomplete(content_filter) surfaces an error', async () => {
        const out = await run({ events: [
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }
        ] });
        assert.equal(out.length, 1);
        assert.equal(out[0].type, 'error');
        assert.equal(out[0].error_type, 'content_filter');
    });

    test('incomplete with response.error still surfaces the error payload', async () => {
        const out = await run({ events: [{ type: 'response.incomplete', response: { error: { message: 'boom' } } }] });
        assert.equal(out[0].type, 'error');
        assert.equal(out[0].data.message, 'boom');
    });

    test('refusal delta -> text and done -> error (both surfaces)', async () => {
        const out = await run({ events: [
            { type: 'response.refusal.delta', delta: 'I cannot. ' },
            { type: 'response.refusal.done', refusal: 'I cannot. ' }
        ] });
        assert.deepEqual(types({ events: out }), ['first_token', 'text', 'error']);
        assert.equal(out[1].content, 'I cannot. ');
        assert.equal(out[2].error_type, 'refusal');
        assert.equal(out[2].error_message, 'I cannot. ');
    });

    test('refusal done without deltas still yields the refusal text', async () => {
        const out = await run({ events: [{ type: 'response.refusal.done', refusal: 'No.' }] });
        assert.deepEqual(types({ events: out }), ['first_token', 'text', 'error']);
        assert.equal(out[1].content, 'No.');
    });

    test('reasoning deltas -> thought (spec reasoning_text / summary / legacy aliases)', async () => {
        for (const t of ['response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning.delta', 'response.summary_text.delta']) {
            const out = await run({ events: [{ type: t, delta: 'why' }] });
            assert.deepEqual(types({ events: out }), ['first_token', 'thought'], t);
            assert.equal(out[1].content, 'why');
        }
    });

    test('function_call survives without output_item.done via output_item.added', async () => {
        const out = await run({ events: [
            { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'get_weather' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"Paris"}' }
        ] });
        const calls = out.find(e => e.type === 'tool_calls')?.calls;
        assert.ok(Array.isArray(calls) && calls.length === 1, 'the partial call must be emitted');
        assert.equal(calls[0].id, 'c1');
        assert.equal(calls[0].function.name, 'get_weather');
        assert.equal(calls[0].function.arguments, '{"city":"Paris"}');
    });

    test('function_call done confirms and keeps streamed args when the item omits them', async () => {
        const out = await run({ events: [
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' },
            { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'f' } }
        ] });
        const calls = out.find(e => e.type === 'tool_calls').calls;
        assert.equal(calls[0].function.arguments, '{"a":1}');
        assert.equal(calls[0].confirmed, true);
    });

    test('completed usage -> quota with cache_read and reasoning details', async () => {
        const out = await run({ events: [{
            type: 'response.completed',
            response: {
                usage: {
                    total_tokens: 12, input_tokens: 7, output_tokens: 5,
                    input_tokens_details: { cached_tokens: 3 },
                    output_tokens_details: { reasoning_tokens: 2 }
                }
            }
        }] });
        assert.equal(out[0].type, 'quota');
        assert.equal(out[0].data.spent.amount, 12);
        assert.equal(out[0].data.cache_read_input_tokens, 3);
        assert.equal(out[0].data.reasoning_tokens, 2);
    });

    test('response.error and response.failed -> error', async () => {
        const err = await run({ events: [{ type: 'response.error', error: { message: 'x' } }] });
        assert.equal(err[0].type, 'error');
        const failed = await run({ events: [{ type: 'response.failed', response: { error: { message: 'boom' } } }] });
        assert.equal(failed[0].type, 'error');
    });

    test('top-level ResponseErrorEvent (type:error, not response.*) -> error', async () => {
        const out = await run({ events: [{ type: 'error', code: 'server_error', message: 'inference exploded' }] });
        assert.equal(out.length, 1);
        assert.equal(out[0].type, 'error');
        assert.equal(out[0].error_type, 'server_error');
        assert.equal(out[0].error_message, 'inference exploded');
    });

    test('incomplete with no reason and no error payload -> error, never a silent finish', async () => {
        const out = await run({ events: [{ type: 'response.incomplete', response: {} }] });
        assert.equal(out.length, 1);
        assert.equal(out[0].type, 'error');
        assert.equal(out[0].error_type, 'incomplete');
    });

    test('an unknown response.* event is ignored without throwing', async () => {
        const out = await run({ events: [{ type: 'response.mcp_call.in_progress', output_index: 0 }] });
        assert.deepEqual(out, []);
    });
});

describe('OAI — chat-completions output events', () => {
    /** @param {{events: *}} arg0 */
    const run = ({ events }) => collect({ gen: OAI.consumeStream({ rawStream: feed({ events }) }) });

    test('usage -> quota with cache_read and reasoning details', async () => {
        const out = await run({ events: [{
            usage: {
                total_tokens: 9, prompt_tokens: 5, completion_tokens: 4,
                prompt_tokens_details: { cached_tokens: 2 },
                completion_tokens_details: { reasoning_tokens: 1 }
            }
        }] });
        assert.equal(out[0].type, 'quota');
        assert.equal(out[0].data.cache_read_input_tokens, 2);
        assert.equal(out[0].data.reasoning_tokens, 1);
    });

    test('delta.reasoning array -> thought (parts joined)', async () => {
        const out = await run({ events: [{ choices: [{ delta: { reasoning: [{ text: 'a' }, { text: 'b' }] } }] }] });
        assert.deepEqual(types({ events: out }), ['first_token', 'thought']);
        assert.equal(out[1].content, 'ab');
    });

    test('delta.reasoning_details -> thought for text entries, other kinds ignored', async () => {
        const out = await run({ events: [{ choices: [{ delta: { reasoning_details: [
            { type: 'summary', text: 'summary ' },
            { type: 'encrypted', data: 'enc' },
            { type: 'server_tool_call', id: 'stc_1' },
            { type: 'text', text: 'raw' }
        ] } }] }] });
        assert.deepEqual(types({ events: out }), ['first_token', 'thought']);
        assert.equal(out[1].content, 'summary raw');
    });

    test('sparse tool_call indexes are compacted, not holes', async () => {
        const out = await run({ events: [{
            choices: [{
                delta: {
                    tool_calls: [
                        { index: 0, id: 'a', function: { name: 'f', arguments: '{}' } },
                        { index: 2, id: 'b', function: { name: 'g', arguments: '{}' } }
                    ]
                }
            }]
        }] });
        const calls = out.find(e => e.type === 'tool_calls').calls;
        assert.deepEqual(calls.map(/** @type {(...args: any[]) => any} */ (( c) => c.id)), ['a', 'b']);
    });
});

describe('OAI — non-JSON vendor body', () => {
    /** @param {{raw: any}} arg0 */
    const consumeRejects = async ({ raw }) => {
        /** @type {Array<any>} */
        const events = [];
        await assert.rejects(
            async () => { for await (const event of OAI.consumeStream({ rawStream: raw, signal: undefined })) events.push(event); },
            (error) => error instanceof BackendError
                && error.status === 400
                && /non-JSON/i.test(error.message)
                && error.message.includes('Sign in to continue'),
        );
        assert.deepEqual(events, [], 'a bad body must not become a silent empty event stream');
    };

    test('a non-stream chat call answered with HTML fails loudly, with a short body prefix', async () => {
        const vendorClient = {
            chat: { completions: { create: async () => '<html><body>Sign in to continue</body></html>' } },
        };
        const raw = await OAI.executeVendorRequest({
            vendorClient,
            request: { model: 'gpt-test', messages: [], stream: false },
            signal: undefined,
            session: {},
        });
        await consumeRejects({ raw });
    });

    test('a non-stream responses call answered with HTML fails loudly too', async () => {
        const vendorClient = {
            responses: { create: async () => 'Sign in to continue: <html><body>login</body></html>' },
        };
        const raw = await OAI.executeVendorRequest({
            vendorClient,
            request: { model: 'gpt-test', input: [], stream: false, __merciProtocol: 'responses' },
            signal: undefined,
            session: {},
        });
        await consumeRejects({ raw });
    });

    test('a raw string stream is rejected before it can be iterated as characters', async () => {
        await consumeRejects({ raw: '<html><body>Sign in to continue</body></html>' });
    });
});

describe('OAI — truncated stream guard', () => {
    /** @param {{events: *}} arg0 */
    const run = ({ events }) => collect({ gen: OAI.consumeStream({ rawStream: feed({ events }) }) });
    /** @param {{events: Array<any>, type: string}} arg0 */
    const countType = ({ events, type }) => events.filter((event) => event.type === type).length;
    /** @param {{events: Array<any>, sawDone?: boolean}} arg0 */
    const runWithSentinel = ({ events, sawDone = true }) => {
        const source = feed({ events });
        /** @type {any} */ (source).streamState = { sawDone };
        return collect({ gen: OAI.consumeStream({ rawStream: source, signal: undefined }) });
    };

    test('chat text then EOF without finish_reason is truncated once, text preserved', async () => {
        const out = await run({ events: [{ choices: [{ delta: { content: 'half a sent' } }] }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 1);
        assert.equal(out.filter((event) => event.type === 'text').map((event) => event.content).join(''), 'half a sent');
        assert.equal(out[out.length - 1].type, 'truncated', 'the truncation is the last signal');
    });

    test('chat finish_reason stop ends cleanly', async () => {
        const out = await run({ events: [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 0);
    });

    test('chat finish_reason length keeps its single truncated event', async () => {
        const out = await run({ events: [{ choices: [{ delta: { content: 'cut' }, finish_reason: 'length' }] }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 1);
    });

    test('chat tool calls without a finish_reason are truncated once', async () => {
        const out = await run({ events: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 1);
        assert.equal(countType({ events: out, type: 'tool_calls' }), 1);
    });

    test('an empty chat stream is neither truncated nor an error', async () => {
        const out = await run({ events: [] });
        assert.deepEqual(out, []);
    });

    test('responses text then EOF is truncated once', async () => {
        const out = await run({ events: [{ type: 'response.output_text.delta', delta: 'half an ans' }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 1);
        assert.equal(out.filter((event) => event.type === 'text').map((event) => event.content).join(''), 'half an ans');
    });

    test('responses response.completed ends cleanly', async () => {
        const out = await run({ events: [
            { type: 'response.output_text.delta', delta: 'complete' },
            { type: 'response.completed', response: {} },
        ] });
        assert.equal(countType({ events: out, type: 'truncated' }), 0);
    });

    test('responses response.incomplete keeps its existing single truncated', async () => {
        const out = await run({ events: [
            { type: 'response.output_text.delta', delta: 'cut' },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
        ] });
        assert.equal(countType({ events: out, type: 'truncated' }), 1);
    });

    test('a chat [DONE] sentinel is terminal even without finish_reason', async () => {
        const out = await runWithSentinel({ events: [{ choices: [{ delta: { content: 'answered' } }] }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 0);
        assert.equal(countType({ events: out, type: 'text' }), 1);
    });

    test('a responses [DONE] sentinel is terminal even without response.completed', async () => {
        const out = await runWithSentinel({ events: [{ type: 'response.output_text.delta', delta: 'answered' }] });
        assert.equal(countType({ events: out, type: 'truncated' }), 0);
        assert.equal(countType({ events: out, type: 'text' }), 1);
    });

    test('a stream whose streamState says sawDone=false still truncates', async () => {
        const out = await runWithSentinel({ events: [{ choices: [{ delta: { content: 'cut' } }] }], sawDone: false });
        assert.equal(countType({ events: out, type: 'truncated' }), 1);
    });

    test('an error before EOF suppresses the truncation', async () => {
        const responses = await run({ events: [
            { type: 'response.output_text.delta', delta: 'partial' },
            { type: 'response.error', error: { message: 'boom' } },
        ] });
        assert.equal(countType({ events: responses, type: 'truncated' }), 0);
        assert.equal(countType({ events: responses, type: 'error' }), 1);

        const chat = await run({ events: [
            { choices: [{ delta: { content: 'partial' } }] },
            { type: 'error', message: 'boom' },
        ] });
        assert.equal(countType({ events: chat, type: 'truncated' }), 0);
        assert.equal(countType({ events: chat, type: 'error' }), 1);
    });

    test('a caller abort after a content chunk is not truncation', async () => {
        const encoder = new TextEncoder();
        const aborter = new AbortController();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
                controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"more"}}]}\n\n'));
                controller.close();
            },
        });
        const transport = createOaiTransport({
            apiKey: 'k',
            baseURL: 'https://gateway.test/v1',
            fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        });
        const raw = await transport.chat.completions.create({ model: 'm', stream: true }, { signal: aborter.signal });
        /** @type {Array<any>} */
        const events = [];
        for await (const event of OAI.consumeStream({ rawStream: raw, signal: aborter.signal })) {
            events.push(event);
            if (event.type === 'text') aborter.abort();
        }
        assert.equal(countType({ events, type: 'truncated' }), 0, 'the abort ended the stream on purpose');
        assert.equal(events.filter((event) => event.type === 'text').length, 1, 'the chunk before the abort was delivered');
    });
});

describe('OAI — OPENCODE tool_choice degrade', () => {
    const TOOL = { type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } } };
    const PROTOCOLS = ['completions', 'responses'];

    /** @param {{parameters?: Record<string, any>, protocol?: string, forceTextResponse?: boolean, toolChoiceRequired?: boolean, provider?: string}} arg0 */
    const build = ({ parameters = {}, protocol = 'completions', forceTextResponse = false, toolChoiceRequired = false, provider = ProviderType.OPENCODE }) => OAI.buildVendorRequest({
        model: 'm', parameters, tools: [TOOL], preparedMessages: [],
        forceTextResponse, toolChoiceRequired,
        session: { protocol, provider }
    });

    test('required and named degrade to auto; auto passes through', () => {
        for (const protocol of PROTOCOLS) {
            assert.equal(build({ parameters: { tool_choice: 'required' }, protocol }).request.tool_choice, 'auto');
            assert.equal(build({ parameters: { tool_choice: { type: 'function', function: { name: 'f' } } }, protocol }).request.tool_choice, 'auto');
            assert.equal(build({ parameters: { tool_choice: 'auto' }, protocol }).request.tool_choice, 'auto');
        }
    });

    test('a `none` choice drops the tool list — the gateway answers 400 on anything but "auto"', () => {
        for (const protocol of PROTOCOLS) {
            const req = build({ parameters: { tool_choice: 'none', parallel_tool_calls: false }, protocol }).request;
            assert.equal(req.tool_choice, undefined, `${protocol}: "none" is rejected upstream, never send it`);
            assert.equal(req.tools, undefined, `${protocol}: a text-only step must offer no tools`);
            assert.equal(req.parallel_tool_calls, undefined, `${protocol}: no tool flags without tools`);
        }
    });

    test('forceTextResponse (the loop final iteration) sends no tools and no tool_choice', () => {
        for (const protocol of PROTOCOLS) {
            const req = build({ forceTextResponse: true, protocol }).request;
            assert.equal(req.tool_choice, undefined, `${protocol}: "none" is rejected upstream`);
            assert.equal(req.tools, undefined, `${protocol}: the model must not be offered a tool it cannot be forced off`);
        }
    });

    test('toolChoiceRequired still asks for a tool, as auto', () => {
        for (const protocol of PROTOCOLS) {
            const req = build({ toolChoiceRequired: true, protocol }).request;
            assert.equal(req.tool_choice, 'auto');
            assert.equal(req.tools.length, 1);
        }
    });

    test('the degrade is OPENCODE-only — other backends keep the OpenAI pin', () => {
        for (const protocol of PROTOCOLS) {
            for (const provider of [ProviderType.OPENAI, ProviderType.OPENROUTER]) {
                const req = build({ forceTextResponse: true, provider, protocol }).request;
                assert.equal(req.tool_choice, 'none', `${provider}/${protocol}`);
                assert.equal(req.tools.length, 1, `${provider}/${protocol}`);
            }
        }
    });
});

describe('AAI — output events', () => {
    /** @param {{events: *}} arg0 */
    const run = ({ events }) => collect({ gen: AAI.consumeStream({ rawStream: feed({ events }) }) });

    test('max_tokens stop_reason -> truncated', async () => {
        const out = await run({ events: [{ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3 } }] });
        assert.ok(types({ events: out }).includes('truncated'));
    });

    test('model_context_window_exceeded stop_reason -> one truncated, like max_tokens', async () => {
        const out = await run({ events: [
            { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } },
            { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } }
        ] });
        assert.equal(out.filter(e => e.type === 'truncated').length, 1);
    });

    test('pause_turn stop_reason -> one error, never twice', async () => {
        const out = await run({ events: [
            { type: 'message_delta', delta: { stop_reason: 'pause_turn' } },
            { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }
        ] });
        const errors = out.filter(e => e.type === 'error');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].error_type, 'pause_turn');
        assert.equal(errors[0].error_message, 'Anthropic paused the turn (stop_reason: pause_turn); resend the conversation to continue.');
    });

    test('redacted_thinking block -> redacted_thinking event', async () => {
        const out = await run({ events: [
            { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENC==' } },
            { type: 'content_block_stop', index: 0 }
        ] });
        const ev = out.find(e => e.type === 'redacted_thinking');
        assert.ok(ev, 'redacted_thinking must not be dropped');
        assert.deepEqual(ev.blocks, ['ENC==']);
    });

    test('signature_delta -> thought_signature', async () => {
        const out = await run({ events: [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
            { type: 'content_block_stop', index: 0 }
        ] });
        assert.equal(out.find(e => e.type === 'thought_signature')?.signature, 'sig');
    });
});

describe('AAI — request shaping', () => {
    const build = /** @type {(...args: any[]) => any} */ (( parameters) => AAI.buildVendorRequest({
        model: 'claude', parameters, tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session: {}
    }));

    test('thinking budget clamps into [1024, max_tokens-1]', () => {
        const high = build({ max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 5000 } });
        assert.equal(high.request.thinking.budget_tokens, 2047);
        const low = build({ max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 10 } });
        assert.equal(low.request.thinking.budget_tokens, 1024);
    });

    test('parallel tool calls false -> disable_parallel_tool_use', () => {
        const req = build({ _toolChoice: 'auto', _parallelToolCalls: false });
        assert.deepEqual(req.request.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    });
});

describe('GAI — output events', () => {
    /** @param {{events: *}} arg0 */
    const run = ({ events }) => collect({ gen: GAI.consumeStream({ rawStream: feed({ events }) }) });

    test('promptFeedback block -> one error (no candidates to carry a finishReason)', async () => {
        const out = await run({ events: [
            { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'blocked' } },
            { promptFeedback: { blockReason: 'SAFETY' } }
        ] });
        assert.equal(out.length, 1, 'the block must be reported exactly once');
        assert.equal(out[0].type, 'error');
        assert.equal(out[0].error_type, 'SAFETY');
        assert.ok(out[0].error_message.includes('blocked'));
    });

    test('usageMetadata -> quota with cache and thought details', async () => {
        const out = await run({ events: [{
            usageMetadata: {
                totalTokenCount: 10, promptTokenCount: 6, candidatesTokenCount: 4,
                cachedContentTokenCount: 2, thoughtsTokenCount: 1
            }
        }] });
        assert.equal(out[0].type, 'quota');
        assert.equal(out[0].data.cache_read_input_tokens, 2);
        assert.equal(out[0].data.reasoning_tokens, 1);
    });
});

describe('JAI — output events', () => {
    /** @param {{events: *}} arg0 */
    const run = ({ events }) => collect({ gen: JAI.consumeStream({ rawStream: feed({ events }) }) });

    test('metadata -> thought_signature; without a signature -> nothing', async () => {
        assert.deepEqual(await run({ events: [{ type: 'metadata', thoughtSignature: 'sig' }] }), [{ type: 'thought_signature', signature: 'sig' }]);
        assert.deepEqual(await run({ events: [{ type: 'metadata' }] }), []);
    });

    test('error -> error (payload preserved)', async () => {
        const out = await run({ events: [{ type: 'error', error_message: 'x', error_type: 'y' }] });
        assert.equal(out[0].type, 'error');
        assert.equal(out[0].error_type, 'y');
    });

    test('reasoning payload shapes -> thought; empty payload -> nothing', async () => {
        for (const data of [{ content: 'a' }, { text: 'b' }, { reasoning: 'c' }]) {
            const out = await run({ events: [{ type: 'reasoning', data }] });
            assert.deepEqual(out, [{ type: 'thought', content: data.content ?? data.text ?? data.reasoning }]);
        }
        assert.deepEqual(await run({ events: [{ type: 'reasoning', data: {} }] }), []);
    });

    test('text and tool_calls are fronted by a single first_token; reasoning is not', async () => {
        const text = await run({ events: [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }] });
        assert.deepEqual(types({ events: text }), ['first_token', 'text', 'text']);
        assert.equal(typeof text[0].latencyMs, 'number');
        const tool = await run({ events: [{ type: 'tool_calls', calls: [{ id: 'c1', name: 'f', arguments: '{}' }] }] });
        assert.deepEqual(types({ events: tool }), ['first_token', 'tool_calls']);
        const reasoned = await run({ events: [{ type: 'reasoning', data: { content: 'r' } }, { type: 'text', content: 'x' }] });
        assert.deepEqual(types({ events: reasoned }), ['thought', 'first_token', 'text']);
    });
});

describe('JAI — native V9 signature / delta / finish parity', () => {
    /** @param {{json: *}} arg0 */
    const parse = ({ json }) => new SSEParser().parseLine({ line: `data: ${json}` });

    test('ToolCall carries its OWN signature onto the assembled call', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{}","thoughtSignature":"tool-sig"}' });
        p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call"}' });
        const { toolCalls } =  (p.getFinalResult());
        assert.equal(toolCalls[0].thoughtSignature, 'tool-sig');
    });

    test('a signature-less Content never inherits a prior tool signature', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{}","thoughtSignature":"tool-sig"}' });
        const text =  (p.parseLine({ line: 'data: {"type":"Content","content":"hello"}' }));
        assert.equal(/** @type {any} */ (text).thoughtSignature, undefined, 'stale tool sig must not ride a later text turn');
        assert.equal( (p.getFinalResult()).thoughtSignature, null);
    });

    test('Content carries its own signature as the turn-level one (snake or camel)', () => {
        const p = new SSEParser();
        const text =  (p.parseLine({ line: 'data: {"type":"Content","content":"hi","thought_signature":"text-sig"}' }));
        assert.equal(/** @type {any} */ (text).thoughtSignature, 'text-sig');
        assert.equal( (p.getFinalResult()).thoughtSignature, 'text-sig');
    });

    test('each ToolCall fragment surfaces as a tool_call_delta; object content is serialized', () => {
        const p = new SSEParser();
        const d1 =  (p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":{"a":1}}' }));
        assert.equal(/** @type {any} */ (d1).type, 'tool_call_delta');
        assert.equal(/** @type {any} */ (d1).content, '{"a":1}', 'never "[object Object]"');
        const d2 =  (p.parseLine({ line: 'data: {"type":"ToolCall","id":"c1","content":"}"}' }));
        assert.equal(/** @type {any} */ (d2).type, 'tool_call_delta');
        p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call","choiceIndex":0}' });
        const { toolCalls } =  (p.getFinalResult());
        assert.equal(toolCalls[0].arguments, '{"a":1}}');
    });

    test('FinishMetadata surfaces the native reason and finalizes on function_call', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{}"}' });
        const fin =  (p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"function_call","choiceIndex":0}' }));
        assert.deepEqual(fin, { type: 'finish', reason: 'function_call', choiceIndex: 0 });
        assert.equal( (p.getFinalResult()).toolCalls.length, 1);
    });

    test('unknown vendor types are surfaced, not dropped', () => {
        assert.deepEqual(
             /** @type {any} */
                          (parse({ json: '{"type":"Mystery","x":1}' })),
            { type: 'unknown', data: { type: 'Mystery', x: 1 } }
        );
    });

    test('PrematureEnd surfaces as premature_end (gateway early termination)', () => {
        assert.deepEqual(
             /** @type {any} */
                          (parse({ json: '{"type":"PrematureEnd","reason":"Unknown","event_type":"premature_end"}' })),
            { type: 'premature_end', reason: 'Unknown', choiceIndex: 0 }
        );
        assert.deepEqual(
             /** @type {any} */
                          (parse({ json: '{"type":"PrematureEnd","reason":"Timeout","choiceIndex":1}' })),
            { type: 'premature_end', reason: 'Timeout', choiceIndex: 1 }
        );
    });

    test('adapter forwards tool_call_delta / finish / unknown / premature_end', async () => {
        const out = await collect({ gen: JAI.consumeStream({ rawStream: feed({ events: [
            { type: 'tool_call_delta', id: 'c1', name: 'f', content: '{' },
            { type: 'finish', reason: 'length' },
            { type: 'unknown', data: { x: 1 } },
            { type: 'premature_end', reason: 'Unknown' }
        ] }) }) });
        assert.deepEqual(out.map(e => e.type), ['tool_call_delta', 'finish', 'unknown', 'premature_end']);
    });

    test('formatToolCall carries the per-call signature', () => {
        assert.equal(JAI.formatToolCall({ call: { id: 'c1', name: 'f', arguments: '{}', thoughtSignature: 's' } }).thoughtSignature, 's');
        assert.equal(JAI.formatToolCall({ call: { id: 'c1', name: 'f', arguments: '{}' } }).thoughtSignature, null);
    });

    test('a length finish discards the in-progress call (never executes partial args)', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{\\"q\\":\\"part"}' });
        p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"length"}' });
        assert.deepEqual( (p.getFinalResult()).toolCalls, []);
    });

    test('an id that moves to a different parallel index is rejected as corrupt', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":1,"id":"c1","name":"f","content":"{}"}' });
        assert.throws(
            () => p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","content":"x"}' }),
            /moved from index/
        );
    });

    test('a signature nested under data is honored (defensive gateway shape)', () => {
        const p = new SSEParser();
        const ev =  (p.parseLine({ line: 'data: {"type":"Content","content":"hi","data":{"thought_signature":"nested"}}' }));
        assert.equal(/** @type {any} */ (ev).thoughtSignature, 'nested');
        assert.equal( (p.getFinalResult()).thoughtSignature, 'nested');
    });

    test('parallel calls without their own signature inherit the turn signature', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{}","thoughtSignature":"turn-sig"}' });
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":1,"id":"c2","name":"f","content":"{}"}' });
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":2,"id":"c3","name":"f","content":"{}"}' });
        p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call"}' });
        const { toolCalls, thoughtSignature } =  (p.getFinalResult());
        assert.deepEqual(toolCalls.map(( c) => c.thoughtSignature), ['turn-sig', 'turn-sig', 'turn-sig']);
        assert.equal(thoughtSignature, null, 'the metadata signature stays Content-only');
    });

    test('a thinking-text signature fills calls that carry none', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"Content","content":"thinking","thought_signature":"thought-sig"}' });
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{}"}' });
        p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call"}' });
        const { toolCalls } =  (p.getFinalResult());
        assert.equal(toolCalls[0].thoughtSignature, 'thought-sig');
    });

    test('a call with its own signature keeps it over the turn signature', () => {
        const p = new SSEParser();
        p.parseLine({ line: 'data: {"type":"Content","content":"thinking","thought_signature":"turn-sig"}' });
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":0,"id":"c1","name":"f","content":"{}","thoughtSignature":"own-sig"}' });
        p.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":1,"id":"c2","name":"f","content":"{}"}' });
        p.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_call"}' });
        const { toolCalls } =  (p.getFinalResult());
        assert.deepEqual(toolCalls.map(( c) => c.thoughtSignature), ['own-sig', 'turn-sig']);
    });
});

describe('JAI — native single tool-choice constraint', () => {
    test('a step-level forceTextResponse replaces a builder-level choice (never stacks)', () => {
        const emitter = new EventEmitter();
        const httpClient = { streamTimeout: 1000, getEventEmitter: () => emitter, _fetchWithRetry: async () => ({}) };
        const session = new JaiAgenticChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'm', eventEmitter: emitter, profileManager: /** @type {any} */ (null) });
        session.withTools({ tools: [{ name: 't' }] }).withParameters({ params: (/** @type {any} */ b) => b.toolChoiceAuto() });
        assert.deepEqual( (/** @type {any} */ (session))._parameters.toolConfig.toolChoice, { auto: true });

        const { session: clone } = session._onStepBuildContext({ forceTextResponse: true, toolChoiceRequired: false });
        assert.deepEqual(
             /** @type {any} */
                          (clone)._parameters.toolConfig.toolChoice,
            { none: true },
            'AUTO must be replaced, not stacked — the native protocol allows exactly one'
        );
    });

    test('a step-level toolChoiceRequired replaces a builder-level choice', () => {
        const emitter = new EventEmitter();
        const httpClient = { streamTimeout: 1000, getEventEmitter: () => emitter, _fetchWithRetry: async () => ({}) };
        const session = new JaiAgenticChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'm', eventEmitter: emitter, profileManager: /** @type {any} */ (null) });
        session.withTools({ tools: [{ name: 't' }] }).withParameters({ params: /** @type {(...args: any[]) => any} */ (( b) => b.toolChoiceAuto()) });
        const { session: clone } = session._onStepBuildContext({ forceTextResponse: false, toolChoiceRequired: true });
        assert.deepEqual( (/** @type {any} */ (clone))._parameters.toolConfig.toolChoice, { required: true });
    });
});

describe('redacted_thinking row round-trip (AAI continuity)', () => {
    test('replays ahead of thinking/tool_use in normalizeToAAI', () => {
        const row =  (createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: '', thoughtSignature: 'sig', reasoningContent: '', redactedThinking: ['ENC=='] }));
        row.tool_calls = [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }];
        const out = normalizeToAAI({ msgs: [{ role: 'user', content: 'go' }, row, { role: 'tool', tool_call_id: 't1', content: 'ok' }] });
        const assistant = /** @type {Record<string, any>} */ (out.messages.find(m => m.role === 'assistant'));
        assert.ok(assistant, 'the assistant row must exist');
        assert.equal(assistant.content[0].type, 'redacted_thinking');
        assert.equal(assistant.content[0].data, 'ENC==');
        assert.ok(assistant.content.some(/** @type {(...args: any[]) => any} */ (( b) => b.type === 'tool_use')), 'the tool_use block must survive');
    });

    test('never leaks to the OAI or GAI wire', () => {
        const row = createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: 'answer', thoughtSignature: null, reasoningContent: '', redactedThinking: ['ENC=='] });
        const oai = normalizeToOAI({ model: 'gpt-4o', msgs: [{ role: 'user', content: 'go' }, row] });
        assert.ok(!JSON.stringify(oai).includes('ENC=='));
        const gai = normalizeToGAI({ msgs: [{ role: 'user', content: 'go' }, row] });
        assert.ok(!JSON.stringify(gai).includes('ENC=='));
    });
});

describe('step() — refusal error classification', () => {
    
    /**
     * /
      * @param {{firstEvent: *, onAttempt: *}} arg0
     */
        function makeFirstEventAdapter({ firstEvent, onAttempt }) {
        return {
            vendorName: 'STUB',
            buildVendorRequest: () => ({ request: {}, observability: {} }),
            executeVendorRequest: () => { onAttempt(); return feed({ events: [firstEvent] }); },
            /** @param {{rawStream: *}} arg0 */
            consumeStream: /** @param {{ rawStream: any }} arg0 */ ({ rawStream }) => rawStream,
            extractXmlToolCalls: () => [],
            /** @param {{call: *}} arg0 */
            formatToolCall: /** @param {{ call: any }} arg0 */ ({ call }) => ({ id: call.id, name: call.name, args: call.args })
        };
    }

    class StubSession extends AbstractChatSession {
        
        /**
         * /
          * @param {{adapter: *, emitter: *, retryPolicy: *}} arg0
         */
                constructor({ adapter, emitter, retryPolicy }) {
            /** @param {{stream: *}} arg0 */
            super({ provider: ProviderType.OPENAI, model: 'stub', eventEmitter: emitter, client: null, vendorClient: {}, retryPolicy, streamTimeoutPolicy: { wrapStream: /** @param {{ stream: any }} arg0 */ ({ stream }) => stream } });
            this._adapter = adapter;
        }
    }

    
    /**
     * /
      * @param {{events: *}} arg0
     */
        function makeEventAdapter({ events }) {
        return {
            vendorName: 'STUB',
            buildVendorRequest: () => ({ request: {}, observability: {} }),
            executeVendorRequest: () => feed({ events }),
            /** @param {{rawStream: *}} arg0 */
            consumeStream: /** @param {{ rawStream: any }} arg0 */ ({ rawStream }) => rawStream,
            extractXmlToolCalls: () => [],
            /** @param {{call: *}} arg0 */
            formatToolCall: /** @param {{ call: any }} arg0 */ ({ call }) => ({ id: call.id, name: call.name, args: call.args })
        };
    }

    test('a JAI finish(length) event marks the step truncated', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [{ type: 'text', content: 'partial' }, { type: 'finish', reason: 'length' }] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(state.truncated, true);
        assert.equal(state.content, 'partial');
    });

    test('a JAI premature_end marks the step truncated (never a clean answer)', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [{ type: 'text', content: 'partial' }, { type: 'premature_end', reason: 'Unknown' }] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(state.truncated, true);
        assert.equal(state.content, 'partial');
    });

    test('a JAI premature_end(reason=Unknown) is a provider truncation, not content moderation', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [{ type: 'text', content: 'partial' }, { type: 'premature_end', reason: 'Unknown' }] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(state.truncated, true);
        assert.equal(state.truncatedBy, 'premature_end');
        assert.ok(!state.contentFiltered, 'reason Unknown is not moderation');
    });

    test('a JAI premature_end(reason=content_filter) is content moderation', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [{ type: 'premature_end', reason: 'content_filter' }] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(state.truncated, true);
        assert.equal(state.contentFiltered, true);
    });

    test('a JAI premature_end with no content is an empty truncated turn', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [{ type: 'premature_end', reason: 'Unknown' }] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(state.truncated, true);
        assert.equal(state.content, '');
    });

    test('a truncated turn never surfaces its tool calls for execution', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [
                { type: 'tool_calls', calls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"/tmp/x","content":"partial' }] },
                { type: 'truncated' },
            ] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        
        /** @type {Array<any>} */
                const events = [];
        const gen = session.step({ messages: [{ role: 'user', content: 'go' }] });
        let r = await gen.next();
        while (!r.done) { events.push(r.value); r = await gen.next(); }
        const state =  (r.value);
        assert.equal(/** @type {any} */ (state).truncated, true);
        assert.ok(!events.some((e) => e.type === 'tool_request'), 'no tool round from a truncated turn');
        const msgs =  (/** @type {any} */ (state).messages ?? []);
        assert.ok(!msgs.some(/** @type {(...args: any[]) => any} */ ((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0)),
            'the partial call is not persisted as a tool round');
    });

    test('a vendor restart discards the dead attempt (content + truncation reset)', async () => {
        const session = new StubSession({ adapter: makeEventAdapter({ events: [
                { type: 'text', content: 'stale' },
                { type: 'premature_end', reason: 'Unknown' },
                { type: 'restart', reason: 'premature_end' },
                { type: 'text', content: 'fresh' },
                { type: 'finish', reason: 'stop' },
            ] }), emitter: new EventEmitter(), retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) } });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(state.content, 'fresh', 'only the replacement stream is recorded');
        assert.ok(!state.truncated, 'the retried turn is not truncated');
    });

    test('a first-event refusal is non-retryable (one attempt)', async () => {
        let attempts = 0;
        const policy = { shouldRetry: () => ({ retry: attempts < 3, delayMs: 0 }) };
        const session = new StubSession({ adapter: makeFirstEventAdapter({ firstEvent: { type: 'error', error_message: 'refusal', error_type: 'refusal' }, onAttempt: () => { attempts++; } }), emitter: new EventEmitter(), retryPolicy: policy });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(attempts, 1, 'a refusal must not be retried');
        assert.equal(state.streamError?.error_type, 'refusal');
    });

    test('a first-event pause_turn is non-retryable (one attempt)', async () => {
        let attempts = 0;
        const policy = { shouldRetry: () => ({ retry: attempts < 3, delayMs: 0 }) };
        const session = new StubSession({ adapter: makeFirstEventAdapter({ firstEvent: { type: 'error', error_message: 'pause_turn', error_type: 'pause_turn' }, onAttempt: () => { attempts++; } }), emitter: new EventEmitter(), retryPolicy: policy });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.equal(attempts, 1, 'a pause_turn resend is the caller decision, not an automatic retry');
        assert.equal(state.streamError?.error_type, 'pause_turn');
    });

    test('control: a transient first-event error IS retried', async () => {
        let attempts = 0;
        const policy = { shouldRetry: () => ({ retry: attempts < 3, delayMs: 0 }) };
        const session = new StubSession({ adapter: makeFirstEventAdapter({ firstEvent: { type: 'error', error_message: 'rate limited', error_type: 'rate_limit' }, onAttempt: () => { attempts++; } }), emitter: new EventEmitter(), retryPolicy: policy });
        const state = await drain({ gen: session.step({ messages: [{ role: 'user', content: 'go' }] }) });
        assert.ok(attempts >= 2, `expected retries, got ${attempts}`);
        assert.equal(state.streamError?.error_type, 'rate_limit');
    });
});
