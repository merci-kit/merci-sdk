// @ts-check
/**
 * The HTTP MCP handler created a server and transport per request and kept
 * them in a session map that only ever grew. A closed transport or a DELETE
 * must remove its session, and the handler must be able to shut down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';

const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle', version: '1.0.0' } },
});

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {{port: number, method?: string, headers?: Record<string, string>, body?: string}} arg0 */
function send({ port, method = 'POST', headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method,
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

test('DELETE removes the session from the map', async () => {
    const handler = await createMcpHttpHandler({ tools: [] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const base = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        const init = await send({ port: srv.port, headers: base, body: INIT });
        assert.equal(init.status, 200);
        const sessionId = String(init.headers['mcp-session-id'] ?? '');
        assert.ok(sessionId, 'the server assigned a session id');
        assert.equal(handler.sessions.size, 1);

        const deleted = await send({ port: srv.port, method: 'DELETE', headers: { ...base, 'mcp-session-id': sessionId } });
        assert.ok(deleted.status === 200 || deleted.status === 204, `DELETE answered ${deleted.status}`);
        assert.equal(handler.sessions.size, 0, 'the closed session left the map');
    } finally { await srv.close(); }
});

test('close() closes every live session', async () => {
    const handler = await createMcpHttpHandler({ tools: [] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const base = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        const first = await send({ port: srv.port, headers: base, body: INIT });
        const second = await send({ port: srv.port, headers: base, body: INIT });
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(handler.sessions.size, 2);

        await handler.close();
        assert.equal(handler.sessions.size, 0, 'shutdown drains the session map');
    } finally { await srv.close(); }
});
