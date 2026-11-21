// @ts-check


/**
 * @file A client view that attaches a scheduler attempt's ledger to the sessions
 * an engine creates.
 * @version 0.12.0
 *
 * @description
 * The runner measures one attempt by giving the engine a view of its client:
 * `session`/`sessionWithId` return the backend's own session with the ledger
 * attached. The view keeps the base client's identity-keyed state (roster,
 * circuit breakers) through `CLIENT_VIEW_BASE`, so wrapping never isolates an
 * engine from its registry.
 *
 * A session that already carries this attempt's ledger keeps it. A session that
 * arrives with a budget keeps its own capped pool and links it to the ledger as
 * a child, so its cap still binds its subtree while its spend is reported to the
 * attempt; a sequentially reused one is re-linked to the current ledger, while a
 * live foreign parent is refused. A session carrying ANOTHER attempt's ledger is
 * refused too, unless that ledger was released: one session object per live
 * attempt. Attached sessions are recorded on the ledger itself (not a WeakSet,
 * which cannot be iterated) so the attempt's `finally` can detach a memoized
 * session before the next attempt attaches a fresh ledger.
 */

import { ConfigurationError } from '../core/errors.mjs';
import { ATTEMPT_LEDGER, ATTEMPT_LEDGER_RELEASED, ensureBudgetPool, ensurePoolLists, getPoolParent, markPoolReleased, setPoolParent } from './budget-pool.mjs';
import { CLIENT_VIEW_BASE } from '../support/utils.mjs';

/**
 * @typedef {Object} PooledSession
 * @property {Object|null} [client]
 * @property {Object|null} [_budget]
 * @property {Object|null} [_budgetPool]
 */

/** @returns {ConfigurationError} */
function reusedAcrossAttempts() {
    return new ConfigurationError({
        message: 'One session per attempt: this session already belongs to another attempt ledger. A client that memoizes a session cannot be used for concurrent attempts.',
        options: { option: 'session_reused_across_attempts' }
    });
}

/**
 * Joins `session` to `pool` (an attempt ledger or a session's owner pool).
 * `share: true` is the one-tree-pool contract (task children): the session joins
 * the target by reference, unless `ownBudget` marks a budget that is its own.
 * @param {{session: PooledSession, pool: Object, share?: boolean, ownBudget?: boolean}} arg0 -
 * @returns {PooledSession}
 */
export function attachSessionPool({ session, pool, share = false, ownBudget = false }) {
    if (!session || typeof session !== 'object' || !pool) return session;
    const ledger = /** @type {any} */ (pool);
    // A ledger the runner already released is absent, not stale: attaching would
    // charge a report nobody reads.
    if (ledger[ATTEMPT_LEDGER_RELEASED]) return session;
    const existing = /** @type {any} */ (session)._budgetPool;
    if (existing === ledger && !(share && ownBudget && session._budget)) return session;
    if (existing?.[ATTEMPT_LEDGER]) {
        // A live foreign attempt is refused; a closed one is host-assigned stale
        // state, which the SDK itself never leaves on a session.
        if (!existing[ATTEMPT_LEDGER_RELEASED]) throw reusedAcrossAttempts();
        delete /** @type {PooledSession} */ (session)._budgetPool;
    } else if (existing) {
        const parent = getPoolParent({ pool: existing });
        if (share) {
            // A task child already reporting to another live attempt must not switch.
            const foreign = /** @type {any} */ (parent);
            if (foreign && foreign !== ledger && foreign[ATTEMPT_LEDGER] && !foreign[ATTEMPT_LEDGER_RELEASED]) throw reusedAcrossAttempts();
        } else {
            // A reused budgeted session reports to this attempt; a live foreign one is refused.
            if (parent === ledger) return session;
            if (parent !== null) throw reusedAcrossAttempts();
            ensureBudgetPool({ session, parent: ledger });
            return session;
        }
    }
    if (share && ownBudget && session._budget) {
        // A fresh capped ledger per spawn: a memoized child cannot accumulate
        // across attempts, and its subtree is bounded by its own budget.
        delete /** @type {PooledSession} */ (session)._budgetPool;
        if (ensureBudgetPool({ session, parent: ledger })) return session;
    }
    if (!share && session._budget) {
        // A budgeted session keeps its cap; the target ledger is its parent.
        ensureBudgetPool({ session, parent: ledger });
        return session;
    }
    // The one-tree-pool contract (a task child) joins the target by reference.
    session._budgetPool = ledger;
    const attached = /** @type {Array<Object>} */ (ensurePoolLists({ pool: ledger }).attached);
    if (!attached.includes(session)) attached.push(session);
    return session;
}

/**
 * A client view whose sessions join the attempt ledger.
 * @param {{client: {session: Function, sessionWithId?: Function}, pool: Object}} arg0 -
 * @returns {Object}
 */
export function pooledClient({ client, pool }) {
    const ledger = /** @type {import('./budget-pool.mjs').BudgetPool} */ (pool);
    /** @param {PooledSession} session @returns {PooledSession} */
    const attach = (session) => attachSessionPool({ session, pool: ledger });
    const pooled = /** @type {any} */ (Object.create(client));
    pooled[CLIENT_VIEW_BASE] = client;
    pooled.session = (/** @type {string} */ model) => attach(/** @type {any} */ (client.session(model)));
    const withId = /** @type {any} */ (client).sessionWithId;
    if (typeof withId === 'function') {
        pooled.sessionWithId = (/** @type {any} */ args) => attach(/** @type {any} */ (withId.call(client, args)));
    }
    return pooled;
}

/**
 * Detaches this attempt's ledger from the sessions it attached and clears the
 * parent links of the owner ledgers it borrowed the report from. A session that
 * has since gained another ledger is left alone; a child ledger keeps its usage
 * so a later `getBudgetPool` read stays truthful. The ledger is marked closed so
 * a view a host kept cannot attach it to a session after the attempt.
 * @param {{pool: import('./budget-pool.mjs').BudgetPool}} arg0 -
 * @returns {void}
 */
export function releaseAttemptLedger({ pool }) {
    markPoolReleased({ pool });
    const attached = Array.isArray(pool.attached) ? pool.attached : [];
    for (const session of attached) {
        if (/** @type {PooledSession} */ (session)._budgetPool === pool) {
            delete /** @type {PooledSession} */ (session)._budgetPool;
        }
    }
    const children = Array.isArray(pool.children) ? pool.children : [];
    for (const child of children) {
        // Only unlink a child this ledger still owns; a re-attached one belongs elsewhere.
        if (getPoolParent({ pool: child }) === pool) setPoolParent({ pool: child, parent: null });
    }
    pool.attached = [];
    pool.children = [];
}
