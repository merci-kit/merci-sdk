// @ts-check
/**
 * Phase B granular-event proofs: tool output truncation + MCP call lifecycle.
 * One focused check per new emit site; fails if the emit is removed or the
 * payload fields drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';

test('tool:output_truncated fires with inLen/outLen when a string result is capped', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.TOOL.OUTPUT_TRUNCATED, (/** @type {any} */ e) => seen.push(e));
    const tools = [{
        name: 'big',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'x'.repeat(60_000),
    }];
    await executeTools({
        toolCalls: [{ id: 'c1', name: 'big', args: '{}' }],
        toolLibrary: tools, emitter, runContext: new RunContext(),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 'c1');
    assert.equal(seen[0].name, 'big');
    assert.equal(seen[0].inLen, 60_000);
    assert.ok(seen[0].outLen < seen[0].inLen, 'outLen is smaller than inLen');
});

test('tool:output_truncated does NOT fire for an under-cap string result', async () => {
    const emitter = new EventEmitter();
    let fired = 0;
    emitter.on(EVENTS.TOOL.OUTPUT_TRUNCATED, () => { fired += 1; });
    const tools = [{ name: 'small', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }];
    await executeTools({
        toolCalls: [{ id: 'c1', name: 'small', args: '{}' }],
        toolLibrary: tools, emitter, runContext: new RunContext(),
    });
    assert.equal(fired, 0);
});

test('mcp:call_start/end wrap a successful MCP tool call', async () => {
    const emitter = new EventEmitter();
    /** @type {string[]} */
    const calls = [];
    emitter.on(EVENTS.MCP.CALL_START, () => calls.push('start'));
    emitter.on(EVENTS.MCP.CALL_END, (/** @type {any} */ e) => calls.push(`end:${e.name}`));
    emitter.on(EVENTS.MCP.CALL_ERROR, () => calls.push('error'));
    const client = new McpClient({ command: 'x', options: { eventEmitter: emitter } });
    /** @type {any} */ (client)._client = { callTool: async () => ({ content: [] }) };
    const response = await client.executeTool({ name: 'foo', args: {} });
    assert.ok(response);
    assert.deepEqual(calls, ['start', 'end:foo']);
});

test('mcp:call_error fires and rethrows when the MCP call rejects', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const errors = [];
    emitter.on(EVENTS.MCP.CALL_ERROR, (/** @type {any} */ e) => errors.push(e));
    const client = new McpClient({ command: 'x', options: { eventEmitter: emitter } });
    /** @type {any} */ (client)._client = { callTool: async () => { throw new Error('nope'); } };
    await assert.rejects(() => client.executeTool({ name: 'bar', args: {} }), /nope/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'bar');
    assert.match(errors[0].error, /nope/);
});
