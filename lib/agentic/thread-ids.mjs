// @ts-check


/**
 * @file The one thread-id rule shared by the scheduler, the workspace, the
 * engine runner, and spawns.
 * @version 0.12.0
 *
 * @description
 * A thread id is `${kind}:${id}`. Both parts are strings that are non-empty
 * after trim, so a host can rebuild an id from the same two values and every
 * consumer joins on the same string. Internal spaces are allowed; both parts
 * are trimmed before building, so `work: MER-1 ` becomes `work:MER-1`.
 */

import { ConfigurationError } from '../core/errors.mjs';

/**
 * Build the deterministic thread id for one identity. The output is trimmed.
 * @param {{kind: string, id: string}} arg0 -
 * @returns {string}
 * @throws {ConfigurationError} `invalid_thread_id` when a part is not a string or is empty after trim.
 */
export function threadIdFor({ kind, id }) {
    for (const part of [kind, id]) {
        if (typeof part !== 'string' || part.trim() === '') {
            throw new ConfigurationError({
                message: 'A thread id part must be a non-empty string.',
                options: { option: 'invalid_thread_id' }
            });
        }
    }
    return `${kind.trim()}:${id.trim()}`;
}
