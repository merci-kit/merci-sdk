// @ts-check
/**
 * @file The `transportOptions` validator every native connector shares.
 * @version 0.22.0
 *
 * @description
 * Moved unchanged from `lib/backends/oai.mjs`: the four keys the transports
 * accept, the shape of each, and the refusal of a positive `maxRetries` because
 * Merci owns retries. `timeout` is the first-headers deadline; `0` or a negative
 * value uses the transport default.
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { readClosedOptions } from '../../support/options.mjs';

/**
 * The validated `options.transportOptions`.
 * @typedef {Object} TransportOptions
 * @property {typeof fetch} [fetch] - Fetch implementation for the transport.
 * @property {Record<string, string|null|undefined>} [defaultHeaders] - Headers under the per-call ones.
 * @property {number} [timeout] - First-headers deadline in milliseconds.
 * @property {number} [maxRetries] - Present only as 0/absent; a positive value is refused.
 */

/** The four keys the transports accept. */
const TRANSPORT_OPTION_KEYS = ['fetch', 'defaultHeaders', 'timeout', 'maxRetries'];

/**
 * Validates `options.transportOptions`.
 * @param {{value?: TransportOptions}} arg0
 * @returns {TransportOptions}
 */
export function readTransportOptions({ value } = {}) {
    const options = /** @type {TransportOptions} */ (readClosedOptions({
        value,
        allowed: TRANSPORT_OPTION_KEYS,
        name: 'transportOptions',
        label: 'options.transportOptions'
    }) ?? {});
    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
        throw new ConfigurationError({ message: 'transportOptions.fetch must be a fetch function.', options: { option: 'transportOptions.fetch' } });
    }
    if (options.defaultHeaders !== undefined) {
        const headers = options.defaultHeaders;
        const isPlainObject = headers !== null && typeof headers === 'object' && !Array.isArray(headers);
        const allStrings = isPlainObject && Object.values(headers).every((entry) => typeof entry === 'string');
        if (!allStrings) {
            throw new ConfigurationError({ message: 'transportOptions.defaultHeaders must be a plain object of string values.', options: { option: 'transportOptions.defaultHeaders' } });
        }
    }
    if (options.timeout !== undefined && !(typeof options.timeout === 'number' && Number.isFinite(options.timeout))) {
        throw new ConfigurationError({ message: 'transportOptions.timeout must be a finite number of milliseconds.', options: { option: 'transportOptions.timeout' } });
    }
    if (options.maxRetries) {
        throw new ConfigurationError({ message: 'transportOptions.maxRetries is not supported: Merci owns retries (lib/support/retry-policy.mjs) and the transport never retries.', options: { option: 'transportOptions.maxRetries' } });
    }
    return options;
}
