// @ts-check


/**
 * @file The composition root: one call binds the four coordination primitives.
 * @version 0.12.0
 *
 * @description
 * These tests are about the **seams**, not the primitives: the order policy →
 * workspace/scheduler, one approval reaching both gates, the model never coming
 * from the file, a live reload applying only what changed, and the operator
 * exposing the policy health the scheduler obeys. Primitives have their own
 * suites; nothing here re-tests them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { createOrchestration, createItemTools } from '../lib/agentic/orchestration/facade.mjs';
import { WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import { createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { PolicyError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const NOW = Date.parse('2026-11-11T10:00:00.000Z');

/**
 * A clock whose timers never fire, so only an explicit `tick()` advances work.
 * @returns {{now: () => number, setTimeout: () => number, clearTimeout: (handle: number) => void, pending: () => number}}
 */
function createClock() {
    /** @type {Set<number>} */
    const timers = new Set();
    let next = 1;
    return {
        now: () => NOW,
        setTimeout: () => { const handle = next++; timers.add(handle); return handle; },
        clearTimeout: (handle) => { timers.delete(handle); },
        pending: () => timers.size
    };
}

/**
 * A client whose sessions are stubs: this file proves the wiring, and the
 * runner's own suite proves the engine adapter against `BaseChatSession`'s
 * method contract.
 * @param {{
 *   run?: () => Promise<string>,
 *   onTools?: ((tools: Array<Record<string, unknown>>) => void)|null,
 *   onApproval?: ((entry: Record<string, any>) => void)|null
 * }} [arg0]
 * @returns {{session: (model: string) => Record<string, unknown>, models: string[]}}
 */
function createClient({ run = async () => 'done', onTools = null, onApproval = null } = {}) {
    /** @type {string[]} */
    const models = [];
    return {
        models,
        session(model) {
            models.push(model);
            /** @type {(arg0: {tools: Array<Record<string, unknown>>}) => Record<string, unknown>} */
            const withTools = ({ tools }) => {
                onTools?.(tools);
                return session;
            };
            /** @type {(arg0: {fn: unknown, options: Record<string, unknown>}) => Record<string, unknown>} */
            const withApproval = ({ fn, options }) => {
                onApproval?.({ fn, options });
                return session;
            };
            /** @type {Record<string, unknown>} */
            const session = {
                provider: 'openai',
                _lastRunUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
                withSessionStore: () => session,
                withExecutionJournal: () => session,
                withTools,
                withBudget: () => session,
                withApproval,
                loadCheckpoint: async () => null,
                run
            };
            return session;
        }
    };
}

/**
 * A repo-owned contract that resolves to one active state and one item's worth
 * of settings.
 * @param {{intervalMs?: number, root: string, prompt?: string}} arg0
 * @returns {string}
 */
function workflowFile({ intervalMs = 30_000, root, prompt = 'Work on {{ issue.identifier }}.' }) {
    return [
        '---',
        'tracker:',
        '  kind: memory',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        'polling:',
        `  interval_ms: ${intervalMs}`,
        'workspace:',
        `  root: ${JSON.stringify(root)}`,
        'agent:',
        '  max_concurrent_agents: 1',
        'merci:',
        '  scheduler:',
        '    continuation_max: 0',
        '---',
        prompt
    ].join('\n');
}

/** One dispatchable row; the board is the host's, so the test owns the state. */
const ITEM = Object.freeze({
    id: 'wi-facade-1',
    identifier: 'MER-FACADE-1',
    title: 'Wire the layer',
    state: 'Todo',
    dispatchable: true,
    priority: 1
});

/**
 * Build a temp repo with a WORKFLOW.md and an isolated workspace root.
 * @param {{content?: string}} [arg0]
 * @returns {Promise<{dir: string, file: string, root: string, cleanup: () => Promise<void>}>}
 */
async function createRepo({ content = undefined } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-orchestration-'));
    const root = join(dir, 'workspaces');
    const file = join(dir, 'WORKFLOW.md');
    if (content !== undefined) {
        await writeFile(file, content);
    } else {
        await writeFile(file, workflowFile({ root }));
    }
    return {
        dir,
        file,
        root,
        cleanup: async () => { await rm(dir, { recursive: true, force: true }); }
    };
}

/**
 * Wait for the microtask queue and any settle continuation to drain.
 * @returns {Promise<void>}
 */
async function flush() {
    for (let index = 0; index < 12; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * Wait for real filesystem work (the workspace manager) to settle, not just
 * for microtasks. Fails the test rather than hanging.
 * @param {{predicate: () => boolean, timeoutMs?: number}} arg0
 * @returns {Promise<void>}
 */
async function waitFor({ predicate, timeoutMs = 5_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('createItemTools binds the shell only when an approval gate exists', async () => {
    const repo = await createRepo();
    try {
        const { WorkspaceManager } = await import('../lib/agentic/workspace/index.mjs');
        const workspace = await new WorkspaceManager({ root: repo.root }).ensure({ workItemId: 'MER-TOOLS' });

        const unguarded = createItemTools({ approval: null })({ item: ITEM, attempt: 1, workspace });
        assert.equal(unguarded.some((tool) => /** @type {{name?: string}} */ (tool).name === 'execute_shell_command'), false,
            'no approval callback means no shell tool');
        assert.ok(unguarded.length >= 3, 'the context and artifact tools are still bound');

        const guarded = createItemTools({ approval: () => true })({ item: ITEM, attempt: 1, workspace });
        assert.equal(guarded.some((tool) => /** @type {{name?: string}} */ (tool).name === 'execute_shell_command'), true,
            'one approval callback binds the shell tool');
        assert.equal(guarded.length, unguarded.length + 1);

        assert.deepEqual(createItemTools({ approval: () => true })({ item: ITEM, attempt: 1, workspace: null }), [],
            'no workspace means no tools');

        const objectShape = createItemTools({ approval: { fn: () => true } })({ item: ITEM, attempt: 1, workspace });
        assert.equal(objectShape.some((tool) => /** @type {{name?: string}} */ (tool).name === 'execute_shell_command'), true,
            'the builder shape is normalized, not dropped');
        assert.throws(
            () => createItemTools({ approval: /** @type {any} */ ({}) }),
            (error) => /** @type {{option?: string}} */ (error).option === 'approval',
            'an invalid shape must not silently drop the shell'
        );
    } finally {
        await repo.cleanup();
    }
});

test('one call wires policy, workspace, scheduler and operator around one board', async () => {
    const repo = await createRepo();
    const clock = createClock();
    const emitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    emitter.onAny((/** @type {Record<string, any>} */ envelope) => events.push(envelope));

    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [ITEM] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        emitter,
        operator: true,
        scheduler: { clock }
    });

    try {
        // The policy resolved first, and the scheduler inherited its settings.
        assert.equal(orchestration.policy.snapshot().started, true);
        assert.equal(orchestration.policy.snapshot().healthy, true);
        assert.equal(orchestration.scheduler.snapshot().pollIntervalMs, 30_000);
        assert.deepEqual(orchestration.scheduler.snapshot().activeStates, ['Todo']);
        assert.ok(orchestration.workspace, 'the workspace manager is built from the policy');
        assert.equal(typeof orchestration.handler, 'function');
        assert.ok(orchestration.ring, 'the operator ring is wired to the same emitter');

        await orchestration.start();
        await waitFor({ predicate: () => orchestration.scheduler.snapshot().completed.includes('MER-FACADE-1') });
        await flush();

        const snapshot = orchestration.scheduler.snapshot();
        assert.equal(snapshot.totals.dispatches, 1, 'exactly one engine attempt ran');
        assert.deepEqual(snapshot.completed, ['MER-FACADE-1'], 'the item completed and left the board');

        const created = events.find((event) => event.event === EVENTS.WORKSPACE.CREATED);
        const dispatched = events.find((event) => event.event === EVENTS.WORK_ITEM.DISPATCHED);
        assert.ok(created && dispatched, 'both the dispatch and the workspace creation were emitted');
        assert.ok(existsSync(/** @type {string} */ (created.path)), 'the item has its own directory');
        assert.equal(String(created.path).startsWith(realpathSync(repo.root)), true, 'the workspace root came from WORKFLOW.md');

        assert.equal(created.runId, dispatched.runId,
            'the workspace event is correlated with the attempt that created it');

        const counts = await orchestration.stop();
        assert.equal(counts.drained, true);
        assert.equal(orchestration.policy.snapshot().stopped, true, 'stop() also stops the policy');
    } finally {
        await repo.cleanup();
    }
});

test('a live reload applies what changed, keeps the last good config, and applies nothing twice', async () => {
    const repo = await createRepo();
    const clock = createClock();
    const emitter = new MerciEventEmitter();
    /** @type {string[]} */
    const configured = [];
    emitter.on(EVENTS.SCHEDULER.CONFIGURED, (/** @type {Record<string, any>} */ envelope) => {
        configured.push(/** @type {string[]} */ (envelope.changed).join(','));
    });

    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        emitter,
        scheduler: { clock }
    });

    try {
        await orchestration.start();

        await writeFile(repo.file, workflowFile({ intervalMs: 60_000, root: repo.root }));
        const changed = await orchestration.reload();
        assert.equal(changed.healthy, true);
        assert.equal(changed.changed, true);
        assert.equal(orchestration.scheduler.snapshot().pollIntervalMs, 60_000);
        assert.deepEqual(/** @type {Record<string, unknown>} */ (changed.applied).changed, ['pollIntervalMs'],
            'the prompt-only preflight closure is not reported as a change');
        assert.equal(configured.length, 1);

        const identical = await orchestration.reload();
        assert.equal(identical.changed, false);
        assert.equal(/** @type {Record<string, unknown>} */ (identical.applied).applied, false,
            'an identical reload applies nothing');
        assert.deepEqual(/** @type {Record<string, unknown>} */ (identical.applied).changed, []);
        assert.equal(configured.length, 1, 'and emits no second configured event');

        await writeFile(repo.file, '---\ntracker: [not-a-map\n---\nbroken');
        const broken = await orchestration.reload();
        assert.equal(broken.healthy, false);
        assert.equal(broken.applied, null);
        assert.ok(broken.reasons.length > 0, 'the reasons are reported, not swallowed');
        assert.equal(orchestration.scheduler.snapshot().pollIntervalMs, 60_000,
            'the last good config keeps serving');
        assert.deepEqual(orchestration.policy.preflight(), broken.reasons);
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('boot is strict and never takes the model from the contract', async () => {
    const missing = await createRepo({ content: '' });
    try {
        await assert.rejects(
            () => createOrchestration({
                client: createClient(),
                model: 'gpt-4o',
                workSource: createMemoryWorkSource({ items: [] }),
                workflowFile: join(missing.dir, 'absent.md'),
                policyOptions: { watch: false }
            }),
            (error) => error instanceof PolicyError && error.reasons.length > 0,
            'a WORKFLOW.md that cannot load fails the factory with its reasons'
        );
    } finally {
        await missing.cleanup();
    }

    const repo = await createRepo();
    try {
        await assert.rejects(
            () => createOrchestration({
                client: createClient(),
                model: '',
                workSource: createMemoryWorkSource({ items: [] }),
                workflowFile: repo.file
            }),
            (error) => /** @type {{option?: string}} */ (error).option === 'model',
            'the model is always the host\'s, never read from the file'
        );
    } finally {
        await repo.cleanup();
    }
});

test('the factory refuses a half-wired system', async () => {
    const repo = await createRepo();
    try {
        const base = {
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            workflowFile: repo.file,
            policyOptions: { watch: false }
        };
        await assert.rejects(() => createOrchestration(/** @type {any} */ ({ ...base, client: null })),
            (error) => /** @type {{option?: string}} */ (error).option === 'client');
        await assert.rejects(() => createOrchestration(/** @type {any} */ ({ ...base, workSource: {} })),
            (error) => /** @type {{option?: string}} */ (error).option === 'workSource');
        await assert.rejects(
            () => createOrchestration({ ...base, scheduler: { workflow: () => null } }),
            (error) => /** @type {{option?: string}} */ (error).option === 'scheduler',
            'the facade owns the four couplings; a pass-through may not replace one'
        );
        await assert.rejects(
            () => createOrchestration(/** @type {any} */ ({ ...base, emitter: new EventEmitter() })),
            (error) => /** @type {{option?: string}} */ (error).option === 'emitter',
            'the ring needs onAny(), so a bare EventEmitter is refused up front'
        );

        const orchestration = await createOrchestration(base);
        await assert.rejects(
            () => orchestration.listen(),
            (error) => /** @type {{option?: string}} */ (error).option === 'operator',
            'listen() without the operator is a configuration error, not a silent no-op'
        );
        await orchestration.stop();
    } finally {
        await repo.cleanup();
    }
});

test('the operator reports the policy health and the last tick outcome', async () => {
    const repo = await createRepo();
    const clock = createClock();
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        operator: true,
        scheduler: { clock }
    });

    /** @type {{server: import('node:http').Server, url: string}|null} */
    let server = null;
    try {
        await orchestration.start();
        const listening = await orchestration.listen();
        server = listening;

        const stateResponse = await fetch(`${listening.url}/api/v1/state`);
        assert.equal(stateResponse.status, 200);
        const state = /** @type {any} */ (await stateResponse.json());
        assert.equal(state.policy.healthy, true);
        assert.equal(state.policy.started, true);
        assert.deepEqual(state.policy.reasons, []);
        assert.equal(state.scheduler.lastOutcome, 'ok', 'the operator can tell an idle tick from a blocked one');

        await writeFile(repo.file, '---\ntracker: [not-a-map\n---\nbroken');
        await orchestration.reload();

        const broken = /** @type {any} */ (await (await fetch(`${listening.url}/api/v1/state`)).json());
        assert.equal(broken.policy.healthy, false);
        assert.ok(broken.policy.reasons.length > 0, 'the reason code reaches the operator');

        const page = await (await fetch(`${listening.url}/`)).text();
        assert.match(page, /Policy: failed/i, 'the text page says the policy is unhealthy');
        assert.ok(page.includes(broken.policy.reasons[0]), 'and names the first reason');

        const tickBefore = orchestration.scheduler.snapshot().tickCount;
        const refreshed = await fetch(`${listening.url}/api/v1/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: ''
        });
        assert.equal(refreshed.status, 202);
        assert.ok(orchestration.scheduler.snapshot().tickCount > tickBefore, 'refresh ticks the real scheduler');
    } finally {
        if (server !== null) await orchestration.close();
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('the built-in watcher applies a live edit without the host calling reload()', async () => {
    const repo = await createRepo();
    const clock = createClock();
    // macOS `fs.watch` returns before the stream is live, so an edit written
    // right after `start()` can land in the arming window and be dropped. The
    // seam replaces only event delivery: the real debounce and the real apply
    // path still run, and the event is delivered exactly once.
    /** @type {Array<(...args: unknown[]) => void>} */
    const changeListeners = [];
    const watchImpl = () => ({
        on: (/** @type {string} */ event, /** @type {(...args: unknown[]) => void} */ listener) => {
            if (event === 'change') changeListeners.push(listener);
        },
        close: () => {}
    });
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        // The shipped default. A host that never calls reload() must still get
        // the edit: the policy reloads itself, so gating on `changed` would
        // leave the scheduler on the old contract forever.
        policyOptions: { watch: true, debounceMs: 25, watchImpl },
        scheduler: { clock }
    });
    try {
        await orchestration.start();
        await writeFile(repo.file, workflowFile({ intervalMs: 60_000, root: repo.root }));
        assert.equal(changeListeners.length, 1, 'the watcher is armed for change events');
        changeListeners[0]('change', basename(repo.file));
        await waitFor({
            predicate: () => orchestration.scheduler.snapshot().pollIntervalMs === 60_000,
            timeoutMs: 2_000
        });
        assert.equal(orchestration.policy.snapshot().healthy, true);
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('an edit made before start() is applied by start(), not by a stale first tick', async () => {
    const repo = await createRepo();
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false }
    });
    try {
        await writeFile(repo.file, workflowFile({ intervalMs: 45_000, root: repo.root }));
        assert.equal((await orchestration.reload()).applied, null, 'nothing to apply before start');
        await orchestration.start();
        assert.equal(orchestration.scheduler.snapshot().pollIntervalMs, 45_000,
            'start() rebuilds from the current contract');
        assert.equal(orchestration.scheduler.snapshot().tickCount, 1, 'and still ticks once');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('a failed construction stops the policy it started, so no watcher survives', async () => {
    const repo = await createRepo({
        content: workflowFile({ root: '/tmp/merci-never-used' })
            .replace('merci:\n  scheduler:', 'merci:\n  engine:\n    kind: dag\n  scheduler:')
    });
    const emitter = new MerciEventEmitter();
    /** @type {string[]} */
    const names = [];
    emitter.onAny((/** @type {Record<string, any>} */ envelope) => names.push(String(envelope.event)));

    try {
        await assert.rejects(
            () => createOrchestration({
                client: createClient(),
                model: 'gpt-4o',
                workSource: createMemoryWorkSource({ items: [] }),
                workflowFile: repo.file,
                policyOptions: { watch: true, debounceMs: 25 },
                emitter
            }),
            (error) => /** @type {{option?: string}} */ (error).option === 'missing_plan',
            'dag needs planFor, so construction fails after the policy started'
        );
        assert.ok(names.includes('workflow_policy:loaded'), 'the policy did start before the failure');

        const before = names.length;
        await writeFile(repo.file, workflowFile({ intervalMs: 61_000, root: repo.root })
            .replace('merci:\n  scheduler:', 'merci:\n  engine:\n    kind: dag\n  scheduler:'));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(names.slice(before), [], 'no phantom reload from a leaked watcher');
    } finally {
        await repo.cleanup();
    }
});

test('a bad approval is refused before the policy starts, leaving no watcher', async () => {
    const repo = await createRepo();
    const emitter = new MerciEventEmitter();
    /** @type {string[]} */
    const names = [];
    emitter.onAny((/** @type {Record<string, any>} */ envelope) => names.push(String(envelope.event)));

    try {
        await assert.rejects(
            () => createOrchestration({
                client: createClient(),
                model: 'gpt-4o',
                workSource: createMemoryWorkSource({ items: [] }),
                workflowFile: repo.file,
                policyOptions: { watch: true, debounceMs: 25 },
                approval: /** @type {any} */ ({}),
                emitter
            }),
            (error) => /** @type {{option?: string}} */ (error).option === 'approval',
            'the published option is restored and validated before start'
        );
        assert.equal(names.includes(EVENTS.WORKFLOW_POLICY.LOADED), false, 'the policy never started');

        const before = names.length;
        await writeFile(repo.file, workflowFile({ intervalMs: 61_000, root: repo.root }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(names.slice(before), [], 'no phantom reload from an unstarted policy');
    } finally {
        await repo.cleanup();
    }
});

test('reload after stop answers stopped instead of throwing, and listen refuses', async () => {
    const repo = await createRepo();
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        operator: true,
        scheduler: { clock: createClock() }
    });
    try {
        await orchestration.start();
        await orchestration.listen();
        await orchestration.stop();

        const after = await orchestration.reload();
        assert.deepEqual(after, { changed: false, healthy: false, reasons: ['stopped'], applied: null });
        await assert.rejects(
            () => orchestration.listen(),
            (error) => /** @type {{option?: string}} */ (error).option === 'stopped',
            'a stopped system cannot come back to life on a new port'
        );
    } finally {
        await repo.cleanup();
    }
});

test('listen() owns one server: a second call closes the first', async () => {
    const repo = await createRepo();
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        operator: true,
        scheduler: { clock: createClock() }
    });
    try {
        await orchestration.start();
        const first = await orchestration.listen();
        const second = await orchestration.listen();
        assert.notEqual(first.url, second.url);
        await assert.rejects(() => fetch(`${first.url}/api/v1/state`), 'the first server is closed');
        assert.equal((await fetch(`${second.url}/api/v1/state`)).status, 200);
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('the facade refuses a host preflight and a shadowed runner option', async () => {
    const repo = await createRepo();
    try {
        const base = {
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            workflowFile: repo.file,
            policyOptions: { watch: false }
        };
        await assert.rejects(
            () => createOrchestration({ ...base, scheduler: { preflight: () => [] } }),
            (error) => /** @type {{option?: string}} */ (error).option === 'scheduler',
            'a host preflight would silently replace the policy gate'
        );
        await assert.rejects(
            () => createOrchestration({ ...base, runner: { model: 'someone-else' } }),
            (error) => /** @type {{option?: string}} */ (error).option === 'runner',
            "the model is the host's, passed once"
        );
    } finally {
        await repo.cleanup();
    }
});

test('an injected policy still reaches the ring through the facade emitter', async () => {
    const repo = await createRepo();
    const clock = createClock();
    const emitter = new MerciEventEmitter();
    const policy = new WorkflowPolicy({ path: repo.file, watch: false });
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        policy,
        emitter,
        operator: true,
        scheduler: { clock }
    });
    try {
        await orchestration.start();
        await writeFile(repo.file, '---\ntracker: [not-a-map\n---\nbroken');
        await orchestration.reload();
        assert.ok(orchestration.ring, 'the operator ring is wired');
        const records = orchestration.ring.list({});
        assert.ok(
            records.some((record) => record.event === EVENTS.WORKFLOW_POLICY.RELOAD_FAILED),
            'an injected policy must emit into the same ring as the scheduler'
        );
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('the facade ring can follow the old layer, and the default ring ignores it', async () => {
    const repo = await createRepo();
    const customEmitter = new MerciEventEmitter();
    const custom = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        emitter: customEmitter,
        ring: { prefixes: ['run:', 'session:', 'scheduler:'] },
        scheduler: { clock: createClock() }
    });
    try {
        customEmitter.emitSafe('run:end', { event: 'run:end', runId: 'run-1', sessionId: 'sess-1', ts: 1 });
        customEmitter.emitSafe('scheduler:tick', { event: 'scheduler:tick', runId: 'run-2', ts: 2 });
        const customRing = custom.ring;
        assert.ok(customRing, 'a ring option wires the ring without the HTTP handler');
        assert.deepEqual(customRing.list().map((record) => record.event), ['run:end', 'scheduler:tick']);
        assert.equal(customRing.list()[0].sessionId, 'sess-1');
    } finally {
        await custom.stop();
    }

    const defaultEmitter = new MerciEventEmitter();
    const defaults = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        emitter: defaultEmitter,
        operator: true,
        scheduler: { clock: createClock() }
    });
    try {
        defaultEmitter.emitSafe('run:end', { event: 'run:end', ts: 1 });
        defaultEmitter.emitSafe('scheduler:tick', { event: 'scheduler:tick', ts: 2 });
        const defaultRing = defaults.ring;
        assert.ok(defaultRing);
        assert.deepEqual(defaultRing.list().map((record) => record.event), ['scheduler:tick'],
            'the default prefixes do not change');
    } finally {
        await defaults.stop();
        await repo.cleanup();
    }
});

test('the facade ring honours ring.limit', async () => {
    const repo = await createRepo();
    const emitter = new MerciEventEmitter();
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        emitter,
        ring: { limit: 5 },
        scheduler: { clock: createClock() }
    });
    try {
        for (let index = 1; index <= 7; index += 1) {
            emitter.emitSafe('scheduler:tick', { event: 'scheduler:tick', ts: index });
        }
        const ring = orchestration.ring;
        assert.ok(ring);
        assert.deepEqual(ring.list().map((record) => record.at), [3, 4, 5, 6, 7]);
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('an invalid ring option is refused, leaving no policy watcher', async () => {
    const repo = await createRepo();
    const emitter = new MerciEventEmitter();
    /** @type {string[]} */
    const names = [];
    emitter.onAny((/** @type {Record<string, any>} */ envelope) => names.push(String(envelope.event)));

    try {
        await assert.rejects(
            () => createOrchestration({
                client: createClient(),
                model: 'gpt-4o',
                workSource: createMemoryWorkSource({ items: [] }),
                workflowFile: repo.file,
                policyOptions: { watch: true, debounceMs: 25 },
                ring: { prefixes: [] },
                emitter
            }),
            (error) => /** @type {{option?: string}} */ (error).option === 'invalid_prefixes',
            'createEventRing validates the published option'
        );
        assert.ok(names.includes(EVENTS.WORKFLOW_POLICY.LOADED), 'the policy started before the ring was built');

        const before = names.length;
        await writeFile(repo.file, workflowFile({ intervalMs: 61_000, root: repo.root }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(names.slice(before), [], 'no phantom reload from a leaked watcher');
    } finally {
        await repo.cleanup();
    }
});

test('the facade refuses a malformed ring option', async () => {
    const repo = await createRepo();
    const emitter = new MerciEventEmitter();
    /** @type {string[]} */
    const names = [];
    emitter.onAny((/** @type {Record<string, any>} */ envelope) => names.push(String(envelope.event)));

    try {
        const base = {
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            workflowFile: repo.file,
            policyOptions: { watch: false },
            emitter
        };
        for (const ring of /** @type {Array<unknown>} */ ([
            true, 'x', [], null, { prefix: ['run:'] }
        ])) {
            await assert.rejects(
                () => createOrchestration(/** @type {any} */ ({ ...base, ring })),
                (error) => /** @type {{option?: string}} */ (error).option === 'ring',
                `ring ${JSON.stringify(ring)} must be refused`
            );
        }
        assert.deepEqual(names, [], 'a malformed ring is refused before the policy starts');
    } finally {
        await repo.cleanup();
    }
});

test('a construction failure after the ring is built unsubscribes it', async () => {
    const repo = await createRepo();
    const emitter = new MerciEventEmitter();
    try {
        await assert.rejects(
            () => createOrchestration({
                client: createClient(),
                model: 'gpt-4o',
                workSource: createMemoryWorkSource({ items: [] }),
                workflowFile: repo.file,
                policyOptions: { watch: false },
                emitter,
                ring: { limit: 5 },
                operator: { basePath: 'bad' }
            }),
            (error) => /** @type {{option?: string}} */ (error).option === 'invalid_base_path',
            'the handler is built after the ring'
        );
        assert.equal(emitter.listenerCount(), 0, 'the failed ring must not keep a listener');
    } finally {
        await repo.cleanup();
    }
});

test('operator.ringLimit is the fallback and ring.limit wins', async () => {
    const repo = await createRepo();
    try {
        const legacyEmitter = new MerciEventEmitter();
        const legacy = await createOrchestration({
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            workflowFile: repo.file,
            policyOptions: { watch: false },
            emitter: legacyEmitter,
            operator: { ringLimit: 2 },
            scheduler: { clock: createClock() }
        });
        try {
            for (let index = 1; index <= 8; index += 1) {
                legacyEmitter.emitSafe('scheduler:tick', { event: 'scheduler:tick', ts: index });
            }
            const ring = legacy.ring;
            assert.ok(ring);
            assert.deepEqual(ring.list().map((record) => record.at), [7, 8]);
        } finally {
            await legacy.stop();
        }

        const overrideEmitter = new MerciEventEmitter();
        const override = await createOrchestration({
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            workflowFile: repo.file,
            policyOptions: { watch: false },
            emitter: overrideEmitter,
            operator: { ringLimit: 2 },
            ring: { limit: 3 },
            scheduler: { clock: createClock() }
        });
        try {
            for (let index = 1; index <= 8; index += 1) {
                overrideEmitter.emitSafe('scheduler:tick', { event: 'scheduler:tick', ts: index });
            }
            const ring = override.ring;
            assert.ok(ring);
            assert.deepEqual(ring.list().map((record) => record.at), [6, 7, 8]);
        } finally {
            await override.stop();
        }
    } finally {
        await repo.cleanup();
    }
});

test('an approval given as { callback } still binds the shell gate', async () => {
    const repo = await createRepo();
    const clock = createClock();
    /** @type {Array<Array<Record<string, unknown>>>} */
    const captured = [];
    const orchestration = await createOrchestration({
        client: createClient({ onTools: (tools) => captured.push(tools) }),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [ITEM] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        approval: { callback: () => false },
        scheduler: { clock }
    });
    try {
        await orchestration.start();
        await waitFor({ predicate: () => captured.length > 0 });
        const names = captured[0].map((tool) => tool.name);
        assert.ok(names.includes('execute_shell_command'),
            'the object form is normalized, so the shell gate is not silently lost');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('{ fn, options } reaches both gates with the same function instance', async () => {
    const repo = await createRepo();
    const clock = createClock();
    /** @type {Array<Array<Record<string, unknown>>>} */
    const captured = [];
    /** @type {Array<Record<string, any>>} */
    const approvals = [];
    /** @type {Array<Array<unknown>>} */
    const calls = [];
    /** @param {...unknown} args */
    const callback = (...args) => {
        calls.push(args);
        return false;
    };
    const orchestration = await createOrchestration({
        client: createClient({
            onTools: (tools) => captured.push(tools),
            onApproval: (entry) => {
                approvals.push(entry);
                entry.fn('gated_tool', {}, {});
            }
        }),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [ITEM] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        approval: { fn: callback, options: { timeoutMs: 250 } },
        scheduler: { clock }
    });
    try {
        await orchestration.start();
        await waitFor({ predicate: () => captured.length > 0 && approvals.length > 0 });

        assert.equal(approvals[0].fn, callback, 'the documented builder shape reaches the session gate');
        assert.equal(approvals[0].options.timeoutMs, 250);
        assert.ok(calls.some((args) => args[0] === 'gated_tool'), 'the session gate calls the same callback');

        const shell = /** @type {{name?: string, execute: (arg0: {args: Record<string, unknown>}) => Promise<Record<string, unknown>>}}|undefined} */ (
            captured[0].find((tool) => /** @type {{name?: string}} */ (tool).name === 'execute_shell_command')
        );
        assert.ok(shell, 'the same approval binds the workspace shell gate');
        const result = await shell.execute({ args: { command: 'cat', args: ['/etc/hosts'] } });
        assert.equal(result.success, false);
        assert.equal(calls.filter((args) => args[0] === 'cat').length, 1, 'a gated shell command calls the same callback');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('permissionMode: bypassPermissions lets the workspace shell run without asking', async () => {
    const repo = await createRepo();
    const clock = createClock();
    /** @type {Array<Array<Record<string, unknown>>>} */
    const captured = [];
    let asked = 0;
    const orchestration = await createOrchestration({
        client: createClient({ onTools: (tools) => captured.push(tools) }),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [ITEM] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        approval: () => { asked += 1; return false; },
        permissionMode: 'bypassPermissions',
        scheduler: { clock }
    });
    try {
        await orchestration.start();
        await waitFor({ predicate: () => captured.length > 0 });
        const shell = /** @type {{name?: string, execute: (arg0: {args: Record<string, unknown>}) => Promise<Record<string, unknown>>}}|undefined} */ (
            captured[0].find((tool) => /** @type {{name?: string}} */ (tool).name === 'execute_shell_command')
        );
        assert.ok(shell);
        const result = await shell.execute({ args: { command: 'cat', args: ['/etc/hosts'] } });
        assert.equal(result.success, true, 'the gated command runs under the explicit bypass');
        assert.equal(asked, 0, 'the shell gate does not ask under bypassPermissions');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('the one approval keeps the session gate timeout', async () => {
    const repo = await createRepo();
    const clock = createClock();
    /** @type {Array<Record<string, any>>} */
    const approvals = [];
    const orchestration = await createOrchestration({
        client: createClient({ onApproval: (entry) => approvals.push(entry) }),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [ITEM] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        approval: { callback: () => false, timeoutMs: 5_000 },
        scheduler: { clock }
    });
    try {
        await orchestration.start();
        await waitFor({ predicate: () => approvals.length > 0 });
        assert.equal(approvals[0].options.timeoutMs, 5_000,
            'the object form keeps the session timeout; the shell gate has none');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('host scheduler caps survive a reload of an unchanged file (F1-2)', async () => {
    const repo = await createRepo();
    const clock = createClock();
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        emitter: new MerciEventEmitter(),
        scheduler: {
            clock,
            limits: { maxAttemptsPerItem: 2, maxTotalUsd: 1, maxDispatches: 10 },
            activeStates: ['Todo'],
        },
    });

    try {
        await orchestration.start();
        assert.equal(orchestration.scheduler.snapshot().limits.maxTotalUsd, 1, 'the host cap is in force at start');

        const reloaded = await orchestration.reload();
        assert.equal(reloaded.healthy, true);

        const snapshot = orchestration.scheduler.snapshot();
        assert.equal(snapshot.limits.maxTotalUsd, 1, 'a spend cap set in code must survive the file reload');
        assert.equal(snapshot.limits.maxDispatches, 10);
        assert.equal(snapshot.limits.maxAttemptsPerItem, 2);
        assert.deepEqual(snapshot.activeStates, ['Todo'], 'a host selector survives too');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});

test('a partial host limits override survives the reload instead of rejecting the patch (F1-2)', async () => {
    const repo = await createRepo();
    const clock = createClock();
    // The shape `docs/ORCHESTRATION.md` shows: the host names the caps it cares
    // about and leaves the rest to the file. A shallow merge replaced the whole
    // mapped `limits`, so the patch lost `maxAttemptsPerItem` and `applyConfig`
    // refused every reload — including the watcher path.
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: repo.file,
        policyOptions: { watch: false },
        scheduler: { clock, limits: { maxTotalUsd: 1, maxDispatches: 10 } },
    });

    try {
        await orchestration.start();
        const reloaded = await orchestration.reload();
        assert.equal(reloaded.healthy, true, 'the unchanged file is healthy');
        assert.notEqual(reloaded.applied, null, 'the patch is applied, not rejected');

        const snapshot = orchestration.scheduler.snapshot();
        assert.equal(snapshot.limits.maxTotalUsd, 1, 'the host cap is kept');
        assert.equal(snapshot.limits.maxDispatches, 10, 'the host dispatch cap is kept');
        assert.equal(snapshot.limits.maxAttemptsPerItem, 5, 'the file value fills the key the host omitted');
    } finally {
        await orchestration.stop();
        await repo.cleanup();
    }
});
