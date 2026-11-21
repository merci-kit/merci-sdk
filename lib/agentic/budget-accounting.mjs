// @ts-check

/**
 * @file The token-budget enforcement kernel — pure functions, no state.
 * @version 0.12.0
 *
 * @description
 * Every engine (agentic loop, discussion group, state machine, wave executor)
 * computes "what may the next turn spend" and "has the cap been passed" from a
 * cap, a spend and an emit hook. The rules are one kernel so the two boundaries
 * (`>=` before a turn, `>` after a charge) cannot drift between engines; the
 * engine keeps only its own emitter and message prefix.
 */

import { BudgetExceededError } from '../core/errors.mjs';

/** @typedef {{prompt_tokens: number, completion_tokens: number, total_tokens: number}} BudgetUsage */
/** @typedef {{maxTotalTokens?: number, maxBudgetUsd?: number}} TokenBudget */
/**
 * A budget as a caller hands it in: the caps are validated at runtime, so a bad
 * value is accepted here and ignored by the kernel instead of rejected by the
 * type. The kernel returns a `TokenBudget` once a cap is usable.
 * @typedef {{maxTotalTokens?: unknown, maxBudgetUsd?: unknown}} BudgetCandidate
 */

/**
 * Reports the overrun to the engine's emitter, then throws the typed error.
 * `comparator` is the boundary that tripped: `>=` before a turn spends, `>`
 * after a charge (an exactly-spent cap is allowed to run one more time in the
 * accounting path but not in the pre-turn path).
 * @param {{spent: number, max: number, emit?: ((arg0: {usage: BudgetUsage, maxTotalTokens: number}) => void)|null, comparator: string}} arg0
 * @returns {never}
 */
function stopAtBudget({ spent, max, emit, comparator }) {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: spent };
    emit?.({ usage, maxTotalTokens: max });
    throw new BudgetExceededError({
        message: `Token budget exceeded: ${spent} ${comparator} ${max}.`,
        options: { maxTotalTokens: max, usage },
    });
}

/**
 * The money half of the same kernel (B-2). A USD cap is only enforceable when
 * the backend reported a cost, so an unreported spend is `0` here and the
 * first call past the cap stops the next one — one-call overshoot, like tokens.
 * @param {{spentUsd: number, maxUsd: number, emit?: ((arg0: {usage: BudgetUsage, maxBudgetUsd: number}) => void)|null, comparator: string}} arg0
 * @returns {never}
 */
function stopAtBudgetUsd({ spentUsd, maxUsd, emit, comparator }) {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: spentUsd };
    emit?.({ usage, maxBudgetUsd: maxUsd });
    throw new BudgetExceededError({
        message: `USD budget exceeded: $${spentUsd} ${comparator} $${maxUsd}.`,
        options: { maxBudgetUsd: maxUsd, usage },
    });
}

/**
 * The budget the next turn may spend: the cap minus what is already spent.
 * An invalid/unset cap returns the budget unchanged (no enforcement); an
 * exhausted cap emits and throws. `divisor` splits the remainder across a wave
 * of parallel turns, never below `floor`.
 *
 * Both caps are decremented (B-2): `spentUsd` is the money the engine already
 * summed from `outcome.usage.cost_usd`, so a USD-only budget shrinks from node
 * to node instead of handing every node the whole cap.
 * @param {{budget?: BudgetCandidate|null, spent: number, spentUsd?: number, emit?: ((arg0: {usage: BudgetUsage, maxTotalTokens?: number, maxBudgetUsd?: number}) => void)|null, divisor?: number, floor?: number, round?: boolean}} arg0
 * @returns {TokenBudget|null}
 */
export function remainingBudget({ budget, spent, spentUsd = 0, emit, divisor = 1, floor = 0, round = false }) {
    const max = Number(budget?.maxTotalTokens);
    const maxUsd = Number(budget?.maxBudgetUsd);
    const hasTokens = Number.isFinite(max) && max > 0;
    const hasUsd = Number.isFinite(maxUsd) && maxUsd > 0;
    if (!hasTokens && !hasUsd) return /** @type {TokenBudget|null} */ (budget);
    const next = /** @type {TokenBudget} */ ({ ...budget });
    if (hasTokens) {
        if (spent >= max) stopAtBudget({ spent, max, emit, comparator: '>=' });
        const raw = divisor > 1 ? (max - spent) / divisor : (max - spent);
        next.maxTotalTokens = Math.max(floor, round ? Math.floor(raw) : raw);
    }
    if (hasUsd) {
        const paid = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
        if (paid >= maxUsd) stopAtBudgetUsd({ spentUsd: paid, maxUsd, emit, comparator: '>=' });
        const rawUsd = divisor > 1 ? (maxUsd - paid) / divisor : (maxUsd - paid);
        next.maxBudgetUsd = Math.max(0, round ? Math.floor(rawUsd * 1e6) / 1e6 : rawUsd);
    }
    return next;
}

/**
 * Fails closed after a charge: a spend that passed the cap emits and throws.
 * An equal spend does not throw, and an invalid/unset cap is a no-op. Does not
 * mutate `spent`.
 * @param {{budget?: BudgetCandidate|null, spent: number, spentUsd?: number, emit?: ((arg0: {usage: BudgetUsage, maxTotalTokens?: number, maxBudgetUsd?: number}) => void)|null}} arg0
 * @returns {void}
 */
export function assertBudgetOverspent({ budget, spent, spentUsd = 0, emit }) {
    const max = Number(budget?.maxTotalTokens);
    if (Number.isFinite(max) && max > 0 && spent > max) stopAtBudget({ spent, max, emit, comparator: '>' });
    const maxUsd = Number(budget?.maxBudgetUsd);
    if (Number.isFinite(maxUsd) && maxUsd > 0 && spentUsd > maxUsd) {
        stopAtBudgetUsd({ spentUsd, maxUsd, emit, comparator: '>' });
    }
}

/**
 * Adds every finite numeric field of a usage record onto an accumulator.
 * A new object is returned unless `into` is passed. Non-numeric fields (a
 * boolean flag, a string id) are skipped, not coerced.
 * @param {{usage?: Object, into?: Record<string, number>}} arg0
 * @returns {Record<string, number>}
 */
export function sumNumericUsage({ usage, into = {} }) {
    for (const [key, value] of Object.entries(usage ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value)) into[key] = (typeof into[key] === 'number' ? into[key] : 0) + value;
    }
    return into;
}
