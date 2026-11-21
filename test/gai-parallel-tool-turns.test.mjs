// @ts-check
/**
 * @file Parallel Gemini function calls keep one model turn and their own
 * thought signatures.
 * @version 0.22.0
 *
 * @description
 * Gemini returns parallel function calls in one model turn, each with its own
 * `thoughtSignature`. Replaying them as interleaved single-call turns breaks
 * the turn structure, and copying the first call's signature onto every call
 * sends a signature the vendor did not issue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { initializeClient } from '../lib/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/**
 * Drains a step generator, answering the tool round with `toolResults`.
 * @param {{gen: AsyncGenerator<any, any>, toolResults?: Array<any>|null}} arg0
 * @returns {Promise<any>}
 */
async function drive({ gen, toolResults = null }) {
    let step = await gen.next();
    while (!step.done) step = await gen.next(step.value.type === EVENTS.STEP.TOOL_REQUEST ? toolResults : undefined);
    return step.value;
}

test('a text part before calls does not carry the fallback signature', async () => {
    const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.GOOGLE_GENAI, options: { apiKey: 'test-key' } }));
    /** @type {Array<any>} */
    const requests = [];
    const call = { id: 'call_1', name: 'lookup', args: { q: 'a' } };
    client.transport = {
        models: {
            /** @param {any} args */
            generateContentStream: async (args) => {
                requests.push({ contents: JSON.parse(JSON.stringify(args.contents)) });
                return (async function* () {
                    if (requests.length === 1) {
                        yield {
                            candidates: [{ content: { parts: [
                                { text: 'Looking it up.', thoughtSignature: 'sig_text' },
                                { functionCall: { id: call.id, name: call.name, args: call.args } },
                            ] }, finishReason: 'STOP' }],
                            functionCalls: [call],
                        };
                    } else {
                        yield { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] };
                    }
                })();
            },
        },
    };

    const session = client.session('gemini-2.5-flash');
    const state = await drive({
        gen: session.step({ messages: [{ role: 'user', parts: [{ text: 'look it up' }] }] }),
        toolResults: [{ id: call.id, tool_call_id: call.id, name: call.name, success: true, result: 'ok' }],
    });

    await drive({ gen: session.step({ messages: state.messages }) });

    const modelRow = requests.at(-1).contents.find((/** @type {any} */ c) => c.role === 'model');
    const textPart = modelRow.parts.find((/** @type {any} */ p) => typeof p.text === 'string');
    const callPart = modelRow.parts.find((/** @type {any} */ p) => p.functionCall);
    assert.equal('thoughtSignature' in textPart, false, 'Gemini validates a signature per part; the text part is not the call');
    assert.equal(callPart.thoughtSignature, 'sig_text', 'the turn signature stays on the call part');
});

test('parallel calls are one model turn with their own signatures', async () => {
    const { client } = /** @type {any} */ (await initializeClient({ provider: ProviderType.GOOGLE_GENAI, options: { apiKey: 'test-key' } }));
    /** @type {Array<any>} */
    const requests = [];
    const calls = [
        { id: 'call_1', name: 'lookup', args: { q: 'a' }, thoughtSignature: 'sig_1' },
        { id: 'call_2', name: 'lookup', args: { q: 'b' }, thoughtSignature: 'sig_2' },
    ];
    client.transport = {
        models: {
            /** @param {any} args */
            generateContentStream: async (args) => {
                requests.push({ contents: JSON.parse(JSON.stringify(args.contents)) });
                return (async function* () {
                    if (requests.length === 1) {
                        yield {
                            candidates: [{ content: { parts: calls.map((c) => ({
                                functionCall: { id: c.id, name: c.name, args: c.args },
                                thoughtSignature: c.thoughtSignature,
                            })) }, finishReason: 'STOP' }],
                            functionCalls: calls,
                        };
                    } else {
                        yield { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] };
                    }
                })();
            },
        },
    };

    const session = client.session('gemini-2.5-flash');
    const results = calls.map((c) => ({ id: c.id, tool_call_id: c.id, name: c.name, success: true, result: `${c.id} ok` }));
    const state = await drive({
        gen: session.step({ messages: [{ role: 'user', parts: [{ text: 'look both up' }] }] }),
        toolResults: results,
    });

    const callRow = state.messages.at(-3);
    assert.equal(callRow.role, 'model', 'one model turn carries both calls');
    assert.equal(callRow.parts.length, 2, 'both calls share the model row');
    assert.deepEqual(callRow.parts.map((/** @type {any} */ p) => p.thoughtSignature), ['sig_1', 'sig_2'], 'each call keeps its own signature');

    await drive({ gen: session.step({ messages: state.messages }) });

    const contents = requests.at(-1).contents;
    assert.deepEqual(contents.map((/** @type {any} */ c) => c.role), ['user', 'model', 'user'], 'request 2 is one model turn, then one user turn');
    const modelRow = contents[1];
    assert.equal(modelRow.parts.length, 2, 'request 2 sends both calls in one model content');
    assert.deepEqual(modelRow.parts.map((/** @type {any} */ p) => p.functionCall.id), ['call_1', 'call_2']);
    assert.deepEqual(modelRow.parts.map((/** @type {any} */ p) => p.thoughtSignature), ['sig_1', 'sig_2']);
    assert.deepEqual(contents[2].parts.map((/** @type {any} */ p) => p.functionResponse.id), ['call_1', 'call_2'], 'both results answer that one turn');
});
