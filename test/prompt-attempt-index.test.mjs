// @ts-check


/**
 * @file F1-5 / F2-8: the retry index the prompt sees.
 * @version 0.12.0
 *
 * @description
 * The contract's `attempt` is a retry index: `null` on the first dispatch,
 * `1` on the first retry, `2` on the second. The scheduler numbers dispatches
 * from 1 and runs a continuation again as attempt 1, so the renderer needs the
 * dispatch kind: a failure retry at attempt 2 is retry 1, and a continuation at
 * attempt 1 is retry 1 (not a first run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPolicyRenderer, WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import {
    createMemoryClaimStore,
    createMemoryWorkSource,
    WorkScheduler
} from '../lib/agentic/scheduler/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const ITEM = Object.freeze({
    id: 'wi-attempt-1',
    identifier: 'MER-ATTEMPT-1',
    title: 'Render the retry index',
    state: 'Todo',
    dispatchable: true,
    priority: 1,
    labels: [],
    lane: 'Todo'
});

/** A manual clock: recorded timers never fire, so only `tick()` advances work. */
function createClock() {
    let current = Date.parse('2026-11-11T10:00:00.000Z');
    return {
        now: () => current,
        setTimeout: () => 1,
        clearTimeout: () => {},
        advance: (/** @type {number} */ ms) => { current += ms; }
    };
}

/**
 * @param {{template: string}} arg0 -
 * @returns {Promise<{policy: WorkflowPolicy, cleanup: () => Promise<void>}>}
 */
async function createPolicy({ template }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-attempt-index-'));
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, ['---', 'polling:', '  interval_ms: 30000', '---', template].join('\n'));
    const policy = new WorkflowPolicy({ path, watch: false });
    await policy.start();
    return {
        policy,
        cleanup: async () => {
            policy.stop();
            await rm(dir, { recursive: true, force: true });
        }
    };
}

/**
 * @param {{
 *   clock: ReturnType<typeof createClock>,
 *   run: (arg0: {item: Record<string, unknown>, attempt: number|null, continuation?: boolean}) => unknown,
 *   retry?: {baseMs: number, maxMs: number},
 *   continuation?: {delayMs: number, max: number},
 *   emitter?: {emit: (name: string, payload: Record<string, unknown>) => void}
 * }} arg0 -
 * @returns {WorkScheduler}
 */
function createScheduler({ clock, run, retry = { baseMs: 0, maxMs: 0 }, continuation = { delayMs: 0, max: 0 }, emitter = undefined }) {
    return new WorkScheduler({
        workSource: createMemoryWorkSource({ items: [ITEM] }),
        workflow: { run },
        claims: createMemoryClaimStore(),
        clock,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        pollIntervalMs: 60_000,
        retry,
        continuation,
        limits: { maxAttemptsPerItem: 3 },
        ...(emitter === undefined ? {} : { eventEmitter: emitter })
    });
}

/**
 * Wait for the settle continuations a tick starts.
 * @returns {Promise<void>}
 */
async function flush() {
    for (let index = 0; index < 12; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test('F1-5 the first retry renders 1', async () => {
    const { policy, cleanup } = await createPolicy({
        template: 'retry={% if attempt %}{{ attempt }}{% else %}none{% endif %}'
    });
    const render = createPolicyRenderer({ policy });
    try {
        // The mapping itself: dispatch 1 is the first run, dispatch 2 the first retry.
        assert.equal(render({ item: ITEM, attempt: 1 }), 'retry=none');
        assert.equal(render({ item: ITEM, attempt: 2 }), 'retry=1', 'the first retry is retry 1');
        assert.equal(render({ item: ITEM, attempt: 3 }), 'retry=2');
        assert.equal(render({ item: ITEM }), 'retry=none');

        // And the scheduler hands the same index to the prompt it renders.
        const clock = createClock();
        /** @type {string[]} */
        const prompts = [];
        let runs = 0;
        const scheduler = createScheduler({
            clock,
            run: async (/** @type {{item: Record<string, unknown>, attempt: number|null, continuation?: boolean}} */ arg0) => {
                prompts.push(render({ item: arg0.item, attempt: arg0.attempt, continuation: arg0.continuation }));
                runs += 1;
                return runs === 1
                    ? { status: 'failed', error: new Error('transient') }
                    : { status: 'completed' };
            }
        });
        try {
            await scheduler.start();
            await flush();
            await scheduler.tick();
            await flush();
            assert.deepEqual(prompts, ['retry=none', 'retry=1'],
                'the first dispatch has no retry index, its retry has 1');
        } finally {
            await scheduler.stop({ timeoutMs: 2_000 });
        }
    } finally {
        await cleanup();
    }
});

test('F2-8 a continuation renders 1', async () => {
    const { policy, cleanup } = await createPolicy({
        template: 'retry={% if attempt %}{{ attempt }}{% else %}none{% endif %}'
    });
    const render = createPolicyRenderer({ policy });
    const clock = createClock();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    /** @type {Array<{prompt: string, attempt: number|null, continuation: boolean}>} */
    const runs = [];
    const scheduler = createScheduler({
        clock,
        continuation: { delayMs: 0, max: 1 },
        emitter: {
            emit: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ payload) => {
                events.push({ event: name, ...payload });
            }
        },
        run: async (/** @type {{item: Record<string, unknown>, attempt: number|null, continuation?: boolean}} */ arg0) => {
            runs.push({
                prompt: render({ item: arg0.item, attempt: arg0.attempt, continuation: arg0.continuation }),
                attempt: arg0.attempt,
                continuation: arg0.continuation === true
            });
            return { status: 'completed' };
        }
    });
    try {
        await scheduler.start();
        await flush();
        await scheduler.tick();
        await flush();

        assert.equal(runs.length, 2, 'the completion scheduled one continuation');
        assert.deepEqual(runs[0], { prompt: 'retry=none', attempt: 1, continuation: false });
        assert.deepEqual(runs[1], { prompt: 'retry=1', attempt: 1, continuation: true },
            'a continuation is a retry, not a first run');
        const continued = events.filter((envelope) => envelope.event === EVENTS.WORK_ITEM.CONTINUED);
        assert.equal(continued.length, 1);
    } finally {
        await scheduler.stop({ timeoutMs: 2_000 });
        await cleanup();
    }
});
