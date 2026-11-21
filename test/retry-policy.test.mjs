// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NoRetryPolicy, ExponentialBackoffPolicy, createStreamingRetryPolicy, CircuitBreaker, getCircuitBreaker, runGuardedStep, isTransientError, isNonRetryable, HEADER_TIMEOUT_CODE, BODY_TIMEOUT_CODE, BREAKER_OPEN_CODE, hasTimeoutCode, runWithRetry, rateLimitDelayFromError } from '../lib/support/retry-policy.mjs';
import { setLimits, resetLimits } from '../lib/core/limit-config.mjs';

// ==================================================================================
// NoRetryPolicy
// ==================================================================================

test('NoRetryPolicy: always returns {retry:false, delayMs:0}', () => {
    const p = new NoRetryPolicy();
    const e = new Error('anything');
    const d1 = p.shouldRetry({ error: e, attempt: 0 });
    const d2 = p.shouldRetry({ error: e, attempt: 1 });
    const d3 = p.shouldRetry({ error: e, attempt: 99 });
    assert.deepEqual(d1, { retry: false, delayMs: 0 });
    assert.deepEqual(d2, { retry: false, delayMs: 0 });
    assert.deepEqual(d3, { retry: false, delayMs: 0 });
});

test('NoRetryPolicy: ignores error type and attempt count', () => {
    const p = new NoRetryPolicy();
    const transient = Object.assign(new Error('rate limit'), { status: 429 });
    const permanent = Object.assign(new Error('bad request'), { status: 400 });
    assert.equal(p.shouldRetry({ error: transient, attempt: 0 }).retry, false);
    assert.equal(p.shouldRetry({ error: permanent, attempt: 0 }).retry, false);
});

// ==================================================================================
// ExponentialBackoffPolicy — defaults
// ==================================================================================

test('ExponentialBackoffPolicy: defaults are SOTA streaming scale (maxRetries=3, initialDelayMs=1000, maxDelayMs=30000)', () => {
    const p = new ExponentialBackoffPolicy();
    assert.equal(p.maxRetries, 3);
    assert.equal(p.initialDelayMs, 1000);
    assert.equal(p.maxDelayMs, 30_000);
});

test('createStreamingRetryPolicy: preset matches SOTA scale and accepts overrides', () => {
    const p = createStreamingRetryPolicy();
    assert.equal(p.maxRetries, 2);
    assert.equal(p.initialDelayMs, 500);
    assert.equal(p.maxDelayMs, 30_000);
    const custom = createStreamingRetryPolicy({ overrides: { maxRetries: 1 } });
    assert.equal(custom.maxRetries, 1);
    assert.equal(custom.initialDelayMs, 500);
});

test('ExponentialBackoffPolicy: respects custom options', () => {
    const p = new ExponentialBackoffPolicy({
        maxRetries: 7,
        initialDelayMs: 50,
        maxDelayMs: 5000,
        jitterMs: 250
    });
    assert.equal(p.maxRetries, 7);
    assert.equal(p.initialDelayMs, 50);
    assert.equal(p.maxDelayMs, 5000);
    assert.equal(p.jitterMs, 250);
});

// ==================================================================================
// ExponentialBackoffPolicy — retryability classification
// ==================================================================================

test('ExponentialBackoffPolicy: retries on 429 (rate limit) errors', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100, jitterMs: 0 });
    const err = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    const d = p.shouldRetry({ error: err, attempt: 0 });
    assert.equal(d.retry, true);
    assert.ok(d.delayMs >= 10 && d.delayMs <= 100);
});

test('ExponentialBackoffPolicy: retries on 5xx errors', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    for (const status of [500, 502, 503, 504, 599]) {
        const err = Object.assign(new Error('server error'), { status });
        const d = p.shouldRetry({ error: err, attempt: 0 });
        assert.equal(d.retry, true, `status ${status} should retry`);
    }
});

test('ExponentialBackoffPolicy: retries on connection errors (lowercase message)', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    for (const msg of ['ECONNRESET: connection reset by peer', 'connection refused', 'CONNECTION timeout']) {
        const d = p.shouldRetry({ error: new Error(msg), attempt: 0 });
        assert.equal(d.retry, true, `message "${msg}" should retry`);
    }
});

test('ExponentialBackoffPolicy: retries on rate-limit and timeout messages', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    assert.equal(p.shouldRetry({ error: new Error('Rate limit hit'), attempt: 0 }).retry, true);
    assert.equal(p.shouldRetry({ error: new Error('Request timeout'), attempt: 0 }).retry, true);
});

test('ExponentialBackoffPolicy: does NOT retry on 4xx other than 429', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    for (const status of [400, 401, 403, 404, 422]) {
        const err = Object.assign(new Error('client error'), { status });
        const d = p.shouldRetry({ error: err, attempt: 0 });
        assert.equal(d.retry, false, `status ${status} should NOT retry`);
    }
});

test('ExponentialBackoffPolicy: does NOT retry on errors with no recognizable signature', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const d = p.shouldRetry({ error: new Error('something else entirely'), attempt: 0 });
    assert.equal(d.retry, false);
    assert.equal(d.delayMs, 0);
});

// ==================================================================================
// ExponentialBackoffPolicy — attempt-count upper bound
// ==================================================================================

test('ExponentialBackoffPolicy: stops retrying after maxRetries attempts', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 10, jitterMs: 0 });
    const err = Object.assign(new Error('transient'), { status: 429 });
    assert.equal(p.shouldRetry({ error: err, attempt: 0 }).retry, true);
    assert.equal(p.shouldRetry({ error: err, attempt: 1 }).retry, true);
    assert.equal(p.shouldRetry({ error: err, attempt: 2 }).retry, true);
    assert.equal(p.shouldRetry({ error: err, attempt: 3 }).retry, false, 'attemptCount=3 (i.e. 4th attempt) must not retry');
    assert.equal(p.shouldRetry({ error: err, attempt: 4 }).retry, false);
});

test('ExponentialBackoffPolicy: returns delayMs=0 when refusing to retry', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 10, jitterMs: 0 });
    const err = Object.assign(new Error('transient'), { status: 429 });
    assert.equal(p.shouldRetry({ error: err, attempt: 5 }).delayMs, 0);
});

// ==================================================================================
// ExponentialBackoffPolicy — backoff curve
// ==================================================================================

test('ExponentialBackoffPolicy: backoff is exponential: attempt 0 < attempt 1 < attempt 2 (deterministic with jitterMs: 0)', () => {
    const p = new ExponentialBackoffPolicy({
        maxRetries: 5,
        initialDelayMs: 100,
        maxDelayMs: 100_000,
        jitterMs: 0
    });
    const err = Object.assign(new Error('transient'), { status: 429 });
    const d0 = p.shouldRetry({ error: err, attempt: 0 }).delayMs;
    const d1 = p.shouldRetry({ error: err, attempt: 1 }).delayMs;
    const d2 = p.shouldRetry({ error: err, attempt: 2 }).delayMs;
    assert.equal(d0, 100, 'attempt 0: 100 * 2^0 = 100');
    assert.equal(d1, 200, 'attempt 1: 100 * 2^1 = 200');
    assert.equal(d2, 400, 'attempt 2: 100 * 2^2 = 400');
});

test('ExponentialBackoffPolicy: backoff is capped at maxDelayMs', () => {
    const p = new ExponentialBackoffPolicy({
        maxRetries: 20,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        jitterMs: 0
    });
    const err = Object.assign(new Error('transient'), { status: 429 });
    const d = p.shouldRetry({ error: err, attempt: 10 });
    assert.equal(d.delayMs, 5000, 'capped at maxDelayMs');
});

test('ExponentialBackoffPolicy: full jitter draws uniform [0, capped window]', () => {
    const p = new ExponentialBackoffPolicy({
        maxRetries: 5,
        initialDelayMs: 100,
        maxDelayMs: 100_000,
    });
    const err = Object.assign(new Error('transient'), { status: 429 });
    const samples = new Set();
    for (let i = 0; i < 20; i++) samples.add(p.shouldRetry({ error: err, attempt: 0 }).delayMs);
    assert.ok(samples.size > 1, 'jitter should produce different delays across calls');
    for (const s of samples) {
        assert.ok(s >= 0 && s <= 100, `delay ${s} within full-jitter window [0, 100]`);
    }
    let sum = 0;
    const N = 50;
    for (let i = 0; i < N; i++) sum += p.shouldRetry({ error: err, attempt: 2 }).delayMs;
    assert.ok(sum / N > 50, 'full-jitter mean over [0,400] must clear 50');
});

test('ExponentialBackoffPolicy: typed HEADER_TIMEOUT/BODY_TIMEOUT codes retry without message match', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const header = Object.assign(new Error('unrelated wording'), { code: HEADER_TIMEOUT_CODE });
    assert.equal(p.shouldRetry({ error: header, attempt: 0 }).retry, true, 'HEADER_TIMEOUT code retries');
    const body = Object.assign(new Error('unrelated wording'), { code: BODY_TIMEOUT_CODE });
    assert.equal(p.shouldRetry({ error: body, attempt: 0 }).retry, true, 'BODY_TIMEOUT code retries');
    const chained = new Error('fetch failed');
    chained.cause = Object.assign(new Error('stall'), { code: HEADER_TIMEOUT_CODE });
    assert.equal(p.shouldRetry({ error: chained, attempt: 0 }).retry, true, 'code on the cause chain retries');
    assert.equal(hasTimeoutCode({ error: header }), true);
    assert.equal(hasTimeoutCode({ error: new Error('plain') }), false);
});

// ==================================================================================
// ExponentialBackoffPolicy — Retry-After honoring
// ==================================================================================

test('ExponentialBackoffPolicy: honors retry-after seconds over exponential backoff', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100, jitterMs: 0 });
    const err = Object.assign(new Error('rate limited'), { status: 429, headers: { get: /** @type {(...args: any[]) => any} */ ((n) => (n === 'retry-after' ? '2' : null)) } });
    const d = p.shouldRetry({ error: err, attempt: 0 });
    assert.equal(d.retry, true);
    assert.equal(d.delayMs, 2000, 'server hint (2s) wins over the 10ms exponential window');
});

test('ExponentialBackoffPolicy: retry-after-ms is preferred over retry-after, and a hint above the cap is ignored', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const both = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { get: (/** @type {string} */ n) => (n === 'retry-after-ms' ? '1500' : n === 'retry-after' ? '10' : null) },
    });
    assert.equal(p.shouldRetry({ error: both, attempt: 0 }).delayMs, 1500, 'retry-after-ms wins');
    const huge = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { get: (/** @type {string} */ n) => (n === 'retry-after' ? '600' : null) },
    });
    assert.equal(p.shouldRetry({ error: huge, attempt: 0 }).delayMs, 10, 'a hint above retry_after_max_ms is ignored → exponential backoff, not a 60s clamp');
});

test('ExponentialBackoffPolicy: retry-after as an HTTP-date is converted to a delay', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const when = new Date(Date.now() + 5000).toUTCString();
    const err = Object.assign(new Error('rate limited'), { status: 429, headers: { get: (/** @type {string} */ n) => (n === 'retry-after' ? when : null) } });
    const d = p.shouldRetry({ error: err, attempt: 0 }).delayMs;
    assert.ok(d > 3000 && d <= 5000, `HTTP-date hint ~5s, got ${d}`);
});

test('ExponentialBackoffPolicy: reads Retry-After from a Headers-like or nested cause', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const headers = { get: (/** @type {string} */ n) => (n === 'retry-after' ? '3' : null) };
    const chained = Object.assign(new Error('fetch failed'), { status: 429 });
    chained.cause = Object.assign(new Error('429'), { headers });
    assert.equal(p.shouldRetry({ error: chained, attempt: 0 }).delayMs, 3000, 'hint on the cause chain is honored');
});

test('ExponentialBackoffPolicy: an unusable retry-after / retry-after-ms is IGNORED, not clamped', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 100, jitterMs: 0 });
    /** @param {Record<string, string>} headers */
    const withHeaders = (headers) => Object.assign(new Error('rate limited'), { status: 429, headers });
    assert.equal(p.shouldRetry({ error: withHeaders({ 'retry-after': '120' }), attempt: 0 }).delayMs, 100, '120s is above the 60s cap → exponential, not 60s');
    assert.equal(p.shouldRetry({ error: withHeaders({ 'retry-after': '0' }), attempt: 0 }).delayMs, 100, '0 is not "retry now" → exponential');
    assert.equal(p.shouldRetry({ error: withHeaders({ 'retry-after': '-5' }), attempt: 0 }).delayMs, 100, 'negative → exponential');
    assert.equal(p.shouldRetry({ error: withHeaders({ 'retry-after-ms': '-1' }), attempt: 0 }).delayMs, 100, 'negative ms → the default');
    assert.equal(p.shouldRetry({ error: withHeaders({ 'retry-after-ms': '1500' }), attempt: 0 }).delayMs, 1500, 'a usable ms hint still wins');
    assert.equal(p.shouldRetry({ error: withHeaders({ 'retry-after': '0.5' }), attempt: 0 }).delayMs, 500, 'fractional seconds are usable');
});

test('rateLimitDelayFromError: a compound vendor duration (6m0s) parses in full', () => {
    try {
        // The 60s window is the policy's guard, not the parser's limit.
        setLimits({ values: { retry_after_max_ms: 4_000_000 } });
        /** @param {string} raw */
        const delay = (raw) => rateLimitDelayFromError({
            error: Object.assign(new Error('rate limited'), { status: 429, headers: { 'x-ratelimit-reset-tokens': raw } }),
        });
        assert.equal(delay('6m0s'), 360_000, 'the shape OpenAI actually sends');
        assert.equal(delay('1h2m3s'), 3_723_000, 'hours chain too');
        assert.equal(delay('500ms'), 500, 'single ms unit keeps working');
        assert.equal(delay('20'), 20_000, 'a bare number is seconds');
        assert.equal(delay('6m0x'), null, 'trailing junk is not a duration');
    } finally {
        resetLimits();
    }
    const ignored = Object.assign(new Error('rate limited'), { status: 429, headers: { 'x-ratelimit-reset-tokens': '6m0s' } });
    assert.equal(rateLimitDelayFromError({ error: ignored }), null, 'beyond the default 60s window → ignored like any other hint');
});

test('ExponentialBackoffPolicy: a 6m0s reset hint falls back to exponential backoff at the default limit', () => {
    const policy = new ExponentialBackoffPolicy({ initialDelayMs: 100, maxDelayMs: 10_000, jitterMs: 0 });
    const error = Object.assign(new Error('rate limited'), { status: 429, headers: { 'x-ratelimit-reset-tokens': '6m0s' } });
    assert.equal(policy.shouldRetry({ error, attempt: 0 }).delayMs, 100, 'the parsed duration is still subject to the 60s window');
});

// ==================================================================================
// ExponentialBackoffPolicy — vendor error codes (.type / .code)
// ==================================================================================

test('ExponentialBackoffPolicy: a transient vendor code retries with no status', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    /** @type {Array<{label: string, error: any}>} */
    const cases = [
        { label: 'overloaded_error', error: Object.assign(new Error('overloaded'), { type: 'overloaded_error' }) },
        { label: 'rate_limit_error', error: Object.assign(new Error('slow down'), { type: 'rate_limit_error' }) },
        { label: 'server_error', error: Object.assign(new Error('boom'), { code: 'server_error' }) },
        { label: 'rate_limit_exceeded', error: Object.assign(new Error('quota'), { code: 'rate_limit_exceeded' }) },
    ];
    for (const { label, error } of cases) {
        assert.equal(error.status, undefined, `${label} carries no status`);
        assert.equal(p.shouldRetry({ error, attempt: 0 }).retry, true, `${label} retries`);
        assert.equal(isTransientError({ error }), true, 'the task fallback gate agrees');
    }
});

test('ExponentialBackoffPolicy: a fatal vendor code never retries, even behind a 500 or 429', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    for (const code of ['invalid_request_error', 'authentication_error', 'invalid_prompt', 'invalid_image_format', 'image_too_large']) {
        for (const status of [undefined, 500, 429]) {
            const error = Object.assign(new Error('nope'), { code, ...(status ? { status } : {}) });
            assert.equal(p.shouldRetry({ error, attempt: 0 }).retry, false, `${code} at ${status ?? 'no status'} is final`);
            assert.equal(isTransientError({ error }), false);
            assert.equal(isNonRetryable({ error }), true, 'the retry loop honours it for every policy');
        }
    }
    const anthropicTyped = Object.assign(new Error('bad key'), { type: 'authentication_error', status: 500 });
    assert.equal(p.shouldRetry({ error: anthropicTyped, attempt: 0 }).retry, false, 'Anthropic carries the verdict in .type');
});

test('ExponentialBackoffPolicy: a vendor code is read through the cause chain, nearest first', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const transientCause = new Error('fetch failed', { cause: Object.assign(new Error('overloaded'), { type: 'overloaded_error' }) });
    assert.equal(p.shouldRetry({ error: transientCause, attempt: 0 }).retry, true, 'a wrapped transient code still retries');
    const fatalCause = new Error('fetch failed', { cause: Object.assign(new Error('bad prompt'), { code: 'invalid_prompt', status: 500 }) });
    assert.equal(p.shouldRetry({ error: fatalCause, attempt: 0 }).retry, false, 'a wrapped fatal code is still final');
});

// ==================================================================================
// ExponentialBackoffPolicy — status set and x-should-retry
// ==================================================================================

test('ExponentialBackoffPolicy: retries 408, 409, 429 and >=500 (501 included, as the OpenAI SDK did)', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    for (const status of [408, 409, 429, 500, 501, 502, 503, 599]) {
        assert.equal(p.shouldRetry({ error: Object.assign(new Error('failed'), { status }), attempt: 0 }).retry, true, `status ${status} retries`);
    }
    for (const status of [400, 401, 404, 422]) {
        assert.equal(p.shouldRetry({ error: Object.assign(new Error('failed'), { status }), attempt: 0 }).retry, false, `status ${status} does not retry`);
    }
});

test('ExponentialBackoffPolicy: x-should-retry overrides the status in both directions', () => {
    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    const forced = Object.assign(new Error('bad request'), { status: 400, headers: { 'x-should-retry': 'true' } });
    assert.equal(p.shouldRetry({ error: forced, attempt: 0 }).retry, true, 'true forces a retry on a 400');
    const forbidden = Object.assign(new Error('unavailable'), {
        status: 503,
        headers: { get: (/** @type {string} */ n) => (n === 'x-should-retry' ? 'FALSE' : null) },
    });
    assert.equal(p.shouldRetry({ error: forbidden, attempt: 0 }).retry, false, 'FALSE (case-insensitive) forbids a retry on a 503');
    const unrecognised = Object.assign(new Error('unavailable'), { status: 503, headers: { 'x-should-retry': 'maybe' } });
    assert.equal(p.shouldRetry({ error: unrecognised, attempt: 0 }).retry, true, 'an unrecognised verdict is ignored');
    const nested = Object.assign(new Error('bad request'), {
        status: 400,
        response: { headers: new Headers({ 'x-should-retry': 'TRUE' }) },
    });
    assert.equal(p.shouldRetry({ error: nested, attempt: 0 }).retry, true, 'read from error.response.headers like retry-after');
});

// ==================================================================================
// ExponentialBackoffPolicy — our own deadline and caller aborts
// ==================================================================================

test('createTimeoutError: retryable by code and by message; a caller abort is not', async () => {
    const { createTimeoutError, createAbortError } = await import('../lib/backends/transport/errors.mjs');
    const err = createTimeoutError();
    assert.equal(err.message, 'Request timed out.', 'the OpenAI message is unchanged');
    assert.equal(Object.hasOwn(err, 'code'), true, 'code is an own property');
    assert.equal(/** @type {any} */ (err).code, HEADER_TIMEOUT_CODE);

    const p = new ExponentialBackoffPolicy({ initialDelayMs: 10, jitterMs: 0 });
    assert.equal(p.shouldRetry({ error: err, attempt: 0 }).retry, true, 'the 600s deadline is retryable by code');
    const untyped = new Error('Request timed out.');
    assert.equal(p.shouldRetry({ error: untyped, attempt: 0 }).retry, true, '…and by message when the code is lost');
    assert.equal(isTransientError({ error: err }), true);
    assert.equal(isTransientError({ error: untyped }), true);

    const callerAbort = createAbortError({ cause: 'user hangup' });
    assert.equal(p.shouldRetry({ error: callerAbort, attempt: 0 }).retry, false, 'a caller abort is not retryable');
    assert.equal(isTransientError({ error: callerAbort }), false);

    const signalTimeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assert.equal(p.shouldRetry({ error: signalTimeout, attempt: 0 }).retry, false, "a host's AbortSignal.timeout() is a caller cancel");
    const wrapped = createAbortError({ cause: signalTimeout });
    assert.equal(p.shouldRetry({ error: wrapped, attempt: 0 }).retry, false, 'an AbortError whose reason is a host timeout is still a cancel');
});

// ==================================================================================
// ExponentialBackoffPolicy — custom isRetryable predicate
// ==================================================================================

test('ExponentialBackoffPolicy: custom isRetryable predicate overrides default classification', () => {
    const p = new ExponentialBackoffPolicy({
        maxRetries: 3,
        initialDelayMs: 10,
        jitterMs: 0,
        isRetryable: (err) => err.message === 'please retry me'
    });
    assert.equal(p.shouldRetry({ error: new Error('please retry me'), attempt: 0 }).retry, true);
    assert.equal(p.shouldRetry({ error: Object.assign(new Error('rate limit'), { status: 429 }), attempt: 0 }).retry, false);
    assert.equal(p.shouldRetry({ error: new Error('whatever'), attempt: 0 }).retry, false);
});

test('runWithRetry: maxElapsedMs budget skips retries that would overshoot the deadline', async () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30_000, jitterMs: 0 });
    let calls = 0;
    const op = async () => { calls++; throw Object.assign(new Error('boom'), { status: 503 }); };
    const err = await runWithRetry({ operation: op, policy: p, maxElapsedMs: 500 }).catch((e) => e);
    assert.equal(err.message, 'boom');
    assert.equal(calls, 1, 'first backoff (1000ms) already overshoots the 500ms budget');
});

test('runWithRetry: unbounded budget (default) retries per policy', async () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5, jitterMs: 0 });
    let calls = 0;
    const op = async () => { calls++; if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 }); return 'ok'; };
    assert.equal(await runWithRetry({ operation: op, policy: p }), 'ok');
    assert.equal(calls, 3);
});

test('runWithRetry: a 429 carrying retry-after: 120 retries on the exponential window, not 60s', async () => {
    const policy = new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 5, maxDelayMs: 10, jitterMs: 0 });
    /** @type {number[]} */
    const delays = [];
    let calls = 0;
    const out = await runWithRetry({
        operation: async () => {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '120' } });
            return 'ok';
        },
        policy,
        onRetry: ({ nextDelayMs }) => delays.push(nextDelayMs),
    });
    assert.equal(out, 'ok');
    assert.equal(calls, 2, 'exactly one retry');
    assert.deepEqual(delays, [5], 'the loop slept the 5ms exponential delay, not a clamped 60000 or a raw 120000');
});

// ==================================================================================
// CircuitBreaker
// ==================================================================================

test('CircuitBreaker: closed by default; opens at the threshold', () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    assert.equal(b.canRun(), true);
    b.recordFailure();
    b.recordFailure();
    assert.equal(b.canRun(), true);
    b.recordFailure();
    assert.equal(b.canRun(), false, 'open at 3 consecutive failures');
});

test('CircuitBreaker: success closes it; aborts must not trip it (caller records only real failures)', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    assert.equal(b.canRun(), true, 'one success resets the count');
});

test('CircuitBreaker: half-open probe allowed after cooldown', async () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    b.recordFailure();
    assert.equal(b.canRun(), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(b.canRun(), true, 'cooldown expiry allows one probe');
    b.recordFailure();
    assert.equal(b.canRun(), false, 'failed probe re-opens');
});

test('getCircuitBreaker: client-scoped registry shares instances per key', () => {
    const client = {};
    const a = getCircuitBreaker({ client, key: 'jai:m1' });
    const b = getCircuitBreaker({ client, key: 'jai:m1' });
    const c = getCircuitBreaker({ client, key: 'jai:m2' });
    assert.equal(a, b, 'same key shares the breaker');
    assert.notEqual(a, c, 'different keys isolate');
    a.recordFailure();
    assert.equal(b.consecutiveFailures, 1, 'shared state visible');
});

test('isTransientError: transient shapes true, permanent shapes false', () => {
    assert.equal(isTransientError({ error: Object.assign(new Error('x'), { status: 429 }) }), true);
    assert.equal(isTransientError({ error: Object.assign(new Error('x'), { status: 503 }) }), true);
    assert.equal(isTransientError({ error: Object.assign(new Error('stall'), { code: HEADER_TIMEOUT_CODE }) }), true);
    assert.equal(isTransientError({ error: Object.assign(new Error('x'), { status: 400 }) }), false);
    assert.equal(isTransientError({ error: new Error('something else entirely') }), false);
});

// ==================================================================================
// ==================================================================================

test('runGuardedStep: open breaker takes onBreakerOpen without running', async () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    b.recordFailure();
    let ran = false;
    const out = await runGuardedStep({
        breaker: b,
        run: /** @type {any} */ (() => { ran = true; return 'x'; }),
        onBreakerOpen: () => 'open-path',
        /** @param {{err: *}} arg0 */
        onFailure: ({ err }) => { throw err; },
    });
    assert.equal(out, 'open-path');
    assert.equal(ran, false, 'doomed attempt skipped');
});

test('runGuardedStep: success records, failure records, abort and BREAKER_OPEN do not', async () => {
    const ok = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });
    await runGuardedStep({ breaker: ok, run: async () => 'v', onBreakerOpen: () => 'o', onFailure: (e) => { throw e; } });
    assert.equal(ok.consecutiveFailures, 0);

    const bad = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });
    await assert.rejects(() => runGuardedStep({
        breaker: bad, run: async () => { throw Object.assign(new Error('down'), { status: 503 }); },
        onBreakerOpen: () => 'o', onFailure: (e) => { throw e; },
    }));
    assert.equal(bad.consecutiveFailures, 1, 'genuine failure trips');

    const aborted = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });
    const ctl = new AbortController();
    ctl.abort('hangup');
    await assert.rejects(() => runGuardedStep({
        breaker: aborted, signal: ctl.signal, run: async () => { throw new Error('mid-abort'); },
        onBreakerOpen: () => 'o', onFailure: (e) => { throw e; },
    }));
    assert.equal(aborted.consecutiveFailures, 0, 'caller hangup is not backend health');

    const openRej = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });
    await assert.rejects(() => runGuardedStep({
        breaker: openRej,
        run: async () => { throw Object.assign(new Error('open downstream'), { code: BREAKER_OPEN_CODE }); },
        onBreakerOpen: () => 'o', onFailure: (e) => { throw e; },
    }));
    assert.equal(openRej.consecutiveFailures, 0, 'no double-count on nested open breaker');
});

test('runGuardedStep: null breaker is a transparent pass-through', async () => {
    const out = await runGuardedStep({ run: async () => 42, onBreakerOpen: () => 0, onFailure: (e) => { throw e; } });
    assert.equal(out, 42);
});

// ─── hostile errors: getter-throwing properties never break the loop ─────────

test('a hostile error (throwing message getter) rethrows the ORIGINAL error, not the policy crash', async () => {
    const { runWithRetry, ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const evil = new Error('the-real-failure');
    Object.defineProperty(evil, 'message', { get() { throw new Error('getter exploded'); } });
    await assert.rejects(
        () => runWithRetry({ operation: async () => { throw evil; }, policy: new ExponentialBackoffPolicy({ maxRetries: 1, jitterMs: 0 }) }),
        (/** @type {any} */ e) => e === evil,
        'the real error must surface (the policy crash is demoted to a warning)'
    );
});

test('a hostile error still produces a JSON-safe api_retry envelope and retries', async () => {
    const { runWithRetry, ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const evil = new Error('boom');
    Object.defineProperty(evil, 'message', { get() { throw new Error('getter exploded'); } });
    Object.defineProperty(evil, 'name', { get() { throw new Error('name exploded'); } });
    /** @type {any[]} */
    const envelopes = [];
    let attempts = 0;
    /** @param {{error: *}} arg0 */
    const out = await runWithRetry({ operation: async () => { attempts += 1; if (attempts === 1) throw evil; return 'ok'; }, policy: new ExponentialBackoffPolicy({ maxRetries: 1, jitterMs: 0, isRetryable: () => true }), onRetry: /** @type {(...args: any[]) => any} */ (({ error }) => envelopes.push({ error })) });
    assert.equal(out, 'ok', 'the loop must survive the hostile error and retry');
    assert.equal(envelopes.length, 1);
    assert.deepEqual(envelopes[0].error, { name: 'Error', message: 'unserializable error' });
    assert.equal(JSON.stringify(envelopes[0].error), '{"name":"Error","message":"unserializable error"}', 'envelope stays JSON-safe');
});
