// @ts-check

/**
 * @file IR-1: the scheduler lifecycle against the real `WorkspaceManager`
 * (`git-worktree`, temp repository, no model calls).
 * @version 0.12.0
 *
 * @description
 * Two items run concurrently, one per linked worktree: each workflow checks
 * its own `cwd` and that its write never appears in the other worktree. Item A
 * commits its write and item B leaves it uncommitted, so the terminal cleanup
 * exercises both RC-16 outcomes on the real manager: A is removed and leaves
 * `git worktree list` without its path, B is refused as `dirty` and survives
 * with `work_item:workspace_cleanup_refused`. A second scheduler then proves
 * startup cleanup goes through the real `handleFor()` + `remove()`.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkScheduler, createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { WorkspaceManager, WORKSPACE_STRATEGIES } from '../lib/agentic/workspace/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** True when the host has a usable `git`; the whole file is skipped otherwise. */
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * A capturing emitter `emitEvent` accepts: it only needs `emit`.
 * @typedef {Object} CapturingEmitter
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emitSafe
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/**
 * @returns {CapturingEmitter}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    return {
        events,
        emitSafe: (name, envelope) => { events.push(/** @type {{event: string, [key: string]: unknown}} */ (envelope)); },
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {}
    };
}

/**
 * @param {{event: string, [key: string]: unknown}} entry -
 * @returns {Record<string, unknown>}
 */
function payloadOf(entry) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
        if (!ENVELOPE_KEYS.has(key)) out[key] = value;
    }
    return out;
}

/**
 * @param {{emitter: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<Record<string, unknown>>}
 */
function payloads({ emitter, name }) {
    return emitter.events.filter((entry) => entry.event === name).map((entry) => payloadOf(entry));
}

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
 * Create a real repository with one commit.
 * @param {{dir: string}} arg0 -
 * @returns {Promise<void>}
 */
async function createRepo({ dir }) {
    await mkdir(dir, { recursive: true });
    runGit({ args: ['init', '-b', 'main'], cwd: dir });
    await writeFile(join(dir, 'base.txt'), 'base\n');
    runGit({ args: ['add', '.'], cwd: dir });
    runGit({
        args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '-m', 'base'],
        cwd: dir
    });
}

/**
 * The `worktree` paths `git worktree list` reports.
 * @param {{repo: string}} arg0 -
 * @returns {Array<string>}
 */
function listWorktrees({ repo }) {
    return runGit({ args: ['worktree', 'list', '--porcelain'], cwd: repo })
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
}

/**
 * @param {{path: string}} arg0 -
 * @returns {Promise<boolean>}
 */
async function exists({ path }) {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * @returns {{promise: Promise<void>, resolve: () => void}}
 */
function deferredVoid() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = /** @type {Promise<void>} */ (new Promise((res) => { resolve = () => res(); }));
    return { promise, resolve };
}

/**
 * Poll a predicate until it holds; real git IO can outlast a microtask flush.
 * @param {{predicate: () => boolean, label: string, timeoutMs?: number}} arg0 -
 * @returns {Promise<void>}
 */
async function waitFor({ predicate, label, timeoutMs = 10_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
}

/**
 * A recording wrapper around the real manager: it delegates every call and
 * records the method and arguments so the startup path can be observed without
 * replacing the real lifecycle.
 * @param {{manager: WorkspaceManager}} arg0 -
 * @returns {{
 *   calls: Array<{method: string, args: Record<string, unknown>}>,
 *   ensure: (arg0: {workItemId: string, signal?: AbortSignal|null}) => Promise<Record<string, unknown>>,
 *   beforeRun: (arg0: {workspace: Record<string, unknown>, signal?: AbortSignal|null}) => Promise<unknown>,
 *   afterRun: (arg0: {workspace: Record<string, unknown>, outcome: string, signal?: AbortSignal|null}) => Promise<unknown>,
 *   remove: (arg0: {workspace: Record<string, unknown>, force?: boolean}) => Promise<{removed?: boolean, reason?: string}|null|undefined>,
 *   handleFor: (arg0: {workItemId: string}) => Record<string, unknown>
 * }}
 */
function createRecordingManager({ manager }) {
    /** @type {Array<{method: string, args: Record<string, unknown>}>} */
    const calls = [];
    return {
        calls,
        ensure: async (args) => {
            calls.push({ method: 'ensure', args: /** @type {Record<string, unknown>} */ (args) });
            return /** @type {Record<string, unknown>} */ (await manager.ensure(args));
        },
        beforeRun: (args) => {
            calls.push({ method: 'beforeRun', args: /** @type {Record<string, unknown>} */ (args) });
            return manager.beforeRun(args);
        },
        afterRun: (args) => {
            calls.push({ method: 'afterRun', args: /** @type {Record<string, unknown>} */ (args) });
            return manager.afterRun(args);
        },
        remove: (args) => {
            calls.push({ method: 'remove', args: /** @type {Record<string, unknown>} */ (args) });
            return manager.remove(args);
        },
        handleFor: (args) => {
            calls.push({ method: 'handleFor', args: /** @type {Record<string, unknown>} */ (args) });
            return manager.handleFor(args);
        }
    };
}

/**
 * @param {{id: string, identifier: string, state?: string}} arg0 -
 * @returns {Record<string, unknown>}
 */
function rawItem({ id, identifier, state = 'Todo' }) {
    return { id, identifier, title: identifier, state, dispatchable: true };
}

describe('scheduler workspace integration (IR-1)', {
    skip: GIT_AVAILABLE ? false : 'git is not available on PATH'
}, () => {
    /** @type {{base: string, repo: string}} */
    let fixture;

    before(async () => {
        const base = await mkdtemp(join(tmpdir(), 'merci-scheduler-workspace-'));
        const repo = join(base, 'repo');
        await createRepo({ dir: repo });
        fixture = { base, repo };
    });

    after(async () => {
        await rm(fixture.base, { recursive: true, force: true });
    });

    test('each attempt runs in its own worktree and terminal cleanup keeps only a dirty one', { timeout: 20000 }, async () => {
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: fixture.repo,
            root: join(fixture.base, 'worktrees'),
            eventEmitter: createEmitter()
        });
        const emitter = /** @type {CapturingEmitter} */ (manager.eventEmitter);
        const items = [
            rawItem({ id: 'id-A', identifier: 'MER-A' }),
            rawItem({ id: 'id-B', identifier: 'MER-B' })
        ];
        const ready = new Map([
            ['MER-A', deferredVoid()],
            ['MER-B', deferredVoid()]
        ]);
        /** @type {Array<{identifier: string, path: string}>} */
        const runs = [];
        /** @type {Array<{identifier: string, attempt: number, workspace: Record<string, unknown>}>} */
        const inputs = [];
        const workflow = {
            run: async (/** @type {{item: WorkItem, attempt: number, workspace: Record<string, unknown>|null, signal: AbortSignal}} */ input) => {
                const { item, attempt, signal } = input;
                const handle = /** @type {{path?: unknown}} */ (input.workspace);
                assert.equal(typeof handle.path, 'string', 'the workflow receives a workspace handle');
                const workspacePath = /** @type {string} */ (handle.path);
                runs.push({ identifier: item.identifier, path: workspacePath });
                inputs.push({ identifier: item.identifier, attempt, workspace: /** @type {Record<string, unknown>} */ (input.workspace) });

                const printed = spawnSync('pwd', [], { cwd: workspacePath, encoding: 'utf8' });
                assert.equal(printed.status, 0, `pwd ran in ${workspacePath}`);
                assert.equal(printed.stdout.trim(), await realpath(workspacePath), 'the process cwd is the workspace');

                const ownName = item.identifier === 'MER-A' ? 'agent-A.txt' : 'agent-B.txt';
                await writeFile(join(workspacePath, ownName), `${item.identifier}\n`);

                if (item.identifier === 'MER-A') {
                    runGit({ args: ['add', ownName], cwd: workspacePath });
                    runGit({
                        args: ['-c', 'user.name=Merci', '-c', 'user.email=merci@example.com', 'commit', '-m', 'agent write'],
                        cwd: workspacePath
                    });
                }

                const gate = /** @type {{resolve: () => void}} */ (ready.get(item.identifier));
                gate.resolve();
                await new Promise((resolve) => {
                    if (signal.aborted) {
                        resolve(undefined);
                        return;
                    }
                    signal.addEventListener('abort', () => resolve(undefined), { once: true });
                });
                return { status: 'canceled' };
            }
        };
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items, eventEmitter: emitter }),
            workflow,
            workspace: manager,
            eventEmitter: emitter,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            concurrency: { global: 2 },
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1 },
            pollIntervalMs: 60_000
        });
        try {
            await scheduler.start();
            await Promise.all([...ready.values()].map((entry) => entry.promise));

            const aPath = manager.pathFor({ workItemId: 'MER-A' });
            const bPath = manager.pathFor({ workItemId: 'MER-B' });
            assert.equal(runs.length, 2);

            // The manager emits its own events; the scheduler must run them
            // under the attempt's context, or the trace cannot join a workspace
            // to the dispatch that created it.
            const createdEntries = emitter.events.filter((entry) => entry.event === EVENTS.WORKSPACE.CREATED);
            const dispatchedEntries = emitter.events.filter((entry) => entry.event === EVENTS.WORK_ITEM.DISPATCHED);
            assert.equal(createdEntries.length, 2);
            for (const created of createdEntries) {
                const dispatched = dispatchedEntries.find((entry) => entry.identifier === created.workItemId);
                assert.ok(dispatched, 'every created workspace belongs to a dispatched item');
                assert.equal(created.runId, dispatched.runId, 'the workspace event joins the attempt run');
            }
            const aReal = await realpath(aPath);
            const bReal = await realpath(bPath);
            assert.notEqual(aReal, bReal, 'two items get two worktrees');
            assert.equal(await readFile(join(aPath, 'agent-A.txt'), 'utf8'), 'MER-A\n', 'A has its own file');
            assert.equal(await readFile(join(bPath, 'agent-B.txt'), 'utf8'), 'MER-B\n', 'B has its own file');
            assert.equal(await exists({ path: join(aPath, 'agent-B.txt') }), false, 'A never sees B\'s file');
            assert.equal(await exists({ path: join(bPath, 'agent-A.txt') }), false, 'B never sees A\'s file');
            assert.equal(await exists({ path: join(fixture.repo, 'agent-A.txt') }), false, 'the repo root sees neither file');
            assert.equal(await exists({ path: join(fixture.repo, 'agent-B.txt') }), false, 'the repo root sees neither file');

            for (const item of items) item.state = 'Done';
            await scheduler.tick();
            await waitFor({
                predicate: () => payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED }).length === 2,
                label: 'both terminal releases'
            });

            assert.equal(await exists({ path: aPath }), false, 'the committed workspace is removed');
            assert.equal(await exists({ path: bPath }), true, 'the dirty workspace is retained');

            const listed = await Promise.all(listWorktrees({ repo: fixture.repo }).map((path) => realpath(path)));
            assert.equal(listed.includes(aReal), false, 'the removed worktree is no longer listed');
            assert.equal(listed.includes(bReal), true, 'the retained worktree is still listed');
            assert.equal(listed.includes(await realpath(fixture.repo)), true, 'the repository root is listed');

            const refusals = payloads({ emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED });
            assert.equal(refusals.length, 1);
            assert.deepEqual(refusals[0], { workItemId: 'id-B', identifier: 'MER-B', reason: 'dirty' });
            assert.deepEqual(scheduler.snapshot().claimed, [], 'both claims are released');
            const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
            assert.deepEqual(released.map((entry) => entry.reason), ['terminal', 'terminal']);
        } finally {
            await scheduler.stop({ timeoutMs: 1_000 });
        }
    });

    test('startup cleanup removes a clean terminal workspace through the real handleFor', { timeout: 20000 }, async () => {
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: fixture.repo,
            root: join(fixture.base, 'startup-worktrees')
        });
        const workspace = await manager.ensure({ workItemId: 'MER-T' });
        assert.equal(await exists({ path: workspace.path }), true);

        const recorder = createRecordingManager({ manager });
        const emitter = createEmitter();
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({
                items: [rawItem({ id: 'id-T', identifier: 'MER-T', state: 'Done' })],
                eventEmitter: emitter
            }),
            workflow: {
                run: () => {
                    throw new Error('startup cleanup must not run a workflow');
                }
            },
            workspace: recorder,
            eventEmitter: emitter,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            pollIntervalMs: 60_000
        });
        try {
            await scheduler.start();
            const methods = recorder.calls.map((call) => call.method);
            assert.ok(methods.includes('handleFor'), 'startup cleanup used handleFor');
            assert.ok(methods.includes('remove'), 'startup cleanup removed the workspace');
            const removeCall = recorder.calls.find((call) => call.method === 'remove');
            assert.equal(removeCall?.args.force, false);
            assert.equal(await exists({ path: workspace.path }), false, 'the terminal workspace path is gone');
            assert.equal(payloads({ emitter, name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED }).length, 0);
            assert.deepEqual(scheduler.snapshot().claimed, []);
        } finally {
            await scheduler.stop({ timeoutMs: 1_000 });
        }
    });

    test('a retry fired for an item that became terminal removes its clean worktree', { timeout: 20000 }, async () => {
        const manager = new WorkspaceManager({
            strategy: WORKSPACE_STRATEGIES.GIT_WORKTREE,
            repoRoot: fixture.repo,
            root: join(fixture.base, 'retry-worktrees')
        });
        const emitter = createEmitter();
        const items = [rawItem({ id: 'id-R', identifier: 'MER-R' })];
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items, eventEmitter: emitter }),
            workflow: { run: async () => ({ status: 'failed' }) },
            workspace: manager,
            eventEmitter: emitter,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            continuation: { delayMs: 0, max: 0 },
            retry: { baseMs: 10, maxMs: 10 },
            limits: { maxAttemptsPerItem: 3 },
            pollIntervalMs: 60_000
        });
        try {
            await scheduler.start();
            await waitFor({
                predicate: () => scheduler.snapshot().retrying.length === 1,
                label: 'a queued retry'
            });
            const workspacePath = manager.pathFor({ workItemId: 'MER-R' });
            assert.equal(await exists({ path: workspacePath }), true, 'the failed attempt left a worktree');
            const workspaceReal = await realpath(workspacePath);

            items[0].state = 'Done';
            await new Promise((resolve) => setTimeout(resolve, 30));
            await scheduler.tick();
            await waitFor({
                predicate: () => payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED }).length === 1,
                label: 'the terminal retry release'
            });

            assert.equal(await exists({ path: workspacePath }), false, 'the clean terminal worktree is removed');
            const listed = await Promise.all(listWorktrees({ repo: fixture.repo }).map((path) => realpath(path)));
            assert.equal(listed.includes(workspaceReal), false, 'the removed worktree is no longer listed');
            const released = payloads({ emitter, name: EVENTS.WORK_ITEM.RELEASED });
            assert.equal(released[0].reason, 'terminal');
        } finally {
            await scheduler.stop({ timeoutMs: 1_000 });
        }
    });
});
