// @ts-check
/**
 * The exported limit constants are documented *code defaults*, not the live
 * values. Live configuration is `LIMITS` / `getLimits()`: an override must move
 * the behaviour without moving these numbers (the mcp-server page-size
 * fallback case is covered in `mcp-task-page.test.mjs`).
 *
 * Pins are literals: comparing a constant to `LIMIT_REGISTRY[key].default`
 * compares the initialiser to itself and can never fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import { DEFAULT_TOOL_OUTPUT_MAX_LENGTH } from '../lib/tools/external-capability.mjs';
import { MCP_TASK_PAGE_SIZE } from '../lib/tools/mcp-task-store.mjs';
import * as mcpClientModule from '../lib/tools/mcp-client.mjs';

test('the kept limit constants equal their reviewed literals', () => {
    assert.equal(DEFAULT_TOOL_OUTPUT_MAX_LENGTH, 50_000);
    assert.equal(MCP_TASK_PAGE_SIZE, 100);
    assert.equal(mcpClientModule.MCP_MAX_OUTPUT_LENGTH, 50_000);
});

test('an override moves the live limit, not the shipped constant', () => {
    try {
        setLimits({ values: { mcp_task_page_size: 7 } });
        assert.equal(LIMITS.mcp_task_page_size, 7);
        assert.equal(MCP_TASK_PAGE_SIZE, 100, 'the constant stays the code default');
    } finally {
        resetLimits();
    }
});

test('the deleted reconnect-delay constant is gone from mcp-client', () => {
    assert.ok(!('MCP_RECONNECT_BASE_DELAY_MS' in mcpClientModule));
});
