// @ts-check
/**
 * `FileMcpTaskStore` persists one JSON record per task, so a completed task
 * and its result survive a restart. A task that was `working` when the process
 * ended cannot resume, so it loads as `failed`. Retention still comes from the
 * last update, and an expired record is removed instead of loaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';
import { FileMcpTaskStore } from '../lib/tools/mcp-task-store.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

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

/** @returns {string} */
function scratchDir() {
    return mkdtempSync(join(tmpdir(), 'merci-task-store-'));
}

/** @param {{store: FileMcpTaskStore, taskId: string}} arg0 */
async function waitForTerminal({ store, taskId }) {
    for (let i = 0; i < 100; i += 1) {
        const task = store.get({ taskId });
        if (task.status !== 'working' && task.status !== 'input_required') return task;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`task ${taskId} never finished`);
}

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

test('a completed task and its result survive a restart', async () => {
    const dir = scratchDir();
    const store = new FileMcpTaskStore({ dir });
    try {
        const task = store.start({ run: async () => ({ content: [{ type: 'text', text: 'kept' }] }) });
        await waitForTerminal({ store, taskId: task.taskId });

        const reloaded = new FileMcpTaskStore({ dir });
        try {
            assert.equal(reloaded.get({ taskId: task.taskId }).status, 'completed');
            assert.deepEqual(reloaded.result({ taskId: task.taskId }), { content: [{ type: 'text', text: 'kept' }] });
        } finally {
            reloaded.close();
        }
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a task still working when the process ended loads as failed', async () => {
    const dir = scratchDir();
    const store = new FileMcpTaskStore({ dir });
    try {
        const task = store.start({ run: () => new Promise(() => {}) });

        const reloaded = new FileMcpTaskStore({ dir });
        try {
            const restored = reloaded.get({ taskId: task.taskId });
            assert.equal(restored.status, 'failed');
            assert.match(/** @type {string} */ (restored.statusMessage), /restarted/);
            assert.throws(() => reloaded.result({ taskId: task.taskId }), /restarted/);
        } finally {
            reloaded.close();
        }
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a cancelled task stays cancelled across a restart', async () => {
    const dir = scratchDir();
    const store = new FileMcpTaskStore({ dir });
    try {
        const task = store.start({ run: () => new Promise(() => {}) });
        assert.equal(store.cancel({ taskId: task.taskId }).status, 'cancelled');

        const reloaded = new FileMcpTaskStore({ dir });
        try {
            assert.equal(reloaded.get({ taskId: task.taskId }).status, 'cancelled');
            assert.throws(() => reloaded.result({ taskId: task.taskId }), /cancelled/);
        } finally {
            reloaded.close();
        }
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the retention timer removes the record from disk', async () => {
    const dir = scratchDir();
    const store = new FileMcpTaskStore({ dir });
    try {
        const task = store.start({ run: async () => 'done', ttl: 30 });
        await waitForTerminal({ store, taskId: task.taskId });
        assert.ok(existsSync(join(dir, `${task.taskId}.json`)), 'the record is written');

        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.deepEqual(store.list().tasks, [], 'the task is dropped');
        assert.equal(existsSync(join(dir, `${task.taskId}.json`)), false, 'the record is removed');
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a record already past its retention window is removed on load', async () => {
    const dir = scratchDir();
    try {
        const taskId = 'expired-task';
        const past = new Date(Date.now() - 10_000).toISOString();
        writeFileSync(join(dir, `${taskId}.json`), JSON.stringify({
            version: 1,
            task: {
                taskId,
                status: 'completed',
                ttl: 1000,
                createdAt: past,
                lastUpdatedAt: past,
                pollInterval: 1000,
            },
            result: { content: [] },
        }));

        const store = new FileMcpTaskStore({ dir });
        try {
            assert.deepEqual(store.list().tasks, []);
            assert.equal(existsSync(join(dir, `${taskId}.json`)), false);
        } finally {
            store.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('unreadable and malformed records are skipped, not fatal', async () => {
    const dir = scratchDir();
    try {
        writeFileSync(join(dir, 'bad.json'), '{not json');
        writeFileSync(join(dir, 'empty.json'), '{}');
        const store = new FileMcpTaskStore({ dir });
        try {
            assert.deepEqual(store.list().tasks, []);
        } finally {
            store.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a directory is required', () => {
    assert.throws(
        () => new FileMcpTaskStore({ dir: '' }),
        (err) => err instanceof ConfigurationError && /dir/.test(/** @type {Error} */ (err).message),
    );
});

test('the HTTP handler serves a task created before a restart', async () => {
    const dir = scratchDir();
    const first = new FileMcpTaskStore({ dir });
    const handler = await createMcpHttpHandler({ tools: [SLOW_TOOL], taskStore: first });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = legacyClient({ port: srv.port });
    /** @type {string} */
    let taskId = '';
    try {
        await client.start();
        taskId = (await client.startToolTask({ name: 'slow' })).taskId;
        for (let i = 0; i < 100; i += 1) {
            if ((await client.getTask({ taskId })).status === 'completed') break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
        first.close();
    }

    const second = new FileMcpTaskStore({ dir });
    const revived = await createMcpHttpHandler({ tools: [SLOW_TOOL], taskStore: second });
    const srv2 = await listen({ handler: (req, res) => revived.handle(req, res) });
    const client2 = legacyClient({ port: srv2.port });
    try {
        await client2.start();
        assert.equal((await client2.getTask({ taskId })).status, 'completed');
        const result = /** @type {any} */ (await client2.getTaskResult({ taskId }));
        assert.equal(result.content[0].text, 'slow-result');
    } finally {
        await client2.stop();
        await revived.close();
        await srv2.close();
        second.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
