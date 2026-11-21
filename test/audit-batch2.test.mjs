// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, normalizeToOAI, normalizeToAAI, normalizeToGAI } from '../lib/messaging/messages.mjs';
import { formatJaiMessages } from '../lib/backends/jai-vendor/messages.mjs';
import { SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

// ─── B-M1: GAI-shaped history through the JAI path keeps user text ──────────

test('B-M1 GAI parts rows convert on the JAI path (user text preserved, no raw rows)', () => {
    const jai =  (normalizeHistory({ provider: ProviderType.JAI, messages: [
        { role: 'user', parts: [{ text: 'hello from gemini' }] },
        { role: 'model', parts: [{ text: 'hi' }, { functionCall: { id: 'c1', name: 'get_weather', args: { q: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'get_weather', response: { output: 'sunny' } } }, { text: 'and now?' }] },
    ] }));
    const shaped =  (formatJaiMessages({ messages: jai }));
    const userRows = shaped.filter(( r) => r.type === 'user_message');
    assert.equal(userRows.length, 2);
    assert.equal(userRows[0].content, 'hello from gemini', 'user text must survive the GAI→JAI transplant');
    assert.ok(String(userRows[1].content).includes('and now?'));
    const toolRow =  (shaped.find(( r) => r.type === 'tool_message'));
    assert.equal(/** @type {any} */ (toolRow).id, 'c1');
    assert.ok(String(/** @type {any} */ (toolRow).result).includes('sunny'));
    const toolCallRow =  (shaped.find(( r) => r.type === 'assistant_message_tool'));
    assert.equal(/** @type {any} */ (toolCallRow).toolName, 'get_weather');
    assert.ok(!shaped.some(( r) => r.parts !== undefined), 'no raw parts row may reach the gateway');
});

// ─── B-M2: JAI-typed array content corrupts AAI/GAI wires ────────────────────

test('B-M2a JAI-typed multimodal user row converts on the AAI wire', () => {
    const out = normalizeToAAI({ msgs: [
        { type: 'user_message', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,XXX' } }] },
    ] });
    assert.equal(out.messages.length, 1);
    const blocks = /** @type {Array<Record<string, any>>} */ (out.messages[0].content);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, 'look');
    assert.equal(blocks[1].type, 'image', 'image_url must become an image block, not text:[array]');
    assert.equal(blocks[1].source.data, 'XXX');
});

test('B-M2b GAI inlineData part maps to an Anthropic image block', () => {
    const out = normalizeToAAI({ msgs: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'YYY' } }] },
    ] });
    const blocks = /** @type {Array<Record<string, any>>} */ (out.messages[0].content);
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].source.data, 'YYY');
});

test('B-M2c JAI-typed array content converts on the GAI wire (no text:[array])', () => {
    const out = normalizeToGAI({ msgs: [
        { type: 'user_message', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZ' } }] },
        { type: 'assistant_message_text', content: [{ type: 'text', text: 'reply' }] },
    ] });
    assert.deepEqual(out.contents[0], { role: 'user', parts: [{ text: 'a' }, { inlineData: { mimeType: 'image/png', data: 'ZZ' } }] });
    const modelParts = out.contents[1].parts;
    assert.equal(modelParts[0].text, 'reply', 'assistant array flattens to text parts, not text:[array]');
    assert.ok(modelParts[0].thoughtSignature === undefined || typeof modelParts[0].thoughtSignature === 'string');
});

// ─── B-M3: GAI→OAI parallel functionResponses all survive ────────────────────

test('B-M3 parallel functionResponses produce one tool row each, prose preserved', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'f', args: {} } }, { functionCall: { id: 'c2', name: 'f', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'f', response: { output: 'r1' } } }, { functionResponse: { id: 'c2', name: 'f', response: { output: 'r2' } } }, { text: 'NOTE' }] },
    ] }));
    const toolRows = out.filter((r) => r.role === 'tool');
    assert.equal(toolRows.length, 2, 'every functionResponse must become its own tool row');
    assert.deepEqual(toolRows.map((r) => r.tool_call_id), ['c1', 'c2']);
    const note = /** @type {Record<string, any>} */ (out.find((r) => r.role === 'user'));
    assert.equal(note.content, 'NOTE', 'co-present prose must not vanish');
});

// ─── B-M4: AAI→OAI keeps text next to tool_result ────────────────────────────

test('B-M4 text beside a tool_result survives AAI→OAI', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }, { type: 'text', text: 'SIDENOTE' }] },
    ] }));
    const toolRow = /** @type {Record<string, any>} */ (out.find((r) => r.role === 'tool'));
    assert.equal(toolRow.content, 'r1');
    const note = /** @type {Record<string, any>} */ (out.find((r) => r.role === 'user'));
    assert.equal(note.content, 'SIDENOTE');
});

// ─── B-M5: thinking-only AAI row no longer yields a degenerate OAI row ───────

test('B-M5 a thinking-only assistant row is dropped, not degenerate tool_calls:[]', () => {
    const out =  (normalizeToOAI({ model: 'gpt-4o', msgs: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
    ] }));
    assert.ok(!out.some(( r) => r.role === 'assistant'), 'no degenerate assistant row on the wire');
    assert.equal(out.length, 1);
});

// ─── B-M6: thoughtSignature survives plain-text turns (AAI + GAI) ───────────

test('B-M6a AAI text turn re-emits the thinking block with its signature', () => {
    const out =  (normalizeToAAI({ msgs: [{ role: 'assistant', content: 'plain', thoughtSignature: 'SIG' }] }));
    const blocks = /** @type {Array<Record<string, any>>} */ (out.messages[0].content);
    assert.equal(blocks[0].type, 'thinking');
    assert.equal(blocks[0].signature, 'SIG');
    assert.equal(blocks[1].text, 'plain');
});

test('B-M6b GAI text turn carries thoughtSignature on the part', () => {
    const out =  (normalizeToGAI({ msgs: [{ type: 'assistant_message_text', content: 'reply', thought_signature: 'SIG2' }] }));
    assert.equal(out.contents[0].parts[0].thoughtSignature, 'SIG2');
});

// ─── B-M7: role-shaped system rows are promoted for o-series ─────────────────

test('B-M7 role system rows are promoted to developer for o-series', () => {
    const out =  (normalizeToOAI({ model: 'o1-preview', msgs: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
    ] }));
    assert.equal(out[0].role, 'developer');
    assert.equal(out[0].content, 'sys');
});

// ─── B-M8: ambiguous success is never mislabeled is_error ────────────────────

test('B-M8 a successful payload containing an error key round-trips as success', () => {
    const ok = JSON.stringify({ error: 'ECONNRESET (retried, ok)', merci_success: true });
    const out =  (normalizeToAAI({ msgs: [{ role: 'tool', tool_call_id: 'x', content: ok }] }));
    assert.equal(/** @type {Array<Record<string, any>>} */ (out.messages[0].content)[0].is_error, false, 'merci_success must win over the error-key sniff');

    const failed =  (normalizeToAAI({ msgs: [{ role: 'tool', tool_call_id: 'x', content: JSON.stringify({ error: 'boom' }) }] }));
    assert.equal(/** @type {Array<Record<string, any>>} */ (failed.messages[0].content)[0].is_error, true, 'the legacy failure envelope still flags');
});

// ─── B-T1: parallel tool calls without parallelToolIndex no longer kill SSE ──

test('B-T1 parallel ToolCall fragments without parallelToolIndex assemble both calls', () => {
    const parser = new SSEParser();
    
    /** @param {any} o */
        const d = (o) => 'data: ' + JSON.stringify(o) + '\n';
    parser.parseLine({ line: d({ type: 'ToolCall', id: 'a', name: 'f1', content: '{"x":1}' }) });
    parser.parseLine({ line: d({ type: 'ToolCall', id: 'b', name: 'f2', content: '{"y":2}' }) });
    parser.parseLine({ line: d({ type: 'FinishMetadata', reason: 'tool_call' }) });
    const calls =  (parser.getFinalResult().toolCalls);
    assert.equal(calls.length, 2, 'the second call must open a new slot, not throw SSEError');
    assert.deepEqual(calls.map(( c) => c.name), ['f1', 'f2']);
});

test('B-T1b an id relocating to a different explicit index is still corruption', () => {
    const parser = new SSEParser();
    
    /** @param {any} o */
        const d = (o) => 'data: ' + JSON.stringify(o) + '\n';
    parser.parseLine({ line: d({ type: 'ToolCall', parallelToolIndex: 0, id: 'a', name: 'f1' }) });
    assert.throws(() => parser.parseLine({ line: d({ type: 'ToolCall', parallelToolIndex: 1, id: 'a', name: 'f1' }) }), /moved from index/);
});

// ─── JAI empty-assistant-turn guard ──────────────────────────────────────────

test('JAI path drops every empty assistant spelling', () => {
    const out =  (normalizeHistory({ provider: ProviderType.JAI, messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '  ' },
        { type: 'assistant_message_text', content: '' },
    ] }));
    assert.ok(!out.some((r) => r.type === 'assistant_message_text'), 'no empty assistant turn reaches the JAI wire');
    assert.equal(out.length, 1);
});

// ─── empty-turn predicate: whitespace arrays and reasoning-only rows ─────────

test('whitespace-only text-block assistant arrays are dropped; reasoning-only rows are kept', () => {
    const dropped =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    ] }));
    assert.equal(dropped.length, 1, 'a whitespace-only array turn is empty');

    const kept =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', reasoning_content: 'chain of thought' },
    ] }));
    assert.equal(kept.length, 2, 'a reasoning-only assistant row carries replay payload');
    assert.equal(kept[1].reasoning_content, 'chain of thought');
});
