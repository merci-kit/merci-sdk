// @ts-check
/**
 * @file options — the closed-key options reader.
 * @version 0.12.0
 *
 * @description
 * A per-client options bag accepts a fixed set of keys and refuses the rest
 * instead of ignoring a typo. Three backends hand-rolled the same shape guard
 * and unknown-key loop; this is that loop, with the caller's own label so the
 * message still names the path the user wrote (`options.transportOptions`).
 */
import { configurationError } from '../core/errors.mjs';

/**
 * Reads a closed-key options object. `null`/`undefined` is `null` so the caller
 * keeps its own default (a bag's empty default is not the same for every
 * caller).
 * @param {{value: unknown, allowed: ReadonlyArray<string>, name: string, label?: string}} arg0 -
 *   `name` prefixes the unknown-key message and names the error option; `label`
 *   is the path in the shape message and defaults to `name`.
 * @returns {Record<string, unknown>|null}
 * @throws {ConfigurationError} When the value is not an object or names an unknown key.
 */
export function readClosedOptions({ value, allowed, name, label = name }) {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw configurationError({ option: name, message: `${label} must be an object.` });
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) {
            throw configurationError({ option: name, message: `Unknown ${name} key '${key}'. Supported: ${allowed.join(', ')}.` });
        }
    }
    return record;
}
