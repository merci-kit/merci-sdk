// @ts-check
/**
 * @file object — the record coercion the transports share.
 * @version 0.12.0
 *
 * @description
 * Four transports kept their own "treat this as a keyed record" test and two of
 * them disagreed on arrays. `asRecord` is the one answer: a non-null, non-array
 * object is a record, anything else is `null` so `?.` reads nothing from a body
 * that is a list, a string or absent.
 */

/**
 * The value as a keyed record, or `null` when it is not a non-null, non-array
 * object.
 * @param {{value: unknown}} arg0
 * @returns {Record<string, unknown>|null}
 */
export function asRecord({ value }) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? /** @type {Record<string, unknown>} */ (value)
        : null;
}
