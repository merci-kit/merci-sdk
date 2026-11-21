// @ts-check
/**
 * @file Shared session-policy carrier.
 * @version 0.12.0
 *
 * @description
 * The policy surfaces that must follow a conversation wherever it is executed:
 * permissions, guardrails, hooks, context processors, tool timeout, compaction,
 * retry/stream/header/elapsed policies, approval and budget. Every engine and
 * every subagent used to hand-copy a subset of these fields; a new policy was
 * silently not inherited. One capture/apply pair makes the copy explicit and
 * testable.
 */
import { normalizePermissionRules } from './permissions.mjs';
import { syncBudgetPoolCaps } from './budget-pool.mjs';

/**
 * @typedef {Object} SessionPolicy
 * @property {import('./permissions.mjs').PermissionRules|null} permissions
 * @property {string[][]|null} toolAllowlists
 * @property {Object|null} guardrails - The host's guardrail set.
 * @property {import('../core/hooks.mjs').HookRegistry|null} hooks
 * @property {Array<Object>} contextProcessors - `{name, order, process}` rows the session applies in order.
 * @property {number|null} toolTimeoutMs
 * @property {Object|null} compaction - Compaction options (`{}` when enabled bare).
 * @property {import('./chat-session.mjs').RetryPolicyLike|null} retryPolicy
 * @property {import('./chat-session.mjs').StreamTimeoutPolicyLike|null} streamTimeoutPolicy
 * @property {number|null} headerTimeoutMs
 * @property {number|null} maxElapsedMs
 * @property {Object|null} approvalPolicy - The approval callback or `{callback, timeoutMs}` row.
 * @property {Object|null} budget - The token/USD budget knobs.
 * @property {Object|null} [promptCache] - The host's cache policy (SP6: a role template is
 *   only cacheable if the child inherits it).
 * @property {import('./task.mjs').TaskSessionStore|null} [sessionStore] - The host's opt-in checkpoint store (D10). The
 *   child gets its OWN thread id; the parent's is never carried.
 */

/**
 * The policy fields a live session exposes (the `_`-prefixed mirror of
 * `SessionPolicy`). A session-like stub may carry any subset.
 * @typedef {Object} SessionPolicySource
 * @property {import('./permissions.mjs').PermissionRules|null} [_permissionRules]
 * @property {Array<Array<string>>|null} [_toolAllowlists]
 * @property {Object|null} [_guardrails]
 * @property {import('../core/hooks.mjs').HookRegistry|null} [_hooks]
 * @property {Array<Object>} [_contextProcessors]
 * @property {number|null} [_toolTimeoutMs]
 * @property {Object|null} [_compaction]
 * @property {import('./chat-session.mjs').RetryPolicyLike|null} [_retryPolicy]
 * @property {import('./chat-session.mjs').StreamTimeoutPolicyLike|null} [_streamTimeoutPolicy]
 * @property {number|null} [_headerTimeoutMs]
 * @property {number|null} [_maxElapsedMs]
 * @property {Object|null} [_approvalPolicy]
 * @property {Object|null} [_budget]
 * @property {Object|null} [_promptCache]
 * @property {import('./task.mjs').TaskSessionStore|null} [_sessionStore]
 * @property {string|null} [_explicitSessionId] - The id `createSession` asked for, when the client honoured it.
 * @property {{sessionId?: string, runId?: string}|null} [_sessionRunCtx]
 * @property {Function} [withSystemMessage]
 * @property {Function} [withParameters]
 * @property {Function} [withTools]
 * @property {Function} [withToolAllowlist]
 * @property {Function} [withApproval]
 * @property {Function} [withBudget]
 * @property {Function} [run]
 */

/**
 * Captures the policy fields of a live session (or a session-like object).
 * @param {{session?: unknown}} arg0
 * @returns {SessionPolicy|null}
 */
export function captureSessionPolicy({ session } = {}) {
    if (!session || typeof session !== 'object') return null;
    const live = /** @type {SessionPolicySource} */ (session);
    return {
        permissions: live._permissionRules
            ? normalizePermissionRules({ rules: live._permissionRules })
            : null,
        toolAllowlists: Array.isArray(live._toolAllowlists) ? live._toolAllowlists.map((/** @type {string[]} */ layer) => [...layer]) : null,
        guardrails: live._guardrails ?? null,
        hooks: live._hooks ?? null,
        contextProcessors: Array.isArray(live._contextProcessors) ? [...live._contextProcessors] : [],
        toolTimeoutMs: live._toolTimeoutMs ?? null,
        compaction: live._compaction ?? null,
        retryPolicy: live._retryPolicy ?? null,
        streamTimeoutPolicy: live._streamTimeoutPolicy ?? null,
        headerTimeoutMs: live._headerTimeoutMs ?? null,
        maxElapsedMs: live._maxElapsedMs ?? null,
        approvalPolicy: live._approvalPolicy ?? null,
        budget: live._budget ?? null,
        // SP6: a role template only stays cacheable if the child keeps the
        // parent's caching policy.
        promptCache: live._promptCache ?? null,
        // D10: persistence is opt-in. The store travels; the thread id must NOT
        // (a child that reused it would overwrite the parent's conversation).
        sessionStore: live._sessionStore ?? null,
    };
}

/**
 * Applies a captured policy to a session (a fresh child or engine session).
 * A null/undefined policy is a no-op. Fields the policy does not carry are
 * left untouched, so a child's own capability settings survive.
 * @template {Object} T
 * @param {{session: T, policy?: SessionPolicy|null}} arg0
 * @returns {T}
 */
export function applySessionPolicy({ session, policy = null }) {
    if (!session || !policy) return session;
    const target = /** @type {SessionPolicySource} */ (/** @type {unknown} */ (session));
    if (policy.permissions) target._permissionRules = normalizePermissionRules({ rules: policy.permissions });
    if (Array.isArray(policy.toolAllowlists)) target._toolAllowlists = policy.toolAllowlists.map((layer) => [...layer]);
    if (policy.guardrails) target._guardrails = policy.guardrails;
    if (policy.hooks) target._hooks = policy.hooks;
    if (Array.isArray(policy.contextProcessors) && policy.contextProcessors.length > 0) {
        target._contextProcessors = [...policy.contextProcessors];
    }
    if (policy.toolTimeoutMs != null) target._toolTimeoutMs = policy.toolTimeoutMs;
    if (policy.compaction) target._compaction = policy.compaction;
    if (policy.retryPolicy) target._retryPolicy = policy.retryPolicy;
    if (policy.streamTimeoutPolicy) target._streamTimeoutPolicy = policy.streamTimeoutPolicy;
    if (policy.headerTimeoutMs != null) target._headerTimeoutMs = policy.headerTimeoutMs;
    if (policy.maxElapsedMs != null) target._maxElapsedMs = policy.maxElapsedMs;
    if (policy.approvalPolicy) target._approvalPolicy = policy.approvalPolicy;
    if (policy.budget) {
        target._budget = policy.budget;
        // An eager child ledger must not keep stale caps (the owner gate skips borrowed ledgers).
        syncBudgetPoolCaps({ session: target });
    }
    if (policy.promptCache) target._promptCache = policy.promptCache;
    if (policy.sessionStore) target._sessionStore = policy.sessionStore;
    return session;
}

/**
 * The client `createSession` drives: one session factory, plus the id-aware one
 * when the backend has it.
 * @typedef {Object} SessionClientLike
 * @property {(model?: string) => Object} session
 * @property {(arg0: {model?: string, sessionId: string}) => Object} [sessionWithId]
 */

/**
 * Builds a session with an explicit conversation id when the client supports
 * `sessionWithId`. A plain `session(model)` cannot emit the right
 * `session:start` (it constructs and announces before the id is known), so
 * every internal factory must prefer this path.
 * The returned session is the backend's own object: the four backends share no
 * base type, and each caller passes it straight into a builder or a policy
 * applier, so this is the one deliberate open return in the file.
 * @param {{client: SessionClientLike, model?: string, sessionId?: string|null}} arg0
 * @returns {Object} The backend's own session object — callers name the surface they need.
 */
export function createSession({ client, model, sessionId = null }) {
    if (sessionId && typeof client?.sessionWithId === 'function') {
        return client.sessionWithId({ model, sessionId });
    }
    return client.session(model);
}

/**
 * Fallback for clients that only expose `session(model)`: keep the session
 * fields consistent after construction. The initial `session:start` for such
 * a stub is already emitted with the auto id; real backends implement
 * `sessionWithId`.
 * @template {Object} T
 * @param {{session: T, sessionId?: string|null}} arg0
 * @returns {T}
 */
export function adoptSessionId({ session, sessionId = null }) {
    if (!session || !sessionId) return session;
    const target = /** @type {SessionPolicySource} */ (/** @type {unknown} */ (session));
    if (target._explicitSessionId == null) {
        target._explicitSessionId = sessionId;
        if (target._sessionRunCtx) target._sessionRunCtx.sessionId = sessionId;
    }
    return session;
}
