// @ts-check


/**
 * @file Reload recovery on an unchanged file, and a rejected apply that is
 * reported (F1-1, F1-4).
 * @version 0.12.0
 *
 * @description
 * A reload that fails while the file itself has not changed must heal on the
 * next read: the bytes then equal the last validated state, so no re-parse is
 * needed and the stored failure is stale. On the facade's watcher path a patch
 * the scheduler refuses has no caller to receive the throw; it is emitted as
 * `scheduler:internal_error { op: 'apply_config' }` and the operator ring
 * records it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrchestration } from '../lib/agentic/orchestration/facade.mjs';
import { WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import { createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';

const NOW = Date.parse('2026-11-11T10:00:00.000Z');

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A clock whose timers never fire, so no poll tick runs beside the test.
 * @returns {{now: () => number, setTimeout: () => number, clearTimeout: (handle: number) => void}}
 */
function createClock() {
    /** @type {Set<number>} */
    const timers = new Set();
    let next = 1;
    return {
        now: () => NOW,
        setTimeout: () => { const handle = next++; timers.add(handle); return handle; },
        clearTimeout: (handle) => { timers.delete(handle); }
    };
}

/**
 * A client whose sessions are stubs: no model call happens on an empty board.
 * @returns {{session: (model: string) => Record<string, unknown>}}
 */
function createClient() {
    return {
        session() {
            /** @type {Record<string, unknown>} */
            const session = {
                provider: 'openai',
                withSessionStore: () => session,
                withExecutionJournal: () => session,
                withTools: () => session,
                withBudget: () => session,
                withApproval: () => session,
                loadCheckpoint: async () => null,
                run: async () => 'done'
            };
            return session;
        }
    };
}

/**
 * @param {{root?: string, concurrency?: number}} [arg0]
 * @returns {string}
 */
function workflow({ root = undefined, concurrency = 1 } = {}) {
    return [
        '---',
        'tracker:',
        '  kind: memory',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        'polling:',
        '  interval_ms: 30000',
        ...(root === undefined ? [] : ['workspace:', `  root: ${JSON.stringify(root)}`]),
        'agent:',
        `  max_concurrent_agents: ${concurrency}`,
        'merci:',
        '  scheduler:',
        '    continuation_max: 0',
        '---',
        'Work on {{ issue.identifier }}.'
    ].join('\n');
}

/** @type {number} */
let mtimeClock = 1_700_000_000_000;

/**
 * @param {{path: string, markdown: string}} arg0
 * @returns {Promise<void>}
 */
async function rewrite({ path, markdown }) {
    await writeFile(path, markdown);
    mtimeClock += 10_000;
    const at = new Date(mtimeClock);
    await utimes(path, at, at);
}

/**
 * @param {{predicate: () => boolean, timeoutMs?: number}} arg0
 * @returns {Promise<void>}
 */
async function waitFor({ predicate, timeoutMs = 2_000 }) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not met in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('a failed reload heals when the same stat reads again', { timeout: 5000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-heal-'));
    tempDirs.push(dir);
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, workflow({ root: join(dir, 'ws') }));
    const emitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    emitter.onAny((/** @type {Record<string, unknown>} */ envelope) => events.push(envelope));
    const policy = new WorkflowPolicy({ path, watch: false, eventEmitter: emitter });
    try {
        await policy.start();
        assert.deepEqual(await policy.reload(), { changed: false, healthy: true, reasons: [] });

        // A read failure that leaves the file's stat untouched: the only way
        // back is the unchanged shortcut, which used to keep the error forever.
        await chmod(path, 0o000);
        assert.deepEqual(
            await policy.reload(),
            { changed: false, healthy: false, reasons: ['workflow_read_error'] }
        );
        events.length = 0;

        await chmod(path, 0o644);
        assert.deepEqual(await policy.reload(), { changed: false, healthy: true, reasons: [] });
        assert.deepEqual(policy.preflight(), []);
        assert.equal(policy.snapshot().healthy, true);

        const reloaded = events.filter((envelope) => envelope.event === EVENTS.WORKFLOW_POLICY.RELOADED);
        assert.equal(reloaded.length, 1, 'the heal is reported as an unchanged reload');
        assert.equal(reloaded[0].changed, false);
    } finally {
        await chmod(path, 0o644).catch(() => {});
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test('a same-stat rewrite to bad bytes does not heal a stored failure', { timeout: 5000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-heal-stat-'));
    tempDirs.push(dir);
    const path = join(dir, 'WORKFLOW.md');
    // A pinned mtime, restorable to the millisecond, so the trap is exact.
    const pinned = new Date(1_700_000_000_000);
    const good = workflow({ root: join(dir, 'ws') });
    await writeFile(path, good);
    await utimes(path, pinned, pinned);
    const policy = new WorkflowPolicy({ path, watch: false });
    try {
        await policy.start();
        const goodStat = await stat(path);
        const goodConfig = policy.getConfig();

        // A real failure whose stat differs, so the parse is what records it.
        await rewrite({ path, markdown: '---\npolling:\n  interval_ms: nope\n---\nwork' });
        const failed = await policy.reload();
        assert.equal(failed.healthy, false);
        assert.deepEqual(failed.reasons, ['invalid_config:polling.interval_ms']);

        // Same length, same inode, and the good mtime restored: the stat is
        // indistinguishable from the last good state, but the bytes are not.
        const bad = good.replace('30000', '3000x');
        assert.equal(Buffer.byteLength(bad), Buffer.byteLength(good), 'the fixture keeps the size');
        await writeFile(path, bad);
        await utimes(path, pinned, pinned);
        const badStat = await stat(path);
        assert.equal(badStat.ino, goodStat.ino);
        assert.equal(badStat.mtimeMs, goodStat.mtimeMs);
        assert.equal(badStat.size, goodStat.size);

        const stillBad = await policy.reload();
        assert.equal(stillBad.healthy, false, 'a stat match is not content proof');
        assert.deepEqual(stillBad.reasons, ['invalid_config:polling.interval_ms']);
        assert.equal(policy.getConfig(), goodConfig, 'the last-known-good config keeps serving');
        assert.deepEqual(policy.preflight(), ['invalid_config:polling.interval_ms']);

        // The genuine good bytes, with the same restored stat, do heal.
        await writeFile(path, good);
        await utimes(path, pinned, pinned);
        assert.deepEqual(await policy.reload(), { changed: false, healthy: true, reasons: [] });
        assert.deepEqual(policy.preflight(), []);
    } finally {
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test('an inverted retry pair is refused at load, keeping the last good config', { timeout: 5000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-heal-retry-'));
    tempDirs.push(dir);
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, workflow({ root: join(dir, 'ws'), concurrency: 1 }));
    const policy = new WorkflowPolicy({ path, watch: false });
    try {
        await policy.start();
        await rewrite({
            path,
            markdown: [
                '---',
                'agent:',
                '  max_retry_backoff_ms: 1000',
                'merci:',
                '  scheduler:',
                '    retry_base_ms: 60000',
                '---',
                'Work on {{ issue.identifier }}.'
            ].join('\n')
        });

        const result = await policy.reload();

        assert.equal(result.healthy, false);
        assert.deepEqual(result.reasons, ['invalid_config:scheduler.retry_base_ms']);
        assert.equal(policy.getConfig()?.scheduler.retryBaseMs, 10_000,
            'the last-known-good config keeps serving');
    } finally {
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test('a scheduler-rejected apply is reported on the watcher path', { timeout: 5000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-heal-facade-'));
    tempDirs.push(dir);
    const path = join(dir, 'WORKFLOW.md');
    const root = join(dir, 'ws');
    await writeFile(path, workflow({ root, concurrency: 1 }));
    const emitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    emitter.onAny((/** @type {Record<string, unknown>} */ envelope) => events.push(envelope));
    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        workflowFile: path,
        policyOptions: { watch: false },
        emitter,
        // No workspace manager, so the scheduler refuses `concurrency.global > 1`
        // while the policy accepts the same file.
        workspace: null,
        operator: true,
        scheduler: { clock: createClock() }
    });
    try {
        await orchestration.start();
        await rewrite({ path, markdown: workflow({ root, concurrency: 2 }) });
        // The built-in watcher calls `policy.reload()` itself; this is that
        // path (the facade's `reload()` holds the guard that skips the handler).
        await orchestration.policy.reload();

        await waitFor({
            predicate: () => events.some((envelope) => envelope.event === EVENTS.SCHEDULER.INTERNAL_ERROR)
        });
        const internal = events.filter((envelope) => envelope.event === EVENTS.SCHEDULER.INTERNAL_ERROR);
        assert.equal(internal.length, 1);
        assert.equal(internal[0].op, 'apply_config');
        assert.equal(internal[0].errorName, 'ConfigurationError');

        const ring = /** @type {{list: () => Array<Record<string, unknown>>}} */ (orchestration.ring);
        const recorded = ring.list().find((record) => record.event === EVENTS.SCHEDULER.INTERNAL_ERROR);
        assert.ok(recorded, 'the operator projection records the rejected apply');
        assert.equal(recorded.op, 'apply_config');
        assert.equal(recorded.errorName, 'ConfigurationError');
        assert.equal(orchestration.scheduler.snapshot().pollIntervalMs, 30_000,
            'the scheduler stayed on its last good config');
    } finally {
        await orchestration.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
