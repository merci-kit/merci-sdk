// @ts-check
/**
 * G2-3: `acceptEdits` is a brand, not a name.
 *
 * The mode used to auto-approve any gated tool whose name started with
 * `write`/`create`/`delete`/`move`…, so a remote MCP tool called
 * `delete_repository` ran without asking. Now only a tool the SDK brands
 * `editsFiles === true` (and that does not run code) is approved; the name
 * still drives the allow/deny globs through `isEditTool`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEditTool, stillRequiresApproval } from '../lib/agentic/permissions.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { loadMcpTools } from '../lib/tools/mcp-client.mjs';

/** The gated names `track-g2/06-accept-edits-glob.mjs` proved were approved at HEAD. */
const NAME_MATCHED = ['delete_repository', 'create_payment', 'move_funds', 'deleteAllRecords', 'createSubagent'];

test('acceptEdits never auto-approves a name-matched foreign tool', () => {
    for (const name of NAME_MATCHED) {
        assert.equal(isEditTool({ name }), true, `${name} still matches the allow/deny glob family`);
        assert.equal(stillRequiresApproval({
            name,
            mode: 'acceptEdits',
            requiresApproval: true,
            tool: {},
        }), true, `${name} carries no editsFiles brand, so it must ask`);
    }
    // No tool bag at all: nothing is branded, so nothing is auto-approved.
    assert.equal(stillRequiresApproval({ name: 'delete_repository', mode: 'acceptEdits', requiresApproval: true }), true);
});

test('acceptEdits approves the branded built-in', () => {
    const tool = createSaveArtifactTool({ dir: 'artifacts' });
    assert.equal(tool.name, 'save_artifact');
    assert.equal(/** @type {any} */ (tool).editsFiles, true, 'the SDK brands its own file writer');
    assert.equal(stillRequiresApproval({
        name: tool.name,
        mode: 'acceptEdits',
        requiresApproval: true,
        tool,
    }), false, 'a branded file edit does not ask under acceptEdits');
    // The brand never outranks "runs code": a branded tool that also runs code still asks.
    assert.equal(stillRequiresApproval({
        name: tool.name,
        mode: 'acceptEdits',
        requiresApproval: true,
        tool: { editsFiles: true, runsCode: true },
    }), true);
    // `default` and bypassPermissions are untouched by the brand.
    assert.equal(stillRequiresApproval({ name: tool.name, mode: 'default', requiresApproval: true, tool }), true);
    assert.equal(stillRequiresApproval({ name: tool.name, mode: 'bypassPermissions', requiresApproval: true, tool }), false);
});

test('an MCP destructive tool still asks', async () => {
    const mcpClient = /** @type {any} */ ({
        approveDestructive: true,
        connect: async () => {},
        stop: async () => {},
        getTools: async () => [
            { name: 'delete_repository', description: 'Deletes a repository', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
            { name: 'write_config', description: 'Writes config', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: false, readOnlyHint: false } },
        ],
        executeTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const tools = await loadMcpTools({ mcpClient });
    const destructive = /** @type {any} */ (tools.find((t) => t.name === 'delete_repository'));
    const writer = /** @type {any} */ (tools.find((t) => t.name === 'write_config'));
    assert.equal(destructive.requiresApproval, true, 'the server hint gates the tool');
    assert.equal(destructive.editsFiles, undefined, 'a remote tool never carries the edits brand');
    assert.equal(writer.editsFiles, undefined, 'a remote writer is not a local file edit');
    for (const tool of [destructive, writer]) {
        assert.equal(stillRequiresApproval({
            name: /** @type {string} */ (tool.name),
            mode: 'acceptEdits',
            requiresApproval: /** @type {boolean} */ (tool.requiresApproval),
            tool,
        }), true, `acceptEdits must not approve the MCP tool ${tool.name}`);
    }
});
