// @ts-check

/**
 * @file Stage 4 tests: reload, last-known-good, watcher, and `force` (§5.4).
 * @version 0.12.0
 *
 * @description
 * Reload is single-flight and atomic: an unchanged stat is a no-op, a valid
 * edit swaps the whole effective state, and a broken edit keeps the last good
 * config/prompt while `preflight()` blocks new work. The watcher is exercised
 * through an injected fake so the debounce and error path are deterministic;
 * one real-watch smoke test covers the platform watcher.
 */
import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { watch as fsWatch } from 'node:fs';
import { mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import { createWorkflowWatcher } from '../lib/agentic/workflow-policy/watch.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

/** Envelope keys the SDK stamps on every event; the rest is the payload. */
const STAMP_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const PROMPT_A = 'Prompt A: {{ issue.identifier }}';
const PROMPT_B = 'Prompt B: {{ issue.identifier }}';

/**
 * @param {{prompt?: string, intervalMs?: number}} [arg0]
 * @returns {string}
 */
function workflow({ prompt = PROMPT_A, intervalMs = 30_000 } = {}) {
    return ['---', 'polling:', `  interval_ms: ${intervalMs}`, '---', prompt].join('\n');
}

/** A deterministic, strictly increasing mtime so a rewrite never lands on the same stat. */
let mtimeClock = 1_700_000_000_000;

/**
 * @param {{path: string, markdown: string}} arg0
 */
async function rewrite({ path, markdown }) {
    await writeFile(path, markdown);
    mtimeClock += 10_000;
    const at = new Date(mtimeClock);
    await utimes(path, at, at);
}

/**
 * @param {{markdown: string, options?: import('../lib/agentic/workflow-policy/policy.mjs').WorkflowPolicyOptions}} arg0
 */
async function createFixture({ markdown, options = {} }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-reload-'));
    tempDirs.push(dir);
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, markdown);
    const emitter = new MerciEventEmitter();
    /** @type {Record<string, unknown>[]} */
    const events = [];
    /** @param {Record<string, unknown>} envelope */
    const collect = (envelope) => { events.push(envelope); };
    emitter.onAny(collect);
    const policy = new WorkflowPolicy({ path, watch: false, eventEmitter: emitter, ...options });
    return { dir, path, policy, events, emitter };
}

/**
 * @param {{dir: string, policy: WorkflowPolicy}} fixture
 */
async function dispose({ dir, policy }) {
    policy.stop();
    await rm(dir, { recursive: true, force: true });
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
 * @param {{predicate: () => boolean, timeoutMs?: number}} arg0
 */
async function waitFor({ predicate, timeoutMs = 1_000 }) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not met in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/**
 * @returns {{
 *   factory: import('../lib/agentic/workflow-policy/watch.mjs').WorkflowWatchFactory,
 *   emitChange: () => void,
 *   emitError: () => void,
 *   isClosed: () => boolean,
 *   armCount: () => number
 * }}
 */
function createFakeWatcher() {
    /** @type {Map<string, (...args: unknown[]) => void>} */
    const listeners = new Map();
    let closed = false;
    let arms = 0;
    return {
        factory: () => {
            arms += 1;
            return {
                on(event, listener) {
                    listeners.set(event, listener);
                    return undefined;
                },
                close() { closed = true; },
                unref() { return undefined; }
            };
        },
        emitChange() { listeners.get('change')?.('change', 'WORKFLOW.md'); },
        emitError() { listeners.get('error')?.(new Error('host failure that must not leak')); },
        isClosed: () => closed,
        armCount: () => arms
    };
}

describe('workflow policy reload', () => {
    it('no-ops without an event when the stat is unchanged', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;
            const configBefore = fixture.policy.getConfig();

            const result = await fixture.policy.reload();

            assert.deepEqual(result, { changed: false, healthy: true, reasons: [] });
            assert.equal(fixture.policy.getConfig(), configBefore);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 0);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOAD_FAILED }).length, 0);
        } finally {
            await dispose(fixture);
        }
    });

    it('applies a config-only change and keeps the prompt', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            const promptChars = /** @type {{chars: number}} */ (fixture.policy.snapshot().prompt).chars;
            await rewrite({ path: fixture.path, markdown: workflow({ intervalMs: 45_000 }) });

            const result = await fixture.policy.reload();

            assert.equal(result.changed, true);
            const config = fixture.policy.getConfig();
            assert.ok(config !== null);
            assert.equal(config.polling.intervalMs, 45_000);
            const snapshot = fixture.policy.snapshot();
            const prompt = /** @type {{chars: number}} */ (snapshot.prompt);
            assert.equal(prompt.chars, promptChars);
            const reloaded = emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED });
            assert.equal(reloaded.length, 1);
            assert.deepEqual(Object.keys(payloadOf(reloaded[0])).sort(), ['changed', 'path', 'promptChars']);
            assert.equal(payloadOf(reloaded[0]).changed, true);
        } finally {
            await dispose(fixture);
        }
    });

    it('applies a prompt-only change and keeps the config', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            const configBefore = fixture.policy.getConfig();
            await rewrite({ path: fixture.path, markdown: workflow({ prompt: PROMPT_B }) });

            const result = await fixture.policy.reload();

            assert.equal(result.changed, true);
            assert.deepEqual(fixture.policy.getConfig(), configBefore);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt B: MERCI-1');
        } finally {
            await dispose(fixture);
        }
    });

    it('keeps the last good state on broken YAML and recovers after a fix', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;
            const configBefore = fixture.policy.getConfig();
            await rewrite({ path: fixture.path, markdown: '---\ntracker:\n  kind: [unclosed\n---\nBroken' });

            const result = await fixture.policy.reload();

            assert.equal(result.changed, false);
            assert.equal(result.healthy, false);
            assert.equal(result.reasons[0], 'workflow_parse_error');
            assert.equal(fixture.policy.getConfig(), configBefore);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt A: MERCI-1');
            assert.deepEqual(fixture.policy.preflight(), result.reasons);
            const failed = emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOAD_FAILED });
            assert.equal(failed.length, 1);
            assert.deepEqual(Object.keys(payloadOf(failed[0])).sort(), ['path', 'reasons']);
            const snapshot = fixture.policy.snapshot();
            assert.equal(snapshot.healthy, false);
            const lastError = /** @type {{reasons: string[]}} */ (snapshot.lastError);
            assert.deepEqual(lastError.reasons, result.reasons);

            await rewrite({ path: fixture.path, markdown: workflow() });
            const fixed = await fixture.policy.reload();
            assert.equal(fixed.changed, true);
            assert.equal(fixed.healthy, true);
            assert.deepEqual(fixture.policy.preflight(), []);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 1);
        } finally {
            await dispose(fixture);
        }
    });

    it('keeps the last good state when the file is deleted', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            const configBefore = fixture.policy.getConfig();
            await rm(fixture.path);

            const result = await fixture.policy.reload();

            assert.equal(result.changed, false);
            assert.deepEqual(result.reasons, ['missing_workflow_file']);
            assert.equal(fixture.policy.getConfig(), configBefore);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt A: MERCI-1');
        } finally {
            await dispose(fixture);
        }
    });

    it('detects an atomic replace through a changed inode', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            const original = await stat(fixture.path);
            const tempPath = join(fixture.dir, 'next.md');
            await writeFile(tempPath, workflow({ prompt: PROMPT_B }));
            await utimes(tempPath, original.atime, original.mtime);
            await rename(tempPath, fixture.path);
            const replaced = await stat(fixture.path);
            assert.notEqual(replaced.ino, original.ino);

            const result = await fixture.policy.reload();

            assert.equal(result.changed, true);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt B: MERCI-1');
        } finally {
            await dispose(fixture);
        }
    });

    it('skips identical stats without force and rereads when forced', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            // A whole-second mtime round-trips exactly through `utimes`, so the
            // same-size rewrite below can reproduce the identical stat on purpose.
            await utimes(fixture.path, 1_700_000_000, 1_700_000_000);
            await fixture.policy.start();

            const unchanged = await fixture.policy.reload({ force: true });
            assert.equal(unchanged.changed, false);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 0);

            // Same inode, same size, same mtime, different text: the stat shortcut misses it.
            const current = await stat(fixture.path);
            await writeFile(fixture.path, workflow({ prompt: PROMPT_B }));
            await utimes(fixture.path, current.atime, current.mtime);
            const skipped = await fixture.policy.reload();
            assert.equal(skipped.changed, false);

            const forced = await fixture.policy.reload({ force: true });
            assert.equal(forced.changed, true);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt B: MERCI-1');
        } finally {
            await dispose(fixture);
        }
    });

    it('collapses a burst of watcher events into one reload', { timeout: 5000 }, async () => {
        const fake = createFakeWatcher();
        const fixture = await createFixture({
            markdown: workflow(),
            // A wide window keeps the 5-write burst inside one debounce even on a
            // loaded machine: the assertion is about collapsing, not about timing.
            options: { watch: true, debounceMs: 200, watchImpl: fake.factory }
        });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;
            for (let index = 0; index < 5; index += 1) {
                await rewrite({ path: fixture.path, markdown: workflow({ prompt: `Burst ${index}: {{ issue.identifier }}` }) });
                fake.emitChange();
            }
            await waitFor({ predicate: () => emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length > 0 });
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 1);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Burst 4: MERCI-1');
        } finally {
            await dispose(fixture);
        }
    });

    it('degrades on a watcher error without touching health and still reloads', { timeout: 5000 }, async () => {
        const fake = createFakeWatcher();
        const fixture = await createFixture({
            markdown: workflow(),
            options: { watch: true, debounceMs: 10, watchImpl: fake.factory }
        });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;

            fake.emitError();

            const snapshot = fixture.policy.snapshot();
            assert.equal(snapshot.healthy, true);
            assert.equal(snapshot.watch, 'failed');
            assert.ok(/** @type {string[]} */ (snapshot.warnings).includes('watch_failed'));
            const failed = emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.WATCH_FAILED });
            assert.equal(failed.length, 1);
            assert.deepEqual(Object.keys(payloadOf(failed[0])).sort(), ['path', 'reason']);
            assert.equal(payloadOf(failed[0]).reason, 'watch_failed');

            await rewrite({ path: fixture.path, markdown: workflow({ prompt: PROMPT_B }) });
            const result = await fixture.policy.reload();
            assert.equal(result.changed, true);
        } finally {
            await dispose(fixture);
        }
    });

    it('degrades when the watcher cannot be constructed', { timeout: 5000 }, async () => {
        const fixture = await createFixture({
            markdown: workflow(),
            options: {
                watch: true,
                watchImpl: () => { throw new Error('watch unavailable'); }
            }
        });
        try {
            await fixture.policy.start();
            const snapshot = fixture.policy.snapshot();
            assert.equal(snapshot.healthy, true);
            assert.equal(snapshot.watch, 'failed');
            assert.ok(/** @type {string[]} */ (snapshot.warnings).includes('watch_failed'));
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.WATCH_FAILED }).length, 1);
            assert.equal(fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }), 'Prompt A: MERCI-1');
        } finally {
            await dispose(fixture);
        }
    });

    it('reports a stop during an in-flight reload without swapping or emitting', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;
            const configBefore = fixture.policy.getConfig();
            await rewrite({ path: fixture.path, markdown: workflow({ prompt: PROMPT_B }) });

            const inflight = fixture.policy.reload();
            fixture.policy.stop();
            const result = await inflight;

            assert.deepEqual(result, { changed: false, healthy: false, reasons: ['stopped'] });
            assert.equal(fixture.policy.getConfig(), configBefore);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 0);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOAD_FAILED }).length, 0);
        } finally {
            await dispose(fixture);
        }
    });

    it('does not arm a watcher when watch is false', { timeout: 5000 }, async () => {
        const fake = createFakeWatcher();
        const fixture = await createFixture({
            markdown: workflow(),
            options: { watch: false, watchImpl: fake.factory }
        });
        try {
            await fixture.policy.start();
            assert.equal(fixture.policy.snapshot().watch, 'disabled');
            assert.equal(fake.armCount(), 0);

            await rewrite({ path: fixture.path, markdown: workflow({ prompt: PROMPT_B }) });
            const result = await fixture.policy.reload();
            assert.equal(result.changed, true);
        } finally {
            await dispose(fixture);
        }
    });

    it('reloads from a real fs.watch within the budget', { timeout: 15_000 }, async (t) => {
        if (typeof fsWatch !== 'function') {
            t.skip('fs.watch is not available on this platform');
            return;
        }
        const fixture = await createFixture({
            markdown: workflow(),
            options: { watch: true, debounceMs: 10 }
        });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;

            // `fs.watch` may coalesce or drop a single notification on a loaded
            // box, so the rewrite is retried; the assertion is that a real
            // watcher eventually reloads, not that one write is never lost.
            let observed = 0;
            let suffix = '';
            for (let attempt = 0; attempt < 3 && observed === 0; attempt += 1) {
                suffix = attempt === 0 ? '' : ` (${attempt})`;
                await rewrite({ path: fixture.path, markdown: workflow({ prompt: `${PROMPT_B}${suffix}` }) });
                try {
                    await waitFor({
                        predicate: () => emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length > 0,
                        timeoutMs: 3_000
                    });
                    observed = emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length;
                } catch {
                    // A missed notification is retried; the loop bound keeps it bounded.
                }
            }
            assert.ok(observed > 0, 'a real fs.watch reload reached the policy');
            assert.equal(
                fixture.policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }),
                `Prompt B: MERCI-1${suffix}`
            );
        } finally {
            await dispose(fixture);
        }
    });

    it('keeps the watch_failed warning across a successful reload', { timeout: 5000 }, async () => {
        const fake = createFakeWatcher();
        const fixture = await createFixture({
            markdown: workflow(),
            options: { watch: true, debounceMs: 10, watchImpl: fake.factory }
        });
        try {
            await fixture.policy.start();
            fake.emitError();
            await rewrite({ path: fixture.path, markdown: workflow({ prompt: PROMPT_B }) });

            const result = await fixture.policy.reload();

            assert.equal(result.changed, true);
            assert.equal(result.healthy, true);
            const snapshot = fixture.policy.snapshot();
            assert.equal(snapshot.watch, 'failed');
            assert.equal(snapshot.healthy, true);
            assert.ok(/** @type {string[]} */ (snapshot.warnings).includes('watch_failed'));
            assert.deepEqual(fixture.policy.preflight(), []);
        } finally {
            await dispose(fixture);
        }
    });

    it('emits a copy of the failure reasons that a listener cannot corrupt', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            /** @param {Record<string, unknown>} envelope */
            const tamper = (envelope) => {
                if (envelope.event === EVENTS.WORKFLOW_POLICY.RELOAD_FAILED) {
                    const reasons = /** @type {string[]} */ (envelope.reasons);
                    reasons.push('listener_mutation');
                }
            };
            fixture.emitter.onAny(tamper);
            await rewrite({ path: fixture.path, markdown: '---\ntracker:\n  kind: [unclosed\n---\nBroken' });

            const result = await fixture.policy.reload();

            assert.deepEqual(result.reasons, ['workflow_parse_error']);
            assert.deepEqual(fixture.policy.preflight(), ['workflow_parse_error']);
            const lastError = /** @type {{reasons: string[]}} */ (fixture.policy.snapshot().lastError);
            assert.deepEqual(lastError.reasons, ['workflow_parse_error']);
        } finally {
            await dispose(fixture);
        }
    });

    it('returns the stopped result when the read fails after stop', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            const configBefore = fixture.policy.getConfig();
            const healthBefore = fixture.policy.snapshot().healthy;
            fixture.events.length = 0;
            await rm(fixture.path);

            const inflight = fixture.policy.reload();
            fixture.policy.stop();
            const result = await inflight;

            assert.deepEqual(result, { changed: false, healthy: false, reasons: ['stopped'] });
            assert.equal(fixture.policy.getConfig(), configBefore);
            assert.equal(fixture.policy.snapshot().lastError, null);
            assert.equal(fixture.policy.snapshot().healthy, healthBefore);
            assert.equal(fixture.events.length, 0);
        } finally {
            await dispose(fixture);
        }
    });

    it('leaves started false when stop lands during start', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            const starting = fixture.policy.start();
            fixture.policy.stop();
            await starting;

            const snapshot = fixture.policy.snapshot();
            assert.equal(snapshot.started, false);
            assert.equal(snapshot.stopped, true);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.LOADED }).length, 0);
            assert.deepEqual(fixture.policy.preflight(), ['stopped']);
            await assert.rejects(
                fixture.policy.start(),
                (err) => err instanceof PolicyError && err.reason === 'stopped'
            );
        } finally {
            await dispose(fixture);
        }
    });

    it('adopts the fresh stat on a forced no-op so the next reload no-ops', { timeout: 5000 }, async () => {
        const fixture = await createFixture({ markdown: workflow() });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;
            // Same content, new stat: the force path compares the content hash.
            await rewrite({ path: fixture.path, markdown: workflow() });

            const forced = await fixture.policy.reload({ force: true });
            assert.equal(forced.changed, false);
            const plain = await fixture.policy.reload();
            assert.equal(plain.changed, false);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 0);
        } finally {
            await dispose(fixture);
        }
    });

    it('shares one read and one result between concurrent reloads', { timeout: 5000 }, async () => {
        /** Counts one `now()` per read attempt plus one per successful load. */
        let ticks = 0;
        const fixture = await createFixture({
            markdown: workflow(),
            options: { now: () => { ticks += 1; return 1_700_000_000_000 + ticks; } }
        });
        try {
            await fixture.policy.start();
            fixture.events.length = 0;
            await rewrite({ path: fixture.path, markdown: workflow({ prompt: PROMPT_B }) });
            ticks = 0;

            const [first, second] = await Promise.all([fixture.policy.reload(), fixture.policy.reload()]);

            assert.equal(first, second);
            assert.equal(ticks, 2);
            assert.equal(emitted({ events: fixture.events, name: EVENTS.WORKFLOW_POLICY.RELOADED }).length, 1);

            await rewrite({ path: fixture.path, markdown: workflow({ prompt: 'Prompt C: {{ issue.identifier }}' }) });
            const third = await fixture.policy.reload();
            assert.equal(third.changed, true);
            assert.equal(ticks, 4);
        } finally {
            await dispose(fixture);
        }
    });

    it('contains a throwing change consumer in the watcher error path', { timeout: 5000 }, async () => {
        /** @type {(...args: unknown[]) => void} */
        let changeListener = () => {};
        /** @type {import('../lib/agentic/workflow-policy/watch.mjs').WorkflowWatchEvent[]} */
        const received = [];
        const watcher = createWorkflowWatcher({
            path: join(tmpdir(), 'merci-wp-watch', 'WORKFLOW.md'),
            debounceMs: 1,
            watchImpl: () => ({
                on(event, listener) {
                    if (event === 'change') changeListener = listener;
                    return undefined;
                },
                close() { /* nothing to close */ },
                unref() { return undefined; }
            }),
            onEvent: (event) => {
                received.push(event);
                if (event.type === 'change') throw new Error('consumer failed');
            }
        });
        try {
            changeListener('change', 'WORKFLOW.md');
            await waitFor({ predicate: () => received.length > 1 });

            assert.deepEqual(received, [{ type: 'change' }, { type: 'error', reason: 'watch_failed' }]);
        } finally {
            watcher.close();
        }
    });
});
