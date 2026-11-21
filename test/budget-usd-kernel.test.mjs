// @ts-check
/**
 * B-2: the budget kernel must decrement money as well as tokens.
 *
 * Before the fix `remainingBudget` returned `maxBudgetUsd` unchanged, so every
 * StateMachine node (and DAG step / discussion turn) received the whole USD cap.
 * A $1 cap with three $0.60 nodes finished `done` after $1.80.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remainingBudget, assertBudgetOverspent } from '../lib/agentic/budget-accounting.mjs';
import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';

test('remainingBudget subtracts USD and stops at the cap', () => {
    assert.deepEqual(
        { ...remainingBudget({ budget: { maxBudgetUsd: 1 }, spent: 0, spentUsd: 0.6 }) },
        { maxBudgetUsd: 0.4 },
    );
    assert.throws(
        () => remainingBudget({ budget: { maxBudgetUsd: 1 }, spent: 0, spentUsd: 1 }),
        (err) => err instanceof BudgetExceededError && err.maxBudgetUsd === 1,
    );
    // Tokens + USD together: both remainders are returned.
    assert.deepEqual(
        { ...remainingBudget({ budget: { maxTotalTokens: 100, maxBudgetUsd: 2 }, spent: 40, spentUsd: 0.5 }) },
        { maxTotalTokens: 60, maxBudgetUsd: 1.5 },
    );
    // No cap stays a no-op.
    assert.deepEqual({ ...remainingBudget({ budget: {}, spent: 10, spentUsd: 10 }) }, {});
});

test('assertBudgetOverspent fails closed on a USD overrun', () => {
    assert.throws(
        () => assertBudgetOverspent({ budget: { maxBudgetUsd: 1 }, spent: 0, spentUsd: 1.2 }),
        BudgetExceededError,
    );
    assert.doesNotThrow(() => assertBudgetOverspent({ budget: { maxBudgetUsd: 1 }, spent: 0, spentUsd: 1 }));
});

/** A client whose model call reports a fixed usage, with `runStep`'s session shape. */
/** @param {{costUsd?: number, tokens?: number, runs: number[]}} arg0 */
function fakeClient({ costUsd = 0.6, tokens = 20, runs }) {
    return {
        session: () => ({
            provider: 'openai',
            model: 'm',
            withSystemMessage() { return this; },
            withTools() { return this; },
            withParameters() { return this; },
            async run() {
                runs.push(1);
                const usage = { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens, cost_usd: costUsd };
                /** @type {any} */ (this)._lastRunUsage = usage;
                return { result: 'ok', messages: [{ role: 'assistant', content: 'ok' }] };
            },
        }),
    };
}

test('a StateMachine with three $0.60 nodes and a $1 cap refuses the third node', async () => {
    /** @type {number[]} */
    const runs = [];
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', systemPrompt: 'p' },
            { id: 'b', systemPrompt: 'p' },
            { id: 'c', systemPrompt: 'p', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    };
    const sm = new StateMachine({ graph, options: {
        client: fakeClient({ runs }),
        defaultModel: 'm',
        budget: { maxBudgetUsd: 1 },
    } });
    await assert.rejects(() => sm.run(), (err) => err instanceof BudgetExceededError);
    assert.equal(runs.length, 2, 'the third node must be refused before it calls the model');
    assert.ok(sm.usageUsd >= 1.2, `spend stays at one-call overshoot, got ${sm.usageUsd}`);
    assert.notEqual(sm.phase, 'done');
});

test('a $1 cap with two $0.40 nodes still completes', async () => {
    /** @type {number[]} */
    const runs = [];
    const graph = {
        entry: 'a',
        nodes: [{ id: 'a', systemPrompt: 'p' }, { id: 'b', systemPrompt: 'p', terminal: true }],
        edges: [{ from: 'a', to: 'b' }],
    };
    const sm = new StateMachine({ graph, options: {
        client: fakeClient({ runs, costUsd: 0.4 }),
        defaultModel: 'm',
        budget: { maxBudgetUsd: 1 },
    } });
    await sm.run();
    assert.equal(runs.length, 2);
    assert.equal(sm.phase, 'done');
    assert.equal(Math.round(sm.usageUsd * 100) / 100, 0.8);
});
