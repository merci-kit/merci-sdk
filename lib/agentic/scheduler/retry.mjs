// @ts-check

import { TIMEOUT_CODES } from '../../core/constants/index.mjs';
import { isAbortErrorSafe as isAbortError } from '../../core/errors.mjs';
import { isNonRetryable } from '../../support/retry-policy.mjs';
import { projectUsage } from './state.mjs';

// The evidence builder lives with the taxonomy it feeds (`loops/policy.mjs`);
// re-exported here so this module's surface and the scheduler's imports are
// unchanged.
export { failureEvidence } from '../loops/policy.mjs';


/**
 * @file Retry delay, run-result normalization, and failure evidence.
 * @version 0.12.0
 *
 * @description
 * The scheduler retries a whole attempt at the queue level; these helpers are
 * deterministic (no jitter — transport jitter stays in `retry-policy.mjs`) and
 * never carry an error message, a prompt, or provider payload forward. Only
 * `name` and `code` survive normalization, which is what the failure taxonomy
 * consumes.
 *
 * The taxonomy and its evidence builder live in `loops/policy.mjs`; this module
 * re-exports `failureEvidence` so the scheduler keeps one import site.
 * `classifyFailure` reads `source: 'scheduler'`, so a workflow-policy failure is
 * reachable through its `errorCode` without importing the policy module.
 */

/** @typedef {'completed'|'failed'|'canceled'} RunStatus */

/**
 * @typedef {Object} NormalizedRunResult
 * @property {RunStatus} status
 * @property {boolean} progress
 * @property {object|null} usage
 * @property {number|null} costUsd
 * @property {string|null} errorName
 * @property {string|null} errorCode
 * @property {boolean} timedOut
 * @property {boolean} nonRetryable - The failure must park, not retry.
 */

/** @type {ReadonlySet<string>} */
const RUN_STATUSES = new Set(['completed', 'failed', 'canceled']);

/**
 * Read `name`/`code` without letting a hostile getter or message escape.
 * @param {{error: unknown}} arg0 -
 * @returns {{errorName: string|null, errorCode: string|null}}
 */
export function errorFields({ error }) {
    /** @type {string|null} */
    let errorName = null;
    /** @type {string|null} */
    let errorCode = null;
    // Arrays are not error records: a `throw []` with an own `name`/`code` must
    // not re-classify a failure here (scheduler.mjs's former guard excluded them).
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return { errorName, errorCode };
    const record = /** @type {Record<string, unknown>} */ (error);
    try {
        if (typeof record.name === 'string') errorName = record.name;
    } catch { /* unreadable name */ }
    try {
        if (typeof record.code === 'string') errorCode = record.code;
    } catch { /* unreadable code */ }
    return { errorName, errorCode };
}

/**
 * @param {{value: unknown}} arg0 -
 * @returns {number|null}
 */
function finiteOrNull({ value }) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Capped exponential queue delay: `min(baseMs * 2 ** (attempt - 1), maxMs)`.
 * A non-finite or `< 1` attempt is treated as the first attempt.
 * @param {{attempt: number, baseMs: number, maxMs: number}} arg0 -
 * @returns {number}
 */
export function retryDelayMs({ attempt, baseMs, maxMs }) {
    const safeAttempt = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
    const delay = baseMs * 2 ** (safeAttempt - 1);
    return Number.isFinite(delay) ? Math.min(delay, maxMs) : maxMs;
}

/**
 * Normalize a workflow result or a thrown error into the scheduler's fixed
 * shape. A missing or unknown status fails closed (§3.10/AC16); only an
 * explicit `completed`/`failed`/`canceled` survives. Only `name` and `code` of
 * an error survive — whether it is thrown or carried on a failed result.
 *
 * A timeout code wins over an `AbortError` name: the stream inactivity policy
 * names its error `AbortError` so adapters destroy the vendor request, but that
 * is infrastructure, not a user cancel, and must count as a failure.
 * @param {{
 *   result?: Record<string, unknown>|null,
 *   error?: unknown,
 *   signal?: AbortSignal|null
 * }} [arg0] -
 * @returns {NormalizedRunResult}
 */
export function normalizeRunResult({ result = null, error = null, signal = null } = {}) {
    if (error !== null && error !== undefined) {
        const { errorName, errorCode } = errorFields({ error });
        const timedOut = (errorCode !== null && TIMEOUT_CODES.has(errorCode))
            || isTimeoutReason({ signal });
        const canceled = signal?.aborted === true || (!timedOut && isAbortError({ error }));
        return {
            status: canceled ? 'canceled' : 'failed',
            progress: true,
            usage: null,
            costUsd: null,
            errorName,
            errorCode,
            timedOut,
            nonRetryable: safelyNonRetryable({ error })
        };
    }
    const record = result !== null && typeof result === 'object'
        ? /** @type {Record<string, unknown>} */ (result)
        : {};
    const rawStatus = record.status;
    const status = typeof rawStatus === 'string' && RUN_STATUSES.has(rawStatus)
        ? /** @type {RunStatus} */ (rawStatus)
        : 'failed';
    const usage = record.usage !== null && typeof record.usage === 'object'
        ? /** @type {object} */ (record.usage)
        : null;
    const explicitCost = finiteOrNull({ value: record.costUsd });
    const usageCost = usage === null ? null : projectUsage({ usage })?.costUsd ?? null;
    const evidence = resultErrorEvidence({ record });
    return {
        status,
        progress: record.progress !== false,
        usage,
        costUsd: explicitCost ?? usageCost,
        errorName: evidence.errorName,
        errorCode: evidence.errorCode,
        timedOut: record.timedOut === true
            || (evidence.errorCode !== null && TIMEOUT_CODES.has(evidence.errorCode)),
        nonRetryable: record.nonRetryable === true || evidence.nonRetryable
    };
}

/**
 * The `error`/`errorCode`/`errorName` a failed workflow result may carry. A
 * result could not declare a non-retryable failure before, so an application
 * error was retried until `maxAttemptsPerItem`; reading the fields here keeps a
 * workflow's evidence on the same path as a thrown error.
 * @param {{record: Record<string, unknown>}} arg0 -
 * @returns {{errorName: string|null, errorCode: string|null, nonRetryable: boolean}}
 */
function resultErrorEvidence({ record }) {
    let errorName = typeof record.errorName === 'string' ? record.errorName : null;
    let errorCode = typeof record.errorCode === 'string' ? record.errorCode : null;
    let nonRetryable = false;
    const carried = record.error;
    if (carried !== null && typeof carried === 'object') {
        const fields = errorFields({ error: carried });
        errorName = errorName ?? fields.errorName;
        errorCode = errorCode ?? fields.errorCode;
        nonRetryable = safelyNonRetryable({ error: carried });
    }
    return { errorName, errorCode, nonRetryable };
}

/**
 * `isNonRetryable` walks the cause chain without guarding hostile getters; a
 * thrown getter must not reject the settle path.
 * @param {{error: unknown}} arg0 -
 * @returns {boolean}
 */
function safelyNonRetryable({ error }) {
    try {
        return isNonRetryable({ error: /** @type {Error} */ (error) });
    } catch {
        return false;
    }
}

/**
 * Whether the abort signal carries a timeout reason.
 * @param {{signal: AbortSignal|null}} arg0 -
 * @returns {boolean}
 */
function isTimeoutReason({ signal }) {
    if (signal === null || signal === undefined) return false;
    try {
        const reason = /** @type {{name?: unknown}} */ (signal.reason);
        return reason?.name === 'TimeoutError';
    } catch {
        return false;
    }
}
