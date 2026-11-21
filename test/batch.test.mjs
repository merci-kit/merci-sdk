// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { runBatch } from '../lib/support/limiter.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';

/** @param {{ms: number}} arg0 */
/** @param {{ms: *}} arg0 */
const sleep = ({ ms }) => new Promise((r) => setTimeout(r, ms));

describe('runBatch', () => {
    it('never exceeds maxConcurrent and returns input-ordered results', async () => {
        let active = 0;
        let peak = 0;
        const results = await runBatch({ items: [5, 1, 3, 2, 4], worker: async (n) => {
            active++;
            peak = Math.max(peak, active);
            await sleep({ ms: n });
            active--;
            return n * 10;
        }, maxConcurrent: 2 });

        assert.equal(peak, 2);
        assert.deepEqual(results.map((r) => r.value), [50, 10, 30, 20, 40]);
        assert.ok(results.every((r) => r.status === 'fulfilled'));
    });

    it('retries a transient throw per the policy', async () => {
        let calls = 0;
        const [res] = await runBatch({ items: ['x'], worker: async () => {
            calls++;
            if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
            return 'ok';
        }, retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 0, jitterMs: 0 }) });

        assert.equal(res.status, 'fulfilled');
        assert.equal(res.value, 'ok');
        assert.equal(calls, 3);
    });

    it('without a policy a failing item is not retried', async () => {
        let calls = 0;
        const [res] = await runBatch({ items: ['x'], worker: async () => { calls++; throw new Error('nope'); } });
        assert.equal(res.status, 'rejected');
        assert.match(/** @type {Error} */ (res.reason).message, /nope/);
        assert.equal(calls, 1);
    });

    it('reports a rejected item at its index without aborting siblings', async () => {
        const results = await runBatch({ items: [1, 2, 3], worker: async (n) => {
            if (n === 2) throw new Error('bad');
            return n;
        }, maxConcurrent: 3 });

        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[1].status, 'rejected');
        assert.match(/** @type {Error} */ (results[1].reason).message, /bad/);
        assert.equal(results[2].value, 3);
    });

    it('stopOnError throws the first failure reason after draining every item', async () => {
        let ran = 0;
        await assert.rejects(
            () => runBatch({ items: [1, 2, 3], worker: async (n) => {
                ran++;
                if (n === 1) throw new Error('first');
                return n;
            }, stopOnError: true, maxConcurrent: 1 }),
            /first/
        );
        assert.equal(ran, 3, 'the queued siblings still ran');
    });
});

describe('runBatch token cap', () => {
    it('throws BudgetExceededError and stops dispatching once the cap is crossed', async () => {
        const { BudgetExceededError, ConfigurationError } = await import('../lib/core/errors.mjs');
        const started = [];
        const error = await runBatch({ items: [1, 2, 3, 4, 5, 6], worker: async (n) => {
            started.push(n);
            return { tokens: 60 };
        }, maxConcurrent: 1, maxTotalTokens: 100, usageOf: (r) => r.tokens })
            .then(() => null, (e) => e);

        assert.ok(error instanceof BudgetExceededError);
        assert.equal((/** @type {any} */ (error)).usage.total_tokens, 120);
        assert.equal(started.length, 2, 'no item beyond the cap is dispatched');
        assert.ok(error instanceof Error && typeof ConfigurationError === 'function');
    });

    it('requires usageOf when a cap is set', async () => {
        const { ConfigurationError } = await import('../lib/core/errors.mjs');
        await assert.rejects(
            () => runBatch({ items: [1], worker: async () => 1, maxTotalTokens: 10 }),
            ConfigurationError
        );
    });

    it('without a cap the return shape is unchanged', async () => {
        const results = await runBatch({ items: [1, 2, 3], worker: async (n) => n * 2, maxConcurrent: 2 });
        assert.deepEqual(results, [
            { status: 'fulfilled', value: 2 },
            { status: 'fulfilled', value: 4 },
            { status: 'fulfilled', value: 6 },
        ]);
    });
});
