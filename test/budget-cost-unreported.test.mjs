// @ts-check
/**
 * B-9: a partly costed run is not a complete cost.
 *
 * One call reports tokens and a price, the next reports tokens and no price.
 * Before the fix the pool and the run published `cost_usd` as the sum of the
 * costed calls only, counted nothing, and never announced the gap: an
 * unenforceable-USD run read as a precise one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { absorbPoolUsage, ensureBudgetPool, poolUsageSnapshot } from '../lib/agentic/budget-pool.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { attachSessionPool } from '../lib/agentic/pooled-client.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';

/**
 * The subset of a step stream and step result the accounting path reads.
 * @typedef {{type: string, data?: Record<string, number>, content?: string, calls?: Array<Record<string, unknown>>}} FixtureEvent
 * @typedef {{done?: boolean, content?: string, messages?: Array<Record<string, unknown>>}} FixtureStepResult
 * @typedef {(arg0: {messages: Array<Record<string, unknown>>}) => AsyncGenerator<FixtureEvent, FixtureStepResult, unknown>} FixtureStep
 * @typedef {{maxTotalTokens?: number, maxBudgetUsd?: number}|null} FixtureBudget
 */

/**
 * The fixture's own surface: the fields the loop and the pool helpers read from
 * a session, declared so a test can assign them.
 * @typedef {Object} CostSession
 * @property {string} provider
 * @property {string} model
 * @property {import('node:events').EventEmitter} eventEmitter
 * @property {Array<Record<string, unknown>>} _tools
 * @property {Array<Record<string, unknown>>} _lastStepMessages
 * @property {FixtureBudget} [_budget]
 * @property {Record<string, number>} [_lastRunUsage]
 * @property {Array<{maxBudgetUsd?: number, model?: string, unreportedCalls?: number}>} unreported
 * @property {() => CostSession} withSystemMessage
 * @property {() => CostSession} withTools
 * @property {FixtureStep} [step]
 */

/**
 * A session making `costs.length` calls; each reports its own cost (or none).
 * @param {{costs: Array<number|null>, tokens?: number}} arg0
 * @returns {CostSession}
 */
function sessionWithCosts({ costs, tokens = 40 }) {
    const emitter = new EventEmitter();
    let call = 0;
    /** @type {Array<{maxBudgetUsd?: number, model?: string, unreportedCalls?: number}>} */
    const unreported = [];
    emitter.on(EVENTS.CLIENT.BUDGET_UNREPORTED, (/** @type {{maxBudgetUsd?: number, model?: string, unreportedCalls?: number}} */ e) => unreported.push(e));
    const tool = { name: 'noop', description: 'no-op', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) };
    /** @type {CostSession} */
    const session = {
        provider: 'openai',
        model: 'm',
        eventEmitter: emitter,
        _tools: [tool],
        _lastStepMessages: [],
        unreported,
        withSystemMessage() { return session; },
        withTools() { return session; },
        async *step({ messages }) {
            const cost = costs[call] ?? null;
            call += 1;
            yield { type: 'quota', data: {
                prompt_tokens: tokens - 1,
                completion_tokens: 1,
                total_tokens: tokens,
                ...(cost != null ? { cost_usd: cost } : {}),
            } };
            if (call < costs.length) {
                const id = `c${call}`;
                yield { type: 'tool_request', calls: [{ id, name: 'noop', args: {} }] };
                const row = { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'noop', arguments: '{}' } }] };
                return { done: true, content: '', messages: [...messages, row, { role: 'tool', content: '{"ok":true}' }] };
            }
            return { done: true, content: 'done', messages: [...messages, { role: 'assistant', content: 'done' }] };
        },
    };
    return session;
}

function isValidChainOfUnreported() {
    const pool = ensureBudgetPool({ session: { _budget: { maxBudgetUsd: 10 } } });
    if (!pool) throw new Error('pool');
    absorbPoolUsage({ pool, usage: { prompt_tokens: 10, completion_tokens: 0, cost_usd: 0.5 }, estTokens: 0 });
    absorbPoolUsage({ pool, usage: { prompt_tokens: 10, completion_tokens: 0 }, estTokens: 0 });
    return pool;
}

test('B-9 a partly costed run reports the unreported call and emits once', async () => {
    const session = sessionWithCosts({ costs: [0.25, null] });
    session._budget = { maxBudgetUsd: 10 };

    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 3 } });

    const pool = ensureBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.cost_usd, 0.25, 'the reported money is still summed');
    assert.equal(pool.usage.cost_unreported_calls, 1, 'the uncosted call is counted, not treated as free');
    assert.equal(poolUsageSnapshot({ pool }).cost_unreported_calls, 1, 'the snapshot carries the count');
    const runUsage = session._lastRunUsage;
    assert.ok(runUsage, 'the run reports its usage');
    assert.equal(runUsage.cost_unreported_calls, 1, 'the run usage carries the same count');
    assert.equal(session.unreported.length, 1, 'the gap is announced exactly once');
    const notice = session.unreported[0];
    assert.equal(notice.unreportedCalls, runUsage.cost_unreported_calls, 'the notice carries the count the run reports');
    assert.equal(notice.unreportedCalls, poolUsageSnapshot({ pool }).cost_unreported_calls, 'and the pool snapshot agrees');
    assert.equal(notice.maxBudgetUsd, 10, 'the notice names the cap it could not enforce');
    assert.equal(notice.model, 'm', 'and the model it ran');
});

test('B-9 a fully costed run reports no unreported call', async () => {
    const session = sessionWithCosts({ costs: [0.25, 0.25] });
    session._budget = { maxBudgetUsd: 10 };
    /** @type {Array<{usage: Record<string, number>}>} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {{usage: Record<string, number>}} */ e) => ends.push(e));

    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 3 } });

    const pool = ensureBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.cost_unreported_calls, 0);
    const runUsage = session._lastRunUsage;
    assert.ok(runUsage, 'the run reports its usage');
    assert.equal(runUsage.cost_unreported_calls, 0, 'no unreported call');
    assert.equal(session.unreported.length, 0, 'no notice when every call was priced (no unreportedCalls payload is emitted)');
    assert.equal(ends[0].usage.cost_usd, 0.5);
    assert.equal(ends[0].usage.cost_unreported_calls, 0, 'run:end carries the count, and it is zero');
});

test('B-9 the pool counts an estimated charge with no cost', () => {
    const pool = isValidChainOfUnreported();
    assert.equal(pool.usage.cost_unreported_calls, 1);
    assert.equal(pool.usage.total_tokens, 20);
});

/**
 * A session that streams text and reports no usage at all.
 * @returns {CostSession}
 */
function silentSession() {
    const emitter = new EventEmitter();
    /** @type {CostSession} */
    const session = {
        provider: 'openai',
        model: 'm',
        eventEmitter: emitter,
        _tools: [],
        _lastStepMessages: [],
        unreported: [],
        withSystemMessage() { return session; },
        withTools() { return session; },
        async *step() {
            yield { type: 'text', content: 'x'.repeat(400) };
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
    };
    return session;
}

test('W2-8 the pool and the run agree on the unreported-call count', async () => {
    const session = silentSession();
    session._budget = { maxTotalTokens: 10_000 };
    /** @type {Array<{usage: Record<string, number>}>} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {{usage: Record<string, number>}} */ e) => ends.push(e));

    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1 } });

    const pool = ensureBudgetPool({ session });
    assert.ok(pool);
    assert.equal(pool.usage.cost_unreported_calls, 1, 'an estimated call is counted at the pool');
    const runUsage = session._lastRunUsage;
    assert.ok(runUsage, 'the run reports its usage');
    assert.equal(runUsage.cost_unreported_calls, 1, 'and in the run usage');
    assert.equal(ends[0].usage.cost_unreported_calls, pool.usage.cost_unreported_calls, 'both views carry the same count');
});

test('W2-7 an unpriced ancestor USD cap is announced, not read as $0', async () => {
    const parentPool = ensureBudgetPool({ session: { _budget: { maxBudgetUsd: 1 } } });
    if (!parentPool) throw new Error('the parent budget must create a pool');
    const child = sessionWithCosts({ costs: [null] });
    /** @type {Array<{maxBudgetUsd?: number, unreportedCalls?: number}>} */
    const notices = [];
    child.eventEmitter.on(EVENTS.CLIENT.BUDGET_UNREPORTED, (/** @type {{maxBudgetUsd?: number, unreportedCalls?: number}} */ e) => notices.push(e));
    attachSessionPool({ session: child, pool: parentPool });

    await runAgenticLoop({ session: child, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 2 } });

    assert.equal(child._budget, undefined, 'the child has no USD cap of its own');
    assert.equal(parentPool.usage.cost_usd, null, 'the tree ledger never saw a price');
    assert.equal(notices.length, 1, 'the ancestor cap that cannot be enforced is announced once');
    assert.equal(notices[0].maxBudgetUsd, 1, 'the notice names the ancestor cap');
    assert.equal(notices[0].unreportedCalls, parentPool.usage.cost_unreported_calls, 'the count is the ancestor ledger\'s, the one that cannot be enforced');
});

test('W2-7 a priced ancestor USD cap still stops the run', async () => {
    const parentPool = ensureBudgetPool({ session: { _budget: { maxBudgetUsd: 0.5 } } });
    if (!parentPool) throw new Error('the parent budget must create a pool');
    const child = sessionWithCosts({ costs: [1] });
    attachSessionPool({ session: child, pool: parentPool });

    await assert.rejects(
        () => runAgenticLoop({ session: child, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 2 } }),
        (err) => err instanceof BudgetExceededError && err.maxBudgetUsd === 0.5,
    );
});
