// @ts-check
/**
 * E-1 / E-2: one ledger for the whole discussion group.
 *
 * Before the fix every turn received the same `cap - usage` snapshot, so N
 * parallel agents each spent the full remainder (cap 100 -> 180), delegated
 * tasks had a fresh pool each, and a refused turn re-charged the group's whole
 * spend (usage doubled per refusal: 60 -> 120 -> 240 ...).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {{tokens?: number, calls?: {n: number}}} [arg0] */
function makeGroup({ tokens = 60, calls = { n: 0 } } = {}) {
    const stub = {
        provider: ProviderType.OPENAI,
        model: 'm',
        client: null,
        eventEmitter: new EventEmitter(),
        _tools: [],
        _lastStepMessages: null,
        _lastRunUsage: null,
        withSystemMessage() { return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        async *step() {
            calls.n += 1;
            yield { type: 'quota', data: { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens } };
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
        /** @param {any} args */
        async run(args) {
            return runAgenticLoop({ session: /** @type {any} */ (this), messages: args.initialInput, opts: { maxIterations: 4 } });
        },
    };
    const group = new DiscussionSession({
        client: { session: () => stub, /* one session is enough: every turn joins the group ledger */ },
        options: { budget: { maxTotalTokens: 100 } },
    });
    for (const name of ['alpha', 'beta', 'gamma']) {
        group.addAgent({ name, model: 'm', provider: ProviderType.OPENAI });
    }
    return { group, calls };
}

test('parallel turns draw from one pool and stop the group at the cap', async () => {
    const { group, calls } = makeGroup();
    await group.discuss({ instruction: 'go', turns: 1 });
    assert.ok(calls.n <= 2, `the group cap stops the wave, model calls=${calls.n}`);
    const pool = /** @type {any} */ (group)._budgetPool;
    assert.ok(pool, 'the group must own one ledger');
    assert.ok(pool.usage.total_tokens <= 120, `one-call overshoot at most, got ${pool.usage.total_tokens}`);
});

test('a refused turn is not charged again (usage does not double)', async () => {
    const { group, calls } = makeGroup();
    for (let turn = 0; turn < 6; turn++) {
        await group.discuss({ instruction: `go ${turn}`, turns: 1, sequential: true });
    }
    // Two 60-token calls fit under 100 (one-call overshoot); every later turn is
    // refused by the pool and must charge nothing.
    assert.equal(calls.n, 2, `model calls=${calls.n}`);
    assert.equal(group.usageTokens, 120, `usage must not double per refusal, got ${group.usageTokens}`);
    const pool = /** @type {any} */ (group._budgetPool);
    assert.equal(pool.usage.total_tokens, 120);
});

test('a pooled client (scheduler attempt) does not trip the one-session guard (A-3)', async () => {
    const { createBudgetPool } = await import('../lib/agentic/budget-pool.mjs');
    const { pooledClient } = await import('../lib/agentic/pooled-client.mjs');
    const calls = { n: 0 };
    const stub = {
        provider: ProviderType.OPENAI,
        model: 'm',
        eventEmitter: new EventEmitter(),
        _tools: [],
        withSystemMessage() { return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {any} args */
        async run(args) {
            calls.n += 1;
            const { runAgenticLoop } = await import('../lib/agentic/agentic-core.mjs');
            return runAgenticLoop({ session: /** @type {any} */ (this), messages: args.initialInput, opts: args.options ?? {} });
        },
        async *step() {
            yield { type: 'quota', data: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
    };
    const attempt = createBudgetPool();
    const client = pooledClient({ client: /** @type {any} */ ({ session: () => stub }), pool: attempt });
    const group = new DiscussionSession({ client, options: { budget: { maxTotalTokens: 100 } } });
    group.addAgent({ name: 'A', model: 'm', provider: ProviderType.OPENAI });
    await group.discuss({ instruction: 'go', turns: 1, sequential: true });
    assert.equal(group.getLedger().length >= 1, true);
    assert.equal(group.getLedger().some((/** @type {any} */ e) => String(e.content).includes('[error:')), false, 'no AGENT_ERROR from a double attach');
    assert.equal(calls.n, 1);
    assert.equal(attempt.usage.total_tokens, 5, 'the attempt ledger saw the turn');
});
