// @ts-check
/**
 * Multimodal tool results: an image block returned by a tool survives on a
 * backend whose tool-result wire accepts one, and is replaced by a note that
 * says it was dropped everywhere else. Base64 never leaks into a text field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createToolResultMessage } from '../lib/messaging/messages.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { loadMcpTools } from '../lib/tools/mcp-client.mjs';
import { capToolOutputValue } from '../lib/tools/external-capability.mjs';

const IMAGE = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
/** @param {{name?: string}} [arg0] */
const call = ({ name = 'shot' } = {}) => ({ id: 'c1', tool_call_id: 'c1', name, success: true, result: [{ type: 'text', text: 'screen' }, IMAGE] });

test('Anthropic keeps the image block in the tool_result', () => {
    const row = createToolResultMessage({ provider: ProviderType.ANTHROPIC, result: call() });
    const block = /** @type {any} */ (/** @type {any} */ (row).content[0]);
    assert.equal(block.type, 'tool_result');
    assert.deepEqual(block.content, [
        { type: 'text', text: 'screen' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
});

test('Gemini carries the image in functionResponse.parts', () => {
    const row = createToolResultMessage({ provider: ProviderType.GOOGLE_GENAI, result: call() });
    const fr = /** @type {any} */ (/** @type {any} */ (row).parts[0].functionResponse);
    assert.deepEqual(fr.parts, [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
    assert.deepEqual(fr.response, { output: [{ type: 'text', text: 'screen' }] });
});

test('OpenAI Responses carries the image in function_call_output.output', () => {
    const row = createToolResultMessage({ provider: ProviderType.OPENAI, protocol: 'responses', result: call() });
    assert.deepEqual(row.content, [
        { type: 'text', text: 'screen' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    const req = /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'gpt-5', parameters: {}, tools: [], preparedMessages: [row],
        forceTextResponse: false, toolChoiceRequired: false, session: { protocol: 'responses' },
    });
    assert.deepEqual(req.request.input[0], {
        type: 'function_call_output',
        call_id: 'c1',
        output: [
            { type: 'input_text', text: 'screen' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
    });
});

test('an OpenAI chat-completions tool message says the image was dropped', () => {
    const row = createToolResultMessage({ provider: ProviderType.OPENAI, result: call() });
    assert.equal(typeof row.content, 'string');
    assert.match(String(row.content), /1 image\(s\) omitted/);
    assert.equal(String(row.content).includes('AAAA'), false, 'no base64 in the text');
});

test('a JAI tool message says the image was dropped', () => {
    const row = createToolResultMessage({ provider: ProviderType.JAI, result: call() });
    assert.match(JSON.stringify(row.result), /1 image\(s\) omitted/);
    assert.equal(JSON.stringify(row.result).includes('AAAA'), false);
});

test('an oversized image is dropped with a note on a supporting backend', () => {
    const huge = { type: 'image', data: 'A'.repeat(5 * 1024 * 1024 + 1), mimeType: 'image/png' };
    const row = createToolResultMessage({
        provider: ProviderType.ANTHROPIC,
        result: { id: 'c1', name: 'shot', success: true, result: [huge] },
    });
    assert.match(String(JSON.stringify(row)), /too large for a tool result/);
    assert.equal(JSON.stringify(row).includes('A'.repeat(5 * 1024 * 1024 + 1)), false);
});

test('the text cap does not truncate image data', () => {
    const { value } = capToolOutputValue({
        value: { content: [{ type: 'text', text: 'x'.repeat(60_000) }, IMAGE] },
        maxLength: 100,
    });
    const blocks = /** @type {any} */ (value).content;
    assert.equal(blocks[1].data, 'AAAA');
    assert.ok(blocks[0].text.length < 100, 'the text is still capped');
});

test('loadMcpTools keeps an image block instead of stringifying it', async () => {
    const mcpClient = /** @type {any} */ ({
        connect: async () => {},
        stop: async () => {},
        getTools: async () => [{ name: 'shot' }],
        executeTool: async () => ({ content: [{ type: 'text', text: 'screen' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
    });
    const [tool] = await loadMcpTools({ mcpClient });
    const out = await /** @type {any} */ (tool).execute({ args: {}, signal: null, context: {} });
    assert.deepEqual(out.result, [
        { type: 'text', text: 'screen' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
});

test('loadMcpTools leaves a text-only result a plain string', async () => {
    const mcpClient = /** @type {any} */ ({
        connect: async () => {},
        stop: async () => {},
        getTools: async () => [{ name: 'read' }],
        executeTool: async () => ({ content: [{ type: 'text', text: 'hello' }] }),
    });
    const [tool] = await loadMcpTools({ mcpClient });
    const out = await /** @type {any} */ (tool).execute({ args: {}, signal: null, context: {} });
    assert.equal(out.result, 'hello');
});
