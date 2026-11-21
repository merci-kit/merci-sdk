// @ts-check
/**
 * Two MCP server-side bounds were missing: Streamable-HTTP sessions were never
 * capped or expired, so one caller could grow the map (and its tool library)
 * without end; and a shared `taskStore` served `tasks/get` / `tasks/result` /
 * `tasks/cancel` to any session that named another session's task id.
 *
 * These tests pin the cap, the idle sweep, and the per-session task boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';
import { McpTaskStore } from '../lib/tools/mcp-task-store.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import { ERROR_CODES } from '../lib/core/constants/index.mjs';

const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'sessions', version: '1.0.0' } },
});

/** @type {import('../lib/tools/tool-execution.mjs').ToolDefinition} */
const SLOW_TOOL = {
    name: 'slow',
    description: 'Answers after a tick.',
    parameters: { type: 'object', properties: {} },
    taskSupport: 'optional',
    execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'slow-result';
    },
};

/** @type {import('../lib/tools/tool-execution.mjs').ToolDefinition} */
const LONG_TOOL = {
    name: 'long',
    description: 'Runs for most of a second.',
    parameters: { type: 'object', properties: {} },
    taskSupport: 'optional',
    execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return 'long-result';
    },
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

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {{port: number}} arg0 */
function legacyClient({ port }) {
    return new McpClient({
        command: null,
        args: [],
        options: { url: `http://127.0.0.1:${port}/mcp`, mcpProtocolVersion: 'legacy' },
    });
}

/**
 * Opens the stateful SSE stream a client keeps for server notifications and
 * resolves with the response while the stream is still open.
 * @param {{port: number, sessionId: string}} arg0
 * @returns {Promise<{ended: () => boolean, close: () => void}>}
 */
function openStream({ port, sessionId }) {
    /** @type {{value: boolean}} */
    const ended = { value: false };
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: '/mcp',
            headers: { Host: `localhost:${port}`, Accept: 'text/event-stream', 'mcp-session-id': sessionId },
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => { ended.value = true; });
            res.on('close', () => { ended.value = true; });
            resolve({ ended: () => ended.value, close: () => req.destroy() });
        });
        req.on('error', () => { /* a closed stream errors on this side */ });
        req.end();
    });
}

test('initializes stay at the session cap and an idle session is evicted', async () => {
    setLimits({ values: { mcp_http_sessions_max: 2, mcp_http_session_idle_ms: 40 } });
    const handler = await createMcpHttpHandler({ tools: [] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const headers = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        /** @type {Array<string>} */
        const ids = [];
        for (let i = 0; i < 5; i += 1) {
            const res = await send({ port: srv.port, headers, body: INIT });
            assert.equal(res.status, 200, `initialize ${i} is served`);
            ids.push(String(res.headers['mcp-session-id'] ?? ''));
        }
        assert.ok(handler.sessions.size <= 2, `the cap holds (saw ${handler.sessions.size})`);
        assert.ok(handler.sessions.has(ids.at(-1) ?? ''), 'the newest session is the one kept');

        for (let i = 0; i < 100 && handler.sessions.size > 0; i += 1) await sleep(10);
        assert.equal(handler.sessions.size, 0, 'the idle sweep closed every session');
        assert.equal(handler.sessions.has(ids.at(-1) ?? ''), false);
    } finally {
        await handler.close();
        await srv.close();
        resetLimits();
    }
});

test('a session stays while it is used, so only the idle one is evicted', async () => {
    setLimits({ values: { mcp_http_sessions_max: 2, mcp_http_session_idle_ms: 60 } });
    const handler = await createMcpHttpHandler({ tools: [] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const base = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        const idle = await send({ port: srv.port, headers: base, body: INIT });
        const idleId = String(idle.headers['mcp-session-id'] ?? '');
        const busy = await send({ port: srv.port, headers: base, body: INIT });
        const busyId = String(busy.headers['mcp-session-id'] ?? '');
        assert.ok(idleId && busyId);

        // Keep the second session warm while the first goes idle.
        for (let i = 0; i < 6; i += 1) {
            await sleep(20);
            await send({ port: srv.port, headers: { ...base, 'mcp-session-id': busyId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
        }
        assert.equal(handler.sessions.has(idleId), false, 'the idle session was evicted');
        assert.equal(handler.sessions.has(busyId), true, 'the session in use survives');
    } finally {
        await handler.close();
        await srv.close();
        resetLimits();
    }
});

test('a held SSE stream does not pin the session cap', async () => {
    setLimits({ values: { mcp_http_sessions_max: 2, mcp_http_session_idle_ms: 60 } });
    const handler = await createMcpHttpHandler({ tools: [] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const base = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    /** @type {Array<{ended: () => boolean, close: () => void}>} */
    const streams = [];
    try {
        for (let i = 0; i < 6; i += 1) {
            const init = await send({ port: srv.port, headers: base, body: INIT });
            assert.equal(init.status, 200, `initialize ${i} is served`);
            const sessionId = String(init.headers['mcp-session-id'] ?? '');
            assert.ok(sessionId);
            // Each client holds its notification stream open, exactly as a real
            // client does, while the next session initializes.
            streams.push(await openStream({ port: srv.port, sessionId }));
        }
        assert.ok(handler.sessions.size <= 2, `a held stream must not pin the cap (saw ${handler.sessions.size})`);

        for (let i = 0; i < 100 && handler.sessions.size > 0; i += 1) await sleep(10);
        assert.equal(handler.sessions.size, 0, 'the idle sweep closed the streaming sessions too');

        for (let i = 0; i < 100 && streams.some((stream) => !stream.ended()); i += 1) await sleep(10);
        assert.ok(streams.every((stream) => stream.ended()), 'closing the transport ended every stream');
    } finally {
        for (const stream of streams) stream.close();
        await handler.close();
        await srv.close();
        resetLimits();
    }
});

/**
 * One JSON-RPC call over the Streamable HTTP transport, parsing either the JSON
 * body or the single SSE frame the transport answers with.
 * @param {{port: number, headers?: Record<string, string>, request: Record<string, unknown>}} arg0
 * @returns {Promise<{status: number, headers: any, result: any}>}
 */
async function rpc({ port, headers = {}, request }) {
    const res = await send({ port, headers, body: JSON.stringify({ jsonrpc: '2.0', ...request }) });
    const text = res.body.trim();
    /** @type {any} */
    let parsed = {};
    if (text.startsWith('{')) parsed = JSON.parse(text);
    else {
        const frame = text.split('\n').filter((/** @type {string} */ line) => line.startsWith('data:')).at(-1) ?? '';
        parsed = frame ? JSON.parse(frame.slice('data:'.length).trim()) : {};
    }
    return { status: res.status ?? 0, headers: res.headers, result: parsed.result ?? parsed.error };
}

test('a session with a live task is never evicted', async () => {
    setLimits({ values: { mcp_http_sessions_max: 2, mcp_http_session_idle_ms: 60 } });
    const handler = await createMcpHttpHandler({ tools: [LONG_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const base = { Host: `localhost:${srv.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        const init = await send({ port: srv.port, headers: base, body: INIT });
        const sessionId = String(init.headers['mcp-session-id'] ?? '');
        assert.ok(sessionId, 'the session handshook');
        const headers = { ...base, 'mcp-session-id': sessionId };
        const created = await rpc({ port: srv.port, headers, request: { id: 2, method: 'tools/call', params: { name: 'long', arguments: {}, task: { ttl: 5000 } } } });
        const taskId = String(created.result?.task?.taskId ?? '');
        assert.ok(taskId, 'the tool runs as a task');
        assert.equal(created.result.task.status, 'working');

        // Longer than three idle windows with no request to refresh the clock:
        // only the live task keeps the session.
        await sleep(250);
        assert.equal(handler.sessions.size, 1, 'a running task pins its session');

        /** @type {any} */
        let task = null;
        for (let i = 0; i < 100; i += 1) {
            task = (await rpc({ port: srv.port, headers, request: { id: 3, method: 'tasks/get', params: { taskId } } })).result;
            if (task?.status === 'completed') break;
            await sleep(20);
        }
        assert.equal(task?.status, 'completed', 'the sweep did not cancel the task');
        assert.equal(handler.sessions.size, 1, 'the session survived its own task');
    } finally {
        await handler.close();
        await srv.close();
        resetLimits();
    }
});

test('a shared task store does not serve another session\'s task', async () => {
    const store = new McpTaskStore();
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL], taskStore: store });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const clientA = legacyClient({ port: srv.port });
    const clientB = legacyClient({ port: srv.port });
    try {
        await clientA.start();
        await clientB.start();

        const task = await clientA.startToolTask({ name: 'slow' });
        assert.ok(store.list().tasks.some((entry) => entry.taskId === task.taskId), 'the shared store holds the task');

        await assert.rejects(
            () => clientB.getTask({ taskId: task.taskId }),
            (/** @type {any} */ err) => err?.code === ERROR_CODES.MCP_UNKNOWN_TASK,
            'B cannot read A\'s task',
        );
        await assert.rejects(
            () => clientB.cancelTask({ taskId: task.taskId }),
            (/** @type {any} */ err) => err?.code === ERROR_CODES.MCP_UNKNOWN_TASK,
            'B cannot cancel A\'s task',
        );
        await assert.rejects(
            () => clientB.getTaskResult({ taskId: task.taskId }),
            (/** @type {any} */ err) => err?.code === ERROR_CODES.MCP_UNKNOWN_TASK,
            'B cannot read A\'s task result',
        );
        assert.deepEqual((await clientB.listTasks()).tasks, [], 'B lists none of A\'s tasks');

        const finished = await clientA.waitForTask({ taskId: task.taskId, pollInterval: 10, maxWaitMs: 2000 });
        assert.equal(finished.status, 'completed', 'A\'s task ran to completion, not cancelled by B');
        assert.equal((await clientA.getTask({ taskId: task.taskId })).taskId, task.taskId);
        assert.deepEqual((await clientA.listTasks()).tasks.map((entry) => entry.taskId), [task.taskId]);
    } finally {
        await clientA.stop();
        await clientB.stop();
        await handler.close();
        await srv.close();
    }
});
