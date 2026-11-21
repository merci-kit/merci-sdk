// @ts-check
/**
 * MCP Tasks are 2025-11-25 vocabulary: the server advertises
 * `execution.taskSupport`, `tools/call` with `task` returns a task, and the
 * client polls `tasks/get` / `tasks/result`. The v2 SDK ships no runtime for
 * the vocabulary, so both sides speak it directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';
import { McpTaskStore } from '../lib/tools/mcp-task-store.mjs';
import { BackendError, ConfigurationError } from '../lib/core/errors.mjs';
import { ERROR_CODES } from '../lib/core/constants/index.mjs';

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
const WAIT_TOOL = {
    name: 'wait',
    description: 'Waits until cancelled.',
    parameters: { type: 'object', properties: {} },
    taskSupport: 'optional',
    execute: (/** @type {any} */ envelope) => new Promise((_, reject) => {
        envelope?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
};

/** @type {import('../lib/tools/tool-execution.mjs').ToolDefinition} */
const REQUIRED_TOOL = {
    name: 'required',
    description: 'Must run as a task.',
    parameters: { type: 'object', properties: {} },
    taskSupport: 'required',
    execute: async () => 'ran',
};

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {{port: number}} arg0 */
function legacyClient({ port }) {
    return new McpClient({
        command: null,
        args: [],
        options: { url: `http://127.0.0.1:${port}/mcp`, mcpProtocolVersion: 'legacy' },
    });
}

test('the server advertises task support and runs a task to completion', async () => {
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        const listed = await client.getTools();
        assert.deepEqual(listed[0].execution, { taskSupport: 'optional' });

        const task = await client.startToolTask({ name: 'slow' });
        assert.equal(task.status, 'working');
        assert.ok(task.taskId);

        const finished = await waitForStatus({ client, taskId: task.taskId, status: 'completed' });
        assert.equal(finished.status, 'completed');
        const result = /** @type {any} */ (await client.getTaskResult({ taskId: task.taskId }));
        assert.equal(result.content[0].text, 'slow-result');
        assert.deepEqual((await client.listTasks()).tasks.map((entry) => entry.taskId), [task.taskId]);
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('a task can be cancelled', async () => {
    const handler = await createMcpHttpHandler({ tools: [WAIT_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        const task = await client.startToolTask({ name: 'wait' });
        const cancelled = await client.cancelTask({ taskId: task.taskId });
        assert.equal(cancelled.status, 'cancelled');
        assert.equal((await client.getTask({ taskId: task.taskId })).status, 'cancelled');
        await assert.rejects(() => client.getTaskResult({ taskId: task.taskId }), /cancelled|not complete/i);
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('a required-task tool rejects a plain call', async () => {
    const handler = await createMcpHttpHandler({ tools: [REQUIRED_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        const result = /** @type {any} */ (await client.executeTool({ name: 'required', args: {} }));
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /requires a task/);
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('the ttl is retention from the last update, not a run deadline', async () => {
    /** @type {(() => void)|null} */
    let release = null;
    /** @type {import('../lib/tools/tool-execution.mjs').ToolDefinition} */
    const gate = {
        name: 'gate',
        description: 'Completes when released.',
        parameters: { type: 'object', properties: {} },
        taskSupport: 'optional',
        execute: () => new Promise((resolve) => { release = () => resolve('gated'); }),
    };
    const handler = await createMcpHttpHandler({ tools: [gate] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        const task = await client.startToolTask({ name: 'gate', ttl: 20 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal((await client.getTask({ taskId: task.taskId })).status, 'working', 'a working task outlives its ttl');
        assert.ok(release, 'the tool is running');
        /** @type {() => void} */ (release)();
        await waitForStatus({ client, taskId: task.taskId, status: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual((await client.listTasks()).tasks, [], 'a finished task is retained for its ttl');
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('closing the server aborts a task still in flight', async () => {
    let aborted = false;
    /** @type {import('../lib/tools/tool-execution.mjs').ToolDefinition} */
    const abortable = {
        name: 'abortable',
        description: 'Waits until the server closes.',
        parameters: { type: 'object', properties: {} },
        taskSupport: 'optional',
        execute: (/** @type {any} */ envelope) => new Promise((_, reject) => {
            envelope?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('closed')); }, { once: true });
        }),
    };
    const handler = await createMcpHttpHandler({ tools: [abortable] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        await client.startToolTask({ name: 'abortable' });
        await handler.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(aborted, true);
    } finally {
        await client.stop();
        await srv.close();
    }
});

test('waitForTask polls to a terminal state and honors its own budget', async () => {
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL, WAIT_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        const slow = await client.startToolTask({ name: 'slow' });
        const done = await client.waitForTask({ taskId: slow.taskId, pollInterval: 10, maxWaitMs: 2000 });
        assert.equal(done.status, 'completed');

        const waiting = await client.startToolTask({ name: 'wait' });
        await assert.rejects(
            () => client.waitForTask({ taskId: waiting.taskId, pollInterval: 10, maxWaitMs: 20 }),
            /did not finish/,
        );
        await client.cancelTask({ taskId: waiting.taskId });
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

/**
 * @param {{client: McpClient, taskId: string, status: string}} arg0
 */
async function waitForStatus({ client, taskId, status }) {
    for (let i = 0; i < 50; i += 1) {
        const task = await client.getTask({ taskId });
        if (task.status === status) return task;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`task ${taskId} never reached ${status}`);
}

test('a supplied task store is used and is not closed with the session', async () => {
    const store = new McpTaskStore({ pageSize: 2 });
    let closed = false;
    const close = store.close.bind(store);
    store.close = () => { closed = true; close(); };
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL], taskStore: store });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        const task = await client.startToolTask({ name: 'slow' });
        await waitForStatus({ client, taskId: task.taskId, status: 'completed' });
        assert.deepEqual(store.list().tasks.map((entry) => entry.taskId), [task.taskId], 'the task lives in the supplied store');
        await handler.close();
        assert.equal(closed, false, 'the caller owns the supplied store');
    } finally {
        await client.stop();
        await srv.close();
    }
});

test('tasks/list pages by cursor', async () => {
    const store = new McpTaskStore({ pageSize: 2 });
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL], taskStore: store });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        for (let i = 0; i < 3; i += 1) await client.startToolTask({ name: 'slow' });
        const first = await client.listTasks();
        assert.equal(first.tasks.length, 2);
        assert.ok(first.nextCursor, 'more tasks remain');
        const second = await client.listTasks({ cursor: first.nextCursor });
        assert.equal(second.tasks.length, 1);
        assert.equal(second.nextCursor, undefined);
        assert.notEqual(first.tasks[0].taskId, second.tasks[0].taskId);
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('an unknown task carries the domain error code', async () => {
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    try {
        await client.start();
        for (const call of [
            () => client.getTask({ taskId: 'missing' }),
            () => client.cancelTask({ taskId: 'missing' }),
        ]) {
            await assert.rejects(call, (err) =>
                err instanceof BackendError
                && err.code === ERROR_CODES.MCP_UNKNOWN_TASK
                && err.context?.taskId === 'missing');
        }
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('the client surfaces task status notifications', async () => {
    /** @type {Array<import('../lib/tools/mcp-client.mjs').McpTask>} */
    const seen = [];
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL] });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = new McpClient({
        command: null,
        args: [],
        options: {
            url: `http://127.0.0.1:${srv.port}/mcp`,
            mcpProtocolVersion: 'legacy',
            onTaskStatus: (task) => seen.push(task),
        },
    });
    try {
        await client.start();
        const task = await client.startToolTask({ name: 'slow' });
        await waitForStatus({ client, taskId: task.taskId, status: 'completed' });
        for (let i = 0; i < 50; i += 1) {
            if (seen.some((entry) => entry.taskId === task.taskId && entry.status === 'completed')) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(seen.some((entry) => entry.taskId === task.taskId && entry.status === 'completed'), 'the completed status arrived');
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
    }
});

test('taskStore is refused where a task cannot outlive a request', async () => {
    /** @type {Array<any>} */
    const variants = [
        { mcpProtocolVersion: '2026-07-28' },
        { sessionIdGenerator: undefined },
    ];
    for (const options of variants) {
        await assert.rejects(
            () => createMcpHttpHandler({ tools: [SLOW_TOOL], taskStore: new McpTaskStore(), ...options }),
            (err) => err instanceof ConfigurationError && /taskStore/.test(err.message),
        );
    }
});
