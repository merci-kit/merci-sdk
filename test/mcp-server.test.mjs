// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_OUTPUT_TRUNCATION_SUFFIX, DEFAULT_TOOL_OUTPUT_MAX_LENGTH } from '../lib/tools/external-capability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsUrl = pathToFileURL(path.resolve(__dirname, '../lib/tools/index.mjs')).href;

const CHILD_SOURCE = `
import { createMcpServer } from ${JSON.stringify(toolsUrl)};
await createMcpServer({
    name: 'test-mcp-server',
    version: '1.0.0',
    tools: [{
        name: 'get_system_time',
        description: 'Returns a time payload.',
        parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
        execute: async ({ args }) => JSON.stringify({ timezone: args.timezone ?? 'UTC', ok: true }),
    }, {
        name: 'huge',
        description: 'Returns a very large string.',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'x'.repeat(60000),
    }],
});
`;

/** @param {{fn: (client: any) => any}} arg0 */
async function withServer({ fn }) {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--input-type=module', '-e', CHILD_SOURCE],
    });
    try {
        await client.connect(transport);
        return await fn(client);
    } finally {
        await client.close();
    }
}

describe('createMcpServer', () => {
    it('completes the initialize / tools/list round trip', async () => {
        await withServer({ fn: async (client) => {
            const { tools } = await client.listTools();
            assert.deepEqual(tools.map((/** @type {any} */ t) => t.name), ['get_system_time', 'huge']);
            assert.equal(tools[0].description, 'Returns a time payload.');
            assert.deepEqual(tools[0].inputSchema.properties.timezone, { type: 'string' });
        } });
    });

    it('executes tools/call and returns the tool output as text', async () => {
        await withServer({ fn: async (client) => {
            const res = await client.callTool({
                name: 'get_system_time',
                arguments: { timezone: 'Europe/Prague' },
            });
            assert.equal(res.isError, undefined);
            assert.deepEqual(JSON.parse(res.content[0].text), { timezone: 'Europe/Prague', ok: true });
        } });
    });

    it('reports an unknown tool as an error result', async () => {
        await withServer({ fn: async (client) => {
            const res = await client.callTool({ name: 'nope', arguments: {} });
            assert.equal(res.isError, true);
            assert.match(res.content[0].text, /Unknown tool: nope/);
        } });
    });

    it('caps an oversized tool result and leaves a small one untouched', async () => {
        await withServer({ fn: async (client) => {
            const huge = await client.callTool({ name: 'huge', arguments: {} });
            assert.equal(huge.content[0].text.length, DEFAULT_TOOL_OUTPUT_MAX_LENGTH);
            assert.ok(huge.content[0].text.endsWith(TOOL_OUTPUT_TRUNCATION_SUFFIX));

            const small = await client.callTool({ name: 'get_system_time', arguments: { timezone: 'UTC' } });
            assert.doesNotMatch(small.content[0].text, /TRUNCATED/);
        } });
    });
});
