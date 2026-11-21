// @ts-check


/**
 * @file F1-3: a policy edit that lands after the tick's preflight check must
 * still stop the dispatch.
 * @version 0.12.0
 *
 * @description
 * The tick reads `preflight()` once, before the retry fire and the item scan.
 * A `WORKFLOW.md` edit can break the contract during that same tick (here the
 * work source applies it), and a dispatch decided on the stale answer runs the
 * new prompt under the old config. The scheduler re-checks policy health at
 * claim time, so the item is refused with `claim_failed { reason: 'preflight' }`
 * instead of dispatched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrchestration } from '../lib/agentic/orchestration/facade.mjs';
import { createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** A clock whose timers never fire, so one `start()` is exactly one tick. */
function createClock() {
    return {
        now: () => Date.parse('2026-11-11T10:00:00.000Z'),
        setTimeout: () => 1,
        clearTimeout: () => {}
    };
}

/**
 * A repo-owned contract that resolves to one active state and one item's worth
 * of settings.
 * @param {{root: string, prompt?: string}} arg0 -
 * @returns {string}
 */
function workflowFile({ root, prompt = 'Work on {{ issue.identifier }}.' }) {
    return [
        '---',
        'tracker:',
        '  kind: memory',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        'polling:',
        '  interval_ms: 30000',
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

/** One dispatchable row. */
const ITEM = Object.freeze({
    id: 'wi-midtick-1',
    identifier: 'MER-MIDTICK-1',
    title: 'Land an edit mid-tick',
    state: 'Todo',
    dispatchable: true,
    priority: 1
});

/** @returns {{session: (model: string) => unknown}} */
function createClient() {
    return {
        session: () => {
            /** @type {Record<string, unknown>} */
            const session = {
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

test('F1-3 a preflight error mid-tick stops the dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-facade-midtick-'));
    const file = join(dir, 'WORKFLOW.md');
    const root = join(dir, 'workspaces');
    await writeFile(file, workflowFile({ root }));
    const emitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    emitter.onAny((/** @type {Record<string, unknown>} */ envelope) => events.push(envelope));

    const base = createMemoryWorkSource({ items: [ITEM] });
    /** @type {{reload: () => Promise<{healthy: boolean}>}|null} */
    let orchestration = null;
    let broke = false;
    /** @type {{fetchByStates: Function, fetchByIds: Function}} */
    const workSource = {
        async fetchByStates(/** @type {{states: ReadonlyArray<unknown>, signal?: AbortSignal}} */ arg0) {
            // The startup sweep runs first; the edit must land in the tick that
            // dispatches, after that tick's preflight check.
            if (!broke && arg0.states.includes('Todo')) {
                broke = true;
                // The edit lands after this tick's preflight check already ran.
                await writeFile(file, '---\ntracker: [not-a-map\n---\nbroken');
                const result = await /** @type {{reload: () => Promise<{healthy: boolean}>}} */ (orchestration).reload();
                assert.equal(result.healthy, false, 'the edit broke the contract inside the tick');
            }
            return base.fetchByStates(arg0);
        },
        fetchByIds: (/** @type {{ids: ReadonlyArray<unknown>, signal?: AbortSignal}} */ arg0) => base.fetchByIds(arg0)
    };

    const created = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource,
        workflowFile: file,
        policyOptions: { watch: false },
        emitter,
        scheduler: { clock: createClock(), startupCleanup: false }
    });
    orchestration = created;
    try {
        await created.start();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(created.scheduler.snapshot().totals.dispatches, 0,
            'the broken contract blocked the dispatch');
        assert.equal(events.some((envelope) => envelope.event === EVENTS.WORK_ITEM.DISPATCHED), false);
        const refused = events.filter((envelope) => envelope.event === EVENTS.WORK_ITEM.CLAIM_FAILED);
        assert.deepEqual(refused.map((envelope) => envelope.reason), ['preflight'],
            'the claim was refused because the policy went unhealthy mid-tick');
    } finally {
        await created.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
