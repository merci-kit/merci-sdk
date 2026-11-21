// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { WorkspaceManager } from '../lib/agentic/workspace/index.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * Run a body in a fresh temp directory and always clean it up.
 * @param {{fn: (arg0: {dir: string}) => Promise<void>}} arg0 -
 * @returns {Promise<void>}
 */
async function withTempDir({ fn }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-session-workspace-'));
    try {
        await fn({ dir });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * @param {{dir: string}} arg0 -
 * @returns {Promise<{workspace: import('../lib/agentic/workspace/manager.mjs').WorkspaceHandle}>}
 */
async function directoryWorkspace({ dir }) {
    const manager = new WorkspaceManager({ root: join(dir, 'root') });
    const workspace = await manager.ensure({ workItemId: 'MER-P5-SESSION' });
    await writeFile(join(workspace.path, 'inside.txt'), 'inside\n');
    await writeFile(join(workspace.root, 'outside.txt'), 'outside\n');
    return { workspace };
}

/**
 * @param {{session: import('../lib/agentic/chat-session-builder.mjs').ChatSessionBuilder, name: string}} arg0 -
 * @returns {import('../lib/tools/tool-execution.mjs').ReadyTool}
 */
function toolIn({ session, name }) {
    const found = /** @type {any} */ (session._tools.find((tool) => tool?.name === name));
    assert.ok(found, `${name} must be bound to the session`);
    return found;
}

test('withWorkspace runs the worktree shell and confines the context and artifact tools', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        const artifactsDir = join(workspace.path, '.merci-artifacts');
        const session = new ChatSessionBuilder()
            .withApproval({ fn: (/** @type {string} */ command, /** @type {string[]} */ args) => !args.includes('..') })
            .withWorkspace({ workspace, artifactsDir });

        assert.equal(session.workspace, workspace);

        const shell = toolIn({ session, name: 'execute_shell_command' });
        const pwd = await shell.execute({ args: { command: 'pwd', args: [] } });
        assert.equal(pwd.success, true);
        assert.equal(String(pwd.stdout).trim(), await realpath(workspace.path));

        const outsideOperand = await shell.execute({ args: { command: 'ls', args: ['..'] } });
        assert.equal(outsideOperand.success, false);

        const read = toolIn({ session, name: 'read' });
        await assert.rejects(() => read.execute({ args: { filePath: '../outside.txt' } }), /outside the workspace root/i);
        assert.ok(String(await read.execute({ args: { filePath: 'inside.txt' } })).includes('inside'));

        const artifactTool = toolIn({ session, name: 'save_artifact' });
        const saved = await artifactTool.execute({ args: { name: 'report.md', content: '# report\n' } });
        assert.equal(saved, join(artifactsDir, 'report.md'));

        session.withWorkspace({ workspace, artifactsDir });
        const shells = session._tools.filter((tool) => tool?.name === 'execute_shell_command');
        assert.equal(shells.length, 1, 'a second withWorkspace must not duplicate execute_shell_command');
    } });
});

test('withWorkspace without an approval callback and default mode fails closed', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        assert.throws(
            () => new ChatSessionBuilder().withWorkspace({ workspace }),
            (error) => error instanceof ConfigurationError && /** @type {any} */ (error).option === 'approvalCallback'
        );
    } });
});

test('withWorkspace under bypassPermissions binds a shell and announces once', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        const emitter = new EventEmitter();
        /** @type {Array<{name: string, payload: any}>} */
        const seen = [];
        const baseEmit = emitter.emit.bind(emitter);
        emitter.emit = (name, ...args) => {
            seen.push({ name: String(name), payload: args[0] });
            return baseEmit(name, ...args);
        };

        const session = new ChatSessionBuilder();
        session.eventEmitter = emitter;
        session.withWorkspace({ workspace, permissionMode: 'bypassPermissions' });

        assert.ok(toolIn({ session, name: 'execute_shell_command' }));
        const bypass = seen.filter((entry) => entry.name === EVENTS.PERMISSIONS.BYPASS && entry.payload?.target === 'shell');
        assert.equal(bypass.length, 1, 'the bypass opt-in is announced exactly once');
    } });
});

test('withWorkspace follows the session permission mode, and an explicit mode wins', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });

        const bypass = new ChatSessionBuilder()
            .withPermissions({ mode: 'bypassPermissions' })
            .withWorkspace({ workspace });
        assert.ok(toolIn({ session: bypass, name: 'execute_shell_command' }));

        const explicit = new ChatSessionBuilder()
            .withPermissions({ mode: 'default' })
            .withWorkspace({ workspace, permissionMode: 'bypassPermissions' });
        assert.ok(toolIn({ session: explicit, name: 'execute_shell_command' }));

        assert.throws(
            () => new ChatSessionBuilder().withWorkspace({ workspace }),
            (error) => error instanceof ConfigurationError && /** @type {any} */ (error).option === 'approvalCallback'
        );
    } });
});

test('withTools after withWorkspace clears the workspace handle and its tools', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        const custom = /** @type {any} */ ({
            name: 'custom',
            description: 'custom',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'ok'
        });
        const session = new ChatSessionBuilder()
            .withApproval({ fn: () => true })
            .withWorkspace({ workspace });
        assert.equal(session.workspace, workspace);

        session.withTools({ tools: [custom] });
        assert.equal(session.workspace, null, 'a whole-list replacement drops the binding');
        assert.equal(session._tools.some((tool) => tool?.name === 'read'), false);
        assert.ok(session._tools.some((tool) => tool?.name === 'custom'));
    } });
});

test('withWorkspace does not resurrect a tool a later step removed from the session list', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        const custom = /** @type {any} */ ({
            name: 'custom',
            description: 'custom',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'ok'
        });
        const session = new ChatSessionBuilder()
            .withApproval({ fn: () => true })
            .withTools({ tools: [custom] });

        // A handoff or a native-mode filter strips the list after it was set.
        session._toolsStore = [];
        session.withWorkspace({ workspace });

        assert.equal(session._tools.some((tool) => tool?.name === 'custom'), false, 'removed tools stay removed');
        assert.ok(session._tools.some((tool) => tool?.name === 'read'));
        assert.ok(session._tools.some((tool) => tool?.name === 'execute_shell_command'));
    } });
});

test('withWorkspace validates its options', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        const session = new ChatSessionBuilder();
        for (const call of [
            () => session.withWorkspace(),
            () => session.withWorkspace(/** @type {any} */ (null)),
            () => session.withWorkspace(/** @type {any} */ ({}))
        ]) {
            assert.throws(call, (error) => error instanceof ConfigurationError && /** @type {any} */ (error).option === 'workspace');
        }
        assert.throws(
            () => session.withWorkspace({ workspace, permissionMode: /** @type {any} */ ('nope') }),
            (error) => error instanceof ConfigurationError && /** @type {any} */ (error).option === 'permissionMode'
        );
    } });
});

test('withWorkspace picks up the withApproval callback automatically', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const { workspace } = await directoryWorkspace({ dir });
        /** @type {number} */
        let asked = 0;
        const session = new ChatSessionBuilder()
            .withApproval({ fn: () => { asked += 1; return false; } })
            .withWorkspace({ workspace });

        const shell = toolIn({ session, name: 'execute_shell_command' });
        const result = await shell.execute({ args: { command: 'ls', args: ['..'] } });
        assert.equal(result.success, false);
        assert.equal(asked, 1, 'the session approval gate is the shell gate');
    } });
});
