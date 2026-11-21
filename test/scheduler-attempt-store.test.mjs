// @ts-check

/**
 * @file P3b contract tests for the durable attempt store: restart resume of
 * attempt counts and parking, record hygiene, and the file-store key.
 * @version 0.12.0
 *
 * @description
 * A scheduler restart must not lose `#attempts`/`#continuations`/`#parked`.
 * These tests park with one scheduler, start a second over the same directory,
 * and assert dispatch, re-check, and clearing behavior. The file store is the
 * system under test; the scheduler is driven with a manual clock and a fake
 * workflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    WorkScheduler,
    createFileAttemptStore,
    createMemoryWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { log } from '../lib/support/logger.mjs';

/** @typedef {ConstructorParameters<typeof WorkScheduler>[0]} SchedulerOptions */

const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/**
 * @typedef {Object} WorkflowInput
 * @property {unknown} item
 * @property {number} attempt
 * @property {AbortSignal} signal
 * @property {() => void} reportProgress
 */

/**
 * @returns {{events: Array<{event: string, [key: string]: unknown}>, emitSafe: (arg0: string, arg1: Record<string, unknown>) => void, emit: (arg0: string, arg1: Record<string, unknown>) => void, on: () => void}}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    return {
        events,
        emitSafe: (name, envelope) => {
            events.push(/** @type {{event: string, [key: string]: unknown}} */ (envelope));
        },
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {}
    };
}

/**
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
 * Poll until an async predicate is true. The attempt store writes through
 * `fsync`, so a fixed number of microtask turns is not enough.
 * @param {{predicate: () => boolean|Promise<boolean>, timeoutMs?: number}} arg0 -
 * @returns {Promise<void>}
 */
async function waitFor({ predicate, timeoutMs = 5_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for scheduler state');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/**
 * @param {{overrides?: Record<string, unknown>}} [arg0] -
 * @returns {Record<string, unknown>}
 */
function rawItem({ overrides = {} } = {}) {
    return {
        id: 'id-1',
        identifier: 'MER-1',
        title: 'One',
        state: 'Todo',
        dispatchable: true,
        ...overrides
    };
}

/**
 * @param {Record<string, unknown>} [overrides] -
 * @returns {Record<string, unknown>}
 */
function failedResult(overrides = {}) {
    return { status: 'failed', ...overrides };
}

/**
 * @param {{run?: (arg0: WorkflowInput) => Promise<unknown>}} [arg0] -
 * @returns {{calls: WorkflowInput[], run: (arg0: WorkflowInput) => Promise<unknown>}}
 */
function createWorkflow({ run } = {}) {
    /** @type {WorkflowInput[]} */
    const calls = [];
    return {
        calls,
        run: async (input) => {
            calls.push(input);
            return run ? run(input) : { status: 'completed' };
        }
    };
}

/**
 * @param {{name: string, emitter: ReturnType<typeof createEmitter>}} arg0 -
 * @returns {Array<Record<string, unknown>>}
 */
function payloads({ name, emitter }) {
    return emitter.events
        .filter((entry) => entry.event === name)
        .map((entry) => {
            /** @type {Record<string, unknown>} */
            const out = {};
            for (const [key, value] of Object.entries(entry)) {
                if (!ENVELOPE_KEYS.has(key)) out[key] = value;
            }
            return out;
        });
}

/**
 * @param {unknown} item -
 * @returns {Record<string, unknown>}
 */
function asRecord(item) {
    return /** @type {Record<string, unknown>} */ (item);
}

/**
 * @param {{
 *   items?: unknown[],
 *   attemptStore: import('../lib/agentic/scheduler/attempt-store.mjs').AttemptStore|'memory',
 *   clock?: ReturnType<typeof createClock>,
 *   workflow?: ReturnType<typeof createWorkflow>,
 *   emitter?: ReturnType<typeof createEmitter>,
 *   options?: SchedulerOptions
 * }} arg0 -
 * @returns {{scheduler: WorkScheduler, emitter: ReturnType<typeof createEmitter>, clock: ReturnType<typeof createClock>, workflow: ReturnType<typeof createWorkflow>, items: unknown[]}}
 */
function buildScheduler({ items = [], attemptStore, clock = createClock(), workflow = createWorkflow(), emitter = createEmitter(), options = {} }) {
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items, eventEmitter: emitter }),
        workflow,
        eventEmitter: emitter,
        clock,
        attemptStore,
        pollIntervalMs: 10_000_000,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done'],
        continuation: { delayMs: 0, max: 0 },
        retry: { baseMs: 1_000, maxMs: 1_000 },
        limits: { maxAttemptsPerItem: 2 },
        ...options
    });
    return { scheduler, emitter, clock, workflow, items };
}

/**
 * A file store whose save and clear are slow enough that a stop/reset reaches
 * them while they are still in flight.
 * @param {{dir: string, delayMs?: number}} arg0 -
 * @returns {import('../lib/agentic/scheduler/attempt-store.mjs').AttemptStore}
 */
function createSlowAttemptStore({ dir, delayMs = 120 }) {
    const inner = createFileAttemptStore({ dir });
    const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
        load: (args) => inner.load(args),
        save: async (args) => {
            await wait();
            return inner.save(args);
        },
        clear: async (args) => {
            await wait();
            return inner.clear(args);
        },
        list: () => inner.list()
    };
}

/**
 * A file store whose load returns the record it read after a delay, leaving a
 * window where a clear can land before the load resolves.
 * @param {{dir: string, delayMs?: number}} arg0 -
 * @returns {import('../lib/agentic/scheduler/attempt-store.mjs').AttemptStore}
 */
function createSlowLoadStore({ dir, delayMs = 30 }) {
    const inner = createFileAttemptStore({ dir });
    return {
        load: async (args) => {
            const record = await inner.load(args);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return record;
        },
        save: (args) => inner.save(args),
        clear: (args) => inner.clear(args),
        list: () => inner.list()
    };
}

/**
 * Park one item after two failed attempts in a first scheduler, then stop it.
 * @param {{dir: string, items: unknown[]}} arg0 -
 * @returns {Promise<{clock: ReturnType<typeof createClock>, workflow: ReturnType<typeof createWorkflow>}>}
 */
async function parkAfterTwoAttempts({ dir, items }) {
    const clock = createClock({ now: 1_000 });
    const store = createFileAttemptStore({ dir });
    const ctx = buildScheduler({
        items,
        clock,
        attemptStore: store,
        workflow: createWorkflow({ run: async () => failedResult() })
    });
    await ctx.scheduler.start();
    await waitFor({ predicate: () => ctx.scheduler.snapshot().retrying.length === 1 });
    clock.advance(1_000);
    await ctx.scheduler.tick();
    await waitFor({
        predicate: async () => (await store.load({ identifier: 'MER-1' }))?.parked?.reason === 'attempts_exhausted'
    });
    assert.equal(ctx.workflow.calls.length, 2);
    assert.equal(ctx.scheduler.snapshot().parked.length, 1);
    await ctx.scheduler.stop();
    return { clock, workflow: ctx.workflow };
}

test('P3b: a parked item keeps its attempt count and park across a restart, and resetItem clears it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const items = [rawItem()];
        await parkAfterTwoAttempts({ dir, items });

        const firstStore = createFileAttemptStore({ dir });
        const firstRecord = await firstStore.load({ identifier: 'MER-1' });
        assert.ok(firstRecord);
        assert.equal(firstRecord.attempts, 2);
        assert.equal(firstRecord.parked?.reason, 'attempts_exhausted');

        const store = createFileAttemptStore({ dir });
        const workflow = createWorkflow({ run: async () => failedResult() });
        const second = buildScheduler({
            items,
            attemptStore: store,
            clock: createClock({ now: 2_500 }),
            workflow
        });
        await second.scheduler.start();
        await waitFor({ predicate: () => second.scheduler.snapshot().parked.length === 1 });

        assert.equal(workflow.calls.length, 0, 'a parked item is not dispatched after a restart');
        assert.equal(second.scheduler.snapshot().parked[0].reason, 'attempts_exhausted');
        assert.equal(second.scheduler.snapshot().parked[0].attempts, 2, 'the attempt count continues');

        await second.scheduler.tick();
        assert.equal(workflow.calls.length, 0, 'a later tick does not dispatch it either');

        await second.scheduler.resetItem({ identifier: 'MER-1' });
        assert.equal(await store.load({ identifier: 'MER-1' }), null, 'resetItem clears the persisted record');

        await second.scheduler.tick();
        assert.equal(workflow.calls.length, 1, 'after a reset the item dispatches again');
        await second.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b: a hydrated parked item whose nextCheckAt has passed is re-checked, not dispatched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const items = [rawItem()];
        await parkAfterTwoAttempts({ dir, items });

        const store = createFileAttemptStore({ dir });
        const workflow = createWorkflow();
        const second = buildScheduler({
            items,
            attemptStore: store,
            clock: createClock({ now: 5_000 }),
            workflow
        });
        await second.scheduler.start();
        await waitFor({
            predicate: async () => (await store.load({ identifier: 'MER-1' }))?.parked?.nextCheckAt === 7_000
        });

        assert.equal(workflow.calls.length, 0, 'the parked check never dispatches');
        assert.equal(second.scheduler.snapshot().parked.length, 1);
        assert.equal(second.scheduler.snapshot().parked[0].nextCheckAt, 7_000, 'the due check extended the backoff');
        assert.equal(payloads({ name: EVENTS.WORK_ITEM.DISPATCHED, emitter: second.emitter }).length, 0);

        second.clock.advance(2_000);
        await second.scheduler.tick();
        await waitFor({ predicate: () => second.scheduler.snapshot().parked[0]?.nextCheckAt === 11_000 });
        assert.equal(workflow.calls.length, 0);
        await second.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b F4: hydration does not delete a record for an item that is not active', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-9',
                id: 'id-9',
                attempts: 1,
                continuations: 0,
                parked: { reason: 'non_retryable', at: 1, nextCheckAt: 2 },
                updatedAt: 1
            }
        });
        assert.ok(await store.load({ identifier: 'MER-9' }));

        const ctx = buildScheduler({ items: [], attemptStore: store });
        await ctx.scheduler.start();
        assert.ok(await store.load({ identifier: 'MER-9' }), 'hydration never deletes an unseen record');
        await ctx.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b: a corrupt record is skipped with a warning and dispatch starts at attempts 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    /** @type {string[]} */
    const lines = [];
    log.configure({
        extended: true,
        sink: {
            log: (text) => { lines.push(String(text)); },
            error: (text) => { lines.push(String(text)); },
            write: () => {}
        }
    });
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'id-1',
                attempts: 5,
                continuations: 0,
                parked: null,
                updatedAt: 1
            }
        });
        const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
        assert.equal(names.length, 1);
        await writeFile(join(dir, names[0]), '{ not json', 'utf8');

        const workflow = createWorkflow({ run: async () => failedResult() });
        const ctx = buildScheduler({ items: [rawItem()], attemptStore: store, workflow });
        await ctx.scheduler.start();
        await waitFor({ predicate: () => ctx.scheduler.snapshot().retrying.length === 1 });

        assert.equal(workflow.calls.length, 1, 'the item still dispatches');
        assert.equal(ctx.scheduler.snapshot().parked.length, 0, 'attempts did not resume at 5');
        assert.equal(ctx.scheduler.snapshot().retrying.length, 1, 'one failure with attempts 0 retries');
        assert.ok(lines.some((line) => line.includes('AttemptStore')), 'a warning is emitted');
        await ctx.scheduler.stop();
    } finally {
        log.configure({
            extended: false,
            sink: {
                log: (text) => console.log(text),
                error: (text) => console.error(text),
                write: (text) => process.stdout.write(String(text))
            }
        });
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b: hydrated attempts continue the failure count and hydrated continuations are honored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'id-1',
                attempts: 1,
                continuations: 0,
                parked: null,
                updatedAt: 1
            }
        });
        const workflow = createWorkflow({ run: async () => failedResult() });
        const ctx = buildScheduler({ items: [rawItem()], attemptStore: store, workflow });
        await ctx.scheduler.start();
        await waitFor({ predicate: () => ctx.scheduler.snapshot().parked.length === 1 });

        assert.equal(workflow.calls.length, 1, 'a non-parked item still dispatches');
        assert.equal(workflow.calls[0].attempt, 1, 'the dispatch ordinal is the fresh attempt');
        const failed = payloads({ name: EVENTS.WORK_ITEM.FAILED, emitter: ctx.emitter });
        assert.equal(failed.length, 1);
        assert.equal(ctx.scheduler.snapshot().parked[0].attempts, 2, 'the continued count reaches the cap');
        await ctx.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }

    const continuationDir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir: continuationDir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'id-1',
                attempts: 0,
                continuations: 1,
                parked: null,
                updatedAt: 1
            }
        });
        const workflow = createWorkflow();
        const ctx = buildScheduler({
            items: [rawItem()],
            attemptStore: store,
            workflow,
            options: { continuation: { delayMs: 0, max: 1 } }
        });
        await ctx.scheduler.start();
        await waitFor({ predicate: () => ctx.scheduler.snapshot().parked.length === 1 });

        assert.equal(workflow.calls.length, 1);
        assert.equal(payloads({ name: EVENTS.WORK_ITEM.CONTINUED, emitter: ctx.emitter }).length, 0,
            'the persisted continuation count is not restarted');
        assert.equal(ctx.scheduler.snapshot().parked[0]?.reason, 'continuations_exhausted');
        await ctx.scheduler.stop();
    } finally {
        await rm(continuationDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b: resetItem and a terminal release clear the persisted record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const items = [rawItem()];
        const clock = createClock({ now: 1_000 });
        const store = createFileAttemptStore({ dir });
        const ctx = buildScheduler({
            items,
            clock,
            attemptStore: store,
            workflow: createWorkflow({ run: async () => failedResult() }),
            options: { limits: { maxAttemptsPerItem: 1 } }
        });
        await ctx.scheduler.start();
        await waitFor({
            predicate: async () => (await store.load({ identifier: 'MER-1' }))?.parked?.reason === 'attempts_exhausted'
        });
        assert.equal((await store.load({ identifier: 'MER-1' }))?.attempts, 1);

        await ctx.scheduler.resetItem({ identifier: 'MER-1' });
        assert.equal(await store.load({ identifier: 'MER-1' }), null);

        await ctx.scheduler.tick();
        await waitFor({
            predicate: async () => (await store.load({ identifier: 'MER-1' }))?.parked?.reason === 'attempts_exhausted'
        });

        asRecord(items[0]).state = 'Done';
        clock.advance(1_000);
        await ctx.scheduler.tick();
        await waitFor({ predicate: () => ctx.scheduler.snapshot().parked.length === 0 });
        assert.equal(await store.load({ identifier: 'MER-1' }), null, 'a release clears the record');
        await ctx.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b F1: stop waits for an in-flight park write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createSlowAttemptStore({ dir });
        const ctx = buildScheduler({
            items: [rawItem()],
            attemptStore: store,
            workflow: createWorkflow({ run: async () => failedResult() }),
            options: { limits: { maxAttemptsPerItem: 1 } }
        });
        await ctx.scheduler.start();
        // The park is visible in memory while its 120 ms write is still in flight.
        await waitFor({ predicate: () => ctx.scheduler.snapshot().parked.length === 1 });
        await ctx.scheduler.stop();

        const record = await store.load({ identifier: 'MER-1' });
        assert.equal(record?.parked?.reason, 'attempts_exhausted', 'stop flushed the park to disk');
        assert.equal(record?.attempts, 1);
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b F2: resetItem waits for the in-flight save and is not overwritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createSlowAttemptStore({ dir });
        const ctx = buildScheduler({
            items: [rawItem()],
            attemptStore: store,
            workflow: createWorkflow({ run: async () => failedResult() }),
            options: { limits: { maxAttemptsPerItem: 1 } }
        });
        await ctx.scheduler.start();
        await waitFor({ predicate: () => ctx.scheduler.snapshot().parked.length === 1 });

        await ctx.scheduler.resetItem({ identifier: 'MER-1' });
        assert.equal(await store.load({ identifier: 'MER-1' }), null, 'the clear is ordered after the save');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(await store.load({ identifier: 'MER-1' }), null, 'the earlier save did not resurrect the park');
        await ctx.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b F3: a re-created identifier with a different source id starts fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'old-id',
                attempts: 2,
                continuations: 0,
                parked: null,
                updatedAt: 1
            }
        });
        const workflow = createWorkflow({ run: async () => failedResult() });
        const ctx = buildScheduler({ items: [rawItem()], attemptStore: store, workflow });
        await ctx.scheduler.start();
        await waitFor({ predicate: () => ctx.scheduler.snapshot().retrying.length === 1 });

        assert.equal(workflow.calls.length, 1, 'the old count did not park the new item');
        assert.equal(workflow.calls[0].attempt, 1, 'the dispatch ordinal restarts at 1');
        await ctx.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b F5: a hydrated count at the cap parks instead of dispatching once more', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'id-1',
                attempts: 2,
                continuations: 0,
                parked: null,
                updatedAt: 1
            }
        });
        const workflow = createWorkflow();
        const ctx = buildScheduler({ items: [rawItem()], attemptStore: store, workflow });
        await ctx.scheduler.start();
        await waitFor({
            predicate: async () => (await store.load({ identifier: 'MER-1' }))?.parked?.reason === 'attempts_exhausted'
        });

        assert.equal(workflow.calls.length, 0, 'no extra dispatch at the cap');
        assert.equal(ctx.scheduler.snapshot().parked[0]?.reason, 'attempts_exhausted');
        assert.equal(ctx.scheduler.snapshot().parked[0]?.attempts, 2);
        await ctx.scheduler.stop();
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b F6: attemptStore accepts memory and rejects a malformed store', async () => {
    const memory = buildScheduler({ items: [rawItem()], attemptStore: 'memory' });
    await memory.scheduler.start();
    await waitFor({ predicate: () => memory.scheduler.snapshot().parked.length === 1 });
    assert.equal(memory.workflow.calls.length, 1);
    await memory.scheduler.stop();

    const broken = buildScheduler({
        items: [],
        attemptStore: /** @type {any} */ ({ load: async () => null })
    });
    await assert.rejects(
        () => broken.scheduler.start(),
        (error) => /attemptStore/.test(String(/** @type {Error} */ (error).message))
    );
});

test('P3b race: resetItem during hydration wins and is not re-adopted', async () => {
    for (const offset of [0, 1, 3, 1, 3]) {
        const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
        try {
            const store = createSlowLoadStore({ dir });
            await store.save({
                record: {
                    version: 1,
                    identifier: 'MER-1',
                    id: 'id-1',
                    attempts: 2,
                    continuations: 0,
                    parked: { reason: 'attempts_exhausted', at: 1, nextCheckAt: 10_000_000 },
                    updatedAt: 1
                }
            });
            const ctx = buildScheduler({
                items: [rawItem({ overrides: { dispatchable: false } })],
                attemptStore: store,
                clock: createClock({ now: 1_000 })
            });

            const starting = ctx.scheduler.start();
            if (offset > 0) await new Promise((resolve) => setTimeout(resolve, offset));
            await ctx.scheduler.resetItem({ identifier: 'MER-1' });
            await starting;

            assert.equal(await store.load({ identifier: 'MER-1' }), null, `offset ${offset}: the record stays cleared`);
            assert.equal(ctx.scheduler.snapshot().parked.length, 0, `offset ${offset}: no parked row is re-adopted`);
            await ctx.scheduler.stop();
        } finally {
            await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        }
    }
});

test('P3b F11: list skips a file whose name does not match its record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir });
        await store.save({
            record: {
                version: 1,
                identifier: 'MER-1',
                id: 'id-1',
                attempts: 1,
                continuations: 0,
                parked: null,
                updatedAt: 1
            }
        });
        const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
        assert.equal(names.length, 1);
        await rename(join(dir, names[0]), join(dir, 'hand-copied.json'));
        assert.deepEqual(await store.list(), [], 'a record under a foreign file name is skipped');
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});

test('P3b: two identifiers that slug to one filename keep separate records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempts-'));
    try {
        const store = createFileAttemptStore({ dir });
        const base = { version: /** @type {1} */ (1), continuations: 0, parked: null, updatedAt: 1 };
        await store.save({ record: { ...base, identifier: 'a/b', id: 'id-a', attempts: 1 } });
        await store.save({ record: { ...base, identifier: 'a:b', id: 'id-b', attempts: 2 } });

        const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
        assert.equal(names.length, 2, 'the hash suffix keeps the files apart');
        assert.equal((await store.load({ identifier: 'a/b' }))?.attempts, 1);
        assert.equal((await store.load({ identifier: 'a:b' }))?.attempts, 2);
        const listed = await store.list();
        assert.deepEqual(
            listed.map((record) => [record.identifier, record.attempts]).sort(),
            [['a/b', 1], ['a:b', 2]]
        );
    } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
});
