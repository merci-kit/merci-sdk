// @ts-check
/**
 * MCP TypeScript SDK v2: the wire era is selectable and the default is
 * unchanged.
 *
 * `mcpProtocolVersion` defaults to `'legacy'` — the plain 2025 `initialize`
 * handshake — so an existing caller keeps the byte-identical v1 exchange.
 * `'auto'` probes `server/discover` and falls back to the 2025 handshake; a
 * date string pins the modern era. On the modern era the SDK auto-fulfils a
 * tool's `input_required` (MRTR) through the registered `onElicit` handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { InMemoryTransport } from '@modelcontextprotocol/client';
import { acceptedContent, inputRequired, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { McpClient } from '../lib/tools/mcp-client.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ConfigurationError, isAbortError } from '../lib/core/errors.mjs';

/** The tool the MRTR scenario calls; it asks once and answers on re-entry. */
const CONFIRM_TOOL = 'confirm';

/**
 * A v2 server that serves both eras: `serveStdio` pins a 2025-era instance for
 * an `initialize` opening and a 2026-07-28 instance for a `server/discover`
 * opening, from the same factory.
 * @returns {{clientSide: import('@modelcontextprotocol/client').Transport, sawAbort: () => boolean, close: () => Promise<void>}}
 */
function createServerPair() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let sawAbort = false;
    const handle = serveStdio(() => {
        const server = new Server(
            { name: 'merci-v2-test', version: '1.0.0' },
            { capabilities: { tools: {} } }
        );
        server.setRequestHandler('tools/list', () => ({
            tools: [
                { name: 'echo', description: 'Echoes.', inputSchema: { type: 'object', properties: {} } },
                { name: 'slow', description: 'Never answers in time.', inputSchema: { type: 'object', properties: {} } },
                { name: CONFIRM_TOOL, description: 'Asks before answering.', inputSchema: { type: 'object', properties: {} } },
            ],
        }));
        server.setRequestHandler('tools/call', async (request, ctx) => {
            if (request.params.name === 'slow') {
                // Waits until the caller cancels, and records that it did:
                // this is what proves `ctx.mcpReq.signal` reaches the handler.
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 5_000);
                    timer.unref?.();
                    ctx.mcpReq.signal.addEventListener('abort', () => {
                        sawAbort = true;
                        clearTimeout(timer);
                        resolve(undefined);
                    }, { once: true });
                });
                return { content: [{ type: 'text', text: 'late' }] };
            }
            if (request.params.name !== CONFIRM_TOOL) {
                return { content: [{ type: 'text', text: 'ok' }] };
            }
            const accepted = acceptedContent(ctx.mcpReq.inputResponses, 'confirm');
            if (!accepted) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Proceed?',
                            requestedSchema: {
                                type: 'object',
                                properties: { ok: { type: 'boolean' } },
                                required: ['ok'],
                            },
                        }),
                    },
                });
            }
            return { content: [{ type: 'text', text: `confirmed:${accepted.ok === true}` }] };
        });
        return server;
    }, { transport: serverSide });
    return { clientSide, sawAbort: () => sawAbort, close: () => handle.close() };
}

/**
 * Connects an `McpClient` over an in-memory transport and returns it with the
 * events it emitted.
 * @param {{options?: Record<string, unknown>}} [arg0]
 */
async function connectClient({ options = {} } = {}) {
    const pair = createServerPair();
    const emitter = new EventEmitter();
    /** @type {Array<Record<string, any>>} */
    const started = [];
    emitter.on(EVENTS.MCP.SERVER_START, (/** @type {any} */ event) => started.push(event));
    const client = new McpClient({
        command: 'unused',
        options: { transport: pair.clientSide, eventEmitter: emitter, ...options },
    });
    await client.start();
    return { client, started, sawAbort: pair.sawAbort, close: async () => { await client.stop(); await pair.close(); } };
}

test('the default era is legacy: a 2025 initialize handshake', async () => {
    const { client, started, close } = await connectClient();
    try {
        assert.equal(client.mcpProtocolVersion, 'legacy');
        assert.equal(started.length, 1);
        assert.equal(started[0].era, 'legacy');
        assert.match(String(started[0].protocolVersion), /^2025-/);
    } finally {
        await close();
    }
});

test("'auto' negotiates the 2026-07-28 era against a modern server", async () => {
    const { client, started, close } = await connectClient({ options: { mcpProtocolVersion: 'auto' } });
    try {
        assert.equal(started[0].era, 'modern');
        assert.equal(started[0].protocolVersion, '2026-07-28');
        const tools = await client.getTools();
        assert.deepEqual(tools.map((t) => t.name), ['echo', 'slow', CONFIRM_TOOL]);
        const result = /** @type {any} */ (await client.executeTool({ name: 'echo', args: {} }));
        assert.equal(result.content[0].text, 'ok');
    } finally {
        await close();
    }
});

test('a pinned revision connects to the same era', async () => {
    const { started, close } = await connectClient({ options: { mcpProtocolVersion: '2026-07-28' } });
    try {
        assert.equal(started[0].era, 'modern');
        assert.equal(started[0].protocolVersion, '2026-07-28');
    } finally {
        await close();
    }
});

test('onElicit answers a tool that returns input_required (MRTR)', async () => {
    /** @type {Array<Record<string, any>>} */
    const asks = [];
    const { client, close } = await connectClient({
        options: {
            mcpProtocolVersion: 'auto',
            onElicit: (/** @type {any} */ request) => {
                asks.push(request);
                return { action: 'accept', content: { ok: true } };
            },
        },
    });
    try {
        const result = /** @type {any} */ (await client.executeTool({ name: CONFIRM_TOOL, args: {} }));
        assert.equal(asks.length, 1, 'the client was asked once');
        assert.equal(asks[0].message, 'Proceed?');
        assert.equal(result.content[0].text, 'confirmed:true');
    } finally {
        await close();
    }
});

test('an aborted call cancels the request (the signal reaches the tool)', async () => {
    const { client, sawAbort, close } = await connectClient({ options: { mcpProtocolVersion: 'auto' } });
    try {
        const controller = new AbortController();
        const started = Date.now();
        const call = client.executeTool({ name: 'slow', args: {}, signal: controller.signal });
        setTimeout(() => controller.abort(), 25);
        await assert.rejects(call, (/** @type {any} */ err) => isAbortError({ err }));
        assert.ok(Date.now() - started < 2_000, 'the abort short-circuited the 5 s tool');
        // The client-side rejection alone proves nothing: wait for the
        // cancellation to reach the handler's own signal.
        const deadline = Date.now() + 1_000;
        while (!sawAbort() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(sawAbort(), true, 'ctx.mcpReq.signal fired in the server handler');
    } finally {
        await close();
    }
});

test('mcpProtocolVersion rejects a value that is not a revision date', () => {
    assert.throws(
        () => new McpClient({ command: 'unused', options: { mcpProtocolVersion: 'modern' } }),
        (/** @type {any} */ err) => err instanceof ConfigurationError && /legacy/.test(err.message)
    );
});

test('mcpProtocolVersion must be a non-empty string', () => {
    assert.throws(
        () => new McpClient({ command: 'unused', options: { mcpProtocolVersion: /** @type {any} */ (42) } }),
        ConfigurationError
    );
});
