// @ts-check

/**
 * The parent inbox (wave 6 / SP3) — placing a background result into the next turn.
 *
 * A finished background delegation leaves a row on `session._pendingInputRows`.
 * The next turn must deliver it, and the placement is not free:
 *
 * - the row belongs to the turn that just ended, so it goes **after** the
 *   history and **before** the new prompt;
 * - a request must not **start** with an assistant row (Anthropic rejects a
 *   leading assistant turn), so when there is no history to sit after, the text
 *   folds into the new user prompt instead of becoming its own row.
 *
 * Both entry points (`runStep` and `ChatSession.run`) share this one rule, so the
 * two paths cannot drift.
 *
 * The inbox is also the host's queue panel: `listInboxRows`, `cancelInboxRow` and
 * `setInboxRowDelivery` are the same three operations OpenCode exposes as
 * `session.inbox.list|cancel|update`, and they only ever touch rows the running
 * turn has not claimed yet.
 */

import { isToolResultRow } from './transfer.mjs';
import { createToolResultMessage } from '../messaging/messages.mjs';
import { ProviderType } from '../core/constants/index.mjs';
import { isUserRow } from '../messaging/row-shape.mjs';
import { ConfigurationError } from '../core/errors.mjs';

/** @typedef {import('../messaging/row-shape.mjs').MessageRow} MessageRow */
/** @typedef {{_pendingInputRows?: Array<Object>}} ParentInboxSession */

/**
 * The last user row that carries a prompt. A tool result is a user row on the
 * Anthropic wire but it belongs to the exchange before it, so inserting between
 * a `tool_use` and its `tool_result` would break the pair.
 * @param {{rows: Array<MessageRow>}} arg0
 * @returns {number} index of the last prompt row, or -1
 */
function lastPromptIndex({ rows }) {
    for (let i = rows.length - 1; i >= 0; i--) {
        const m = rows[i];
        const isUser = isUserRow({ m });
        if (isUser && !isToolResultRow(m)) return i;
    }
    return -1;
}

/**
 * @param {{content: any, prefix: string}} arg0 content may be a string, a block array, or anything else
 * @returns {any}
 */
function withPrefix({ content, prefix }) {
    if (content === undefined || content === null) return prefix;
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
    return `${prefix}\n\n${String(content)}`;
}

/**
 * @param {{rows: Array<MessageRow>}} arg0
 * @returns {string}
 */
function textOf({ rows }) {
    return rows
        .map((/** @type {any} */ row) => {
            // Gemini/Vertex rows carry their text in `parts`, not `content`.
            if (Array.isArray(row?.parts)) {
                return row.parts
                    .map((/** @type {any} */ part) => (typeof part?.text === 'string' ? part.text : ''))
                    .filter(Boolean)
                    .join('\n');
            }
            const content = row?.content ?? row?.text ?? '';
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                return content
                    .map((/** @type {any} */ part) => (typeof part?.text === 'string' ? part.text : ''))
                    .filter(Boolean)
                    .join('\n');
            }
            return '';
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Folds the notification into the prompt row, whatever shape that row uses:
 * a Gemini/Vertex row carries its text in `parts`, not `content`.
 * @param {{prompt?: MessageRow|null, prefix: string}} arg0
 * @returns {MessageRow}
 */
function foldPrompt({ prompt, prefix }) {
    if (Array.isArray(prompt?.parts)) {
        return { ...prompt, parts: [{ text: prefix }, ...prompt.parts] };
    }
    return { ...prompt, content: withPrefix({ content: prompt?.content, prefix }) };
}

/** @param {{row: any}} arg0 @returns {Array<{id: string|null, name: string}>} */
function toolCallsOf({ row }) {
    if (!row || typeof row !== 'object') return [];
    if (Array.isArray(row.tool_calls)) {
        return row.tool_calls
            .filter((/** @type {any} */ c) => c && typeof c === 'object')
            .map((/** @type {any} */ c) => ({ id: c.id ?? null, name: c.function?.name ?? c.name ?? '' }));
    }
    if (Array.isArray(row.parts)) {
        return row.parts
            .filter((/** @type {any} */ p) => p && p.functionCall)
            .map((/** @type {any} */ p) => ({ id: p.functionCall.id ?? null, name: p.functionCall.name ?? '' }));
    }
    if (Array.isArray(row.content)) {
        return row.content
            .filter((/** @type {any} */ b) => b && b.type === 'tool_use')
            .map((/** @type {any} */ b) => ({ id: b.id ?? null, name: b.name ?? '' }));
    }
    if (row.type === 'assistant_message_tool') {
        // JAI carries the call on the row itself.
        return [{ id: row.id ?? null, name: row.toolName ?? '' }];
    }
    return [];
}

/**
 * The provider whose result shape a call row belongs to (the row's shape, not the
 * session's, because the history may have been built elsewhere).
 * @param {{row: any}} arg0
 * @returns {string}
 */
function providerOfRow({ row }) {
    if (row?.type === 'assistant_message_tool' || row?.type === 'tool_message') return ProviderType.JAI;
    if (Array.isArray(row?.parts)) return ProviderType.GOOGLE_GENAI;
    if (Array.isArray(row?.content) && row.content.some((/** @type {any} */ b) => b?.type === 'tool_use')) return ProviderType.ANTHROPIC;
    return ProviderType.OPENAI;
}

/** @param {{row: any}} arg0 @returns {string[]} every id/name a row answers */
function answersOf({ row }) {
    if (!row || typeof row !== 'object') return [];
    /** @type {string[]} */
    const out = [];
    if (row.tool_call_id) out.push(String(row.tool_call_id));
    if (row.type === 'tool_message' && row.id) out.push(String(row.id));
    if (Array.isArray(row.parts)) {
        for (const part of row.parts) {
            const response = part?.functionResponse;
            if (!response) continue;
            if (response.id) out.push(String(response.id));
            if (response.name) out.push(String(response.name));
        }
    }
    if (Array.isArray(row.content)) {
        for (const block of row.content) {
            if (block?.type === 'tool_result' && block.tool_use_id) out.push(String(block.tool_use_id));
        }
    }
    return out;
}

/**
 * N4: the notification is an assistant row, so it cannot sit right after a tool
 * call that has no result — the pair would be split. Close the round first: a
 * synthetic result for every call the turn never ran. The call did not produce an
 * output, and the row says exactly that (the model must not read it as success).
 * @param {{rows: any[], at: number}} arg0 - `at` is where the notification will go
 * @returns {any[]} synthetic results closing the round the history stops in
 */
function closeDanglingToolRound({ rows, at }) {
    if (at <= 0) return [];
    // The round the history stops in: the last call row before `at`, and only if
    // every row between it and `at` is an answer to it (otherwise a later turn came
    // between and the round is not the one being interrupted).
    let callAt = -1;
    for (let i = at - 1; i >= 0; i--) {
        if (toolCallsOf({ row: rows[i] }).length > 0) { callAt = i; break; }
    }
    if (callAt < 0) return [];
    for (let i = callAt + 1; i < at; i++) {
        if (isToolResultRow(rows[i]) || answersOf({ row: rows[i] }).length > 0) continue;
        return [];
    }
    const callRow = rows[callAt];
    const calls = toolCallsOf({ row: callRow });
    /** @type {Set<string>} */
    const answered = new Set();
    for (let i = callAt + 1; i < rows.length; i++) {
        for (const key of answersOf({ row: rows[i] })) answered.add(key);
    }
    const provider = providerOfRow({ row: callRow });
    // A multi-call row may be half answered: only the calls with no result get one.
    return calls
        .filter((call) => !(call.id != null && answered.has(String(call.id)))
            && !(call.name && answered.has(call.name)))
        .map((call) => createToolResultMessage({ provider, result: {
            id: call.id ?? undefined,
            name: call.name,
            success: false,
            error: 'This tool call did not run: a background subagent result was delivered before the turn could execute it.',
        } }));
}

/**
 * Places the queued inbox rows into a turn's message list.
 * Pure: the caller decides when to clear the inbox (a failed turn keeps it).
 * @param {{rows: Array<import('../messaging/unified-message.mjs').MessageRow>, pending: Array<import('../messaging/unified-message.mjs').MessageRow>}} arg0
 * @returns {Array<import('../messaging/unified-message.mjs').MessageRow>}
 */
export function interleavePendingRows({ rows, pending }) {
    if (!Array.isArray(rows)) return rows;
    if (!Array.isArray(pending) || pending.length === 0) return rows;
    // Nothing at all: a notification is information, so deliver it as a user row
    // rather than let the request start with an assistant turn.
    if (rows.length === 0) return pending.map((row) => ({ ...row, role: 'user', type: 'user_message' }));
    const last = lastPromptIndex({ rows });
    const endsWithPrompt = last === rows.length - 1;
    // Only the new prompt: separate rows would lead with an assistant turn, and
    // there is no history to hang anything off.
    if (endsWithPrompt && last === 0) {
        // A row with no extractable text (a tool-call-only part) would be
        // claimed and then dropped; deliver a plain marker instead.
        const prefix = textOf({ rows: pending }) || '[background delegation update]';
        return [foldPrompt({ prompt: rows[0], prefix })];
    }
    // N4: the notification goes after the history and before the prompt (or at the
    // end), and it must not split a `tool_use`/`tool_result` pair. A history that
    // stops mid-round is closed with a synthetic result first.
    const at = endsWithPrompt ? last : rows.length;
    const closing = closeDanglingToolRound({ rows, at });
    const withClosing = closing.length === 0 ? rows : [...rows.slice(0, at), ...closing, ...rows.slice(at)];
    if (endsWithPrompt) {
        const notifyAt = at + closing.length;
        return [...withClosing.slice(0, notifyAt), ...pending, ...withClosing.slice(notifyAt)];
    }
    // The list ends with a tool exchange or an assistant turn: appending keeps
    // the `tool_use`/`tool_result` pair intact.
    return [...withClosing, ...pending];
}

/**
 * Takes `rows` out of the inbox. Claimed by object identity (`includes`): a
 * structurally equal row is a different delivery, not this one.
 * An empty claim leaves the field untouched rather than replacing it with `[]`.
 * @param {{session: object, rows: Array<Object>, onClaim?: ((row: MessageRow) => void)|null}} arg0
 */
export function claimInboxRows({ session, rows, onClaim = null }) {
    if (!rows || rows.length === 0) return;
    const parent = /** @type {ParentInboxSession} */ (session);
    const queued = parent._pendingInputRows;
    if (!Array.isArray(queued)) { parent._pendingInputRows = []; return; }
    const removed = queued.filter((row) => rows.includes(row));
    parent._pendingInputRows = queued.filter((row) => !rows.includes(row));
    if (typeof onClaim === 'function') for (const row of removed) onClaim(/** @type {MessageRow} */ (row));
}

/**
 * Puts `rows` back at the FRONT of the inbox, so a restored row is delivered
 * before anything that landed while the failed turn was in flight.
 * @param {{session: object, rows: Array<Object>}} arg0
 */
export function restoreInboxRows({ session, rows }) {
    if (!rows || rows.length === 0) return;
    const parent = /** @type {ParentInboxSession} */ (session);
    const queued = parent._pendingInputRows;
    parent._pendingInputRows = [
        ...rows,
        ...(Array.isArray(queued) ? queued : []),
    ];
}

/**
 * The one delivery enum: `steer` reaches a RUNNING turn at its next step
 * boundary, `queue` waits for the next turn. Anything else is a host bug, not a
 * third mode.
 * @param {{delivery: unknown}} arg0
 * @returns {'steer'|'queue'}
 */
export function normalizeDelivery({ delivery }) {
    if (delivery === 'steer' || delivery === 'queue') return delivery;
    throw new ConfigurationError({
        message: `delivery must be 'steer' or 'queue', got ${String(delivery)}.`,
        options: { option: 'delivery' }
    });
}

/**
 * A row matches either by identity (the object `enqueueInput` returned) or by
 * its stable `merciId` — the id a UI keeps after a round-trip through its own
 * store. Structural equality is NOT a match: two equal texts are two messages.
 * @param {{row: any, input: unknown}} arg0
 * @returns {boolean}
 */
function isSameInput({ row, input }) {
    if (row === input) return true;
    return typeof input === 'string' && typeof row?.merciId === 'string' && row.merciId === input;
}

/**
 * The rows still waiting, in delivery order — a snapshot, so a caller cannot
 * mutate the queue it is rendering.
 * @param {{session: object}} arg0
 * @returns {Array<MessageRow>}
 */
export function listInboxRows({ session }) {
    const parent = /** @type {ParentInboxSession} */ (session);
    return /** @type {MessageRow[]} */ (Array.isArray(parent._pendingInputRows) ? [...parent._pendingInputRows] : []);
}

/**
 * Drops one pending row. A row the running turn already claimed is no longer in
 * the inbox, so this returns null for it: cancelling cannot recall a message the
 * model has seen.
 * @param {{session: object, input: unknown}} arg0
 * @returns {MessageRow|null} the removed row
 */
export function cancelInboxRow({ session, input }) {
    const parent = /** @type {ParentInboxSession} */ (session);
    const inbox = parent._pendingInputRows;
    if (!Array.isArray(inbox)) return null;
    const at = inbox.findIndex((row) => isSameInput({ row, input }));
    if (at < 0) return null;
    const [removed] = inbox.splice(at, 1);
    return /** @type {MessageRow} */ (removed);
}

/**
 * Switches a pending row between `steer` and `queue`, which is what a queue
 * panel's toggle does before the turn claims it.
 * @param {{session: object, input: unknown, delivery: unknown}} arg0
 * @returns {MessageRow|null} the row, or null when it is not pending
 */
export function setInboxRowDelivery({ session, input, delivery }) {
    const mode = normalizeDelivery({ delivery });
    const parent = /** @type {ParentInboxSession} */ (session);
    const inbox = parent._pendingInputRows;
    if (!Array.isArray(inbox)) return null;
    const row = /** @type {any} */ (inbox.find((entry) => isSameInput({ row: entry, input })));
    if (!row) return null;
    row.delivery = mode;
    return /** @type {MessageRow} */ (row);
}

/**
 * Takes the rows a `select` predicate chooses out of the inbox, by identity, in
 * inbox order. `inbox` is read once: the remaining rows are filtered from that
 * snapshot, never from the reassigned field.
 * @param {{session: object, select: (row: MessageRow) => boolean, onClaim?: ((row: MessageRow) => void)|null}} arg0
 * @returns {Array<MessageRow>} the claimed rows
 */
function claimInboxBy({ session, select, onClaim = null }) {
    const parent = /** @type {ParentInboxSession} */ (session);
    const inbox = /** @type {Array<MessageRow>} */ (Array.isArray(parent._pendingInputRows) ? parent._pendingInputRows : []);
    const claimed = inbox.filter((row) => select(row));
    if (claimed.length === 0) return [];
    parent._pendingInputRows = inbox.filter((row) => !claimed.includes(row));
    if (typeof onClaim === 'function') for (const row of claimed) onClaim(row);
    return claimed;
}

/**
 * Claims the `delivery: 'steer'` rows for a step boundary.
 * @param {{session: object, onClaim?: ((row: MessageRow) => void)|null}} arg0
 * @returns {Array<MessageRow>} the rows to inject into the running turn
 */
export function claimSteerRows({ session, onClaim = null }) {
    return claimInboxBy({ session, onClaim, select: (row) => row?.delivery === 'steer' });
}

/**
 * A row the host submitted for this run. A row with no `delivery` is a
 * background delegation result: conversation state, not an instruction.
 * @param {MessageRow} row
 * @returns {boolean}
 */
export function isSubmittedInput(row) {
    return row?.delivery === 'steer' || row?.delivery === 'queue';
}

/**
 * Claims the rows for ONE turn: every `steer` row still waiting, plus the FIRST
 * `queue` row. That is OpenCode's `SessionInbox.promote` rule — steers ride a
 * turn together, but each queued message gets a turn of its own, so a user who
 * sends three messages while the agent works gets three answers, not one.
 *
 * `includeBackground` is for an explicit drain: the drain IS the "next turn" SP3
 * promises a background delegation result, so the waiting conversation state
 * rides the turn instead of waiting for a `run()` that may never come.
 *
 * A row with no `delivery` is otherwise conversation state, not an instruction,
 * so it is not claimed here.
 * @param {{session: object, onClaim?: ((row: MessageRow) => void)|null, includeBackground?: boolean}} arg0
 * @returns {Array<MessageRow>} the rows that start the next turn
 */
export function claimTurnRows({ session, onClaim = null, includeBackground = false }) {
    let queuedTaken = false;
    return claimInboxBy({
        session,
        onClaim,
        select: (row) => {
            if (row?.delivery === 'steer') return true;
            if (row?.delivery === 'queue' && !queuedTaken) { queuedTaken = true; return true; }
            return includeBackground && !isSubmittedInput(row);
        }
    });
}

/**
 * Claims the rows for ONE inbox-driven turn, or leaves them pending when the
 * run's budget is spent. The budget is the bound a caller with untrusted input
 * needs: a host that enqueues on every token would otherwise keep one `run()`
 * alive forever. The rows are not lost — `listInboxRows` still shows them and
 * the next run delivers them — they just stop extending this one.
 *
 * `onExhausted` runs at most once per budget, whichever layer (`run()` or the
 * loop inside it) notices the spent cap first.
 * @param {{session: object, budget: {left: number, exhausted?: boolean}, onClaim?: ((row: MessageRow) => void)|null, onExhausted?: ((arg0: {pending: number}) => void)|null, includeBackground?: boolean}} arg0
 * @returns {Array<MessageRow>} the rows that start the next turn, or none
 */
export function claimInboxTurn({ session, budget, onClaim = null, onExhausted = null, includeBackground = false }) {
    const pending = listInboxRows({ session }).filter((row) => includeBackground || isSubmittedInput(row));
    if (pending.length === 0) return [];
    if (!(budget.left > 0)) {
        if (budget.exhausted !== true) {
            budget.exhausted = true;
            if (typeof onExhausted === 'function') onExhausted({ pending: pending.length });
        }
        return [];
    }
    budget.left -= 1;
    return claimTurnRows({ session, onClaim, includeBackground });
}
