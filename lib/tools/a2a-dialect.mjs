// @ts-check


/**
 * @file A2A (Agent-to-Agent) wire vocabulary.
 * @version 0.12.0
 *
 * @description
 * One home for the words that travel on an A2A wire: the method names of both
 * dialects, how a message part and a message are read, how a task state is
 * spelled in each dialect, and the two JSON-RPC envelope shapes. The client
 * (`a2a.mjs`) and the server (`a2a-server.mjs`) import them instead of keeping
 * private copies, so a dialect change lands in one place.
 */
import { A2A_METHODS, A2A_TASK_STATES, JSON_RPC_VERSION } from '../core/constants/index.mjs';

/**
 * A message part in either dialect: text, a nested content object, or a data
 * part. Everything is optional — a part carries only what its peer emitted.
 * @typedef {{text?: string, content?: {text?: string}, kind?: string, data?: unknown}} A2APartLike
 */
/** @typedef {{parts?: Array<unknown>}} A2AMessageLike */


/**
 * Method names accepted per dialect.
 * @type {Record<string, string>}
 */
export const LEGACY_METHODS = {
    [A2A_METHODS.SEND_MESSAGE]: 'message/send',
    [A2A_METHODS.STREAM_MESSAGE]: 'message/stream',
    [A2A_METHODS.GET_TASK]: 'tasks/get',
    [A2A_METHODS.LIST_TASKS]: 'tasks/list',
    [A2A_METHODS.CANCEL_TASK]: 'tasks/cancel',
    [A2A_METHODS.RESUBSCRIBE_TASK]: 'tasks/resubscribe'
};

/**
 * @type {Record<string, string>}
 */
export const V1_METHODS = {
    [A2A_METHODS.SEND_MESSAGE]: 'SendMessage',
    [A2A_METHODS.STREAM_MESSAGE]: 'SendStreamingMessage',
    [A2A_METHODS.GET_TASK]: 'GetTask',
    [A2A_METHODS.LIST_TASKS]: 'ListTasks',
    [A2A_METHODS.CANCEL_TASK]: 'CancelTask',
    [A2A_METHODS.RESUBSCRIBE_TASK]: 'SubscribeToTask'
};

/**
 * The method table of each dialect, keyed by the `A2A_METHODS` operation name.
 * @type {Record<'v1'|'legacy', Record<string, string>>}
 */
export const A2A_RPC_METHODS = { v1: V1_METHODS, legacy: LEGACY_METHODS };


/**
 * Reads the dialect and operation a request's method name asks for. An
 * unrecognized method keeps the v1 dialect with an empty operation, which the
 * server answers as "method not found".
 * @param {{ method: string }} arg0
 * @returns {{ dialect: 'v1'|'legacy', op: string }}
 */
export function resolveDialect({ method }) {
    if (V1_METHODS[A2A_METHODS.SEND_MESSAGE] === method) return { dialect: 'v1', op: A2A_METHODS.SEND_MESSAGE };
    if (LEGACY_METHODS[A2A_METHODS.SEND_MESSAGE] === method) return { dialect: 'legacy', op: A2A_METHODS.SEND_MESSAGE };
    if (V1_METHODS[A2A_METHODS.STREAM_MESSAGE] === method) return { dialect: 'v1', op: A2A_METHODS.STREAM_MESSAGE };
    if (LEGACY_METHODS[A2A_METHODS.STREAM_MESSAGE] === method) return { dialect: 'legacy', op: A2A_METHODS.STREAM_MESSAGE };
    if (V1_METHODS[A2A_METHODS.GET_TASK] === method) return { dialect: 'v1', op: A2A_METHODS.GET_TASK };
    if (LEGACY_METHODS[A2A_METHODS.GET_TASK] === method) return { dialect: 'legacy', op: A2A_METHODS.GET_TASK };
    if (V1_METHODS[A2A_METHODS.LIST_TASKS] === method) return { dialect: 'v1', op: A2A_METHODS.LIST_TASKS };
    if (LEGACY_METHODS[A2A_METHODS.LIST_TASKS] === method) return { dialect: 'legacy', op: A2A_METHODS.LIST_TASKS };
    if (V1_METHODS[A2A_METHODS.CANCEL_TASK] === method) return { dialect: 'v1', op: A2A_METHODS.CANCEL_TASK };
    if (LEGACY_METHODS[A2A_METHODS.CANCEL_TASK] === method) return { dialect: 'legacy', op: A2A_METHODS.CANCEL_TASK };
    return { dialect: 'v1', op: '' };
}


/**
 * Extracts the text of a message part in either dialect.
 * @param {{ part: unknown }} arg0
 * @returns {string}
 */
export function partText({ part }) {
    if (!part || typeof part !== 'object') return '';
    const p = /** @type {A2APartLike} */ (part);
    if (typeof p.text === 'string') return p.text;
    if (p.content && typeof p.content.text === 'string') return p.content.text;
    if (p.kind === 'data') {
        try { return JSON.stringify(p.data ?? null); } catch { return ''; }
    }
    return '';
}


/**
 * Concatenates the text of every part of a message.
 * @param {{ message?: A2AMessageLike|null }} arg0
 * @returns {string}
 */
export function messageText({ message }) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts.map((p) => partText({ part: p })).filter(Boolean).join('\n');
}


/**
 * Every spelling of an A2A task state, mapped to the canonical v1.0 name.
 * The v1.0 binding uses the uppercase proto names; v0.3 used lowercase short
 * names. Both are accepted on the wire.
 * @type {Record<string, string>}
 */
const A2A_STATE_ALIASES = {
    [A2A_TASK_STATES.SUBMITTED]: A2A_TASK_STATES.SUBMITTED,
    submitted: A2A_TASK_STATES.SUBMITTED,
    [A2A_TASK_STATES.WORKING]: A2A_TASK_STATES.WORKING,
    working: A2A_TASK_STATES.WORKING,
    [A2A_TASK_STATES.COMPLETED]: A2A_TASK_STATES.COMPLETED,
    completed: A2A_TASK_STATES.COMPLETED,
    [A2A_TASK_STATES.FAILED]: A2A_TASK_STATES.FAILED,
    failed: A2A_TASK_STATES.FAILED,
    [A2A_TASK_STATES.CANCELED]: A2A_TASK_STATES.CANCELED,
    canceled: A2A_TASK_STATES.CANCELED,
    cancelled: A2A_TASK_STATES.CANCELED,
    [A2A_TASK_STATES.INPUT_REQUIRED]: A2A_TASK_STATES.INPUT_REQUIRED,
    'input-required': A2A_TASK_STATES.INPUT_REQUIRED,
    input_required: A2A_TASK_STATES.INPUT_REQUIRED,
    [A2A_TASK_STATES.REJECTED]: A2A_TASK_STATES.REJECTED,
    rejected: A2A_TASK_STATES.REJECTED,
    [A2A_TASK_STATES.AUTH_REQUIRED]: A2A_TASK_STATES.AUTH_REQUIRED,
    'auth-required': A2A_TASK_STATES.AUTH_REQUIRED,
    auth_required: A2A_TASK_STATES.AUTH_REQUIRED
};


/**
 * Every canonical task state, spelled the v0.3 (legacy) way.
 * @type {Record<string, string>}
 */
const LEGACY_STATE_ALIASES = {
    [A2A_TASK_STATES.SUBMITTED]: 'submitted',
    [A2A_TASK_STATES.WORKING]: 'working',
    [A2A_TASK_STATES.COMPLETED]: 'completed',
    [A2A_TASK_STATES.FAILED]: 'failed',
    [A2A_TASK_STATES.CANCELED]: 'canceled',
    [A2A_TASK_STATES.INPUT_REQUIRED]: 'input-required',
    [A2A_TASK_STATES.REJECTED]: 'rejected',
    [A2A_TASK_STATES.AUTH_REQUIRED]: 'auth-required'
};


/**
 * Maps a wire task state to its canonical v1.0 name.
 * @param {{ rawState: string }} arg0
 * @returns {string}
 */
export function canonicalState({ rawState }) {
    return A2A_STATE_ALIASES[rawState] ?? rawState;
}


/**
 * Maps a task state to the v0.3 spelling; an unknown state passes through.
 * @param {{ state: string }} arg0
 * @returns {string}
 */
export function legacyState({ state }) {
    return LEGACY_STATE_ALIASES[state] ?? state;
}


/**
 * A successful JSON-RPC response.
 * @param {{ id: string|number|null, result: unknown }} arg0
 * @returns {{ jsonrpc: string, id: string|number|null, result: unknown }}
 */
export function rpcResult({ id, result }) {
    return { jsonrpc: JSON_RPC_VERSION, id, result };
}


/**
 * A JSON-RPC error response.
 * @param {{ id: string|number|null, code: number, message: string }} arg0
 * @returns {{ jsonrpc: string, id: string|number|null, error: { code: number, message: string } }}
 */
export function rpcError({ id, code, message }) {
    return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}
