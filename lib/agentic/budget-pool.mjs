// @ts-check

/**
 * The shared budget pool (wave 6 / SP4, D12) — one cap for the whole spawn tree.
 *
 * Before this module every child inherited a **copy** of the parent's budget
 * (`profile.budget ?? session._budget`), so N children meant N × the cap (E2):
 * a parent allowed 100 000 tokens could spend 100 000 in each of ten children.
 *
 * The pool is one object shared **by reference** across a tree. It holds the cap
 * (`maxTotalTokens` / `maxBudgetUsd`) and the tree ledger (`usage`), which every
 * session in the tree charges as it spends. Enforcement reads the pool, so the
 * cap binds the tree rather than each session.
 *
 * The pool belongs to the session that created it (the tree root): only the owner
 * may move a cap. A child may tighten its OWN cap (a local budget), but it can
 * neither widen nor narrow the tree's — a sibling's allowance must not depend on
 * how another child was configured.
 *
 * A pool may have a parent (a wider session pool or an attempt ledger): each
 * charge is reported to every ancestor once, so a budgeted subtree's spend
 * reaches the scheduler's attempt total while its own cap still binds it.
 *
 * A session without a budget has no pool and keeps the old behaviour: no
 * accounting, no cap, no estimates.
 */

import { ConfigurationError } from '../core/errors.mjs';

/**
 * @typedef {Object} PoolUsage
 * @property {number} prompt_tokens
 * @property {number} completion_tokens
 * @property {number} total_tokens
 * @property {number} cache_creation_input_tokens
 * @property {number} cache_read_input_tokens
 * @property {number|null} cost_usd
 * @property {number} cost_unreported_calls - Calls that reported tokens but no cost; the sum is a lower bound while this is > 0.
 * @property {number} estimated_tokens
 * @property {boolean} [estimated] - Derived when read (`estimated_tokens > 0`).
 */

/**
 * @typedef {Object} BudgetPool
 * @property {Object} owner - The session that created (and may re-cap) the tree (it carries its own budget fields).
 * @property {number|null} maxTotalTokens
 * @property {number|null} maxBudgetUsd
 * @property {PoolUsage} usage
 * @property {Array<Object>} attached - Sessions whose `_budgetPool` is this ledger, so a release can detach them.
 * @property {Array<BudgetPool>} children - Owner ledgers that report here; a release clears their parent link.
 * @property {number} [reservedTokens] - Tokens an in-flight call may still spend (B-3); not part of `usage`.
 * @property {Map<string, number>} [reservedBy] - The same reservation split by run id, so a descendant can ignore capacity its own ancestor is holding (waiting on it could only deadlock).
 * @property {number} [reservedCallers] - Calls in flight on this ledger (B-3 fairness); moves with `reservedTokens`.
 */

/**
 * The vendor usage a model call reports (all fields optional: a silent backend
 * reports nothing).
 * @typedef {Object} PoolUsageInput
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [cost_usd]
 */

/**
 * @param {{value: unknown}} arg0
 * @returns {number|null}
 */
function positiveOrNull({ value }) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * @param {{budget: Object|null|undefined}} arg0
 * @returns {{maxTotalTokens: number|null, maxBudgetUsd: number|null}}
 */
function capsOf({ budget }) {
    const b = /** @type {{maxTotalTokens?: unknown, maxBudgetUsd?: unknown}|null|undefined} */ (budget);
    return {
        maxTotalTokens: positiveOrNull({ value: b?.maxTotalTokens }),
        maxBudgetUsd: positiveOrNull({ value: b?.maxBudgetUsd }),
    };
}

/**
 * @returns {PoolUsage}
 */
function emptyUsage() {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cost_usd: null,
        cost_unreported_calls: 0,
        estimated_tokens: 0,
    };
}

/**
 * Parent links live outside the pool: a ledger must not serialize a cycle.
 * @type {WeakMap<BudgetPool, BudgetPool>}
 */
const parentOf = new WeakMap();

/**
 * The pool's parent (a wider session pool or an attempt ledger), if any.
 * @param {{pool: BudgetPool|null|undefined}} arg0
 * @returns {BudgetPool|null}
 */
export function getPoolParent({ pool }) {
    return pool ? parentOf.get(pool) ?? null : null;
}

/**
 * Re-parents a pool. `parent: null` clears the link when an attempt releases.
 * @param {{pool: BudgetPool|null|undefined, parent: BudgetPool|null}} arg0
 * @returns {void}
 */
export function setPoolParent({ pool, parent }) {
    if (!pool) return;
    if (parent === pool) {
        throw new ConfigurationError({
            message: 'A budget ledger cannot be its own parent.',
            options: { option: 'invalid_pool_parent' }
        });
    }
    if (parent) parentOf.set(pool, parent);
    else parentOf.delete(pool);
}

/**
 * The ledger-owned list, created lazily because a host may pass a plain ledger
 * and non-enumerable because `attached` holds sessions that point back here.
 * @param {{pool: BudgetPool, key: 'attached'|'children'}} arg0
 * @returns {Array<any>}
 */
function ledgerList({ pool, key }) {
    const current = /** @type {any} */ (pool)[key];
    if (Array.isArray(current)) return current;
    /** @type {Array<any>} */
    const list = [];
    Object.defineProperty(pool, key, { value: list, writable: true });
    return list;
}

/**
 * The two ledger-owned lists on a pool, kept out of JSON and created lazily so
 * a host-shaped ledger (a plain object) works too.
 * @param {{pool: BudgetPool}} arg0
 * @returns {BudgetPool}
 */
export function ensurePoolLists({ pool }) {
    ledgerList({ pool, key: 'attached' });
    ledgerList({ pool, key: 'children' });
    return pool;
}

/**
 * Links a pool to an unparented parent once; idempotent so a re-attach is safe.
 * @param {{pool: BudgetPool, parent: BudgetPool}} arg0
 * @returns {void}
 */
function linkPool({ pool, parent }) {
    if (getPoolParent({ pool }) === parent) return;
    setPoolParent({ pool, parent });
    const children = ledgerList({ pool: parent, key: 'children' });
    if (!children.includes(pool)) children.push(pool);
}

/**
 * The pool of a session, created on first use when the session has a budget.
 * Idempotent: a session in a tree already has one and gets the same object back.
 * `parent` links an owner ledger (new or created earlier) into a wider ledger.
 * @param {{session: Object|null|undefined, parent?: BudgetPool|null}} arg0
 * @returns {BudgetPool|null}
 */
export function ensureBudgetPool({ session, parent = null }) {
    if (!session || typeof session !== 'object') return null;
    const existing = /** @type {any} */ (session)._budgetPool;
    if (existing) {
        // A ledger created before the attempt (or by an earlier one) joins now.
        if (parent && getPoolParent({ pool: existing }) === null) linkPool({ pool: existing, parent });
        return existing;
    }
    const budget = /** @type {any} */ (session)._budget ?? null;
    if (!budget) return null;
    /** @type {BudgetPool} */
    const pool = ensurePoolLists({
        pool: /** @type {BudgetPool} */ ({
            owner: session,
            ...capsOf({ budget }),
            usage: emptyUsage(),
            reservedBy: new Map(),
        })
    });
    if (parent) linkPool({ pool, parent });
    /** @type {any} */ (session)._budgetPool = pool;
    return pool;
}

/** The sentinel owner of an attempt ledger: no session may move its caps. */
const ATTEMPT_POOL_OWNER = Object.freeze({});

/** Marks a ledger as an attempt ledger (a session pool is not one). */
export const ATTEMPT_LEDGER = Symbol('merci.attemptLedger');

/** Marks an attempt ledger the runner has released (a stale view must not re-attach it). */
export const ATTEMPT_LEDGER_RELEASED = Symbol('merci.attemptLedgerReleased');

/**
 * Closes an attempt ledger. A client view a host kept can outlive `run()`, and
 * re-attaching a closed ledger would charge a report nobody reads and block the
 * next attempt with `session_reused_across_attempts`.
 * @param {{pool: BudgetPool|null|undefined}} arg0
 * @returns {void}
 */
export function markPoolReleased({ pool }) {
    if (pool) Object.defineProperty(pool, ATTEMPT_LEDGER_RELEASED, { value: true, configurable: true });
}

/**
 * A cap-less ledger for one scheduler attempt. The runner owns it, every session
 * in the attempt charges it, and its caps stay null: a cap here would be a second
 * enforcement gate inside the engines.
 * @returns {BudgetPool}
 */
export function createBudgetPool() {
    const pool = ensurePoolLists({
        pool: /** @type {BudgetPool} */ ({
            owner: ATTEMPT_POOL_OWNER,
            maxTotalTokens: null,
            maxBudgetUsd: null,
            usage: emptyUsage(),
            reservedBy: new Map(),
        })
    });
    Object.defineProperty(pool, ATTEMPT_LEDGER, { value: true });
    return pool;
}

/**
 * Mirrors the owner's budget onto the pool after `withBudget`. A child is not the
 * owner, so its budget never moves the tree's cap.
 * @param {{session: Object|null|undefined}} arg0
 * @returns {void}
 */
export function syncBudgetPoolCaps({ session }) {
    const pool = /** @type {any} */ (session)?._budgetPool;
    if (!pool || pool.owner !== session) return;
    const caps = capsOf({ budget: /** @type {any} */ (session)._budget ?? null });
    pool.maxTotalTokens = caps.maxTotalTokens;
    pool.maxBudgetUsd = caps.maxBudgetUsd;
}

/**
 * Charges one model call to the tree and to every ancestor. An unreported usage
 * is charged as an estimate (the same rule the per-run budget uses), so a silent
 * backend cannot make the tree's spend invisible.
 * @param {{pool: BudgetPool|null, usage?: PoolUsageInput|null, estTokens?: number}} arg0
 * @returns {void}
 */
export function absorbPoolUsage({ pool, usage = null, estTokens = 0 }) {
    if (!pool) return;
    const prompt = usage?.prompt_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    const reported = prompt + completion;
    const estimated = reported === 0 ? Math.max(0, estTokens) : 0;
    const cost = typeof usage?.cost_usd === 'number' && Number.isFinite(usage.cost_usd) ? usage.cost_usd : null;
    /** @param {BudgetPool} target */
    const charge = (target) => {
        target.usage.prompt_tokens += prompt;
        target.usage.completion_tokens += completion;
        target.usage.cache_creation_input_tokens += usage?.cache_creation_input_tokens ?? 0;
        target.usage.cache_read_input_tokens += usage?.cache_read_input_tokens ?? 0;
        target.usage.total_tokens += reported + estimated;
        target.usage.estimated_tokens += estimated;
        if (cost !== null) target.usage.cost_usd = (target.usage.cost_usd ?? 0) + cost;
        // B-9: a priced subset is a lower bound, not a total. Count the calls
        // that spent tokens without a price so a reader can tell the two apart.
        // (A host-shaped ledger may lack the field.)
        if (cost === null && reported + estimated > 0) target.usage.cost_unreported_calls = (target.usage.cost_unreported_calls ?? 0) + 1;
    };
    charge(pool);
    // A budgeted subtree reports upward; `visited` keeps a cyclic chain to one pass.
    const visited = new Set([pool]);
    let ancestor = getPoolParent({ pool });
    while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        charge(ancestor);
        ancestor = getPoolParent({ pool: ancestor });
    }
}

/**
 * The pool's usage in the shape the budget events and errors carry.
 * @param {{pool: BudgetPool}} arg0
 * @returns {PoolUsage & {estimated?: boolean}}
 */
export function poolUsageSnapshot({ pool }) {
    const usage = pool.usage;
    return {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cost_usd: usage.cost_usd ?? null,
        cost_unreported_calls: usage.cost_unreported_calls ?? 0,
        estimated_tokens: usage.estimated_tokens,
        ...(usage.estimated_tokens > 0 ? { estimated: true } : {}),
    };
}

/**
 * A frozen read-only view of a ledger for host hooks: caps are live getters,
 * usage is a frozen copy per read, and the live ledger is never exposed.
 * @param {{pool: BudgetPool|null|undefined}} arg0 -
 * @returns {Object|null}
 */
export function attemptPoolView({ pool }) {
    if (!pool) return null;
    return Object.freeze({
        get maxTotalTokens() { return pool.maxTotalTokens; },
        get maxBudgetUsd() { return pool.maxBudgetUsd; },
        get usage() { return Object.freeze({ ...pool.usage }); }
    });
}

/**
 * The public read API: the tree's cap and spend, or null when the session has no
 * budget. A copy — the enforcement state is not exposed for mutation. Reading a
 * budgeted session that has not run yet creates its (empty) pool; after the owner
 * clears its budget the pool stays as a truthful ledger with `maxTotalTokens:null`.
 * @param {{session: Object|null|undefined}} arg0
 * @returns {{maxTotalTokens: number|null, maxBudgetUsd: number|null, usage: PoolUsage, shared: boolean}|null}
 */
export function getBudgetPool({ session }) {
    const pool = ensureBudgetPool({ session });
    if (!pool) return null;
    return {
        maxTotalTokens: pool.maxTotalTokens,
        maxBudgetUsd: pool.maxBudgetUsd,
        usage: {
            ...pool.usage,
            ...(pool.usage.estimated_tokens > 0 ? { estimated: true } : {}),
        },
        shared: pool.owner !== session,
    };
}
