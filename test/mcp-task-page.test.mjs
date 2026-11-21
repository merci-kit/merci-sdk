// @ts-check
/**
 * `tasks/list` must page a *foreign* task store (one with no `pageSize`) by the
 * live limit, `LIMITS.mcp_task_page_size`. A module constant frozen at import
 * ignored both the env var and `setLimits()`, so a host that lowers the page
 * size still got 100 rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createMcpHttpHandler } from '../lib/tools/mcp-server.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';

/** @type {import('../lib/tools/tool-execution.mjs').ToolDefinition} */
const TASK_TOOL = {
    name: 'tick',
    description: 'Answers immediately.',
    parameters: { type: 'object', properties: {} },
    taskSupport: 'optional',
    execute: async () => 'tick',
};

/**
 * A foreign store: the task methods, no `pageSize`. Paging every task in one
 * page keeps the double paging out of the way (the server pages it itself).
 * @param {{count: number}} arg0
 */
function foreignStore({ count }) {
    /** @type {Array<any>} */
    const tasks = Array.from({ length: count }, (_, i) => ({
        taskId: /** @type {string} */ (`task-${String(i).padStart(2, '0')}`),
        status: 'completed',
        ttl: null,
        createdAt: new Date(0).toISOString(),
        lastUpdatedAt: new Date(0).toISOString(),
    }));
    return {
        /** @param {any} _arg0 */
        start: (_arg0) => { throw new Error('not used'); },
        /** @param {{taskId: string}} arg0 */
        get: ({ taskId }) => tasks.find((task) => task.taskId === taskId),
        /** @param {{taskId: string}} arg0 */
        result: ({ taskId }) => tasks.find((task) => task.taskId === taskId),
        /** @param {{cursor?: string|null}} [_arg0] */
        list: (_arg0) => ({ tasks }),
        /** @param {{taskId: string}} arg0 */
        cancel: ({ taskId }) => tasks.find((task) => task.taskId === taskId),
        close: () => {},
    };
}

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('tasks/list pages a foreign store by the live page-size limit', async () => {
    setLimits({ values: { mcp_task_page_size: 7 } });
    const store = foreignStore({ count: 120 });
    const handler = await createMcpHttpHandler({ tools: [TASK_TOOL], taskStore: store });
    const srv = await listen({ handler: (req, res) => handler.handle(req, res) });
    const client = new McpClient({
        command: null,
        args: [],
        options: { url: `http://127.0.0.1:${srv.port}/mcp`, mcpProtocolVersion: 'legacy' },
    });
    try {
        await client.start();
        const page = await client.listTasks();
        assert.equal(page.tasks.length, 7, 'the override reaches the foreign-store fallback');
        assert.ok(page.nextCursor, 'more tasks remain');
    } finally {
        await client.stop();
        await handler.close();
        await srv.close();
        resetLimits();
    }
});
