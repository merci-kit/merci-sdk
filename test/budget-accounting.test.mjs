// @ts-check
/**
 * Wave 4: the token-budget enforcement kernel and the shared accounting
 * primitives (`remainingBudget`, `assertBudgetOverspent`, `sumNumericUsage`),
 * plus the two helpers folded into support (`baseClientOf`, `circuitKey`).
 * Boundaries: `>=` before a turn, `>` after a charge.
 */

import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { remainingBudget, assertBudgetOverspent, sumNumericUsage } from '../lib/agentic/budget-accounting.mjs';
import { baseClientOf, CLIENT_VIEW_BASE } from '../lib/support/utils.mjs';
import { circuitKey } from '../lib/support/retry-policy.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';
import { ERROR_CODES } from '../lib/core/constants/index.mjs';

/** @param {any} budget */
const asBudget = (budget) => /** @type {any} */ (budget);

describe('remainingBudget', () => {
    test('returns the budget unchanged when the cap is missing or invalid', () => {
        for (const budget of [undefined, null, { maxTotalTokens: 0 }, { maxTotalTokens: -5 }, { maxTotalTokens: 'nope' }]) {
            assert.equal(remainingBudget({ budget, spent: 10, emit: () => assert.fail('emit must not fire') }), budget);
        }
    });

    test('returns the remainder when spent is below the cap', () => {
        const budget = asBudget({ maxTotalTokens: 100, maxBudgetUsd: 2 });
        assert.deepEqual(remainingBudget({ budget, spent: 30.5 }), { maxTotalTokens: 69.5, maxBudgetUsd: 2 });
    });

    test('spent === cap emits the payload then throws with the >= message', () => {
        const budget = asBudget({ maxTotalTokens: 100 });
        /** @type {Array<any>} */
        const emitted = [];
        assert.throws(
            () => remainingBudget({ budget, spent: 100, emit: (/** @type {any} */ arg) => emitted.push(arg) }),
            (/** @type {any} */ err) => {
                assert.ok(err instanceof BudgetExceededError);
                assert.equal(err.message, 'Token budget exceeded: 100 >= 100.');
                assert.equal(err.code, ERROR_CODES.BUDGET);
                assert.equal(err.maxTotalTokens, 100);
                const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 100 };
                assert.deepEqual(err.usage, usage);
                assert.deepEqual(err.context, usage);
                return true;
            },
        );
        assert.deepEqual(emitted, [{ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 100 }, maxTotalTokens: 100 }]);
    });

    test('divides the remainder across a wave and floors the share', () => {
        const budget = asBudget({ maxTotalTokens: 100 });
        assert.deepEqual(remainingBudget({ budget, spent: 4, divisor: 8, floor: 1 }), { maxTotalTokens: 12 });
        assert.deepEqual(remainingBudget({ budget, spent: 99, divisor: 8, floor: 1 }), { maxTotalTokens: 1 });
        assert.deepEqual(remainingBudget({ budget, spent: 99, divisor: 8, floor: 5 }), { maxTotalTokens: 5 });
    });

    test('divisor 1 returns the whole remainder and still honours an explicit floor', () => {
        assert.deepEqual(remainingBudget({ budget: asBudget({ maxTotalTokens: 100 }), spent: 40 }), { maxTotalTokens: 60 });
        // A one-step wave with a configured swarm floor keeps the old rule.
        assert.deepEqual(remainingBudget({ budget: asBudget({ maxTotalTokens: 100 }), spent: 99, floor: 5 }), { maxTotalTokens: 5 });
    });

    test('round floors a fractional remainder only when the caller asks (wave executor)', () => {
        assert.deepEqual(remainingBudget({ budget: asBudget({ maxTotalTokens: 100.5 }), spent: 0, floor: 1, round: true }), { maxTotalTokens: 100 });
        assert.deepEqual(remainingBudget({ budget: asBudget({ maxTotalTokens: 100 }), spent: 97.5, floor: 2, round: true }), { maxTotalTokens: 2 });
        assert.deepEqual(remainingBudget({ budget: asBudget({ maxTotalTokens: 100.5 }), spent: 0 }), { maxTotalTokens: 100.5 });
    });
});

describe('assertBudgetOverspent', () => {
    test('an exactly-spent cap does not throw or emit', () => {
        assert.doesNotThrow(() => assertBudgetOverspent({
            budget: asBudget({ maxTotalTokens: 100 }), spent: 100, emit: () => assert.fail('emit must not fire'),
        }));
    });

    test('an overrun emits then throws with the > message', () => {
        /** @type {Array<any>} */
        const emitted = [];
        assert.throws(
            () => assertBudgetOverspent({ budget: asBudget({ maxTotalTokens: 100 }), spent: 101, emit: (/** @type {any} */ arg) => emitted.push(arg) }),
            (/** @type {any} */ err) => {
                assert.ok(err instanceof BudgetExceededError);
                assert.equal(err.message, 'Token budget exceeded: 101 > 100.');
                assert.deepEqual(err.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 101 });
                return true;
            },
        );
        assert.deepEqual(emitted, [{ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 101 }, maxTotalTokens: 100 }]);
    });

    test('an invalid or missing cap is a no-op and never mutates spent', () => {
        let spent = 50;
        assert.doesNotThrow(() => assertBudgetOverspent({ budget: undefined, spent, emit: () => assert.fail('emit must not fire') }));
        assert.doesNotThrow(() => assertBudgetOverspent({ budget: asBudget({ maxTotalTokens: 0 }), spent, emit: () => assert.fail('emit must not fire') }));
        assert.equal(spent, 50);
    });
});

describe('sumNumericUsage', () => {
    test('sums into a new object when no accumulator is passed', () => {
        assert.deepEqual(sumNumericUsage({ usage: { a: 1, b: 2.5 } }), { a: 1, b: 2.5 });
        assert.deepEqual(sumNumericUsage({ usage: {} }), {});
    });

    test('adds onto an existing accumulator in place', () => {
        /** @type {Record<string, number>} */
        const into = { a: 10 };
        assert.equal(sumNumericUsage({ usage: { a: 5, b: 1 }, into }), into);
        assert.deepEqual(into, { a: 15, b: 1 });
    });

    test('skips non-numeric, NaN and infinite values', () => {
        assert.deepEqual(sumNumericUsage({ usage: {
            a: 1, s: '2', b: true, nan: NaN, inf: Infinity, ninf: -Infinity, obj: {}, nil: null,
        } }), { a: 1 });
    });

    test('a non-numeric accumulator value is replaced, never concatenated', () => {
        /** @type {Record<string, any>} */
        const into = { a: '5', b: true, c: [2] };
        assert.deepEqual(sumNumericUsage({ usage: { a: 1, b: 1, c: 1 }, into }), { a: 1, b: 1, c: 1 });
    });
});

describe('baseClientOf', () => {
    test('a plain client is its own base', () => {
        const plain = { name: 'plain' };
        assert.equal(baseClientOf({ client: plain }), plain);
    });

    test('follows one and then two view hops to the base client', () => {
        const base = { name: 'base' };
        const one = Object.create(base);
        one[CLIENT_VIEW_BASE] = base;
        assert.equal(baseClientOf({ client: one }), base);

        const two = Object.create(one);
        two[CLIENT_VIEW_BASE] = one;
        assert.equal(baseClientOf({ client: two }), base);
    });

    test('a self-link stops the walk and null/undefined pass through', () => {
        const self = /** @type {any} */ ({ name: 'self' });
        self[CLIENT_VIEW_BASE] = self;
        assert.equal(baseClientOf({ client: self }), self);
        assert.equal(baseClientOf({ client: null }), null);
        assert.equal(baseClientOf({ client: undefined }), undefined);
    });
});

describe('circuitKey', () => {
    test('joins provider and model with a colon', () => {
        assert.equal(circuitKey({ provider: 'jai', model: 'google-gemini-3-8-flash' }), 'jai:google-gemini-3-8-flash');
        assert.equal(circuitKey({ provider: null, model: null }), 'null:null');
    });
});
