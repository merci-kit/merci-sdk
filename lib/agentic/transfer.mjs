// @ts-check
/**
 * @file transfer — the single cross-instance context-transfer primitive.
 * @version 0.12.0
 *
 * @description
 * One place that turns an engine's ordered upstream units into what the next
 * step sees: `stringify` (rendered text) or `ledger` (real message rows),
 * optionally windowed (`select`) and with the dropped prefix compacted
 * (`compact` → summary) or made visible as a loss marker. The ledger is the
 * canonical carrier; every mode is a renderer over it.
 *
 * Reuses the existing primitives — `stringifyTemplateValue`, `foldContext`,
 * `truncateForPrompt` and the message factories — so all four engines (DAG
 * step, StateMachine node, discussion turn, delegation) share one
 * implementation. The glue still owns WHEN it builds units and where it
 * attaches `{ text, rows }`; this module owns HOW they render.
 *
 * Order is invariant: units keep their original sequence (sorting a
 * conversation breaks the flow). `select` is a window, not a reorder.
 */

import { ConfigurationError } from '../core/errors.mjs';
import { createUserMessage } from '../messaging/messages.mjs';
import { foldContext } from './context-fold.mjs';
import { truncateForPrompt, stringifyTemplateValue } from '../support/utils.mjs';
import { LIMITS } from '../core/limit-config.mjs';

/**
 * One upstream unit handed to the transfer renderer. A step / node / agent turn
 * contributes its final output (for `stringify`) and/or its real message rows
 * (for `ledger`). `provider` is the provider those rows were shaped for.
 * @typedef {Object} TransferUnit
 * @property {string} id
 * @property {unknown} [output]
 * @property {unknown} [data]
 * @property {Array<import('./chat-session.mjs').ChatRow>} [messages]
 * @property {string} [provider]
 */

/**
 * The transfer option bag: a preset name plus the per-call overrides.
 * @typedef {Object} TransferOptions
 * @property {string} [preset]
 * @property {'stringify'|'ledger'} [mode]
 * @property {'all'|'tail'} [select]
 * @property {boolean} [compact]
 * @property {number} [tail]
 * @property {Function|null} [summarize]
 * @property {string} [markerLabel]
 */

/**
 * The normalized transfer policy.
 * @typedef {Object} TransferPolicy
 * @property {'stringify'|'ledger'} mode
 * @property {'all'|'tail'} select
 * @property {boolean} compact
 * @property {number} tail
 * @property {Function|null} summarize
 * @property {string} markerLabel
 */

/** Selectable transfer modes. */
export const TRANSFER_MODES = ['stringify', 'ledger'];

/** Selectable windowing strategies (order is always preserved). */
export const TRANSFER_SELECTS = ['all', 'tail'];

/** Default marker label used when a dropped prefix has no summary. */
export const TRANSFER_MARKER_LABEL = 'Earlier context omitted';

/**
 * Named presets. Compacted variants select a window (compaction requires
 * dropping something); `ledger-compact` is the default-window alias.
 * @type {Record<string, Partial<TransferPolicy>>}
 */
export const TRANSFER_PRESETS = Object.freeze({
    stringify: { mode: 'stringify', select: 'all', compact: false },
    ledger: { mode: 'ledger', select: 'all', compact: false },
    'ledger-selected': { mode: 'ledger', select: 'tail', compact: false },
    'ledger-compact': { mode: 'ledger', select: 'tail', compact: true },
    'ledger-selected-compact': { mode: 'ledger', select: 'tail', compact: true },
});

/**
 * Resolves a preset name or an option object into the canonical policy.
 * Unknown presets / modes / selects throw a `ConfigurationError` (fail loud at
 * the config boundary rather than silently rendering the wrong shape).
 * @param {{transfer?: string|TransferOptions|null}} [arg0]
 * @returns {TransferPolicy}
 */
export function normalizeTransfer({ transfer = null } = {}) {
    /** @type {Record<string, any>} */
    let raw;
    if (transfer == null) {
        raw = {};
    } else if (typeof transfer === 'string') {
        const preset = TRANSFER_PRESETS[transfer];
        if (!preset) {
            throw new ConfigurationError({ message: `Unknown transfer preset "${transfer}". Valid: ${Object.keys(TRANSFER_PRESETS).join(', ')}`, options: { option: 'transfer' } });
        }
        raw = { ...preset };
    } else if (typeof transfer === 'object') {
        const base = transfer.preset != null ? TRANSFER_PRESETS[transfer.preset] : null;
        if (transfer.preset != null && !base) {
            throw new ConfigurationError({ message: `Unknown transfer preset "${transfer.preset}". Valid: ${Object.keys(TRANSFER_PRESETS).join(', ')}`, options: { option: 'transfer' } });
        }
        raw = { ...(base ?? {}), ...transfer };
    } else {
        throw new ConfigurationError({ message: `transfer must be a preset name or an object (got ${typeof transfer})`, options: { option: 'transfer' } });
    }

    const mode = raw.mode ?? 'stringify';
    if (!TRANSFER_MODES.includes(mode)) {
        throw new ConfigurationError({ message: `transfer.mode must be one of ${TRANSFER_MODES.join('|')} (got ${JSON.stringify(mode)})`, options: { option: 'transfer' } });
    }
    const select = raw.select ?? 'all';
    if (!TRANSFER_SELECTS.includes(select)) {
        throw new ConfigurationError({ message: `transfer.select must be one of ${TRANSFER_SELECTS.join('|')} (got ${JSON.stringify(select)})`, options: { option: 'transfer' } });
    }
    const tail = Number.isFinite(raw.tail) && raw.tail > 0 ? Math.floor(raw.tail) : LIMITS.transfer_tail_rows;
    return {
        mode,
        select,
        compact: raw.compact === true,
        tail,
        summarize: raw.summarize ?? null,
        markerLabel: typeof raw.markerLabel === 'string' && raw.markerLabel ? raw.markerLabel : TRANSFER_MARKER_LABEL,
    };
}

/**
 * True when a row is a tool result — the continuation of an assistant tool
 * call. Covers the OAI `role:'tool'` shape and the JAI/GAI typed rows
 * (`tool_message`, `tool_result_message`, `functionResponse` parts). A message
 * run that STARTS on one is dangling (its call is missing), so it cannot be
 * replayed as history and must be degraded to a digest instead.
 * @param {unknown} row
 * @returns {boolean}
 */
export function isToolResultRow(row) {
    if (!row || typeof row !== 'object') return false;
    const r = /** @type {Record<string, any>} */ (row);
    if (r.role === 'tool') return true;
    if (typeof r.type === 'string' && /tool_message|tool_result|tool_response/i.test(r.type)) return true;
    if (Array.isArray(r.parts) && r.parts.some((/** @type {any} */ p) => p && (p.functionResponse || p.toolResult))) return true;
    // The Anthropic shape keeps the result inside a user row's content blocks.
    if (Array.isArray(r.content)
        && r.content.some((/** @type {any} */ p) => p && (p.type === 'tool_result' || p.toolResult))) return true;
    return false;
}

/**
 * A model-visible digest of one unit: its output when present, else the last
 * assistant text in its rows, else its data. Truncated like the DAG intake.
 * @param {{unit: TransferUnit, maxChars?: number}} arg0
 * @returns {string}
 */
function digestText({ unit, maxChars = LIMITS.max_intake_output_chars }) {
    if (unit?.output != null) return stringifyTemplateValue({ value: unit.output });
    const rows = Array.isArray(unit?.messages) ? unit.messages : [];
    for (let i = rows.length - 1; i >= 0; i--) {
        const m = /** @type {any} */ (rows[i]);
        if (m && (m.role === 'assistant' || m.type === 'assistant_message_text') && m.content) {
            return stringifyTemplateValue({ value: m.content });
        }
    }
    const text = stringifyTemplateValue({ value: unit?.data ?? '' });
    return truncateForPrompt({ text, maxChars });
}

/**
 * The framed text for one unit, shared by `stringify` mode and unit
 * degradation so the two never drift.
 * @param {{unit: TransferUnit, maxChars?: number}} arg0
 * @returns {string}
 */
function unitText({ unit, maxChars = LIMITS.max_intake_output_chars }) {
    return `[Output from Step "${unit?.id ?? '?'}"]: \n${digestText({ unit, maxChars })}`;
}

/**
 * Rows for one unit. Same-backend rows replay verbatim (roles, types and tool
 * pairing preserved — the `fork` contract); a foreign backend or a dangling
 * tool-result start degrades to a single user digest row.
 * @param {{unit: TransferUnit, target: string, maxChars?: number}} arg0
 * @returns {{rows: Array<Record<string, any>>, degraded: boolean}}
 */
function unitRows({ unit, target, maxChars }) {
    const msgs = Array.isArray(unit?.messages) ? unit.messages.filter(Boolean) : [];
    const sameBackend = !unit?.provider || unit.provider === target;
    const safeStart = msgs.length > 0 && !isToolResultRow(msgs[0]);
    if (sameBackend && safeStart) return { rows: msgs, degraded: false };
    return { rows: [createUserMessage({ provider: target, content: unitText({ unit, maxChars }) })], degraded: true };
}

/**
 * Renders the ordered upstream units into what the next step consumes.
 * @param {{units?: Array<TransferUnit>, transfer?: string|TransferOptions|null, targetProvider?: string|null, summarize?: ((rows: Array<import('./chat-session.mjs').ChatRow>) => Promise<string>|string)|null, maxChars?: number}} [arg0]
 * @returns {Promise<{policy: TransferPolicy, text: string, rows: Array<import('./chat-session.mjs').ChatRow>, dropped: number, summarized: boolean, degraded: number}>}
 */
export async function renderTransfer({ units = [], transfer = null, targetProvider = null, summarize = null, maxChars = LIMITS.max_intake_output_chars } = {}) {
    const policy = normalizeTransfer({ transfer });
    const list = (Array.isArray(units) ? units : []).filter((u) => u && typeof u === 'object');

    // D2: the window is a transfer-wide decision, not a ledger-mode one. It used to
    // sit below the mode branch, so `{mode:'stringify', select:'tail', tail:1}`
    // rendered everything and reported `dropped: 0`.
    let kept = list;
    /** @type {Array<TransferUnit>} */
    let dropped = [];
    if (policy.select === 'tail' && list.length > policy.tail) {
        dropped = list.slice(0, list.length - policy.tail);
        kept = list.slice(list.length - policy.tail);
    }

    // A summarizer is the caller's code: a throw degrades to the visible marker
    // rather than failing the transfer (the fold path follows the same rule).
    /** @param {Function} fn @returns {(rows: any[]) => Promise<string|null>} */
    const guarded = (fn) => async (rows) => {
        try {
            return (await fn(rows)) ?? null;
        } catch {
            return null;
        }
    };

    if (policy.mode === 'stringify') {
        /** @param {TransferUnit} unit */
        const textOf = (unit) => `\n${unitText({ unit, maxChars })}\n`;
        const rawSummarize = typeof policy.summarize === 'function'
            ? policy.summarize
            : (typeof summarize === 'function' ? summarize : null);
        const summarizeFn = rawSummarize ? guarded(rawSummarize) : null;
        let head = '';
        let summarized = false;
        if (dropped.length > 0) {
            const droppedText = dropped.map(textOf).join('');
            if (policy.compact && summarizeFn) {
                const summary = await summarizeFn([{ role: 'user', content: droppedText }]);
                if (summary) {
                    head = `\n[${policy.markerLabel}]\n${summary}\n`;
                    summarized = true;
                }
            }
            if (!summarized) {
                // Never drop silently: the same rule the ledger fold follows.
                const reason = policy.compact ? 'no summarizer configured' : 'not selected';
                head = `\n[${policy.markerLabel}]: ${dropped.length} earlier entries omitted (${reason}).\n`;
            }
        }
        return {
            policy,
            text: head + kept.map(textOf).join(''),
            rows: [],
            dropped: dropped.length,
            summarized,
            degraded: 0,
        };
    }

    if (!targetProvider) {
        throw new ConfigurationError({ message: 'renderTransfer: targetProvider is required for ledger transfer mode', options: { option: 'transfer' } });
    }
    const target = targetProvider;

    const rows = [];
    let degraded = 0;
    for (const unit of kept) {
        const r = unitRows({ unit, target, maxChars });
        if (r.degraded) degraded += 1;
        rows.push(...r.rows);
    }

    if (dropped.length === 0) {
        return { policy, text: '', rows, dropped: 0, summarized: false, degraded };
    }

    /** @type {Array<Record<string, any>>} */
    const droppedRows = [];
    for (const unit of dropped) {
        const r = unitRows({ unit, target, maxChars });
        if (r.degraded) degraded += 1;
        droppedRows.push(...r.rows);
    }

    // `foldContext` already degrades a throwing summarizer to its marker.
    const summarizeFn = typeof policy.summarize === 'function'
        ? policy.summarize
        : (typeof summarize === 'function' ? summarize : null);

    const fold = await foldContext({
        rows: [...droppedRows, ...rows],
        cut: droppedRows.length,
        summarize: policy.compact ? /** @type {((prefix: Array<import('./chat-session.mjs').ChatRow>) => string|Promise<string>)|null} */ (summarizeFn) : null,
        wrapSummary: (/** @type {(a: {summary: any}) => any} */ (({ summary }) => createUserMessage({ provider: target, content: `[${policy.markerLabel}]\n${summary}` }))),
        wrapMarker: (/** @type {(a: {n: number, reason: string}) => any} */ (({ n, reason }) => createUserMessage({ provider: target, content: `[${policy.markerLabel}]: ${n} earlier entries omitted (${reason}).` }))),
    });

    return { policy, text: '', rows: fold.rows, dropped: dropped.length, summarized: fold.summarized, degraded };
}
