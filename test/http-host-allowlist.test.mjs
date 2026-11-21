// @ts-check
/**
 * DNS-rebinding protection compares the Host header, not the socket address.
 * A server created before `listen()` cannot know its port, so the hostname is
 * compared and the port is ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { requestHostAllowed } from '../lib/support/utils.mjs';
import { SDK_VERSION } from '../lib/core/constants/index.mjs';
import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { createA2AServer, createA2AHttpHandler } from '../lib/tools/a2a-server.mjs';

const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'host-test', version: '1.0.0' } },
});

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {{port: number, method?: string, path?: string, headers?: Record<string, string>, body?: string}} arg0 */
function send({ port, method = 'POST', path = '/mcp', headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method,
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

/** @param {string|undefined} host */
const reqWithHost = (host) => /** @type {any} */ ({ headers: host === undefined ? {} : { host } });

test('requestHostAllowed compares the hostname and ignores the port', () => {
    assert.equal(requestHostAllowed({ req: reqWithHost('localhost:3000') }), true);
    assert.equal(requestHostAllowed({ req: reqWithHost('127.0.0.1:3000') }), true);
    assert.equal(requestHostAllowed({ req: reqWithHost('[::1]:3000') }), true);
    assert.equal(requestHostAllowed({ req: reqWithHost('localhost.:3000') }), true);
    assert.equal(requestHostAllowed({ req: reqWithHost('localhost.evil.com') }), false);
    assert.equal(requestHostAllowed({ req: reqWithHost('127.0.0.1.evil.com') }), false);
    assert.equal(requestHostAllowed({ req: reqWithHost('evil.com') }), false);
    assert.equal(requestHostAllowed({ req: reqWithHost(undefined) }), false);
    assert.equal(requestHostAllowed({ req: reqWithHost(''), }), false);
});

test('requestHostAllowed honours a custom allowlist and the explicit escape hatch', () => {
    assert.equal(requestHostAllowed({ req: reqWithHost('api.example.com:443'), allowedHosts: ['api.example.com'] }), true);
    assert.equal(requestHostAllowed({ req: reqWithHost('localhost:443'), allowedHosts: ['api.example.com'] }), false);
    assert.equal(requestHostAllowed({ req: reqWithHost('evil.com'), allowAnyHost: true }), true);
});

test('MCP HTTP refuses a foreign Host and serves loopback', async () => {
    const handler = await createMcpHttpHandler({ tools: [], sessionIdGenerator: undefined });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const headers = (/** @type {string} */ host) => ({ Host: host, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
    try {
        const evil = await send({ port: srv.port, headers: headers('evil.com'), body: INIT });
        assert.equal(evil.status, 403, 'a foreign Host must not reach the transport');

        const suffix = await send({ port: srv.port, headers: headers('localhost.evil.com'), body: INIT });
        assert.equal(suffix.status, 403, 'a suffix attack must not match localhost');

        for (const host of [`localhost:${srv.port}`, `127.0.0.1:${srv.port}`, `[::1]:${srv.port}`]) {
            const ok = await send({ port: srv.port, headers: headers(host), body: INIT });
            assert.equal(ok.status, 200, `${host} must be served`);
        }
    } finally { await srv.close(); }
});

test('MCP HTTP can opt out of the host check explicitly', async () => {
    const handler = await createMcpHttpHandler({ tools: [], sessionIdGenerator: undefined, allowAnyHost: true });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    try {
        const ok = await send({
            port: srv.port,
            headers: { Host: 'evil.com', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: INIT,
        });
        assert.equal(ok.status, 200);
    } finally { await srv.close(); }
});

test('A2A HTTP refuses a foreign Host and serves loopback', async () => {
    const server = createA2AServer({ skills: [] });
    const handler = createA2AHttpHandler({ server });
    const srv = await listen({ handler });
    try {
        const evil = await send({ port: srv.port, method: 'GET', path: '/.well-known/agent-card.json', headers: { Host: 'evil.com' } });
        assert.equal(evil.status, 403);

        const ok = await send({ port: srv.port, method: 'GET', path: '/.well-known/agent-card.json', headers: { Host: `localhost:${srv.port}` } });
        assert.equal(ok.status, 200);
        assert.equal(JSON.parse(ok.body).version, SDK_VERSION);
    } finally { await srv.close(); }
});
