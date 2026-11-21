// @ts-check
/**
 * The retry classifier and the circuit breaker, one symptom per case:
 * a status must beat the wording (A-3), a bare breaker code is final (A-16),
 * undici's socket codes are transient (A-6), the exhausted rate-limit bucket
 * and the 429-only vendor windows decide the wait (A-4), a caller-caused 4xx
 * is not backend health (A-7), and half-open admits one probe (A-8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BREAKER_OPEN_CODE,
    CircuitBreaker,
    ExponentialBackoffPolicy,
    isNonRetryable,
    isTransientError,
    rateLimitDelayFromError,
    runGuardedStep,
    runWithRetry,
} from '../lib/support/retry-policy.mjs';

/** A policy whose delay is the plain exponential window. */
const deterministic = () => new ExponentialBackoffPolicy({ initialDelayMs: 10, maxDelayMs: 30_000, jitterMs: 0 });

test('A-3 a 400 whose message says connection is not retried', () => {
    const policy = deterministic();
    const error = Object.assign(new Error('connection reset by peer'), { status: 400 });
    assert.equal(policy.shouldRetry({ error, attempt: 0 }).retry, false, 'the status dominates the wording');
    assert.equal(isTransientError({ error }), false, 'the task fallback gate agrees');

    assert.equal(
        policy.shouldRetry({ error: Object.assign(new Error('connection reset by peer'), { status: 429 }), attempt: 0 }).retry,
        true,
        'a retryable 4xx still retries',
    );
    assert.equal(
        policy.shouldRetry({ error: new Error('connection reset by peer'), attempt: 0 }).retry,
        true,
        'the wording still classifies an untyped error',
    );
});

test('A-16 a bare BREAKER_OPEN code is non-retryable', async () => {
    const error = Object.assign(new Error('probe refused'), { code: BREAKER_OPEN_CODE });
    assert.equal(isNonRetryable({ error }), true, 'the code alone is final');

    let calls = 0;
    await assert.rejects(
        runWithRetry({
            operation: async () => { calls += 1; throw error; },
            policy: { shouldRetry: ({ attempt }) => ({ retry: attempt < 3, delayMs: 0 }) },
        }),
        /probe refused/,
    );
    assert.equal(calls, 1, 'the loop refuses it under any policy');
});

test('A-6 an undici socket code is transient', () => {
    const policy = deterministic();
    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED']) {
        const error = Object.assign(new Error('other side closed'), { code });
        assert.equal(policy.shouldRetry({ error, attempt: 0 }).retry, true, `${code} is transient`);
        assert.equal(isTransientError({ error }), true, `${code} is transient for the fallback gate`);
    }
    const chained = new Error('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    assert.equal(isTransientError({ error: chained }), true, 'the cause chain carries it');
});

test('A-4 the exhausted tokens bucket wins', () => {
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: {
            'x-ratelimit-remaining-requests': '99',
            'x-ratelimit-reset-requests': '1',
            'x-ratelimit-remaining-tokens': '0',
            'x-ratelimit-reset-tokens': '4',
        },
    });
    assert.equal(rateLimitDelayFromError({ error }), 4000, 'the empty bucket names its own reset');
    assert.equal(deterministic().shouldRetry({ error, attempt: 0 }).delayMs, 4000);
});

test('A-4 a 500 keeps its backoff', () => {
    const policy = deterministic();
    const windowed = Object.assign(new Error('upstream failed'), { status: 500, headers: { 'x-ratelimit-reset-requests': '2' } });
    const decision = policy.shouldRetry({ error: windowed, attempt: 0 });
    assert.equal(decision.retry, true);
    assert.equal(decision.delayMs, 10, 'a rate-limit window on a 5xx is not a wait');

    const withRetryAfter = Object.assign(new Error('upstream failed'), { status: 500, headers: { 'retry-after': '2' } });
    assert.equal(policy.shouldRetry({ error: withRetryAfter, attempt: 0 }).delayMs, 2000, 'retry-after applies at any status');
});

test('W1-6 a 400 re-wrapping a transient vendor code still retries', () => {
    const policy = deterministic();
    const cases = [
        { label: 'a quota body under a 400', error: Object.assign(new Error('quota'), { status: 400, code: 'rate_limit_exceeded' }) },
        { label: 'an overload body under a 400', error: Object.assign(new Error('overloaded'), { status: 400, type: 'overloaded_error' }) },
    ];
    for (const { label, error } of cases) {
        assert.equal(policy.shouldRetry({ error, attempt: 0 }).retry, true, `${label} retries`);
        assert.equal(isTransientError({ error }), true, `${label} is transient for the fallback gate`);
    }
});

test('W1-11 an exhausted bucket with an unusable reset falls back to backoff', () => {
    const error = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: {
            'x-ratelimit-remaining-tokens': '0',
            'x-ratelimit-reset-tokens': '6m',
            'x-ratelimit-remaining-requests': '99',
            'x-ratelimit-reset-requests': '1',
        },
    });
    assert.equal(
        rateLimitDelayFromError({ error, status: 429 }),
        null,
        'a healthy bucket\'s shorter reset must not stand in for the empty one',
    );
    assert.equal(deterministic().shouldRetry({ error, attempt: 0 }).delayMs, 10, 'the policy backs off on its own terms');
});

test('A-7 three 400s leave the breaker closed', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) {
        await assert.rejects(
            runGuardedStep({
                breaker,
                run: async () => { throw Object.assign(new Error('bad input'), { status: 400 }); },
                onBreakerOpen: () => 'open',
                onFailure: ({ err }) => { throw err; },
            }),
            /bad input/,
        );
    }
    assert.equal(breaker.consecutiveFailures, 0, 'a caller-caused 4xx is not backend health');
    assert.equal(breaker.canRun(), true);

    const outage = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    for (let i = 0; i < 2; i++) {
        await assert.rejects(
            runGuardedStep({
                breaker: outage,
                run: async () => { throw Object.assign(new Error('down'), { status: 503 }); },
                onBreakerOpen: () => 'open',
                onFailure: ({ err }) => { throw err; },
            }),
            /down/,
        );
    }
    assert.equal(outage.canRun(), false, 'a real outage still opens the breaker');
});

test('A-8 only one probe passes after cooldown', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    breaker.recordFailure();
    assert.equal(breaker.canRun(), false);
    await new Promise((resolve) => setTimeout(resolve, 30));

    let started = 0;
    /** @type {() => void} */
    let release = () => { /* replaced below */ };
    const held = new Promise((resolve) => { release = () => resolve(undefined); });
    const ok = () => 'probed';
    const first = runGuardedStep({
        breaker,
        run: async () => { started += 1; await held; return ok(); },
        onBreakerOpen: () => 'refused',
        onFailure: ({ err }) => { throw err; },
    });
    await new Promise((resolve) => { setImmediate(resolve); });
    const second = await runGuardedStep({
        breaker,
        run: async () => { started += 1; return 'second'; },
        onBreakerOpen: () => 'refused',
        onFailure: ({ err }) => { throw err; },
    });
    assert.equal(second, 'refused', 'a concurrent caller is refused');
    assert.equal(started, 1, 'exactly one probe reached the backend');
    release();
    assert.equal(await first, 'probed');
    assert.equal(breaker.consecutiveFailures, 0, 'the successful probe closes the breaker');

    // A probe that ends in a caller-caused 4xx says nothing about the backend:
    // the slot is released instead of wedging the breaker shut.
    const callerFault = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    callerFault.recordFailure();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(runGuardedStep({
        breaker: callerFault,
        run: async () => { throw Object.assign(new Error('bad input'), { status: 400 }); },
        onBreakerOpen: () => 'open',
        onFailure: ({ err }) => { throw err; },
    }), /bad input/);
    assert.equal(callerFault.consecutiveFailures, 1, 'the 400 is not counted');
    assert.equal(callerFault.canRun(), true, 'the probe slot is free again');
});

test('W1-3 asking canRun does not consume the probe slot', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    breaker.recordFailure();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(breaker.canRun(), true, 'the breaker admits a probe');
    assert.equal(breaker.canRun(), true, 'asking is a predicate, not a claim');
    assert.equal(breaker.canRun(), true, 'and it stays pure');

    let ran = 0;
    const out = await runGuardedStep({
        breaker,
        run: async () => { ran += 1; return 'ok'; },
        onBreakerOpen: () => 'refused',
        onFailure: ({ err }) => { throw err; },
    });
    assert.equal(out, 'ok', 'the real attempt is admitted after the questions');
    assert.equal(ran, 1);
    assert.equal(breaker.consecutiveFailures, 0);
});

test('W1-3 a hung probe is re-claimable after the cooldown', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    breaker.recordFailure();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(breaker.beginProbe(), true, 'the slot is claimable');
    assert.equal(breaker.beginProbe(), false, 'a second claim is refused while the probe is out');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(breaker.beginProbe(), true, 'a claim older than the cooldown is stale and recoverable');
    breaker.endProbe();
    assert.equal(breaker.beginProbe(), true, 'a released probe is claimable again');
});
