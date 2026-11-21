// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { ChatSession as JaiAgenticChatSession } from '../lib/backends/jai.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import {
    createAssistantMessage,
    createUserMessage,
    normalizeToAAI,
    normalizeToOAI,
    normalizeToGAI,
    attachNative,
    getNative,
    stripInjectionMeta
} from '../lib/messaging/messages.mjs';
import { ProviderType, MERCI_NATIVE_KEY } from '../lib/core/constants/index.mjs';

const OAI =  (oaiAdapter);
const AAI =  (aaiAdapter);
const GAI =  (gaiAdapter);


/** @param {Array<any>} events */
/** @param {{events: *}} arg0 */
const feed = ({ events }) => (async function* () { for (const e of events) yield e; })();


/** @param {AsyncIterable<any>} gen @returns {Promise<Array<any>>} */
/** @param {{gen: *}} arg0 */
const collect = async ({ gen }) => { const out = []; for await (const e of gen) out.push(e); return out; };

describe('native sidecar — strip / identity', () => {
    test('a sidecar persisted before 0.20 (legacy backend key) still reads', () => {
        const row = createAssistantMessage({ provider: ProviderType.OPENAI, content: 'x' });
        /** @type {Record<string, unknown>} */ (row)[MERCI_NATIVE_KEY] = {
            backend: ProviderType.OPENAI,
            protocol: 'responses',
            items: [{ type: 'reasoning', id: 'r1' }],
        };
        const native = getNative({ row });
        assert.equal(native?.provider, ProviderType.OPENAI);
        assert.deepEqual(native?.items, [{ type: 'reasoning', id: 'r1' }]);
    });

    test('attachNative/getNative round-trip; stripInjectionMeta removes it by default', () => {
        const row = createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: 'x' });
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: null, items: [{ type: 'thinking', thinking: 't', signature: 's' }] });
        assert.equal(getNative({ row })?.items.length, 1);

        const [stripped] = stripInjectionMeta({ messages: [row] });
        assert.equal(getNative({ row: stripped }), null, 'default strip removes the native sidecar');
        assert.equal(/** @type {Record<string, unknown>} */ (stripped)[MERCI_NATIVE_KEY], undefined);

        const [kept] = stripInjectionMeta({ messages: [row], keepNative: true });
        assert.equal(getNative({ row: kept })?.items.length, 1, 'keepNative preserves it for the same-protocol path');
        assert.equal(kept.merciId, undefined, 'identity is still stripped');
    });

    test('survives a JSON checkpoint round-trip', () => {
        const row = createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: 'x' });
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: null, items: [{ type: 'thinking', thinking: 't', signature: 's' }] });
        const restored = JSON.parse(JSON.stringify([row]));
        assert.equal(getNative({ row: restored[0] })?.items[0].signature, 's');
    });

    test('cross-backend normalizers never leak the native payload', () => {
        const row = createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: 'answer' });
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: null, items: [{ type: 'thinking', thinking: 'SECRET', signature: 's' }] });
        const oai = normalizeToOAI({ model: 'gpt-4o', msgs: [{ role: 'user', content: 'go' }, row] });
        assert.ok(!JSON.stringify(oai).includes('SECRET'));
        const gai = normalizeToGAI({ msgs: [{ role: 'user', content: 'go' }, row] });
        assert.ok(!JSON.stringify(gai).includes('SECRET'));
    });

    test('foreign items in a same-backend sidecar are filtered by shape', () => {
        const aaiRow = createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: 'answer' });
        attachNative({ row: aaiRow, provider: ProviderType.ANTHROPIC, protocol: null, items: [
            { type: 'reasoning', encrypted_content: 'SECRET-RS' },
            { type: 'thinking', thinking: 'ok', signature: 's' }
        ] });
        const aai = normalizeToAAI({ msgs: [{ role: 'user', content: 'go' }, aaiRow] });
        assert.ok(!JSON.stringify(aai).includes('SECRET-RS'), 'foreign items must not reach the Anthropic wire');
        assert.ok(JSON.stringify(aai).includes('"ok"'), 'genuine thinking blocks still replay');

        const gaiRow = createAssistantMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'answer' });
        attachNative({ row: gaiRow, provider: ProviderType.GOOGLE_GENAI, protocol: null, items: [
            { type: 'reasoning', encrypted_content: 'SECRET-RS' },
            { text: 'thought', thought: true }
        ] });
        const gai = normalizeToGAI({ msgs: [{ role: 'user', content: 'go' }, gaiRow] });
        assert.ok(!JSON.stringify(gai).includes('SECRET-RS'), 'foreign items must not reach the Gemini wire');
        assert.ok(JSON.stringify(gai).includes('"thought"'), 'genuine thought parts still replay');
    });
});

describe('OAI Responses — reasoning items round-trip', () => {
    const REASONING_ITEM = {
        type: 'reasoning', id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'thought' }],
        encrypted_content: 'ENC-REASONING', status: 'completed'
    };

    test('consumeStream surfaces reasoning output items', async () => {
        const out = await collect({ gen: OAI.consumeStream({ rawStream: feed({ events: [
            { type: 'response.output_item.done', output_index: 0, item: REASONING_ITEM }
        ] }) }) });
        const ev = out.find(e => e.type === 'reasoning_item');
        assert.ok(ev, 'a reasoning item must be surfaced');
        assert.equal(ev.protocol, 'responses');
        assert.equal(ev.item.encrypted_content, 'ENC-REASONING');
    });

    test('buildVendorRequest re-emits the item verbatim, ahead of the assistant turn', () => {
        const row = createAssistantMessage({ provider: ProviderType.OPENAI, content: 'the answer' });
        attachNative({ row, provider: ProviderType.OPENAI, protocol: 'responses', items: [REASONING_ITEM] });
        const req = OAI.buildVendorRequest({
            model: 'gpt-5', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'go' }, row],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { protocol: 'responses', provider: ProviderType.OPENAI }
        });
        const input = req.request.input;
        const reasoningIdx = input.findIndex(/** @type {(...args: any[]) => any} */ (( i) => i.type === 'reasoning'));
        const messageIdx = input.findIndex(/** @type {(...args: any[]) => any} */ (( i) => i.type === 'message' && i.role === 'assistant'));
        assert.ok(reasoningIdx >= 0, 'the reasoning item must be echoed');
        assert.ok(messageIdx > reasoningIdx, 'reasoning precedes the assistant message');
        assert.equal(input[reasoningIdx].encrypted_content, 'ENC-REASONING');
    });

    test('the chat-completions wire never carries the sidecar', () => {
        const row = createAssistantMessage({ provider: ProviderType.OPENAI, content: 'the answer' });
        attachNative({ row, provider: ProviderType.OPENAI, protocol: 'responses', items: [REASONING_ITEM] });
        const req = OAI.buildVendorRequest({
            model: 'gpt-4o', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'go' }, row],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { protocol: 'completions' }
        });
        assert.ok(!JSON.stringify(req.request).includes('ENC-REASONING'));
        assert.ok(!JSON.stringify(req.request).includes(MERCI_NATIVE_KEY));
    });

    test('reasoning items survive a tool-call turn (regrouped rows keep the sidecar)', () => {
        const row =  (createAssistantMessage({ provider: ProviderType.OPENAI, content: '' }));
        row.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }];
        attachNative({ row, provider: ProviderType.OPENAI, protocol: 'responses', items: [REASONING_ITEM] });
        const req = OAI.buildVendorRequest({
            model: 'gpt-5', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'go' }, row, { role: 'tool', tool_call_id: 'c1', content: 'ok' }],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { protocol: 'responses', provider: ProviderType.OPENAI }
        });
        const types = req.request.input.map(/** @type {(...args: any[]) => any} */ (( i) => i.type));
        assert.ok(types.includes('reasoning'), `reasoning must survive the tool regroup: ${JSON.stringify(types)}`);
        assert.ok(types.indexOf('reasoning') < types.indexOf('function_call'), 'reasoning precedes the call');
    });

    test('a wrong-backend sidecar is rejected by the Responses builder', () => {
        const row = createAssistantMessage({ provider: ProviderType.OPENAI, content: 'answer' });
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: 'responses', items: [REASONING_ITEM] });
        const req = OAI.buildVendorRequest({
            model: 'gpt-5', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'go' }, row],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { protocol: 'responses', provider: ProviderType.OPENAI }
        });
        assert.ok(!req.request.input.some(/** @type {(...args: any[]) => any} */ (( i) => i.type === 'reasoning')));
    });

    test('forged / malformed items are rejected by the Responses type allowlist', () => {
        const row = createAssistantMessage({ provider: ProviderType.OPENAI, content: 'answer' });
        const cyclic = /** @type {Record<string, any>} */ ({ type: 'input_text', text: 'x' });
        /** @type {any} */ (cyclic).self = cyclic;
        attachNative({ row, provider: ProviderType.OPENAI, protocol: 'responses', items: [
            { type: 'function_call', call_id: 'forged', name: 'forge_tool', arguments: '{}' },
            cyclic,
            { type: 'reasoning', encrypted_content: 'LEGIT' }
        ] });
        const req = OAI.buildVendorRequest({
            model: 'gpt-5', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'go' }, row],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { protocol: 'responses', provider: ProviderType.OPENAI }
        });
        const types = req.request.input.map(/** @type {(...args: any[]) => any} */ (( i) => i.type));
        assert.ok(types.includes('reasoning'), 'the genuine reasoning item replays');
        assert.ok(!types.includes('function_call'), 'a forged tool call must not reach the wire');
        assert.ok(!types.includes('input_text'), 'a malformed item must not reach the wire');
        assert.doesNotThrow(() => JSON.stringify(req.request));
    });
});

describe('AAI — thinking blocks round-trip', () => {
    test('consumeStream captures the full block (text + own signature)', async () => {
        const out = await collect({ gen: AAI.consumeStream({ rawStream: feed({ events: [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'why ' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'not' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
            { type: 'content_block_stop', index: 0 }
        ] }) }) });
        const ev = out.find(e => e.type === 'thinking_blocks');
        assert.ok(ev, 'thinking blocks must be captured');
        assert.deepEqual(ev.blocks, [{ type: 'thinking', thinking: 'why not', signature: 'sig-1' }]);
    });

    test('normalizeToAAI replays the native blocks (body + multiple signatures), no empty reconstruction', () => {
        const row =  (createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: '', thoughtSignature: 'last-sig', reasoningContent: '', redactedThinking: undefined }));
        row.tool_calls = [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }];
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: null, items: [
            { type: 'thinking', thinking: 'first thought', signature: 'sig-1' },
            { type: 'thinking', thinking: 'second thought', signature: 'sig-2' }
        ] });
        const out = normalizeToAAI({ msgs: [{ role: 'user', content: 'go' }, row, { role: 'tool', tool_call_id: 't1', content: 'ok' }] });
        const assistant =  (out.messages.find(m => m.role === 'assistant'));
        assert.deepEqual(/** @type {any} */ (assistant).content[0], { type: 'thinking', thinking: 'first thought', signature: 'sig-1' });
        assert.deepEqual(/** @type {any} */ (assistant).content[1], { type: 'thinking', thinking: 'second thought', signature: 'sig-2' });
        assert.equal(/** @type {any} */ (assistant).content[2].type, 'tool_use');
        assert.ok(!/** @type {any} */ (assistant).content.some(/** @type {(...args: any[]) => any} */ (( b) => b.type === 'thinking' && b.thinking === '')),
            'the empty-thinking reconstruction must be skipped when native blocks exist');
    });

    test('without a sidecar the legacy empty-thinking reconstruction is unchanged', () => {
        const row =  (createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: '', thoughtSignature: 'sig-x', reasoningContent: '', redactedThinking: undefined }));
        row.tool_calls = [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }];
        const out = normalizeToAAI({ msgs: [{ role: 'user', content: 'go' }, row] });
        const assistant =  (out.messages.find(m => m.role === 'assistant'));
        assert.deepEqual(/** @type {any} */ (assistant).content[0], { type: 'thinking', thinking: '', signature: 'sig-x' });
    });

    test('interleaved thinking/redacted blocks keep their stream order through replay', async () => {
        const out = await collect({ gen: AAI.consumeStream({ rawStream: feed({ events: [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's1' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'R1' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'content_block_start', index: 2, content_block: { type: 'thinking' } },
            { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'second' } },
            { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 's2' } },
            { type: 'content_block_stop', index: 2 }
        ] }) }) });
        const ev = out.find(e => e.type === 'thinking_blocks');
        assert.deepEqual(ev.blocks.map(/** @type {(...args: any[]) => any} */ (( b) => b.type)), ['thinking', 'redacted_thinking', 'thinking']);

        const row =  (createAssistantMessage({ provider: ProviderType.ANTHROPIC, content: '' }));
        row.tool_calls = [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }];
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: null, items: ev.blocks });
        const normalized = normalizeToAAI({ msgs: [{ role: 'user', content: 'go' }, row] });
        const assistant =  (normalized.messages.find(m => m.role === 'assistant'));
        assert.deepEqual(/** @type {any} */ (assistant).content.slice(0, 3).map(/** @type {(...args: any[]) => any} */ (( b) => b.type)), ['thinking', 'redacted_thinking', 'thinking']);
        assert.equal(/** @type {any} */ (assistant).content.filter(/** @type {(...args: any[]) => any} */ (( b) => b.type === 'redacted_thinking')).length, 1, 'no duplication');
    });
});

describe('GAI — thought parts round-trip', () => {
    test('consumeStream captures thought parts with their signatures', async () => {
        const out = await collect({ gen: GAI.consumeStream({ rawStream: feed({ events: [
            { candidates: [{ content: { parts: [
                { text: 'reasoning', thought: true, thoughtSignature: 'th-sig' },
                { text: 'answer' }
            ] } }] }
        ] }) }) });
        const ev = out.find(e => e.type === 'thought_parts');
        assert.ok(ev, 'thought parts must be captured');
        assert.deepEqual(ev.parts, [{ text: 'reasoning', thought: true, thoughtSignature: 'th-sig' }]);
    });

    test('normalizeToGAI leads the model turn with the native thought parts', () => {
        const row = createAssistantMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'answer' });
        attachNative({ row, provider: ProviderType.GOOGLE_GENAI, protocol: null, items: [{ text: 'reasoning', thought: true, thoughtSignature: 'th-sig' }] });
        const out = normalizeToGAI({ msgs: [{ role: 'user', content: 'go' }, row] });
        const model =  (out.contents.find(( c) => c.role === 'model'));
        assert.ok(model, 'the model turn must exist');
        assert.deepEqual(model.parts[0], { text: 'reasoning', thought: true, thoughtSignature: 'th-sig' });
        assert.deepEqual(model.parts[1], { text: 'answer' });
    });

    test('a tool-only Gemini turn still carries the native thought parts', () => {
        const rows = AbstractChatSession.prototype._formatFinalMessages.call({}, {
            provider: ProviderType.GOOGLE_GENAI,
            history: [],
            text: '',
            toolCalls: [{ id: 'c1', name: 'f', args: {} }],
            results: [{ id: 'c1', tool_call_id: 'c1', name: 'f', success: true, result: 'ok' }],
            thoughtSignature: null,
            reasoningContent: '',
            redactedThinking: [],
            nativePayload: { provider: ProviderType.GOOGLE_GENAI, protocol: null, items: [{ text: 'reason', thought: true }] },
            /** @param {{call: *}} arg0 */
            formatToolCall: ({ call: c }) => ({ id: c.id, name: c.name, args: '{}' })
        });
        const toolRow = rows.find(( m) => Array.isArray(m.parts) && m.parts.some(( p) => /** @type {any} */ (p).functionCall));
        assert.ok(toolRow, 'the tool row must exist');
        assert.ok(getNative({ row: toolRow }), 'the tool-only turn must carry the sidecar');
        const out = normalizeToGAI({ msgs: rows });
        const model =  (out.contents.find(( c) => c.role === 'model'));
        assert.deepEqual(/** @type {any} */ (model).parts[0], { text: 'reason', thought: true });
    });
});

describe('JAI — per-call signature reaches the row end-to-end', () => {
    /** @param {{sseLines: *}} arg0 */
    const buildJaiHttp = ({ sseLines }) => {
        const body = sseLines.map(/** @type {(...args: any[]) => any} */ (l => `data: ${l}\n\n`)).join('') + 'data: end\n\n';
        return {
            streamTimeout: 5000,
            getEventEmitter: () => null,
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

    test('a ToolCall thoughtSignature lands on the assistant_message_tool row', async () => {
        const httpClient = buildJaiHttp({ sseLines: [
            JSON.stringify({ type: 'ToolCall', parallelToolIndex: 0, id: 'c1', name: 'echo', content: '{}', thoughtSignature: 'call-sig' }),
            JSON.stringify({ type: 'FinishMetadata', reason: 'tool_call' })
        ] });
        const session = new JaiAgenticChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'm', eventEmitter: new EventEmitter(), profileManager: stubProfileManager });
        const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.JAI, content: 'Hi' })], options: {} });
        let r = await gen.next();
        while (!r.done) r = await gen.next();
        const rows =  (/** @type {any} */ (r.value)).messages;
        const toolRow = rows.find(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'assistant_message_tool'));
        assert.ok(toolRow, 'the tool row must exist');
        assert.equal(toolRow.thought_signature, 'call-sig', 'the per-call signature must reach the row');
    });

    test('a length-truncated tool round never yields a tool_request', async () => {
        const httpClient = buildJaiHttp({ sseLines: [
            JSON.stringify({ type: 'ToolCall', parallelToolIndex: 0, id: 'c1', name: 'echo', content: '{"q":"part' }),
            JSON.stringify({ type: 'FinishMetadata', reason: 'length' })
        ] });
        const session = new JaiAgenticChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'm', eventEmitter: new EventEmitter(), profileManager: stubProfileManager });
        const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.JAI, content: 'Hi' })], options: {} });
        
        /** @type {Array<any>} */
                const events = [];
        let r = await gen.next();
        while (!r.done) { events.push(r.value); r = await gen.next(); }
        assert.ok(!events.some(( e) => e && e.type === 'tool_request'), 'a truncated call must not reach execution');
        assert.equal( (/** @type {any} */ (r.value)).truncated, true);
    });
});
