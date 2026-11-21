// @ts-check

/**
 * @file Stage 4 tests: `WorkflowPolicy` lifecycle, health, and snapshots (§5.5).
 * @version 0.12.0
 *
 * @description
 * `start()` is the one hard failure: it emits `load_failed`, leaves the policy
 * unstarted, and can be retried after a fix. `stop()` is final and idempotent
 * and never emits again; the effective prompt/config stay readable. `snapshot()`
 * is stable before start, and `preflight()` reports `not_started`, the live
 * reasons, `stopped`, or `[]` in that order of precedence.
 */
import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WORKFLOW_POLICY_DEFAULTS, WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

const STAMP_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const PROMPT_A = 'Prompt A: {{ issue.identifier }}';
const PROMPT_B = 'Prompt B: {{ issue.identifier }}';

/**
 * @param {{prompt?: string}} [arg0]
 * @returns {string}
 */
function workflow({ prompt = PROMPT_A } = {}) {
    return ['---', 'polling:', '  interval_ms: 30000', '---', prompt].join('\n');
}

/**
 * @returns {Promise<{dir: string, path: string}>}
 */
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-life-'));
    tempDirs.push(dir);
    return { dir, path: join(dir, 'WORKFLOW.md') };
}

/**
 * @param {{path: string, watch?: boolean, watchImpl?: import('../lib/agentic/workflow-policy/watch.mjs').WorkflowWatchFactory}} arg0
 */
function createPolicy({ path, watch = false, watchImpl }) {
    const emitter = new MerciEventEmitter();
    /** @type {Record<string, unknown>[]} */
    const events = [];
    /** @param {Record<string, unknown>} envelope */
    const collect = (envelope) => { events.push(envelope); };
    emitter.onAny(collect);
    const policy = new WorkflowPolicy({
        path,
        watch,
        eventEmitter: emitter,
        ...(watchImpl === undefined ? {} : { watchImpl })
    });
    return { policy, events };
}

/**
 * @param {{events: Record<string, unknown>[], name: string}} arg0
 * @returns {Record<string, unknown>[]}
 */
function emitted({ events, name }) {
    return events.filter((envelope) => envelope.event === name);
}

/**
 * @param {Record<string, unknown>} envelope
 * @returns {Record<string, unknown>}
 */
function payloadOf(envelope) {
    const payload = { ...envelope };
    for (const key of STAMP_KEYS) delete payload[key];
    return payload;
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<PolicyError>}
 */
async function asyncPolicyError(promise) {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the call to throw a PolicyError');
}

/**
 * @param {() => unknown} fn
 * @returns {PolicyError}
 */
function syncPolicyError(fn) {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the call to throw a PolicyError');
}

/**
 * @returns {{factory: import('../lib/agentic/workflow-policy/watch.mjs').WorkflowWatchFactory, isClosed: () => boolean}}
 */
function createFakeWatcher() {
    let closed = false;
    return {
        factory: () => ({
            on() { return undefined; },
            close() { closed = true; },
            unref() { return undefined; }
        }),
        isClosed: () => closed
    };
}

describe('workflow policy lifecycle', () => {
    it('starts, snapshots, emits loaded, and exposes a frozen config', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const { policy, events } = createPolicy({ path });
        try {
            await policy.start();

            const config = policy.getConfig();
            assert.ok(config !== null);
            assert.ok(Object.isFrozen(config));
            assert.ok(Object.isFrozen(config.tracker));
            assert.ok(Object.isFrozen(config.workspace));
            assert.equal(config.polling.intervalMs, 30_000);

            const snapshot = policy.snapshot();
            assert.equal(snapshot.started, true);
            assert.equal(snapshot.stopped, false);
            assert.equal(snapshot.healthy, true);
            assert.equal(snapshot.path, path);
            assert.equal(snapshot.source, 'startup');
            assert.equal(typeof snapshot.loadedAt, 'number');
            assert.equal(typeof snapshot.lastCheckedAt, 'number');
            assert.equal(snapshot.watch, 'disabled');
            const prompt = /** @type {{chars: number, hash: string}} */ (snapshot.prompt);
            assert.equal(prompt.chars, PROMPT_A.length);
            assert.match(prompt.hash, /^[0-9a-f]{12}$/);
            assert.deepEqual(snapshot.warnings, ['no_active_states']);
            assert.equal(snapshot.lastError, null);

            const loaded = emitted({ events, name: EVENTS.WORKFLOW_POLICY.LOADED });
            assert.equal(loaded.length, 1);
            assert.deepEqual(
                Object.keys(payloadOf(loaded[0])).sort(),
                ['path', 'promptChars', 'source', 'warnings']
            );
            assert.equal(payloadOf(loaded[0]).source, 'startup');
            assert.equal(payloadOf(loaded[0]).promptChars, PROMPT_A.length);
        } finally {
            policy.stop();
        }
    });

    it('rejects a second start with already_started', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const { policy } = createPolicy({ path });
        try {
            await policy.start();
            const error = await asyncPolicyError(policy.start());
            assert.equal(error.reason, 'already_started');
        } finally {
            policy.stop();
        }
    });

    it('fails the first start on a missing file, then succeeds after the fix', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        const { policy, events } = createPolicy({ path });
        try {
            const error = await asyncPolicyError(policy.start());
            assert.equal(error.reason, 'missing_workflow_file');
            assert.equal(policy.snapshot().started, false);
            assert.deepEqual(policy.preflight(), ['not_started']);
            const failed = emitted({ events, name: EVENTS.WORKFLOW_POLICY.LOAD_FAILED });
            assert.equal(failed.length, 1);
            assert.deepEqual(Object.keys(payloadOf(failed[0])).sort(), ['path', 'reasons']);
            const lastError = /** @type {{reasons: string[]}} */ (policy.snapshot().lastError);
            assert.deepEqual(lastError.reasons, ['missing_workflow_file']);

            await writeFile(path, workflow());
            await policy.start();
            assert.equal(policy.snapshot().started, true);
            assert.equal(policy.snapshot().healthy, true);
            assert.deepEqual(policy.preflight(), []);
            assert.equal(emitted({ events, name: EVENTS.WORKFLOW_POLICY.LOADED }).length, 1);
        } finally {
            policy.stop();
        }
    });

    it('fails the start on invalid YAML and emits load_failed', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, '---\ntracker:\n  kind: [unclosed\n---\n');
        const { policy, events } = createPolicy({ path });
        try {
            const error = await asyncPolicyError(policy.start());
            assert.equal(error.reason, 'workflow_parse_error');
            assert.equal(policy.snapshot().started, false);
            assert.equal(emitted({ events, name: EVENTS.WORKFLOW_POLICY.LOAD_FAILED }).length, 1);
        } finally {
            policy.stop();
        }
    });

    it('rejects reload before start with not_started', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const { policy } = createPolicy({ path });
        try {
            const error = await asyncPolicyError(policy.reload());
            assert.equal(error.reason, 'not_started');
        } finally {
            policy.stop();
        }
    });

    it('stops idempotently, even before start, and never emits again', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const { policy, events } = createPolicy({ path });

        policy.stop();
        policy.stop();
        const snapshot = policy.snapshot();
        assert.equal(snapshot.stopped, true);
        assert.equal(snapshot.started, false);
        assert.equal(snapshot.watch, 'stopped');
        const stoppedStart = await asyncPolicyError(policy.start());
        assert.equal(stoppedStart.reason, 'stopped');
        assert.equal(events.length, 0);
    });

    it('keeps the effective state readable after stop and emits nothing', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const fake = createFakeWatcher();
        const { policy, events } = createPolicy({ path, watch: true, watchImpl: fake.factory });
        try {
            await policy.start();
            assert.equal(fake.isClosed(), false);
            policy.stop();
            assert.equal(fake.isClosed(), true);
            events.length = 0;

            const stoppedReload = await asyncPolicyError(policy.reload());
            assert.equal(stoppedReload.reason, 'stopped');
            const stoppedStart = await asyncPolicyError(policy.start());
            assert.equal(stoppedStart.reason, 'stopped');
            assert.equal(policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt A: MERCI-1');
            const renderError = syncPolicyError(() => policy.renderPrompt({ issue: {} }));
            assert.equal(renderError.reason, 'template_render_error:issue.identifier');
            assert.equal(events.length, 0);
            assert.deepEqual(policy.preflight(), ['stopped']);
        } finally {
            policy.stop();
        }
    });

    it('reports preflight in all five states', { timeout: 5000 }, async () => {
        const { dir, path } = await tempDir();
        const before = new WorkflowPolicy({ path, watch: false });
        const missing = new WorkflowPolicy({ path, watch: false });
        try {
            assert.deepEqual(before.preflight(), ['not_started']);

            await asyncPolicyError(missing.start());
            assert.deepEqual(missing.preflight(), ['not_started']);
            missing.stop();
            assert.deepEqual(missing.preflight(), ['stopped']);

            await writeFile(path, workflow());
            const healthy = new WorkflowPolicy({ path, watch: false });
            try {
                await healthy.start();
                assert.deepEqual(healthy.preflight(), []);
                await writeFile(path, '---\ntracker:\n  kind: [broken\n---\n');
                const failed = await healthy.reload();
                assert.ok(failed.reasons.length > 0);
                assert.deepEqual(healthy.preflight(), failed.reasons);
            } finally {
                healthy.stop();
            }
        } finally {
            before.stop();
            missing.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('has a stable null snapshot before start', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        const { policy } = createPolicy({ path });
        try {
            const first = policy.snapshot();
            const second = policy.snapshot();
            assert.deepEqual(first, second);
            assert.equal(first.started, false);
            assert.equal(first.stopped, false);
            assert.equal(first.healthy, true);
            assert.equal(first.source, null);
            assert.equal(first.loadedAt, null);
            assert.equal(first.lastCheckedAt, null);
            assert.equal(first.config, null);
            assert.equal(first.prompt, null);
            assert.deepEqual(first.warnings, []);
            assert.equal(first.lastError, null);
            assert.equal(policy.getConfig(), null);
        } finally {
            policy.stop();
        }
    });

    it('swaps the effective prompt atomically on reload', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const { policy } = createPolicy({ path });
        try {
            await policy.start();
            const configBefore = policy.getConfig();
            const promptBefore = policy.renderPrompt({ issue: { identifier: 'MERCI-1' } });

            await writeFile(path, workflow({ prompt: PROMPT_B }));
            const result = await policy.reload();

            assert.equal(result.changed, true);
            assert.equal(promptBefore, 'Prompt A: MERCI-1');
            assert.equal(policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt B: MERCI-1');
            // The captured config is the old frozen object; the live one is new.
            assert.equal(configBefore === policy.getConfig(), false);
            assert.ok(configBefore !== null);
            assert.ok(policy.getConfig() !== null);
        } finally {
            policy.stop();
        }
    });

    it('resolves stop and leaves no watcher armed', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const fake = createFakeWatcher();
        const { policy } = createPolicy({ path, watch: true, watchImpl: fake.factory });
        await policy.start();
        await policy.stop();
        assert.equal(fake.isClosed(), true);
        assert.equal(policy.snapshot().watch, 'stopped');
    });

    it('copies snapshot warnings and lastError reasons away from policy state', { timeout: 5000 }, async () => {
        const { path } = await tempDir();
        await writeFile(path, workflow());
        const { policy } = createPolicy({ path });
        try {
            await policy.start();
            await writeFile(path, '---\ntracker:\n  kind: [unclosed\n---\n');
            const failed = await policy.reload();
            assert.equal(failed.healthy, false);

            const snapshot = policy.snapshot();
            /** @type {string[]} */ (snapshot.warnings).push('tampered_warning');
            /** @type {{reasons: string[]}} */ (snapshot.lastError).reasons.push('tampered_reason');

            assert.deepEqual(policy.preflight(), failed.reasons);
            const fresh = policy.snapshot();
            assert.equal(/** @type {string[]} */ (fresh.warnings).includes('tampered_warning'), false);
            assert.deepEqual(/** @type {{reasons: string[]}} */ (fresh.lastError).reasons, failed.reasons);
        } finally {
            policy.stop();
        }
    });

    it('renders the fallback for an empty body and the body when present', { timeout: 5000 }, async () => {
        const { dir, path } = await tempDir();
        await writeFile(path, '---\npolling:\n  interval_ms: 30000\n---\n');
        const fullPath = join(dir, 'WORKFLOW-B.md');
        await writeFile(fullPath, workflow());
        const empty = createPolicy({ path });
        const full = createPolicy({ path: fullPath });
        try {
            await empty.policy.start();
            assert.equal(
                empty.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }),
                WORKFLOW_POLICY_DEFAULTS.promptFallback
            );
            assert.ok(/** @type {string[]} */ (empty.policy.snapshot().warnings).includes('empty_prompt'));

            await full.policy.start();
            assert.equal(full.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt A: MERCI-1');
        } finally {
            empty.policy.stop();
            full.policy.stop();
        }
    });
});
