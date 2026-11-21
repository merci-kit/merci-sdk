// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { McpClient, loadMcpTools } from '../lib/tools/mcp-client.mjs';
import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { EVENTS } from '../lib/core/events.mjs';

// ── The client declares the capabilities a server may call back on ───────────

test('MCP conformance: the client declares sampling, elicitation and roots', async () => {
    /** @type {any} */
    const seen = { capabilities: null };
    const server = new Server(
        { name: 'oracle', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );
    server.oninitialized = () => {
        seen.capabilities = server.getClientCapabilities();
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({
        command: 'unused',
        options: {
            transport: serverTransport,
            onSampling: async () => ({ content: { type: 'text', text: 'x' } }),
            onElicit: async () => ({ action: 'decline' }),
            roots: [{ uri: 'file:///workspace', name: 'workspace' }]
        }
    });
    await server.connect(clientTransport);
    await client.start();

    assert.ok(seen.capabilities, 'the server must have seen the client capabilities');
    assert.ok(seen.capabilities.sampling, 'sampling must be announced');
    assert.ok(seen.capabilities.elicitation, 'elicitation must be announced');
    assert.ok(seen.capabilities.roots, 'roots must be announced');
});

test('MCP conformance: a server-initiated sampling request reaches the callback', async () => {
    /** @type {any} */
    let sampled = null;
    const server = new Server({ name: 'oracle', version: '1.0.0' }, { capabilities: { tools: {} } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new McpClient({
        command: 'unused',
        options: {
            transport: serverTransport,
            onSampling: async (/** @type {any} */ request) => {
                sampled = request;
                return { role: 'assistant', content: { type: 'text', text: 'sampled answer' }, model: 'oracle-model', stopReason: 'endTurn' };
            }
        }
    });
    /** @type {any} */ (client)._transport = serverTransport;
    await server.connect(clientTransport);
    await client.start();

    const result = await server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'what is 2+2?' } }],
        maxTokens: 100
    });
    assert.equal((/** @type {any} */ (result).content).text, 'sampled answer');
    assert.ok(sampled, 'the sampling callback must have been invoked');
    assert.equal(sampled.messages[0].content.text, 'what is 2+2?');
});

test('MCP conformance: a server that samples during initialize is answered', async () => {
    // The official client sends `notifications/initialized` while connect()
    // resolves, so a server may sample in that very moment: the client's
    // handlers must already exist by then.
    /** @type {any} */
    let sampled = null;
    const server = new Server({ name: 'eager', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.oninitialized = async () => {
        sampled = await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'eager' } }],
            maxTokens: 10
        });
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new McpClient({
        command: 'unused',
        options: {
            transport: serverTransport,
            onSampling: async () => ({ content: { type: 'text', text: 'sampled early' }, model: 'oracle' })
        }
    });
    await server.connect(clientTransport);
    await client.start();
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(sampled, 'the eager sampling request must have been answered');
    assert.equal(sampled.content.text, 'sampled early');
});

test('MCP conformance: an elicitation request reaches the callback', async () => {
    /** @type {any} */
    let elicited = null;
    const server = new Server({ name: 'oracle', version: '1.0.0' }, { capabilities: { tools: {} } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new McpClient({
        command: 'unused',
        options: {
            transport: serverTransport,
            onElicit: async (/** @type {any} */ request) => {
                elicited = request;
                return { action: 'accept', content: { city: 'Prague' } };
            }
        }
    });
    /** @type {any} */ (client)._transport = serverTransport;
    await server.connect(clientTransport);
    await client.start();

    const result = await server.elicitInput({
        message: 'Which city?',
        requestedSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    });
    const elicitedResult = /** @type {any} */ (result);
    assert.equal(elicitedResult.action, 'accept');
    assert.equal(elicitedResult.content.city, 'Prague');
    assert.ok(elicited, 'the elicitation callback must have been invoked');
    assert.equal(elicited.message, 'Which city?');
});

test('MCP conformance: roots are advertised to the server', async () => {
    /** @type {any} */
    let roots = null;
    const server = new Server({ name: 'oracle', version: '1.0.0' }, { capabilities: { tools: {} } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new McpClient({
        command: 'unused',
        options: { transport: serverTransport, roots: [{ uri: 'file:///workspace', name: 'workspace' }] }
    });
    await server.connect(clientTransport);
    await client.start();

    const listed = await server.listRoots();
    roots = listed.roots;
    assert.equal(roots.length, 1);
    assert.equal(roots[0].uri, 'file:///workspace');
});

// ── Our server exposes resources, prompts and structured output ───────────────

test('MCP conformance: our HTTP server serves tools, resources and prompts', async () => {
    const handler = await createMcpHttpHandler({
        name: 'merci-http',
        tools: [{
            name: 'summarize',
            description: 'summarize a document',
            parameters: { type: 'object', properties: { text: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
            execute:
                /** @param {any} envelope */
                async (envelope) => ({ summary: `summary of ${envelope?.args?.text ?? ''}` })
        }],
        resources: [{
            uri: 'file:///readme.md',
            name: 'readme',
            description: 'the readme',
            mimeType: 'text/plain',
            read: () => 'hello resource'
        }],
        prompts: [{
            name: 'greet',
            description: 'greet somebody',
            arguments: [{ name: 'who', description: 'the name', required: true }],
            render:
                /** @param {any} args */
                (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: `hello ${args?.who ?? 'world'}` } }] })
        }],
        sessionIdGenerator: undefined
    });

    const http = createServer((req, res) => { void handler.handle(req, res); });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = /** @type {any} */ (http.address());
    const url = `http://127.0.0.1:${address.port}/mcp`;

    try {
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));

        const tools = await client.listTools();
        assert.equal(tools.tools.length, 1);
        assert.equal(tools.tools[0].name, 'summarize');
        assert.ok(tools.tools[0].outputSchema, 'the output schema must be advertised');

        const called = await client.callTool({ name: 'summarize', arguments: { text: 'a doc' } });
        assert.equal(/** @type {any} */ (called).structuredContent.summary, 'summary of a doc');

        const resources = await client.listResources();
        assert.equal(resources.resources.length, 1);
        assert.equal(resources.resources[0].uri, 'file:///readme.md');

        const read = await client.readResource({ uri: 'file:///readme.md' });
        assert.equal((/** @type {any} */ (read).contents)[0].text, 'hello resource');

        const prompts = await client.listPrompts();
        assert.equal(prompts.prompts.length, 1);
        assert.equal(prompts.prompts[0].name, 'greet');

        const prompt = await client.getPrompt({ name: 'greet', arguments: { who: 'Ada' } });
        assert.equal((/** @type {any} */ (prompt).messages)[0].content.text, 'hello Ada');

        await client.close();
    } finally {
        http.closeAllConnections?.();
        await new Promise((resolve) => http.close(() => resolve(undefined)));
    }
});

test('MCP conformance: a stateless server answers every request on its own transport', async () => {
    const handler = await createMcpHttpHandler({
        name: 'merci-stateless',
        tools: [{
            name: 'ping',
            description: 'answers',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'pong'
        }],
        sessionIdGenerator: undefined
    });
    const http = createServer((req, res) => { void handler.handle(req, res); });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = /** @type {any} */ (http.address());
    try {
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
        assert.equal(handler.sessions.size, 0, 'stateless mode mints no session');
        const called = await client.callTool({ name: 'ping', arguments: {} });
        assert.equal((/** @type {any} */ (called.content)[0]).text, 'pong');
        assert.equal(handler.sessions.size, 0, 'a second request still mints no session');
        await client.close();
    } finally {
        http.closeAllConnections?.();
        await new Promise((resolve) => http.close(() => resolve(undefined)));
    }
});

// ── Reconnect and tool-list changes ──────────────────────────────────────────

test('MCP conformance: a failed connect is retried when reconnects are enabled', async () => {
    let attempts = 0;
    const client = new McpClient({
        command: 'definitely-not-a-real-binary-xyz',
        options: { reconnectAttempts: 2 }
    });
    const originalStart = client.start.bind(client);
    /** @type {any} */ (client).start = async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('boom');
        return originalStart();
    };
    await assert.rejects(() => client.connect(), /boom|ENOENT/);
    assert.equal(attempts, 3, 'the client must try the configured number of times');
});

test('MCP conformance: a tools/list_changed notification refreshes the tool list', async () => {
    /** @type {any} */
    const server = new Server({ name: 'oracle', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    let refreshed = 0;
    const client = new McpClient({
        command: 'unused',
        options: { transport: serverTransport, onToolsChanged: async () => { refreshed += 1; } }
    });
    await server.connect(clientTransport);
    await client.start();

    await server.sendToolListChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(refreshed, 1, 'the client must be told the tool list changed');
});

test('MCP conformance: the events registry announces the new MCP events', () => {
    assert.equal(EVENTS.MCP.TOOLS_CHANGED, 'mcp:tools_changed');
    assert.equal(EVENTS.MCP.SERVER_RETRY, 'mcp:server_retry');
    assert.equal(EVENTS.MCP.RESOURCES_FETCHED, 'mcp:resources_fetched');
    assert.equal(EVENTS.MCP.PROMPTS_FETCHED, 'mcp:prompts_fetched');
});

test('MCP conformance: loadMcpTools still exposes the remote tools', async () => {
    const server = new Server({ name: 'oracle', version: '1.0.0' }, { capabilities: { tools: {} } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server.setRequestHandler(
        (await import('@modelcontextprotocol/sdk/types.js')).ListToolsRequestSchema,
        () => ({ tools: [{ name: 'remote_tool', description: 'a remote tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] })
    );
    const client = new McpClient({ command: 'unused', options: { transport: serverTransport } });
    await server.connect(clientTransport);
    await client.start();

    const tools = await loadMcpTools({ mcpClient: client });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'remote_tool');
    assert.equal(tools[0].parameters.type, 'object');
});
