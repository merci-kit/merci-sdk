// @ts-check
/**
 * Both HTTP servers cap the request body. The MCP SDK enforces its own 4 MiB
 * limit once `handleRequest` owns the stream; A2A counts the bytes itself.
 * Either way the answer is 413 and the server keeps serving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { createA2AServer, createA2AHttpHandler } from '../lib/tools/a2a-server.mjs';
import { A2A_REQUEST_MAX_BODY_BYTES } from '../lib/core/constants/index.mjs';

const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'body-test', version: '1.0.0' } },
});

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {{port: number, path?: string, headers?: Record<string, string>, body?: string}} arg0 */
function send({ port, path = '/mcp', headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path,
            headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
        }, (res) => {
            /** @type {Buffer[]} */
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('MCP HTTP answers 413 to a body over the SDK cap and keeps serving', async () => {
    const handler = await createMcpHttpHandler({ tools: [], sessionIdGenerator: undefined });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const headers = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        const tooBig = await send({ port: srv.port, headers, body: 'x'.repeat(5 * 1024 * 1024) });
        assert.equal(tooBig.status, 413);

        const ok = await send({ port: srv.port, headers, body: INIT });
        assert.equal(ok.status, 200, 'the server must survive the oversized request');
    } finally { await srv.close(); }
});

test('A2A HTTP answers 413 to a body over the request cap and keeps serving', async () => {
    const server = createA2AServer({ skills: [] });
    const handler = createA2AHttpHandler({ server });
    const srv = await listen({ handler });
    const headers = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json' };
    try {
        const tooBig = await send({ port: srv.port, path: '/a2a', headers, body: 'x'.repeat(A2A_REQUEST_MAX_BODY_BYTES + 1) });
        assert.equal(tooBig.status, 413);

        const ok = await send({
            port: srv.port,
            path: '/a2a',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} }),
        });
        assert.equal(ok.status, 200, 'the server must survive the oversized request');
    } finally { await srv.close(); }
});
