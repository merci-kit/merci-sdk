// @ts-check


/**
 * @file Concurrency limiter (semaphore) for fan-out calls.
 * @version 0.12.0
 *
 * @description
 * Caps how many async tasks run at once and optionally spaces task starts by
 * a minimum delay. Replaces ad-hoc `Promise.all` fan-out that can stampede a
 * gateway with thousands of simultaneous calls. `runBatch` also takes an
 * opt-in batch token cap (`maxTotalTokens` + `usageOf`) on top of the R7
 * per-run cap.
 *
 * @example
 * const { createLimiter } = await import('./limiter.mjs');
 * const limiter = createLimiter({ maxConcurrent: 4 });
 * const results = await Promise.all(items.map((i) => limiter.run(() => call(i))));
 */
import { NoRetryPolicy, runWithRetry } from './retry-policy.mjs';
import { BudgetExceededError, ConfigurationError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';


/**
 * Captures the caller's promise type through the limiter: `run` returns exactly
 * what the callback resolved to.
 * @template T
 * @typedef {(fn: () => Promise<T>) => Promise<T>} LimitedRun
 */

/**
 * A retry policy as `runBatch` consumes it: one decision per failed attempt.
 * @typedef {{shouldRetry: Function}} BatchRetryPolicy
 */

/**
 * Creates a limiter.
 * @param {{maxConcurrent?: number, minDelayMs?: number, shouldDelay?: (() => boolean)|null}} [arg0]
 * @returns {{ run: <T>(fn: () => Promise<T>) => Promise<T>, acquire: () => Promise<void>, release: () => void }}
 */
export function createLimiter({ maxConcurrent = LIMITS.limiter_max_concurrent, minDelayMs = LIMITS.limiter_min_delay_ms, shouldDelay = null } = {}) {
    const limit = Math.max(1, Math.floor(maxConcurrent) || 1);
    const delay = Math.max(0, minDelayMs);
    let active = 0;
    
    /** @type {Array<(value?: any) => void>} */
        const waiters = [];

    const acquire = () => {
        if (active < limit) {
            active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => waiters.push(resolve));
    };

    const release = () => {
        const next = waiters.shift();
        if (next) next();
        else if (active > 0) active--;
    };

    const run = /** @type {(...args: any[]) => any} */ (async ( fn) => {
        await acquire();
        try {
            return await fn();
        } finally {
            if (delay > 0 && (typeof shouldDelay !== 'function' || shouldDelay())) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            release();
        }
    });

    return { run, acquire, release };
}


/**
 * per-item retry, returning an index-aligned array of settled outcomes in
 * INPUT order (independent of completion order):
 * `[{status:'fulfilled', value} | {status:'rejected', reason}]`.
 * A rejected/repeatedly-failing item never aborts its siblings (default); set
 * `stopOnError` to throw the first rejection's reason after the batch drains.
 * A batch-level token cap is opt-in: pass `maxTotalTokens` plus a `usageOf`
 * extractor. Once the summed usage crosses the cap, queued items are not
 * dispatched (in-flight items still drain), and BudgetExceededError is thrown.
 * @template I
 * @template V
 * @param {{items: Array<I>, worker: (item: I, index: number) => Promise<V>, maxConcurrent?: number, minDelayMs?: number, retryPolicy?: BatchRetryPolicy|null, signal?: AbortSignal, stopOnError?: boolean, maxTotalTokens?: number|null, usageOf?: ((value: V, item: I, index: number) => number)|null}} arg0 -
 * @returns {Promise<Array<{status: string, value?: V, reason?: unknown}>>}
 */
export async function runBatch({ items, worker, maxConcurrent = LIMITS.limiter_max_concurrent, minDelayMs = LIMITS.limiter_min_delay_ms, retryPolicy = null, signal, stopOnError = false, maxTotalTokens = null, usageOf = null }) {
    if (maxTotalTokens != null && typeof usageOf !== 'function') {
        throw new ConfigurationError({ message: 'runBatch: maxTotalTokens requires a usageOf(value, item, index) extractor.' });
    }
    const limiter = createLimiter({ maxConcurrent, minDelayMs, shouldDelay: () => !overBudget && !signal?.aborted });
    const list = items ?? [];
    const results = new Array(list.length);
    let totalTokens = 0;
    let overBudget = false;
    await Promise.all(list.map((item, index) => limiter.run(async () => {
        if (overBudget) return;
        results[index] = await runWithRetry({ operation: () => worker(item, index), policy: /** @type {import('./retry-policy.mjs').RetryPolicy} */ (retryPolicy ?? new NoRetryPolicy()), signal }).then(
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason })
        );
        const settled = results[index];
        if (settled.status === 'fulfilled' && usageOf) {
            totalTokens += Number(usageOf(settled.value, item, index)) || 0;
            if (maxTotalTokens != null && totalTokens > maxTotalTokens) overBudget = true;
        }
    })));
    if (overBudget) {
        throw new BudgetExceededError({ message: `Batch token budget exceeded: ${totalTokens} > ${maxTotalTokens}.`, options: {
            maxTotalTokens: maxTotalTokens ?? undefined,
            usage: { total_tokens: totalTokens },
        } });
    }
    if (stopOnError) {
        const failed = results.find((r) => r?.status === 'rejected');
        if (failed) throw failed.reason;
    }
    return results;
}
