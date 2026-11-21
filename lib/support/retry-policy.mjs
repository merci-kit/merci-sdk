// @ts-check




/**
 * @file Pluggable retry policies for SDK API calls.
 * @version 0.12.0
 *
 * @description
 * A `RetryPolicy` decides whether a failed API call should be retried and how
 * long to wait before the retry. The policy is consulted by the caller after
 * a fetch attempt throws (or returns a non-OK response). The default
 * `NoRetryPolicy` matches the current behavior of AAI/GAI (no retries on the
 * vendor SDK call itself; JAI's 401 handling lives in `_fetchWithRetry`); the
 * `ExponentialBackoffPolicy` matches the current behavior of OAI's `embed()`
 * method (connection / rate-limit / timeout / 429 / 5xx with capped
 * exponential backoff and full jitter). `runWithRetry` is the shared loop that drives any
 * policy with abort-aware backoff — one implementation instead of three.
 *
 * Retryability: 408, 409, 429 and every status >= 500. 501 stays in because
 * the OpenAI SDK we replaced retried it (Google's client does not). No other
 * 4xx is retried. The server's `x-should-retry: true|false` header is read
 * before the status and message heuristics: `true` forces a retry, `false`
 * forbids one even for 429/5xx, and an unrecognised value is ignored. The one
 * exception is a fatal vendor code (`code`/`type`), which is final and is
 * checked before the header: a deterministic failure must not be retried just
 * because a gateway asked for it.
 *
 * Vendor error codes are read from `.type` and `.code` on the error and its
 * `cause` chain, because a stream `error` event carries no status at all:
 * `overloaded_error`, `rate_limit_error`, `server_error` and
 * `rate_limit_exceeded` retry on their own, and a code naming a permanent
 * failure (`invalid_request_error`, `authentication_error`,
 * `permission_error`, `not_found_error`, `invalid_prompt`, the policy codes and
 * the whole `invalid_image*` / `image_*` family of the OpenAI
 * `ResponseErrorCode` enum) is never retried, not even behind a 500/429.
 *
 * Rate-limit hints: `rateLimitDelayFromError` reads the vendor's rate-limit
 * headers in this precedence:
 *   1. `retry-after-ms`
 *   2. `retry-after` (seconds or an HTTP-date)
 *   3. The vendor windows: a bucket that reports `…-remaining: 0`
 *      (`x-ratelimit-remaining-requests` / `-tokens`, the
 *      `anthropic-ratelimit-requests-*` / `-tokens-*` pair) names the wait
 *      through its own reset — waiting on a bucket that still holds volume
 *      retries into the same limit. With every bucket still holding volume the
 *      later of the resets wins. OpenAI resets are seconds or a compound
 *      duration (`6m`, `6m0s`, `1h2m3s`), Anthropic's an RFC3339 timestamp or
 *      seconds. An empty bucket whose own reset is unusable (absent,
 *      unparsable, past `retry_after_max_ms`) cancels the whole family — the
 *      policy backs off on its own terms instead of borrowing a healthy
 *      bucket's shorter reset and walking into the empty one again.
 * Windows are a wait only on a 429: a 5xx keeps its own backoff, while
 * `retry-after` / `retry-after-ms` apply at any status. The status comes from
 * `getErrorStatus`, so a 400 whose message says "connection" is never retried
 * on its wording.
 * A hint that is zero, negative, non-finite or above `retry_after_max_ms`
 * (60s by default) is IGNORED, not clamped: the call falls back to the
 * policy's own backoff, exactly as the OpenAI SDK treats a `retry-after`
 * outside `(0, 60s]`. The Anthropic SDK honours `retry-after` with no upper
 * bound; we deliberately do not, because one proxy-set `retry-after: 3600`
 * would otherwise stall every attempt for an hour.
 * The headers are read from the error itself, from `error.response.headers`
 * (a `Headers` instance or a plain object) and from every error in the
 * `cause` chain. `retryAfterFromError` keeps its original contract (only
 * `retry-after-ms` / `retry-after`) for backwards compatibility.
 *
 * Deliberately different from the vendors: the fallback backoff is full jitter
 * over the whole capped window (`random(0, min(cap, base * 2^attempt))`), not
 * their fixed or decorrelated variants, so parallel callers do not retry in
 * lockstep.
 *
 * @example
 * const { NoRetryPolicy, ExponentialBackoffPolicy } = await import('./retry-policy.mjs');
 * const noop = new NoRetryPolicy();
 * noop.shouldRetry({ error: new Error('whatever'), attempt: 0 });  // { retry: false, delayMs: 0 }
 *
 * const exp = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
 * exp.shouldRetry({ error: errorWithStatus429, attempt: 0 });     // { retry: true, delayMs: ~0..1000 }
 */
import { AbortedError } from './../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { getErrorStatus, sdkWarn, baseClientOf } from './utils.mjs';
import { TIMEOUT_CODES } from '../core/constants/limits.mjs';
/**
 * An Error that may carry the ad-hoc `.code` field (typed timeout/breaker
 * codes) and a `.cause` chain the SDK walks.
 * @typedef {Error & { code?: string, cause?: unknown }} ErrWithCode
 */


/**
 * @typedef {Object} RetryDecision
 * @property {boolean} retry - Whether the caller should retry the failed operation.
 * @property {number} delayMs - How long the caller should wait before the retry (0 when retry is false).
 */

/**
 * @typedef {Object} RetryEvent
 * @property {string|null} vendor
 * @property {number} attempt - Zero-based index of the failed attempt.
 * @property {number} nextDelayMs
 * @property {{name: string, message: string, status?: number}} error - A summary (`describeError`), never the error itself.
 */

/**
 * The session fields the vendor-call retry reads: its policy, its elapsed
 * budget, and whether the session already owns the retry.
 * @typedef {Object} RetrySession
 * @property {{shouldRetry: Function}|null} [_retryPolicy]
 * @property {number|null} [_maxElapsedMs]
 * @property {Function} [_openFirstEvent] - Present when the session opens the vendor call inside its own retry.
 */

/**
 * @typedef {Object} RetryPolicy
 * @property {(arg0: { error: unknown, attempt: number }) => RetryDecision} shouldRetry
 *   Decide whether a failed call should be retried. Called by the consumer
 *   after a thrown error or non-OK response. The consumer is responsible for
 *   enforcing the delay (with `await new Promise(r => setTimeout(r, delayMs))`)
 *   and for honoring the `maxRetries` / `maxAttempts` upper bound — the policy
 *   is consulted once per failed attempt.
 */



/**
 * Machine-readable code carried by header-timeout abort errors (JAI gateway
 * accepted the connection but sent no response headers in time). Matched
 * structurally by the retry policy — message-substring matching is the
 * compat fallback, not the contract.
 */
export const HEADER_TIMEOUT_CODE = 'HEADER_TIMEOUT';

/** Machine-readable code for response-body stalls (headers arrived, body dripped). */
export const BODY_TIMEOUT_CODE = 'BODY_TIMEOUT';






/**
 * A retry policy that never retries. Matches the current behavior of AAI/GAI
 * step() and the JAI streaming API call: errors propagate to the caller
 * without re-attempt.
 */
export class NoRetryPolicy {
    
    /** @param {{error: unknown, attempt: number}} arg0 @returns {RetryDecision} */
    shouldRetry({ error, attempt }) {
        return { retry: false, delayMs: 0 };
    }
}


/**
 * `{ headers }` wrapper. Case-insensitive; returns null when absent.
 * @param {{headers: any, name: string}} arg0 -
 * @returns {string|null}
 */
function readHeader({ headers, name }) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
        try { return headers.get(name); } catch { return null; }
    }
    if (typeof headers !== 'object') return null;
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) return headers[key];
    }
    return null;
}


/**
 * Every header container carried by the error chain: `err.headers` and
 * `err.response.headers` (a `Headers` instance or a plain object) for each
 * error in the chain, nearest error first.
 * @param {{error: any}} arg0 -
 * @returns {Array<any>}
 */
function headerContainers({ error }) {
    /** @type {Array<any>} */
    const out = [];
    let cur = error;
    let depth = 0;
    while (cur && depth++ < LIMITS.cause_chain_depth) {
        const e = /** @type {any} */ (cur);
        if (e.headers) out.push(e.headers);
        const responseHeaders = e.response?.headers;
        if (responseHeaders && responseHeaders !== e.headers) out.push(responseHeaders);
        cur = e.cause;
    }
    return out;
}


/**
 * The first value of `name` found on the error chain (the nearest error
 * wins). Case-insensitive; null when no container carries the header.
 * @param {{error: any, name: string}} arg0 -
 * @returns {string|null}
 */
function firstHeader({ error, name }) {
    for (const headers of headerContainers({ error })) {
        const value = readHeader({ headers, name });
        if (value != null) return value;
    }
    return null;
}


/**
 * The server's `x-should-retry` verdict: true forces a retry, false forbids
 * one, null (no header, or an unrecognised value) leaves the decision to the
 * classifier. Case-insensitive, read like `retry-after`.
 * @param {{error: any}} arg0 -
 * @returns {boolean|null}
 */
function shouldRetryHeader({ error }) {
    const raw = firstHeader({ error, name: 'x-should-retry' });
    if (raw == null) return null;
    const value = String(raw).trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}


/**
 * The usable length of a server hint, or null when it must be ignored: zero,
 * negative, non-finite and above `retry_after_max_ms` are all "back off on our
 * own terms", never "sleep this long" (the OpenAI SDK's rule).
 * @param {{ms: number}} arg0 -
 * @returns {number|null}
 */
function retryWindow({ ms }) {
    const maxMs = LIMITS.retry_after_max_ms;
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms > maxMs ? null : ms;
}


/**
 * One duration unit → milliseconds.
 * @type {Record<string, number>}
 */
const DURATION_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };


/**
 * A `retry-after-ms` header → milliseconds (null when unusable).
 * @param {{raw: any}} arg0 -
 * @returns {number|null}
 */
function parseMillisHint({ raw }) {
    return retryWindow({ ms: Number.parseFloat(String(raw)) });
}


/**
 * A `retry-after` header → milliseconds: a number of seconds or an
 * HTTP-date. Unusable numbers (0, negative, > max) and a date in the past are
 * ignored, not clamped to 0 or to the cap.
 * @param {{raw: any}} arg0 -
 * @returns {number|null}
 */
function parseRetryAfterHint({ raw }) {
    const text = String(raw).trim();
    const secs = Number.parseFloat(text);
    if (Number.isFinite(secs)) return retryWindow({ ms: secs * 1000 });
    const dateMs = Date.parse(text);
    if (Number.isNaN(dateMs)) return null;
    return retryWindow({ ms: dateMs - Date.now() });
}


/**
 * A duration header → milliseconds. Accepts a plain number of seconds (`20`),
 * one unit (`500ms`, `2s`, `1m`) and a compound duration (`6m0s`, `1h2m3s`) —
 * the shapes OpenAI's `x-ratelimit-reset-*` headers use. Null for anything
 * else, including a duration beyond the retry window.
 * @param {{raw: any}} arg0 -
 * @returns {number|null}
 */
function parseDurationMs({ raw }) {
    const text = String(raw).trim();
    const groups = text.match(/(\d+(?:\.\d+)?)(ms|s|m|h)?/g);
    // `join` catches trailing junk the per-group pattern would silently drop.
    if (!groups || groups.join('') !== text) return null;
    let ms = 0;
    for (const group of groups) {
        const part = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(group);
        if (!part) return null;
        ms += Number.parseFloat(part[1]) * (part[2] ? DURATION_UNIT_MS[part[2]] : 1000);
    }
    return retryWindow({ ms });
}


/**
 * An Anthropic reset header → milliseconds: an RFC3339 timestamp
 * (`2026-01-01T00:00:00Z`) or a number of seconds.
 * @param {{raw: any}} arg0 -
 * @returns {number|null}
 */
function parseResetHint({ raw }) {
    const text = String(raw).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return retryWindow({ ms: Number.parseFloat(text) * 1000 });
    const ts = Date.parse(text);
    if (Number.isNaN(ts)) return null;
    return retryWindow({ ms: ts - Date.now() });
}


/**
 * `retry-after-ms` headers (walking the `cause` chain). Returns the delay in
 * ms, or null when the error carries no usable hint. `retry-after-ms` is
 * preferred; then `retry-after` as seconds or an HTTP-date. An unusable hint
 * (0, negative, above `retry_after_max_ms`) is ignored so the caller backs off
 * on its own schedule instead of sleeping for minutes.
 * @param {{error: Error}} arg0 -
 * @returns {number|null}
 */
export function retryAfterFromError({ error }) {
    let cur =  (error);
    let depth = 0;
    while (cur && depth++ < LIMITS.cause_chain_depth) {
        const headers = /** @type {any} */ (cur).headers ?? /** @type {any} */ (cur).response?.headers ?? null;
        const msRaw = readHeader({ headers, name: 'retry-after-ms' });
        if (msRaw != null) {
            const ms = parseMillisHint({ raw: msRaw });
            if (ms !== null) return ms;
        }
        const afterRaw = readHeader({ headers, name: 'retry-after' });
        if (afterRaw != null) {
            const delay = parseRetryAfterHint({ raw: afterRaw });
            if (delay !== null) return delay;
        }
        cur = /** @type {any} */ (cur.cause);
    }
    return null;
}


/**
 * One vendor rate-limit bucket: the `remaining` header that names an exhausted
 * bucket with `0`, and the `reset` header that says when it refills.
 * @type {Array<{remaining: string, reset: string, parse: (arg0: {raw: any}) => number|null}>}
 */
const RATE_LIMIT_BUCKETS = [
    { remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests', parse: parseDurationMs },
    { remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens', parse: parseDurationMs },
    { remaining: 'anthropic-ratelimit-requests-remaining', reset: 'anthropic-ratelimit-requests-reset', parse: parseResetHint },
    { remaining: 'anthropic-ratelimit-tokens-remaining', reset: 'anthropic-ratelimit-tokens-reset', parse: parseResetHint },
];


/**
 * The vendor rate-limit windows: a bucket whose `remaining` is 0 names the wait
 * exactly (waiting for a bucket that still holds volume retries into the same
 * limit), otherwise the later of the resets is the safe one. Null when no
 * bucket carries a usable reset — and when an EMPTY bucket carries no usable
 * reset either, because borrowing a healthy bucket's shorter reset walks
 * straight back into the exhausted one.
 * @param {{error: Error}} arg0 -
 * @returns {number|null}
 */
function bucketDelayFromError({ error }) {
    /** @type {Array<number>} */
    const exhausted = [];
    /** @type {Array<number>} */
    const resets = [];
    let exhaustedWithoutReset = false;
    for (const bucket of RATE_LIMIT_BUCKETS) {
        const resetRaw = firstHeader({ error, name: bucket.reset });
        const delay = resetRaw == null ? null : bucket.parse({ raw: resetRaw });
        const remainingRaw = firstHeader({ error, name: bucket.remaining });
        const empty = remainingRaw != null && /^0(?:\.0+)?$/.test(String(remainingRaw).trim());
        if (empty) {
            if (delay === null) exhaustedWithoutReset = true;
            else exhausted.push(delay);
            continue;
        }
        if (delay !== null) resets.push(delay);
    }
    if (exhaustedWithoutReset) return null;
    if (exhausted.length > 0) return Math.max(...exhausted);
    return resets.length > 0 ? Math.max(...resets) : null;
}


/**
 * The vendor's rate-limit hint for a failed call, in milliseconds, or null
 * when the error carries none. Reads the headers in the precedence documented
 * in the file header (`retry-after-ms`, `retry-after`, then the OpenAI
 * `x-ratelimit-*` and Anthropic `anthropic-ratelimit-*` buckets). The headers
 * may sit on the error, on `error.response.headers` (a `Headers` instance or a
 * plain object) or on any error in the `cause` chain.
 *
 * `status` is the HTTP status the caller already read: when it is a number
 * other than 429 the bucket family is skipped, because a window describes a
 * rate limit and a 5xx must keep its own backoff. `retry-after` and
 * `retry-after-ms` apply at any status. Omitted, the bucket family is read.
 * @param {{error: Error, status?: number|null}} arg0 -
 * @returns {number|null}
 */
export function rateLimitDelayFromError({ error, status }) {
    const msRaw = firstHeader({ error, name: 'retry-after-ms' });
    if (msRaw != null) {
        const ms = parseMillisHint({ raw: msRaw });
        if (ms !== null) return ms;
    }

    const afterRaw = firstHeader({ error, name: 'retry-after' });
    if (afterRaw != null) {
        const delay = parseRetryAfterHint({ raw: afterRaw });
        if (delay !== null) return delay;
    }

    if (typeof status === 'number' && status !== 429) return null;
    return bucketDelayFromError({ error });
}


/**
 * A retry policy that retries on transient errors (connection, rate limit,
 * timeout, HTTP 408, 409, 429 and >= 500) with capped exponential backoff and
 * full jitter (AWS Architecture Blog: sleep = random(0, min(cap, base*2^attempt))).
 *
 * Non-retryable: HTTP 4xx other than 408/409/429 (e.g. 400, 401, 403, 404),
 * the LM Studio "no models loaded" 400, validation errors, and any error
 * after `maxRetries` attempts have been made. A server `x-should-retry` or a
 * `nonRetryable` flag overrides the status in their own direction.
 *
 * Retryability is classified structurally first (the `x-should-retry` verdict
 * and error `.code` on the error or its cause chain — e.g. HEADER_TIMEOUT —
 * then HTTP status, then Node syscall codes); message-substring matching
 * ("connection"/"rate limit"/"timeout"/"timed out") is the compat fallback
 * for untyped errors.
 *
 * @example
 * const policy = new ExponentialBackoffPolicy({
 *     maxRetries: 3,
 *     initialDelayMs: 1000,
 *     maxDelayMs: 30_000,
 * });
 */
export class ExponentialBackoffPolicy {
    
    /**
 * @param {{maxRetries?: number, initialDelayMs?: number, maxDelayMs?: number, jitterMs?: number, isRetryable?: ((error: Error) => boolean)|null}} arg0
 *   backward compatibility and ignored: jitter is always full (the whole
 *   capped window). Pass `jitterMs: 0` for deterministic delays in tests.
 */
        constructor({
        maxRetries = LIMITS.retry_max_retries,
        initialDelayMs = LIMITS.retry_initial_delay_ms,
        maxDelayMs = LIMITS.retry_max_delay_ms,
        jitterMs = LIMITS.retry_jitter_ms,
        isRetryable = null
    } = {}) {
        this.maxRetries = maxRetries;
        this.initialDelayMs = initialDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.jitterMs = jitterMs;
        this._isRetryableOverride = isRetryable;
    }

    
    /**
     * Retryable: a timeout code (HEADER_TIMEOUT/BODY_TIMEOUT on the error or
     * its cause chain), connection / rate-limit / timeout messages, the
     * network syscall codes, a transient vendor error code (`.type`/`.code`),
     * and the HTTP statuses 408, 409, 429 and >= 500.
     * False for everything else. `AbortSignal.timeout()`'s own `TimeoutError`
     * is the host's deadline, not ours, so it is never retried. The server's
     * `x-should-retry` wins over all of it. A 4xx status refuses the retry
     * whatever its wording says, while a transient vendor code wins over that
     * status. Reads the status through
     * `getErrorStatus` (the SDK's single status extractor) and walks the
     * `cause` chain for codes that Node's fetch wraps in "fetch failed".
     * @param {{error: Error}} arg0 -
     * @returns {boolean}
     */
        _isRetryable({ error }) {
        if (this._isRetryableOverride) return !!this._isRetryableOverride(error);
        // Kept here as well as in runWithRetry: `isTransientError` and the
        // public `shouldRetry` predicate are documented decision points of
        // their own, and the task tool's model-fallback gate reads
        // `isTransientError` directly.
        if (isNonRetryable({ error })) return false;
        // The server's verdict is final, in both directions (OpenAI's order).
        const verdict = shouldRetryHeader({ error });
        if (verdict !== null) return verdict;
        if (hasTimeoutCode({ error })) return true;
        // A host's own `AbortSignal.timeout()` reason is a caller-imposed
        // deadline, so it stops the call instead of being retried as ours.
        if (isTimeoutAbort({ error })) return false;
        const status = getErrorStatus({ error });
        // A transient vendor code wins over the status: a gateway re-wraps a
        // quota or overload body under a 400, and that is still a retry. A
        // stream `error` event carries no status at all and lands here too; a
        // fatal code already stopped us above.
        if (vendorFailureClass({ error }) === 'transient') return true;
        // A 4xx the caller caused (400, 401, 403, 404, …) is not made
        // retryable by its wording; only 408, 409 and 429 are retried.
        if (typeof status === 'number' && status >= 400 && status < 500 && !RETRYABLE_STATUSES.has(status)) return false;
        const msg = (error?.message || '').toLowerCase();
        if (msg.includes('connection')) return true;
        if (msg.includes('rate limit')) return true;
        if (/timeout|timed out/.test(msg)) return true;
        if (typeof status === 'number' && (RETRYABLE_STATUSES.has(status) || status >= 500)) return true;
        let cur =  (error);
        let depth = 0;
        while (cur && depth++ < LIMITS.cause_chain_depth) {
            const code = typeof /** @type {any} */ (cur).code === 'string' ? /** @type {any} */ (cur).code.toUpperCase() : '';
            if (TRANSIENT_SYSCODES.has(code)) return true;
            cur = /** @type {any} */ (cur.cause);
        }
        return false;
    }

    
    /**
     * The server's own hint wins — `retry-after-ms`, `retry-after` and the
     * vendor rate-limit headers — retrying earlier than the server asked just
     * burns another rate-limit window; an unusable hint is ignored. The bucket
     * family is only a wait on a 429: a 5xx keeps its own backoff. Without a
     * hint: full-jitter draw over
     * the capped exponential window (`jitterMs: 0` disables the draw for
     * deterministic tests). Never exceeds maxDelayMs.
     * @param {{attemptCount: number, error?: Error}} arg0 - Zero-based index of the failed attempt.
     * @returns {number} Delay in milliseconds.
     */
        _delayMs({ attemptCount, error }) {
        const hinted = error ? rateLimitDelayFromError({ error, status: getErrorStatus({ error }) }) : null;
        if (hinted !== null) return hinted;
        const expDelay = this.initialDelayMs * Math.pow(2, attemptCount);
        const capped = Math.min(expDelay, this.maxDelayMs);
        if (!(capped > 0)) return 0;
        if (this.jitterMs === 0) return capped;
        return Math.random() * capped;
    }

    
    /**
     * @param {{error: unknown, attempt: number}} arg0
     * @returns {RetryDecision}
     */
        shouldRetry({ error, attempt: attemptCount }) {
        const cause = /** @type {Error} */ (error);
        if (attemptCount >= this.maxRetries) {
            return { retry: false, delayMs: 0 };
        }
        if (!this._isRetryable({ error: cause })) {
            return { retry: false, delayMs: 0 };
        }
        return { retry: true, delayMs: this._delayMs({ attemptCount, error: cause }) };
    }
}


/**
 * The `embed()` retry policy every embedding-capable client shares: the
 * caller's own `embedRetryPolicy`, else the `embed_max_retries` /
 * `embed_initial_delay_ms` / `embed_max_delay_ms` budget with a 1s jitter
 * window. One construction point, so `oai` and `gai` cannot drift.
 * @param {{options?: {embedRetryPolicy?: RetryPolicy, embedMaxRetries?: number, embedInitialDelay?: number}}} [arg0]
 * @returns {RetryPolicy}
 */
export function embedRetryPolicyFrom({ options = {} } = {}) {
    return options.embedRetryPolicy || new ExponentialBackoffPolicy({
        maxRetries: options.embedMaxRetries ?? LIMITS.embed_max_retries,
        initialDelayMs: options.embedInitialDelay ?? LIMITS.embed_initial_delay_ms,
        maxDelayMs: LIMITS.embed_max_delay_ms,
        jitterMs: 1000
    });
}


/**
 * 30s, 2 retries — matching the OpenAI/Anthropic default). Use as the session
 * default; NOT for embeddings (embed keeps its own (5, 2s, 60s) policy on the
 * OAI client).
 * @param {{overrides?: Object}} arg0 - Partial options merged over the preset.
 * @returns {ExponentialBackoffPolicy}
 */
export function createStreamingRetryPolicy({ overrides = {} } = {}) {
    return new ExponentialBackoffPolicy({
        maxRetries: LIMITS.streaming_max_retries,
        initialDelayMs: LIMITS.streaming_initial_delay_ms,
        maxDelayMs: LIMITS.streaming_max_delay_ms,
        ...overrides,
    });
}


/**
 * Machine-readable code for fail-fast rejections while a circuit breaker is
 * open (never retried — the whole point is to stop calling). Carried on the
 * thrown Error as `.code`.
 */
export const BREAKER_OPEN_CODE = 'BREAKER_OPEN';

export const EMPTY_OUTPUT_CODE = 'EMPTY_OUTPUT';


/**
 * predicate): true when a fresh default-policy instance would retry the
 * error on attempt 0. Used by the task tool's model-fallback gate without
 * allocating policy intent — callers that own a policy should call
 * `policy.shouldRetry({ error: err, attempt: 0 }).retry` instead.
 * @param {{error: Error}} arg0 -
 * @returns {boolean}
 */
export function isTransientError({ error }) {
    return new ExponentialBackoffPolicy()._isRetryable({ error });
}


/**
 * Walk the `cause` chain nearest-first, bounded by `LIMITS.cause_chain_depth`,
 * and report whether `predicate` accepts any link. The one walk the retry
 * predicates share.
 * @param {{error: unknown, predicate: (cur: unknown) => boolean}} arg0 -
 * @returns {boolean}
 */
function someCause({ error, predicate }) {
    let cur = error;
    let depth = 0;
    while (cur && depth++ < LIMITS.cause_chain_depth) {
        if (predicate(cur)) return true;
        cur = /** @type {any} */ (cur).cause;
    }
    return false;
}


/**
 * timeout code (`TIMEOUT_CODES`: HEADER_TIMEOUT, BODY_TIMEOUT, STEP_TIMEOUT,
 * STREAM_TIMEOUT, plus the host spellings ETIMEDOUT, TIMEOUT, timeout) — the
 * structural contract that replaces message-substring matching. A host timeout
 * should reuse one of these codes.
 * @param {{error: Error}} arg0 -
 * @returns {boolean}
 */
export function hasTimeoutCode({ error }) {
    return someCause({ error, predicate: (cur) => TIMEOUT_CODES.has(/** @type {any} */ (cur).code) });
}


/**
 * A host's own `AbortSignal.timeout()` reason rather than our request deadline:
 * the DOM/Node `TimeoutError`, directly or as the `cause` of an `AbortError`.
 * The host decided to stop, so the call is never retried; our deadline carries
 * `HEADER_TIMEOUT`/`BODY_TIMEOUT` or the `Request timed out.` wording instead.
 * @param {{error: Error}} arg0 -
 * @returns {boolean}
 */
function isTimeoutAbort({ error }) {
    return someCause({ error, predicate: (cur) => /** @type {any} */ (cur).name === 'TimeoutError' });
}


/**
 * True when the error must not be retried at any layer: the caller, transport
 * or a spent attempt budget flagged it `nonRetryable` (e.g. the JAI gateway
 * retry), an error in the chain is an open circuit breaker (`BREAKER_OPEN`), or
 * the vendor named a permanent failure in `.type`/`.code`. Retrying a flagged
 * error at a higher layer multiplies non-idempotent POSTs; one flag, one check,
 * every policy caller honors it.
 * @param {{error: Error}} arg0 -
 * @returns {boolean}
 */
export function isNonRetryable({ error }) {
    if (vendorFailureClass({ error }) === 'fatal') return true;
    return someCause({ error, predicate: (cur) => /** @type {any} */ (cur).nonRetryable === true || /** @type {any} */ (cur).code === BREAKER_OPEN_CODE });
}


/**
 * when `signal` fires (checked synchronously for pre-aborted signals).
 * @param {{ms: number, signal?: AbortSignal|null}} arg0 - Delay in milliseconds.
 * @returns {Promise<void>}
 */
export function sleepAbortable({ ms, signal }) {
    return new Promise((resolve, reject) => {
        if (!signal) { setTimeout(resolve, ms); return; }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new AbortedError({ message: 'Operation was aborted.', options: { cause: signal.reason } }));
        };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
}

const TRANSIENT_SYSCODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
    'EPIPE', 'EAI_AGAIN', 'EADDRINUSE', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_SOCKET_CLOSED',
    // undici's own wrappers: a socket closed after the headers, or a connect /
    // headers / body stall, arrives as one of these on `fetch`'s cause.
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
]);

/** The statuses every vendor SDK retries; every status >= 500 joins them. */
const RETRYABLE_STATUSES = new Set([408, 409, 429]);

/**
 * Vendor error codes that name a transient failure, so the code alone retries:
 * OpenAI's `ResponseErrorCode` (`server_error`, `rate_limit_exceeded`) and
 * Anthropic's `ErrorResponse.error.type` (`overloaded_error`,
 * `rate_limit_error`). Needed because a stream `error` event carries no status.
 * @type {Set<string>}
 */
const TRANSIENT_ERROR_CODES = new Set(['overloaded_error', 'rate_limit_error', 'server_error', 'rate_limit_exceeded']);

/**
 * Vendor error codes that name a permanent failure: no status, header or
 * backoff makes a malformed request or a bad credential work. The image family
 * is enumerated from OpenAI's `ResponseErrorCode` enum rather than matched by
 * prefix, so a new code has to be classified on purpose.
 * @type {Set<string>}
 */
const FATAL_ERROR_CODES = new Set([
    'invalid_request_error',
    'authentication_error',
    'permission_error',
    'not_found_error',
    'invalid_prompt',
    'data_residency_mismatch',
    'bio_policy',
    'misalignment_policy_violation',
    'invalid_image',
    'invalid_image_format',
    'invalid_base64_image',
    'invalid_image_url',
    'invalid_image_mode',
    'image_too_large',
    'image_too_small',
    'image_parse_error',
    'image_content_policy_violation',
    'image_file_too_large',
    'unsupported_image_media_type',
    'empty_image_file',
    'failed_to_download_image',
    'image_file_not_found',
]);


/**
 * The vendor's own verdict for a failed call, read from `.type` and `.code` on
 * the error and its `cause` chain (the nearest typed error wins): `'transient'`,
 * `'fatal'`, or null when no error in the chain carries a known vendor code.
 * One walker for both callers — the policy and `isNonRetryable`.
 * @param {{error: Error}} arg0 -
 * @returns {'transient'|'fatal'|null}
 */
function vendorFailureClass({ error }) {
    let cur =  (error);
    let depth = 0;
    while (cur && depth++ < LIMITS.cause_chain_depth) {
        for (const raw of [/** @type {any} */ (cur).type, /** @type {any} */ (cur).code]) {
            if (typeof raw !== 'string') continue;
            const code = raw.toLowerCase();
            if (FATAL_ERROR_CODES.has(code)) return 'fatal';
            if (TRANSIENT_ERROR_CODES.has(code)) return 'transient';
        }
        cur = /** @type {any} */ (cur).cause;
    }
    return null;
}


/**
 * @returns {{ name: string, message: string, status?: number }}
  * @param {{err: *}} arg0
 */
function describeError({ err }) {
    
    /** @type {{ name: string, message: string, status?: number }} */
        const out = { name: 'Error', message: 'unserializable error' };
    try {
        if (err?.name !== undefined) out.name = err.name;
    } catch {   }
    try {
        if (err?.message !== undefined) out.message = err.message;
        else out.message = String(err);
    } catch {   }
    try {
        if (err?.status !== undefined) out.status = err.status;
    } catch {   }
    return out;
}


/**
 * gives up. Abort-aware: a cancelled signal rejects with `AbortedError`
 * between attempts AND during the backoff sleep. One implementation for the
 * step() vendor call, `embed()`, and any future caller — previously each
 * re-implemented the same loop with its own sleep flavor. Retries share one
 * wall-clock budget (`maxElapsedMs`): a retry whose backoff would overshoot
 * the deadline is skipped and the last error propagates, so N retries never
 * cost N × timeout.
 * @template T
 * @param {{operation: () => Promise<T>, policy: RetryPolicy, signal?: AbortSignal|null, maxElapsedMs?: number, onRetry?: ((arg0: RetryEvent) => void)|null, vendorName?: string|null}} arg0 -
 * @returns {Promise<T>}
 */
export async function runWithRetry({ operation, policy, signal = null, maxElapsedMs = LIMITS.max_elapsed_ms, onRetry = null, vendorName = null }) {
    /** @param {{fallback: *}} arg0 */
    const abortMessage = ({ fallback }) => {
        if (!signal) return fallback;
        return typeof signal.reason === 'string' ? signal.reason
            : signal.reason instanceof Error ? signal.reason.message
            : fallback;
    };
    let attempt = 0;
    const startTs = Date.now();
    for (;;) {
        if (signal && signal.aborted) {
            throw new AbortedError({ message: abortMessage({ fallback: 'Retry loop aborted before attempt.' }), options: { cause: signal.reason } });
        }
        try {
            return await operation();
        } catch (err) {
            if (signal && signal.aborted) {
                throw new AbortedError({ message: abortMessage({ fallback: 'Retry loop aborted mid-attempt.' }), options: { cause: signal.reason } });
            }
            if (!policy || typeof policy.shouldRetry !== 'function') {
                throw err;
            }
            let decision;
            try {
                // The retry loop owns the non-retryable classes (an open
                // breaker, a cassette miss, an aborted stream): a permissive
                // custom policy must not override them.
                decision = isNonRetryable({ error: /** @type {any} */ (err) }) ? null : policy.shouldRetry({ error: /** @type {any} */ (err), attempt });
            } catch (policyErr) {
                if (policyErr !== err) {
                    sdkWarn({ prefix: 'RETRY', args: [`retry policy crashed on a hostile error (${/** @type {any} */ (policyErr).message}) — treating as non-retryable`] });
                }
                throw err;
            }
            if (!decision || !decision.retry) {
                throw err;
            }
            if (maxElapsedMs > 0 && Date.now() - startTs + decision.delayMs > maxElapsedMs) {
                throw err;
            }
            if (typeof onRetry === 'function') {
                onRetry({
                    vendor: vendorName,
                    attempt,
                    nextDelayMs: decision.delayMs,
                    error: describeError({ err })
                });
            }
            if (decision.delayMs > 0) {
                await sleepAbortable({ ms: decision.delayMs, signal });
            }
            attempt++;
        }
    }
}


/**
 * Consecutive-failure circuit breaker with half-open probing.
 */
export class CircuitBreaker {
    
    /**
 * @param {{failureThreshold?: number, cooldownMs?: number}} arg0
 */
        constructor({ failureThreshold = LIMITS.circuit_failure_threshold, cooldownMs = LIMITS.circuit_cooldown_ms } = {}) {
        this.failureThreshold = failureThreshold;
        this.cooldownMs = cooldownMs;
        this.consecutiveFailures = 0;
        this.openedAt = 0;
        this.probeClaimedAt = 0;
    }

    
    /** True when the breaker is currently open (still in cooldown). */
        get isOpen() {
        if (this.consecutiveFailures < this.failureThreshold) return false;
        if (Date.now() - this.openedAt >= this.cooldownMs) return false;
        return true;
    }

    
    /**
     * False when an attempt must be skipped: the breaker is open, or a fresh
     * half-open probe already holds the slot. Pure — asking never claims the
     * probe, so a caller that asks and does not run cannot starve the breaker.
     * @returns {boolean}
     */
        canRun() {
        return !this.isOpen && !this.probeInFlight();
    }

    
    /**
     * True while a half-open probe holds the slot. A claim older than the
     * cooldown is stale — the probe never settled — so it stops blocking; with
     * a zero cooldown a claim is stale immediately.
     * @returns {boolean}
     */
        probeInFlight() {
        if (this.probeClaimedAt === 0) return false;
        return Date.now() - this.probeClaimedAt < this.cooldownMs;
    }

    
    /**
     * Claims the half-open probe slot for one attempt: true for exactly one
     * caller after a cooldown expiry, false while another probe is unresolved.
     * A closed breaker is always claimable and needs no claim. Released by
     * `endProbe()` or by the attempt's recorded outcome.
     * @returns {boolean}
     */
        beginProbe() {
        if (!this.canRun()) return false;
        if (this.consecutiveFailures >= this.failureThreshold) this.probeClaimedAt = Date.now();
        return true;
    }

    
    /** Records a success: closes the breaker. */
        recordSuccess() {
        this.consecutiveFailures = 0;
        this.openedAt = 0;
        this.probeClaimedAt = 0;
    }

    
    /**
     * Releases an unresolved probe without counting a failure: the attempt
     * ended without saying anything about the backend's health (a caller-caused
     * 4xx, an abort), so the next caller may probe.
     * @returns {void}
     */
        endProbe() {
        this.probeClaimedAt = 0;
    }

    
    /** Records a failure: opens the breaker at the threshold. */
        recordFailure() {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold) this.openedAt = Date.now();
        this.probeClaimedAt = 0;
    }
}


/** @type {WeakMap<object, Map<string, CircuitBreaker>>} */
const BREAKERS = new WeakMap();

/**
 * The breaker name for a backend/model pair. One construction so every caller
 * (step, task, discussion) agrees on the shared health key.
 * @param {{provider?: string|null, model?: string|null}} arg0
 * @returns {string}
 */
export function circuitKey({ provider, model } = {}) {
    return `${provider}:${model}`;
}

/**
 * backend/model (or any caller key). Fresh child sessions share the parent
 * client's health view instead of each starting blind.
 * @param {{client?: Object|null, key: string, options?: Object}} arg0 - Breaker name, e.g. `jai:google-gemini-3-8-flash`.
 * @returns {CircuitBreaker}
 */
export function getCircuitBreaker({ client, key, options }) {
    if (!client) return new CircuitBreaker(options);
    // A view shares the health of the client it wraps; one backend, one breaker.
    const owner = /** @type {object} */ (baseClientOf({ client }));
    // SP5: the health view is keyed by the client but never STORED on it — a
    // transport carries no SDK orchestration state (and a frozen client works).
    let breakers = BREAKERS.get(owner);
    if (!breakers) {
        breakers = new Map();
        BREAKERS.set(owner, breakers);
    }
    let breaker = breakers.get(key);
    if (!breaker) {
        breaker = new CircuitBreaker(options);
        breakers.set(key, breaker);
    }
    return breaker;
}


/**
 * Runs `run` behind `breaker`, recording shared backend health. Only a
 * transient failure (or one of our timeout codes) is backend health: a
 * caller-caused 4xx, an open breaker downstream and a caller abort never open
 * the breaker. The half-open probe is claimed for this attempt and resolved by
 * the outcome, so exactly one caller probes after a cooldown.
 * @template T
 * @param {{breaker?: CircuitBreaker|null, signal?: AbortSignal|null, run: () => Promise<T>, onBreakerOpen: () => T|Promise<T>, onFailure: (arg0: { err: unknown }) => T|Promise<T>}} arg0
 * @returns {Promise<T>}
 */
export async function runGuardedStep({ breaker = null, signal = null, run, onBreakerOpen, onFailure }) {
    if (breaker && !breaker.beginProbe()) return onBreakerOpen();
    try {
        const out = await run();
        breaker?.recordSuccess();
        return out;
    } catch (err) {
        const ec =  (err);
        const backendFailure = isTransientError({ error: /** @type {Error} */ (ec) }) || hasTimeoutCode({ error: /** @type {Error} */ (ec) });
        if (backendFailure && /** @type {any} */ (ec)?.code !== BREAKER_OPEN_CODE && /** @type {any} */ (ec)?.code !== EMPTY_OUTPUT_CODE && !signal?.aborted) breaker?.recordFailure();
        else breaker?.endProbe();
        return onFailure({ err: /** @type {any} */ (err) });
    }
}


/**
 * Runs a vendor call under the session's retry policy — the shared entry
 * point for the backend adapters' `executeVendorRequest` (OAI / AAI / GAI).
 *
 * The policy is the session's own (`session._retryPolicy`, the streaming
 * preset by default); when the session carries none the call runs exactly
 * once, so an unconfigured session behaves as before. The retry is bounded
 * by the session's `maxElapsedMs` budget, honours the caller's
 * `AbortSignal` (never retries after an abort) and never retries an error
 * flagged `nonRetryable` (a 4xx other than 429, a blocked prompt, …).
 *
 * The `operation` must be re-runnable: it creates the vendor request (and
 * the vendor stream) on every attempt, so a retry never reuses a consumed
 * stream.
 * @template T
 * @param {{operation: () => Promise<T>, session?: RetrySession, vendorName?: string|null, signal?: AbortSignal|null}} arg0 -
 *   `operation` opens the vendor call; `session` carries the policy and the
 *   elapsed budget; `signal` aborts the call and the backoff.
 * @returns {Promise<T>} The vendor result.
 */
export async function runVendorCallWithRetry({ operation, session, vendorName = null, signal = null }) {
    const policy = session?._retryPolicy ?? null;
    // ONE owner for the retry. A session that opens the vendor call inside its
    // own retry (the agent loop does) already re-runs the call, so a second
    // policy here would multiply the attempts (3 x 3 = 9 calls for one
    // failure). A direct adapter consumer has no such session and keeps the
    // retry.
    if (typeof session?._openFirstEvent === 'function') return operation();
    if (!policy || typeof policy.shouldRetry !== 'function') return operation();
    const budget = Number(session?._maxElapsedMs);
    return runWithRetry({
        operation,
        policy: /** @type {RetryPolicy} */ (policy),
        signal,
        maxElapsedMs: Number.isFinite(budget) && budget > 0 ? budget : LIMITS.max_elapsed_ms,
        vendorName,
    });
}
