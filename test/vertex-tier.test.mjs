// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { initializeClient } from '../lib/index.mjs';
import { ProviderType, ProtocolType, StandardType, isStandard } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ChatSession as GaiSession } from '../lib/backends/gai.mjs';
import { createAssistantMessage, attachNative, normalizeToGAI } from '../lib/messaging/messages.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';

const VERTEX_OPTIONS = { genaiOptions: { vertexai: true, project: 'test-project', location: 'global' } };


/** @param {{chunks: *}} arg0 */
function stubStream({ chunks }) {
    return {
        models: {
            generateContentStream: async () => (async function* () {
                for (const chunk of chunks) yield chunk;
            })()
        }
    };
}


/** @param {{gen: *, toolResults?: *}} arg0 */
async function drive({ gen, toolResults = null }) {
    let step = await gen.next();
    while (!step.done) {
        step = await gen.next(step.value.type === EVENTS.STEP.TOOL_REQUEST ? toolResults : undefined);
    }
    return step.value;
}

describe('Google-family predicate', () => {
    it('is true for both Google tiers and false for the others', () => {
        assert.equal(isStandard({ provider: ProviderType.GOOGLE_GENAI, standard: StandardType.GAI }), true);
        assert.equal(isStandard({ provider: ProviderType.VERTEX, standard: StandardType.GAI }), true);
        for (const provider of [ProviderType.OPENAI, ProviderType.ANTHROPIC, ProviderType.JAI, ProviderType.OPENROUTER, ProviderType.LOCAL, ProviderType.OPENCODE]) {
            assert.equal(isStandard({ provider, standard: StandardType.GAI }), false, provider);
        }
        assert.equal(isStandard({ provider: 'nope', standard: StandardType.GAI }), false);
    });
});

describe('tier identity', () => {
    it('GenAI client/session report google_genai', async () => {
        const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.GOOGLE_GENAI, options: { apiKey: 'test-key' } }));
        assert.equal(client.provider, ProviderType.GOOGLE_GENAI);
        assert.equal(client.vertexai, false);
        const session = client.session('gemini-x');
        assert.equal(session.provider, ProviderType.GOOGLE_GENAI);
        assert.equal(session.protocol, ProtocolType.GENERATE_CONTENT);
    });

    it('Vertex client/session/events report vertex', async () => {
        const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.VERTEX, options: VERTEX_OPTIONS }));
        assert.equal(client.provider, ProviderType.VERTEX);
        assert.equal(client.vertexai, true);
        
        /** @type {Array<any>} */
                const events = [];
        client.on(EVENTS.CLIENT.SESSION_START, /** @type {(...args: any[]) => any} */ (( e) => events.push(e)));
        const session = client.session('gemini-x');
        assert.equal(session.provider, ProviderType.VERTEX);
        assert.equal(session.protocol, ProtocolType.GENERATE_CONTENT);
        assert.equal(events.at(-1)?.provider, ProviderType.VERTEX);
    });

    it('a directly constructed GAI session still defaults to google_genai', () => {
        const session = new ( (GaiSession))({ client: {}, model: 'gemini-x', eventEmitter: new EventEmitter() });
        assert.equal(session.provider, ProviderType.GOOGLE_GENAI);
    });
});

describe('vertex rows use the Gemini wire shape', () => {
    it('text turn produces a role:model parts row', async () => {
        const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.VERTEX, options: VERTEX_OPTIONS }));
        client.transport = stubStream({ chunks: [{ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }] });
        const session = client.session('gemini-x');
        const state = await drive({ gen: session.step({ messages: [{ role: 'user', parts: [{ text: 'hi' }] }] }) });
        const row = state.messages.at(-1);
        assert.equal(row.role, 'model');
        assert.deepEqual(row.parts, [{ text: 'hello' }]);
    });

    it('tool turn keeps per-call functionCall/functionResponse rows (no OAI merge)', async () => {
        const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.VERTEX, options: VERTEX_OPTIONS }));
        client.transport = stubStream({ chunks: [{
            candidates: [{ content: { parts: [
                { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'SF' } }, thoughtSignature: 'sig_1' }
            ] }, finishReason: 'STOP' }],
            functionCalls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SF' } }]
        }] });
        const session = client.session('gemini-x');
        const result = { id: 'call_1', tool_call_id: 'call_1', name: 'get_weather', success: true, result: 'sunny' };
        const state = await drive({ gen: session.step({ messages: [{ role: 'user', parts: [{ text: 'weather?' }] }] }), toolResults: [result] });
        const callRow = state.messages.at(-2);
        const resultRow = state.messages.at(-1);
        assert.equal(callRow.role, 'model');
        assert.equal(callRow.parts[0].functionCall.name, 'get_weather');
        assert.equal(callRow.parts[0].thoughtSignature, 'sig_1');
        assert.equal(callRow.tool_calls, undefined);
        assert.equal(resultRow.role, 'user');
        assert.deepEqual(resultRow.parts[0].functionResponse, { id: 'call_1', name: 'get_weather', response: { output: 'sunny' } });
    });
});

describe('Vertex rejects a tool result followed by text in the same turn', () => {
    const responsePart = { functionResponse: { id: 'call_1', name: 'manage_todos', response: { success: true } } };

    it('moves functionResponse parts after a merged live-state text part', () => {
        const { contents } = normalizeToGAI({ msgs: [
            { role: 'user', parts: [{ text: 'Add two tasks' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'manage_todos', args: {} } }] },
            { role: 'user', parts: [responsePart] },
            { type: 'user_message', content: '[LIVE STATE]\nTodos: two pending' },
        ] });
        assert.equal(contents.length, 3);
        const last = contents[contents.length - 1];
        assert.ok(last);
        assert.deepEqual(last.parts, [
            { text: '[LIVE STATE]\nTodos: two pending' },
            responsePart,
        ]);
    });

    it('keeps a turn that is only functionResponses unchanged', () => {
        const second = { functionResponse: { id: 'call_2', name: 'manage_todos', response: { success: true } } };
        const { contents } = normalizeToGAI({ msgs: [
            { role: 'user', parts: [{ text: 'Add two tasks' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'manage_todos', args: {} } }] },
            { role: 'user', parts: [responsePart, second] },
        ] });
        const last = contents[contents.length - 1];
        assert.ok(last);
        assert.deepEqual(last.parts, [responsePart, second]);
    });

    it('the second request after a tool round ends with text before functionResponse', async () => {
        const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.VERTEX, options: VERTEX_OPTIONS }));
        /** @type {Array<any>} */
        const requests = [];
        client.transport = { models: { generateContentStream: async (/** @type {any} */ args) => {
            requests.push({ contents: JSON.parse(JSON.stringify(args.contents)) });
            return (async function* () {
                if (requests.length === 1) {
                    yield { candidates: [{ content: { parts: [
                        { functionCall: { id: 'call_1', name: 'manage_todos', args: { action: 'add', title: 'a' } } },
                    ] }, finishReason: 'STOP' }], functionCalls: [{ id: 'call_1', name: 'manage_todos', args: { action: 'add', title: 'a' } }] };
                } else {
                    yield { candidates: [{ content: { parts: [{ text: 'Added.' }] }, finishReason: 'STOP' }], text: 'Added.' };
                }
            })();
        } } };
        const session = client.session('gemini-x');
        const result = { id: 'call_1', tool_call_id: 'call_1', name: 'manage_todos', success: true, result: { message: 'added 1' } };
        const state = await drive({ gen: session.step({ messages: [{ role: 'user', parts: [{ text: 'add a task' }] }] }), toolResults: [result] });
        const prepared = [...state.messages, { type: 'user_message', content: '[LIVE STATE]\nTodos: one pending' }];
        await drive({ gen: session.step({ messages: prepared }) });
        const requestContents = requests[requests.length - 1].contents;
        const last = requestContents[requestContents.length - 1];
        assert.equal(last.role, 'user');
        const lastPart = last.parts[last.parts.length - 1];
        assert.equal(Boolean(lastPart.functionResponse), true, 'functionResponse is the last part');
        assert.equal(typeof last.parts[0].text, 'string', 'the live-state text precedes it');
    });
});

describe('native sidecar replay accepts both Google tiers', () => {
    for (const provider of [ProviderType.GOOGLE_GENAI, ProviderType.VERTEX]) {
        it(`${provider}: thought parts lead the model turn`, () => {
            const row = createAssistantMessage({ provider, content: 'answer' });
            attachNative({ row, provider, protocol: ProtocolType.GENERATE_CONTENT, items: [{ text: 'reasoning', thought: true, thoughtSignature: 'th-1' }] });
            const { contents } = normalizeToGAI({ msgs: [row] });
            assert.deepEqual(contents, [{
                role: 'model',
                parts: [{ text: 'reasoning', thought: true, thoughtSignature: 'th-1' }, { text: 'answer' }]
            }]);
        });
    }

    it('a foreign native sidecar is not replayed', () => {
        const row = createAssistantMessage({ provider: ProviderType.VERTEX, content: 'answer' });
        attachNative({ row, provider: ProviderType.ANTHROPIC, protocol: null, items: [{ text: 'reasoning', thought: true }] });
        assert.deepEqual(normalizeToGAI({ msgs: [row] }).contents, [{ role: 'model', parts: [{ text: 'answer' }] }]);
    });
});

describe('thinkingLevel on the Google wire', () => {
    for (const provider of [ProviderType.GOOGLE_GENAI, ProviderType.VERTEX]) {
        it(`${provider}: the wire body carries the uppercase enum`, () => {
            const { request } = /** @type {any} */ (gaiAdapter).buildVendorRequest({
                model: 'gemini-x',
                parameters: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
                tools: [], preparedMessages: [],
                forceTextResponse: false, toolChoiceRequired: false,
                session: { provider, protocol: 'responses', eventEmitter: new EventEmitter() },
            });
            assert.equal(request.config.thinkingConfig.thinkingLevel, 'HIGH');
        });
    }
});
