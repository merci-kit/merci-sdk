// @ts-check


/**
 * @file Public surface of the operator API modules.
 * @version 0.12.0
 *
 * @description
 * The barrel exposes the pure pieces (the bounded event ring and the terminal
 * status renderer) and the mountable HTTP handler, plus the API version and the
 * documented defaults. Importing it never opens a server; the host mounts the
 * handler on a `node:http` server it owns.
 */

import { LIMITS } from '../../core/limit-config.mjs';

/** The operator API response version. */
export const OPERATOR_API_VERSION = 1;

/**
 * The documented defaults for `createOperatorHttpHandler` (§3.8). The numeric
 * entries read the limit registry on access, so a host's limits apply to the
 * next handler.
 */
export const OPERATOR_DEFAULTS = Object.freeze({
    basePath: '/api/v1',
    statusPath: '/',
    get maxBodyBytes() { return LIMITS.operator_max_body_bytes; },
    get ringLimit() { return LIMITS.operator_ring_limit; },
    get recentEventsLimit() { return LIMITS.operator_recent_events_limit; },
    get statusMaxRows() { return LIMITS.operator_status_max_rows; },
    allowedHosts: ['localhost', '127.0.0.1', '::1']
});

export { createEventRing, DEFAULT_PREFIXES } from './ring.mjs';
export { formatStatus } from './status.mjs';
export { createOperatorHttpHandler } from './http.mjs';
