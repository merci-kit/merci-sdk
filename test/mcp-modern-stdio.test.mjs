// @ts-check
/**
 * The modern stdio mode wraps the SDK's `serveStdio`: the opening exchange
 * selects the era, one instance is pinned per connection, and the handle owns
 * only `close()`. The legacy default keeps the connected server handle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpClient } from '../lib/tools/mcp-client.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const toolsUrl = pathToFileURL(path.resolve(HERE, '../lib/tools/index.mjs')).href;

const CHILD_SOURCE = `
import { createMcpServer } from ${JSON.stringify(toolsUrl)};
await createMcpServer({
    name: 'modern-stdio',
    version: '1.0.0',
    mcpProtocolVersion: '2026-07-28',
    tools: [{
        name: 'echo',
        description: 'Echoes the text.',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async ({ args }) => 'echo:' + String(args?.text ?? ''),
    }],
});
`;

// Registered before the first message: the facade queues it and replays it onto
// the pinned instance. `tools/list` is a 2026-era method with a declared
// capability, so the override is the observable proof that it ran.
const HANDLER_CHILD_SOURCE = `
import { createMcpServer } from ${JSON.stringify(toolsUrl)};
const server = await createMcpServer({
    name: 'modern-stdio-handler',
    version: '1.0.0',
    mcpProtocolVersion: '2026-07-28',
    tools: [{
        name: 'echo',
        description: 'Echoes the text.',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'echo',
    }],
});
server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'marker', inputSchema: { type: 'object', properties: {} } }] }));
`;

/** @param {{mcpProtocolVersion: string}} arg0 */
function clientFor({ mcpProtocolVersion }) {
    return new McpClient({
        command: process.execPath,
        args: ['--input-type=module', '-e', CHILD_SOURCE],
        options: { mcpProtocolVersion },
    });
}

const REJECT_CHILD_SOURCE = `
import { createMcpServer } from ${JSON.stringify(toolsUrl)};
await createMcpServer({
    name: 'modern-stdio-reject',
    version: '1.0.0',
    mcpProtocolVersion: '2026-07-28',
    legacy: 'reject',
    tools: [{
        name: 'echo',
        description: 'Echoes the text.',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'echo',
    }],
});
`;

/** @param {{mcpProtocolVersion: string, source: string}} arg0 */
function clientForSource({ mcpProtocolVersion, source }) {
    return new McpClient({
        command: process.execPath,
        args: ['--input-type=module', '-e', source],
        options: { mcpProtocolVersion },
    });
}

test('legacy: reject refuses a 2025 client and still serves a modern one', async () => {
    const legacy = clientForSource({ mcpProtocolVersion: 'legacy', source: REJECT_CHILD_SOURCE });
    try {
        await assert.rejects(() => legacy.start());
    } finally {
        await legacy.stop().catch(() => {});
    }
    const modern = clientForSource({ mcpProtocolVersion: '2026-07-28', source: REJECT_CHILD_SOURCE });
    try {
        await modern.start();
        assert.deepEqual((await modern.getTools()).map((tool) => tool.name), ['echo']);
    } finally {
        await modern.stop();
    }
});

test("legacy: 'reject' without the modern era is rejected", async () => {
    const { createMcpServer } = await import('../lib/tools/mcp-server.mjs');
    await assert.rejects(
        () => createMcpServer({ tools: [], legacy: 'reject' }),
        (err) => err instanceof ConfigurationError && /legacy/.test(/** @type {Error} */ (err).message),
    );
});

test('a 2026-07-28 client speaks to the modern stdio mode', async () => {
    const client = clientFor({ mcpProtocolVersion: '2026-07-28' });
    try {
        await client.start();
        assert.deepEqual((await client.getTools()).map((tool) => tool.name), ['echo']);
        const result = /** @type {any} */ (await client.executeTool({ name: 'echo', args: { text: 'modern' } }));
        assert.equal(result.content[0].text, 'echo:modern');
    } finally {
        await client.stop();
    }
});

test('a legacy client is still served on the same modern mode', async () => {
    const client = clientFor({ mcpProtocolVersion: 'legacy' });
    try {
        await client.start();
        const result = /** @type {any} */ (await client.executeTool({ name: 'echo', args: { text: 'old' } }));
        assert.equal(result.content[0].text, 'echo:old');
    } finally {
        await client.stop();
    }
});

test('setRequestHandler is replayed onto the pinned modern instance', async () => {
    const sdk = new Client(
        { name: 'modern-stdio-probe', version: '1.0.0' },
        { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--input-type=module', '-e', HANDLER_CHILD_SOURCE],
    });
    try {
        await sdk.connect(transport);
        const listed = await sdk.listTools();
        assert.deepEqual(listed.tools.map((tool) => tool.name), ['marker']);
    } finally {
        await sdk.close();
    }
});

test('an unknown mcpProtocolVersion is rejected before the transport starts', async () => {
    const { createMcpServer } = await import('../lib/tools/mcp-server.mjs');
    await assert.rejects(
        () => createMcpServer({ tools: [], mcpProtocolVersion: /** @type {any} */ ('2026-01-01') }),
        (/** @type {any} */ err) => err instanceof ConfigurationError && /mcpProtocolVersion/.test(err.message),
    );
});
