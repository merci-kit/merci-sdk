// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { executeTools } from '../lib/tools/tool-execution.mjs';
import { DEFAULT_TOOL_OUTPUT_MAX_LENGTH } from '../lib/tools/external-capability.mjs';
import { loadMcpTools } from '../lib/tools/mcp-client.mjs';

describe('2C: dispatch output cap', () => {
    it('a huge string result is capped with the shared suffix', async () => {
        const tool = {
            name: 'dump',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'x'.repeat(200_000),
        };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'dump', arguments: '{}' }], toolLibrary: [tool] }));
        assert.equal(/** @type {any} */ (res).success, true);
        assert.ok(/** @type {any} */ (res).result.length <= DEFAULT_TOOL_OUTPUT_MAX_LENGTH + 64, `capped, got ${/** @type {any} */ (res).result.length}`);
        assert.match(/** @type {any} */ (res).result, /TRUNCATED/);
    });

    it('structured results keep their shape (not stringified by the cap)', async () => {
        const tool = {
            name: 'obj',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ success: true, stdout: 'ok' }),
        };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'obj', arguments: '{}' }], toolLibrary: [tool] }));
        assert.equal(typeof /** @type {any} */ (res).result, 'object');
        assert.equal(/** @type {any} */ (res).result.stdout, 'ok');
    });
});

describe('2C: modern JSON Schema keywords', () => {
    it('a draft-2020-12 prefixItems schema validates instead of erroring', async () => {
        const tool = {
            name: 'tuple',
            parameters: {
                type: 'object',
                properties: {
                    pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
                },
                required: ['pair'],
            },
            execute: async () => 'ok',
        };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'tuple', arguments: '{"pair":["a",1]}' }], toolLibrary: [tool] }));
        assert.equal(/** @type {any} */ (res).success, true, `expected execution, got: ${/** @type {any} */ (res).error ?? ''}`);
        assert.equal(/** @type {any} */ (res).result, 'ok');
    });
});

describe('2C: MCP non-string content', () => {
    it('an image block survives instead of being stringified', async () => {
        const fakeClient = {
            async start() {},
            async getTools() { return [{ name: 'shot', description: 'd', inputSchema: { type: 'object' } }]; },
            async executeTool() {
                return { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(120_000) }] };
            },
            async stop() {},
        };
        const tools =  (await loadMcpTools({ mcpClient: /** @type {any} */ (fakeClient) }));
        const res = await tools[0].execute({ args: {} });
        assert.equal(res.success, true);
        assert.deepEqual(res.result.map((/** @type {any} */ b) => b.type), ['image']);
        // The text cap must not cut base64: a truncated image is a corrupt one.
        assert.equal(res.result[0].data.length, 120_000);
    });
});
