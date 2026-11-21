// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeToOAI,
    normalizeToAAI,
    normalizeToGAI
} from '../lib/messaging/messages.mjs';
import { SYSTEM_MESSAGE_MERGE_SEPARATOR } from '../lib/core/constants/index.mjs';

const SEP = SYSTEM_MESSAGE_MERGE_SEPARATOR;
const CHAT_MODEL = 'gpt-4o-mini';
const OSERIES_MODEL = 'o1-preview';

// ─── No-op cases ─────────────────────────────────────────────────────────────

test('no-op: empty input returns empty output', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [] });
    assert.deepEqual(out, []);
});

test('no-op: array with no system messages is unchanged', () => {
    const input = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'bye' }
    ];
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: input });
    assert.deepEqual(out, input);
    assert.notEqual(out, input, 'output must be a new array');
});

test('no-op: single system message is unchanged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'system', content: 'A' });
    assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

test('no-op: single developer message is unchanged (o-series)', () => {
    const out = normalizeToOAI({ model: OSERIES_MODEL, msgs: [
        { role: 'developer', content: 'A' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'developer', content: 'A' });
    assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

// ─── Basic merge: two consecutive ───────────────────────────────────────────

test('merge: two consecutive role:system → one merged with separator', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'system', content: `A${SEP}B` });
    assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

test('merge: two consecutive role:developer → one merged (o-series)', () => {
    const out = normalizeToOAI({ model: OSERIES_MODEL, msgs: [
        { role: 'developer', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'developer', content: `A${SEP}B` });
    assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

test('merge: system + developer are both system-ish → merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'system', 'first system-ish role wins');
    assert.equal(out[0].content, `A${SEP}B`);
});

test('merge: developer + system are both system-ish → merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'developer', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'developer', 'first system-ish role wins');
    assert.equal(out[0].content, `A${SEP}B`);
});

test('merge: three consecutive role:system → all merged into one', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'system', content: 'C' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'system', content: `A${SEP}B${SEP}C` });
    assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

// ─── Mixed cases: non-system messages interleaved ───────────────────────────

test('mixed: system, user, system, user → 4 messages, no merge', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'u2' }
    ] });
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], { role: 'system', content: 'A' });
    assert.deepEqual(out[1], { role: 'user', content: 'u1' });
    assert.deepEqual(out[2], { role: 'system', content: 'B' });
    assert.deepEqual(out[3], { role: 'user', content: 'u2' });
});

test('mixed: system, system, user → 2 messages (merged system + user)', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'u' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'system', content: `A${SEP}B` });
    assert.deepEqual(out[1], { role: 'user', content: 'u' });
});

test('mixed: user, system, system, assistant → 3 messages', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'user', content: 'u' },
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'assistant', content: 'a' }
    ] });
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { role: 'user', content: 'u' });
    assert.deepEqual(out[1], { role: 'system', content: `A${SEP}B` });
    assert.deepEqual(out[2], { role: 'assistant', content: 'a' });
});

test('mixed: alternating groups → each group merged independently', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A1' },
        { role: 'system', content: 'A2' },
        { role: 'user', content: 'u' },
        { role: 'system', content: 'B1' },
        { role: 'system', content: 'B2' },
        { role: 'system', content: 'B3' },
        { role: 'assistant', content: 'a' }
    ] });
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], { role: 'system', content: `A1${SEP}A2` });
    assert.deepEqual(out[1], { role: 'user', content: 'u' });
    assert.deepEqual(out[2], { role: 'system', content: `B1${SEP}B2${SEP}B3` });
    assert.deepEqual(out[3], { role: 'assistant', content: 'a' });
});

test('mixed: system at the very end of input → still emitted', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'user', content: 'u' },
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'user', content: 'u' });
    assert.deepEqual(out[1], { role: 'system', content: `A${SEP}B` });
});

// ─── Non-system roles are NOT merged ────────────────────────────────────────

test('non-merge: two consecutive assistant messages are NOT merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'assistant', content: 'a1' },
        { role: 'assistant', content: 'a2' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'assistant', content: 'a1' });
    assert.deepEqual(out[1], { role: 'assistant', content: 'a2' });
});

test('non-merge: two consecutive user messages are NOT merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'user', content: 'u1' });
    assert.deepEqual(out[1], { role: 'user', content: 'u2' });
});

test('non-merge: two consecutive tool messages are NOT merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'tool', tool_call_id: '1', content: 'r1' },
        { role: 'tool', tool_call_id: '2', content: 'r2' }
    ] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'tool', tool_call_id: '1', content: 'r1' });
    assert.deepEqual(out[1], { role: 'tool', tool_call_id: '2', content: 'r2' });
});

// ─── Separator behavior ─────────────────────────────────────────────────────

test('separator: the separator is exactly SYSTEM_MESSAGE_MERGE_SEPARATOR', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' }
    ] });
    assert.equal(out[0].content, `A${SYSTEM_MESSAGE_MERGE_SEPARATOR}B`);
    assert.equal(out[0].content, 'A\n\nB');
});

// ─── Content shapes ─────────────────────────────────────────────────────────

test('content: string + string → concatenated string', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' }
    ] });
    assert.equal(typeof out[0].content, 'string');
    assert.equal(out[0].content, `A${SEP}B`);
});

test('content: string + array of text parts → flattened and merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: [{ type: 'text', text: 'B' }, { type: 'text', text: 'C' }] }
    ] });
    assert.equal(typeof out[0].content, 'string');
    assert.equal(out[0].content, `A${SEP}BC`);
});

test('content: array of text parts + array of text parts → flattened and merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: [{ type: 'text', text: 'A1' }, { type: 'text', text: 'A2' }] },
        { role: 'system', content: [{ type: 'text', text: 'B' }] }
    ] });
    assert.equal(typeof out[0].content, 'string');
    assert.equal(out[0].content, `A1A2${SEP}B`);
});

// ─── Defensive: missing/null/empty content ──────────────────────────────────

test('defensive: null content + non-null content → handles gracefully', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: null },
        { role: 'system', content: 'B' }
    ] });
    assert.equal(out.length, 1);
    assert.equal(typeof out[0].content, 'string');
    assert.ok(/** @type {string} */ (out[0].content).includes('B'));
});

test('defensive: missing content field + non-null content → handles gracefully', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system' },
        { role: 'system', content: 'B' }
    ] });
    assert.equal(out.length, 1);
    assert.equal(typeof out[0].content, 'string');
    assert.ok(/** @type {string} */ (out[0].content).includes('B'));
});

test('defensive: empty content + non-null content → concatenated with separator', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { role: 'system', content: '' },
        { role: 'system', content: 'B' }
    ] });
    assert.equal(out.length, 1);
    assert.equal(out[0].content, `${SEP}B`);
});

// ─── O-series model behavior ────────────────────────────────────────────────

test('o-series: JAI-shape system_message promotes to role:developer, then merged', () => {
    const out = normalizeToOAI({ model: OSERIES_MODEL, msgs: [
        { type: 'system_message', content: 'A' },
        { type: 'system_message', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'developer', 'o-series should promote to role:developer');
    assert.equal(out[0].content, `A${SEP}B`);
    assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

test('chat-model: JAI-shape system_message promotes to role:system, then merged', () => {
    const out = normalizeToOAI({ model: CHAT_MODEL, msgs: [
        { type: 'system_message', content: 'A' },
        { type: 'system_message', content: 'B' }
    ] });
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'system', 'chat model should keep role:system');
    assert.equal(out[0].content, `A${SEP}B`);
});

test('o-series: JAI-shape developer_message stays as role:developer, then merged', () => {
    const out = normalizeToOAI({ model: OSERIES_MODEL, msgs: [
        { type: 'developer_message', content: 'A' },
        { type: 'developer_message', content: 'B' }
    ] });
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'developer');
    assert.equal(out[0].content, `A${SEP}B`);
});

// ─── Immutability ───────────────────────────────────────────────────────────

test('immutability: the input array is not mutated', () => {
    const input = [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' }
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeToOAI({ model: CHAT_MODEL, msgs: input });
    assert.deepEqual(input, snapshot, 'input array must not be mutated');
});

test('immutability: input messages are not mutated (deep)', () => {
    const sysA = { role: 'system', content: 'A' };
    const sysB = { role: 'system', content: 'B' };
    const input = [sysA, sysB, { role: 'user', content: 'hi' }];
    normalizeToOAI({ model: CHAT_MODEL, msgs: input });
    assert.equal(sysA.content, 'A', 'first system message must not be mutated');
    assert.equal(sysB.content, 'B', 'second system message must not be mutated');
});

// ─── Bug-class regression: OAI/AAI/GAI parity ──────────────────────────────

test('parity: AAI normalizer already collapses (regression sentinel)', () => {
    const out = normalizeToAAI({ msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.system, `A${SEP}B`);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
});

test('parity: GAI normalizer already collapses (regression sentinel)', () => {
    const out = normalizeToGAI({ msgs: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' }
    ] });
    assert.equal(out.systemInstruction, `A${SEP}B`);
    assert.equal(out.contents.length, 1);
    assert.equal(out.contents[0].role, 'user');
});
