// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const USER_MSG = [{ type: 'user_message', content: 'ping' }];


/**
 * @param {Array<Record<string, any>>} chunks
 */
/** @param {{chunks: *}} arg0 */
const makeAdapter = ({ chunks }) => ({
    vendorName: 'STUB',
    
    /**
     * @param {{ model?: any }} param0
     */
        buildVendorRequest({ model }) {
        return { request: { model }, observability: { model } };
    },
    executeVendorRequest() {
        return (async function* () {
            for (const c of chunks) yield c;
        })();
    },
    /** @param {{rawStream: *}} arg0 */
    consumeStream({ rawStream }) {
        return (async function* () {
            for await (const chunk of rawStream) {
                if (chunk && typeof chunk.text === 'string') {
                    
                    /** @type {Record<string, any>} */
                                        const ev = { type: 'text', content: chunk.text };
                    if (chunk.thoughtSignature) ev.thoughtSignature = chunk.thoughtSignature;
                    yield ev;
                } else if (chunk && chunk.type === 'thought_signature') {
                    yield chunk;
                }
            }
        })();
    },
    extractXmlToolCalls() { return []; },
    /** @param {{call: *}} arg0 */
    formatToolCall({ call }) { return { id: call.id, name: call.name, args: call.args }; },
});

class StubSession extends AbstractChatSession {
    /** @param {{adapter: *, emitter?: *}} arg0 */
    constructor({ adapter, emitter = new EventEmitter() }) {
        super({ provider: ProviderType.JAI, model: 'gemini-3-flash', eventEmitter: emitter, client: null, vendorClient: {} });
        this._adapter = adapter;
    }
}


/**
  * @param {{gen: *, events?: *}} arg0
 */
async function collect({ gen, events = [] }) {
    let r = await gen.next();
    while (!r.done) {
        events.push(r.value);
        r = await gen.next();
    }
    return r.value;
}

test('step(): a turn that emitted no signature reports null and stamps nothing', async () => {
    const session = new StubSession({ adapter: makeAdapter({ chunks: [{ text: 'hello' }] }) });
    const finalState = await collect({ gen: session.step({ messages: USER_MSG, options: { thoughtSignature: 'prev-turn-sig' } }) });

    assert.equal(finalState.thoughtSignature, null, 'the incoming signature must not be echoed as this turn\'s');
    const asst = finalState.messages.find(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'assistant_message_text'));
    assert.ok(asst, 'the assistant row must exist');
    assert.equal(asst.thought_signature, undefined, 'a later text turn must not inherit a function-call signature');
    assert.equal(asst.thoughtSignature, undefined);
});

test('step(): a signature emitted by this stream lands on the new assistant row', async () => {
    const session = new StubSession({ adapter: makeAdapter({ chunks: [
        { type: 'thought_signature', signature: 'fresh-sig' },
        { text: 'hello' }
    ] }) });
    const finalState = await collect({ gen: session.step({ messages: USER_MSG, options: { thoughtSignature: 'prev-turn-sig' } }) });

    assert.equal(finalState.thoughtSignature, 'fresh-sig');
    const asst = finalState.messages.find(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'assistant_message_text'));
    assert.equal(asst.thought_signature, 'fresh-sig');
});

test('JAI _onStepWillStart: a trailing assistant text turn is never stamped', () => {
    const session = new JaiChatSession({ httpClient: /** @type {any} */ ({}), profile: 'p', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
    const bare = [
        { type: 'user_message', content: 'multiply' },
        { type: 'assistant_message_text', content: 'May I?' },
        { type: 'user_message', content: 'approved' }
    ];
    const { messages } = session._onStepWillStart({ messages: bare, options: { thoughtSignature: 'prev-turn-sig' } });
    assert.equal(messages[1].thoughtSignature, undefined, 'a text turn must never receive a stale signature');
    assert.equal(messages[1].thought_signature, undefined);
});

test('JAI _onStepWillStart: a function call missing its signature is still stamped', () => {
    const session = new JaiChatSession({ httpClient: /** @type {any} */ ({}), profile: 'p', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
    const messages = [
        { type: 'user_message', content: 'multiply' },
        { type: 'assistant_message_tool', id: 'c1', toolName: 'math_genius', content: '{"a":1,"b":2}' },
        { type: 'tool_message', id: 'c1', toolName: 'math_genius', result: '{"product":2}' }
    ];
    const out = session._onStepWillStart({ messages, options: { thoughtSignature: 'sig-call' } }).messages;
    assert.equal(out[1].thoughtSignature, 'sig-call');
});

test('JAI _onStepWillStart: every call of the trailing parallel turn is stamped', () => {
    const session = new JaiChatSession({ httpClient: /** @type {any} */ ({}), profile: 'p', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
    const messages = [
        { type: 'user_message', content: 'multiply' },
        { type: 'assistant_message_tool', id: 'c1', toolName: 'f', content: '{}' },
        { type: 'tool_message', id: 'c1', toolName: 'f', result: '{}' },
        { type: 'assistant_message_tool', id: 'c2', toolName: 'f', content: '{}' },
        { type: 'tool_message', id: 'c2', toolName: 'f', result: '{}' },
        { type: 'assistant_message_tool', id: 'c3', toolName: 'f', content: '{}' },
        { type: 'tool_message', id: 'c3', toolName: 'f', result: '{}' }
    ];
    const out = session._onStepWillStart({ messages, options: { thoughtSignature: 'sig-turn' } }).messages;
    const toolRows = out.filter(( m) => m.type === 'assistant_message_tool');
    assert.deepEqual(toolRows.map(( m) => m.thoughtSignature), ['sig-turn', 'sig-turn', 'sig-turn']);
});

test('JAI _onStepWillStart: an earlier turn keeps its own signatures', () => {
    const session = new JaiChatSession({ httpClient: /** @type {any} */ ({}), profile: 'p', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
    const messages = [
        { type: 'user_message', content: 'first' },
        { type: 'assistant_message_tool', id: 'old', toolName: 'f', content: '{}', thought_signature: 'old-sig' },
        { type: 'tool_message', id: 'old', toolName: 'f', result: '{}' },
        { type: 'user_message', content: 'second' },
        { type: 'assistant_message_tool', id: 'c1', toolName: 'f', content: '{}' },
        { type: 'tool_message', id: 'c1', toolName: 'f', result: '{}' }
    ];
    const out = session._onStepWillStart({ messages, options: { thoughtSignature: 'sig-turn' } }).messages;
    assert.equal(out[1].thought_signature, 'old-sig', 'the earlier turn is untouched');
    assert.equal(out[1].thoughtSignature, undefined);
    assert.equal(out[4].thoughtSignature, 'sig-turn');
});
