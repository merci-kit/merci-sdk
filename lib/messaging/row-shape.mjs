// @ts-check
/**
 * @file Row-shape predicates shared by the inbox, guardrails and context assembly.
 * @version 0.12.0
 *
 * @description
 * The two "is this a user row / a system row?" answers. A row written for one
 * backend marks the turn with `type`, for another with `role`; both spell the
 * same turn, so every reader asks these instead of re-deriving the disjunction.
 *
 * Internal: deliberately NOT re-exported from `unified-message.mjs`, because
 * `merci-sdk/messaging` maps to that file verbatim and its exports are
 * published API.
 */

/**
 * A loose row: any shape carrying the `type`/`role` marker.
 * @typedef {Record<string, unknown>} MessageRow
 */

/**
 * True when `m` is a user turn, whatever wire shape it uses.
 *
 * Deliberately broader than `isGenuineUserTurn`: a tool-result carrier is still
 * a user row on the Anthropic wire, and the inbox placement rule and the input
 * guardrail both want to see it as one.
 * @param {{m: MessageRow|null|undefined}} arg0
 * @returns {boolean}
 */
export function isUserRow({ m }) {
    return !!m && (m.type === 'user_message' || m.role === 'user');
}

/**
 * True when `m` is a system/developer row.
 *
 * Deliberately WITHOUT `developer_message`: `messaging/messages.mjs` treats that
 * separate variant on its own, and widening this predicate to match it would
 * change the context merge there.
 * @param {{m: MessageRow|null|undefined}} arg0
 * @returns {boolean}
 */
export function isSystemRow({ m }) {
    return !!m && (m.type === 'system_message' || m.role === 'system' || m.role === 'developer');
}
