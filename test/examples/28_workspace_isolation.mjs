// @ts-check
/**
 * Example 28 — Workspace isolation: one git worktree per work item, bound tools.
 *
 * A deterministic core plus a live model scene. A temp repository with one
 * commit, a `WorkspaceManager` on the `git-worktree` strategy rooted under the
 * OS temp dir, and the coding tools the binder builds.
 *
 *   A — ensure a worktree      : the item gets a real worktree on `merci/<key>`,
 *       the base file is there, `.git` is a file, and a second ensure reuses it.
 *   B — the bound tools        : a read inside succeeds; a read of `../outside`
 *       and of an absolute outside path is denied with `tool:path_denied`; the
 *       shell `pwd` is the worktree; an outside operand is denied by the
 *       approval callback.
 *   L — the live scene         : a real model reads `base.txt` through the
 *       bound read tool and answers with its marker.
 *   C — the artifact boundary  : a saved artifact lands in the sibling
 *       `<root>/<key>.artifacts`, outside the worktree, so `git status` stays
 *       empty — and the host reads it back with `fs`.
 *   D — the lifecycle          : `beforeRun` → edit → `afterRun` → `remove`
 *       refuses a dirty worktree without `force`, then removes it with it.
 *
 * Public API: `WorkspaceManager`, `WORKSPACE_STRATEGIES`, `createWorkspaceTools`,
 * `workspaceKeyFor`, `EVENTS`, `log`.
 *
 * Run: `node test/examples/28_workspace_isolation.mjs` (live) · `node test/examples/28_workspace_isolation.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live scene;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { EVENTS, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    WORKSPACE_HOOKS, WORKSPACE_STRATEGIES, WorkspaceManager, createWorkspaceTools, isInsideRoot,
    resolveWorkspacePath, workspaceKeyFor,
} from 'merci-sdk/workspace';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/28_workspace_isolation',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 28 — Workspace isolation',
});

/** The stable external work-item key — the scheduler passes its `identifier` here. */
const ITEM = 'MER-28';

/**
 * Run git and throw on a non-zero exit. Setup and observation only.
 * @param {{args: Array<string>, cwd: string}} arg0 -
 * @returns {string} Trimmed stdout.
 */
function git({ args, cwd }) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
}

/**
 * A repository with one commit, so a worktree has a base ref to start from.
 * @param {{dir: string}} arg0 -
 * @returns {string} The repo root.
 */
function makeRepo({ dir }) {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git({ args: ['init', '-b', 'main'], cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git({ args: ['add', '.'], cwd: repo });
    git({
        args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '-m', 'base'],
        cwd: repo,
    });
    return repo;
}

/**
 * Run a tool call and keep the rejection instead of throwing it.
 * @param {{fn: () => Promise<unknown>}} arg0 -
 * @returns {Promise<{ok: boolean, value?: unknown, error?: unknown}>}
 */
async function probe({ fn }) {
    try {
        return { ok: true, value: await fn() };
    } catch (error) {
        return { ok: false, error };
    }
}

/** @param {unknown} error @returns {string} */
const messageOf = (error) => String(/** @type {any} */ (error)?.message ?? error);

async function main() {
    const dir = mkdtempSync(join(tmpdir(), 'merci-workspace-example-'));
    log.option({ name: 'sandbox', value: dir, source: 'mkdtempSync(tmpdir()) — removed in finally' });

    /** @type {Awaited<ReturnType<typeof initializeClient>>['client']|null} */
    let client = null;
    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    let apiCalls = 0;

    try {
        if (live !== null) {
            const initialized = await initializeClient({
                provider: live.provider,
                options: loadCredentials({ provider: live.provider }),
            });
            client = initialized.client;
            wireClient({ client });
            usage = trackUsage({ client });
            client.on('api_request', () => { apiCalls += 1; });
        }
        const repo = makeRepo({ dir });
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: repo,
            hooks: { beforeRun: 'printf before > before-run.txt' },
        });

        // ── A: ensure a worktree ─────────────────────────────────────────────
        audit.scenario({
            id: 'A', title: 'ensure a worktree workspace',
            goal: 'one work item gets a real git worktree on its own branch, created once and reused after',
            expect: 'createdNow true · key is workspaceKeyFor(ITEM) · path is <root>/<key> · branch merci/<key> · base.txt present · .git is a file · a second ensure reuses the same path',
            fails: [
                { code: 'no-worktree', symptom: 'the path is a plain directory or `.git` is a directory', hint: 'the strategy must be git-worktree and repoRoot must be the temp repo' },
                { code: 'wrong-key', symptom: 'the handle key differs from workspaceKeyFor(ITEM)', hint: 'ensure derives the key from the work item id; it is deterministic' },
                { code: 'recreated', symptom: 'the second ensure reports createdNow: true', hint: 'ensure reuses the existing worktree; it never resets it' },
            ],
            input: { workItemId: ITEM, strategy: 'git-worktree' },
        });

        const workspace = await manager.ensure({ workItemId: ITEM });
        const reused = await manager.ensure({ workItemId: ITEM });
        log.list({
            title: 'workspace handle',
            items: [
                `workItemId  ${workspace.workItemId}`,
                `key         ${workspace.key}`,
                `path        ${workspace.path}`,
                `branch      ${workspace.branch}`,
            ],
        });
        audit.observe({ name: 'handle', value: { key: workspace.key, path: workspace.path, branch: workspace.branch } });
        audit.check({
            name: 'the workspace is a worktree of the temp repo, on a branch derived from the key',
            ok: workspace.branch === `merci/${workspace.key}`
                && existsSync(join(workspace.path, 'base.txt'))
                && statSync(join(workspace.path, '.git')).isFile(),
            detail: {
                expected: 'merci/<key> · base.txt · .git is a file',
                observed: `${workspace.branch} · base=${existsSync(join(workspace.path, 'base.txt'))} · gitFile=${statSync(join(workspace.path, '.git')).isFile()}`,
            },
        });
        audit.check({
            name: 'the key is workspaceKeyFor(ITEM) and the path is <root>/<key>',
            ok: workspace.key === workspaceKeyFor({ workItemId: ITEM }) && workspace.path === join(workspace.root, workspace.key),
            detail: { expected: workspaceKeyFor({ workItemId: ITEM }), observed: workspace.key },
        });
        audit.check({
            name: 'a second ensure reuses the same worktree',
            ok: workspace.createdNow === true && reused.createdNow === false && reused.path === workspace.path,
            detail: { expected: 'true then false · same path', observed: `${workspace.createdNow} then ${reused.createdNow} · same=${reused.path === workspace.path}` },
        });
        // The path guards are public on purpose: a host that builds its own
        // confinement can reuse the same rule instead of re-deriving it.
        const resolved = resolveWorkspacePath({ root: workspace.root, key: workspace.key });
        const insideRoot = isInsideRoot({ root: workspace.root, path: workspace.path });
        const outsideRootPath = isInsideRoot({ root: workspace.root, path: join(dir, 'outside.txt') });
        const hookNames = Object.values(WORKSPACE_HOOKS);
        audit.observe({ name: 'path guards', value: { resolved, insideRoot, outsideRootPath, hooks: hookNames } });
        audit.check({
            name: 'resolveWorkspacePath and isInsideRoot agree with the handle',
            ok: resolved === workspace.path && insideRoot === true && outsideRootPath === false
                && hookNames.join(',') === 'afterCreate,beforeRun,afterRun,beforeRemove',
            detail: {
                expected: 'resolved == path · inside true · outside false · four hook names',
                observed: `resolved ${resolved === workspace.path} · inside ${insideRoot} · outside ${outsideRootPath} · hooks ${hookNames.join(',')}`,
            },
        });
        audit.end();

        // ── B: the bound tools ───────────────────────────────────────────────
        audit.scenario({
            id: 'B', title: 'the bound coding tools',
            goal: 'read and the shell resolve inside the worktree, and an outside path is denied by the tool or by the approval callback',
            expect: 'read base.txt succeeds · read ../outside.txt and an absolute outside path are denied with tool:path_denied · shell pwd is the worktree · shell ls .. is denied by the callback',
            fails: [
                { code: 'read-leak', symptom: 'a read outside the worktree returned content', hint: 'the binder roots createContextTools at workspace.path' },
                { code: 'no-denial', symptom: 'no tool:path_denied event for an outside read', hint: 'confine() emits EVENTS.TOOL.PATH_DENIED before it throws' },
                { code: 'shell-escaped', symptom: 'pwd is not the worktree, or ls .. ran without approval', hint: 'the binder owns cwd/roots and gates an outside operand' },
            ],
            input: { workItemId: ITEM, approvalCallback: 'deny-all' },
        });

        writeFileSync(join(workspace.root, 'outside.txt'), 'outside\n');
        const absoluteOutside = join(dir, 'absolute-outside.txt');
        writeFileSync(absoluteOutside, 'outside\n');

        /** @type {number} */
        let asked = 0;
        const emitter = new EventEmitter();
        /** @type {Array<{reason?: string}>} */
        const denied = [];
        emitter.on(EVENTS.TOOL.PATH_DENIED, (/** @type {{reason?: string}} */ payload) => denied.push(payload));

        const tools = /** @type {any} */ (createWorkspaceTools({
            workspace,
            approvalCallback: () => { asked += 1; return false; },
            eventEmitter: emitter,
        }));
        const read = tools.contextTools[0];
        const inside = await read.execute({ args: { filePath: 'base.txt' } });
        audit.check({
            name: 'a read inside the worktree succeeds',
            ok: String(inside).includes('base'),
            detail: { expected: 'base', observed: String(inside).trim() },
        });

        const relativeDenied = await probe({ fn: () => read.execute({ args: { filePath: '../outside.txt' } }) });
        const absoluteDenied = await probe({ fn: () => read.execute({ args: { filePath: absoluteOutside } }) });
        audit.observe({ name: 'tool:path_denied reasons', value: denied.map((d) => d.reason) });
        audit.check({
            name: 'a read of ../outside and of an absolute outside path is denied with tool:path_denied',
            ok: relativeDenied.ok === false && absoluteDenied.ok === false
                && denied.length === 2 && denied.every((d) => d.reason === 'outside_workspace_root'),
            detail: {
                expected: '2 denials, reason outside_workspace_root',
                observed: `${relativeDenied.ok ? 'ran' : messageOf(relativeDenied.error)} · ${absoluteDenied.ok ? 'ran' : messageOf(absoluteDenied.error)} · ${denied.map((d) => d.reason).join(',')}`,
            },
        });

        const pwd = await tools.shellTool.execute({ args: { command: 'pwd', args: [] } });
        audit.check({
            name: 'the shell pwd is the worktree',
            ok: pwd.success === true && String(pwd.stdout).trim() === realpathSync(workspace.path),
            detail: { expected: realpathSync(workspace.path), observed: String(pwd.stdout).trim() },
        });

        const outsideShell = await tools.shellTool.execute({ args: { command: 'ls', args: ['..'] } });
        audit.check({
            name: 'a shell command reaching outside is denied by the approval callback',
            ok: outsideShell.success === false && asked === 1,
            detail: { expected: '1 approval asked · refused', observed: `${asked} asked · success=${outsideShell.success}` },
        });
        audit.end();

        // ── L: the live model scene ──────────────────────────────────────────
        if (client !== null && live !== null) {
            audit.scenario({
                id: 'L', title: 'the live workspace scene',
                goal: 'a real model uses the bound read tool inside the worktree and answers with the file marker',
                expect: 'at least one api_request · a read tool call · the answer contains WORKSPACE-LIVE',
                fails: [
                    { code: 'no-api', symptom: 'no api_request was emitted', hint: 'the session must run a real model turn' },
                    { code: 'no-read', symptom: 'the model never called the read tool', hint: 'the system message and prompt must ask for the read; do not fake the tool call' },
                    { code: 'wrong-answer', symptom: 'the answer does not contain WORKSPACE-LIVE', hint: 'the model must return the exact file contents' },
                ],
                input: { file: 'base.txt', model: live.toolModel, maxIterations: 4 },
            });
            const liveFile = join(workspace.path, 'base.txt');
            writeFileSync(liveFile, 'base WORKSPACE-LIVE');
            /** @type {Array<string>} */
            const liveToolNames = [];
            try {
                const session = client.session(live.toolModel)
                    .withSystemMessage('You are a coding agent scoped to this workspace. Use the read tool; do not guess.')
                    .withTools({ tools: [...tools.contextTools, tools.shellTool] });
                const answer = await session.run({
                    initialInput: 'Use the read tool to read base.txt, then reply with its exact contents and nothing else.',
                    options: {
                        maxIterations: 4,
                        onEvent: (/** @type {{type?: string, name?: string}} */ event) => {
                            if (event?.type === 'tool_call_start') liveToolNames.push(String(event.name));
                        },
                    },
                });
                const answerText = String(answer ?? '');
                audit.observe({ name: 'live answer', value: answerText });
                audit.observe({ name: 'live tool calls', value: liveToolNames });
                audit.check({
                    name: 'the live run made a real vendor call',
                    ok: apiCalls > 0,
                    detail: { expected: '> 0 api_request', observed: `${apiCalls} api_request` },
                });
                audit.check({
                    name: 'the model called the bound read tool',
                    ok: liveToolNames.includes('read'),
                    detail: { expected: 'read in the tool calls', observed: liveToolNames.join(', ') || '(none)' },
                });
                audit.check({
                    name: 'the answer carries the file marker read from inside the worktree',
                    ok: answerText.includes('WORKSPACE-LIVE'),
                    detail: { expected: 'the answer contains WORKSPACE-LIVE', observed: answerText },
                });
            } finally {
                // Restore the base file so C's clean-worktree check stays exact.
                writeFileSync(liveFile, 'base\n');
            }
            audit.end();
        }

        // ── C: the artifact boundary ─────────────────────────────────────────
        audit.scenario({
            id: 'C', title: 'the artifact boundary',
            goal: 'a saved artifact lands beside the worktree, so the worktree stays clean and the host can read the file',
            expect: 'saved path is <root>/<key>.artifacts/report.md · the host reads the content · git status --porcelain is empty',
            fails: [
                { code: 'artifact-inside', symptom: 'the artifact landed inside the worktree', hint: 'the default artifactsDir is <root>/<key>.artifacts' },
                { code: 'dirty-tree', symptom: 'git status shows the artifact', hint: 'a sibling directory is invisible to the worktree' },
                { code: 'unreadable', symptom: 'the host cannot read the returned path', hint: 'the host reads with fs; the agent tools cannot' },
            ],
            input: { name: 'report.md' },
        });

        const saved = await tools.artifactTool.execute({ args: { name: 'report.md', content: '# report\n' } });
        const artifactsDir = join(workspace.root, `${workspace.key}.artifacts`);
        log.list({ title: 'artifact', items: [`saved     ${saved}`, `worktree  ${workspace.path}`] });
        audit.check({
            name: 'the artifact lands in the sibling <root>/<key>.artifacts, outside the worktree',
            ok: saved === join(artifactsDir, 'report.md') && !saved.startsWith(`${workspace.path}${sep}`),
            detail: { expected: join(artifactsDir, 'report.md'), observed: saved },
        });
        audit.check({
            name: 'the host reads the saved file with fs',
            ok: readFileSync(saved, 'utf8') === '# report\n',
            detail: { expected: '# report\\n', observed: JSON.stringify(readFileSync(saved, 'utf8')) },
        });
        const status = git({ args: ['status', '--porcelain'], cwd: workspace.path });
        audit.check({
            name: 'git status in the worktree is still empty',
            ok: status === '',
            detail: { expected: '(empty)', observed: JSON.stringify(status) },
        });
        audit.end();

        // ── D: the lifecycle ─────────────────────────────────────────────────
        audit.scenario({
            id: 'D', title: 'the lifecycle: beforeRun → work → afterRun → remove',
            goal: 'the hooks run with the worktree as cwd, a dirty worktree is refused without force, and force removes it',
            expect: 'beforeRun wrote its marker · afterRun clears the active guard · remove without force → dirty · with force → removed, path gone',
            fails: [
                { code: 'hook-cwd', symptom: 'before-run.txt is not in the worktree', hint: 'a hook runs with workspace.path as cwd' },
                { code: 'dirty-deleted', symptom: 'remove without force removed the worktree', hint: 'force: false is the default; a dirty worktree is refused' },
                { code: 'force-kept', symptom: 'remove with force left the path', hint: 'force overrides the dirty guard for a path this manager owns' },
            ],
            input: { hook: 'beforeRun', force: 'false then true' },
        });

        await manager.beforeRun({ workspace });
        const marker = existsSync(join(workspace.path, 'before-run.txt'));
        writeFileSync(join(workspace.path, 'work.txt'), 'agent work\n');
        const after = await manager.afterRun({ workspace, outcome: 'succeeded' });
        audit.observe({ name: 'lifecycle', value: { marker, after, statusBeforeRemove: git({ args: ['status', '--porcelain'], cwd: workspace.path }) } });
        audit.check({
            name: 'beforeRun runs in the worktree and afterRun clears the guard',
            ok: marker === true && after?.skipped !== true,
            detail: { expected: 'before-run.txt present · not skipped', observed: `marker=${marker} · after=${JSON.stringify(after)}` },
        });

        const refused = await manager.remove({ workspace });
        audit.check({
            name: 'remove without force refuses the dirty worktree',
            ok: refused.removed === false && refused.reason === 'dirty' && existsSync(workspace.path),
            detail: { expected: 'removed=false reason=dirty · path intact', observed: `${JSON.stringify(refused)} · intact=${existsSync(workspace.path)}` },
        });

        const forced = await manager.remove({ workspace, force: true });
        audit.check({
            name: 'remove with force removes it',
            ok: forced.removed === true && !existsSync(workspace.path),
            detail: { expected: 'removed=true · path gone', observed: `${JSON.stringify(forced)} · gone=${!existsSync(workspace.path)}` },
        });
        audit.end();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    if (live !== null && usage !== null) reportUsage({ provider: live.provider, usage });
    log.success({ m: 'Workspace isolation verified: worktree, bound tools, artifact boundary, lifecycle.' });
}

// The await matters: without it the run is not a top-level await, and a
// stalled round would exit 0 with a truncated log instead of failing.
await audit.run(main);
