// @ts-check


/**
 * @file Objective policy + the restatement pass.
 * @version 0.12.0
 *
 * @description
 * The objective is a mutable artifact, not a frozen constant: a run restates it
 * from the work so far on a cadence (`firstUpdate`, then every `updateTurns`
 * turns), so the direction stays current and lands in the model's recent
 * attention span instead of decaying in the middle of the window. The initial
 * value (what `withObjective` was called with) is kept on the context for the
 * record and rides along in the restatement prompt.
 *
 * Two guards keep adaptation from becoming drift: a restatement that is empty,
 * a fallback string, or absurdly long is REJECTED (the previous objective is
 * kept), and every applied change is versioned + emitted as
 * `run:objective_updated` with the previous text, so a silent rewrite is
 * impossible.
 */
import { isSdkFallbackOutput } from './agentic-core.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { isAbortError } from '../core/errors.mjs';
import { isGenuineUserTurn } from '../messaging/unified-message.mjs';
import { utilitySession } from './planning/planner-utils.mjs';
import { truncateForPrompt } from '../support/utils.mjs';


/**
 * An objective-policy bag as `normalizeObjectivePolicy` reads it: every knob is
 * optional and a bad one falls back to the default.
 * @typedef {Object} ObjectivePolicyOptions
 * @property {boolean} [adaptable]
 * @property {boolean} [hitl]
 * @property {number} [firstUpdate]
 * @property {number} [updateTurns]
 * @property {boolean} [preStep]
 */

/**
 * The policy the cadence reads (the normalized one, or a caller's partial bag).
 * @typedef {Object} ObjectivePolicy
 * @property {boolean} [adaptable]
 * @property {boolean} [hitl]
 * @property {number} [firstUpdate]
 * @property {number} [updateTurns]
 * @property {boolean} [preStep]
 */

/**
 * What one restatement pass reports — the `run:objective_updated` payload.
 * @typedef {Object} ObjectiveOutcome
 * @property {boolean} applied
 * @property {string} reason - `cadence` | `unchanged` | `restatement_failed` | `hitl_declined` | `hitl_unconfigured`.
 * @property {string|null} previous
 * @property {string|null} objective
 * @property {string} [error] - Present when `reason` is `restatement_failed`.
 * @property {number} turn
 * @property {number} [version] - Present when the pass applied.
 * @property {string|null} [initial] - The original objective, present when the pass applied.
 */


/**
 * Cadence + gating defaults. `adaptable: true` — the pass runs unless opted out.
 * `preStep` (default false) opts the stateMachine/discussion engines into a pass
 * BEFORE their step prompt is built (the naive engine always does this — its
 * prompt is assembled by the executor and would otherwise carry a stale goal).
 */
export const DEFAULT_OBJECTIVE_POLICY = Object.freeze({
    adaptable: true,
    hitl: false,
    // Read through the registry so a kill switch or env override still applies.
    get firstUpdate() { return LIMITS.objective_first_update; },
    get updateTurns() { return LIMITS.objective_update_turns; },
    preStep: false,
});



/**
 * Merges caller options over the defaults. Non-integer / < 1 cadence values
 * fall back to the default rather than throwing — a bad knob must not fail a run.
 * @param {{opts?: ObjectivePolicyOptions|null}} arg0
 * @returns {{ adaptable: boolean, hitl: boolean, firstUpdate: number, updateTurns: number, preStep: boolean }}
 */
export function normalizeObjectivePolicy({ opts = null } = {}) {
    const o = opts ?? {};
    return {
        adaptable: o.adaptable !== false,
        hitl: o.hitl === true,
        firstUpdate: Number.isInteger(o.firstUpdate) && /** @type {number} */ (o.firstUpdate) >= 1
            ? /** @type {number} */ (o.firstUpdate) : DEFAULT_OBJECTIVE_POLICY.firstUpdate,
        updateTurns: Number.isInteger(o.updateTurns) && /** @type {number} */ (o.updateTurns) >= 1
            ? /** @type {number} */ (o.updateTurns) : DEFAULT_OBJECTIVE_POLICY.updateTurns,
        preStep: o.preStep === true,
    };
}


/**
 * it (default 1, 11, 21, ...).
 * @param {{policy: ObjectivePolicy, turn: number}} arg0 -
 * @returns {boolean}
 */
export function shouldRunObjectivePass({ policy, turn }) {
    if (!policy?.adaptable || !Number.isInteger(turn) || turn < 1) return false;
    const first = policy.firstUpdate ?? DEFAULT_OBJECTIVE_POLICY.firstUpdate;
    const every = policy.updateTurns ?? DEFAULT_OBJECTIVE_POLICY.updateTurns;
    if (turn === first) return true;
    return turn > first && (turn - first) % every === 0;
}


/** First line of the restatement prompt — the discriminator for `isObjectiveRestatePrompt`. */
export const OBJECTIVE_RESTATE_HEADER = 'You maintain the working objective of an ongoing agent run.';


/**
 * not a message array). Stub clients in tests use this to stay model-call-only.
 * @param {{input: unknown}} arg0 -
 * @returns {boolean}
 */
export function isObjectiveRestatePrompt({ input }) {
    return typeof input === 'string' && input.includes(OBJECTIVE_RESTATE_HEADER);
}


/**
 * The restatement prompt. Anchored on the current objective (or the work, when
 * there is none yet) — the model may sharpen and extend, never replace the goal.
 * @param {{ objective: string|null, progress: string }} param0
 * @returns {string}
 */
export function objectiveRestatePrompt({ objective, progress }) {
    return `${OBJECTIVE_RESTATE_HEADER}

Current objective:
${objective || '(none yet — derive it from the work below)'}

Work so far:
${progress || '(nothing yet)'}

Rewrite the objective as one short imperative paragraph (max 60 words) that:
- states the goal in the imperative,
- keeps every constraint the current objective already carries,
- adds constraints, acceptance criteria, or established facts the work makes explicit,
- never invents a new goal.

Reply with the objective text only — no preamble, no quotes, no markdown.`;
}


/**
 * intake on the first pass, the work after it) plus the last assistant text.
 * Cheap and bounded — a restatement, not a summarization.
 * @param {{messages?: Array<import('../messaging/unified-message.mjs').MessageRow>}} arg0 -
 * @returns {string}
 */
export function objectiveProgressDigest({ messages = [] } = {}) {
    const text = (/** @type {Record<string, unknown>} */ m) => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    const rows = Array.isArray(messages) ? messages : [];
    const users = rows
        .filter((m) => isGenuineUserTurn({ m }) && !m?.functionResponse)
        .map(text).filter((s) => s && s.trim());
    const parts = users.slice(-LIMITS.objective_intake_rows);
    const lastAssistant = [...rows].reverse()
        .find((m) => m && (m.type === 'assistant_message_text' || m.role === 'assistant') && String(text(m)).trim());
    if (lastAssistant) parts.push(`Last assistant output:\n${text(lastAssistant)}`);
    return truncateForPrompt({ text: parts.join('\n\n'), maxChars: LIMITS.objective_digest_chars });
}


/**
 * One pass's whole input: the context to adapt, the client that runs the
 * restatement session, and the optional hooks (approval, emit, unavailability).
 * @typedef {Object} ObjectivePassInput
 * @property {import('./agent-context.mjs').AgentContext|null} ctx
 * @property {{session?: Function}|null|undefined} client
 * @property {string} model
 * @property {string} [progress]
 * @property {AbortSignal|null} [signal]
 * @property {{callback: Function}|null} [approval]
 * @property {((arg0: {outcome: ObjectiveOutcome}) => void)|null} [emit]
 * @property {(() => void)|null} [onUnavailable]
 * @property {string|null} [sessionId]
 * @property {Object|null} [pool] - The caller's attempt ledger; the restatement is charged to it.
 */

/**
 * runs it before building a step prompt). Owns the whole contract: cadence,
 * the bounded call, the guards, the HITL gate, the version bump and the event.
 * A failed / rejected / unchanged restatement changes nothing.
 * @param {{p: ObjectivePassInput}} arg0 -
 * @returns {Promise<ObjectiveOutcome|null>} the outcome, or null when the pass was not due.
 */
export async function runObjectivePass({ p }) {
    const ctx = p.ctx;
    if (!ctx || !/** @type {{ adaptable?: boolean, hitl?: boolean, firstUpdate?: number, updateTurns?: number }|null} */ (ctx.objectivePolicy)?.adaptable) return null;
    const latch = /** @type {any} */ (ctx);
    if (latch._objectivePassInFlight) return latch._objectivePassInFlight;
    const task = _runObjectivePassNow(p);
    latch._objectivePassInFlight = task.finally(() => { latch._objectivePassInFlight = null; });
    return latch._objectivePassInFlight;
}


/**
 * The pass body, serialized per context by `runObjectivePass`'s latch.
 * @param {ObjectivePassInput} arg0
 * @returns {Promise<ObjectiveOutcome|null>} the outcome, or null when the pass was not due.
 */
async function _runObjectivePassNow({ ctx, client, model, progress = '', approval = null, signal = null, emit = null, onUnavailable = null, sessionId = null, pool = null }) {
    const policy = /** @type {{ adaptable?: boolean, hitl?: boolean, firstUpdate?: number, updateTurns?: number }|null} */ (ctx?.objectivePolicy);
    if (!ctx || !policy?.adaptable) return null;
    ctx.objectiveTurn = (ctx.objectiveTurn ?? 0) + 1;
    if (!shouldRunObjectivePass({ policy, turn: ctx.objectiveTurn })) return null;
    const turn = ctx.objectiveTurn;
    if (typeof client?.session !== 'function') {
        onUnavailable?.();
        return null;
    }
    const previous = ctx.objective;
    
    /** @type {string|null} */
        let next = null;
    try {
        next = await restateObjective({ client, model, objective: previous, progress, signal, sessionId, pool });
    } catch (err) {
        // Only a caller cancellation may escape. `isAbortError` also matches
        // the stream inactivity timeout (an AbortError with STREAM_TIMEOUT),
        // which is a failed restatement — rethrowing it aborted the whole run.
        if (signal?.aborted && isAbortError({ err, signal })) throw err;
        const outcome = { applied: false, reason: 'restatement_failed', previous, objective: previous, error: String(/** @type {Error} */ (err)?.message ?? err), turn };
        emit?.({ outcome });
        return outcome;
    }
    if (!next || next === previous) return { applied: false, reason: 'unchanged', previous, objective: previous, turn };
    if (policy.hitl) {
        let approved = false;
        if (approval?.callback) {
            try {
                approved = !!(await approval.callback('objective_update',
                    { previous, objective: next, turn }, { tool: null, id: `objective_${turn}` }));
            } catch {
                approved = false;
            }
        }
        if (!approved) {
            const outcome = { applied: false, reason: approval?.callback ? 'hitl_declined' : 'hitl_unconfigured', previous, objective: next, turn };
            emit?.({ outcome });
            return outcome;
        }
    }
    if (!ctx.applyObjective({ next })) return { applied: false, reason: 'unchanged', previous, objective: previous, turn };
    const outcome = {
        applied: true, reason: 'cadence',
        previous, objective: ctx.objective, version: ctx.objectiveVersion, turn, initial: ctx.objectiveInitial,
    };
    emit?.({ outcome });
    return outcome;
}


/**
 * One bounded restatement call. Returns null when the pass cannot run or the
 * output is unusable (empty / SDK fallback / over-long) — the caller keeps the
 * previous objective, so a failed pass is a no-op, never a direction loss.
 * @param {{client: {session?: Function}|null|undefined, model: string, objective: string|null, progress?: string, signal?: AbortSignal|null, sessionId?: string|null, pool?: Object|null}} arg0
 * @returns {Promise<string|null>}
 */
export async function restateObjective({ client, model, objective, progress = '', signal = null, sessionId = null, pool = null }) {
    if (typeof client?.session !== 'function') return null;
    // G5: a stable, run-scoped id — the restatement is its own session, but its
    // events must not announce a fresh auto uuid on the run's emitter.
    const session = utilitySession({ client, model, sessionId });
    if (typeof session?.run !== 'function') return null;
    // The session's own transport is the base client, so a runner's attempt ledger
    // would otherwise miss this call; the util session is per-call.
    const util = /** @type {any} */ (session);
    if (pool && !util._budgetPool) util._budgetPool = pool;
    const raw = await session.run({
        initialInput: objectiveRestatePrompt({ objective: objective ?? null, progress }),
        options: { maxIterations: LIMITS.objective_restate_iterations, ...(signal ? { signal } : {}) }
    });
    const text = String(raw ?? '').trim();
    if (!text || isSdkFallbackOutput({ text }) || text.length > LIMITS.objective_max_chars) return null;
    return text;
}
