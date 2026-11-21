// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

const stubEmitter = new EventEmitter();

const stubAdapter = {
    vendorName: 'TEST',
    buildVendorRequest: () => ({ request: {}, observability: {} }),
    executeVendorRequest: async () => ({}),
    consumeStream: async function* () {
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'task', args: {} }] };
    },
    extractXmlToolCalls: () => [],
    /** @param {{call: *}} arg0 */
    formatToolCall: ({ call }) => ({ id: call.id, name: call.name, args: call.args ?? {} }),
};

const textAdapter = {
    vendorName: 'TEST',
    buildVendorRequest: () => ({ request: {}, observability: {} }),
    executeVendorRequest: async () => ({}),
    consumeStream: async function* () {
        yield { type: 'text', content: '{"ok":true}' };
    },
    extractXmlToolCalls: () => [],
    /** @param {{call: *}} arg0 */
    formatToolCall: ({ call }) => ({ id: call.id, name: call.name, args: {} }),
};


/** @param {{adapter: *}} arg0 */
function makeSession({ adapter }) {
    const session = new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'test-model',
        eventEmitter: stubEmitter,
        provider: ProviderType.OPENAI,
        adapter,
        /** @param {{s: *}} arg0 */
        buildParameters: ({ s }) => s,
    });
    session._onStepShouldPrepare = () => false;
    return session;
}

describe('step() unhandledToolCalls flag', () => {
    it('flags a tool round the caller never answered', async () => {
        const session = makeSession({ adapter: stubAdapter });
        const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'hi' })] });
        let result = await gen.next();
        while (!result.done) result = await gen.next();
        const finalState =  (result.value ?? {});
        assert.equal(/** @type {any} */ (finalState).unhandledToolCalls, true, 'unanswered tool round must be flagged');
    });

    it('does not flag when the caller answers the tool round', async () => {
        const session = makeSession({ adapter: stubAdapter });
        const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'hi' })] });
        let result = await gen.next();
        while (!result.done) {
            if (( (/** @type {any} */ (result.value)))?.type === 'tool_request') {
                result = await gen.next([{ result: 'ok' }]);
            } else {
                result = await gen.next();
            }
        }
        const finalState =  (result.value ?? {});
        assert.equal(/** @type {any} */ (finalState).unhandledToolCalls, undefined, 'answered tool round must not be flagged');
    });

    it('does not flag a plain text pass', async () => {
        const session = makeSession({ adapter: textAdapter });
        const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'hi' })] });
        let result = await gen.next();
        while (!result.done) result = await gen.next();
        const finalState =  (result.value ?? {});
        assert.equal(/** @type {any} */ (finalState).done, true);
        assert.equal(/** @type {any} */ (finalState).unhandledToolCalls, undefined);
    });
});