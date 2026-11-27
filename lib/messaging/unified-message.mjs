
// @ts-check
/**
 * @file Canonical UnifiedMessage typedefs + re-export surface.
 * @version 0.12.0
 *
 * @description
 * The shared message-shape typedefs, the injection-marker readers
 * (`isInjection`, `getInjectionMark`) and the public re-exports of the
 * message factories and normalizers.
 */

import { INJECTION_META_KEY } from '../core/constants/index.mjs';

export {
    createUserMessage,
    createSystemMessage,
    createAssistantMessage,
    createToolCallMessage,
    createToolCallMessages,
    createToolResultMessage,
    normalizeHistory,
    normalizeToOAI,
    normalizeToAAI,
    normalizeToGAI,
    stripInjectionMeta,
    attachNative,
    getNative,
    dedupeMessages
} from './messages.mjs';

/**
 * @typedef {Object} UnifiedSystemMessage
 * @property {'system_message'} [type] - JAI-shape marker.
 * @property {'system'|'developer'} [role] - OAI/AAI/GAI shape ('developer' for o-series).
 * @property {string} content
 */

/**
 * @typedef {Object} UnifiedUserMessage
 * @property {'user_message'} [type] - JAI-shape marker.
 * @property {'user'} [role] - OAI/AAI/GAI shape.
 * @property {string|Array<Record<string, unknown>>} content
 */

/**
 * @typedef {Object} UnifiedAssistantTextMessage
 * @property {'assistant_message_text'} [type] - JAI shape.
 * @property {'assistant'|'model'} [role] - OAI/AAI shape ('model' for GAI).
 * @property {string} content
 * @property {string} [thoughtSignature] - OAI/AAI wire name.
 * @property {string} [thought_signature] - JAI/GAI wire name.
 */

/**
 * @typedef {Object} UnifiedAssistantToolCallMessage
 * @property {'assistant_message_tool'} [type] - JAI shape.
 * @property {'assistant'} [role] - OAI/AAI shape.
 * @property {string} id
 * @property {string} toolName
 * @property {string|Record<string, unknown>} content - Arguments (string for JAI/OAI, object for GAI).
 * @property {string} [thoughtSignature] - OAI/AAI wire name.
 * @property {string} [thought_signature] - JAI/GAI wire name.
 */

/**
 * @typedef {Object} UnifiedToolResultMessage
 * @property {'tool_message'} [type] - JAI shape.
 * @property {'tool'} [role] - OAI shape.
 * @property {string} id - JAI/GAI marker.
 * @property {string} tool_call_id - OAI marker.
 * @property {string} toolName
 * @property {string|Record<string, unknown>} result - Raw tool result.
 * @property {string|Array<Record<string, unknown>>} [content] - OAI wire content (string) or AAI content blocks (Array).
 * @property {boolean} [success] - Failure envelope flag (success:false maps to is_error).
 * @property {Record<string, unknown>} [functionResponse] - GAI content-block shape on role:'user'.
 * @property {Array<Record<string, unknown>>} [parts] - GAI content blocks.
 */

/**
 * @typedef {UnifiedSystemMessage|UnifiedUserMessage|UnifiedAssistantTextMessage|UnifiedAssistantToolCallMessage|UnifiedToolResultMessage} UnifiedMessage
 */

/**
 * A loose message row for the injection/turn readers — any shape with the
 * fields those helpers probe (type, role, content, parts) and arbitrary
 * extra keys (the injection marker, merciId).
 * @typedef {Record<string, unknown>} MessageRow
 */

/**
 * Returns the capability id a message was injected for, or null.
 * @param {{m: MessageRow|null|undefined}} arg0
 * @returns {string|null}
 */
function getInjectionMark({ m }) {
    return (m && typeof m === 'object' && m[INJECTION_META_KEY] != null)
        ? /** @type {string} */ (m[INJECTION_META_KEY])
        : null;
}

/**
 * True when `m` is an SDK row-injection. When `capId` is given, matches only
 * that capability; otherwise matches any injection.
 * @param {{m: MessageRow, capId?: string}} arg0
 * @returns {boolean}
 */
export function isInjection({ m, capId }) {
    const mark = getInjectionMark({ m });
    if (mark == null) return false;
    return capId ? mark === capId : true;
}

/**
 * True when `m` is a genuine user turn (not a tool-result carrier).
 * @param {{m: MessageRow}} arg0
 * @returns {boolean}
 */
export function isGenuineUserTurn({ m }) {
    if (!m || typeof m !== 'object' || isInjection({ m })) return false;
    if (m.type === 'tool_message' || m.type === 'tool_result_message') return false;
    if (m.role === 'tool') return false;
    if (m.type === 'user_message') return true;
    if (m.role === 'user') {
        if (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) return false;
        if (Array.isArray(m.parts) && m.parts.some(p => p && p.functionResponse)) return false;
        return true;
    }
    return false;
}

/**
 * Counts genuine conversation turns (user messages), ignoring SDK
 * row-injections and tool-result carriers (role:'tool' messages, tool_message
 * rows, and tool_result / functionResponse content blocks). Used for the
 * memory sync-gap / distillation-delta math, where counting every message
 * inflated the gap ~3x.
 * @param {{messages: Array<MessageRow>}} arg0
 * @returns {number}
 */
export function countConversationTurns({ messages }) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) if (isGenuineUserTurn({ m })) n++;
    return n;
}
