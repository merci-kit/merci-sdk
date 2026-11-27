// @ts-check


/**
 * @file Shared agentic loop for all Merci SDK backends.
 * @version 0.12.0
 *
 * @description
 * Single source of truth for the "tool-use then synthesize" iteration policy.
 * Owns the iteration limit, the forceTextResponse on the last turn, the
 * consecutive-empty-response guard, and the FALLBACK_MESSAGE selection.
 *
 * Backends expose a single contract: step(messages, options) yields unified
 * events (text, quota, tool_request) and returns a final state with
 * { done, content, messages, thoughtSignature, ...backendExtras }.
 */
import { executeTools } from '../tools/tool-execution.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { createUserMessage, dedupeMessages } from '../messaging/messages.mjs';
import { noulQuestion } from '../messaging/decision.mjs';
import { isGenuineUserTurn, isInjection } from '../messaging/unified-message.mjs';
import { extractAndParseJson } from '../support/json.mjs';
import {
    FALLBACK_MESSAGE,
    INJECTION_META_KEY,
    SYNTHETIC_TURN_INJECTION,
    PENULTIMATE_ITERATION_REMINDER,
    ProviderType
} from '../core/constants/index.mjs';
import { CONVERSATION_SUMMARY_MARKER, getConversationSummarySchema, CONVERSATION_SUMMARY_PROMPT } from '../core/prompts.mjs';
import { AbortedError, BudgetExceededError, MaxTurnsExceededError, ConfigurationError, GuardrailViolationError, isAbortError } from '../core/errors.mjs';
import { NoRetryPolicy, runWithRetry, sleepAbortable } from '../support/retry-policy.mjs';
import { extractUserText, withToolGuardrails } from './guardrails.mjs';
import { ensureBudgetPool, absorbPoolUsage, getPoolParent, poolUsageSnapshot } from './budget-pool.mjs';
import { log, estimateMessageTokens, estimateTokens, sdkError, sdkWarn } from '../support/utils.mjs';
import { createStreamLogger } from '../support/event-logger.mjs';
import { EVENTS, RunContext, stampStreamEvent, runWithRunContext, emitEvent } from '../core/events.mjs';
import { enterPhase, PHASES } from '../core/lifecycle.mjs';
import { foldContext } from './context-fold.mjs';
import { interleavePendingRows, claimSteerRows, claimInboxTurn, restoreInboxRows } from './pending-inbox.mjs';
import { FailureClass, classifyFailure, failureEvidence, failureFingerprint } from './loops/policy.mjs';
import { ExecutionJournal } from './journal.mjs';
import { assertNotInFlight, assertVerifyVerdict, fallbackKind, streamErrorToRetryError } from './outcomes.mjs';

export {
    EMPTY_FALLBACK_CAUSE,
    SCHEMA_FALLBACK_CAUSE,
    assertNotInFlight,
    assertUsableOutput,
    assertVerifyVerdict,
    fallbackKind,
    isSdkFallbackOutput,
    isTransientFallbackKind,
    normalizeAgentOutput,
    resolveExhaustionOpts,
    schemaCorrection,
    streamErrorToRetryError
} from './outcomes.mjs';
/**
 * One unit of engine work: `{ key, run }` where `run` is a zero-arg async
 * function (the engine closes over its signal, session, and gate config)
 * resolving to the step result.
 * @typedef {Object} DueStep
 * @property {string} [key]
 * @property {() => Promise<unknown>} run
 */

/**
 * The DueStep plus its `Promise.allSettled` entry, in input order.
 * @typedef {Object} StepOutcome
 * @property {DueStep} step
 * @property {'fulfilled'|'rejected'} status
 * @property {unknown} [value]
 * @property {unknown} [reason]
 */

/**
 * One unified step event as the session's `step()` yields it.
 * @typedef {Object} StepStreamEvent
 * @property {string} [type]
 * @property {string} [content]
 * @property {string} [signature]
 * @property {string} [name]
 * @property {Object|null} [args]
 * @property {Object|null} [result]
 * @property {string} [error_type]
 * @property {string} [error_message]
 * @property {string} [error]
 * @property {number} [dropped]
 * @property {number} [summarized]
 * @property {Array<{id?: string, name?: string, function?: {name?: string}, args?: unknown, arguments?: unknown, input?: unknown}>} [calls]
 * @property {{prompt_tokens?: number, completion_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number, reasoning_tokens?: number, cost_usd?: number, updated?: Object, spent?: Object}} [data]
 */

/**
 * One acceptance/verification criterion.
 * @typedef {Object} Criterion
 * @property {string} name
 * @property {Function} check
 */


/**
 * A single conversation row. Arbitrary across backends — only the fields this
 * file reads are meaningful here, and the rest rides along untouched.
 * @typedef {Object} MessageRow
 * @property {string} [role]
 * @property {string} [type]
 * @property {string|Array<{type?: string, text?: string}>|null} [content]
 * @property {Array<Object>} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {Array<{type?: string, text?: string, functionCall?: Object, functionResponse?: Object, toolResult?: Object}>} [parts]
 * @property {string} [name]
 * @property {string} [id]
 * @property {string} [text]
 * @property {string} [toolName]
 * @property {Object} [arguments]
 * @property {Object} [functionResponse]
 * @property {string} [merciInjection]
 */

/**
 * The emitter a session reports to. A Session exposes a structural `{emit}` (a
 * test double or a host wrapper), while the event sinks want a real
 * EventEmitter; this is the single place the two are reconciled.
 * @param {{session?: Session|null}} arg0
 * @returns {import('node:events').EventEmitter|null}
 */
function sessionEmitter({ session }) {
    return /** @type {import('node:events').EventEmitter|null} */ (session?.eventEmitter ?? null);
}

/**
 * The backend ChatSession — duck-typed. Only the fields this file reads.
 * @typedef {Object} Session
 * @property {{emit: Function}|null} [eventEmitter]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string|null} [sessionId] - Stable conversation id (stamped on run events).
 * @property {Object|null|undefined} [client]
 * @property {{embed?: Function, provider?: string}|null} [_memoryClient]
 * @property {{ shouldSync: Function, distill: Function }|null} [_memoryManager]
 * @property {Object|null} [_outputSchema]
 * @property {Object|null} [_guardrails]
 * @property {Array<Object>} [_tools]
 * @property {Array<MessageRow>} [_lastStepMessages]
 * @property {string} [_lastRunText] - The last completed run's deliverable.
 * @property {Object|null} [_retryPolicy]
 * @property {{ maxTotalTokens?: number, maxBudgetUsd?: number }|null} [_budget]
 * @property {{callback: Function, timeoutMs?: number}|null} [_approvalPolicy]
 * @property {boolean} [_runInFlight] - Reentrancy guard for runAgenticLoop.
 * @property {import('./journal.mjs').ExecutionJournal|null} [_journal] - Session-level execution journal fallback.
 * @property {(options?: Record<string, unknown>) => Promise<unknown>} [_maybeObjectivePass]
 * @property {Function} [step]
 */

/**
 * Usage accumulator (per-step, per-attempt and run-level all share this shape).
 * @typedef {Object} UsageState
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} cacheCreationTokens
 * @property {number} cacheReadTokens
 * @property {number} reasoningTokens
 * @property {Record<string, unknown>|null} credits
 * @property {number} [estTokens] - Tokens estimated for steps that reported none.
 * @property {number|null} costUsd - The cost **the backend reported** (USD); `null` when it reported none.
 * @property {number} [costUnreportedCalls] - Calls that reported tokens but no cost (B-9): the USD sum is a lower bound while this is > 0.
 * @property {boolean} [budgetNoticeEmitted] - Whether the "no cost reported" notice already fired in this run.
 */

/**
 * Loop option bag for runAgenticLoop / runAgenticLoopInner.
 * @typedef {Object} LoopOptions
 * @property {import('../support/retry-policy.mjs').RetryPolicy} [retryPolicy]
 * @property {AbortSignal} [signal]
 * @property {{maxTotalTokens?: number, maxBudgetUsd?: number}} [budget] - A cap for
 * THIS run and this session only. It does not create or move the tree's pool (D12):
 * use `withBudget` for a cap that bounds children.
 * @property {Function} [followUp]
 * @property {number} [maxFollowUps]
 * @property {boolean|{maxExtensions?: number, minNovelToolCalls?: number, isProgressing?: Function}} [autoExtend]
 * @property {import('./decision-gate.mjs').DecisionGate|null} [decisionGate] - Opt-in: one bounded extension when the gate is certain one more round finishes.
 * @property {{max_turns?: Function}} [errorHandlers]
 * @property {Function|null} [onEvent]
 * @property {Function} [onIterationStart]
 * @property {Function} [onLimitReached]
 * @property {string} [thoughtSignature]
 * @property {{callback: Function, timeoutMs?: number}|null} [approval]
 * @property {{thresholdTokens?: number, keepRecent?: number, summarize?: Function}|null} [compaction]
 * @property {number} [maxIterations]
 * @property {number} [maxConsecutiveEmpty]
 * @property {number} [maxInboxTurns] - Cap on inbox-driven continuation turns in THIS run (default MERCI_LIMIT_MAX_INBOX_TURNS): how many times a `steer`/`queue` message may add a turn before it waits for the next run.
 * @property {boolean} [waitForBackground] - `drainInbox()` only: wait for live background subagents before taking a turn (default true).
 * @property {number} [backgroundTimeoutMs] - `drainInbox()` only: how long that wait may last before the queue is left for the next call (default MERCI_LIMIT_INBOX_BACKGROUND_WAIT_MS).
 * @property {{left: number, exhausted?: boolean}} [__inboxBudget] - Internal: the run's shared inbox-turn budget, so the outer run and the turns inside it spend one cap instead of one cap each.
 * @property {'run'|'caller'} [__inboxTurns] - Internal: who drives the next inbox turn. `drainInbox()` sets `caller`, so one call answers exactly one queued message.
 * @property {number} [maxSchemaRetries] - Bounded corrective retries for a schema-invalid structured deliverable (default MERCI_LIMIT_MAX_SCHEMA_RETRIES; 0 disables).
 * @property {RunContext} [runContext] - The caller's context. A nested loop started from a tool must pass it: budget admission uses the run-id ancestry to tell an ancestor's in-flight reservation (which it must never wait on) from a concurrent sibling's.
 * @property {import('./journal.mjs').ExecutionJournal} [journal] - Orchestrator-shared execution journal (overrides the session's).
 * @property {string} [boundaryPrefix] - Scope prefix for this run's journal tool keys (DAG step / SM node), so sibling steps cannot replay each other.
 * @property {import('./journal.mjs').ExecutionJournal} [__journal] - Internal: resolved journal passed to the inner loop.
 * @property {{lastCommitted: Array<MessageRow>|null}} [__boundary] - Internal: run-scoped retry boundary holder.
 */


const SYNTHESIS_NUDGE = 'The tool results are in. Provide your final answer now, synthesizing what you learned.';

const SCHEMA_CORRECTION_PREFIX = 'Your previous response did not contain valid JSON for the requested schema';







/**
 * @returns {MessageRow}
  * @param {{provider?: *, content: *}} arg0
 */
function createSyntheticUserMessage({ provider, content }) {
    
    /** @type {MessageRow} */
        const msg = createUserMessage({ provider, content });
    msg[INJECTION_META_KEY] = SYNTHETIC_TURN_INJECTION;
    return msg;
}


/**
 * OR an SDK-synthetic one (marked nudges/follow-ups carry real continuation
 * intent). The single predicate for the cut and the post-fold growth check.
 * @param {{m: MessageRow}} arg0 -
 * @returns {boolean}
 */
function _isCompactionBoundary({ m }) {
    return isGenuineUserTurn({ m })
        || (isInjection({ m }) && (m.type === 'user_message' || m.role === 'user'));
}


/**
 * before it is summarized; the turn and what follows stay — so a tool round
 * (tool_calls + results) is never split across the cut.
 * @param {{messages: Array<MessageRow>}} arg0 -
 * @returns {number} cut index, or -1 when no user turn exists.
 */
function findCompactionCut({ messages }) {
    let last = -1;
    for (let i = 0; i < messages.length; i++) {
        if (_isCompactionBoundary({ m: messages[i] })) last = i;
    }
    return last;
}


/**
 * `structuredLlmCall` helper the planner uses. maxAttempts 1 — compaction is
 * best-effort; a failed summary degrades to drop-oldest, not to a hang.
 * @param {{prefix: Array<MessageRow>, session: Session, signal?: AbortSignal|null, onUsage?: ((usage: Record<string, unknown>) => void)|null}} arg0 -
 */
async function defaultSummarizer({ prefix, session, signal = null, onUsage = null }) {
    const client = session._memoryClient || session.client || session;
    const transcript = prefix
        .map(m => `${m.role || m.type}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`)
        .join('\n');
    
    const { structuredLlmCall } = await import('./planning/planner-utils.mjs');
    /** @type {any} */
        const data = await structuredLlmCall({
        client,
        model: session.model,
        systemMessage: CONVERSATION_SUMMARY_PROMPT,
        schema: getConversationSummarySchema(),
        prompt: transcript,
        label: 'CONVERSATION-SUMMARY',
        schemaName: 'summary',
        signal,
        maxAttempts: LIMITS.compaction_summarizer_attempts,
        onUsage,
    });
    return data?.summary ?? '';
}


/** Placeholder a cleared tool result carries; a marker the model can read. */
const CLEARED_TOOL_RESULT_PLACEHOLDER = '[tool output cleared to save context]';

/**
 * Replaces the content of every tool-result row except the last `keepRecent`
 * with a placeholder, keeping the row (role, id, name) so the call/result pair
 * stays valid. This is the cheap edit before an LLM fold: the model keeps the
 * shape of what happened and loses the payloads it no longer needs.
 * @param {{messages: Array<MessageRow>, keepRecent: number, placeholder: string}} arg0
 * @returns {{messages: Array<MessageRow>, cleared: number}}
 */
function clearOldToolResults({ messages, keepRecent, placeholder }) {
    /** @type {number[]} */
    const results = [];
    messages.forEach((m, i) => { if (_isToolResultMessage({ m })) results.push(i); });
    const drop = new Set(results.slice(0, Math.max(0, results.length - keepRecent)));
    if (drop.size === 0) return { messages, cleared: 0 };
    const textBlock = [{ type: 'text', text: placeholder }];
    const cleared = messages.map((m, i) => {
        if (!drop.has(i)) return m;
        if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) {
            return { ...m, content: m.content.map((b) => (b && b.type === 'tool_result' ? { ...b, content: textBlock } : b)) };
        }
        if (Array.isArray(m.parts) && m.parts.some((p) => p && p.toolResult)) {
            return { ...m, parts: m.parts.map((p) => (p && p.toolResult ? { ...p, toolResult: { ...p.toolResult, response: { content: placeholder } } } : p)) };
        }
        if (m.functionResponse) {
            return { ...m, content: placeholder, functionResponse: { ...m.functionResponse, response: { content: placeholder } } };
        }
        return { ...m, content: placeholder };
    });
    return { messages: cleared, cleared: drop.size };
}


/**
 * @param {{m: MessageRow}} arg0
 * @returns {boolean}
 */
function _isToolResultMessage({ m }) {
    if (!m || typeof m !== 'object') return false;
    if (m.role === 'tool' || m.type === 'tool_message' || m.type === 'tool_result_message') return true;
    if (m.role === 'user') {
        if (m.functionResponse) return true;
        if (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) return true;
        if (Array.isArray(m.parts) && m.parts.some(p => p && (p.functionResponse || p.toolResult))) return true;
    }
    return false;
}


/**
 * Adjusts a candidate cut index so a tool-call message is never separated from
 * its tool-result row(s).
 * @param {{messages: Array<MessageRow>, cut: number, minCut?: number}} arg0
 * @returns {number}
 */
export function adjustCutForToolPairs({ messages, cut, minCut = 1 }) {
    let idx = Math.min(Math.max(cut, minCut), messages.length);
    while (idx > minCut && _isToolResultMessage({ m: messages[idx] })) {
        idx--;
    }
    if (idx > minCut && _isToolCallMessage({ m: messages[idx - 1] }) && _isToolResultMessage({ m: messages[idx] })) {
        idx--;
    }
    while (idx < messages.length && _isToolResultMessage({ m: messages[idx] })) {
        idx++;
    }
    return idx;
}


/**
 * a history that already starts with the summary marker is never re-summarized.
 * Falls back to drop-oldest when the summarizer fails.
 * @param {{messages: Array<MessageRow>, compaction: Object|null|undefined, session: Session, signal: AbortSignal|null|undefined, onEvent: ((event: Record<string, unknown>) => void)|null|undefined, promptTokens?: number|null, onUsage?: ((usage: Record<string, unknown>) => void)|null}} arg0 -
 *   `promptTokens` is the prompt size the backend reported for the last step
 *   (cache tokens included); it triggers compaction more accurately than a row
 *   estimate, which cannot see schemas or the system prompt. `onUsage` charges
 *   the summarizer's own call to the caller's budget.
 * @returns {Promise<Array<MessageRow>>}
 */
export async function compactHistory({ messages, compaction, session, signal, onEvent, promptTokens = null, onUsage = null }) {
    if (!compaction || typeof compaction !== 'object') return messages;
    const opts = /** @type {{thresholdTokens?: number, keepRecent?: number, summarize?: Function, clearToolResults?: {keepRecent?: number, placeholder?: string}}} */ (compaction);
    const threshold = opts.thresholdTokens ?? LIMITS.compaction_threshold_tokens;
    // The cheap pass first: clearing old tool payloads may bring the history
    // under the threshold without an LLM call at all. After the edit the row
    // estimate is the only fresh measure, so the reported size no longer applies.
    let effectivePromptTokens = promptTokens;
    let clearedCount = 0;
    if (opts.clearToolResults && typeof opts.clearToolResults === 'object') {
        const keep = Number.isInteger(opts.clearToolResults.keepRecent) && /** @type {number} */ (opts.clearToolResults.keepRecent) >= 0
            ? /** @type {number} */ (opts.clearToolResults.keepRecent)
            : LIMITS.compaction_clear_tool_keep_recent;
        const placeholder = typeof opts.clearToolResults.placeholder === 'string' && opts.clearToolResults.placeholder.length > 0
            ? opts.clearToolResults.placeholder
            : CLEARED_TOOL_RESULT_PLACEHOLDER;
        const cleared = clearOldToolResults({ messages, keepRecent: keep, placeholder });
        if (cleared.cleared > 0) {
            messages = cleared.messages;
            clearedCount = cleared.cleared;
            effectivePromptTokens = null;
        }
    }
    const used = typeof effectivePromptTokens === 'number' && Number.isFinite(effectivePromptTokens) && effectivePromptTokens > 0
        ? effectivePromptTokens
        : estimateMessageTokens({ messages });
    if (used <= threshold) return messages;
    const keepRecent = Number.isInteger(opts.keepRecent) && /** @type {number} */ (opts.keepRecent) >= 1
        ? /** @type {number} */ (opts.keepRecent)
        : LIMITS.compaction_keep_recent;
    const hasSummaryMarker = messages[0]?.role === 'system' && String(messages[0].content || '').includes(CONVERSATION_SUMMARY_MARKER);
    if (hasSummaryMarker) {
        let boundaries = 0;
        for (const m of messages) if (_isCompactionBoundary({ m })) boundaries++;
        if (boundaries <= 1 && messages.length <= keepRecent + 2) return messages;
    }
    let cut = findCompactionCut({ messages });
    /** @type {Array<MessageRow>|null} */
    let preserved = null;
    let foldInput = messages;
    if (cut <= 1) {
        if (messages.length <= keepRecent + 2) return messages;
        const userIdx = cut >= 0 ? cut : (hasSummaryMarker ? 1 : 0);
        const midStart = userIdx + 1;
        const tailCut = adjustCutForToolPairs({
            messages,
            cut: messages.length - keepRecent,
            minCut: midStart + 1,
        });
        if (tailCut <= midStart || tailCut >= messages.length) return messages;
        preserved = hasSummaryMarker ? [messages[userIdx]] : messages.slice(0, userIdx + 1);
        foldInput = [
            ...(hasSummaryMarker && userIdx > 0 ? [messages[0]] : []),
            ...messages.slice(midStart),
        ];
        cut = (hasSummaryMarker && userIdx > 0 ? 1 : 0) + (tailCut - midStart);
    }

    throwIfAborted({ signal, message: 'Compaction aborted.' });
    const summarize = typeof opts.summarize === 'function'
        ? opts.summarize
        :  (/** @type {(...args: any[]) => any} */ ((p) => defaultSummarizer({ prefix: p, session, signal: signal ?? null, onUsage })));
    /** @param {{summary: *}} arg0 */
    /** @param {{summary: *}} arg0 */
    const fold = await foldContext({ rows: foldInput, cut, summarize: /** @type {((prefix: Array<import('./chat-session.mjs').ChatRow>) => string|Promise<string>)} */ (summarize), wrapSummary:  (/** @type {(...args: any[]) => any} */ (({ summary }) => ({ role: 'system', content: `${CONVERSATION_SUMMARY_MARKER}\n\n${String(summary ?? '')}` }))), wrapMarker:  (/** @type {(...args: any[]) => any} */ (({ n, reason }) => ({
            role: 'system',
            content: `${CONVERSATION_SUMMARY_MARKER}\n\nEarlier conversation was dropped because summarization failed (${reason}). Continue from the remaining conversation.`,
        }))) });
    if (!fold.folded) return messages;
    throwIfAborted({ signal, message: 'Compaction aborted.' });
    if (onEvent) onEvent({ type: EVENTS.STEP.COMPACTION, dropped: fold.dropped, summarized: fold.summarized, ...(clearedCount ? { cleared: clearedCount } : {}) });
    // Emitter twin: session-level subscribers see compaction without tapping the onEvent stream.
    emitEvent({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.SESSION_HISTORY_COMPACTED, payload: {
        dropped: fold.dropped, summarized: fold.summarized, ...(clearedCount ? { cleared: clearedCount } : {})
    } });
    return preserved ? [fold.rows[0], ...preserved, ...fold.rows.slice(1)] : fold.rows;
}

/**
 * The text an appended assistant row carries, or '' for any other row (a tool
 * call, a tool result, a user turn). Used by B-6's per-row output guardrail.
 * @param {{m: MessageRow}} arg0 -
 * @returns {string}
 */
function _assistantText({ m }) {
    if (!m || typeof m !== 'object') return '';
    if (m.role !== 'assistant' && m.role !== 'model' && m.type !== 'assistant_message_text') return '';
    const content = m.content ?? m.parts ?? null;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            const block = /** @type {Record<string, any>|null|undefined} */ (part);
            return block && block.type === 'text' && typeof block.text === 'string' ? block.text : '';
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * @param {{m: MessageRow}} arg0 -
 * @returns {boolean}
 */
function _isToolCallMessage({ m }) {
    if (!m) return false;
    if (m.type === 'assistant_message_tool' || m.type === 'assistant_tool_call') return true;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) return true;
    if (m.role === 'model' && Array.isArray(m.parts)
        && m.parts.some(/** @type {(...args: any[]) => any} */ (p => p && p.functionCall))) return true;
    if (m.role === 'assistant' && Array.isArray(m.content)
        && m.content.some(/** @type {(...args: any[]) => any} */ (b => b && b.type === 'tool_use'))) return true;
    return false;
}


/**
 * in a message row, across all four backend shapes. Used by the autoExtend
 * progress signal: an unseen fingerprint means the model learned something new.
 * @param {{m: MessageRow}} arg0 -
 * @returns {string[]} 12-char hex fingerprints (possibly empty).
 */
function _toolCallFingerprints({ m }) {
    if (!m) return [];
    
    /** @type {(name: any, args: any) => string} */
        /** @param {{name: *, args: *}} arg0 */
        /** @param {{name: *, args: *}} arg0 */
        const fp = ({ name, args }) => failureFingerprint({
        action: 'tool',
        input: name ?? '',
        signature: typeof args === 'string' ? args : JSON.stringify(args ?? '')
    });
    if (m.type === 'assistant_message_tool' || m.type === 'assistant_tool_call') {
        return [fp({ name: m.toolName ?? m.name, args: m.content ?? m.arguments })];
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        return m.tool_calls.map(/** @type {(...args: any[]) => any} */ (tc => fp({ name: tc?.function?.name ?? tc?.name, args: tc?.function?.arguments ?? tc?.arguments ?? tc?.input })));
    }
    if (m.role === 'model' && Array.isArray(m.parts)) {
        return m.parts.filter(/** @type {(...args: any[]) => any} */ (p => p?.functionCall)).map(/** @type {(...args: any[]) => any} */ (p => fp({ name: p.functionCall.name, args: p.functionCall.args })));
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
        return m.content.filter(/** @type {(...args: any[]) => any} */ (b => b?.type === 'tool_use')).map(/** @type {(...args: any[]) => any} */ (b => fp({ name: b.name, args: b.input })));
    }
    return [];
}


/**
 * parity): a user handler may return a controlled output string; a usable
 * partial answer is returned as-is; otherwise the run throws
 * `MaxTurnsExceededError` (whose message IS the MAX_ITERATIONS sentinel so the
 * downstream string-prefix guards keep recognising an exhausted run).
 * @param {{session: Session, errorHandlers?: *, info: *, runCtx: RunContext}} arg0 -
 * @returns {Promise<string>} controlled or partial output
 */
async function _finishExhausted({ session, errorHandlers, info, runCtx }) {
    
    /** @type {(handled: boolean) => void} */
        const emit = (handled) => runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.MAX_TURNS_EXCEEDED, payload: {
        handled,
        maxTurns: info.maxTurns,
        iterationsUsed: info.iterationsUsed
    } });
    const handler = errorHandlers && typeof errorHandlers.max_turns === 'function' ? errorHandlers.max_turns : null;
    if (handler) {
        const out = await handler(info);
        if (typeof out === 'string' && out.length > 0) {
            emit(true);
            return out;
        }
    }
    if (info.partialOutput) {
        emit(true);
        return info.partialOutput;
    }
    emit(false);
    throw new MaxTurnsExceededError({ message: FALLBACK_MESSAGE.MAX_ITERATIONS, options: {
        maxTurns: info.maxTurns,
        iterationsUsed: info.iterationsUsed,
        partialOutput: info.partialOutput
    } });
}


/**
 * @param {{session: Session}} arg0 -
 * @returns {Array<*>|null}
 */
function _getBackendTools({ session }) {
    return Array.isArray(session?._tools) ? session._tools : null;
}


/**
 * session. The session's own withApproval() wins; a session without one gets
 * the engine's policy so gated tools work inside DAG/SM/MAA steps too.
 * @template {Session} T
 * @param {{session: T, policy: {callback: Function, timeoutMs?: number}|null|undefined}} arg0 -
 * @returns {T}
 */
export function applyApprovalPolicy({ session, policy }) {
    const target = /** @type {Session} */ (session);
    if (policy && target && !target._approvalPolicy) target._approvalPolicy = policy;
    return session;
}


/**
 * silently otherwise. Centralized so the loop and every agentic consumer
 * (executor, state machine, discussion) agree.
 * @param {{signal: AbortSignal|null|undefined, message?: string}} arg0 -
 */
export function throwIfAborted({ signal, message = 'Agentic loop aborted.' }) {
    if (signal && signal.aborted) {
        throw new AbortedError({ message, options: { cause: signal.reason } });
    }
}


/**
 * deltas onto an orchestrator's own event names.
 * @param {{emit: Function, textEvent: string, thoughtEvent: string, makePayload: (arg0: { content: string }) => Record<string, unknown>, thoughtSignatureEvent?: string, streamEndEvent?: string}} arg0 - (eventName, payload) => void.
 * @returns {(e: StepStreamEvent) => void} the onEvent handler.
 */
export function forwardStreamEvents({ emit, textEvent, thoughtEvent, makePayload, thoughtSignatureEvent, streamEndEvent }) {
    return (e) => {
        if (e?.type === 'text' && e.content) emit({ name: textEvent, payload: makePayload({ content: e.content }) });
        if (e?.type === 'thought' && e.content) emit({ name: thoughtEvent, payload: makePayload({ content: e.content }) });
        if (e?.type === 'thought_signature' && thoughtSignatureEvent) {
            const base = makePayload({ content: '' });
            emit({ name: thoughtSignatureEvent, payload: { ...base, signature: e.signature } });
        }
        if (e?.type === 'stream_end' && streamEndEvent) {
            emit({ name: streamEndEvent, payload: makePayload({ content: '' }) });
        }
    };
}


/**
 * events (tool_call_start/tool_call_end) the agentic loop emits around
 * executeTools — the AutoGen ToolCallRequestEvent/ExecutionEvent analogue.
 * @param {{emit: Function, textEvent: string, thoughtEvent: string, toolStartEvent?: string, toolEndEvent?: string, thoughtSignatureEvent?: string, makePayload: (arg0: { content: string }) => Record<string, unknown>}} arg0 - (eventName, payload) => void.
 * @returns {(e: StepStreamEvent) => void} the onEvent handler.
 */
export function forwardToolEvents({ emit, textEvent, thoughtEvent, toolStartEvent, toolEndEvent, thoughtSignatureEvent, makePayload }) {
    const forwardStream = forwardStreamEvents({ emit, textEvent, thoughtEvent, makePayload, thoughtSignatureEvent });
    /** @param {Record<string, unknown>} base */
    const correlation = (base) => {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const k of ['agent', 'type', 'stepId', 'nodeId', 'turn', 'subagent']) {
            if (base && base[k] !== undefined) out[k] = base[k];
        }
        return out;
    };
    return (e) => {
        if (!e) return;
        if (e.type === 'tool_call_start' && toolStartEvent) {
            const base = makePayload({ content: '' });
            emit({ name: toolStartEvent, payload: { ...correlation(base), name: e.name, args: e.args } });
        } else if (e.type === 'tool_call_end' && toolEndEvent) {
            const base = makePayload({ content: '' });
            emit({ name: toolEndEvent, payload: { ...correlation(base), name: e.name, result: e.result } });
        } else {
            forwardStream(e);
        }
    };
}


/**
 * Used by the executor's per-node verify and the StateMachine's completion gate.
 * Both a criterion and the judge must return a verdict with a boolean
 * `passed`; anything else is a `ConfigurationError` (fail closed, D-2).
 * @param {{ctx: Object, criteria?: Array<Criterion>, judge?: Function|null, judgeOnPass?: boolean, signal?: AbortSignal|null}} arg0 - The context the checks run against.
 * @returns {Promise<Array<{name: string, passed: boolean, evidence: string}>>}
 */
export async function runCriteriaChecks({ ctx, criteria = [], judge = null, judgeOnPass = false, signal = null }) {
    const checks = [];
    for (const crit of criteria) {
        const r = await crit.check(ctx);
        assertVerifyVerdict({ verdict: r, label: `Criterion "${crit.name}"` });
        checks.push({ name: crit.name, passed: r.passed, evidence: r.evidence ?? '' });
    }
    if (judge && (!judgeOnPass || checks.every(x => x.passed))) {
        const j = await judge({ ctx, signal });
        assertVerifyVerdict({ verdict: j, label: 'Judge' });
        checks.push({ name: 'judge', passed: j.passed, evidence: j.evidence ?? '' });
    }
    return checks;
}



/**
 * Runs the steps that are due and returns one settled result per step, in
 * input order.
 * @param {{steps: Array<DueStep>}} arg0 - the steps due this round.
 * @returns {Promise<Array<StepOutcome>>} one settled result per step, in input order.
 */
export async function runDueSteps({ steps }) {
    const settled = await Promise.allSettled(steps.map(/** @type {(...args: any[]) => any} */ ((s) => s.run())));
    return steps.map(/** @type {(...args: any[]) => any} */ ((step, i) => ({ step, ...settled[i] })));
}


/**
 * handling: errors are logged via the SDK logger, a
 * `memory:distill:error` event is emitted on the session's emitter, and
 * the error is stored on `MemoryManager.lastDistillError`. The caller
 * never sees a thrown error from this path.
 * @param {{session: Session, messages: Array<MessageRow>, distillOptions: Record<string, any>}} arg0 -
 */
function _fireAndForgetDistill({ session, messages, distillOptions }) {
    const mm = session._memoryManager;
    if (!mm) return;
    const client = session._memoryClient || session.client || session;
    const emitter = session.eventEmitter ?? null;
    Promise.resolve(mm.distill({ messages, client, modelToUse: session.model, options: { ...distillOptions, emitter } })).catch((error) => {
        sdkError({ prefix: 'MEMORY', args: [`Unexpected distill rejection: ${error?.message ?? error}`] });
    });
}


/**
 * Fires the memory sync exactly when the manager says these messages should be
 * distilled. The caller owns the "this result was delivered" condition; this
 * helper owns the shared `shouldSync` gate and the distill options shape.
 * @param {{session: Session, messages: Array<MessageRow>, signal?: AbortSignal, runContext?: RunContext}} arg0
 * @returns {void}
 */
function maybeDistill({ session, messages, signal, runContext }) {
    if (session._memoryManager && session._memoryManager.shouldSync({ messages })) {
        _fireAndForgetDistill({ session, messages, distillOptions: { signal, runContext } });
    }
}


/**
 * cannot drift. `total_tokens` is derived (prompt + completion), matching the
 * vendor convention; cache/reasoning are reported for diagnostics only.
 *
 * `cost_usd` is the cost **the backend reported** for the run (USD). The SDK
 * never estimates a price: an unknown cost is `null` — unknown, never zero.
 * @param {{runState: UsageState}} arg0 -
 * @returns {Record<string, any>}
 */
function usageSnapshot({ runState }) {
    return {
        prompt_tokens: runState.promptTokens,
        completion_tokens: runState.completionTokens,
        total_tokens: runState.promptTokens + runState.completionTokens,
        cache_creation_input_tokens: runState.cacheCreationTokens,
        cache_read_input_tokens: runState.cacheReadTokens,
        reasoning_tokens: runState.reasoningTokens,
        cost_usd: runState.costUsd ?? null,
        cost_unreported_calls: runState.costUnreportedCalls ?? 0,
        ...(runState.credits ? { credits: runState.credits } : {})
    };
}


/**
 * snapshot and for the run-level budget total (which spans retries).
 * @param {{acc: UsageState, usage?: Record<string, any>, estimated?: number}} arg0 -
 *   `estimated` is the tokens charged for the same call when the backend
 *   reported none; the unreported-cost count is the same rule the pool uses.
 * @returns {void}
 */
function addUsage({ acc, usage, estimated = 0 }) {
    if (!usage) return;
    acc.promptTokens += usage.prompt_tokens ?? 0;
    acc.completionTokens += usage.completion_tokens ?? 0;
    acc.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    acc.reasoningTokens += usage.reasoning_tokens ?? 0;
    if (usage.credits) acc.credits = usage.credits;
    // The cost the BACKEND reported (USD). The SDK never computes one.
    if (typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd)) {
        acc.costUsd = (acc.costUsd ?? 0) + usage.cost_usd;
    } else if ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) + estimated > 0) {
        // B-9: the same rule `absorbPoolUsage` charges with — a call that spent
        // tokens (reported or estimated) and reported no price is counted, not
        // read as free. W2-8: the estimate must be passed in, or a silent run
        // counts at the pool and reads 0 at the run.
        acc.costUnreportedCalls = (acc.costUnreportedCalls ?? 0) + 1;
    }
}


/**
 * Adds one citation or source to the run's provenance, deduped by uri/url and
 * title, in first-seen order.
 * @param {{runState: any, list: 'citations'|'sources', item: any}} arg0
 * @returns {void}
 */
function addProvenance({ runState, list, item }) {
    if (!item || !runState) return;
    const key = `${String(item.uri ?? item.url ?? '')}|${String(item.title ?? '')}`;
    if (runState._provenanceKeys.has(key)) return;
    runState._provenanceKeys.add(key);
    runState[list].push(item);
}

/**
 * The usage snapshot for the run-level budget total (which spans retries).
 * @param {{runUsage: UsageState}} arg0
 */
function budgetUsage({ runUsage }) {
    const estimated = runUsage.estTokens ?? 0;
    if (runUsage.promptTokens + runUsage.completionTokens > 0) {
        const snapshot = usageSnapshot({ runState: runUsage });
        if (estimated <= 0) return snapshot;
        return {
            ...snapshot,
            total_tokens: snapshot.total_tokens + estimated,
            estimated_tokens: estimated,
        };
    }
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: estimated,
        cost_usd: runUsage.costUsd ?? null,
        cost_unreported_calls: runUsage.costUnreportedCalls ?? 0,
        estimated: true,
    };
}


/**
 * The usage a PRE-CALL refusal reports. The projection is what decided it, so
 * that is the number, with the spend beside it — reporting spend alone read as
 * "901 > 1500", which is not the comparison that fired (W2-5). Once the spend
 * alone reached the cap the projection adds nothing and the spend is reported.
 * @param {{runUsage: UsageState, projected: number, maxTotalTokens: number}} arg0
 * @returns {Record<string, any>}
 */
function projectedBudgetUsage({ runUsage, projected, maxTotalTokens }) {
    const usage = budgetUsage({ runUsage });
    const spent = Number(usage.total_tokens ?? 0);
    if (spent >= maxTotalTokens) return usage;
    return { ...usage, total_tokens: projected, projected_tokens: projected, spent_tokens: spent };
}


/**
 * re-entry): emits `run:budget_exceeded` then throws BudgetExceededError.
 * @param {{runCtx: RunContext, session: any, maxTotalTokens: number, usage: Record<string, any>}} arg0 -
 * @returns {never}
 */
function failBudget({ runCtx, session, maxTotalTokens, usage }) {
    runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxTotalTokens } });
    const projected = typeof usage.projected_tokens === 'number';
    const message = `Token budget exceeded: ${usage.total_tokens} > ${maxTotalTokens}${projected ? ` (projected; spent ${usage.spent_tokens})` : ''}.`;
    throw new BudgetExceededError({ message, options: { maxTotalTokens, usage } });
}


/**
 * The admission timeout of a shared pool (B-3): a waiting turn whose would-be
 * share never reached the minimum is refused before its call starts, instead
 * of running a starved one. `failBudget`'s event and typed error, with the
 * three numbers the decision used.
 * @param {{runCtx: RunContext, session: any, max: number, remaining: number, min: number, usage: Record<string, any>}} arg0 -
 * @returns {never}
 */
function failAdmission({ runCtx, session, max, remaining, min, usage }) {
    runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxTotalTokens: max, remainingTokens: remaining, minOutputTokens: min } });
    throw new BudgetExceededError({
        message: `Token budget exceeded: the shared ${max}-token pool has ${remaining} output tokens left, below the ${min}-token minimum.`,
        options: { maxTotalTokens: max, usage },
    });
}


/**
 * The USD counterpart of `failBudget`: the same event, the same typed error,
 * the money in the payload.
 * @param {{runCtx: RunContext, session: any, maxBudgetUsd: number, costUsd: number, usage: Record<string, any>}} arg0 -
 * @returns {never}
 */
function failBudgetUsd({ runCtx, session, maxBudgetUsd, costUsd, usage }) {
    runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxBudgetUsd, costUsd } });
    throw new BudgetExceededError({ message: `USD budget exceeded: $${costUsd.toFixed(6)} > $${maxBudgetUsd}.`, options: { maxBudgetUsd, costUsd, usage } });
}


/**
 * Drops the trailing rows a blocked output phase refused, keeping the run's
 * tool rows. Restoring the whole pre-run snapshot would erase tool calls whose
 * side effects already happened, so a resumed session would no longer match
 * the journal.
 * @param {{session: any, before: Array<MessageRow>|undefined}} arg0
 * @returns {void}
 */
function dropBlockedOutput({ session, before }) {
    const rows = Array.isArray(session._lastStepMessages) ? session._lastStepMessages : null;
    if (!rows) {
        session._lastStepMessages = before;
        return;
    }
    let keep = rows.length;
    while (keep > 0 && !_isToolCallMessage({ m: rows[keep - 1] }) && !_isToolResultMessage({ m: rows[keep - 1] })) keep -= 1;
    session._lastStepMessages = keep === 0 ? before : rows.slice(0, keep);
}


/**
 * Tool rounds run until the model answers with text. `opts.followUp` then turns that
 * single answer into a staged loop: it is called with the answer, and any string it
 * returns is appended as the NEXT USER TURN, giving the model a fresh iteration budget
 * to review, verify and follow up. Return null/undefined to stop. Capped by
 * `opts.maxFollowUps`. This is the whole "keeps working instead of answering once"
 * behaviour — every caller of `session.run` (DAG steps, MAA agents, SM nodes) gets it.
 * @param {{session: Session, messages: Array<MessageRow>, opts?: LoopOptions}} arg0 - The backend ChatSession.
 * @returns {Promise<string>}
 */
export async function runAgenticLoop({ session, messages, opts = {} }) {
    assertNotInFlight({ flag: session._runInFlight, label: 'This session already has a run in flight; concurrent runs on one session are not supported.' });
    session._runInFlight = true;
    try {
        const guardrails = session._guardrails ?? null;
        if (guardrails) {
            await applyGuardrail({ guardrails, session, phase: 'input', text: extractUserText({ messages }) });
        }
        const before = session._lastStepMessages;
        try {
            const { deliverable, runCtx, runState } = await runAgenticLoopUnlocked({ session, messages, opts });
            const deliverableText = typeof deliverable === 'string' ? deliverable : String(deliverable ?? '');
            // The per-row check already judged the assistant row this answer came
            // from; judging it again doubled the trip events and the check cost.
            // A sentinel the loop assembled itself is not that row, so it is judged.
            const judgedRow = [...(runState?.judgedOutputRows ?? [])].some((row) => _assistantText({ m: row }) === deliverableText);
            if (guardrails && !judgedRow) {
                await applyGuardrail({ guardrails, session, phase: 'output', text: deliverableText });
            }
            // B-6: only after the output guardrail passed. Distilling inside the
            // loop handed the blocked answer to long-term memory before it was judged.
            // W2B-10: an empty or sentinel deliverable is not an answer, so there
            // is nothing worth remembering (and nothing to distil a cost for).
            if (deliverableText.trim() && fallbackKind({ text: deliverableText }) === null) {
                maybeDistill({ session, messages: session._lastStepMessages ?? messages, signal: opts.signal, runContext: runCtx });
            }
            return deliverable;
        } catch (err) {
            // A refused answer must not stay in the transcript, but the tool
            // rows of this run are already side effects: dropping them would
            // make a resumed session disagree with the journal. Covers both the
            // deliverable check and the inner loop's per-row check (B-6).
            if (err instanceof GuardrailViolationError) dropBlockedOutput({ session, before });
            throw err;
        }
    } finally {
        session._runInFlight = false;
    }
}


/**
 * Runs one side of the conversation past the guardrails.
 *
 * A `block` rule refuses the run with a typed error; a `warn` rule reports
 * the match and lets the run continue. Either way the match is announced as
 * an event, so a policy decision is always observable.
 *
 * @param {{guardrails: any, session: any, phase: 'input'|'output', text: string}} arg0 -
 * @returns {Promise<void>}
 */
async function applyGuardrail({ guardrails, session, phase, text }) {
    const verdict = await guardrails.check({ phase, text });
    if (!verdict?.rule) return;
    emitEvent({ emitter: sessionEmitter({ session }), name: EVENTS.GUARDRAIL.TRIPPED, payload: {
        rule: verdict.rule.name,
        phase: verdict.phase,
        action: verdict.rule.action,
        blocked: verdict.blocked
    } });
    if (!verdict.blocked) {
        sdkWarn({ prefix: 'GUARDRAIL', args: [`Guardrail "${verdict.rule.name}" matched on the ${verdict.phase} (${verdict.rule.action}).`] });
        return;
    }
    throw new GuardrailViolationError({
        message: `Guardrail "${verdict.rule.name}" blocked the ${verdict.phase}: ${verdict.message ?? 'the content was refused.'}`,
        options: { rule: verdict.rule, phase: verdict.phase }
    });
}


/**
 * @returns {Promise<{deliverable: string, runCtx: RunContext, runState: any}>}
  * @param {{session: *, messages: *, opts?: *}} arg0
 */
async function runAgenticLoopUnlocked({ session, messages, opts = {} }) {
    const runCtx = RunContext.child(opts.runContext ?? null);
    if (!runCtx.sessionId && session.sessionId) runCtx.sessionId = session.sessionId;
    // The inbox-turn budget is created ONCE per run (not per retry attempt) and
    // shared with the loop and with `run()` through `opts.__inboxBudget`: a host
    // that enqueues on every token is bounded by one cap, and rows over it stay
    // pending and visible instead of being dropped.
    const inboxBudget = /** @type {{left: number, exhausted?: boolean}} */ (opts.__inboxBudget ?? {
        left: Number(opts.maxInboxTurns ?? LIMITS.max_inbox_turns)
    });
    const runRetryPolicy = /** @type {import('../support/retry-policy.mjs').RetryPolicy} */ (opts.retryPolicy ?? session._retryPolicy ?? new NoRetryPolicy());
    const runBoundary = { lastCommitted: null };
    const journal = opts.journal ?? session._journal ?? new ExecutionJournal({ runId: runCtx.runId });
    let attemptMessages = messages;
    
    /** @type {any} */
        let runState =  (null);
    const onEvent = typeof opts.onEvent === 'function'
        ?  (/** @type {(...args: any[]) => any} */ ((e) => ( (opts.onEvent))(stampStreamEvent({ event: e, runContext: runCtx }))))
        : null;
    const startTs = Date.now();
    runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.RUN_START, payload: {
        provider: session.provider,
        model: session.model
    } });
    return runWithRunContext({ runContext: runCtx, fn: () => enterPhase({ ctx: { emitter: sessionEmitter({ session }), runContext: runCtx }, phase: PHASES.RUN, fn: async () => {
    const runUsage = {
        promptTokens: 0, completionTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
        credits: null,
        costUsd: null,
        costUnreportedCalls: 0,
        estTokens: 0,
        // The "the backend reported no cost" notice fires once per run.
        budgetNoticeEmitted: false,
        // Set when the JAI synthesis recovery lowered reasoning effort; the
        // run-level finally restores the caller's effort when it is true.
        reasoningLowered: false,
    };
    // The JAI synthesis recovery lowers reasoning effort for one retry, not
    // for the session's lifetime: snapshot the two fields it touches so the
    // finally below can put them back.
    const beforeJaiSpec = session._jaiSpec;
    const beforeParameters = session._parameters;
    try {
        const deliverable = await runWithRetry({ operation: async () => {
            runState = {
                promptTokens: 0, completionTokens: 0,
                cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
                credits: null,
                costUsd: null,
                costUnreportedCalls: 0,
                steps: 0, truncated: false, truncatedBy: null, contentFiltered: false, hadStreamError: false, exhausted: null,
                citations: [], sources: [], _provenanceKeys: new Set(),
                // The assistant rows the per-row output check already judged, so
                // the same answer is not judged (and reported) a second time as
                // the deliverable.
                judgedOutputRows: new Set()
            };
            return runAgenticLoopInner({ session, messages: attemptMessages, opts: { ...opts, onEvent, __journal: journal, __boundary: runBoundary, __inboxBudget: inboxBudget }, runCtx, runState, runUsage });
        }, policy: runRetryPolicy, signal: opts.signal, vendorName: session.provider, onRetry: () => {
                attemptMessages = runBoundary.lastCommitted ?? messages;
            } });
        const finishReason = runState.hadStreamError ? 'error'
            : runState.contentFiltered ? 'content_filtered'
            : runState.truncated ? (runState.truncatedBy === 'premature_end' ? 'premature_end' : 'length')
            : runState.exhausted ?? 'stop';
        session._lastRunText = deliverable;
        session._lastRunUsage = budgetUsage({ runUsage });
        session._lastRunCitations = runState.citations ?? [];
        session._lastRunSources = runState.sources ?? [];
        // The outcome `run()` cannot return (it resolves to a bare string). Without
        // it a consumer sees a truncated or fallback answer as a normal one.
        session._lastRunFinishReason = finishReason;
        session._lastRunTruncated = runState.truncated;
        session._lastRunTruncatedBy = runState.truncatedBy ?? null;
        session._lastRunContentFiltered = runState.contentFiltered;
        session._lastRunFallbackKind = fallbackKind({ text: typeof deliverable === 'string' ? deliverable : '' });
        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.RUN_END, payload: {
            finishReason,
            durationMs: Date.now() - startTs,
            steps: runState.steps,
            truncated: runState.truncated,
            ...(runState.truncatedBy ? { truncatedBy: runState.truncatedBy } : {}),
            usage: usageSnapshot({ runState: runUsage }),
            ...((runState.citations ?? []).length ? { citations: runState.citations } : {}),
            ...((runState.sources ?? []).length ? { sources: runState.sources } : {})
        } });
        return { deliverable, runCtx, runState };
    } catch (err) {
        session._lastRunUsage = budgetUsage({ runUsage });
        
        /** @type {any} */
                const e = err;
        // One guarded read: a hostile getter must not suppress the run:end report.
        /** @type {{aborted: boolean, failureClass: string, code: string, name: string, message: string, context?: unknown}} */
        let report = { aborted: false, failureClass: FailureClass.UNKNOWN, code: 'Error', name: 'Error', message: '' };
        try {
            const aborted = isAbortError({ err: e });
            report = {
                aborted,
                failureClass: aborted ? FailureClass.UNKNOWN : classifyFailure({ evidence: failureEvidence({ result: { errorCode: e?.code ?? null, errorName: e?.name ?? null } }) }),
                code: e?.code ?? e?.name ?? 'Error',
                name: e?.name ?? 'Error',
                message: String(e?.message ?? e),
                ...(e?.context ? { context: e.context } : {})
            };
        } catch { /* the fallback report stands */ }
        if (report.aborted) {
            runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.ABORTED, payload: { reason: report.message } });
        } else {
            // Diagnostic only; a frozen error refuses the property and keeps its shape.
            try { e.failureClass = report.failureClass; } catch { /* frozen error */ }
            runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.ERRORS.THROWN, payload: {
                code: report.code,
                name: report.name,
                message: report.message,
                ...(report.context ? { context: report.context } : {})
            } });
        }
        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.RUN_END, payload: {
            finishReason: report.aborted ? 'aborted'
                : e instanceof BudgetExceededError ? 'budget'
                : e instanceof MaxTurnsExceededError ? 'max_turns'
                : 'error',
            // A stable class, never a message; an abort is not a failure class.
            ...(report.aborted ? {} : { failureClass: report.failureClass }),
            // The run threw to its caller, whatever the reason.
            failed: true,
            durationMs: Date.now() - startTs,
            steps: runState?.steps ?? 0,
            truncated: runState?.truncated ?? false,
            usage: usageSnapshot({ runState: runUsage }),
        } });
        throw err;
    } finally {
        if (runUsage.reasoningLowered === true) {
            session._jaiSpec = beforeJaiSpec;
            session._parameters = beforeParameters;
        }
    }
    } }) });
}


/**
  * @param {{session: *, messages: *, opts?: *, runCtx: *, runState: *, runUsage: *}} arg0
 */
async function runAgenticLoopInner({ session, messages, opts = {}, runCtx, runState, runUsage }) {
    const maxIterations       = opts.maxIterations       ?? LIMITS.max_iterations;
    const maxConsecutiveEmpty = opts.maxConsecutiveEmpty ?? LIMITS.max_consecutive_empty;
    const maxFollowUps        = opts.maxFollowUps        ?? LIMITS.max_follow_ups;
    // The inbox-turn budget bounds ONE run: every turn a submitted message adds is
    // a turn a host could add forever (a host that enqueues on every token). The
    // caller shares it through `opts.__inboxBudget`, so a turn inside the loop and
    // a turn the caller adds after the loop spend one cap, not one cap each. Rows
    // over the cap stay pending and visible; they are never dropped.
    const inboxBudget = /** @type {{left: number, exhausted?: boolean}} */ (opts.__inboxBudget ?? {
        left: Number(opts.maxInboxTurns ?? LIMITS.max_inbox_turns)
    });
    /** @returns {Array<import('../messaging/unified-message.mjs').MessageRow>} */
    const claimInboxTurnOrRefuse = () => {
        // `drainInbox()` owns the next turn itself, so the run must not run ahead
        // of it: one turn per drain iteration is what makes each queued message
        // come back with its own answer.
        if (opts.__inboxTurns === 'caller') return [];
        return claimInboxTurn({ session, budget: inboxBudget, onClaim: emitInboxDelivered, onExhausted: ({ pending }) => {
        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.WARNING, payload: {
            code: 'INBOX_TURNS_EXHAUSTED',
            message: `The run's inbox-turn cap (${LIMITS.max_inbox_turns}) is spent; ${pending} submitted message(s) stay pending on the session inbox.`
        } });
    } });
    };
    /** @param {any} row */
    function emitInboxDelivered(row) {
        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.SESSION.INPUT_DELIVERED, payload: {
            inboxId: row?.merciId ?? null,
            delivery: row?.delivery ?? null
        } });
    }
    const onIterationStart    = typeof opts.onIterationStart === 'function' ? opts.onIterationStart : null;
    const onEvent             = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    const onLimitReached      = typeof opts.onLimitReached === 'function' ? opts.onLimitReached : null;
    const followUp            = typeof opts.followUp === 'function' ? opts.followUp : null;
    const signal              = opts.signal || null;
    const maxSchemaRetries    = opts.maxSchemaRetries ?? LIMITS.max_schema_retries;
    let schemaRetries         = 0;

    throwIfAborted({ signal });

    let currentMessages = dedupeMessages({ messages: [...messages] });
    // Rows a compaction fold removed during THIS run. The journal boundary is
    // derived from the message count, and a fold shortens the array, so a later
    // turn could land on a length an earlier turn already used and reuse its
    // keys. The offset is a local, so a retry of the same turn recomputes it
    // deterministically.
    let foldOffset = 0;
    let thoughtSignature = opts.thoughtSignature ?? null;
    let consecutiveEmpty = 0;
    let followUpRound = 0;
    let stageQueued = false;
    let hadToolRound = false;
    let reasoningLowered = false;
    let synthesisRecoveries = 0;
    let contentFilteredSeen = false;
    let lastGoodContent = null;
    // B-7: the prompt size the backend reported for the last step of this run
    // (the same `prompt_tokens` the ledger charges — W2-6). A row estimate
    // cannot see the system prompt or the tool schemas, so this is the only
    // honest floor once a call has run; compaction drops it (W2-5).
    /** @type {number|null} */
    let lastPromptTokens = null;
    const tools = _getBackendTools({ session });
    const approval = opts.approval ?? session._approvalPolicy ?? null;
    const maxTotalTokens = (opts.budget ?? session._budget ?? null)?.maxTotalTokens ?? null;
    const maxBudgetUsd = (opts.budget ?? session._budget ?? null)?.maxBudgetUsd ?? null;
    // D12: a session with a budget shares ONE pool with its children, so the cap
    // binds the tree, not each session (E2). A per-run budget stays local.
    const pool = ensureBudgetPool({ session });
    // B-1: enforce every capped ledger on the chain `pool -> parent -> ...`, not
    // just this session's own. A delegated child with its own budget used to be
    // bounded by that local cap alone while the tree's remaining budget was never
    // consulted, so a cap of 100 could be spent to 200. `absorbPoolUsage` already
    // reports upward; this is the matching downward read.
    /** @type {Array<import('./budget-pool.mjs').BudgetPool>} */
    const poolChain = [];
    {
        const seen = new Set();
        let link = pool;
        while (link && !seen.has(link)) {
            seen.add(link);
            poolChain.push(link);
            link = getPoolParent({ pool: link });
        }
    }
    // Budget admission ignores a reservation held by one of this run's own
    // ancestors: that caller is already blocked on this run (it is inside the
    // step that started it), so waiting for it could only deadlock. Sibling
    // reservations stay visible and are waited for. The trade-off: a delegated
    // child may spend into the ancestor's reservation, and the ancestor's own
    // post-charge check then reports the overshoot (two steps past the cap, not
    // one) — loud, rather than a deadlock or a clamped answer.
    const ancestorRunIds = new Set(/** @type {Array<string>} */ (runCtx._ancestorRunIds ?? []));
    /** @param {import('./budget-pool.mjs').BudgetPool} link @returns {number} The capacity on `link` that a non-ancestor run is holding. */
    const siblingReserved = (link) => {
        const by = /** @type {Map<string, number>|undefined} */ (link.reservedBy);
        if (!by) return link.reservedTokens ?? 0; // no per-run detail: a holder we cannot attribute is a sibling
        let total = 0;
        for (const [runId, amount] of by) {
            if (!ancestorRunIds.has(runId)) total += amount;
        }
        return total;
    };
    /**
     * The tightest token cap left on the chain (or null when no ancestor caps).
     * `shared` is true when that ledger is attached by more than one session, the
     * only case where a call has to leave room for a concurrent sibling (B-3).
     * `remaining` excludes reservations held by an ancestor of this run.
     * @returns {{remaining: number, max: number, spent: number, shared: boolean, pool: import('./budget-pool.mjs').BudgetPool}|null}
     */
    const chainTokenLimit = () => {
        let best = null;
        for (const link of poolChain) {
            const max = Number(link.maxTotalTokens);
            if (!Number.isFinite(max) || max <= 0) continue;
            // B-3: a call in flight reserves what it may spend, so a sibling that
            // passes the pre-check at the same time cannot authorise the same
            // remainder a second time.
            const remaining = max - link.usage.total_tokens - siblingReserved(link);
            if (best === null || remaining < best.remaining) {
                best = { remaining, max, spent: link.usage.total_tokens, shared: Array.isArray(link.attached) && link.attached.length > 1, pool: link };
            }
        }
        return best;
    };
    /**
     * Reserves a call's projected spend on every ledger that caps tokens. The
     * check-and-reserve runs without an await, so two turns cannot both see the
     * same remainder (B-3). `runId` splits the reservation per run so a
     * descendant can exclude its ancestor's hold.
     * @param {{amount: number, runId?: string}} arg0
     * @returns {number}
     */
    const reserveChainTokens = ({ amount, runId = runCtx.runId }) => {
        const n = Math.max(0, Math.floor(amount));
        if (n <= 0) return 0;
        for (const link of poolChain) {
            if (!Number.isFinite(Number(link.maxTotalTokens))) continue;
            link.reservedTokens = (link.reservedTokens ?? 0) + n;
            if (runId) {
                const by = /** @type {Map<string, number>} */ (link.reservedBy ??= new Map());
                by.set(runId, (by.get(runId) ?? 0) + n);
            }
        }
        return n;
    };
    /** Claims one in-flight caller slot on every capped ledger (B-3 fairness). */
    const beginChainCall = () => {
        for (const link of poolChain) {
            if (!Number.isFinite(Number(link.maxTotalTokens))) continue;
            link.reservedCallers = (link.reservedCallers ?? 0) + 1;
        }
    };
    /** Releases one in-flight caller slot claimed by `beginChainCall`. */
    const endChainCall = () => {
        for (const link of poolChain) {
            if (!Number.isFinite(Number(link.maxTotalTokens))) continue;
            link.reservedCallers = Math.max(0, (link.reservedCallers ?? 0) - 1);
        }
    };
    /** @param {{amount: number, runId?: string}} arg0 */
    const releaseChainTokens = ({ amount, runId = runCtx.runId }) => {
        if (!(amount > 0)) return;
        for (const link of poolChain) {
            if (link.reservedTokens === undefined) continue;
            link.reservedTokens = Math.max(0, link.reservedTokens - amount);
            const by = /** @type {Map<string, number>|undefined} */ (link.reservedBy);
            if (runId && by) {
                const left = (by.get(runId) ?? 0) - amount;
                if (left > 0) by.set(runId, left);
                else by.delete(runId);
            }
        }
    };
    const spentTotal = () => {
        const reported = runUsage.promptTokens + runUsage.completionTokens;
        // Estimates cover steps that reported no usage. Once any step reports
        // tokens, the old code returned only `reported` and silently dropped
        // every estimated step; charge both.
        return reported + runUsage.estTokens;
    };
    const treeSpentTotal = () => (pool ? pool.usage.total_tokens : spentTotal());
    const treeUsage = () => (pool ? poolUsageSnapshot({ pool }) : budgetUsage({ runUsage }));

    if (tools === null) {
        throw new ConfigurationError({ message: 'agentic-core: session does not expose its tool library.' });
    }

    // SP7 — a host may steer a RUNNING turn. A `steer` row is claimed at the
    // next step boundary and reaches the model there; a `queue` row is claimed
    // at the TURN boundary, so it never interrupts a running step but still gets
    // its own turn before `run()` returns — a one-shot caller never has to call
    // `run()` again for a message the user already sent. A turn that fails puts
    // its claimed rows back, so delivery is at-least-once.
    // Rows injected into `currentMessages` that no completed step has seen yet.
    // A failed turn restores exactly these; a completed step acknowledges them.
    /** @type {Array<Object>} */
    let unacknowledgedRows = [];

    let extensionRound = 0;
    let autoExtensionRound = 0;
    let dmExtensionRound = 0;
    let hitlExtensionRound = 0;
    const autoExtend = opts.autoExtend ?? false;
    const autoExtendOpts = (typeof autoExtend === 'object' && autoExtend !== null) ? autoExtend : {};
    const maxAutoExtensions = autoExtendOpts.maxExtensions ?? LIMITS.max_follow_up_extensions;
    const minNovelToolCalls = autoExtendOpts.minNovelToolCalls ?? LIMITS.auto_extend_min_novel_tool_calls;
    const isProgressing = typeof autoExtendOpts.isProgressing === 'function' ? autoExtendOpts.isProgressing : null;
    const errorHandlers = opts.errorHandlers ?? null;
    const seenToolFingerprints = new Set();
    let lastRoundNovelCalls = 0;

    const lowerSynthesisReasoningOnce = () => {
        if (reasoningLowered) return;
        if (session.provider !== ProviderType.JAI) return;
        if (typeof session.withParameters !== 'function') return;
        session.withParameters({ params: (/** @type {any} */ b) => b.reasoningEffort({ v: 'low' }) });
        reasoningLowered = true;
        // Read by the run-level finally: the lowering is undone when the run
        // ends, so the next run starts at the caller's effort again.
        runUsage.reasoningLowered = true;
        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.WARNING, payload: {
            code: 'SYNTHESIS_REASONING_LOWERED',
            message: 'Synthesis after a tool round produced no text — lowering reasoning effort for the retry.'
        } });
    };

    /** @param {{ iteration: number }} arg0 @returns {Promise<boolean>} */
    const recoverSynthesis = async ({ iteration }) => {
        if (session.provider !== ProviderType.JAI) return false;
        if (typeof session.withParameters !== 'function') return false;
        if (synthesisRecoveries >= maxConsecutiveEmpty) return false;
        if (iteration >= maxIterations - 1) return false;
        synthesisRecoveries += 1;
        lowerSynthesisReasoningOnce();
        await sleepAbortable({ ms: LIMITS.synthesis_retry_backoff_ms * synthesisRecoveries, signal });
        currentMessages = [...currentMessages, createSyntheticUserMessage({ provider: session.provider, content: SYNTHESIS_NUDGE })];
        return true;
    };

    while (true) {
        throwIfAborted({ signal });
        let stageContent = null;

        for (let i = 0; i < maxIterations; i++) {
            throwIfAborted({ signal, message: 'Agentic loop aborted mid-iteration.' });
            const globalIteration = extensionRound * maxIterations + i;
            const isLastIteration = (i === maxIterations - 1);
            if (isLastIteration) {
                runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.TOOL_WARNING, payload: { message: 'Maximum tool iteration limit reached.' } });
            }
            runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.RUN_ITERATION_START, payload: {
                iteration: i,
                globalIteration,
                maxIterations
            } });
            if (onIterationStart) await onIterationStart({ i, globalIteration, iterMax: maxIterations, extRound: extensionRound, signal });

            if (typeof session._maybeObjectivePass === 'function') {
                await session._maybeObjectivePass({ signal, messages: currentMessages, runContext: runCtx });
            }

            let stepMaxOutputTokens = null;
            let stepPromptEst = 0;
            const tokenChain = chainTokenLimit();
            // B-3: a waiting turn claims nothing — no caller slot, no reservation
            // — so the pool is exactly as it found it if it is refused. The
            // finally below releases whatever the proceeding path claimed.
            let callerSlot = false;
            /** @type {number} */
            let reservedTokens = 0;
            let turnStartLength = currentMessages.length;
            /** @type {Awaited<ReturnType<typeof runDueSteps>>[number]} */
            let turnOutcome;
            try {
                if (maxTotalTokens != null || tokenChain !== null) {
                    if (maxTotalTokens != null && spentTotal() >= maxTotalTokens) {
                        failBudget({ runCtx, session, maxTotalTokens, usage: budgetUsage({ runUsage }) });
                    }
                    let treeNow = chainTokenLimit();
                    // Only a chain whose SPEND has already reached the cap fails here.
                    // A remainder consumed by in-flight reservations is waited for
                    // (admission, below) or clamped: a nested call for the same
                    // logical spend must still run (its charge is what the
                    // post-check reports).
                    if (treeNow !== null && treeNow.spent >= treeNow.max) {
                        failBudget({ runCtx, session, maxTotalTokens: treeNow.max, usage: poolUsageSnapshot({ pool: treeNow.pool }) });
                    }
                    stepPromptEst = Math.max(estimateMessageTokens({ messages: currentMessages }), lastPromptTokens ?? 0);
                    if (lastPromptTokens === null) {
                        // B-7: no call has reported a size yet, so the first capped
                        // call is projected from the rows AND the parts the rows
                        // cannot show — the system prompt and the tool schemas.
                        stepPromptEst += estimateTokens({ text: session.getSystemMessage?.() ?? '' })
                            + estimateTokens({ text: session._requestTools?.() ?? [] });
                    }
                    /** Re-checks the session-local cap; the admission wait re-runs it. */
                    /** @returns {number|null} */
                    const localRemaining = () => {
                        if (maxTotalTokens == null) return null;
                        const projected = spentTotal() + stepPromptEst;
                        if (projected >= maxTotalTokens) {
                            failBudget({ runCtx, session, maxTotalTokens, usage: projectedBudgetUsage({ runUsage, projected, maxTotalTokens }) });
                        }
                        return maxTotalTokens - projected;
                    };
                    /** @type {number|null} */
                    let remaining = localRemaining();
                    // B-3 fairness: the allowance this turn would get if it
                    // claimed its caller slot NOW — computed without claiming, so
                    // a waiter moves no counter. Only a NON-ancestor caller is a
                    // competitor (an ancestor is blocked on this run), so a
                    // delegated child divides by 1 and keeps the whole remainder
                    // its ancestor's hold was hiding.
                    /** @param {{remaining: number, pool: import('./budget-pool.mjs').BudgetPool}} chain */
                    const admissionShare = (chain) => {
                        const by = /** @type {Map<string, number>|undefined} */ (chain.pool.reservedBy);
                        let callers = chain.pool.reservedCallers ?? 0;
                        if (by) {
                            callers = 0;
                            for (const [runId, amount] of by) {
                                if (amount > 0 && !ancestorRunIds.has(runId)) callers += 1;
                            }
                        }
                        return Math.floor(Math.max(0, chain.remaining - stepPromptEst) / (callers + 1));
                    };
                    /** A turn that had to wait was contended; a small remainder is then a refusal, not an overshoot. */
                    let waitedAny = false;
                    if (treeNow !== null) {
                        const minOutput = LIMITS.step_min_output_tokens;
                        const waitMs = LIMITS.budget_admission_wait_ms;
                        let share = admissionShare(treeNow);
                        // A contended sibling gets a usable share or nothing: wait
                        // (yielded, signal-aware) for an in-flight reservation to
                        // free capacity instead of starting a starved call. The
                        // holder never waits on a waiter. Under the default cap of
                        // 0 the wait is unbounded (capacity or abort); a positive
                        // value is an optional deadline.
                        // Only a reservation held by a NON-ancestor can free
                        // capacity: an ancestor is blocked on this run, so waiting
                        // for it could only deadlock. A lone turn in a shared pool
                        // (no such reservation) keeps its remainder and is reported
                        // starved instead of waiting for a sibling that does not
                        // exist.
                        const siblingInFlight = () => {
                            const by = /** @type {Map<string, number>|undefined} */ (treeNow?.pool.reservedBy);
                            if (!by) return ((/** @type {any} */ (treeNow))?.pool.reservedCallers ?? 0) > 0;
                            for (const [runId, amount] of by) {
                                if (amount > 0 && !ancestorRunIds.has(runId)) return true;
                            }
                            return false;
                        };
                        for (let waited = 0; treeNow.shared && siblingInFlight() && share < minOutput; waited += 10) {
                            waitedAny = true;
                            if (waitMs > 0 && waited >= waitMs) {
                                failAdmission({
                                    runCtx, session,
                                    max: treeNow.max,
                                    remaining: Math.max(0, treeNow.remaining - stepPromptEst),
                                    min: minOutput,
                                    usage: poolUsageSnapshot({ pool: treeNow.pool }),
                                });
                            }
                            await sleepAbortable({ ms: 10, signal });
                            const next = chainTokenLimit();
                            if (next === null) {
                                // The owner cleared the tree caps mid-wait: no share to wait for.
                                remaining = localRemaining();
                                treeNow = null;
                                break;
                            }
                            treeNow = next;
                            // Capacity opened up but the cap is spent: the same
                            // pre-call failure as above, now with fresh numbers.
                            if (treeNow.spent >= treeNow.max) {
                                failBudget({ runCtx, session, maxTotalTokens: treeNow.max, usage: poolUsageSnapshot({ pool: treeNow.pool }) });
                            }
                            remaining = localRemaining();
                            share = admissionShare(treeNow);
                        }
                        // A chain that is merely tight clamps the output; only a
                        // chain already spent past its cap fails before the call.
                        // This keeps the documented one-call overshoot, and the
                        // post-charge check reports the spend that landed.
                        remaining = remaining == null ? share : Math.min(remaining, share);
                        // A turn that waited and still cannot reach the minimum is
                        // refused: the capacity it waited for never arrived. A turn
                        // that never waited keeps the documented one-call overshoot
                        // (a lone nested call for the same logical spend).
                        if (waitedAny && treeNow !== null && Math.max(1, Math.floor(remaining ?? 1)) < minOutput) {
                            failAdmission({
                                runCtx, session,
                                max: treeNow.max,
                                remaining: Math.max(0, Math.floor(remaining ?? 0)),
                                min: minOutput,
                                usage: poolUsageSnapshot({ pool: treeNow.pool }),
                            });
                        }
                    }
                    stepMaxOutputTokens = Math.max(1, Math.floor(remaining ?? 1));
                    // A turn that PROCEEDS at or below the minimum is reported
                    // (B-3) — a lone caller whose pool is nearly spent. A waiting
                    // caller is never clamped: it gets a usable share or refuses.
                    if (treeNow !== null && stepMaxOutputTokens <= LIMITS.step_min_output_tokens) {
                        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.BUDGET_STARVED, payload: {
                            maxTotalTokens: treeNow.max,
                            remainingTokens: stepMaxOutputTokens,
                            minOutputTokens: LIMITS.step_min_output_tokens
                        } });
                    }
                }

                // B-3: the caller slot and the reservation are claimed in one
                // synchronous block, so no sibling can authorise the same
                // remainder. Released by the finally below on every path.
                if (tokenChain !== null) { beginChainCall(); callerSlot = true; }
                reservedTokens = reserveChainTokens({ amount: stepPromptEst + (stepMaxOutputTokens ?? 0), runId: runCtx.runId });
                // SP7: a steer that arrived while the previous step ran joins the
                // conversation now, before this step's request is assembled.
                const steeredThisTurn = claimSteerRows({ session, onClaim: emitInboxDelivered });
                if (steeredThisTurn.length > 0) {
                    currentMessages = interleavePendingRows({ rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (currentMessages), pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (steeredThisTurn) });
                    unacknowledgedRows.push(...steeredThisTurn);
                }
                // Intra-turn snapshot: the delegation path (`task.mjs`) reads this
                // WHILE the turn is in flight, so it must see the rows sent to the
                // model — including on turn 1. The authoritative value is committed
                // after the turn, below (A2).
                session._lastStepMessages = currentMessages;
                turnStartLength = currentMessages.length;
                const gen = /** @type {Function} */ (session.step)({ messages: currentMessages, options: {
                    forceTextResponse: isLastIteration,
                    thoughtSignature,
                    isLastIteration,
                    signal,
                    runContext: runCtx,
                    maxOutputTokens: stepMaxOutputTokens
                } });
                const stepBoundary = `${opts.boundaryPrefix ?? ''}b${turnStartLength + foldOffset}`;

                turnOutcome = (await runDueSteps({ steps: [{
                    key: `turn-${globalIteration}`,
                    run: () => drainStepWithHooks({ gen, tools, onEvent, signal, emitter: sessionEmitter({ session }), runContext: runCtx, approval, journal: opts.__journal ?? null, boundary: stepBoundary, hooks: withToolGuardrails({ guardrails: session._guardrails ?? null, hooks: session._hooks ?? null }), toolTimeoutMs: session._toolTimeoutMs, maxParallelTools: session._maxParallelTools ?? null, permissionMode: session._permissionRules?.mode ?? 'default' }),
                }] }))[0];
            } finally {
                // The call has settled: release the in-flight reservation and the
                // caller slot before any result processing. The charge below is
                // synchronous, so no sibling observes the gap, and every later
                // throw path is leak-free.
                releaseChainTokens({ amount: reservedTokens, runId: runCtx.runId });
                if (callerSlot) endChainCall();
            }
            if (turnOutcome.status === 'rejected') {
                const reason = turnOutcome.reason;
                const failedUsage = /** @type {any} */ (reason)?.usage;
                // A budget error is thrown after its own charge; absorbing it again
                // would double-count a delegated subtree that shares this pool.
                if (!(reason instanceof BudgetExceededError)) {
                    // A frozen error cannot carry the drain's annotations, so the
                    // streamed count and the usage are read from the drain's own
                    // bookkeeping instead of the foreign error object.
                    const streamedChars = streamedCharsOf({ err: reason });
                    const usageKnown = !!failedUsage && typeof failedUsage === 'object';
                    if (usageKnown || streamedChars !== null) {
                        const charged = usageKnown ? failedUsage : {};
                        const failedReported = (charged.prompt_tokens ?? 0) + (charged.completion_tokens ?? 0);
                        // B-8: a step that dies before its usage frame still sent
                        // the prompt and usually part of the answer. Charge the
                        // same estimate the success branch charges for a silent
                        // step, or a retry loop spends without moving the cap.
                        // `estimateTokens` counts characters: a same-length filler
                        // gives the count without keeping the partial answer.
                        const failedEstimate = failedReported === 0
                            ? stepPromptEst + estimateTokens({ text: 'x'.repeat(Math.max(0, streamedChars ?? 0)) })
                            : 0;
                        if (failedEstimate > 0 && (maxTotalTokens != null || pool)) {
                            runUsage.estTokens += failedEstimate;
                        }
                        addUsage({ acc: runState, usage: charged, estimated: failedEstimate });
                        addUsage({ acc: runUsage, usage: charged, estimated: failedEstimate });
                        absorbPoolUsage({ pool, usage: charged, estTokens: failedEstimate });
                    }
                }
                restoreInboxRows({ session, rows: unacknowledgedRows });
                unacknowledgedRows = [];
                throw reason;
            }
            
            /** @type {{ messages?: Array<MessageRow>, usage?: Record<string, number>, streamError?: {error_message?: string, error_type?: string}|null, thoughtSignature?: string|null, truncated?: boolean, truncatedBy?: 'length'|'premature_end', contentFiltered?: boolean, content?: string, citations?: Array<any>, sources?: Array<{title?: string, url?: string}> }} */
                        const finalState = /** @type {any} */ (turnOutcome.value);
            unacknowledgedRows = [];
            runState.steps++;
            const reportedStepTokens = (finalState?.usage?.prompt_tokens ?? 0) + (finalState?.usage?.completion_tokens ?? 0);
            // W2-6: the floor of the next call's projection is `prompt_tokens`
            // alone — the quantity the ledger charges. A cached prompt is a
            // subset of `prompt_tokens` on the APIs that report cache reads, so
            // adding them refuses a call that fits. The compaction trigger below
            // keeps the cache-inclusive sum, which is the right size there.
            const billedPromptTokens = finalState?.usage?.prompt_tokens ?? 0;
            if (billedPromptTokens > 0) lastPromptTokens = billedPromptTokens;
            // An unreported step is charged as an estimate both locally and to
            // the tree, so a silent backend cannot hide spend from the cap.
            const stepEstimate = reportedStepTokens === 0
                ? stepPromptEst + estimateTokens({ text: finalState?.content ?? '' })
                : 0;
            // W2-8: the estimate rides along, so the run counts an uncosted call
            // exactly as the pool does.
            addUsage({ acc: runState, usage: finalState?.usage, estimated: stepEstimate });
            addUsage({ acc: runUsage, usage: finalState?.usage, estimated: stepEstimate });
            for (const citation of finalState?.citations ?? []) addProvenance({ runState, list: 'citations', item: citation });
            for (const source of finalState?.sources ?? []) addProvenance({ runState, list: 'sources', item: source });
            if (reportedStepTokens === 0 && (maxTotalTokens != null || pool)) {
                runUsage.estTokens += stepEstimate;
            }
            absorbPoolUsage({ pool, usage: finalState?.usage, estTokens: stepEstimate });
            if (maxTotalTokens != null && spentTotal() > maxTotalTokens) {
                failBudget({ runCtx, session, maxTotalTokens, usage: budgetUsage({ runUsage }) });
            }
            // Every capped ancestor fails closed, not just this session's pool (B-1).
            for (const link of poolChain) {
                const cap = Number(link.maxTotalTokens);
                if (Number.isFinite(cap) && cap > 0 && link.usage.total_tokens > cap) {
                    failBudget({ runCtx, session, maxTotalTokens: cap, usage: poolUsageSnapshot({ pool: link }) });
                }
                const usdCap = Number(link.maxBudgetUsd);
                // W2-7: a null cost against a USD cap is unreported spend, not
                // $0 — it cannot be compared, so it is announced below rather
                // than passing the cap silently.
                if (Number.isFinite(usdCap) && usdCap > 0 && link.usage.cost_usd != null && link.usage.cost_usd >= usdCap) {
                    failBudgetUsd({
                        runCtx,
                        session,
                        maxBudgetUsd: usdCap,
                        costUsd: /** @type {number} */ (link.usage.cost_usd),
                        usage: poolUsageSnapshot({ pool: link }),
                    });
                }
            }
            // The money budget follows the amount the BACKEND reported. The SDK
            // never estimates a price, so a cap whose ledger is unpriced (or
            // only partly priced) cannot be enforced: that is announced (once)
            // and the run continues — the token budget is the mechanism. B-9: a
            // partly costed run is announced too, because the sum only covers
            // the priced calls. W2-7: an ancestor's cap counts, not just the
            // session's own.
            /** @type {import('./budget-pool.mjs').BudgetPool|null} */
            const unpricedUsdLink = poolChain.find((link) => {
                const usdCap = Number(link.maxBudgetUsd);
                if (!(Number.isFinite(usdCap) && usdCap > 0)) return false;
                return link.usage.cost_usd == null || (link.usage.cost_unreported_calls ?? 0) > 0;
            }) ?? null;
            const ownUsdUnpriced = maxBudgetUsd != null && (runUsage.costUsd == null || (runUsage.costUnreportedCalls ?? 0) > 0);
            if ((ownUsdUnpriced || unpricedUsdLink !== null) && !runUsage.budgetNoticeEmitted) {
                // Once per RUN: the flag lives on the run-level usage state,
                // which spans the retry attempts.
                runUsage.budgetNoticeEmitted = true;
                const cap = unpricedUsdLink !== null ? Number(unpricedUsdLink.maxBudgetUsd) : Number(maxBudgetUsd);
                const ledgerCost = unpricedUsdLink !== null ? unpricedUsdLink.usage.cost_usd : runUsage.costUsd;
                const unreportedCalls = unpricedUsdLink !== null
                    ? (unpricedUsdLink.usage.cost_unreported_calls ?? 0)
                    : (runUsage.costUnreportedCalls ?? 0);
                runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.BUDGET_UNREPORTED, payload: { maxBudgetUsd: cap, model: session.model, unreportedCalls } });
                sdkWarn({ prefix: 'BUDGET', args: [ledgerCost == null
                    ? `The USD budget ($${cap}) cannot be enforced: the backend reported no cost for this run. The token budget governs.`
                    : `${unreportedCalls} model call(s) reported tokens but no cost for this run: the reported USD spend ($${ledgerCost.toFixed(6)}) is a lower bound.`] });
            }
            if (maxBudgetUsd != null && runUsage.costUsd != null && runUsage.costUsd >= maxBudgetUsd) {
                failBudgetUsd({ runCtx, session, maxBudgetUsd, costUsd: runUsage.costUsd, usage: budgetUsage({ runUsage }) });
            }
            if (finalState?.streamError) runState.hadStreamError = true;

            if (finalState?.streamError) {
                // A provider that dies mid-stream produced no answer. Throwing
                // (instead of returning a sentinel) is what lets `runWithRetry`
                // apply the run-level policy; the sentinel was reported as success.
                // The run's catch reports the failure as `errors:thrown` (code =
                // the vendor's `error_type`), so this branch does not emit twice.
                throw streamErrorToRetryError({ error: finalState.streamError });
            }

            const newMessages = finalState.messages || currentMessages;
            const appendedRows = newMessages.length > currentMessages.length
                ? newMessages.slice(currentMessages.length)
                : [];
            const hasNewToolCalls = appendedRows.some(m => _isToolCallMessage({ m }));

            currentMessages = dedupeMessages({ messages: newMessages });
            // A dedupe that drops a re-delivered row can shrink the array below
            // the turn's start; the boundary must not walk back over it.
            foldOffset += Math.max(0, turnStartLength - currentMessages.length);
            thoughtSignature = finalState.thoughtSignature ?? thoughtSignature;
            if (opts.__boundary) opts.__boundary.lastCommitted = currentMessages;
            // A2 — the authoritative writer of the step transcript, AFTER the
            // turn: the rows the model actually committed. The pre-call snapshot
            // above is the walk-in view delegation reads; without this second
            // write it stayed pre-answer, so `runStep` returned a transcript
            // missing the answer for any backend that honours the documented
            // `step()` return contract but never writes this private field.
            session._lastStepMessages = currentMessages;

            // B-6: judge every assistant text row this step appended, not only the
            // deliverable. A blocked secret in an interim turn otherwise stays in
            // the transcript (and reaches memory and checkpoints) beside the tool
            // round. The deltas were already streamed to `onEvent`, so the check
            // cannot un-send them; it can refuse to persist them.
            if (session._guardrails) {
                for (const row of appendedRows) {
                    const rowText = _assistantText({ m: row });
                    if (!rowText.trim()) continue;
                    try {
                        await applyGuardrail({ guardrails: session._guardrails, session, phase: 'output', text: rowText });
                        runState.judgedOutputRows.add(row);
                    } catch (err) {
                        // Delete exactly the refused row: a tail trim keeps it when
                        // the text sits next to a tool call. A row that CARRIES
                        // tool calls must stay — the tool result after it is a side
                        // effect, and deleting the call row orphans it — so only its
                        // text is stripped, from both carriers `_assistantText` reads.
                        currentMessages = _isToolCallMessage({ m: row })
                            ? currentMessages.map(r => (r === row
                                ? { ...row, content: '', ...(Array.isArray(row.parts) ? { parts: row.parts.filter(p => p.type !== 'text') } : {}) }
                                : r))
                            : currentMessages.filter(r => r !== row);
                        session._lastStepMessages = currentMessages;
                        if (opts.__boundary) opts.__boundary.lastCommitted = currentMessages;
                        throw err;
                    }
                }
            }

            if (opts.compaction && typeof opts.compaction === 'object') {
                const beforeFold = currentMessages.length;
                // The trigger is the size the backend billed for this step's
                // prompt (cache reads and writes included), not a row estimate
                // that cannot see the system prompt or the tool schemas. The
                // cache-inclusive sum is the right measure here; the projection
                // floor uses `prompt_tokens` alone (W2-6).
                const promptSize = billedPromptTokens
                    + (finalState?.usage?.cache_creation_input_tokens ?? 0)
                    + (finalState?.usage?.cache_read_input_tokens ?? 0);
                const beforeCompaction = currentMessages;
                currentMessages = await compactHistory({
                    messages: currentMessages,
                    compaction: opts.compaction,
                    session,
                    signal,
                    onEvent,
                    promptTokens: promptSize,
                    onUsage: (/** @type {Record<string, any>} */ usage) => {
                        addUsage({ acc: runUsage, usage });
                        absorbPoolUsage({ pool, usage, estTokens: 0 });
                    },
                });
                // W2-5: a rewritten history invalidates the reported size. Keeping
                // it as the next call's floor refused a fresh 20-token prompt
                // against a 900-token measurement of the folded history.
                if (currentMessages !== beforeCompaction) lastPromptTokens = null;
                // Re-derive from the actual array delta: fold.dropped counts the
                // rows replaced, and the summary row is one of them.
                foldOffset += Math.max(0, beforeFold - currentMessages.length);
            }

            if (hasNewToolCalls) {
                consecutiveEmpty = 0;
                hadToolRound = true;
                let novelCalls = 0;
                for (const row of appendedRows) {
                    for (const fp of _toolCallFingerprints({ m: row })) {
                        if (!seenToolFingerprints.has(fp)) {
                            seenToolFingerprints.add(fp);
                            novelCalls++;
                        }
                    }
                }
                lastRoundNovelCalls = novelCalls;
                if (maxIterations >= 2 && i + 2 === maxIterations) {
                    currentMessages = [...currentMessages, createSyntheticUserMessage({ provider: session.provider, content: PENULTIMATE_ITERATION_REMINDER })];
                }
                runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.RUN_ITERATION_END, payload: {
                    iteration: i, globalIteration, maxIterations, steps: runState.steps, hadToolRound: true
                } });
                continue;
            }

            if (finalState?.truncated) {
                const partial = String(finalState.content || '').trim();
                const truncatedNote = finalState.truncatedBy === 'premature_end'
                    ? FALLBACK_MESSAGE.TRUNCATED_BY_PROVIDER
                    : FALLBACK_MESSAGE.TRUNCATED;
                if (finalState.contentFiltered) {
                    // Doc 031: remove the moderation-blocked answer, not only
                    // withhold it from the deliverable. The transcript is what
                    // the next turn re-sends to the provider and what a
                    // checkpoint saves, so strip every assistant-text row this
                    // step appended before any synthesis retry. Tool-call rows
                    // stay (their results are a side effect); only their text
                    // is removed, exactly as the guardrail path does.
                    const blockedRows = appendedRows.filter(r => _assistantText({ m: r }).trim() || _isToolCallMessage({ m: r }));
                    if (blockedRows.length > 0) {
                        for (const row of blockedRows) {
                            if (!currentMessages.includes(row)) continue;
                            currentMessages = _isToolCallMessage({ m: row })
                                ? currentMessages.map(r => (r === row
                                    ? { ...row, content: '', ...(Array.isArray(row.parts) ? { parts: row.parts.filter(p => p.type !== 'text') } : {}) }
                                    : r))
                                : currentMessages.filter(r => r !== row);
                        }
                        session._lastStepMessages = currentMessages;
                        if (opts.__boundary) opts.__boundary.lastCommitted = currentMessages;
                    }
                    if (!contentFilteredSeen) {
                        contentFilteredSeen = true;
                        if (onEvent) onEvent({ type: EVENTS.STEP.CONTENT_FILTERED });
                        runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.WARNING, payload: {
                            code: 'CONTENT_FILTERED',
                            message: "The provider's content moderation stopped the response."
                        } });
                    }
                    // A partial after a tool round is usually the provider
                    // closing the synthesis stream, not a real max-token answer.
                    // Retry before treating the fragment as the deliverable.
                    if (hadToolRound && await recoverSynthesis({ iteration: i })) continue;
                    // The transcript no longer carries it; text deltas already
                    // streamed to onEvent cannot be un-sent, which is what the
                    // CONTENT_FILTERED event marks for a live consumer.
                    runState.contentFiltered = true;
                    return lastGoodContent ?? FALLBACK_MESSAGE.CONTENT_FILTERED;
                }
                if (hadToolRound && await recoverSynthesis({ iteration: i })) continue;
                runState.truncated = true;
                runState.truncatedBy = finalState.truncatedBy ?? null;
                if (onEvent) onEvent({ type: EVENTS.STEP.TRUNCATED });
                if (partial) return partial + truncatedNote;
                return `${FALLBACK_MESSAGE.EMPTY_RESPONSE} ${lastGoodContent ?? ''}`.trim() + truncatedNote;
            }

            const isEmpty = !finalState.content || !String(finalState.content).trim();
            if (isEmpty) {
                thoughtSignature = null;
                if (hadToolRound) {
                    if (await recoverSynthesis({ iteration: i })) continue;
                    if (session.provider === ProviderType.JAI) {
                        runState.exhausted = 'empty';
                        return lastGoodContent ?? FALLBACK_MESSAGE.EMPTY_RESPONSE;
                    }
                    currentMessages = [...currentMessages, createSyntheticUserMessage({ provider: session.provider, content: SYNTHESIS_NUDGE })];
                    hadToolRound = false;
                    continue;
                }
            } else {
                hadToolRound = false;
            }

            if (finalState.content && String(finalState.content).trim()) {
                const validation = await _validateDeliverable({ session, content: finalState.content, onEvent });
                if (!validation.ok && schemaRetries < maxSchemaRetries) {
                    schemaRetries++;
                    currentMessages = [...currentMessages, createSyntheticUserMessage({ provider: session.provider, content: validation.correction })];
                    consecutiveEmpty = 0;
                    stageQueued = true;
                    break;
                }
                const deliverable = validation.content;
                schemaRetries = 0;
                lastGoodContent = deliverable;
                stageContent = deliverable;
                if (followUp && followUpRound < maxFollowUps) {
                    const next = await followUp({
                        round: followUpRound,
                        content: deliverable,
                        messages: currentMessages,
                        signal
                    });
                    if (next) {
                        currentMessages = [...currentMessages, createSyntheticUserMessage({ provider: session.provider, content: String(next) })];
                        followUpRound++;
                        stageQueued = true;
                        break;
                    }
                }
                if (!validation.ok) runState.exhausted = 'schema';
                // SP7: input that arrived during the final step is a new
                // instruction, not something to drop on the floor. A steer is
                // answered here instead of returning now; a `queue` row — the
                // message a user sent while this turn ran — gets its own turn
                // BEFORE `run()` returns, because the caller may never call it
                // again. That is OpenCode's inbox rule: only a turn start may
                // promote a queue row.
                const turnRowsAtEnd = claimInboxTurnOrRefuse();
                if (turnRowsAtEnd.length > 0) {
                    currentMessages = interleavePendingRows({ rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (currentMessages), pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (turnRowsAtEnd) });
                    unacknowledgedRows.push(...turnRowsAtEnd);
                    stageQueued = true;
                    break;
                }
                return deliverable;
            }
            consecutiveEmpty++;
            // The same promise on the empty-answer path: a message the user sent
            // must not be stranded because this turn produced nothing.
            const queuedAfterEmpty = claimInboxTurnOrRefuse();
            if (queuedAfterEmpty.length > 0) {
                currentMessages = interleavePendingRows({ rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (currentMessages), pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (queuedAfterEmpty) });
                unacknowledgedRows.push(...queuedAfterEmpty);
                consecutiveEmpty = 0;
                stageQueued = true;
                break;
            }
            if (consecutiveEmpty >= maxConsecutiveEmpty) {
                runState.exhausted = 'empty';
                return lastGoodContent ?? FALLBACK_MESSAGE.EMPTY_RESPONSE;
            }
            // ponytail: emitted only on a full or tool-round iteration; early break/return paths (schema retry, follow-up) do not emit.
            runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.RUN_ITERATION_END, payload: {
                iteration: i, globalIteration, maxIterations, steps: runState.steps, hadToolRound: !!hadToolRound
            } });
        }

        if (stageQueued) {
            stageQueued = false;
            consecutiveEmpty = 0;
            continue;
        }

        if (followUp && followUpRound < maxFollowUps) {
            const next = await followUp({
                round: followUpRound,
                content: stageContent ?? '',
                messages: currentMessages,
                signal
            });
            if (next) {
                currentMessages = [...currentMessages, createSyntheticUserMessage({ provider: session.provider, content: String(next) })];
                followUpRound++;
                consecutiveEmpty = 0;
                continue;
            }
        }

        const iterationsUsed = (extensionRound + 1) * maxIterations;

        if (autoExtend && autoExtensionRound < maxAutoExtensions) {
            const progressing = isProgressing
                ? isProgressing({ novelToolCalls: lastRoundNovelCalls, iterationsUsed, maxIterations })
                : lastRoundNovelCalls >= minNovelToolCalls;
            if (progressing) {
                autoExtensionRound++;
                extensionRound++;
                runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.MAX_TURNS_EXTENDED, payload: {
                    reason: 'progress',
                    novelToolCalls: lastRoundNovelCalls,
                    extensionRound: autoExtensionRound,
                    maxExtensions: maxAutoExtensions,
                    iterationsUsed
                } });
                consecutiveEmpty = 0;
                lastRoundNovelCalls = 0;
                continue;
            }
        }

        // One bounded extension when the decision surface is certain one more
        // round plausibly finishes the task. Never more than one per run.
        if (!autoExtend && dmExtensionRound < 1 && opts.decisionGate?.available) {
            const dm = await opts.decisionGate.gate({
                state: { iterationsUsed, novelToolCalls: lastRoundNovelCalls, partialOutput: String(lastGoodContent ?? '').slice(0, 2000) },
                question: noulQuestion({
                    instructions: 'The tool-round limit is reached; would one more round plausibly produce the final answer?',
                    criteria: { true: 'One more tool round can plausibly finish the task.', false: 'Another round would repeat work without finishing.' }
                }),
                signal
            });
            if (!dm.escalated && dm.verdict === true && dm.certainty !== null && dm.certainty >= LIMITS.decision_skip_certainty) {
                dmExtensionRound++;
                extensionRound++;
                runCtx.emit({ emitter: sessionEmitter({ session }), name: EVENTS.CLIENT.MAX_TURNS_EXTENDED, payload: {
                    reason: 'decision_gate',
                    extensionRound: dmExtensionRound,
                    maxExtensions: 1,
                    iterationsUsed
                } });
                consecutiveEmpty = 0;
                lastRoundNovelCalls = 0;
                continue;
            }
        }

        if (onLimitReached && hitlExtensionRound < LIMITS.max_follow_up_extensions) {
            hitlExtensionRound++;
            extensionRound++;
            const extend = await onLimitReached({
                reason: `Maximum tool iteration limit reached (${maxIterations} per round, ${iterationsUsed} total used so far).`,
                iterationsUsed,
                extensionRound: hitlExtensionRound,
                maxExtensions: LIMITS.max_follow_up_extensions,
                signal
            });
            if (extend) {
                consecutiveEmpty = 0;
                lastRoundNovelCalls = 0;
                continue;
            }
        }

        const controlled = await _finishExhausted({ session, errorHandlers, info: {
            maxTurns: maxIterations,
            iterationsUsed,
            messages: currentMessages,
            partialOutput: lastGoodContent
        }, runCtx });
        runState.exhausted = 'max_turns';
        return controlled;
    }
}


/**
 * @returns {Promise<{ok: true, content: string} | {ok: false, content: string, correction: string}>}
  * @param {{session: *, content: *, onEvent: *}} arg0
 */
async function _validateDeliverable({ session, content, onEvent }) {
    const schema = session?._outputSchema;
    if (!schema) return { ok: true, content };
    const { describeParseFailure } = await import('./planning/planner-utils.mjs');
    
    /** @type {any} */
        const parsed = extractAndParseJson({ input: content, schema });
    if (parsed.success) return { ok: true, content };
    if (onEvent) onEvent({ type: EVENTS.STEP.SCHEMA_VALIDATION_FAILED, error: parsed.error, content });
    return {
        ok: false,
        content: `${FALLBACK_MESSAGE.SCHEMA_VALIDATION} (schema validation failed: ${parsed.error})`,
        correction: `${SCHEMA_CORRECTION_PREFIX} (${describeParseFailure({ parsed })}). Output ONLY the JSON object — no prose, no markdown code fences.`
    };
}


/**
 * The characters a step streamed before it threw, carried outside the error
 * object: a caller's error may be frozen or non-extensible, and annotating it
 * must never turn into a TypeError inside the failure path.
 * @type {WeakMap<object, number>}
 */
const streamedCharsByError = new WeakMap();


/**
 * The streamed size the drain recorded for this error, or `null` when the error
 * did not come through `drainStepWithHooks` (a synchronous step() throw).
 * @param {{err: unknown}} arg0
 * @returns {number|null}
 */
function streamedCharsOf({ err }) {
    if (!err || typeof err !== 'object') return null;
    return streamedCharsByError.get(/** @type {object} */ (err)) ?? null;
}


/**
 * usage across the step's events into `result.usage` so the loop and
 * compaction have real token data.
 * @param {{gen: AsyncGenerator<StepStreamEvent, unknown, unknown>, tools: Array<Object>, onEvent?: Function|null, signal?: AbortSignal|null, emitter?: import('node:events').EventEmitter|null, runContext?: RunContext|null, approval?: {callback: Function, timeoutMs?: number}|null, journal?: import('./journal.mjs').ExecutionJournal|null, boundary?: string|number|null, hooks?: import('../core/hooks.mjs').HookRegistry|null, toolTimeoutMs?: number|null, maxParallelTools?: number|null, permissionMode?: 'default'|'acceptEdits'|'bypassPermissions'}} arg0 -
 */
export async function drainStepWithHooks({ gen, tools, onEvent, signal, emitter = null, runContext = null, approval = null, journal = null, boundary = null, hooks = null, toolTimeoutMs = null, maxParallelTools = null, permissionMode = 'default' }) {
    
    /** @type {{ prompt_tokens: number, completion_tokens: number, total_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number, reasoning_tokens: number, credits?: Record<string, unknown>, cost_usd?: number }} */
        const usage = {
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 0
    };
    // B-8: the text streamed before a failure. Usage frames arrive at the end,
    // so a mid-stream disconnect spent this and reported nothing.
    let streamedChars = 0;
    try {
        let result = await gen.next();
        while (!result.done) {
            throwIfAborted({ signal, message: 'Step drain aborted.' });
            const event = result.value;
            const calls = event?.calls ?? [];
            if (event && event.type === 'tool_request') {
                if (onEvent) {
                    for (const call of calls) {
                        onEvent({ type: EVENTS.STEP.TOOL_CALL_START, name: call.name || call.function?.name || '', args: call.args ?? call.arguments ?? call.input ?? '' });
                    }
                }
                
                /** @type {Array<{result?: unknown}>} */
                                const toolResults = await executeTools({ toolCalls: calls, toolLibrary: tools, signal, emitter, runContext, approval, journal, boundary, hooks, toolTimeoutMs, maxParallelTools, permissionMode });
                if (onEvent && toolResults) {
                    for (let i = 0; i < calls.length; i++) {
                        const call = calls[i];
                        if (!call) continue;
                        const name = call.name || call.function?.name || '';
                        onEvent({ type: EVENTS.STEP.TOOL_CALL_END, name, result: toolResults[i]?.result ?? toolResults[i] });
                    }
                }
                result = await gen.next(toolResults);
            } else {
                if (event?.type === 'text' && event.content) streamedChars += String(event.content).length;
                if (event?.type === 'quota' && event.data) {
                    usage.prompt_tokens = Math.max(usage.prompt_tokens, event.data.prompt_tokens ?? 0);
                    usage.completion_tokens = Math.max(usage.completion_tokens, event.data.completion_tokens ?? 0);
                    usage.cache_creation_input_tokens = Math.max(usage.cache_creation_input_tokens, event.data.cache_creation_input_tokens ?? 0);
                    usage.cache_read_input_tokens = Math.max(usage.cache_read_input_tokens, event.data.cache_read_input_tokens ?? 0);
                    usage.reasoning_tokens = Math.max(usage.reasoning_tokens, event.data.reasoning_tokens ?? 0);
                    // The cost the backend reported (USD). Absent when the
                    // backend reported none — an unknown cost, never zero.
                    if (typeof event.data.cost_usd === 'number' && Number.isFinite(event.data.cost_usd)) {
                        usage.cost_usd = Math.max(usage.cost_usd ?? 0, event.data.cost_usd);
                    }
                    if (event.data.updated || event.data.spent) usage.credits = event.data;
                }
                if (onEvent && event) onEvent(event);
                result = await gen.next();
            }
        }
        if (onEvent) onEvent({ type: EVENTS.STEP.STREAM_END });
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        return { ...(/** @type {Record<string, unknown>|null|undefined} */ (result.value) || {}), usage };
    } catch (err) {
        // A step that reported usage and then threw still spent it (B1): carry the
        // partial usage on the error so the loop can charge the failed attempt.
        if (err && typeof err === 'object') {
            streamedCharsByError.set(err, streamedChars);
            // A frozen or non-extensible error cannot take the annotation; the map
            // above is what the loop reads, so the estimate still lands (B-8).
            if (Object.isExtensible(err)) {
                const failure = /** @type {any} */ (err);
                if (!failure.usage) failure.usage = { ...usage };
                if (failure.streamedChars === undefined) failure.streamedChars = streamedChars;
            }
        }
        throw err;
    } finally {
        try { await gen.return?.(undefined); } catch {   }
    }
}


/**
 * callers no longer need to invoke injectMemory themselves; step() does
 * it through `_prepareStepMessages`.
 * @param {{session: Session, messages: Array<MessageRow>, options?: {signal?: AbortSignal, runContext?: RunContext, thoughtSignature?: string|null, forceTextResponse?: boolean}}} arg0 -
 * @returns {AsyncGenerator<StepStreamEvent, unknown, unknown>}
 */
export async function* stepAgentic({ session, messages, options = {} }) {
    throwIfAborted({ signal: options.signal });
    const stepRunCtx = RunContext.child(options.runContext ?? null);
    const gen = /** @type {Function} */ (session.step)({ messages: [...messages], options: { ...options, runContext: stepRunCtx } });
    let result = await gen.next();
    while (!result.done) {
        const yielded = yield result.value;
        result = await gen.next(yielded);
    }

    const resultMessages = (result.value && result.value.messages) || messages;
    if (result.value && result.value.done) {
        maybeDistill({ session, messages: resultMessages, signal: options.signal, runContext: stepRunCtx });
    }

    return result.value;
}


/**
 * Returns the default display `{ onEvent }` for runAgenticLoop consumers:
 * thinking via the logger, text/tool deltas to stdout (the first text delta of
 * each turn is prefixed with `Assistant > ` so the answer is labelled exactly
 * once), newline on stream_end. Also surfaces the events it used to drop
 * silently (mid-stream error, truncation, schema failure, content filter,
 * compaction).
 *
 * `stream` adds the granular step-stream logger (`createStreamLogger`): a level
 * string (or `true` = `'debug'`, `false` to disable). Default `'debug'`, so
 * `-v`/`LOG_LEVEL=debug` turns on the full step stream (quota, first_token,
 * finish, …) for every example with no per-example wiring.
 * @param {{also?: Function, stream?: string|boolean}} arg0
 * @returns {{onEvent: (e: StepStreamEvent) => void}}
 */
export function defaultDisplay({ also, stream = 'debug' } = {}) {
    let labeled = false;
    const streamLog = stream ? createStreamLogger({ level: stream === true ? 'debug' : stream }) : null;
    return {
        onEvent: (e) => {
            if (!e) return;
            if (also) also(e);
            if (streamLog) streamLog(e);
            if (e.type === EVENTS.STEP.THOUGHT) log.thinking({ t: e.content });
            else if (e.type === EVENTS.STEP.TEXT) {
                const chunk = String(e.content ?? '');
                if (!labeled && chunk) { log.assistant({ m: '', isStreaming: true }); labeled = true; }
                process.stdout.write(chunk);
            }
            else if (e.type === EVENTS.STEP.TOOL_CALL_START) log.toolCall({ n: e.name, a: e.args });
            else if (e.type === EVENTS.STEP.TOOL_CALL_END) log.toolResult({ n: e.name, r: e.result });
            else if (e.type === EVENTS.STEP.STREAM_END) { if (labeled) { process.stdout.write('\n'); labeled = false; } }
            // Notables the renderer used to drop silently — a mid-stream vendor
            // error, a truncated answer, a schema failure, or a compaction must
            // never be invisible.
            else if (e.type === EVENTS.CLIENT.ERROR) log.error({ m: `stream error (${e.error_type ?? 'unknown'})`, d: e.error_message ?? '' });
            else if (e.type === EVENTS.STEP.SCHEMA_VALIDATION_FAILED) log.warn({ m: `schema validation failed: ${e.error}` });
            else if (e.type === EVENTS.STEP.TRUNCATED) log.warn({ m: 'response truncated by the token limit' });
            else if (e.type === EVENTS.STEP.CONTENT_FILTERED) log.warn({ m: 'response stopped by provider content moderation' });
            else if (e.type === EVENTS.STEP.COMPACTION) log.event({ type: 'compaction', payload: { dropped: e.dropped, summarized: e.summarized } });
        },
    };
}
