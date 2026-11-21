// @ts-check
/**
 * `runWithRetry` consulted the policy for every error, so a `nonRetryable`
 * error — an open breaker, a cassette miss, an aborted stream — was retried
 * whenever the caller supplied a permissive custom policy. Callers patched
 * around it in three places; the retry loop owns the decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runWithRetry } from '../lib/support/retry-policy.mjs';

/** A policy that would retry three times if asked. */
const permissive = {
    /** @param {{attempt: number}} arg0 */
    shouldRetry: ({ attempt }) => ({ retry: attempt < 3, delayMs: 0 }),
};

test('a nonRetryable error is tried once even under a permissive policy', async () => {
    let calls = 0;
    const err = Object.assign(new Error('breaker open'), { nonRetryable: true });
    await assert.rejects(
        runWithRetry({ operation: async () => { calls += 1; throw err; }, policy: permissive }),
        /breaker open/,
    );
    assert.equal(calls, 1);
});

test('a nonRetryable cause is honoured through the chain', async () => {
    let calls = 0;
    const err = new Error('outer', { cause: Object.assign(new Error('cassette miss'), { nonRetryable: true }) });
    await assert.rejects(
        runWithRetry({ operation: async () => { calls += 1; throw err; }, policy: permissive }),
        /outer/,
    );
    assert.equal(calls, 1);
});

test('the public predicates still call a nonRetryable error non-retryable', async () => {
    const { isTransientError, ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const err = Object.assign(new Error('connection lost'), { nonRetryable: true });
    assert.equal(isTransientError({ error: err }), false, 'the task fallback gate reads this');
    assert.equal(new ExponentialBackoffPolicy().shouldRetry({ error: err, attempt: 0 }).retry, false);
});

test('a retryable error still retries under the same policy', async () => {
    let calls = 0;
    await assert.rejects(
        runWithRetry({
            operation: async () => { calls += 1; throw new Error('flaky'); },
            policy: { shouldRetry: ({ attempt }) => ({ retry: attempt < 2, delayMs: 0 }) },
        }),
        /flaky/,
    );
    assert.equal(calls, 3, 'the policy still decides retryable errors');
});
