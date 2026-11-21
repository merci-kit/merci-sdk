// @ts-check

/**
 * @file Stage 5 tests: policy → scheduler/workspace options and the renderer (§5.6).
 * @version 0.12.0
 *
 * @description
 * The integration helpers are pure mappings plus one callback. The emitted
 * scheduler shape is validated with the scheduler's own
 * `validateSchedulerConfig`, the workspace shape is pinned key by key, and the
 * renderer is exercised through a real `WorkflowPolicy` so the item → issue
 * conversion (ISO timestamps, snake/camel aliases, `blocked_by` strings) is
 * proven by rendering, not by reading a private helper.
 */
import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createPolicyRenderer,
    policyToSchedulerOptions,
    policyToWorkspaceOptions,
    WorkflowPolicy
} from '../lib/agentic/workflow-policy/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { PolicyError } from '../lib/core/errors.mjs';
import { classifyFailure, FailureClass } from '../lib/agentic/loops/policy.mjs';
import { failureEvidence } from '../lib/agentic/scheduler/retry.mjs';
import {
    createMemoryClaimStore,
    createMemoryWorkSource,
    SCHEDULER_DEFAULTS,
    WorkScheduler
} from '../lib/agentic/scheduler/index.mjs';
import { validateSchedulerConfig } from '../lib/agentic/scheduler/validate.mjs';

/** Envelope keys the SDK stamps on every event; the rest is the payload. */
const STAMP_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A policy that sets every mapped field, including the three limits and `byLane`. */
const FULL_WORKFLOW = [
    '---',
    'tracker:',
    '  kind: linear',
    '  required_labels: [Agent, agent]',
    '  active_states: [Todo, "In Progress"]',
    '  terminal_states: [Done, Canceled]',
    'polling:',
    '  interval_ms: 15000',
    'workspace:',
    '  root: ./workspaces',
    'agent:',
    '  max_concurrent_agents: 2',
    '  max_retry_backoff_ms: 120000',
    '  max_concurrent_agents_by_state:',
    '    "In Progress": 1',
    '    Review: 2',
    'hooks:',
    '  after_create: echo create',
    '  before_run: echo before',
    '  after_run: null',
    '  before_remove: echo remove',
    '  timeout_ms: 5000',
    'merci:',
    '  workspace:',
    '    strategy: git-worktree',
    '    repo_root: .',
    '    base_ref: main',
    '    branch_prefix: agent/',
    '  scheduler:',
    '    max_attempts_per_item: 4',
    '    retry_base_ms: 2000',
    '    continuation_delay_ms: 500',
    '    continuation_max: 2',
    '    stall_timeout_ms: 600000',
    '    max_total_tokens: 100000',
    '    max_total_usd: 5.5',
    '    max_dispatches: 7',
    '---',
    'Work on {{ issue.identifier }}.'
].join('\n');

/** Every default that the mapping must emit as an explicit pair. */
const MINIMAL_WORKFLOW = [
    '---',
    'polling:',
    '  interval_ms: 30000',
    '---',
    'Work on {{ issue.identifier }}.'
].join('\n');

/** A changed policy: a new poll interval, a new dispatch cap, and two limits gone. */
const RELOADED_WORKFLOW = [
    '---',
    'polling:',
    '  interval_ms: 45000',
    'merci:',
    '  scheduler:',
    '    max_attempts_per_item: 6',
    '    max_dispatches: 9',
    '---',
    'Work on {{ issue.identifier }}.'
].join('\n');

/** The same resolved config as {@link RELOADED_WORKFLOW}, different prompt only. */
const PROMPT_ONLY_WORKFLOW = [
    '---',
    'polling:',
    '  interval_ms: 45000',
    'merci:',
    '  scheduler:',
    '    max_attempts_per_item: 6',
    '    max_dispatches: 9',
    '---',
    'Prompt-only edit for {{ issue.identifier }}.'
].join('\n');

/** A template that touches every issue-view key the §3.9 table defines. */
const MAPPING_PROMPT = [
    'id={{ issue.id }}',
    'identifier={{ issue.identifier }}',
    'title={{ issue.title }}',
    'state={{ issue.state }}',
    'url={{ issue.url }}',
    'lane={{ issue.lane }}',
    'dispatchable={{ issue.dispatchable }}',
    'description={{ issue.description }}',
    'priority={{ issue.priority }}',
    'labels={{ issue.labels }}',
    'blocked_by={{ issue.blocked_by }}',
    'blockedBy={{ issue.blockedBy }}',
    'created_at={{ issue.created_at }}',
    'createdAt={{ issue.createdAt }}',
    'updated_at={{ issue.updated_at }}',
    'updatedAt={{ issue.updatedAt }}',
    'native_ref.id={{ issue.native_ref.id }}',
    'nativeRef.id={{ issue.nativeRef.id }}',
    'metadata.source={{ issue.metadata.source }}',
    'branch_name={{ issue.branch_name }}',
    'assignee_id={{ issue.assignee_id }}'
].join('\n');

/**
 * @param {{markdown: string, options?: import('../lib/agentic/workflow-policy/policy.mjs').WorkflowPolicyOptions}} [arg0]
 */
async function createFixture({ markdown, options = {} } = { markdown: MINIMAL_WORKFLOW }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-integrate-'));
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
    await policy.start();
    return { dir, path, policy, emitter, events };
}

/**
 * @param {{template: string}} arg0
 * @returns {string}
 */
function promptWorkflow({ template }) {
    return ['---', 'polling:', '  interval_ms: 30000', '---', template].join('\n');
}

/**
 * @param {{envelope: Record<string, unknown>}} arg0
 * @returns {Record<string, unknown>}
 */
function payloadOf({ envelope }) {
    const payload = { ...envelope };
    for (const key of STAMP_KEYS) delete payload[key];
    return payload;
}

/**
 * A manual clock: recorded timers never fire, so only an explicit `tick()`
 * advances the scheduler. Mirrors the scheduler tests; no shared helper exists.
 * @param {{now?: number}} [arg0]
 * @returns {{
 *   now: () => number,
 *   setTimeout: (fn: () => void, ms: number) => number,
 *   clearTimeout: (handle: unknown) => void,
 *   timers: Map<number, {at: number, fn: () => void}>
 * }}
 */
function createClock({ now = Date.UTC(2026, 10, 9, 18, 0, 0) } = {}) {
    let current = now;
    let nextHandle = 1;
    /** @type {Map<number, {at: number, fn: () => void}>} */
    const timers = new Map();
    return {
        now: () => current,
        setTimeout: (fn, ms) => {
            const handle = nextHandle++;
            timers.set(handle, { at: current + ms, fn });
            return handle;
        },
        clearTimeout: (handle) => { if (typeof handle === 'number') timers.delete(handle); },
        timers
    };
}

/**
 * @param {{events: Record<string, unknown>[]}} arg0
 * @returns {Record<string, unknown>}
 */
function lastTick({ events }) {
    const ticks = events.filter((envelope) => envelope.event === EVENTS.SCHEDULER.TICK);
    const last = ticks.at(-1);
    assert.ok(last !== undefined, 'the scheduler emitted a tick');
    return /** @type {Record<string, unknown>} */ (last);
}

const ITEM = Object.freeze({
    id: 'item-1',
    identifier: 'MERCI-7',
    title: 'Fix the widget',
    state: 'In Progress',
    url: 'https://example.test/MERCI-7',
    lane: 'In Progress',
    dispatchable: true,
    description: 'The widget is broken.',
    priority: 2,
    labels: ['agent', 'bug'],
    blockedBy: [
        { identifier: 'MERCI-1' },
        { id: 'item-2' },
        { state: 'Blocked' },
        null,
        { identifier: '' },
        { identifier: 'MERCI-3' }
    ],
    createdAt: Date.UTC(2026, 10, 1, 12, 0, 0),
    updatedAt: Date.UTC(2026, 10, 2, 12, 0, 0),
    nativeRef: { id: 'n-1' },
    metadata: { branchName: 'merci/merci-7', assignee_id: 'user-1', source: 'linear' }
});

describe('policyToSchedulerOptions', () => {
    it('maps a full policy to exactly the scheduler option shape', async () => {
        const { policy } = await createFixture({ markdown: FULL_WORKFLOW });
        try {
            const options = policyToSchedulerOptions({ policy });
            assert.deepEqual(Object.keys(options).sort(), [
                'activeStates', 'concurrency', 'continuation', 'limits', 'pollIntervalMs',
                'preflight', 'requiredLabels', 'retry', 'stallTimeoutMs', 'terminalStates'
            ]);
            assert.deepEqual(options.activeStates, ['Todo', 'In Progress']);
            assert.deepEqual(options.terminalStates, ['Done', 'Canceled']);
            assert.deepEqual(options.requiredLabels, ['agent']);
            assert.equal(options.pollIntervalMs, 15000);
            assert.equal(options.stallTimeoutMs, 600000);
            assert.deepEqual(Object.keys(options.concurrency).sort(), ['byLane', 'global']);
            assert.equal(options.concurrency.global, 2);
            assert.deepEqual(options.concurrency.byLane, { 'in progress': 1, review: 2 });
            assert.deepEqual(options.retry, { baseMs: 2000, maxMs: 120000 });
            assert.deepEqual(options.continuation, { delayMs: 500, max: 2 });
            assert.deepEqual(Object.keys(options.limits), [
                'maxAttemptsPerItem', 'maxDispatches', 'maxTotalTokens', 'maxTotalUsd'
            ]);
            assert.deepEqual(options.limits, {
                maxAttemptsPerItem: 4,
                maxDispatches: 7,
                maxTotalTokens: 100000,
                maxTotalUsd: 5.5
            });
            assert.equal(typeof options.preflight, 'function');
            assert.deepEqual(options.preflight(), []);
        } finally {
            policy.stop();
        }
    });

    it('omits empty state arrays, an empty byLane, and unset limits', async () => {
        const { policy } = await createFixture({ markdown: MINIMAL_WORKFLOW });
        try {
            const options = policyToSchedulerOptions({ policy });
            assert.equal(Object.hasOwn(options, 'activeStates'), false);
            assert.equal(Object.hasOwn(options, 'terminalStates'), false);
            assert.equal(Object.hasOwn(options.concurrency, 'byLane'), false);
            assert.deepEqual(options.concurrency, { global: 1 });
            assert.deepEqual(options.limits, { maxAttemptsPerItem: 5 });
            assert.deepEqual(options.retry, SCHEDULER_DEFAULTS.retry);
            assert.deepEqual(options.continuation, SCHEDULER_DEFAULTS.continuation);
            assert.equal(options.pollIntervalMs, SCHEDULER_DEFAULTS.pollIntervalMs);
            assert.equal(options.stallTimeoutMs, SCHEDULER_DEFAULTS.stallTimeoutMs);
            assert.ok(!Array.isArray(options.activeStates));
        } finally {
            policy.stop();
        }
    });

    it('returns the policy reasons at call time, not at mapping time', async () => {
        const { path, policy } = await createFixture({ markdown: FULL_WORKFLOW });
        try {
            const options = policyToSchedulerOptions({ policy });
            assert.deepEqual(options.preflight(), []);

            await writeFile(path, '---\ntracker:\n  kind: [broken\n---\n');
            const failed = await policy.reload();
            assert.equal(failed.healthy, false);
            const reasons = options.preflight();
            assert.ok(reasons.length > 0);
            assert.deepEqual(reasons, failed.reasons);

            await writeFile(path, FULL_WORKFLOW);
            const fixed = await policy.reload();
            assert.equal(fixed.healthy, true);
            assert.deepEqual(options.preflight(), []);
        } finally {
            policy.stop();
        }
    });

    it('produces a config the scheduler validates, and a missing key fails', async () => {
        const { policy } = await createFixture({ markdown: FULL_WORKFLOW });
        try {
            const mapped = policyToSchedulerOptions({ policy });
            const options = {
                ...mapped,
                activeStates: mapped.activeStates ?? ['Todo'],
                terminalStates: mapped.terminalStates ?? [],
                workSource: {
                    fetchByStates: () => Promise.resolve([]),
                    fetchByIds: () => Promise.resolve([])
                },
                workflow: { run: () => Promise.resolve({}) },
                claims: 'memory',
                allowSharedWorkspace: true
            };
            assert.deepEqual(validateSchedulerConfig({ options }), []);

            const { retry, ...withoutRetry } = options;
            assert.ok(retry !== undefined);
            assert.ok(validateSchedulerConfig({ options: withoutRetry }).length > 0);

            const { limits, ...withoutLimits } = options;
            assert.ok(limits !== undefined);
            assert.ok(validateSchedulerConfig({ options: withoutLimits }).length > 0);
        } finally {
            policy.stop();
        }
    });
});

describe('the documented wiring merge', () => {
    it('lets the file win and the fallback fill only what it omits', async () => {
        /** @type {{activeStates: string[], terminalStates: string[]}} */
        const fallback = { activeStates: ['Fallback'], terminalStates: ['Fallback Done'] };
        const { policy: full } = await createFixture({ markdown: FULL_WORKFLOW });
        const { policy: minimal } = await createFixture({ markdown: MINIMAL_WORKFLOW });
        try {
            // The documented order: the fallback first, the mapped file options last.
            const fromFile = { ...fallback, ...policyToSchedulerOptions({ policy: full }) };
            assert.deepEqual(fromFile.activeStates, ['Todo', 'In Progress'], 'a file-supplied list survives the fallback');
            assert.deepEqual(fromFile.terminalStates, ['Done', 'Canceled']);

            const filled = { ...fallback, ...policyToSchedulerOptions({ policy: minimal }) };
            assert.deepEqual(filled.activeStates, ['Fallback'], 'the fallback fills an omitted list');
            assert.deepEqual(filled.terminalStates, ['Fallback Done']);
        } finally {
            full.stop();
            minimal.stop();
        }
    });
});

describe('policyToWorkspaceOptions', () => {
    it('maps a git-worktree policy and its snake_case hooks to camelCase', async () => {
        const { dir, policy } = await createFixture({ markdown: FULL_WORKFLOW });
        try {
            const options = policyToWorkspaceOptions({ policy });
            assert.deepEqual(Object.keys(options).sort(), [
                'baseRef', 'branchPrefix', 'hooks', 'repoRoot', 'root', 'strategy'
            ]);
            assert.equal(options.root, join(dir, 'workspaces'));
            assert.equal(options.strategy, 'git-worktree');
            assert.equal(options.repoRoot, dir);
            assert.equal(options.baseRef, 'main');
            assert.equal(options.branchPrefix, 'agent/');
            assert.deepEqual(Object.keys(options.hooks).sort(), [
                'afterCreate', 'afterRun', 'beforeRemove', 'beforeRun', 'timeoutMs'
            ]);
            assert.deepEqual(options.hooks, {
                afterCreate: 'echo create',
                beforeRun: 'echo before',
                afterRun: null,
                beforeRemove: 'echo remove',
                timeoutMs: 5000
            });
        } finally {
            policy.stop();
        }
    });

    it('omits repoRoot for the directory strategy and keeps null hooks', async () => {
        const { policy } = await createFixture({ markdown: MINIMAL_WORKFLOW });
        try {
            const options = policyToWorkspaceOptions({ policy });
            assert.equal(Object.hasOwn(options, 'repoRoot'), false);
            assert.equal(options.strategy, 'directory');
            assert.equal(options.baseRef, 'HEAD');
            assert.equal(options.branchPrefix, 'merci/');
            assert.deepEqual(options.hooks, {
                afterCreate: null,
                beforeRun: null,
                afterRun: null,
                beforeRemove: null,
                timeoutMs: 60000
            });
        } finally {
            policy.stop();
        }
    });
});

describe('mapping lifecycle requirements', () => {
    it('throws not_started before start, maps after start, and maps after stop with a stopped preflight', { timeout: 5000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'merci-wp-lifecycle-'));
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, MINIMAL_WORKFLOW);
        const policy = new WorkflowPolicy({ path, watch: false });
        try {
            for (const map of [policyToSchedulerOptions, policyToWorkspaceOptions]) {
                /** @type {unknown} */
                let thrown = null;
                try {
                    map({ policy });
                } catch (err) {
                    thrown = err;
                }
                assert.ok(thrown instanceof PolicyError, 'an unstarted policy mapping throws a PolicyError');
                const error = /** @type {PolicyError} */ (thrown);
                assert.equal(error.reason, 'not_started');
                assert.equal(error.code, 'MERCI-WORKFLOW-POLICY-ERR');
            }

            await policy.start();
            assert.equal(policyToSchedulerOptions({ policy }).pollIntervalMs, 30000);
            assert.equal(policyToWorkspaceOptions({ policy }).strategy, 'directory');

            policy.stop();
            assert.equal(policyToSchedulerOptions({ policy }).pollIntervalMs, 30000);
            assert.equal(policyToWorkspaceOptions({ policy }).strategy, 'directory');
            assert.deepEqual(policyToSchedulerOptions({ policy }).preflight(), ['stopped']);
        } finally {
            policy.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('live policy reload into the scheduler', () => {
    it('applies a changed policy, keeps host activeStates, and keeps the preflight closure live', { timeout: 5000 }, async () => {
        const clock = createClock();
        /** @type {Record<string, unknown>[]} */
        const events = [];
        /** @type {{emit: (name: string, payload: Record<string, unknown>) => void}} */
        const emitter = { emit: (_name, envelope) => { events.push(envelope); } };
        /** @type {Array<{id: string, identifier: string, title: string, state: string, dispatchable: boolean, url: string}>} */
        const records = [{
            id: 'wi-1',
            identifier: 'MER-9',
            title: 'Live reload item',
            state: 'Backlog',
            dispatchable: true,
            url: 'https://tracker.example/MER-9'
        }];
        const { dir, path, policy } = await createFixture({ markdown: FULL_WORKFLOW });
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items: records }),
            workflow: { run: async () => ({ status: 'completed' }) },
            claims: createMemoryClaimStore(),
            clock,
            eventEmitter: emitter,
            ...policyToSchedulerOptions({ policy }),
            activeStates: ['Todo'],
            allowSharedWorkspace: true
        });
        try {
            await scheduler.start();
            assert.equal(lastTick({ events }).outcome, 'ok', 'the Backlog item is not fetched');

            await writeFile(path, RELOADED_WORKFLOW);
            const reloaded = await policy.reload();
            assert.equal(reloaded.changed, true);
            assert.equal(reloaded.healthy, true);
            const applied = await scheduler.applyConfig({ options: policyToSchedulerOptions({ policy }) });
            assert.equal(applied.applied, true);
            assert.equal(applied.deferred, false);
            assert.ok(applied.changed.includes('pollIntervalMs'), 'the new interval is part of the patch');
            assert.ok(applied.changed.includes('limits'), 'the new limits are part of the patch');

            const changedSnapshot = scheduler.snapshot();
            assert.equal(changedSnapshot.pollIntervalMs, 45000);
            assert.deepEqual(changedSnapshot.limits, { maxAttemptsPerItem: 6, maxDispatches: 9 });
            assert.deepEqual(changedSnapshot.activeStates, ['Todo'], 'the host activeStates survive the patch');

            await writeFile(path, PROMPT_ONLY_WORKFLOW);
            assert.equal((await policy.reload()).changed, true);
            const promptOnly = await scheduler.applyConfig({ options: policyToSchedulerOptions({ policy }) });
            assert.deepEqual(promptOnly.changed, [], 'a prompt-only reload is not a scheduler reconfiguration');
            assert.equal(promptOnly.applied, false, 'and nothing is applied');

            await writeFile(path, '---\ntracker:\n  kind: [broken\n---\nWork\n');
            const broken = await policy.reload();
            assert.equal(broken.healthy, false);
            await scheduler.tick();
            assert.equal(lastTick({ events }).outcome, 'validation_error', 'the live preflight blocks the tick');

            records[0].state = 'Todo';
            await writeFile(path, RELOADED_WORKFLOW);
            assert.equal((await policy.reload()).healthy, true);
            await scheduler.tick();
            const finalTick = lastTick({ events });
            assert.equal(finalTick.outcome, 'ok');
            assert.equal(finalTick.dispatched, 1, 'the fixed policy dispatches the item');
        } finally {
            await scheduler.stop({ timeoutMs: 2000 });
            policy.stop();
            assert.equal(clock.timers.size, 0, 'no timer stays armed');
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('createPolicyRenderer', () => {
    it('maps the full work item to the §3.9 issue view', async () => {
        const { policy } = await createFixture({ markdown: promptWorkflow({ template: MAPPING_PROMPT }) });
        try {
            const render = createPolicyRenderer({ policy });
            const output = render({ item: ITEM });
            assert.equal(output, [
                'id=item-1',
                'identifier=MERCI-7',
                'title=Fix the widget',
                'state=In Progress',
                'url=https://example.test/MERCI-7',
                'lane=In Progress',
                'dispatchable=true',
                'description=The widget is broken.',
                'priority=2',
                'labels=agent, bug',
                'blocked_by=MERCI-1, item-2, Blocked, MERCI-3',
                'blockedBy=MERCI-1, item-2, Blocked, MERCI-3',
                'created_at=2026-11-01T12:00:00.000Z',
                'createdAt=2026-11-01T12:00:00.000Z',
                'updated_at=2026-11-02T12:00:00.000Z',
                'updatedAt=2026-11-02T12:00:00.000Z',
                'native_ref.id=n-1',
                'nativeRef.id=n-1',
                'metadata.source=linear',
                'branch_name=merci/merci-7',
                'assignee_id=user-1'
            ].join('\n'));
        } finally {
            policy.stop();
        }
    });

    it('keeps null fields as present keys that render empty', async () => {
        const { policy } = await createFixture({
            markdown: promptWorkflow({
                template: '{{ issue.description }}|{{ issue.priority }}|{{ issue.url }}'
                    + '|{{ issue.blocked_by }}|{{ issue.blockedBy }}|{{ issue.branch_name }}'
                    + '|{{ issue.assignee_id }}|{{ issue.metadata }}|{{ issue.native_ref }}'
                    + '|{{ issue.createdAt }}'
            })
        });
        try {
            const render = createPolicyRenderer({ policy });
            const output = render({
                item: {
                    id: 'item-2',
                    identifier: 'MERCI-8',
                    title: 'Bare item',
                    state: 'Todo',
                    lane: 'Todo',
                    dispatchable: false,
                    labels: []
                }
            });
            assert.equal(output, '|'.repeat(9));
        } finally {
            policy.stop();
        }
    });

    it('maps the scheduler attempt to the retry index', async () => {
        const { policy } = await createFixture({
            markdown: promptWorkflow({ template: 'attempt={% if attempt %}{{ attempt }}{% else %}none{% endif %}' })
        });
        try {
            const render = createPolicyRenderer({ policy });
            // The scheduler dispatches its first attempt as 1; the contract's
            // first attempt is null, so the retry branch stays off. Dispatch 2
            // is the first retry, so it renders 1.
            assert.equal(render({ item: ITEM, attempt: 1 }), 'attempt=none');
            assert.equal(render({ item: ITEM, attempt: 2 }), 'attempt=1');
            assert.equal(render({ item: ITEM, attempt: 3 }), 'attempt=2');
            assert.equal(render({ item: ITEM, attempt: null }), 'attempt=none');
            assert.equal(render({ item: ITEM }), 'attempt=none');
            // A continuation runs as dispatch 1 again but is a retry.
            assert.equal(render({ item: ITEM, attempt: 1, continuation: true }), 'attempt=1');
            // `renderPrompt()` itself passes the value through: a direct caller
            // passes exactly what it means.
            assert.equal(policy.renderPrompt({ issue: {}, attempt: 1 }), 'attempt=1');
        } finally {
            policy.stop();
        }
    });

    it('renders the first-attempt branch with the real scheduler attempt number', { timeout: 5000 }, async () => {
        const clock = createClock();
        /** @type {Record<string, unknown>[]} */
        const events = [];
        /** @type {{emit: (name: string, payload: Record<string, unknown>) => void}} */
        const emitter = { emit: (_name, envelope) => { events.push(envelope); } };
        /** @type {Array<{id: string, identifier: string, title: string, state: string, dispatchable: boolean, url: string}>} */
        const records = [{
            id: 'wi-r',
            identifier: 'MER-10',
            title: 'Retry branch item',
            state: 'Todo',
            dispatchable: true,
            url: 'https://tracker.example/MER-10'
        }];
        const { policy } = await createFixture({
            markdown: promptWorkflow({ template: 'retry={% if attempt %}{{ attempt }}{% else %}first{% endif %}' })
        });
        /** @type {string[]} */
        const prompts = [];
        const render = createPolicyRenderer({ policy });
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items: records }),
            workflow: {
                run: async ({ item, attempt }) => {
                    prompts.push(render({ item, attempt }));
                    return { status: 'completed' };
                }
            },
            claims: createMemoryClaimStore(),
            clock,
            eventEmitter: emitter,
            // The documented merge: the fallback first, the file's options last.
            activeStates: ['Todo'],
            ...policyToSchedulerOptions({ policy })
        });
        try {
            await scheduler.start();
            await scheduler.tick();
            assert.deepEqual(prompts, ['retry=first'], 'attempt 1 selects the first-attempt branch');
            const dispatched = events.filter((envelope) => envelope.event === EVENTS.WORK_ITEM.DISPATCHED);
            assert.equal(dispatched.length, 1);
            assert.equal(payloadOf({ envelope: dispatched[0] }).attempt, 1, 'the scheduler numbers the first dispatch 1');
        } finally {
            await scheduler.stop({ timeoutMs: 2000 });
            policy.stop();
            assert.equal(clock.timers.size, 0, 'no timer stays armed');
        }
    });

    it('renders a Symphony-style prompt with snake_case fields', async () => {
        const { policy } = await createFixture({
            markdown: promptWorkflow({
                template: 'Created {{ issue.created_at }}; blocked by {{ issue.blocked_by }}.'
            })
        });
        try {
            const render = createPolicyRenderer({ policy });
            assert.equal(
                render({ item: ITEM }),
                'Created 2026-11-01T12:00:00.000Z; blocked by MERCI-1, item-2, Blocked, MERCI-3.'
            );
        } finally {
            policy.stop();
        }
    });

    it('emits render_failed with the base reason and field, then rethrows a PolicyError', async () => {
        const { policy } = await createFixture({
            markdown: promptWorkflow({ template: '{{ issue.missing_field }}' })
        });
        const emitter = new MerciEventEmitter();
        /** @type {Record<string, unknown>[]} */
        const events = [];
        /** @param {Record<string, unknown>} envelope */
        const collect = (envelope) => { events.push(envelope); };
        emitter.onAny(collect);
        try {
            const render = createPolicyRenderer({ policy, eventEmitter: emitter });
            /** @type {unknown} */
            let thrown = null;
            try {
                render({ item: ITEM });
            } catch (err) {
                thrown = err;
            }
            assert.ok(thrown instanceof PolicyError);
            assert.ok(/** @type {PolicyError} */ (thrown).reason?.startsWith('template_render_error'));

            const rendered = events.filter((envelope) => envelope.event === EVENTS.WORKFLOW_POLICY.RENDER_FAILED);
            assert.equal(rendered.length, 1);
            assert.deepEqual(payloadOf({ envelope: rendered[0] }), {
                reason: 'template_render_error',
                field: 'issue.missing_field'
            });
        } finally {
            policy.stop();
        }
    });

    it('wraps a foreign error, emits field null, and rethrows a PolicyError', () => {
        const emitter = new MerciEventEmitter();
        /** @type {Record<string, unknown>[]} */
        const events = [];
        /** @param {Record<string, unknown>} envelope */
        const collect = (envelope) => { events.push(envelope); };
        emitter.onAny(collect);
        /** @type {{getConfig: () => null, preflight: () => string[], renderPrompt: () => string}} */
        const stub = {
            getConfig: () => null,
            preflight: () => [],
            renderPrompt: () => { throw new Error('boom'); }
        };
        const render = createPolicyRenderer({ policy: stub, eventEmitter: emitter });
        assert.throws(() => render({ item: ITEM }), PolicyError);
        assert.deepEqual(payloadOf({ envelope: events[0] }), {
            reason: 'template_render_error',
            field: null
        });
    });

    it('classifies its PolicyError as invalid_workflow through the scheduler path', async () => {
        const { policy } = await createFixture({
            markdown: promptWorkflow({ template: '{{ issue.missing_field }}' })
        });
        try {
            const render = createPolicyRenderer({ policy });
            /** @type {unknown} */
            let thrown = null;
            try {
                render({ item: ITEM });
            } catch (err) {
                thrown = err;
            }
            assert.ok(thrown instanceof PolicyError);
            const error = /** @type {PolicyError} */ (thrown);
            const evidence = {
                ...failureEvidence({ result: { errorCode: error.code } }),
                errorCode: error.code
            };
            assert.equal(evidence.source, 'scheduler');
            assert.equal(evidence.errorCode, 'MERCI-WORKFLOW-POLICY-ERR');
            assert.equal(classifyFailure({ evidence }), FailureClass.INVALID_WORKFLOW);
        } finally {
            policy.stop();
        }
    });
});

describe('integration helper imports', () => {
    it('never imports the scheduler or workspace modules', () => {
        for (const file of ['integrate.mjs', 'index.mjs']) {
            const source = readFileSync(
                new URL(`../lib/agentic/workflow-policy/${file}`, import.meta.url),
                'utf8'
            );
            assert.equal(source.includes('agentic/scheduler'), false, `${file} imports the scheduler`);
            assert.equal(source.includes('agentic/workspace'), false, `${file} imports the workspace`);
        }
    });

    it('maps and renders from a copy with no scheduler or workspace modules', { timeout: 10000 }, async (t) => {
        const repoRoot = fileURLToPath(new URL('..', import.meta.url));
        const copyRoot = await mkdtemp(join(repoRoot, '.tmp-wp-copy-')).catch(() => null);
        if (copyRoot === null) {
            t.skip('a temporary copy directory is unavailable in this environment');
            return;
        }
        try {
            try {
                for (const source of ['lib/core', 'lib/support', 'lib/agentic/workflow-policy']) {
                    await cp(join(repoRoot, source), join(copyRoot, source), { recursive: true });
                }
            } catch {
                t.skip('the module copy is unavailable in this environment');
                return;
            }
            assert.equal(existsSync(join(copyRoot, 'package.json')), false, 'the copy has no package.json');
            assert.equal(existsSync(join(copyRoot, 'lib/agentic/scheduler')), false, 'the copy has no scheduler');
            assert.equal(existsSync(join(copyRoot, 'lib/agentic/workspace')), false, 'the copy has no workspace');

            const source = readFileSync(join(copyRoot, 'lib/agentic/workflow-policy/integrate.mjs'), 'utf8');
            const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
            assert.ok(specifiers.length >= 2, 'the module has static imports to check');
            for (const specifier of specifiers) {
                assert.equal(/scheduler|workspace/i.test(specifier), false, `integrate.mjs imports ${specifier}`);
            }

            /** @type {{policyToSchedulerOptions: typeof policyToSchedulerOptions, createPolicyRenderer: typeof createPolicyRenderer}} */
            const copiedIntegrate = await import(
                pathToFileURL(join(copyRoot, 'lib/agentic/workflow-policy/integrate.mjs')).href
            );
            /** @type {{WorkflowPolicy: typeof WorkflowPolicy}} */
            const copiedPolicy = await import(
                pathToFileURL(join(copyRoot, 'lib/agentic/workflow-policy/policy.mjs')).href
            );

            const path = join(copyRoot, 'WORKFLOW.md');
            await writeFile(path, MINIMAL_WORKFLOW);
            const policy = new copiedPolicy.WorkflowPolicy({ path, watch: false });
            try {
                await policy.start();
                const mapped = copiedIntegrate.policyToSchedulerOptions({ policy });
                assert.equal(mapped.pollIntervalMs, 30000);
                assert.deepEqual(mapped.limits, { maxAttemptsPerItem: 5 });
                const render = copiedIntegrate.createPolicyRenderer({ policy });
                assert.equal(render({
                    item: {
                        id: 'isolated-1',
                        identifier: 'MER-9',
                        title: 'Isolated item',
                        state: 'Todo',
                        lane: 'Todo',
                        dispatchable: true,
                        labels: []
                    }
                }), 'Work on MER-9.');
            } finally {
                policy.stop();
            }
        } finally {
            await rm(copyRoot, { recursive: true, force: true });
        }
    });
});
