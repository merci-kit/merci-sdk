// @ts-check
/**
 * @file context-fold — the single row-array folding primitive.
 * @version 0.12.0
 *
 * @description
 * ONE folding primitive for row arrays (conversations, ledgers). Splits at
 * `cut`, keeps the tail, and REPLACES the dropped prefix with either a
 * summarize() result or an explicit loss marker. Never silent: the SOTA
 * pattern (OpenAI nest_handoff_history, LangGraph summarization) compacts
 * summarizable runs but keeps every drop visible to the model.
 *
 * Consumers: DiscussionSession tail windows and future windowing;
 * compactHistory (agentic-core) implements the same contract as its reference.
 * The StateMachine's JSON context view is a different shape (object entries)
 * and carries its own inline marker.
 */




/**
 * What one fold returns: the kept tail, with the dropped prefix replaced by the
 * summary row (or an explicit loss marker), plus what happened.
 * @typedef {Object} FoldedContext
 * @property {Array<import('./chat-session.mjs').ChatRow>} rows
 * @property {boolean} folded
 * @property {boolean} summarized
 * @property {number} dropped
 * @property {string|null} summary
 */

/**
 * Folds a row array at `cut`: keeps the tail and replaces the prefix with a
 * summary row, or with an explicit loss marker when there is no usable summary.
 *   cut>=length is a no-op fold.
 *   May throw; an empty/failed result falls back to the loss marker.
 * @param {{rows: Array<import('./chat-session.mjs').ChatRow>, cut: number, summarize?: ((prefix: Array<import('./chat-session.mjs').ChatRow>) => Promise<string>|string)|null, markerLabel?: string, wrapSummary?: ((arg0: {summary: string}) => import('./chat-session.mjs').ChatRow)|null, wrapMarker?: ((arg0: {n: number, reason: string}) => import('./chat-session.mjs').ChatRow)|null}} arg0
 * @returns {Promise<FoldedContext>}
 */
export async function foldContext({ rows, cut, summarize = null, markerLabel = 'Earlier entries omitted', wrapSummary = null, wrapMarker = null }) {
    if (!Array.isArray(rows) || !Number.isInteger(cut) || cut <= 0 || cut >= rows.length) {
        return { rows, folded: false, summarized: false, dropped: 0, summary: null };
    }

    const prefix = rows.slice(0, cut);
    const tail = rows.slice(cut);

    let summary = null;
    
    /** @type {Error|null} */
        let summarizeError = null;
    if (typeof summarize === 'function') {
        try {
            summary = String(await summarize(prefix) ?? '').trim();
        } catch (err) {
            summarizeError = /** @type {Error | null} */ (err);
        }
        if (!summary) summarizeError ??= new Error('summarizer returned no content');
    }

    let replacement;
    if (summary) {
        replacement = wrapSummary
            ? wrapSummary({ summary })
            : { type: 'system_message', content: `${markerLabel}\n\n${summary}` };
    } else {
        const reason = summarizeError?.message ?? 'no summarizer configured';
        replacement = wrapMarker
            ? wrapMarker({ n: prefix.length, reason })
            : { type: 'system_message', content: `${markerLabel}\n\n${prefix.length} earlier entries were omitted (${reason}).` };
    }

    return {
        rows: [replacement, ...tail],
        folded: true,
        summarized: !!summary,
        dropped: prefix.length,
        summary,
    };
}
