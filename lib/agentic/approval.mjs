// @ts-check


/**
 * @file One approval-input normalizer for every boundary that accepts a gate.
 * @version 0.12.0
 *
 * @description
 * The scheduler runner, the orchestration facade, and the workspace binder all
 * accept the same host approval in slightly different forms. Sharing one
 * normalizer is what makes "one approval" true: `withApproval({ fn, options })`
 * is the documented builder shape, and passing it to any boundary must reach
 * the same callback with its timeout, never silently drop a gate.
 *
 * The accepted shapes are a bare function, `{ callback }`, `{ fn }`,
 * `{ callback, timeoutMs }`, and `{ fn, options: { timeoutMs } }`. Anything
 * else is refused with `invalid_approval` instead of disabling the gate.
 */

import { ConfigurationError } from '../core/errors.mjs';

/**
 * The gate as the runner and the facade accept it.
 * @typedef {Object} NormalizedApproval
 * @property {Function} callback - The approval function.
 * @property {number} [timeoutMs] - The session gate's timeout, when one was given.
 */

/**
 * Read one field without letting a hostile getter or Proxy trap escape.
 * @param {{record: Record<string, unknown>, key: string}} arg0 -
 * @returns {unknown}
 */
function read({ record, key }) {
    try {
        return record[key];
    } catch {
        return undefined;
    }
}

/**
 * Accept a function, a `{ callback, timeoutMs }` object, or a
 * `{ fn, options: { timeoutMs } }` object. Anything else is refused instead of
 * silently disabling the gate.
 * @param {{value: unknown, origin?: string, option?: string}} arg0 - `origin`
 *   labels the caller in the error message; `option` labels the
 *   `ConfigurationError` (default `invalid_approval`). Neither changes the
 *   accepted shapes.
 * @returns {NormalizedApproval|null} `null` when no approval was supplied.
 * @throws {ConfigurationError} With option `invalid_approval` (or the caller's
 *   label) for any other value.
 */
export function normalizeApproval({ value, origin = 'createEngineRunner', option = 'invalid_approval' }) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'function') return { callback: value };
    if (typeof value !== 'object') {
        throw new ConfigurationError({
            message: `${origin}: approval must be a function, an object, or null.`,
            options: { option }
        });
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    const callbackField = read({ record, key: 'callback' });
    const fnField = read({ record, key: 'fn' });
    const callback = typeof callbackField === 'function'
        ? callbackField
        : typeof fnField === 'function' ? fnField : null;
    if (callback === null) {
        throw new ConfigurationError({
            message: `${origin}: approval needs a callback/fn function.`,
            options: { option }
        });
    }
    /** @type {number|undefined} */
    let timeoutMs;
    const direct = read({ record, key: 'timeoutMs' });
    if (typeof direct === 'number' && Number.isFinite(direct)) {
        timeoutMs = direct;
    } else {
        const nestedOptions = read({ record, key: 'options' });
        if (nestedOptions !== null && typeof nestedOptions === 'object') {
            const nested = read({ record: /** @type {Record<string, unknown>} */ (nestedOptions), key: 'timeoutMs' });
            if (typeof nested === 'number' && Number.isFinite(nested)) timeoutMs = nested;
        }
    }
    return timeoutMs === undefined ? { callback } : { callback, timeoutMs };
}
