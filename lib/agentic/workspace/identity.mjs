// @ts-check


/**
 * @file The one workspace identifier rule.
 * @version 0.12.0
 *
 * @description
 * A workspace `identifier` is optional. `null`/`undefined` mean absent, a
 * string is trimmed and an empty one becomes absent, and any other type is a
 * configuration error, so the handle, every event, and a hook target agree on
 * one value.
 */

import { ConfigurationError } from '../../core/errors.mjs';

/**
 * Normalize an optional workspace identifier.
 * @param {{value: unknown}} arg0 -
 * @returns {string|null} The trimmed identifier, or null when absent.
 * @throws {ConfigurationError} `invalid_identifier` when the value is not a string, null, or undefined.
 */
export function normalizeIdentifier({ value }) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
        throw new ConfigurationError({
            message: 'identifier must be a string or null.',
            options: { option: 'invalid_identifier' }
        });
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}
