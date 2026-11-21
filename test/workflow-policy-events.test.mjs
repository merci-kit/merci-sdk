// @ts-check

/**
 * @file Stage 4 tests: `EVENTS.WORKFLOW_POLICY` payloads and redaction (§5.7).
 * @version 0.12.0
 *
 * @description
 * All six events are emitted with exactly their documented payload keys. No
 * payload, and no `snapshot()`, carries prompt text, a hook script, a provider
 * value, file content, or `err.message`; the hostile fixture puts a distinct
 * `SECRET_...` token in each place so a leak is unambiguous.
 */
import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    WORKFLOW_POLICY_REASONS,
    WORKFLOW_POLICY_WARNINGS,
    WorkflowPolicy
} from '../lib/agentic/workflow-policy/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

const STAMP_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const SECRET_PROMPT = 'Work on {{ issue.identifier }} with SECRET_PROMPT_TEXT';
const SECRET_HOOK = 'echo SECRET_HOOK_SCRIPT';
const SECRET_PROVIDER = 'SECRET_PROVIDER_VALUE';

/** @type {string} */
const HOSTILE = [
    '---',
    'tracker:',
    '  kind: linear',
    '  provider:',
    '    token: "$WP_SECRET_TOKEN"',
    'hooks:',
    '  after_create: |',
    `    ${SECRET_HOOK}`,
    '---',
    SECRET_PROMPT
].join('\n');

/**
 * @param {{path: string, options?: import('../lib/agentic/workflow-policy/policy.mjs').WorkflowPolicyOptions}} arg0
 */
function createPolicy({ path, options = {} }) {
    const emitter = new MerciEventEmitter();
    /** @type {Record<string, unknown>[]} */
    const events = [];
    /** @param {Record<string, unknown>} envelope */
    const collect = (envelope) => { events.push(envelope); };
    emitter.onAny(collect);
    const policy = new WorkflowPolicy({ path, watch: false, eventEmitter: emitter, ...options });
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
 * @returns {{
 *   factory: import('../lib/agentic/workflow-policy/watch.mjs').WorkflowWatchFactory,
 *   emitError: () => void
 * }}
 */
function createFakeWatcher() {
    /** @type {Map<string, (...args: unknown[]) => void>} */
    const listeners = new Map();
    return {
        factory: () => ({
            on(event, listener) {
                listeners.set(event, listener);
                return undefined;
            },
            close() { /* nothing to close */ },
            unref() { return undefined; }
        }),
        emitError() { listeners.get('error')?.(new Error('must not leak')); }
    };
}

/**
 * @param {Record<string, unknown>|null} config
 * @returns {Record<string, unknown>}
 */
function configOf(config) {
    assert.ok(config !== null);
    return config;
}

describe('workflow policy events', () => {
    it('emits all six events with the documented payload keys', { timeout: 5000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'merci-wp-events-'));
        tempDirs.push(dir);
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, HOSTILE);

        const emitter = new MerciEventEmitter();
        /** @type {Record<string, unknown>[]} */
        const events = [];
        /** @param {Record<string, unknown>} envelope */
        const collect = (envelope) => { events.push(envelope); };
        emitter.onAny(collect);
        const env = { WP_SECRET_TOKEN: SECRET_PROVIDER };
        const policy = new WorkflowPolicy({ path, watch: false, eventEmitter: emitter, env });
        const fake = createFakeWatcher();
        const watched = new WorkflowPolicy({
            path,
            watch: true,
            debounceMs: 10,
            watchImpl: fake.factory,
            eventEmitter: emitter,
            env
        });
        const missing = new WorkflowPolicy({ path: join(dir, 'missing.md'), watch: false, eventEmitter: emitter });
        try {
            await policy.start();
            assert.ok(policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }).includes('SECRET_PROMPT_TEXT'));

            await writeFile(path, HOSTILE.replace('Work on', 'Work at'));
            const reloaded = await policy.reload();
            assert.equal(reloaded.changed, true);

            assert.throws(() => policy.renderPrompt({ issue: {} }), PolicyError);

            await writeFile(path, '---\ntracker:\n  kind: [broken\n---\n');
            const failed = await policy.reload();
            assert.equal(failed.healthy, false);
            await writeFile(path, HOSTILE);
            const fixed = await policy.reload();
            assert.equal(fixed.healthy, true);

            await watched.start();
            fake.emitError();
            watched.stop();

            const loadError = await asyncPolicyError(missing.start());
            assert.equal(loadError.reason, 'missing_workflow_file');

            /** @type {Record<string, string[]>} */
            const expected = {
                [EVENTS.WORKFLOW_POLICY.LOADED]: ['path', 'promptChars', 'source', 'warnings'],
                [EVENTS.WORKFLOW_POLICY.RELOADED]: ['changed', 'path', 'promptChars'],
                [EVENTS.WORKFLOW_POLICY.RELOAD_FAILED]: ['path', 'reasons'],
                [EVENTS.WORKFLOW_POLICY.LOAD_FAILED]: ['path', 'reasons'],
                [EVENTS.WORKFLOW_POLICY.WATCH_FAILED]: ['path', 'reason'],
                [EVENTS.WORKFLOW_POLICY.RENDER_FAILED]: ['field', 'reason']
            };
            for (const [name, keys] of Object.entries(expected)) {
                const found = emitted({ events, name });
                assert.ok(found.length >= 1, `${name} was not emitted`);
                for (const envelope of found) {
                    assert.deepEqual(Object.keys(payloadOf(envelope)).sort(), keys);
                }
            }
        } finally {
            policy.stop();
            watched.stop();
            missing.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('keeps secrets out of every payload and the snapshot', { timeout: 5000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'merci-wp-secrets-'));
        tempDirs.push(dir);
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, HOSTILE);
        const { policy, events } = createPolicy({
            path,
            options: { env: { WP_SECRET_TOKEN: SECRET_PROVIDER } }
        });
        try {
            await policy.start();
            assert.ok(policy.renderPrompt({ issue: { identifier: 'MERCI-1' } }).includes('SECRET_PROMPT_TEXT'));
            await writeFile(path, HOSTILE.replace('Work on', 'Work on'));
            await policy.reload();
            await assert.rejects(async () => policy.renderPrompt({ issue: {} }));

            const serializedEvents = JSON.stringify(events);
            for (const secret of ['SECRET_PROMPT_TEXT', 'SECRET_HOOK_SCRIPT', SECRET_PROVIDER]) {
                assert.equal(serializedEvents.includes(secret), false, `event payload leaked ${secret}`);
            }

            const snapshot = policy.snapshot();
            const serializedSnapshot = JSON.stringify(snapshot);
            for (const secret of ['SECRET_PROMPT_TEXT', 'SECRET_HOOK_SCRIPT', SECRET_PROVIDER]) {
                assert.equal(serializedSnapshot.includes(secret), false, `snapshot leaked ${secret}`);
            }

            const config = configOf(/** @type {Record<string, unknown>|null} */ (snapshot.config));
            const tracker = /** @type {Record<string, unknown>} */ (config.tracker);
            assert.deepEqual(tracker.provider, { redacted: true, keys: ['token'] });
            const hooks = /** @type {Record<string, unknown>} */ (config.hooks);
            assert.equal(hooks.afterCreate, true);
            assert.equal(hooks.beforeRun, false);
            assert.equal(hooks.afterRun, false);
            assert.equal(hooks.beforeRemove, false);
            assert.equal(typeof hooks.timeoutMs, 'number');
        } finally {
            policy.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('names every event from the registry and covers each reason code', { timeout: 5000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'merci-wp-codes-'));
        tempDirs.push(dir);
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, HOSTILE);
        const { policy, events } = createPolicy({
            path,
            options: { env: { WP_SECRET_TOKEN: SECRET_PROVIDER } }
        });
        try {
            await policy.start();
            await writeFile(path, '---\ntracker:\n  kind: [broken\n---\n');
            await policy.reload();
            await assert.rejects(async () => policy.renderPrompt({ issue: {} }));

            const registry = new Set(Object.values(EVENTS.WORKFLOW_POLICY));
            assert.equal(registry.size, 6);
            for (const envelope of events) {
                assert.equal(typeof envelope.event, 'string');
                assert.ok(registry.has(/** @type {string} */ (envelope.event)));
            }

            let checked = 0;
            for (const envelope of events) {
                if (envelope.event === EVENTS.WORKFLOW_POLICY.RELOAD_FAILED
                    || envelope.event === EVENTS.WORKFLOW_POLICY.LOAD_FAILED) {
                    for (const reason of /** @type {string[]} */ (envelope.reasons)) {
                        assert.ok(WORKFLOW_POLICY_REASONS.includes(reason.split(':')[0]), reason);
                        checked += 1;
                    }
                }
                if (envelope.event === EVENTS.WORKFLOW_POLICY.WATCH_FAILED) {
                    assert.ok(WORKFLOW_POLICY_WARNINGS.includes(/** @type {string} */ (envelope.reason)));
                    checked += 1;
                }
                if (envelope.event === EVENTS.WORKFLOW_POLICY.RENDER_FAILED) {
                    assert.ok(WORKFLOW_POLICY_REASONS.includes(/** @type {string} */ (envelope.reason)));
                    checked += 1;
                }
                if (envelope.event === EVENTS.WORKFLOW_POLICY.LOADED) {
                    for (const warning of /** @type {string[]} */ (envelope.warnings)) {
                        assert.ok(WORKFLOW_POLICY_WARNINGS.includes(warning.split(':')[0]), warning);
                        checked += 1;
                    }
                }
            }
            assert.ok(checked > 0, 'no reason or warning code was checked');
        } finally {
            policy.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
