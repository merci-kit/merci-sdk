// @ts-check

/**
 * @file F2-2/F2-3/F2-7 contract tests: a crashed attempt consumes one attempt,
 * and a claim survives a restart and a park.
 * @version 0.12.0
 *
 * @description
 * A process that dies mid-attempt used to leave no failure count, so a poison
 * item was re-dispatched on every restart (F2-2). The scheduler now persists an
 * `inFlight` marker before the attempt starts and counts a leftover marker as
 * one `unknown` failure, which reuses the existing `attempts_exhausted` park.
 * The claim store now reclaims a same-host claim whose pid is alive again but
 * whose owner token this process never issued (F2-3), and a same-owner
 * re-acquire refreshes `claimedAt` so a parked claim never ages past
 * `staleMs` (F2-7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    WorkScheduler,
    createFileAttemptStore,
    createFileClaimStore,
    createMemoryWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { workspaceKeyFor } from '../lib/agentic/workspace/index.mjs';

/** @typedef {import('../lib/agentic/scheduler/normalize.mjs').WorkItem} WorkItem */

/**
 * A manual clock: timed callbacks fire only inside `advance`, and a long poll
 * interval keeps an abandoned scheduler from running a second tick.
 * @param {{now?: number}} [arg0] -
 * @returns {{now: () => number, setTimeout: (fn: () => void, ms: number) => number, clearTimeout: (handle: unknown) => void, advance: (ms: number) => void}}
 */
function createClock({ now = 1_000 } = {}) {
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
        advance: (ms) => {
            current += ms;
            for (const [handle, timer] of [...timers.entries()]) {
                if (timer.at <= current) {
                    timers.delete(handle);
                    timer.fn();
                }
            }
        }
    };
}

/**
 * @param {{overrides?: Record<string, unknown>}} [arg0] -
 * @returns {WorkItem}
 */
function rawItem({ overrides = {} } = {}) {
    return /** @type {WorkItem} */ ({
        id: 'id-1',
        identifier: 'MER-1',
        title: 'One',
        state: 'Todo',
        dispatchable: true,
        ...overrides
    });
}

/**
 * Let queued microtasks and `onSettled` continuations run.
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 10 } = {}) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * The claim file path the store derives for one identifier.
 * @param {{dir: string, workItemId: string}} arg0 -
 * @returns {string}
 */
function claimFile({ dir, workItemId }) {
    return join(dir, `${workspaceKeyFor({ workItemId })}.json`);
}

/**
 * Write a claim file directly, as a crashed process would leave it.
 * @param {{file: string, record: {workItemId: string, owner: string, pid: number, host: string, claimedAt: number}}} arg0 -
 * @returns {Promise<void>}
 */
async function seedClaim({ file, record }) {
    await writeFile(file, JSON.stringify(record), 'utf8');
}

/**
 * A file claim store whose claim writes after the first wait for a gate, so a
 * heartbeat can be held in flight while the host resets the item.
 * @param {{dir: string, staleMs: number}} arg0 -
 * @returns {{store: import('../lib/agentic/scheduler/claims.mjs').ClaimStore, inner: import('../lib/agentic/scheduler/claims.mjs').ClaimStore, open: () => void}}
 */
function createGatedClaimStore({ dir, staleMs }) {
    const inner = createFileClaimStore({ dir, hostId: 'this-host', staleMs });
    /** @type {() => void} */
    let open = () => {};
    const gate = new Promise((resolve) => { open = /** @type {() => void} */ (resolve); });
    let writes = 0;
    const wait = async () => {
        writes += 1;
        if (writes > 1) await gate;
    };
    return {
        inner,
        open,
        store: {
            acquire: async (args) => { await wait(); return inner.acquire(args); },
            refresh: async (args) => {
                await wait();
                return inner.refresh ? inner.refresh(args) : false;
            },
            release: (args) => inner.release(args),
            isClaimed: (args) => inner.isClaimed(args),
            list: () => inner.list()
        }
    };
}

/**
 * Stop with an attempt that never settles: the drain times out and the claim
 * file survives, as it does when a host exits with a stuck attempt.
 * @param {{scheduler: WorkScheduler, clock: ReturnType<typeof createClock>}} arg0 -
 * @returns {Promise<{drained: boolean, running: number, retrying: number, parked: number}>}
 */
async function stopUndrained({ scheduler, clock }) {
    const stopping = scheduler.stop({ timeoutMs: 0 });
    await flush();
    clock.advance(0);
    return stopping;
}

test('a crashed attempt consumes one attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-budget-'));
    try {
        // One store directory, as a single deployment restarted six times.
        const store = createFileAttemptStore({ dir });
        const items = [rawItem()];
        /** @type {number[]} */
        const dispatchedAttempts = [];
        /** @type {number[]} */
        const parkedPerIncarnation = [];

        for (let incarnation = 1; incarnation <= 6; incarnation += 1) {
            const scheduler = new WorkScheduler({
                workSource: createMemoryWorkSource({ items }),
                workflow: {
                    // The process dies mid-attempt: the run never settles.
                    run: async ({ attempt }) => {
                        dispatchedAttempts.push(attempt);
                        return new Promise(() => {});
                    }
                },
                clock: createClock(),
                pollIntervalMs: 10_000_000,
                activeStates: ['Todo'],
                terminalStates: ['Done'],
                continuation: { delayMs: 0, max: 0 },
                limits: { maxAttemptsPerItem: 2 },
                attemptStore: store
            });
            await scheduler.start();
            parkedPerIncarnation.push(scheduler.snapshot().parked.length);
            // Abandoned without stop(): this incarnation crashed.
        }

        assert.deepEqual(dispatchedAttempts, [1, 1], 'two dispatches, then the budget is spent');
        assert.deepEqual(parkedPerIncarnation, [0, 0, 1, 1, 1, 1], 'the third incarnation hydrates the spent budget');

        const record = await store.load({ identifier: 'MER-1' });
        assert.ok(record);
        assert.equal(record.attempts, 2, 'each crash consumed one attempt');
        assert.equal(record.parked?.reason, 'attempts_exhausted');
        assert.equal(record.inFlight ?? null, null, 'the crash marker is cleared once it is counted');
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('a same-host claim with a foreign owner token is reclaimed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-claim-'));
    try {
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 86_400_000, now: () => 10_000 });
        const file = claimFile({ dir, workItemId: 'MER-1' });
        // This pid, this host, fresh — but the token is one this process never
        // issued, so the holder is an earlier incarnation that reused the pid.
        await seedClaim({
            file,
            record: {
                workItemId: 'MER-1',
                owner: 'this-host:1:dead-incarnation',
                pid: process.pid,
                host: 'this-host',
                claimedAt: 10_000
            }
        });

        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'this-host:1:new', now: 10_000 }), true);
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('a same-owner re-acquire refreshes claimedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-claim-'));
    try {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        const file = claimFile({ dir, workItemId: 'MER-1' });

        await store.acquire({ workItemId: 'MER-1', owner: 'this-host:1:owner', now: 100 });
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'this-host:1:owner', now: 900 }), true);
        /** @type {{claimedAt: number}} */
        const record = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(record.claimedAt, 900);
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('a parked claim is heartbeated so a foreign host cannot take it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-claim-'));
    try {
        const clock = createClock({ now: 1_000 });
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 1_000 });
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items: [rawItem()] }),
            workflow: { run: async () => ({ status: 'failed' }) },
            claims: store,
            clock,
            pollIntervalMs: 10_000_000,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            continuation: { delayMs: 0, max: 0 },
            retry: { baseMs: 1_000, maxMs: 1_000 },
            limits: { maxAttemptsPerItem: 1 }
        });
        await scheduler.start();
        await flush();
        assert.equal(scheduler.snapshot().parked.length, 1, 'the item parked with the claim held');

        // Five seconds later the claim is older than `staleMs` unless the
        // parked re-check refreshed it.
        clock.advance(5_000);
        await scheduler.tick();

        const foreign = createFileClaimStore({ dir, hostId: 'other-host', staleMs: 1_000 });
        assert.equal(await foreign.acquire({ workItemId: 'MER-1', owner: 'other-host:2:x', now: clock.now() }), false);
        await scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('a claim held across a retry delay is heartbeated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-retry-'));
    try {
        const clock = createClock({ now: 1_000 });
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 1_000 });
        /** @type {number[]} */
        const attempts = [];
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items: [rawItem()] }),
            workflow: {
                run: async ({ attempt }) => {
                    attempts.push(attempt);
                    return { status: 'failed' };
                }
            },
            claims: store,
            clock,
            pollIntervalMs: 10_000_000,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            continuation: { delayMs: 0, max: 0 },
            retry: { baseMs: 10_000, maxMs: 10_000 },
            limits: { maxAttemptsPerItem: 3 }
        });
        await scheduler.start();
        await flush();
        assert.deepEqual(attempts, [1]);
        assert.equal(scheduler.snapshot().retrying.length, 1);

        // Ten stale windows of retry delay; a tick in between must refresh the
        // claim, or the owner looks dead to another host.
        clock.advance(9_000);
        await scheduler.tick();
        const foreign = createFileClaimStore({ dir, hostId: 'other-host', staleMs: 1_000 });
        assert.equal(await foreign.acquire({ workItemId: 'MER-1', owner: 'other-host:2:x', now: clock.now() }), false);

        clock.advance(1_000);
        await scheduler.tick();
        await flush();
        assert.deepEqual(attempts, [1, 2], 'the retry starts with its attempt count intact');
        assert.deepEqual(scheduler.snapshot().claimed, ['MER-1']);
        await scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('an in-process restart reclaims the claim a stopped instance left behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-restart-'));
    const claimDir = await mkdtemp(join(tmpdir(), 'merci-crash-restart-claims-'));
    try {
        const store = createFileAttemptStore({ dir });
        const claims = createFileClaimStore({ dir: claimDir, hostId: 'this-host', staleMs: 86_400_000 });
        const items = [rawItem()];
        /** @type {number[]} */
        const dispatched = [];
        /** @type {number[]} */
        const parkedPerIncarnation = [];
        /** @type {boolean[]} */
        const claimLeftBehind = [];

        for (let incarnation = 1; incarnation <= 4; incarnation += 1) {
            const clock = createClock();
            const scheduler = new WorkScheduler({
                workSource: createMemoryWorkSource({ items }),
                workflow: {
                    // The attempt never settles, so the stop cannot drain.
                    run: async ({ attempt }) => {
                        dispatched.push(attempt);
                        return new Promise(() => {});
                    }
                },
                claims,
                clock,
                pollIntervalMs: 10_000_000,
                activeStates: ['Todo'],
                terminalStates: ['Done'],
                continuation: { delayMs: 0, max: 0 },
                limits: { maxAttemptsPerItem: 2 },
                attemptStore: store
            });
            await scheduler.start();
            parkedPerIncarnation.push(scheduler.snapshot().parked.length);
            await stopUndrained({ scheduler, clock });
            claimLeftBehind.push(await claims.isClaimed({ workItemId: 'MER-1' }));
        }

        assert.equal(claimLeftBehind[0], true, 'the first stop leaves the claim file behind');
        assert.equal(claimLeftBehind[1], true, 'so does the second: the wedge is real');
        assert.deepEqual(dispatched, [1, 1], 'the next incarnation reclaims and the crash budget is spent');
        assert.deepEqual(parkedPerIncarnation, [0, 0, 1, 1]);
        const record = await store.load({ identifier: 'MER-1' });
        assert.equal(record?.attempts, 2);
        assert.equal(record?.parked?.reason, 'attempts_exhausted');
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        await rm(claimDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('a reset during a heartbeat leaves no claim file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-race-'));
    try {
        const gated = createGatedClaimStore({ dir, staleMs: 1_000 });
        const items = [rawItem()];
        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items }),
            workflow: { run: async () => ({ status: 'failed' }) },
            claims: gated.store,
            clock: createClock(),
            pollIntervalMs: 10_000_000,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 1 }
        });
        await scheduler.start();
        await flush();
        assert.equal(scheduler.snapshot().parked.length, 1);
        assert.equal(await gated.inner.isClaimed({ workItemId: 'MER-1' }), true);

        // The scan must not re-dispatch the item after the reset.
        items.length = 0;
        const ticking = scheduler.tick();
        await flush();
        await scheduler.resetItem({ identifier: 'MER-1' });
        assert.equal(await gated.inner.isClaimed({ workItemId: 'MER-1' }), false, 'the reset removed the claim');

        gated.open();
        await ticking;
        assert.equal(
            await gated.inner.isClaimed({ workItemId: 'MER-1' }),
            false,
            'the heartbeat must not resurrect a released claim'
        );
        await scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('a leftover marker on a parked record is counted and cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-crash-parked-'));
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'id-1',
                attempts: 1,
                continuations: 0,
                parked: { reason: 'attempts_exhausted', at: 500, nextCheckAt: 999_999 },
                inFlight: { attemptId: 'dead', startedAt: 499 },
                updatedAt: 499
            }
        });

        const scheduler = new WorkScheduler({
            workSource: createMemoryWorkSource({ items: [rawItem()] }),
            workflow: { run: async () => ({ status: 'failed' }) },
            clock: createClock({ now: 2_000 }),
            pollIntervalMs: 10_000_000,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            continuation: { delayMs: 0, max: 0 },
            limits: { maxAttemptsPerItem: 5 },
            attemptStore: store
        });
        await scheduler.start();
        await flush();

        const record = await store.load({ identifier: 'MER-1' });
        assert.ok(record);
        assert.equal(record.attempts, 2, 'the leftover marker is one consumed attempt');
        assert.equal(record.inFlight ?? null, null, 'and it is cleared, so no restart counts it twice');
        assert.equal(record.parked?.reason, 'attempts_exhausted', 'the park row survives');
        await scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});
