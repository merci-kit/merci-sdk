// @ts-check
/** @file MCP/A2A protocol wire constants (timeouts, JSON-RPC, agent-card path). @version 0.12.0 */

import { LIMIT_REGISTRY } from './limits.mjs';


/** Well-known path where an A2A agent card is advertised. */
export const WELL_KNOWN_AGENT_CARD_PATH = '/.well-known/agent-card.json';


/** Default MCP server call timeout (ms) — the SDK's own default. This value is the code default; the effective value is `LIMITS.mcp_default_timeout_ms` / `getLimits()`. */
export const MCP_DEFAULT_TIMEOUT_MS = LIMIT_REGISTRY.mcp_default_timeout_ms.default;

/**
 * Upper bound (ms) on the `server/discover` probe a modern-era connect sends.
 *
 * The SDK's default is the standard 60 s request timeout. A legacy server that
 * silently ignores an unknown pre-`initialize` request would then stall every
 * `'auto'` connect (and every reconnect attempt) for a minute before falling
 * back, so merci caps the probe. On stdio a silent probe is a legacy server;
 * on HTTP it is an outage.
 *
 * This value is the code default; the effective value is
 * `LIMITS.mcp_probe_timeout_ms` / `getLimits()`.
 */
export const MCP_PROBE_TIMEOUT_MS = LIMIT_REGISTRY.mcp_probe_timeout_ms.default;

/**
 * Default cap on an A2A request body, in bytes. This value is the code default;
 * the effective value is `LIMITS.a2a_request_max_body_bytes` / `getLimits()`.
 */
export const A2A_REQUEST_MAX_BODY_BYTES = LIMIT_REGISTRY.a2a_request_max_body_bytes.default;


/** JSON-RPC version used by MCP transport. */
export const JSON_RPC_VERSION = '2.0';


// ─── A2A v1.0.0 (Linux Foundation) wire constants ─────────────────────────────
// The A2A JSON binding uses the uppercase proto enum names, not the short
// lowercase ones: a task in the completed state is "TASK_STATE_COMPLETED".

/** A2A protocol version implemented by this SDK. */
export const A2A_PROTOCOL_VERSION = '1.0';

/** Content type of an A2A JSON-RPC request or response. */
export const A2A_CONTENT_TYPE = 'application/a2a+json';

/** Header carrying the A2A protocol version. */
export const A2A_VERSION_HEADER = 'A2A-Version';

/** The A2A JSON-RPC method set (v1.0.0). */
export const A2A_METHODS = Object.freeze({
    SEND_MESSAGE: 'message/send',
    STREAM_MESSAGE: 'message/stream',
    GET_TASK: 'tasks/get',
    LIST_TASKS: 'tasks/list',
    CANCEL_TASK: 'tasks/cancel',
    RESUBSCRIBE_TASK: 'tasks/resubscribe'
});

/** A2A task states (v1.0.0 wire values). */
export const A2A_TASK_STATES = Object.freeze({
    SUBMITTED: 'TASK_STATE_SUBMITTED',
    WORKING: 'TASK_STATE_WORKING',
    COMPLETED: 'TASK_STATE_COMPLETED',
    FAILED: 'TASK_STATE_FAILED',
    CANCELED: 'TASK_STATE_CANCELED',
    INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED',
    REJECTED: 'TASK_STATE_REJECTED',
    AUTH_REQUIRED: 'TASK_STATE_AUTH_REQUIRED'
});

/** A2A message roles (v1.0.0 wire values). */
export const A2A_ROLES = Object.freeze({
    USER: 'ROLE_USER',
    AGENT: 'ROLE_AGENT'
});

/** A2A task states that end a task. */
export const A2A_TERMINAL_STATES = Object.freeze([
    A2A_TASK_STATES.COMPLETED,
    A2A_TASK_STATES.FAILED,
    A2A_TASK_STATES.CANCELED,
    A2A_TASK_STATES.REJECTED
]);

/** SSE headers an A2A streaming response must carry. */
export const A2A_SSE_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
});

