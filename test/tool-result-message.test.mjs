// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createToolResultMessage,
    createUserMessage,
    createSystemMessage,
    createAssistantMessage,
    createToolCallMessage
} from '../lib/messaging/messages.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const successResult = {
    id: 'call_123',
    tool_call_id: 'call_123',
    name: 'get_weather',
    success: true,
    result: { temperature: 72, condition: 'sunny' }
};

const errorResult = {
    id: 'call_456',
    tool_call_id: 'call_456',
    name: 'fail_tool',
    success: false,
    error: 'Tool execution failed: timeout'
};

const stringResult = {
    id: 'call_789',
    tool_call_id: 'call_789',
    name: 'echo',
    success: true,
    result: 'plain text response'
};

// ─── JAI ────────────────────────────────────────────────────────────────

test('JAI: success case emits tool_message with object result', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.JAI, result: successResult, thoughtSignature: 'sig_xyz' }));
    assert.equal(msg.type, 'tool_message');
    assert.equal(msg.id, 'call_123');
    assert.equal(msg.toolName, 'get_weather');
    assert.deepEqual(msg.result, { temperature: 72, condition: 'sunny' });
    assert.equal(msg.thought_signature, 'sig_xyz');
    assert.equal(msg.thoughtSignature, undefined, 'JAI must use snake_case, not camelCase');
});

test('JAI: success case with string result passes through as-is', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.JAI, result: stringResult }));
    assert.equal(msg.type, 'tool_message');
    assert.equal(msg.id, 'call_789');
    assert.equal(msg.toolName, 'echo');
    assert.equal(msg.result, 'plain text response');
    assert.equal(msg.thought_signature, undefined, 'no sig if not provided');
});

test('JAI: error case emits tool_message with { error } envelope', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.JAI, result: errorResult }));
    assert.equal(msg.type, 'tool_message');
    assert.equal(msg.id, 'call_456');
    assert.equal(msg.toolName, 'fail_tool');
    assert.deepEqual(msg.result, { error: 'Tool execution failed: timeout' });
});

test('JAI: prefers result.id over result.tool_call_id (defensive)', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.JAI, result: {
        id: 'primary',
        tool_call_id: 'fallback',
        name: 'x',
        success: true,
        result: 'ok'
    } }));
    assert.equal(msg.id, 'primary');
});

// ─── OPENAI ───────────────────────────────────────────────────────────────────

test('OPENAI: success case emits role:tool with JSON-stringified content', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.OPENAI, result: successResult, thoughtSignature: 'sig_aaa' }));
    assert.equal(msg.role, 'tool');
    assert.equal(msg.tool_call_id, 'call_123');
    assert.equal(msg.name, 'get_weather');
    assert.equal(msg.content, JSON.stringify({ temperature: 72, condition: 'sunny' }));
    assert.equal(msg.thoughtSignature, 'sig_aaa');
});

test('OPENAI: error case emits role:tool with { error } envelope JSON-stringified', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.OPENAI, result: errorResult }));
    assert.equal(msg.role, 'tool');
    assert.equal(msg.tool_call_id, 'call_456');
    assert.equal(msg.name, 'fail_tool');
    assert.equal(msg.content, JSON.stringify({ error: 'Tool execution failed: timeout' }));
    assert.equal(msg.thoughtSignature, undefined);
});

test('OPENAI: tolerates results missing tool_call_id (uses id only)', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.OPENAI, result: {
        id: 'only_id',
        name: 'fn',
        success: true,
        result: 42
    } }));
    assert.equal(msg.tool_call_id, 'only_id');
    assert.equal(msg.content, '42');
});

// ─── ANTHROPIC ────────────────────────────────────────────────────────────────

test('ANTHROPIC: success case emits user-wrapped tool_result with is_error=false', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.ANTHROPIC, result: successResult }));
    assert.equal(msg.role, 'user');
    assert.ok(Array.isArray(msg.content));
    assert.equal(msg.content.length, 1);
    const block = msg.content[0];
    assert.equal(block.type, 'tool_result');
    assert.equal(block.tool_use_id, 'call_123');
    assert.equal(block.is_error, false);
    assert.ok(Array.isArray(block.content), 'object success value is wrapped in text block');
    assert.equal(block.content[0].type, 'text');
    assert.equal(block.content[0].text, JSON.stringify({ temperature: 72, condition: 'sunny' }));
});

test('ANTHROPIC: success with string result keeps content as a bare string', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.ANTHROPIC, result: stringResult }));
    const block = msg.content[0];
    assert.equal(block.type, 'tool_result');
    assert.equal(block.is_error, false);
    assert.equal(block.content, 'plain text response');
});

test('ANTHROPIC: error case emits user-wrapped tool_result with is_error=true and string content', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.ANTHROPIC, result: errorResult }));
    assert.equal(msg.role, 'user');
    const block = msg.content[0];
    assert.equal(block.type, 'tool_result');
    assert.equal(block.tool_use_id, 'call_456');
    assert.equal(block.is_error, true);
    assert.equal(block.content, 'Tool execution failed: timeout');
});

test('ANTHROPIC: error case defaults content when result.error is missing', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.ANTHROPIC, result: {
        id: 'e1',
        name: 'broken',
        success: false
    } }));
    const block = msg.content[0];
    assert.equal(block.is_error, true);
    assert.equal(block.content, 'Tool execution failed.');
});

// ─── GOOGLE_GENAI ─────────────────────────────────────────────────────────────

test('GOOGLE_GENAI: success case emits user-wrapped functionResponse with object response', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.GOOGLE_GENAI, result: successResult }));
    assert.equal(msg.role, 'user');
    assert.ok(Array.isArray(msg.parts));
    assert.equal(msg.parts.length, 1);
    const part = msg.parts[0];
    assert.ok(part.functionResponse, 'part has functionResponse block');
    assert.equal(part.functionResponse.id, 'call_123');
    assert.equal(part.functionResponse.name, 'get_weather');
    assert.deepEqual(part.functionResponse.response, { temperature: 72, condition: 'sunny' });
});

test('GOOGLE_GENAI: success with string result wraps in { output } envelope', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.GOOGLE_GENAI, result: stringResult }));
    const part = msg.parts[0];
    assert.equal(part.functionResponse.id, 'call_789');
    assert.deepEqual(part.functionResponse.response, { output: 'plain text response' });
});

test('GOOGLE_GENAI: error case emits user-wrapped functionResponse with { error } response', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.GOOGLE_GENAI, result: errorResult }));
    const part = msg.parts[0];
    assert.equal(part.functionResponse.id, 'call_456');
    assert.deepEqual(part.functionResponse.response, { error: 'Tool execution failed: timeout' });
});

// ─── Cross-backend invariant tests ───────────────────────────────────────────

test('createToolResultMessage: defaults thoughtSignature to null (omitted from output)', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.OPENAI, result: successResult }));
    assert.equal(msg.thoughtSignature, undefined);
});

test('createToolResultMessage: empty string thoughtSignature is treated as falsy and omitted', () => {
    const msg = /** @type {any} */ (createToolResultMessage({ provider: ProviderType.OPENAI, result: successResult, thoughtSignature: '' }));
    assert.equal(msg.thoughtSignature, undefined);
});

// ─── Companion unified factories still produce the right shapes ──────────────

test('createUserMessage(ProviderType.JAI, ...) emits JAI-shape (type)', () => {
    const msg = /** @type {any} */ (createUserMessage({ provider: ProviderType.JAI, content: 'hi' }));
    assert.equal(msg.type, 'user_message');
    assert.equal(msg.content, 'hi');
});

test('createUserMessage(ProviderType.OPENAI, ...) emits OAI-shape (role)', () => {
    const msg = /** @type {any} */ (createUserMessage({ provider: ProviderType.OPENAI, content: 'hi' }));
    assert.equal(msg.role, 'user');
    assert.equal(msg.content, 'hi');
});

test('createSystemMessage(ProviderType.JAI, ...) emits JAI-shape (type)', () => {
    const msg = /** @type {any} */ (createSystemMessage({ provider: ProviderType.JAI, content: 'sys' }));
    assert.equal(msg.type, 'system_message');
    assert.equal(msg.content, 'sys');
});

test('createSystemMessage(ProviderType.OPENAI, ...) emits OAI-shape (role)', () => {
    const msg = /** @type {any} */ (createSystemMessage({ provider: ProviderType.OPENAI, content: 'sys' }));
    assert.equal(msg.role, 'system');
    assert.equal(msg.content, 'sys');
});

test('createAssistantMessage(ProviderType.JAI, ...) uses snake_case thought_signature', () => {
    const msg = /** @type {any} */ (createAssistantMessage({ provider: ProviderType.JAI, content: 'reply', thoughtSignature: 'sig_1' }));
    assert.equal(msg.type, 'assistant_message_text');
    assert.equal(msg.content, 'reply');
    assert.equal(msg.thought_signature, 'sig_1');
    assert.equal(msg.thoughtSignature, undefined);
});

test('createAssistantMessage(ProviderType.GOOGLE_GENAI, ...) emits GAI-shape (parts + thoughtSignature on part)', () => {
    const msg = /** @type {any} */ (createAssistantMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'reply', thoughtSignature: 'sig_g' }));
    assert.equal(msg.role, 'model');
    assert.equal(msg.parts.length, 1);
    assert.equal(msg.parts[0].text, 'reply');
    assert.equal(msg.parts[0].thoughtSignature, 'sig_g');
});

test('createAssistantMessage(ProviderType.OPENAI, ...) uses camelCase thoughtSignature', () => {
    const msg = /** @type {any} */ (createAssistantMessage({ provider: ProviderType.OPENAI, content: 'reply', thoughtSignature: 'sig_o' }));
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content, 'reply');
    assert.equal(msg.thoughtSignature, 'sig_o');
});

test('createToolCallMessage(ProviderType.JAI, ...) emits JAI-shape', () => {
    const msg = /** @type {any} */ (createToolCallMessage({ provider: ProviderType.JAI, id: 'c1', name: 'get_weather', args: '{"city":"SF"}', thoughtSignature: 'sig_j' }));
    assert.equal(msg.type, 'assistant_message_tool');
    assert.equal(msg.id, 'c1');
    assert.equal(msg.toolName, 'get_weather');
    assert.equal(msg.content, '{"city":"SF"}');
    assert.equal(msg.thought_signature, 'sig_j');
});

test('createToolCallMessage(ProviderType.GOOGLE_GENAI, ...) emits GAI-shape with parsed args', () => {
    const msg = /** @type {any} */ (createToolCallMessage({ provider: ProviderType.GOOGLE_GENAI, id: 'c1', name: 'get_weather', args: '{"city":"SF"}', thoughtSignature: 'sig_g' }));
    assert.equal(msg.role, 'model');
    assert.equal(msg.parts.length, 1);
    const fc = msg.parts[0].functionCall;
    assert.equal(fc.id, 'c1');
    assert.equal(fc.name, 'get_weather');
    assert.deepEqual(fc.args, { city: 'SF' });
    assert.equal(msg.parts[0].thoughtSignature, 'sig_g');
});

test('createToolCallMessage(ProviderType.OPENAI, ...) emits OAI-shape', () => {
    const msg = /** @type {any} */ (createToolCallMessage({ provider: ProviderType.OPENAI, id: 'c1', name: 'get_weather', args: '{"city":"SF"}', thoughtSignature: 'sig_o' }));
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].id, 'c1');
    assert.equal(msg.tool_calls[0].function.name, 'get_weather');
    assert.equal(msg.tool_calls[0].function.arguments, '{"city":"SF"}');
    assert.equal(msg.thoughtSignature, 'sig_o');
});
