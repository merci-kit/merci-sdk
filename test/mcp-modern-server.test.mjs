// @ts-check
/**
 * The 2026-07-28 server mode is stateless: one server per request, no
 * Mcp-Session-Id, and the same tool surface as the legacy handler. The legacy
 * mode stays the default and keeps its session id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

const TOOL = {
    name: 'echo',
    description: 'Echoes the text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: /** @param {any} envelope */ async (envelope) => `echo:${envelope?.args?.text ?? ''}`,
};

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {{port: number, headers?: Record<string, string>, body?: string}} arg0 */
function send({ port, headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/mcp',
            headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
        }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** @param {{port: number, options?: Record<string, unknown>}} arg0 */
function modernClient({ port, options = {} }) {
    return new McpClient({
        command: null,
        args: [],
        options: { url: `http://127.0.0.1:${port}/mcp`, mcpProtocolVersion: '2026-07-28', ...options },
    });
}

test('the modern handler serves a 2026-07-28 client without a session id', async () => {
    const handler = await createMcpHttpHandler({ tools: [TOOL], mcpProtocolVersion: '2026-07-28' });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = modernClient({ port: srv.port });
    try {
        await client.start();
        assert.deepEqual((await client.getTools()).map((tool) => tool.name), ['echo']);
        const result = /** @type {any} */ (await client.executeTool({ name: 'echo', args: { text: 'hi' } }));
        assert.equal(result.content[0].text, 'echo:hi');
        assert.equal(handler.sessions.size, 0, 'the modern mode never mints a session');
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('the modern handler also serves a legacy client statelessly', async () => {
    const handler = await createMcpHttpHandler({ tools: [TOOL], mcpProtocolVersion: '2026-07-28' });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = modernClient({ port: srv.port, options: { mcpProtocolVersion: 'legacy' } });
    try {
        await client.start();
        const result = /** @type {any} */ (await client.executeTool({ name: 'echo', args: { text: 'old' } }));
        assert.equal(result.content[0].text, 'echo:old');
        assert.equal(handler.sessions.size, 0, 'the legacy leg is stateless in this mode');
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('the modern handler keeps the host allowlist', async () => {
    const handler = await createMcpHttpHandler({ tools: [TOOL], mcpProtocolVersion: '2026-07-28' });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    try {
        const evil = await send({
            port: srv.port,
            headers: { Host: 'evil.com', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
        });
        assert.equal(evil.status, 403);
    } finally {
        await handler.close();
        await srv.close();
    }
});

test('the default handler is still the stateful legacy mode', async () => {
    const handler = await createMcpHttpHandler({ tools: [TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    try {
        const init = await send({
            port: srv.port,
            headers: { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1.0.0' } },
            }),
        });
        assert.equal(init.status, 200);
        assert.ok(init.headers['mcp-session-id'], 'the legacy default still mints a session');
    } finally {
        await handler.close();
        await srv.close();
    }
});

test('an unknown mcpProtocolVersion is rejected', async () => {
    await assert.rejects(
        () => createMcpHttpHandler({ tools: [], mcpProtocolVersion: /** @type {any} */ ('2026-01-01') }),
        (/** @type {any} */ err) => err instanceof ConfigurationError && /mcpProtocolVersion/.test(err.message),
    );
});
