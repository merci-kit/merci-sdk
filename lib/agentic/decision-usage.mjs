// @ts-check
/**
 * @file Decision usage → the session's budget pool.
 * @version 0.24.0
 *
 * @description
 * A decision call is not a session turn, so it never reaches the loop's usage
 * accounting. This adapter makes the gate report each answered call into the
 * session's budget pool (and its ancestors), in the pool's usage shape. A
 * session without a budget has no pool and is charged nothing; a step's decision
 * tokens ride the usage the step returns instead.
 */

import { absorbPoolUsage, ensureBudgetPool } from './budget-pool.mjs';
import { ConfigurationError } from '../core/errors.mjs';

/** The session a derived gate is charged to. */
const DECISION_USAGE_OWNER = Symbol('merci.decisionUsageOwner');

/**
 * The bookkeeping this adapter keeps on a session, read and written in place.
 * @typedef {{_decisionUsage?: {prompt_tokens: number, completion_tokens: number, total_tokens: number, estimated_tokens: number, cost_usd: number|null}|null, _decisionUsageGates?: WeakMap<object, import('./decision-gate.mjs').DecisionGate>}} DecisionUsageSession
 *   `cost_usd` is `null` once any call reported no price.
 */


/**
 * The per-run options a session hands to the agentic loop: its own gate is the
 * default, and an explicit `options.decisionGate` wins for one call.
 * @param {{options?: Record<string, unknown>, gate?: object|null}} arg0
 * @returns {Record<string, unknown>|undefined}
 */
export function mergeDecisionGate({ options, gate }) {
    if (!gate) return options;
    if (options && options.decisionGate !== undefined) return options;
    return { ...options, decisionGate: gate };
}


/**
 * Wraps `gate` so every answered call is charged to `session`'s pool. The pool
 * is resolved at call time: a session that receives its budget later (an
 * attempt ledger, a child cap) is still charged.
 * @param {{session: object|null|undefined, gate: import('./decision-gate.mjs').DecisionGate|null}} arg0
 * @returns {import('./decision-gate.mjs').DecisionGate|null} the gate (wrapped when it can report usage, else unchanged)
 */
/**
 * The tokens and cost one usage event represents. A usage object with no finite
 * token field is unreported: estimate from the capped state size. `cost` is
 * `null` when the vendor reported no price — unknown, never zero.
 * @param {{usage?: import('./decision-gate.mjs').DecisionUsage|null, stateChars?: number}} arg0
 * @returns {{tokens: number, cost: number|null}}
 */
export function decisionTokensFromEvent({ usage = null, stateChars = 0 }) {
    const hasTokens = Number.isFinite(usage?.inputTokens) || Number.isFinite(usage?.outputTokens);
    const hasCost = typeof usage?.cost === 'number' && Number.isFinite(usage.cost);
    const tokens = hasTokens
        ? Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0)
        : Math.ceil(Math.max(0, Number(stateChars) || 0) / 4);
    return { tokens, cost: hasCost ? /** @type {number} */ (usage?.cost) : null };
}


/**
 * The session's decision spend so far (tokens). The executor cap is fed by the
 * per-step sink in `runStep`; this counter is the session-wide view.
 * @param {{session: object|null|undefined}} arg0
 * @returns {number}
 */
export function decisionUsageTotal({ session }) {
    return Number((/** @type {DecisionUsageSession|null|undefined} */ (session))?._decisionUsage?.total_tokens ?? 0);
}


/**
 * The session's decision cost so far, in USD. `null` once any call failed to
 * report a price: a partly priced total is unknown, not the sum of the priced
 * calls (`0` when no call has run).
 * @param {{session: object|null|undefined}} arg0
 * @returns {number|null}
 */
export function decisionUsageCost({ session }) {
    const acc = (/** @type {DecisionUsageSession|null|undefined} */ (session))?._decisionUsage;
    if (!acc) return 0;
    return typeof acc.cost_usd === 'number' && Number.isFinite(acc.cost_usd) ? acc.cost_usd : null;
}


/**
 * Merges a step's decision tokens into the usage `runStep` returns. The
 * decision count rides as its own field too, so a step record can explain it.
 * `decisionCost: null` means the vendor reported no price: the LLM's
 * `cost_usd` is kept (existing readers still get a number) but
 * `cost_complete: false` says it does not cover the decision calls.
 * @param {{usage?: Record<string, unknown>|null, decisionTokens?: number, decisionCost?: number|null}} arg0
 * @returns {Record<string, unknown>|null}
 */
export function mergeRunUsage({ usage = null, decisionTokens = 0, decisionCost = 0 }) {
    const hasTokens = Number.isFinite(decisionTokens) && decisionTokens > 0;
    const costUnknown = decisionCost === null;
    const hasCost = typeof decisionCost === 'number' && Number.isFinite(decisionCost) && decisionCost > 0;
    if (!hasTokens && !hasCost) return usage ?? null;
    const base = usage && typeof usage === 'object' ? usage : {};
    /** @type {Record<string, unknown>} */
    const merged = { ...base };
    if (hasTokens) {
        // `decision_tokens` is a SUBSET of total_tokens: never add the two.
        merged.total_tokens = Number(base.total_tokens ?? 0) + decisionTokens;
        merged.decision_tokens = Number(base.decision_tokens ?? 0) + decisionTokens;
        if (costUnknown) merged.cost_complete = false;
    }
    if (hasCost) {
        // A known decision cost does not make an unknown LLM cost complete.
        if (Number.isFinite(base.cost_usd)) merged.cost_usd = Number(base.cost_usd) + decisionCost;
        else merged.decision_cost_usd = Number(base.decision_cost_usd ?? 0) + decisionCost;
    }
    return merged;
}


/**
 * Adds one call to the session's decision accumulator (non-enumerable, so a
 * checkpoint never serializes it).
 * @param {{session: DecisionUsageSession, usage: Record<string, unknown>|null, estimated: number}} arg0
 * @returns {void}
 */
function accumulateDecisionUsage({ session, usage, estimated }) {
    if (!session || typeof session !== 'object') return;
    /** @type {DecisionUsageSession['_decisionUsage']} */
    let acc = session._decisionUsage;
    if (!acc) {
        // 0 until a call runs, then `null` for good once any call is unpriced.
        acc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_tokens: 0, cost_usd: 0 };
        Object.defineProperty(session, '_decisionUsage', { value: acc, enumerable: false, configurable: true, writable: true });
    }
    acc.prompt_tokens += Number(usage?.prompt_tokens ?? 0);
    acc.completion_tokens += Number(usage?.completion_tokens ?? 0);
    acc.total_tokens += Number(usage?.prompt_tokens ?? 0) + Number(usage?.completion_tokens ?? 0) + estimated;
    acc.estimated_tokens += estimated;
    if (typeof usage?.cost_usd === 'number' && Number.isFinite(usage.cost_usd)) {
        if (acc.cost_usd !== null) acc.cost_usd += usage.cost_usd;
    } else {
        // G3-6: one unpriced call makes the session total unknown for good.
        acc.cost_usd = null;
    }
}


/**
 * Wraps `gate` so every answered call is charged to `session`'s pool and to its
 * decision accumulator. A derived gate belongs to one session; sharing it with
 * another is refused rather than double-charged.
 * @param {{session: object|null|undefined, gate: import('./decision-gate.mjs').DecisionGate|null}} arg0
 * @returns {import('./decision-gate.mjs').DecisionGate} the derived gate (or the input when it cannot report usage)
 */
export function attachDecisionUsage({ session, gate }) {
    if (!gate || typeof gate.withUsage !== 'function') return /** @type {import('./decision-gate.mjs').DecisionGate} */ (gate);
    if (!session || typeof session !== 'object') return gate;
    // A gate derived for one session must not be shared with another: its
    // listener would charge both pools for one call.
    const owner = /** @type {Record<symbol, object|undefined>} */ (/** @type {unknown} */ (gate))[DECISION_USAGE_OWNER];
    if (owner && owner !== session) {
        throw new ConfigurationError({
            message: 'A decision gate derived by withDecisionGate() belongs to one session. Pass the raw gate (runtime.gate) to another session instead of session._decisionGate.',
            options: { option: 'decisionGate' },
        });
    }
    // Already charged to this session exactly once (every derivation composes
    // one listener for it): re-wrapping would compose a second listener.
    if (owner === session) return gate;
    // One gate is attached to one session at most once: re-wrapping a derived
    // gate would compose its listener again and charge the same call twice. The
    // map stores the WRAPPED gate, so a repeat attach returns the charged one
    // instead of the raw argument (which would charge nothing).
    /** @type {WeakMap<object, import('./decision-gate.mjs').DecisionGate>|undefined} */
    let attached = /** @type {DecisionUsageSession} */ (session)._decisionUsageGates;
    if (!(attached instanceof WeakMap)) {
        attached = new WeakMap();
        // Non-enumerable: a checkpoint or cassette must not see a bookkeeping map.
        Object.defineProperty(session, '_decisionUsageGates', { value: attached, enumerable: false, configurable: true, writable: true });
    }
    const existing = attached.get(gate);
    if (existing) return existing;
    const wrapped = gate.withUsage({
        onUsage: (/** @type {{usage: import('./decision-gate.mjs').DecisionUsage|null, stateChars?: number}} */ { usage, stateChars = 0 }) => {
            // Every adapter returns a usage OBJECT, often with null token fields.
            // "No numeric token" is unreported, not zero: estimate from the state.
            const hasTokens = Number.isFinite(usage?.inputTokens) || Number.isFinite(usage?.outputTokens);
            const hasCost = typeof usage?.cost === 'number' && Number.isFinite(usage.cost);
            const reported = (hasTokens || hasCost) ? {
                prompt_tokens: hasTokens ? Number(/** @type {any} */ (usage).inputTokens ?? 0) : 0,
                completion_tokens: hasTokens ? Number(/** @type {any} */ (usage).outputTokens ?? 0) : 0,
                cost_usd: hasCost ? /** @type {number} */ (/** @type {any} */ (usage).cost) : undefined,
            } : null;
            const estimated = hasTokens ? 0 : Math.ceil(Math.max(0, stateChars) / 4);
            // The accumulator is the executor-cap source and works without a pool.
            accumulateDecisionUsage({ session: /** @type {DecisionUsageSession} */ (session), usage: reported, estimated });
            // A session with a budget also charges its pool (and its ancestors).
            const pool = ensureBudgetPool({ session });
            if (pool) absorbPoolUsage({ pool, usage: reported, estTokens: estimated });
        },
    });
    attached.set(gate, wrapped);
    // Re-attaching the derived gate itself is a no-op, not a second listener.
    attached.set(wrapped, wrapped);
    // Enumerable on purpose: a spread copy must keep the owner so the guard
    // still refuses it. Symbols are ignored by JSON and Object.keys.
    Object.defineProperty(wrapped, DECISION_USAGE_OWNER, { value: session, enumerable: true, configurable: true });
    return wrapped;
}
