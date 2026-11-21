// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ERROR_CODES, ProviderType } from '../lib/core/constants/index.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @param {string} [provider] */
/** @param {{provider?: *}} arg0 */
/** @param {{provider?: *}} arg0 */
const userMessages = ({ provider = ProviderType.OPENAI } = {}) => [createUserMessage({ provider, content: 'go' })];

test('C7/T1: the crossing call carries a maxOutputTokens clamp for the remaining budget', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const stepOptions = [];
    let total = 0;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        /** @param {{options: *}} arg0 */
        async *step({ options }) {
            stepOptions.push(options ?? {});
            const completion = Math.min(80, options?.maxOutputTokens ?? 80);
            total += completion;
            yield { type: 'quota', data: { prompt_tokens: 0, completion_tokens: completion } };
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
    };
    let budgetEvents = 0;
    emitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, () => { budgetEvents++; });

    const out = await runAgenticLoop({ session, messages: userMessages(), opts: {
        budget: { maxTotalTokens: 100 },
        maxFollowUps: 1,
        /** @param {{round: *}} arg0 */
        followUp: (/** @type {{ round: number }} */ { round }) => (round < 1 ? 'again' : null),
    } });

    assert.equal(out, 'answer');
    assert.equal(budgetEvents, 0, 'a clamped crossing call stays within the cap');
    assert.equal(stepOptions.length, 2, 'two model calls');
    assert.ok(Number.isFinite(stepOptions[0].maxOutputTokens) && stepOptions[0].maxOutputTokens > 0, 'first call is clamped to the remaining budget');
    assert.ok(Number.isFinite(stepOptions[1].maxOutputTokens) && stepOptions[1].maxOutputTokens > 0, 'the crossing call is clamped, not left unbounded');
    assert.ok(stepOptions[1].maxOutputTokens < stepOptions[0].maxOutputTokens, 'the crossing clamp shrinks with the spent budget');
    assert.ok(total <= 100, `total ${total} must not exceed the cap`);
});

test('C7/T2: a credit-only backend aborts before the first call when the estimate exceeds the cap', async () => {
    const emitter = new EventEmitter();
    let calls = 0;
    const session = {
        provider: ProviderType.JAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            calls++;
            yield { type: 'quota', data: { updated: { current: { amount: 99 }, maximum: { amount: 100 } }, spent: { amount: 1 } } };
            return { done: true, content: 'answer', messages: [] };
        },
    };
    /** @type {any[]} */
    const events = [];
    emitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => events.push(e));

    const error = await runAgenticLoop({ session, messages: userMessages({ provider: ProviderType.JAI }), opts: { budget: { maxTotalTokens: 1 } } })
        .then(() => null, (/** @type {any} */ e) => e);

    assert.ok(error instanceof BudgetExceededError, 'rejects with BudgetExceededError');
    assert.equal(error.code, ERROR_CODES.BUDGET);
    assert.equal(calls, 0, 'no model call is issued — the cap is enforced pre-emptively');
    assert.equal(events.length, 1, 'exactly one budget event');
    assert.equal(events[0].usage.estimated, true, 'credit-only accounting is flagged as estimated, never reported as tokens');
});

test('C7/T3: a step that spends exactly the cap is not followed by another call', async () => {
    const emitter = new EventEmitter();
    let calls = 0;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            calls++;
            yield { type: 'quota', data: { prompt_tokens: 100, completion_tokens: 0 } };
            return { done: true, content: 'answer', messages: [{ role: 'assistant', content: 'answer' }] };
        },
    };
    /** @type {any[]} */
    const events = [];
    emitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => events.push(e));

    const error = await runAgenticLoop({ session, messages: userMessages(), opts: {
        budget: { maxTotalTokens: 100 },
        maxFollowUps: 1,
        followUp: () => 'again',
    } }).then(() => null, (/** @type {any} */ e) => e);

    assert.ok(error instanceof BudgetExceededError);
    assert.equal(calls, 1, 'the stage-2 call is refused before it is issued');
    assert.equal(events.length, 1);
    assert.equal(events[0].usage.total_tokens, 100, 'the reported (not estimated) total rides the event');
    assert.equal(events[0].usage.estimated, undefined, 'reported totals are not flagged estimated');
});

test('C7/T4: the estimate never fabricates token fields in run:end usage', async () => {
    const events = /** @type {any[]} */ ([]);
    let calls = 0;
    const session = {
        provider: ProviderType.JAI,
        model: 'm',
        _tools: [],
        eventEmitter: { emit: /** @type {(...args: any[]) => any} */ ((name, payload) => events.push({ name, payload })) },
        async *step() {
            calls++;
            yield { type: 'quota', data: { updated: { current: { amount: 99 } }, spent: { amount: 1 } } };
            return { done: true, content: 'answer', messages: [] };
        },
    };

    const out = await runAgenticLoop({ session, messages: userMessages({ provider: ProviderType.JAI }), opts: { budget: { maxTotalTokens: 1000 } } });

    assert.equal(out, 'answer');
    assert.equal(calls, 1, 'a cap that the estimate cannot reach still allows the call');
    const runEnd = events.find(e => e.name === EVENTS.CLIENT.RUN_END);
    assert.ok(runEnd, 'run:end is emitted');
    assert.equal(runEnd.payload.usage.prompt_tokens, 0, 'no fabricated prompt tokens');
    assert.equal(runEnd.payload.usage.total_tokens, 0, 'no fabricated total tokens');
    assert.equal(runEnd.payload.usage.estimated, undefined, 'run:end never carries the estimate flag');
});
