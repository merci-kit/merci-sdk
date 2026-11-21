// @ts-check
/**
 * Example 28 — One work item, one worktree, one agent that cannot leave it.
 *
 * A scheduler hands a single ticket to a coding agent. What you learn watching
 * it run:
 *
 *   1 — the item gets a real git worktree on its own branch, created once and
 *       reused on the next ensure, with the item key derived from its id;
 *   2 — the tools the agent gets are rooted in that path: `read`/`grep`/`glob`
 *       resolve inside it, an outside path is denied, and the shell runs with
 *       the worktree as cwd while an outside operand goes to the host's gate;
 *   3 — a real model reads the ticket's files through those tools and answers
 *       with the marker it found — the work is the model's, not the script's;
 *   4 — the deliverable is saved as an artifact *beside* the worktree, so
 *       `git status` keeps describing the item's work and nothing else;
 *   5 — `beforeRun` → work → `afterRun` → `remove`: a dirty worktree is
 *       refused without `force`, and force removes it;
 *   6 — `withWorkspace({ workspace })` lets an ordinary session join the same
 *       handle, no hand-built tool belt;
 *   7 — the SDK `TodoComponent` store is a scheduler work source: one tick
 *       dispatches the open todo and never the completed one.
 *
 * Public API: `WorkspaceManager`, `WORKSPACE_STRATEGIES`, `createWorkspaceTools`,
 * `workspaceKeyFor`, `isInsideRoot`, `resolveWorkspacePath`, `WORKSPACE_HOOKS`,
 * `EVENTS`, `log`.
 *
 * Run: `node examples/28_workspace_isolation.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { EVENTS, TodoComponent, initializeClient, loadCredentials, log } from 'merci-sdk';
import { WorkScheduler, createMemoryClaimStore, createTodoWorkSource } from 'merci-sdk/scheduler';
import {
    WORKSPACE_HOOKS, WORKSPACE_STRATEGIES, WorkspaceManager, createWorkspaceTools, isInsideRoot,
    resolveWorkspacePath, workspaceKeyFor,
} from 'merci-sdk/workspace';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

/** The external ticket id the scheduler passes in — the worktree key derives from it. */
const ITEM = 'MER-28';

/** @param {unknown} err @returns {string} */
const messageOf = (err) => String(/** @type {any} */ (err)?.message ?? err);

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
    mkdirSync(join(repo, 'notes', 'archive'), { recursive: true });
    git({ args: ['init', '-b', 'main'], cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    writeFileSync(
        join(repo, 'notes', 'checklist.md'),
        '# Release checklist\n\n- OPEN-1: ship the workspace note\n- DONE: seed the repository\n',
    );
    writeFileSync(join(repo, 'notes', 'archive', 'old.md'), '# Archive\n\n- OPEN-0: closed\n');
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

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

async function main() {
    const { provider, toolModel } = resolveExample();
    log.header({ t: `Example 28 — Workspace isolation (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on('api_request', () => { apiCalls += 1; });

    const dir = mkdtempSync(join(tmpdir(), 'merci-workspace-example-'));
    log.option({ name: 'sandbox', value: dir, source: 'mkdtempSync(tmpdir()) — removed in finally' });

    try {
        const repo = makeRepo({ dir });
        const manager = new WorkspaceManager({
            root: join(dir, 'root'),
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: repo,
            hooks: { beforeRun: 'printf before > before-run.txt', afterRun: 'printf after > after-run.txt' },
            eventEmitter: client,
        });
        log.option({ name: 'strategy', value: WORKSPACE_STRATEGIES.GIT_WORKTREE, source: 'new WorkspaceManager({ strategy })' });

        // ── 1 · one work item, one worktree ─────────────────────────────────
        log.section({ t: '1 · the item gets its own worktree' });
        log.info({ m: `The scheduler passes "${ITEM}". The manager derives a filesystem-safe key, creates a branch from HEAD and checks the tree out under its root.` });
        const workspace = await manager.ensure({ workItemId: ITEM });
        const reused = await manager.ensure({ workItemId: ITEM });
        log.list({
            title: 'workspace handle',
            items: [
                `workItemId  ${workspace.workItemId}`,
                `key         ${workspace.key}`,
                `branch      ${workspace.branch}`,
                `path        ${workspace.path}`,
                `createdNow  ${workspace.createdNow} then ${reused.createdNow}`,
            ],
        });
        check({
            name: 'the item got a real worktree on merci/<key>, and a second ensure reused it',
            passed: workspace.branch === `merci/${workspace.key}`
                && workspace.key === workspaceKeyFor({ workItemId: ITEM })
                && workspace.path === join(workspace.root, workspace.key)
                && existsSync(join(workspace.path, 'base.txt'))
                && statSync(join(workspace.path, '.git')).isFile()
                && workspace.createdNow === true && reused.createdNow === false && reused.path === workspace.path,
            detail: `${workspace.branch} · .git is a file · created ${workspace.createdNow} then ${reused.createdNow} · same path ${reused.path === workspace.path}`,
        });

        // The path guards are public on purpose: a host that builds its own
        // confinement can reuse the same rule instead of re-deriving it.
        const resolved = resolveWorkspacePath({ root: workspace.root, key: workspace.key });
        const insideRoot = isInsideRoot({ root: workspace.root, path: workspace.path });
        const outsideRoot = isInsideRoot({ root: workspace.root, path: join(dir, 'outside.txt') });
        const hookNames = Object.values(WORKSPACE_HOOKS);
        log.option({ name: 'resolveWorkspacePath', value: resolved === workspace.path ? 'same path as the handle' : resolved, source: 'resolveWorkspacePath({ root, key })' });
        log.option({ name: 'isInsideRoot', value: `worktree ${insideRoot} · outside ${outsideRoot}`, source: 'isInsideRoot({ root, path })' });
        log.option({ name: 'lifecycle hooks', value: hookNames.join(' → '), source: 'Object.values(WORKSPACE_HOOKS)' });
        check({
            name: 'the public path guards agree with the handle, and the hook vocabulary is complete',
            passed: resolved === workspace.path && insideRoot === true && outsideRoot === false
                && hookNames.join(',') === 'afterCreate,beforeRun,afterRun,beforeRemove',
            detail: `resolved ${resolved === workspace.path} · inside ${insideRoot} · outside ${outsideRoot} · hooks ${hookNames.join(',')}`,
        });

        // ── 2 · the agent's tools are rooted in that path ───────────────────
        log.section({ t: '2 · the bound tools — the worktree is the boundary' });
        writeFileSync(join(workspace.root, 'outside.txt'), 'outside\n');
        const absoluteOutside = join(dir, 'absolute-outside.txt');
        writeFileSync(absoluteOutside, 'outside\n');

        /** @type {number} */
        let asked = 0;
        /** @type {Array<{reason?: string}>} */
        const denied = [];
        client.on(EVENTS.TOOL.PATH_DENIED, (/** @type {{reason?: string}} */ payload) => denied.push(payload));

        const tools = /** @type {any} */ (createWorkspaceTools({
            workspace,
            approvalCallback: () => { asked += 1; return false; },
            eventEmitter: client,
        }));
        const read = tools.contextTools.find((/** @type {{name: string}} */ t) => t.name === 'read');
        const grep = tools.contextTools.find((/** @type {{name: string}} */ t) => t.name === 'grep');
        const glob = tools.contextTools.find((/** @type {{name: string}} */ t) => t.name === 'glob');
        log.list({
            title: 'bound tools',
            items: [
                `context  ${tools.contextTools.map((/** @type {{name: string}} */ t) => t.name).join(', ')} — root ${tools.root}`,
                `shell    ${tools.shellTool.name} — cwd ${tools.root}`,
                `artifact ${tools.artifactTool.name} — saved beside the worktree`,
            ],
        });

        log.info({ m: 'The host probes the boundary before the model runs: a relative escape and an absolute path outside the root.' });
        const inside = await read.execute({ args: { filePath: 'base.txt' } });
        const relativeDenied = await probe({ fn: () => read.execute({ args: { filePath: '../outside.txt' } }) });
        const absoluteDenied = await probe({ fn: () => read.execute({ args: { filePath: absoluteOutside } }) });
        check({
            name: 'a read inside succeeds, and both outside reads are denied with tool:path_denied',
            passed: String(inside).includes('base')
                && relativeDenied.ok === false && absoluteDenied.ok === false
                && denied.length === 2 && denied.every((d) => d.reason === 'outside_workspace_root'),
            detail: `inside ok · ../outside ${relativeDenied.ok ? 'ran' : messageOf(relativeDenied.error)} · absolute ${absoluteDenied.ok ? 'ran' : messageOf(absoluteDenied.error)} · events ${denied.map((d) => d.reason).join(',')}`,
        });

        log.info({ m: 'The shell is not rooted by a path prefix but by its cwd and roots, so an outside operand escalates to the host — here the host refuses every escalation.' });
        const pwd = await tools.shellTool.execute({ args: { command: 'pwd', args: [] } });
        const outsideShell = await tools.shellTool.execute({ args: { command: 'ls', args: ['..'] } });
        log.option({ name: 'shell pwd', value: String(pwd.stdout).trim(), source: 'shellTool.execute({ command: "pwd" })' });
        log.option({ name: 'approval gate', value: `${asked} escalation(s), refused`, source: 'shellTool.execute({ command: "ls", args: [".."] })' });
        check({
            name: 'the shell runs in the worktree and its outside operand is refused by the host',
            passed: pwd.success === true && String(pwd.stdout).trim() === realpathSync(workspace.path)
                && outsideShell.success === false && asked === 1,
            detail: `pwd=${String(pwd.stdout).trim()} · asked=${asked} · outside success=${outsideShell.success}`,
        });

        // ── 3 · beforeRun → the model does the work → afterRun ──────────────
        log.section({ t: '3 · beforeRun → the live model works inside the tree → afterRun' });
        await manager.beforeRun({ workspace });
        log.info({ m: 'beforeRun ran with the worktree as cwd and left its marker there — the item is now active.' });

        const prompt = 'Use the glob tool on "notes/**/*.md", read notes/checklist.md, grep for OPEN-, then run ls with the shell tool. Reply with exactly one line: RELEASE-28: <the open item id and its text>';
        log.user({ m: prompt });
        log.option({ name: 'model', value: toolModel, source: 'resolveExample().toolModel' });
        log.option({ name: 'tool budget', value: 'maxIterations 6', source: 'session.run({ options })' });

        /** @type {string[]} */
        const toolCalls = [];
        const session = client.session(toolModel)
            .withSystemMessage('You are a coding agent scoped to one git worktree. Use the provided tools; never guess file contents.')
            .withTools({ tools: [...tools.contextTools, tools.shellTool] });
        const answer = String(await session.run({
            initialInput: prompt,
            options: {
                maxIterations: 6,
                onEvent: (/** @type {{type?: string, name?: string}} */ event) => {
                    if (event?.type === 'tool_call_start') toolCalls.push(String(event.name));
                },
            },
        }));
        warnEmptyAnswer({ answer, label: 'the workspace agent' });
        log.assistant({ m: answer });
        log.option({ name: 'tool calls', value: toolCalls.join(', ') || '(none)', source: 'onEvent(tool_call_start)' });
        log.option({ name: 'vendor calls', value: `${apiCalls} api_request`, source: "client.on('api_request')" });

        // The host applies the answer: the deliverable outside the tree, the
        // item's own note inside it.
        const saved = await tools.artifactTool.execute({ args: { name: 'report.md', content: `${answer}\n` } });
        writeFileSync(join(workspace.path, 'RELEASE.md'), `${answer}\n`);
        const marker = existsSync(join(workspace.path, 'before-run.txt'));
        const after = await manager.afterRun({ workspace, outcome: 'succeeded' });
        log.list({
            title: 'the work',
            items: [
                `artifact  ${saved}`,
                `note      ${join(workspace.path, 'RELEASE.md')}`,
                `beforeRun marker ${marker} · afterRun ${after?.skipped === true ? `skipped (${after.reason})` : 'ran, guard cleared'}`,
            ],
        });
        check({
            name: 'the live model read the real files through the bound tools and answered with the ticket marker',
            passed: answer.includes('RELEASE-28') && answer.includes('OPEN-1')
                && toolCalls.includes('read') && toolCalls.includes('grep') && toolCalls.includes('glob') && toolCalls.includes('execute_shell_command')
                && apiCalls > 0,
            detail: `${apiCalls} api_request · calls ${toolCalls.join(', ') || '(none)'} · answer ${log.truncate({ text: answer.trim(), n: 120 })}`,
        });

        // ── 4 · the artifact boundary ───────────────────────────────────────
        log.section({ t: '4 · the artifact boundary — the deliverable stays out of the tree' });
        const artifactsDir = join(workspace.root, `${workspace.key}.artifacts`);
        const status = git({ args: ['status', '--porcelain'], cwd: workspace.path });
        log.info({ m: 'A sibling directory is invisible to the worktree, so the artifact neither dirties the tree nor reaches the agent tools. The host reads it back with fs.' });
        log.list({ title: 'git status in the worktree', items: status.split('\n').filter(Boolean) });
        check({
            name: 'the artifact lands in <root>/<key>.artifacts, the host reads it, and git never sees it',
            passed: saved === join(artifactsDir, 'report.md')
                && !saved.startsWith(`${workspace.path}${sep}`)
                && readFileSync(saved, 'utf8').includes('RELEASE-28')
                && !status.includes('report.md') && status.includes('RELEASE.md'),
            detail: `saved=${saved} · in tree=${saved.startsWith(`${workspace.path}${sep}`)} · status=${JSON.stringify(status)}`,
        });

        // ── 5 · the reverse seam: a plain session joins the handle ───────────
        log.section({ t: '5 · withWorkspace — an ordinary session joins the same handle' });
        log.info({ m: 'You do not have to build the tool belt yourself: `withWorkspace({ workspace })` binds the context tools, the shell and the artifact tool to one handle.' });
        const joined = client.session(toolModel)
            .withSystemMessage('You are scoped to one worktree. Answer only from the files you read.')
            .withApproval({ fn: () => false })
            .withWorkspace({ workspace });
        const joinedAnswer = String(await joined.run({
            initialInput: 'Read base.txt with the read tool and reply with exactly: JOINED-28: <file content>.',
            options: { maxIterations: 4 },
        }));
        warnEmptyAnswer({ answer: joinedAnswer, label: 'the withWorkspace session' });
        log.assistant({ m: joinedAnswer });
        check({
            name: 'withWorkspace bound a live session to the same worktree and the model read the real file',
            passed: joinedAnswer.includes('JOINED-28') && joinedAnswer.includes('base'),
            detail: log.truncate({ text: joinedAnswer.trim(), n: 120 }),
        });

        // ── 6 · the same todo list is the scheduler's board ─────────────────
        log.section({ t: '6 · the SDK todo store is a scheduler work source' });
        /** @type {Map<string, any>} */
        const todoStore = new Map();
        const todos = new TodoComponent({ store: todoStore });
        await todos.save({ args: { action: 'add', id: 'todo-open', title: `Open: ship ${ITEM}` } });
        await todos.save({ args: { action: 'add', id: 'todo-done', title: 'Done: already answered' } });
        await todos.save({ args: { action: 'complete', id: 'todo-done' } });
        const workSource = createTodoWorkSource({ store: todoStore });
        const pending = workSource.fetchByStates({ states: ['pending', 'in_progress'] });
        const done = workSource.fetchByIds({ ids: ['todo-done'] })[0] ?? null;
        log.list({
            title: 'the source mapped the todo statuses',
            items: [
                ...pending.map((/** @type {any} */ item) => `dispatch  ${item.identifier} · ${item.state} · dispatchable ${item.dispatchable}`),
                done ? `skip      ${done.identifier} · ${done.state} · dispatchable ${done.dispatchable}` : 'skip      (not found)',
            ],
        });

        /** @type {string[]} */
        const dispatched = [];
        client.on(EVENTS.WORK_ITEM.DISPATCHED, (/** @type {any} */ envelope) => { dispatched.push(String(envelope.identifier)); });
        const scheduler = new WorkScheduler({
            workSource,
            workflow: { run: async (/** @type {{item: any}} */ { item }) => ({ status: 'completed', summary: `shipped ${item.identifier}` }) },
            claims: createMemoryClaimStore(),
            eventEmitter: client,
            activeStates: ['pending', 'in_progress'],
            terminalStates: ['completed', 'failed'],
            concurrency: { global: 1 },
            continuation: { max: 0, delayMs: 0 },
            pollIntervalMs: 3_600_000,
            stallTimeoutMs: 0,
        });
        await scheduler.start();
        for (let i = 0; i < 400 && !scheduler.snapshot().completed.includes('todo-open'); i += 1) {
            await new Promise((resolve) => { setTimeout(resolve, 5); });
        }
        const board = scheduler.snapshot();
        await scheduler.stop();
        log.option({ name: 'board', value: `dispatches ${board.totals.dispatches} · completed [${board.completed.join(', ')}]`, source: 'scheduler.snapshot()' });
        check({
            name: 'one tick dispatched the open todo and never the completed one',
            passed: pending.length === 1 && done !== null && done.dispatchable === false
                && dispatched.join(',') === 'todo-open' && board.completed.includes('todo-open'),
            detail: `pending=${pending.length} · dispatched=[${dispatched.join(',')}] · completed=[${board.completed.join(',')}]`,
        });

        // ── 7 · handing the tree back ───────────────────────────────────────
        log.section({ t: '7 · remove — a dirty tree is refused, force overrides the guard' });
        const refused = await manager.remove({ workspace });
        log.option({ name: 'remove without force', value: JSON.stringify(refused), source: 'manager.remove({ workspace })' });
        const forced = await manager.remove({ workspace, force: true });
        log.option({ name: 'remove with force', value: JSON.stringify(forced), source: 'manager.remove({ workspace, force: true })' });
        check({
            name: 'the lifecycle ran end to end and removal respected the dirty guard',
            passed: marker === true && after?.skipped !== true
                && refused.removed === false && refused.reason === 'dirty'
                && forced.removed === true && !existsSync(workspace.path),
            detail: `marker=${marker} · refused=${JSON.stringify(refused)} · forced=${JSON.stringify(forced)} · gone=${!existsSync(workspace.path)}`,
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Workspace isolation: one worktree per item, bound tools, artifact boundary, clean hand-back.' });
}

runMain({ mainFn: main });
