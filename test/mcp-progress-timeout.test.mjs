// @ts-check
/**
 * The MCP client's default tool timeout was 5 s, which kills a legitimate
 * long tool. The SDK default is 60 s, and progress notifications can reset the
 * timeout while the tool reports it is alive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { McpClient } from '../lib/tools/mcp-client.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MCP_DEFAULT_TIMEOUT_MS } from '../lib/core/constants/index.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the default MCP tool timeout is the SDK default of 60 seconds', () => {
    assert.equal(MCP_DEFAULT_TIMEOUT_MS, 60_000);
    const client = new McpClient({ command: 'x' });
    assert.equal(client.timeout, 60_000);
});

test('progress resets the request timeout and emits CALL_PROGRESS', async () => {
    const server = new Server({ name: 'progress', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const token = /** @type {any} */ (request.params)._meta?.progressToken;
        for (let i = 1; i <= 4; i += 1) {
            await sleep(40);
            if (token !== undefined) {
                await server.notification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 4 } });
            }
        }
        return { content: [{ type: 'text', text: 'done' }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const progress = [];
    emitter.on(EVENTS.MCP.CALL_PROGRESS, (/** @type {any} */ e) => progress.push(e));
    const client = new McpClient({ command: 'unused', options: { transport: serverTransport, timeout: 100, eventEmitter: emitter } });
    await server.connect(clientTransport);
    await client.start();
    try {
        const res = /** @type {any} */ (await client.executeTool({ name: 'slow', args: {} }));
        assert.equal(res.content[0].text, 'done', 'a tool that reports progress outlives the request timeout');
        assert.ok(progress.length >= 2, `expected progress events, got ${progress.length}`);
        assert.equal(progress[0].name, 'slow');
    } finally {
        await client.stop();
    }
});
