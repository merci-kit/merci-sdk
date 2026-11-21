// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ERROR_CODES, ProviderType } from '../lib/core/constants/index.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @param {{ tokens?: any, extra?: Record<string, any> }} [opts] @returns {any} */
function makeSession({ tokens, extra = {} } = {}) {
    const emitter = new EventEmitter();
    const session = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        stepCalls: 0,
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            session.stepCalls++;
            if (tokens) yield { type: 'quota', data: tokens };
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
        ...extra
    };
    return session;
}

const userMessages = () => [createUserMessage({ provider: ProviderType.OPENAI, content: 'go' })];

test('crossing the cap emits run:budget_exceeded and throws BudgetExceededError', async () => {
    const session = makeSession({ tokens: { prompt_tokens: 80, completion_tokens: 40 } });
    /** @type {any[]} */
    const events = [];
    session.eventEmitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => events.push(e));

    const error = await runAgenticLoop({ session, messages: userMessages(), opts: { budget: { maxTotalTokens: 100 } } })
        .then(() => null, (e) => e);

    assert.ok(error instanceof BudgetExceededError, 'rejects with BudgetExceededError');
    assert.equal(error.code, ERROR_CODES.BUDGET);
    assert.equal(error.maxTotalTokens, 100);
    assert.equal((/** @type {any} */ (error)).usage.total_tokens, 120);

    assert.equal(events.length, 1, 'exactly one budget event');
    assert.equal(events[0].maxTotalTokens, 100);
    assert.equal(events[0].usage.total_tokens, 120);
    assert.equal(events[0].usage.prompt_tokens, 80);
});

test('C19: a budget abort reports finishReason budget on run:end', async () => {
    const session = makeSession({ tokens: { prompt_tokens: 200, completion_tokens: 0 } });
    /** @type {any[]} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    await assert.rejects(
        () => runAgenticLoop({ session, messages: userMessages(), opts: { budget: { maxTotalTokens: 100 } } }),
        BudgetExceededError
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0].finishReason, 'budget');
});

test('a run under the cap is unaffected and carries no budget event', async () => {
    const session = makeSession({ tokens: { prompt_tokens: 30, completion_tokens: 10 } });
    /** @type {any[]} */
    const budgetEvents = [];
    /** @type {any[]} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => budgetEvents.push(e));
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));

    const out = await runAgenticLoop({ session, messages: userMessages(), opts: { budget: { maxTotalTokens: 100 } } });

    assert.equal(out, 'answer');
    assert.equal(budgetEvents.length, 0);
    assert.equal(ends[0].usage.total_tokens, 40);
});

test('session._budget (withBudget) caps the run without a per-run option', async () => {
    const session = makeSession({
        tokens: { prompt_tokens: 200, completion_tokens: 0 },
        extra: { _budget: { maxTotalTokens: 100 } }
    });
    await assert.rejects(() => runAgenticLoop({ session, messages: userMessages(), opts: {} }), BudgetExceededError);
});

test('an uncapped run reports usage but never aborts', async () => {
    const session = makeSession({ tokens: { prompt_tokens: 10_000_000, completion_tokens: 10_000_000 } });
    assert.equal(await runAgenticLoop({ session, messages: userMessages(), opts: {} }), 'answer');
});

test('a budget abort is not replayed even with a retry policy configured', async () => {
    const session = makeSession({ tokens: { prompt_tokens: 200, completion_tokens: 0 } });
    await assert.rejects(
        () => runAgenticLoop({ session, messages: userMessages(), opts: {
            budget: { maxTotalTokens: 100 },
            retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 3, jitterMs: 0 })
        } }),
        BudgetExceededError
    );
    assert.equal(session.stepCalls, 1, 'the over-budget attempt was not retried');
});

test('withBudget stores a valid cap and clears on missing/invalid input', () => {
    const builder = new ChatSessionBuilder();
    assert.deepEqual(builder.withBudget({ budget: { maxTotalTokens: 50 } })._budget, { maxTotalTokens: 50 });
    assert.equal(builder.withBudget({ budget: {} })._budget, null);
    assert.equal(builder.withBudget({ budget: { maxTotalTokens: -1 } })._budget, null);
    assert.equal(builder.withBudget({ budget: undefined })._budget, null);
});

test('R7: the cap spans run-level retries (two attempts under the cap, combined over, abort)', async () => {
    const emitter = new EventEmitter();
    let calls = 0;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            calls++;
            // Each attempt reports 60 and dies before its answer, so the retry is
            // what produces the second 60 (B-7: a second call in one attempt would
            // now be refused before it is made — its prompt alone cannot fit).
            yield { type: 'quota', data: { prompt_tokens: 60, completion_tokens: 0 } };
            if (calls === 1) throw Object.assign(new Error('boom'), { statusCode: 503 });
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
    };
    /** @type {any[]} */
    const budgetEvents = [];
    emitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (e) => budgetEvents.push(e));

    const error = await runAgenticLoop({ session, messages: userMessages(), opts: {
        budget: { maxTotalTokens: 100 },
        retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 3, jitterMs: 0 }),
    } }).then(() => null, (e) => e);

    assert.ok(error instanceof BudgetExceededError, `expected BudgetExceededError, got ${error}`);
    assert.equal((/** @type {any} */ (error)).usage.total_tokens, 120, 'the cap must count BOTH attempts (60 + 60)');
    assert.equal(budgetEvents.length, 1);
    assert.equal(budgetEvents[0].usage.total_tokens, 120);
});
