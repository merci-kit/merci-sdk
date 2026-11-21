// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatJaiMessages } from '../lib/backends/jai-vendor/messages.mjs';

// ─── assistant_message_text ──────────────────────────────────────────────────

test('formatJaiMessages: renames thought_signature → thoughtSignature on assistant_message_text', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'assistant_message_text', content: 'hi', thought_signature: 'sig_a' }
    ] });
    const m = out[0];
    assert.equal(m.thoughtSignature, 'sig_a');
    assert.equal(m.thought_signature, undefined, 'snake_case must be removed');
    assert.equal(m.content, 'hi');
});

test('formatJaiMessages: preserves thoughtSignature if already camelCase on assistant_message_text', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'assistant_message_text', content: 'hi', thoughtSignature: 'sig_b' }
    ] });
    assert.equal(out[0].thoughtSignature, 'sig_b');
    assert.equal(out[0].thought_signature, undefined);
});

test('formatJaiMessages: leaves assistant_message_text without signature untouched', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'assistant_message_text', content: 'no sig' }
    ] });
    assert.deepEqual(out[0], { type: 'assistant_message_text', content: 'no sig' });
});

// ─── assistant_message_tool ──────────────────────────────────────────────────

test('formatJaiMessages: renames thought_signature → thoughtSignature on assistant_message_tool', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'assistant_message_tool', id: 'c1', toolName: 'get_weather', content: '{"city":"Paris"}', thought_signature: 'sig_c' }
    ] });
    const m = out[0];
    assert.equal(m.thoughtSignature, 'sig_c');
    assert.equal(m.thought_signature, undefined, 'snake_case must be removed on the assistant tool-call message');
    assert.equal(m.id, 'c1');
    assert.equal(m.toolName, 'get_weather');
    assert.equal(m.content, '{"city":"Paris"}');
});

test('formatJaiMessages: preserves thoughtSignature if already camelCase on assistant_message_tool', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'assistant_message_tool', id: 'c1', toolName: 'get_weather', content: '{}', thoughtSignature: 'sig_d' }
    ] });
    assert.equal(out[0].thoughtSignature, 'sig_d');
    assert.equal(out[0].thought_signature, undefined);
});

// ─── tool_message ───────────────────────────────────────────────────────────

test('formatJaiMessages: strips thought_signature from tool_message (JAI V9 wire has no signature on tool results)', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'get_weather', result: '{"t":14}', thought_signature: 'sig_e' }
    ] });
    const m = out[0];
    assert.equal(m.thought_signature, undefined, 'snake_case must be removed');
    assert.equal(m.thoughtSignature, undefined, 'camelCase must be removed if present');
    assert.equal(m.id, 'c1');
    assert.equal(m.toolName, 'get_weather');
    assert.equal(m.result, '{"t":14}');
});

test('formatJaiMessages: strips thoughtSignature from tool_message too (defensive against camelCase input)', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'get_weather', result: '{}', thoughtSignature: 'sig_f' }
    ] });
    assert.equal(out[0].thought_signature, undefined);
    assert.equal(out[0].thoughtSignature, undefined);
    assert.equal(out[0].result, '{}');
});

test('formatJaiMessages: leaves tool_message without signature untouched', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'get_weather', result: '{}' }
    ] });
    assert.deepEqual(out[0], { type: 'tool_message', id: 'c1', toolName: 'get_weather', result: '{}' });
});

// ─── tool_message.result JSON-stringification (V9 wire expects a string) ────

test('formatJaiMessages: JSON-stringifies tool_message.result when it is an object (V9 wire format)', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'get_weather', result: { temperature: 18, unit: 'celsius' } }
    ] });
    const m = out[0];
    assert.equal(typeof m.result, 'string', 'result must be a string on the V9 wire');
    assert.equal(m.result, JSON.stringify({ temperature: 18, unit: 'celsius' }));
    assert.deepEqual(JSON.parse(m.result), { temperature: 18, unit: 'celsius' });
});

test('formatJaiMessages: JSON-stringifies tool_message.result when it is a number', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'sum', result: 42 }
    ] });
    assert.equal(out[0].result, '42');
});

test('formatJaiMessages: JSON-stringifies tool_message.result when it is a boolean', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'flag', result: true }
    ] });
    assert.equal(out[0].result, 'true');
});

test('formatJaiMessages: JSON-stringifies tool_message.result when it is null', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'noop', result: null }
    ] });
    assert.equal(out[0].result, 'null');
});

test('formatJaiMessages: JSON-stringifies tool_message.result when it is an array', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'list', result: [1, 2, 3] }
    ] });
    assert.equal(out[0].result, '[1,2,3]');
});

test('formatJaiMessages: leaves tool_message.result as-is when it is already a string', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'greet', result: 'hello world' }
    ] });
    assert.equal(out[0].result, 'hello world');
});

test('formatJaiMessages: tool_message without result field is unchanged', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'noop' }
    ] });
    assert.deepEqual(out[0], { type: 'tool_message', id: 'c1', toolName: 'noop' });
});

test('formatJaiMessages: strips signature AND stringifies result on tool_message (combined rule)', () => {
    /** @type {any[]} */ const out = formatJaiMessages({ messages: [
        { type: 'tool_message', id: 'c1', toolName: 'get_weather', result: { t: 14 }, thought_signature: 'sig_x' }
    ] });
    const m = out[0];
    assert.equal(m.thought_signature, undefined);
    assert.equal(m.thoughtSignature, undefined);
    assert.equal(m.id, 'c1');
    assert.equal(m.toolName, 'get_weather');
    assert.equal(m.result, '{"t":14}');
});

// ─── Pass-through (no mutation) for non-affected types ──────────────────────

test('formatJaiMessages: passes user_message through unchanged', () => {
    const input = [{ type: 'user_message', content: 'hi' }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.deepEqual(out[0], { type: 'user_message', content: 'hi' });
});

test('formatJaiMessages: keeps a system_message row native when a user row exists (probed live on the gateway)', () => {
    const input = [{ type: 'system_message', content: 'sys' }, { type: 'user_message', content: 'hi' }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 2, 'system rows are NOT folded into the user turn');
    assert.deepEqual(out[0], { type: 'system_message', content: 'sys' });
    assert.deepEqual(out[1], { type: 'user_message', content: 'hi' });
});

test('formatJaiMessages: keeps multiple system_message rows native (gateway accepts them)', () => {
    const input = [
        { type: 'system_message', content: 'Rule A.' },
        { type: 'system_message', content: 'Rule B.' },
        { type: 'user_message', content: 'hi' }
    ];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.filter((/** @type {any} */ m) => m.type === 'system_message').length, 2);
});

test('formatJaiMessages: a system-only history folds into a user_message (Vertex requires non-system contents)', () => {
    const input = [{ type: 'system_message', content: 'sys' }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 1, 'the system row is folded — Vertex/Gemini 400 a system-only history');
    assert.equal(out[0].type, 'user_message');
    assert.ok(out[0].content.includes('sys'), 'the content survives the fold');
});

test('formatJaiMessages: a system-only history joins multiple rows with the shared separator', () => {
    const input = [{ type: 'system_message', content: 'A' }, { type: 'system_message', content: 'B' }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 1);
    assert.ok(out[0].content.includes('A'));
    assert.ok(out[0].content.includes('B'));
});

// ─── Array-content user messages → native media_message + user_message ──────

test('formatJaiMessages: splits OAI array content into media_message + text user_message (gateway rejects arrays)', () => {
    const input = [{
        type: 'user_message',
        content: [
            { type: 'text', text: 'see this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ]
    }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { type: 'media_message', mediaType: 'image/png', data: 'AAAA' });
    assert.deepEqual(out[1], { type: 'user_message', content: 'see this' });
});

test('formatJaiMessages: splits GAI inline_data array content into a media_message', () => {
    const input = [{
        type: 'user_message',
        content: [{ inline_data: { mime_type: 'image/jpeg', data: 'BBBB' } }, { text: 'look' }]
    }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.deepEqual(out[0], { type: 'media_message', mediaType: 'image/jpeg', data: 'BBBB' });
    assert.deepEqual(out[1], { type: 'user_message', content: 'look' });
});

test('formatJaiMessages: splits AAI image source array content into a media_message', () => {
    const input = [{
        type: 'user_message',
        content: [
            { text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } }
        ]
    }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.deepEqual(out[0], { type: 'media_message', mediaType: 'image/webp', data: 'CCCC' });
    assert.deepEqual(out[1], { type: 'user_message', content: 'look' });
});

test('formatJaiMessages: joins multiple text parts into one user_message', () => {
    const input = [{ type: 'user_message', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'a\nb');
});

test('formatJaiMessages: a media-only array yields only media rows', () => {
    const input = [{ type: 'user_message', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,DDDD' } }] }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'media_message');
    assert.equal(out[0].data, 'DDDD');
});

test('formatJaiMessages: an unrecognized part is JSON-encoded into the text, never dropped', () => {
    const input = [{ type: 'user_message', content: [{ type: 'text', text: 'x' }, { weird: 1 }] }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 1);
    assert.ok(out[0].content.includes('x'));
    assert.ok(out[0].content.includes('{\"weird\":1}'));
});

test('formatJaiMessages: a non-data image URL falls back to JSON text (media_message needs base64)', () => {
    const input = [{ type: 'user_message', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'user_message');
    assert.ok(out[0].content.includes('https://example.com/a.png'));
});

test('formatJaiMessages: passes media_message through unchanged', () => {
    const input = [{ type: 'media_message', mediaType: 'image/png', data: 'base64...' }];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.deepEqual(out[0], { type: 'media_message', mediaType: 'image/png', data: 'base64...' });
});

test('formatJaiMessages: passes OAI-shape messages through (defensive — adapter must not mutate non-JAI shape)', () => {
    const input = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'f', content: '{}' }
    ];
    /** @type {any[]} */ const out = formatJaiMessages({ messages: input });
    assert.deepEqual(out, input);
});

// ─── Multi-message: full lesson-15 second-turn wire shape ────────────────────

test('formatJaiMessages: full lesson-15 second-turn wire format (the regression scenario)', () => {
    const unified = [
        { type: 'user_message', content: "What's the weather in Paris?" },
        { type: 'assistant_message_tool', id: 'call_abc', toolName: 'get_current_weather', content: '{"city":"Paris"}', thought_signature: 'sig_xyz' },
        { type: 'tool_message', id: 'call_abc', toolName: 'get_current_weather', result: '{"temperature":"14","unit":"celsius"}', thought_signature: 'sig_xyz' }
    ];
    /** @type {any[]} */ const wire = formatJaiMessages({ messages: unified });

    assert.deepEqual(wire[0], { type: 'user_message', content: "What's the weather in Paris?" });

    const a = wire[1];
    assert.equal(a.type, 'assistant_message_tool');
    assert.equal(a.id, 'call_abc');
    assert.equal(a.toolName, 'get_current_weather');
    assert.equal(a.content, '{"city":"Paris"}');
    assert.equal(a.thoughtSignature, 'sig_xyz', 'must be camelCase on the wire');
    assert.equal(a.thought_signature, undefined, 'snake_case must NOT be on the wire');

    const t = wire[2];
    assert.equal(t.type, 'tool_message');
    assert.equal(t.id, 'call_abc');
    assert.equal(t.toolName, 'get_current_weather');
    assert.equal(t.result, '{"temperature":"14","unit":"celsius"}');
    assert.equal(t.thought_signature, undefined, 'thought_signature must NOT be on tool_message wire');
    assert.equal(t.thoughtSignature, undefined, 'thoughtSignature must NOT be on tool_message wire');
});

// ─── No-mutation guarantee ──────────────────────────────────────────────────

test('formatJaiMessages: does not mutate the input array or its message objects', () => {
    const input = [
        { type: 'assistant_message_tool', id: 'c1', toolName: 'f', content: '{}', thought_signature: 'sig_x' },
        { type: 'tool_message', id: 'c1', toolName: 'f', result: '{}', thought_signature: 'sig_x' }
    ];
    const inputSnapshot = JSON.parse(JSON.stringify(input));
    formatJaiMessages({ messages: input });
    assert.deepEqual(input, inputSnapshot, 'input array must not be mutated');
});

test('formatJaiMessages: handles non-array input defensively', () => {
    assert.equal(formatJaiMessages({ messages: /** @type {any} */ (null) }), null);
    assert.equal(formatJaiMessages({ messages: /** @type {any} */ (undefined) }), undefined);
});

test('formatJaiMessages: handles empty array', () => {
    assert.deepEqual(formatJaiMessages({ messages: [] }), []);
});
