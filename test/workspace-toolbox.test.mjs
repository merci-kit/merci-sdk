// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    WorkspaceManager,
    WORKSPACE_STRATEGIES,
    createWorkspaceTools,
    isInsideRoot
} from '../lib/agentic/workspace/index.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';

/**
 * An `EventEmitter` that also records every event `emit` receives.
 * @typedef {import('node:events').EventEmitter & {events: Array<{event: string, [key: string]: unknown}>}} CapturingEmitter
 */

/**
 * @returns {CapturingEmitter}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    const emitter = new EventEmitter();
    const baseEmit = emitter.emit.bind(emitter);
    emitter.emit = (name, ...args) => {
        const payload = /** @type {Record<string, unknown>|undefined} */ (args[0]);
        events.push({ event: String(name), ...(payload ?? {}) });
        return baseEmit(name, ...args);
    };
    return Object.assign(emitter, { events });
}

/**
 * @param {{emitter: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<{event: string, [key: string]: unknown}>}
 */
function eventsNamed({ emitter, name }) {
    return emitter.events.filter((entry) => entry.event === name);
}

/**
 * Run a body in a fresh temp directory and always clean it up.
 * @param {{fn: (arg0: {dir: string}) => Promise<void>}} arg0 -
 * @returns {Promise<void>}
 */
async function withTempDir({ fn }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-workspace-toolbox-'));
    try {
        await fn({ dir });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** True when the host has a usable `git`; the worktree case is skipped otherwise. */
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * Run git and throw on a non-zero exit. Test setup only.
 * @param {{args: Array<string>, cwd: string}} arg0 -
 * @returns {string} Trimmed stdout.
 */
function runGit({ args, cwd }) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
}

/**
 * Assert the binder throws a `ConfigurationError` with the given `option` and a
 * message that names the defect, so two failure modes cannot both satisfy a
 * bare class check.
 * @param {{fn: () => unknown, option: string, message: RegExp}} arg0 -
 * @returns {void}
 */
function assertRefused({ fn, option, message }) {
    assert.throws(fn, (error) => {
        assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${String(error)}`);
        assert.equal(error.option, option);
        assert.match(error.message, message);
        return true;
    });
}

/**
 * A directory-strategy manager, one ensured workspace, and the fixture files
 * the tool tests read and refuse.
 * @param {{dir: string}} arg0 -
 * @returns {Promise<{manager: WorkspaceManager, workspace: import('../lib/agentic/workspace/manager.mjs').WorkspaceHandle}>}
 */
async function directoryWorkspace({ dir }) {
    const manager = new WorkspaceManager({ root: join(dir, 'root') });
    const workspace = await manager.ensure({ workItemId: 'MER-TOOLBOX-1' });
    await writeFile(join(workspace.path, 'inside.txt'), 'inside\n');
    await writeFile(join(workspace.path, '.env'), 'SECRET=1\n');
    await writeFile(join(workspace.root, 'outside.txt'), 'outside\n');
    return { manager, workspace };
}

describe('createWorkspaceTools — context tools', () => {
    test('read succeeds inside the workspace', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const { root, contextTools, workspace: bound } = createWorkspaceTools({ workspace, include: ['context'] });
            assert.equal(root, workspace.path);
            assert.equal(bound, workspace);
            assert.equal(contextTools?.length, 3);

            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);
            const out = await read.execute({ args: { filePath: 'inside.txt' } });
            assert.ok(String(out).includes('inside'));
        } });
    });

    test('read ../outside.txt is denied and emits tool:path_denied', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const emitter = createEmitter();
            const { contextTools } = createWorkspaceTools({ workspace, include: ['context'], eventEmitter: emitter });
            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);

            await assert.rejects(() => read.execute({ args: { filePath: '../outside.txt' } }), /outside the workspace root/i);
            const denied = eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED });
            assert.equal(denied.length, 1);
            assert.equal(denied[0].reason, 'outside_workspace_root');
        } });
    });

    test('read of an absolute path outside the workspace is denied', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const outside = join(dir, 'absolute-outside.txt');
            await writeFile(outside, 'outside\n');
            const emitter = createEmitter();
            const { contextTools } = createWorkspaceTools({ workspace, include: ['context'], eventEmitter: emitter });
            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);

            await assert.rejects(() => read.execute({ args: { filePath: outside } }), /outside the workspace root/i);
            assert.equal(eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED }).length, 1);
        } });
    });

    test('read of .env inside the workspace is denied as sensitive', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const emitter = createEmitter();
            const { contextTools } = createWorkspaceTools({ workspace, include: ['context'], eventEmitter: emitter });
            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);

            await assert.rejects(() => read.execute({ args: { filePath: '.env' } }), /sensitive file/i);
            const denied = eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED });
            assert.equal(denied.length, 1);
            assert.equal(denied[0].reason, 'sensitive_file');
        } });
    });

    test('grep of a path outside the workspace is denied and emits tool:path_denied', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const emitter = createEmitter();
            const { contextTools } = createWorkspaceTools({ workspace, include: ['context'], eventEmitter: emitter });
            const grep = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools)[1];

            await assert.rejects(() => grep.execute({ args: { pattern: 'outside', path: '..' } }), /outside the workspace root/i);
            const denied = eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED });
            assert.equal(denied.length, 1);
            assert.equal(denied[0].reason, 'outside_workspace_root');
        } });
    });

    test('glob resolves only inside the root: an outside pattern returns no matches and no event', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const emitter = createEmitter();
            const { contextTools } = createWorkspaceTools({ workspace, include: ['context'], eventEmitter: emitter });
            const glob = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools)[2];

            const out = await glob.execute({ args: { pattern: '../**/*.txt' } });
            assert.equal(String(out), 'No files found');
            assert.ok(!String(out).includes('outside.txt'));
            assert.equal(eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED }).length, 0);
        } });
    });

    test('read of a symlink inside the root that points outside is denied as resolves_outside_workspace_root', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const outside = join(dir, 'outside-secret.txt');
            await writeFile(outside, 'secret\n');
            await symlink(outside, join(workspace.path, 'link.txt'));
            const emitter = createEmitter();
            const { contextTools } = createWorkspaceTools({ workspace, include: ['context'], eventEmitter: emitter });
            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);

            await assert.rejects(() => read.execute({ args: { filePath: 'link.txt' } }), /resolves outside the workspace root/i);
            const denied = eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED });
            assert.equal(denied.length, 1);
            assert.equal(denied[0].reason, 'resolves_outside_workspace_root');
        } });
    });

    test('caller context.root is ignored; the tools stay bound to the workspace', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const outside = join(dir, 'absolute-outside.txt');
            await writeFile(outside, 'outside\n');
            const { contextTools } = createWorkspaceTools({
                workspace,
                include: ['context'],
                context: { root: join(dir, 'not-the-workspace') }
            });
            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);

            const out = await read.execute({ args: { filePath: 'inside.txt' } });
            assert.ok(String(out).includes('inside'));
            await assert.rejects(() => read.execute({ args: { filePath: outside } }), /outside the workspace root/i);
        } });
    });
});

describe('createWorkspaceTools — shell tool', () => {
    test('pwd reports the real workspace path', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const { shellTool } = createWorkspaceTools({
                workspace,
                approvalCallback: () => true,
                shell: { cwd: '/', roots: ['/'] }
            });
            assert.ok(shellTool);

            const result = await shellTool.execute({ args: { command: 'pwd', args: [] } });
            assert.equal(result.success, true);
            assert.equal(String(result.stdout).trim(), await realpath(workspace.path));
        } });
    });

    test('ls .. is gated and denied by a deny-all approval callback', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            /** @type {Array<{command: string, args: Array<string>}>} */
            const asked = [];
            const { shellTool } = createWorkspaceTools({
                workspace,
                approvalCallback: (/** @type {string} */ command, /** @type {Array<string>} */ args) => {
                    asked.push({ command, args });
                    return false;
                }
            });
            assert.ok(shellTool);

            const result = await shellTool.execute({ args: { command: 'ls', args: ['..'] } });
            assert.equal(result.success, false);
            assert.equal(asked.length, 1, 'the outside-root operand must reach the gate');
        } });
    });

    test('cat /etc/hosts is gated and denied by a deny-all approval callback', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            /** @type {number} */
            let asked = 0;
            const { shellTool } = createWorkspaceTools({
                workspace,
                approvalCallback: () => { asked += 1; return false; }
            });
            assert.ok(shellTool);

            const result = await shellTool.execute({ args: { command: 'cat', args: ['/etc/hosts'] } });
            assert.equal(result.success, false);
            assert.equal(asked, 1);
        } });
    });

    test('without a callback under bypassPermissions, the bound shell runs a gated command', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const { shellTool } = createWorkspaceTools({ workspace, permissionMode: 'bypassPermissions' });
            assert.ok(shellTool, 'bypass is the explicit opt-in that may bind an ungated shell');

            const result = await shellTool.execute({ args: { command: 'ls', args: ['..'] } });
            assert.equal(result.success, true);
        } });
    });

    test('the approvalCallback accepts { callback } and { fn, options }', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            /** @type {number} */
            let asked = 0;
            const shapes = [
                { callback: () => { asked += 1; return false; } },
                { fn: () => { asked += 1; return false; }, options: { timeoutMs: 100 } }
            ];
            for (const approvalCallback of shapes) {
                const { shellTool } = createWorkspaceTools({ workspace, approvalCallback });
                assert.ok(shellTool);
                const result = await shellTool.execute({ args: { command: 'cat', args: ['/etc/hosts'] } });
                assert.equal(result.success, false);
            }
            assert.equal(asked, 2, 'both object shapes reach the shell gate');
        } });
    });
});

describe('createWorkspaceTools — artifact tool', () => {
    test('a save lands in <root>/<key>.artifacts, outside the workspace, and the agent cannot read it', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const emitter = createEmitter();
            const { artifactTool, contextTools } = createWorkspaceTools({
                workspace,
                include: ['context', 'artifacts'],
                eventEmitter: emitter
            });
            assert.ok(artifactTool);

            const saved = await artifactTool.execute({ args: { name: 'report.md', content: '# report\n' } });
            const expectedDir = join(workspace.root, `${workspace.key}.artifacts`);
            assert.equal(saved, join(expectedDir, 'report.md'));
            assert.equal(isInsideRoot({ root: workspace.path, path: saved }), false);
            assert.equal(await readFile(saved, 'utf8'), '# report\n');

            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);
            await assert.rejects(() => read.execute({ args: { filePath: saved } }), /outside the workspace root/i);
            assert.equal(eventsNamed({ emitter, name: EVENTS.TOOL.PATH_DENIED }).length, 1);
        } });
    });

    test('artifactsDir inside the workspace allows agent read-back', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const artifactsDir = join(workspace.path, '.merci-artifacts');
            const { artifactTool, contextTools } = createWorkspaceTools({
                workspace,
                include: ['context', 'artifacts'],
                artifactsDir
            });
            assert.ok(artifactTool);

            const saved = await artifactTool.execute({ args: { name: 'report.md', content: '# report\n' } });
            assert.equal(saved, join(artifactsDir, 'report.md'));

            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);
            const out = await read.execute({ args: { filePath: saved } });
            assert.ok(String(out).includes('# report'));
        } });
    });

    test('a relative artifactsDir resolves against workspace.root, not process.cwd()', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            // Pin cwd outside workspace.root so a process.cwd() fallback cannot
            // accidentally produce the same answer as the correct resolution.
            const cwd = process.cwd();
            process.chdir(dir);
            try {
                const { artifactTool } = createWorkspaceTools({
                    workspace,
                    include: ['artifacts'],
                    artifactsDir: 'shared-artifacts'
                });
                assert.ok(artifactTool);

                const saved = await artifactTool.execute({ args: { name: 'note.txt', content: 'note\n' } });
                assert.equal(saved, join(workspace.root, 'shared-artifacts', 'note.txt'));
                assert.equal(isInsideRoot({ root: workspace.root, path: saved }), true);
            } finally {
                process.chdir(cwd);
            }
        } });
    });

    test('a name that normalizes outside the artifact directory is refused', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const artifactTool = createSaveArtifactTool({ dir: join(dir, 'artifacts') });
            await assert.rejects(
                () => artifactTool.execute({ args: { name: '..', content: 'escape\n' } }),
                (error) => error instanceof ConfigurationError
                    && /** @type {any} */ (error).option === 'name'
                    && /escapes the artifact directory/i.test(/** @type {any} */ (error).message)
            );
        } });
    });

    test('an artifactsDir that is a symlink outside workspace.root is refused and creates nothing', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const outside = join(dir, 'outside-artifacts');
            await mkdir(outside);
            await symlink(outside, join(workspace.root, 'linked-artifacts'));

            assertRefused({
                fn: () => createWorkspaceTools({
                    workspace,
                    include: ['artifacts'],
                    artifactsDir: join(workspace.root, 'linked-artifacts')
                }),
                option: 'artifactsDir',
                message: /resolves outside the workspace root/i
            });
            assert.deepEqual(await readdir(outside), [], 'nothing may be created outside the root');
        } });
    });
});

describe('createWorkspaceTools — include and validation', () => {
    test("include: ['context'] returns null shell and artifact tools", async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const tools = createWorkspaceTools({ workspace, include: ['context'] });
            assert.equal('then' in tools, false, 'the binder is synchronous, not a promise');
            assert.deepEqual(Object.keys(tools).sort(), ['artifactTool', 'contextTools', 'root', 'shellTool', 'workspace']);
            assert.equal(tools.contextTools?.length, 3);
            assert.equal(tools.shellTool, null);
            assert.equal(tools.artifactTool, null);

            // The documented scheduler wiring: no `await`, spread the groups.
            const all = [tools.contextTools, tools.shellTool, tools.artifactTool].flat().filter(Boolean);
            assert.equal(all.length, 3);
        } });
    });

    test("include: ['shell'] without approvalCallback fails on approvalCallback", async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace, include: ['shell'] }),
                option: 'approvalCallback',
                message: /approvalCallback/
            });
        } });
    });

    test('the default include without an approvalCallback fails on approvalCallback, not the workspace', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace }),
                option: 'approvalCallback',
                message: /approvalCallback/
            });
        } });
    });

    test('context.allowOutsideRoot: true is a ConfigurationError', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace, include: ['context'], context: { allowOutsideRoot: true } }),
                option: 'context.allowOutsideRoot',
                message: /allowOutsideRoot/
            });
        } });
    });

    test('context.allowOutsideRoot is refused even when the context group is not included', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace, include: ['artifacts'], context: { allowOutsideRoot: true } }),
                option: 'context.allowOutsideRoot',
                message: /allowOutsideRoot/
            });
        } });
    });

    test('an unknown include name is a ConfigurationError', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace, include: ['context', 'network'] }),
                option: 'include',
                message: /network/
            });
        } });
    });

    test('a missing, non-directory, or symlink workspace path names the defect', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const file = join(dir, 'a-file.txt');
            await writeFile(file, 'not a directory\n');
            const link = join(dir, 'link-to-workspace');
            await symlink(workspace.path, link);

            // `include: ['context']` so the shell/approval check cannot mask the
            // path guard; each call must fail on `workspace.path` for its reason.
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, path: join(dir, 'missing') }, include: ['context'] }),
                option: 'workspace.path',
                message: /does not exist/
            });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, path: 'relative/workspace' }, include: ['context'] }),
                option: 'workspace.path',
                message: /absolute/
            });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, path: file }, include: ['context'] }),
                option: 'workspace.path',
                message: /not a directory/
            });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, path: link }, include: ['context'] }),
                option: 'workspace.path',
                message: /symlink/
            });
        } });
    });

    test('a workspace path whose parent symlink leaves workspace.root is a ConfigurationError', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            const outsideParent = join(dir, 'outside-parent');
            await mkdir(join(outsideParent, 'child'), { recursive: true });
            await symlink(outsideParent, join(workspace.root, 'link-parent'));

            assertRefused({
                fn: () => createWorkspaceTools({
                    workspace: { ...workspace, path: join(workspace.root, 'link-parent', 'child') },
                    include: ['context']
                }),
                option: 'workspace.path',
                message: /resolves outside/
            });
        } });
    });

    test('an invalid workspace root or key is a ConfigurationError', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, root: 'relative/root' }, include: ['context'] }),
                option: 'workspace.root',
                message: /absolute/
            });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, root: '' }, include: ['context'] }),
                option: 'workspace.root',
                message: /non-empty/
            });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace: { ...workspace, key: '' }, include: ['context'] }),
                option: 'workspace.key',
                message: /key/
            });
        } });
    });

    test('a workspace root that does not exist is a ConfigurationError', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({
                    workspace: { ...workspace, root: join(dir, 'missing-root') },
                    include: ['context']
                }),
                option: 'workspace.root',
                message: /does not exist/
            });
        } });
    });

    test('an artifactsDir outside workspace.root is a ConfigurationError', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const { workspace } = await directoryWorkspace({ dir });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace, include: ['artifacts'], artifactsDir: join(dir, 'outside-artifacts') }),
                option: 'artifactsDir',
                message: /inside the workspace root/i
            });
            assertRefused({
                fn: () => createWorkspaceTools({ workspace, include: ['artifacts'], artifactsDir: '' }),
                option: 'artifactsDir',
                message: /empty/
            });
        } });
    });
});

describe('createWorkspaceTools — git-worktree artifact boundary', {
    skip: GIT_AVAILABLE ? false : 'git is not available on PATH'
}, () => {
    test('a save lands outside the worktree and git status stays empty', async () => {
        await withTempDir({ fn: async ({ dir }) => {
            const repo = join(dir, 'repo');
            await mkdir(repo, { recursive: true });
            runGit({ args: ['init', '-b', 'main'], cwd: repo });
            await writeFile(join(repo, 'base.txt'), 'base\n');
            runGit({ args: ['add', '.'], cwd: repo });
            runGit({
                args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '-m', 'base'],
                cwd: repo
            });
            const manager = new WorkspaceManager({
                root: join(dir, 'root'),
                strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
                repoRoot: repo
            });
            const workspace = await manager.ensure({ workItemId: 'MER-WT-TOOLBOX' });

            const { artifactTool, contextTools } = createWorkspaceTools({ workspace, include: ['context', 'artifacts'] });
            assert.ok(artifactTool);
            const saved = await artifactTool.execute({ args: { name: 'notes.md', content: 'notes\n' } });

            assert.equal(saved, join(workspace.root, `${workspace.key}.artifacts`, 'notes.md'));
            assert.equal(isInsideRoot({ root: workspace.path, path: saved }), false);
            assert.equal(runGit({ args: ['status', '--porcelain'], cwd: workspace.path }), '');

            const [read] = /** @type {Array<import('../lib/tools/tool-execution.mjs').ReadyTool>} */ (contextTools);
            await assert.rejects(() => read.execute({ args: { filePath: saved } }), /outside the workspace root/i);
        } });
    });
});
