// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHistory } from '../lib/messaging/messages.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

test('normalizeHistory(JAI): plain assistant text normalizes to exactly one message', () => {
    const out = /** @type {Array<Record<string, any>>} */ (normalizeHistory({ provider: ProviderType.JAI, messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
    ] }));
    assert.equal(out.length, 2, 'no raw duplicate may leak through');
    assert.equal(out[1].type, 'assistant_message_text');
    assert.equal(out[1].content, 'hello');
});

test('normalizeHistory(JAI): assistant text + tool_calls produces text and tool messages, no raw copy', () => {
    const out = /** @type {Array<Record<string, any>>} */ (normalizeHistory({ provider: ProviderType.JAI, messages: [
        {
            role: 'assistant',
            content: 'calling',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]
        }
    ] }));
    assert.equal(out.length, 2);
    assert.equal(out[0].type, 'assistant_message_text');
    assert.equal(out[0].content, 'calling');
    const toolMsg = out[1];
    assert.equal(toolMsg.type, 'assistant_message_tool');
    assert.equal(toolMsg.id, 'c1');
    assert.equal(toolMsg.toolName, 'f');
    assert.equal(toolMsg.content, '{"a":1}');
    assert.equal(out.some(m => m.role), false, 'no role-shaped message may survive into JAI history');
});
