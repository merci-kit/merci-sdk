// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as GaiChatSession } from '../lib/backends/gai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { createUserMessage, stripInjectionMeta } from '../lib/messaging/messages.mjs';
import { ProviderType, XML_TOOL_CALL_TAGS, DEFAULT_SYSTEM_PROMPT } from '../lib/core/constants/index.mjs';

// ponytail: internal rows now carry a stable non-wire merciId — strip it
/** @param {{row: *}} arg0 */
const clean = ({ row }) => stripInjectionMeta({ messages: Array.isArray(row) ? row : [row] })[0];

// =============================================================================
// SECTION 1: HELPER UNIT TESTS
// =============================================================================

class MinimalSession extends AbstractChatSession {
    constructor(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ emitter, /** @type {any} */ client) { super({ provider, model, eventEmitter: emitter, client }); }
}

test('_recoverToolCallsFromText: returns [] when text has no XML tool call', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const calls = session._recoverToolCallsFromText({ text: 'plain text', extractFn: () => [{ id: 'x' }] });
    assert.deepEqual(calls, []);
});

test('_recoverToolCallsFromText: returns [] when text is empty/falsy', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    assert.deepEqual(session._recoverToolCallsFromText({ text: '', extractFn: () => [{ id: 'x' }] }), []);
    assert.deepEqual(session._recoverToolCallsFromText({ text: null, extractFn: () => [{ id: 'x' }] }), []);
    assert.deepEqual(session._recoverToolCallsFromText({ text: undefined, extractFn: () => [{ id: 'x' }] }), []);
});

test('_recoverToolCallsFromText: returns [] when extractor is not a function', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    assert.deepEqual(session._recoverToolCallsFromText({ text: `${XML_TOOL_CALL_TAGS.START}foo`, extractFn: null }), []);
    assert.deepEqual(session._recoverToolCallsFromText({ text: `${XML_TOOL_CALL_TAGS.START}foo`, extractFn: undefined }), []);
});

test('_recoverToolCallsFromText: invokes the extractor when text contains the start tag', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const text = `before ${XML_TOOL_CALL_TAGS.START}foo</tool_call> after`;
    let received = null;
    const calls = session._recoverToolCallsFromText({ text, extractFn: (/** @type {{text: string}} */ args) => { received = args.text; return [{ id: 'recovered' }]; } });
    assert.equal(received, text, 'the extractor receives the full text');
    assert.deepEqual(calls, [{ id: 'recovered' }]);
});

test('_formatFinalMessages: no tool calls -> single assistant text message', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const history = [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })];
    const out = session._formatFinalMessages({
        provider: ProviderType.OPENAI,
        history,
        text: 'Hello back',
        toolCalls: [],
        results: null,
        thoughtSignature: null,
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *}} arg0 */
        formatToolCall: ({ call: c }) => ({ id: c.id, name: c.name, args: '{}' })
    });
    assert.equal(out.length, 2);
    assert.deepEqual(clean({ row: out[1] }), { role: 'assistant', content: 'Hello back' });
});

test('_formatFinalMessages: with tool calls and results -> combined assistant + per-call tool-result', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const history = [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })];
    const out = session._formatFinalMessages({
        provider: ProviderType.OPENAI,
        history,
        text: 'Calling foo and bar',
        toolCalls: [
            { id: 'c1', function: { name: 'foo', arguments: '{"x":1}' } },
            { id: 'c2', function: { name: 'bar', arguments: '{"y":2}' } }
        ],
        results: [
            { id: 'c1', name: 'foo', success: true, result: { ok: true } },
            { id: 'c2', name: 'bar', success: false, error: 'boom' }
        ],
        thoughtSignature: 'sig-abc',
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *}} arg0 */
        formatToolCall: ({ call: c }) => ({
            id: c.id,
            name: c.function.name,
            args: c.function.arguments
        })
    });
    assert.equal(out.length, 4);
    assert.deepEqual(clean({ row: out[1] }), {
        role: 'assistant', content: 'Calling foo and bar',
        tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } },
            { id: 'c2', type: 'function', function: { name: 'bar', arguments: '{"y":2}' } }
        ],
        thoughtSignature: 'sig-abc'
    });
    assert.deepEqual(clean({ row: out[2] }), { role: 'tool', tool_call_id: 'c1', name: 'foo', content: JSON.stringify({ ok: true }), thoughtSignature: 'sig-abc' });
    assert.deepEqual(clean({ row: out[3] }), { role: 'tool', tool_call_id: 'c2', name: 'bar', content: JSON.stringify({ error: 'boom' }), thoughtSignature: 'sig-abc' });
});

test('_formatFinalMessages: with tool calls but no results -> combined assistant + synthesized failure results', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const history = [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })];
    const out = session._formatFinalMessages({
        provider: ProviderType.OPENAI,
        history,
        text: 'Calling',
        toolCalls: [{ id: 'c1', function: { name: 'foo', arguments: '{}' } }],
        results: null,
        thoughtSignature: null,
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *}} arg0 */
        formatToolCall: ({ call: c }) => ({ id: c.id, name: c.function.name, args: c.function.arguments })
    });
    assert.equal(out.length, 3);
    assert.equal(out[1].role, 'assistant');
    assert.equal(/** @type {any} */ (out[1].tool_calls)[0].id, 'c1');
    assert.equal(out[2].role, 'tool');
    assert.equal(out[2].tool_call_id, 'c1');
    assert.match(String(out[2].content), /no result/);
});

test('_formatFinalMessages: with tool calls but no text -> no assistant text message', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const history = [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })];
    const out = session._formatFinalMessages({
        provider: ProviderType.OPENAI,
        history,
        text: '   ',
        toolCalls: [{ id: 'c1', function: { name: 'foo', arguments: '{}' } }],
        results: [{ id: 'c1', name: 'foo', success: true, result: 42 }],
        thoughtSignature: null,
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *}} arg0 */
        formatToolCall: ({ call: c }) => ({ id: c.id, name: c.function.name, args: c.function.arguments })
    });
    assert.equal(out.length, 3);
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[2].role, 'tool');
});

test('_formatFinalMessages: formatToolCall receives the matching result and index', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    let receivedArgs = null;
    session._formatFinalMessages({
        provider: ProviderType.OPENAI,
        history: [],
        text: '',
        toolCalls: [{ id: 'c1' }],
        results: [{ id: 'c1', name: 'foo' }],
        thoughtSignature: null,
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *, result: *, index: *}} arg0 */
        formatToolCall: ({ call, result, index }) => {
            receivedArgs = { call, result, index };
            return { id: call.id, name: 'foo', args: '{}' };
        }
    });
    assert.equal( (/** @type {any} */ (receivedArgs)).call.id, 'c1');
    assert.equal( (/** @type {any} */ (receivedArgs)).result.id, 'c1');
    assert.equal( (/** @type {any} */ (receivedArgs)).index, 0);
});

test('_formatFinalMessages: JAI-shape formatToolCall fallback (call.id || result.id || call_${index})', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', new EventEmitter(), {});
    const out = session._formatFinalMessages({
        provider: ProviderType.JAI,
        history: [createUserMessage({ provider: ProviderType.JAI, content: 'Hi' })],
        text: '',
        toolCalls: [
            { name: 'echo' },
            { name: 'ping' }
        ],
        results: [
            { id: 'from-result-1', name: 'echo' },
            { id: 'from-result-2', name: 'ping' }
        ],
        thoughtSignature: null,
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *, result: *, index: *}} arg0 */
        formatToolCall: ({ call, result, index }) => ({
            id: call.id || (result && result.id) || `call_${index}`,
            name: call.name || (result && result.name) || 'unknown',
            args: call.arguments
        })
    });
    assert.equal(out[1].id, 'from-result-1', 'result.id is the fallback when call has no id');
    assert.equal(out[3].id, 'from-result-2');
    const out2 = session._formatFinalMessages({
        provider: ProviderType.JAI,
        history: [],
        text: '',
        toolCalls: [{ name: 'echo' }],
        results: [{ name: 'echo' }],
        thoughtSignature: null,
        reasoningContent: '',
        nativePayload: null,
        
        /** @param {{call: *, result: *, index: *}} arg0 */
        formatToolCall: ({ call, result, index }) => ({
            id: call.id || (result && result.id) || `call_${index}`,
            name: call.name || (result && result.name) || 'unknown',
            args: call.arguments
        })
    });
    assert.equal(out2[0].id, 'call_0', 'last-resort fallback is call_${index} (on the tool-call message)');
});

// =============================================================================
// SECTION 2: BACKEND STEP() END-TO-END (stub SDK)
// =============================================================================


/**
  * @param {{gen: *, tools?: *}} arg0
 */
async function driveStep({ gen, tools = [] }) {
    /** @type {any[]} */
    const events =  ([]);
    let result = await gen.next();
    while (!result.done) {
        const event = result.value;
        events.push(event);
        if (event && event.type === 'tool_request') {
            const results = event.calls.map(/** @type {(...args: any[]) => any} */ (( call) => {
                const t = tools.find( (/** @type {(...args: any[]) => any} */ (x => x.name === (call.function?.name || call.name))));
                return { id: call.id, name: call.function?.name || call.name, success: !!t, result: t ? { ok: true } : null };
            }));
            result = await gen.next(results);
        } else {
            result = await gen.next();
        }
    }
    return { events, final: result.value };
}


/** @param {{text: *}} arg0 */
const oaiTextChunks = ({ text }) => (async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
    yield { usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } };
})();

/** @param {{calls: *}} arg0 */
const oaiToolCallChunks = ({ calls }) => (async function* () {
    for (const c of calls) {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: c.id, function: { name: c.name, arguments: c.args } }] } }] };
    }
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
})();


/**
 * @param {any} streamIter
 * @param {any} [capture]
 */
/** @param {{streamIter: *, capture?: *}} arg0 */
const buildOaiSdk = ({ streamIter, capture = null }) => ({
    chat: {
        completions: {
            create: /** @type {(...args: any[]) => any} */ (async ( params) => {
                if (capture) capture.push(params);
                return streamIter[Symbol.asyncIterator]();
            })
        }
    }
});

test('OAI step: text-only response uses _formatFinalMessages helper (no inline push)', async () => {
    const sdk = buildOaiSdk({ streamIter: oaiTextChunks({ text: 'hello there' }) });
    const session = new OaiChatSession({ client: sdk, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })] });
    const { final } = await driveStep({ gen });
    assert.equal(final.done, true);
    assert.equal(final.content, 'hello there');
    const last = final.messages[final.messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.equal(last.content, 'hello there');
});

test('OAI step: tool-call response pushes assistant text + tool-call + tool-result via helper', async () => {
    const calls = [{ id: 'call_1', name: 'echo', args: '{"x":1}' }];
    const sdk = buildOaiSdk({ streamIter: oaiToolCallChunks({ calls }) });
    const session = new OaiChatSession({ client: sdk, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    const tools = [{ name: 'echo' }];
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })], options: { thoughtSignature: 'sig-x' } });
    const { final, events } = await driveStep({ gen, tools });
    assert.equal(final.done, false, 'tool-call step should NOT be done');
    assert.ok(events.some(e => e && e.type === 'tool_request'));
    assert.equal(final.messages.length, 3);
    assert.equal(final.messages[0].role, 'user');
    assert.equal(final.messages[1].role, 'assistant');
    assert.ok(Array.isArray(final.messages[1].tool_calls));
    assert.equal(final.messages[1].thoughtSignature, undefined);
    assert.equal(final.messages[2].role, 'tool');
    assert.equal(final.messages[2].tool_call_id, 'call_1');
    assert.equal(final.messages[2].thoughtSignature, undefined);
});

test('OAI step: withSystemMessage + step uses _prependSystemMessageIfNeeded helper (wire payload)', async () => {
    /** @type {any[]} */
    const captured =  ([]);
    const sdk = buildOaiSdk({ streamIter: oaiTextChunks({ text: 'ok' }), capture: captured });
    const session = new OaiChatSession({ client: sdk, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    session.withSDKDescriptorMessage({ args: ['persona'] });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })] });
    const { final } = await driveStep({ gen });
    assert.equal(captured.length, 1, 'SDK was called once');
    const wireMsgs = captured[0].messages;
    const sysMsg = wireMsgs.find(/** @type {(...args: any[]) => any} */ (( m) => m.role === 'system'));
    assert.ok(sysMsg, 'system message must reach the wire payload');
    assert.equal(sysMsg.content, 'persona');
    assert.equal(final.messages.length, 2);
    assert.equal(final.messages[0].role, 'user');
    assert.equal(final.messages[1].role, 'assistant');
});


/** @param {{events: *}} arg0 */
const buildAaiSdk = ({ events }) => ({
    messages: {
        stream: () => (async function* () { for (const e of events) yield e; })()
    }
});

test('AAI step: text-only response uses _formatFinalMessages helper', async () => {
    const sdk = buildAaiSdk({ events: [
        { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 7 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ] });
    const session = new AaiChatSession({ client: sdk, model: 'claude-3-5-sonnet-20241022', eventEmitter: new EventEmitter() });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.ANTHROPIC, content: 'Hi' })], options: { thoughtSignature: 'sig-y' } });
    const { final } = await driveStep({ gen });
    assert.equal(final.done, true);
    assert.equal(final.content, 'reply');
    assert.equal(final.thoughtSignature, null);
    const last = final.messages[final.messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.equal(last.content, 'reply');
    assert.equal(last.thoughtSignature, undefined);
});

test('AAI step: tool-use response uses _formatFinalMessages helper', async () => {
    const sdk = buildAaiSdk({ events: [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'echo' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
    ] });
    const session = new AaiChatSession({ client: sdk, model: 'claude-3-5-sonnet-20241022', eventEmitter: new EventEmitter() });
    const tools = [{ name: 'echo' }];
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.ANTHROPIC, content: 'Hi' })], options: { thoughtSignature: 'sig-y' } });
    const { final, events } = await driveStep({ gen, tools });
    assert.equal(final.done, false);
    assert.ok(events.some(e => e && e.type === 'tool_request'));
    assert.equal(final.messages.length, 3);
    assert.equal(final.messages[0].role, 'user');
    assert.equal(final.messages[1].role, 'assistant');
    assert.equal(final.messages[1].tool_calls[0].id, 'tool_1');
    assert.equal(final.messages[1].tool_calls[0].function.name, 'echo');
    assert.equal(final.messages[1].tool_calls[0].function.arguments, '{"q":1}');
    assert.equal(final.messages[2].role, 'user');
    assert.equal(final.messages[2].content[0].type, 'tool_result');
    assert.equal(final.messages[2].content[0].tool_use_id, 'tool_1');
});

test('AAI step: signature_delta event is buffered into effective thoughtSignature', async () => {
    const sdk = buildAaiSdk({ events: [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'new-sig-7' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 0 }
    ] });
    const session = new AaiChatSession({ client: sdk, model: 'claude-3-5-sonnet-20241022', eventEmitter: new EventEmitter() });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.ANTHROPIC, content: 'Hi' })], options: { thoughtSignature: 'initial' } });
    const { final } = await driveStep({ gen });
    assert.equal(final.thoughtSignature, 'new-sig-7', 'effective signature must come from the stream');
});


/** @param {{chunks: *}} arg0 */
const buildGaiSdk = ({ chunks }) => ({
    models: {
        generateContentStream: async () => (async function* () { for (const c of chunks) yield c; })()
    }
});

test('GAI step: text-only response uses _formatFinalMessages helper', async () => {
    const sdk = buildGaiSdk({ chunks: [
        { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
        { usageMetadata: { totalTokenCount: 4, promptTokenCount: 2, candidatesTokenCount: 2 } }
    ] });
    const session = new GaiChatSession({ client: sdk, model: 'gemini-2.0-flash', eventEmitter: new EventEmitter() });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'Hi' })], options: { thoughtSignature: 'sig-g' } });
    const { final } = await driveStep({ gen });
    assert.equal(final.done, true);
    assert.equal(final.content, 'ok');
    assert.equal(final.thoughtSignature, null);
    const last = final.messages[final.messages.length - 1];
    assert.equal(last.role, 'model');
    assert.equal(last.parts[0].text, 'ok');
});

test('GAI step: function-call response uses _formatFinalMessages helper', async () => {
    const sdk = buildGaiSdk({ chunks: [
        {
            candidates: [{ content: { parts: [{ functionCall: { id: 'fc_1', name: 'echo', args: { q: 1 } } }] }, finishReason: 'STOP' }],
            functionCalls: [{ id: 'fc_1', name: 'echo', args: { q: 1 } }]
        }
    ] });
    const session = new GaiChatSession({ client: sdk, model: 'gemini-2.0-flash', eventEmitter: new EventEmitter() });
    const tools = [{ name: 'echo' }];
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'Hi' })], options: { thoughtSignature: 'sig-g' } });
    const { final, events } = await driveStep({ gen, tools });
    assert.equal(final.done, false);
    assert.ok(events.some(e => e && e.type === 'tool_request'));
    assert.equal(final.messages.length, 3);
    assert.equal(final.messages[0].role, 'user');
    assert.equal(final.messages[1].role, 'model');
    assert.equal(final.messages[1].parts[0].functionCall.id, 'fc_1');
    assert.equal(final.messages[2].role, 'user');
    assert.equal(final.messages[2].parts[0].functionResponse.id, 'fc_1');
});

test('GAI step: parallel functionCall parts each carry their own thought signature', async () => {
    const sdk = buildGaiSdk({ chunks: [
        {
            candidates: [{ content: { parts: [
                { functionCall: { id: 'fc_1', name: 'extract_single_action_item', args: { task: 'x' } }, thoughtSignature: 'sig-1' },
                { functionCall: { id: 'fc_2', name: 'extract_single_action_item', args: { task: 'y' } }, thoughtSignature: 'sig-2' },
            ] }, finishReason: 'STOP' }],
            functionCalls: [
                { id: 'fc_1', name: 'extract_single_action_item', args: { task: 'x' } },
                { id: 'fc_2', name: 'extract_single_action_item', args: { task: 'y' } },
            ]
        }
    ] });
    const session = new GaiChatSession({ client: sdk, model: 'gemini-2.0-flash', eventEmitter: new EventEmitter() });
    const tools = [{ name: 'extract_single_action_item' }];
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'Extract' })] });
    const { final } = await driveStep({ gen, tools });
    const sigs = final.messages
        .filter(/** @type {(...args: any[]) => any} */ (( m) => m.role === 'model' && Array.isArray(m.parts)))
        .flatMap(/** @type {(...args: any[]) => any} */ (( m) => m.parts.filter(/** @type {(...args: any[]) => any} */ (( p) => p.functionCall)).map(/** @type {(...args: any[]) => any} */ (( p) => p.thoughtSignature))));
    assert.deepEqual(sigs, ['sig-1', 'sig-2'], 'each parallel call must carry its own signature into history');
});

test('GAI step: per-part thoughtSignature uses last-wins policy', async () => {
    const sdk = buildGaiSdk({ chunks: [
        { candidates: [{ content: { parts: [{ text: 'a', thoughtSignature: 'first-sig' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'b', thoughtSignature: 'second-sig' }] } }] }
    ] });
    const session = new GaiChatSession({ client: sdk, model: 'gemini-2.0-flash', eventEmitter: new EventEmitter() });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'Hi' })] });
    const { final } = await driveStep({ gen });
    assert.equal(final.thoughtSignature, 'second-sig');
});



/**
 * @param {string[]} sseLines
 */
/** @param {{sseLines: *}} arg0 */
const buildJaiHttp = ({ sseLines }) => {
    const body = sseLines.map(/** @type {(...args: any[]) => any} */ (( l) => `data: ${l}\n\n`)).join('') + 'data: end\n\n';
    return {
        streamTimeout: 5000,
        _fetchWithRetry: async () => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                }
            });
            return { body: stream };
        }
    };
};

const stubProfileManager = /** @type {any} */ ({
    getProfile() { return null; },
    isSupported() { return true; },
    getProfiles: async () => ({})
});

test('JAI step: text-only response uses _formatFinalMessages helper', async () => {
    const httpClient = buildJaiHttp({ sseLines: [
        JSON.stringify({ type: 'Content', content: 'hi' })
    ] });
    const session = new JaiChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'jai-gpt-4o', eventEmitter: new EventEmitter(), profileManager: stubProfileManager });
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.JAI, content: 'Hi' })], options: { thoughtSignature: 'sig-init' } });
    const { final } = await driveStep({ gen });
    assert.equal(final.done, true);
    assert.equal(final.content, 'hi');
    const last = final.messages[final.messages.length - 1];
    assert.equal(last.type, 'assistant_message_text');
    assert.equal(last.content, 'hi');
});

test('JAI step: tool-call response uses _formatFinalMessages helper', async () => {
    const httpClient = buildJaiHttp({ sseLines: [
        JSON.stringify({ type: 'ToolCall', parallelToolIndex: 0, name: 'echo', content: '{}' }),
        JSON.stringify({ type: 'FinishMetadata', reason: 'tool_calls' })
    ] });
    const session = new JaiChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'jai-gpt-4o', eventEmitter: new EventEmitter(), profileManager: stubProfileManager });
    const tools = [{ name: 'echo' }];
    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.JAI, content: 'Hi' })], options: { thoughtSignature: 'sig-init' } });
    const { final, events } = await driveStep({ gen, tools });
    assert.equal(final.done, false, 'done is false for tool-call steps (agentic loop continues)');
    assert.ok(events.some(e => e && e.type === 'tool_request'));
    assert.equal(final.messages.length, 3);
    assert.equal(final.messages[1].type, 'assistant_message_tool');
    assert.equal(final.messages[1].toolName, 'echo');
    assert.equal(final.messages[2].type, 'tool_message');
    assert.equal(final.messages[2].toolName, 'echo');
});


test('OAI step: reasoning deltas surface as thought events, not as content', async () => {
    const chunks = (async function* () {
        yield { choices: [{ delta: { reasoning_content: 'weighing options' } }] };
        yield { choices: [{ delta: { content: 'the answer' } }] };
    })();
    const session = new OaiChatSession({ client: buildOaiSdk({ streamIter: chunks }), model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    const { events, final } = await driveStep({ gen: session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'Hi' })] }) });
    assert.deepEqual(events.filter(e => e.type === 'thought').map(e => e.content), ['weighing options']);
    assert.equal(final.content, 'the answer');
});

test('AAI step: thinking deltas surface as thought events, not as content', async () => {
    const sdk = buildAaiSdk({ events: [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 1 }
    ] });
    const session = new AaiChatSession({ client: sdk, model: 'claude-sonnet-4-5', eventEmitter: new EventEmitter() });
    const { events, final } = await driveStep({ gen: session.step({ messages: [createUserMessage({ provider: ProviderType.ANTHROPIC, content: 'Hi' })] }) });
    assert.deepEqual(events.filter(e => e.type === 'thought').map(e => e.content), ['let me think']);
    assert.equal(final.content, 'done');
});

test('GAI step: parts flagged thought:true surface as thought events, not as content', async () => {
    const sdk = buildGaiSdk({ chunks: [
        { candidates: [{ content: { parts: [{ text: 'internal', thought: true }, { text: 'visible' }] } }] }
    ] });
    const session = new GaiChatSession({ client: sdk, model: 'gemini-2.5-pro', eventEmitter: new EventEmitter() });
    const { events, final } = await driveStep({ gen: session.step({ messages: [createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'Hi' })] }) });
    assert.deepEqual(events.filter(e => e.type === 'thought').map(e => e.content), ['internal']);
    assert.equal(final.content, 'visible');
});

test('JAI step: ReasoningData surfaces as thought events, not as content', async () => {
    const httpClient = buildJaiHttp({ sseLines: [
        JSON.stringify({ type: 'ReasoningData', content: 'weighing options' }),
        JSON.stringify({ type: 'Content', content: 'the answer' })
    ] });
    const session = new JaiChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'jai-gpt-4o', eventEmitter: new EventEmitter(), profileManager: stubProfileManager });
    const { events, final } = await driveStep({ gen: session.step({ messages: [createUserMessage({ provider: ProviderType.JAI, content: 'Hi' })] }) });
    assert.deepEqual(events.filter(e => e.type === 'thought').map(e => e.content), ['weighing options']);
    assert.equal(final.content, 'the answer');
});
