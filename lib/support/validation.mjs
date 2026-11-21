// @ts-check
/**
 * @file validation — the shape predicates and the named-string assertion.
 * @version 0.12.0
 *
 * @description
 * One home for the two object tests the SDK kept copying and one of them
 * silently changing meaning: `isObjectLike` includes arrays (a config section
 * may be a list), `isRecordObject` excludes them (a record is indexed by key),
 * and `isPlainObject` also requires an `Object.prototype`/`null` prototype (a
 * class instance is an object but not data). Callers pick the one their input
 * contract means instead of re-deriving it. `assertNonEmptyString` is the
 * caller-bug guard the scheduler's stores share.
 */
import { ConfigurationError } from '../core/errors.mjs';

/**
 * Any non-null object, arrays included.
 * @param {unknown} value -
 * @returns {boolean}
 */
export function isObjectLike(value) {
    return typeof value === 'object' && value !== null;
}

/**
 * A non-null, non-array object: the shape a keyed record has.
 * @param {unknown} value -
 * @returns {value is Record<string, unknown>}
 */
export function isRecordObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record whose prototype is `Object.prototype` or `null`, so a class
 * instance, a Map and a Date are excluded.
 * @param {unknown} value -
 * @returns {boolean}
 */
export function isPlainObject(value) {
    if (!isRecordObject(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * An empty or non-string value can never identify an owner, an item or a
 * stored record, so it is a caller bug rather than data to normalize.
 * @param {{value: unknown, name: string}} arg0 - `name` is the option name reported on the error.
 * @returns {void}
 * @throws {ConfigurationError} When `value` is not a non-empty string.
 */
export function assertNonEmptyString({ value, name }) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigurationError({ message: `${name} must be a non-empty string.`, options: { option: name } });
    }
}
