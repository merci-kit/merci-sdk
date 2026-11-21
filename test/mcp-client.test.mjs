// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { realpathSync } from 'node:fs';
import { McpClient, loadMcpTools } from '../lib/tools/mcp-client.mjs';

describe('McpClient transport selection', () => {
    it('defaults to stdio for a command', () => {
        const c = new McpClient({ command: 'node', args: ['server.mjs'] });
        assert.equal(c._createTransport().constructor.name, 'StdioClientTransport');
    });

    it('uses Streamable HTTP when a url is configured', () => {
        const c = new McpClient({ command: null, args: [], options: { url: 'https://example.com/mcp' } });
        assert.equal(c._createTransport().constructor.name, 'StreamableHTTPClientTransport');
    });

    it('uses SSE only when explicitly opted in', () => {
        const c = new McpClient({ command: null, args: [], options: { url: 'https://example.com/mcp', protocol: 'sse' } });
        assert.equal(c._createTransport().constructor.name, 'SSEClientTransport');
    });
});

describe('McpClient stdio process options', () => {
    it('passes cwd and a piped stderr to the child', () => {
        const c = new McpClient({ command: 'node', args: [], options: { cwd: '/tmp', stderr: 'pipe' } });
        const transport = /** @type {any} */ (c._createTransport());
        assert.equal(transport._serverParams.cwd, '/tmp');
        assert.equal(transport._serverParams.stderr, 'pipe');
    });

    it('defaults to the parent cwd and an inherited stderr', () => {
        const c = new McpClient({ command: 'node', args: [] });
        const transport = /** @type {any} */ (c._createTransport());
        assert.equal(transport._serverParams.cwd, undefined);
        assert.equal(transport._serverParams.stderr, undefined);
    });

    it("the child really runs in `cwd` and writes to the piped stderr", async () => {
        const c = new McpClient({
            command: process.execPath,
            args: ['-e', 'process.stderr.write(process.cwd())'],
            options: { cwd: '/tmp', stderr: 'pipe' },
        });
        const transport = /** @type {any} */ (c._createTransport());
        await transport.start();
        let text = '';
        try {
            for await (const chunk of transport.stderr) text += String(chunk);
        } finally {
            await transport.close().catch(() => {});
        }
        assert.equal(text.trim(), realpathSync('/tmp'));
    });
});

describe('loadMcpTools annotations', () => {
    /** @param {{approveDestructive?: boolean}} [arg0] */
    function stubClient({ approveDestructive = false } = {}) {
        return /** @type {any} */ ({
            approveDestructive,
            connect: async () => {},
            stop: async () => {},
            executeTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
            getTools: async () => [
                { name: 'read', annotations: { readOnlyHint: true } },
                { name: 'write', annotations: { readOnlyHint: false, destructiveHint: true } },
                { name: 'plain' },
                { name: 'hinted', annotations: { idempotentHint: true } },
            ],
        });
    }

    it('keeps the server annotations verbatim', async () => {
        const tools = await loadMcpTools({ mcpClient: stubClient() });
        assert.deepEqual(/** @type {any} */ (tools[0]).annotations, { readOnlyHint: true });
        assert.deepEqual(/** @type {any} */ (tools[2]).annotations, undefined);
    });

    it('never copies outputSchema, and derives idempotent only from a read-only tool', async () => {
        const tools = await loadMcpTools({ mcpClient: stubClient() });
        for (const tool of tools) assert.equal(/** @type {any} */ (tool).outputSchema, undefined);
        // G1-2: a read-only call has no side effect, so a failed row may retry.
        assert.equal(/** @type {any} */ (tools[0]).idempotent, true, 'read-only');
        assert.equal(/** @type {any} */ (tools[1]).idempotent, undefined, 'destructive');
        assert.equal(/** @type {any} */ (tools[2]).idempotent, undefined, 'unannotated');
        // A server hint is not a contract: a write tool stays unknown-state.
        assert.equal(/** @type {any} */ (tools[3]).idempotent, undefined, 'idempotent hint alone');
    });

    it('does not gate anything by default', async () => {
        const tools = await loadMcpTools({ mcpClient: stubClient() });
        assert.deepEqual(tools.map((t) => /** @type {any} */ (t).requiresApproval), [undefined, undefined, undefined, undefined]);
    });

    it('with approveDestructive, only a read-only tool skips approval', async () => {
        const tools = await loadMcpTools({ mcpClient: stubClient({ approveDestructive: true }) });
        assert.equal(/** @type {any} */ (tools[0]).requiresApproval, undefined, 'read-only');
        assert.equal(/** @type {any} */ (tools[1]).requiresApproval, true, 'destructive');
        assert.equal(/** @type {any} */ (tools[2]).requiresApproval, true, 'no annotation means not read-only');
        assert.equal(/** @type {any} */ (tools[3]).requiresApproval, true, 'an idempotent hint is not read-only');
    });
});

describe('McpClient list verbs', () => {
    /** @param {{calls: string[]}} arg0 */
    function withStubClient({ calls }) {
        const client = new McpClient({ command: 'unused' });
        /** @type {any} */ (client)._client = {
            listTools: async () => { calls.push('tools'); return { tools: [{ name: 'a' }, { name: 'b' }] }; },
            listResources: async () => { calls.push('resources'); return { resources: [{ uri: 'u' }] }; },
            listPrompts: async () => { calls.push('prompts'); return { prompts: [{ name: 'p' }] }; },
            listResourceTemplates: async () => { calls.push('templates'); return { resourceTemplates: [{ uriTemplate: 'file:///{p}' }] }; },
        };
        return client;
    }

    it('asks the SDK once per verb and returns the aggregated field', async () => {
        /** @type {string[]} */
        const calls = [];
        const client = withStubClient({ calls });
        assert.deepEqual((await client.getTools()).map((t) => t.name), ['a', 'b']);
        assert.deepEqual(await client.listResources(), [{ uri: 'u' }]);
        assert.deepEqual(await client.listPrompts(), [{ name: 'p' }]);
        assert.deepEqual(await client.listResourceTemplates(), [{ uriTemplate: 'file:///{p}' }]);
        assert.deepEqual(calls, ['tools', 'resources', 'prompts', 'templates'], 'one call each: the SDK aggregates pages');
    });

    it('emits the fetched events with the count', async () => {
        const { EventEmitter } = await import('node:events');
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const events = [];
        emitter.on('mcp:tools_fetched', (/** @type {any} */ e) => events.push(e));
        emitter.on('mcp:resources_fetched', (/** @type {any} */ e) => events.push(e));
        emitter.on('mcp:prompts_fetched', (/** @type {any} */ e) => events.push(e));
        const client = withStubClient({ calls: [] });
        /** @type {any} */ (client).eventEmitter = emitter;
        await client.getTools();
        await client.listResources();
        await client.listPrompts();
        assert.deepEqual(events.map((e) => e.count), [2, 1, 1]);
    });
});
