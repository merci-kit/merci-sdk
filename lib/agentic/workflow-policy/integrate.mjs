// @ts-check


/**
 * @file Integration helpers: a workflow policy to scheduler/workspace options,
 * and the prompt renderer the engine runner calls per attempt.
 * @version 0.12.0
 *
 * @description
 * These are plain mappings over the resolved config, plus one callback. They
 * deliberately import neither the scheduler nor the workspace module: the
 * scheduler receives a plain object (its `applyConfig` replaces known
 * sub-objects wholesale, so `retry`/`continuation` are always full pairs and an
 * unset limit is omitted), and the workspace manager receives the
 * construction-bound shape. The host owns the real instances.
 *
 * `preflight` is a closure, not a snapshot: the mapping is built once and every
 * call returns the policy health at that moment, so an unhealthy reload blocks
 * new work without rebuilding the options. The closure is memoized **per policy
 * instance**, so two mappings of the same policy compare equal: a reload that
 * changed only the prompt is not reported as a scheduler reconfiguration, and
 * `applyConfig` returns `applied: false` for it.
 *
 * The renderer maps a scheduler `WorkItem` to the Symphony-compatible issue
 * view (both naming styles, so an author's prompt works unchanged) and maps the
 * scheduler's 1-based attempt to the contract's retry index. A render error is
 * item-local: it emits `workflow_policy:render_failed` and rethrows, and the
 * scheduler classifies the policy error as non-retryable.
 */
import { PolicyError } from '../../core/errors.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { renderFailure } from './template.mjs';

/**
 * The policy surface these helpers need. `WorkflowPolicy` satisfies it; a test
 * or a host may supply its own.
 * @typedef {Object} PolicyLike
 * @property {() => import('./config.mjs').ResolvedWorkflowConfig|null} getConfig
 * @property {() => string[]} preflight
 * @property {(arg0: {issue: Record<string, unknown>, attempt: unknown}) => string} renderPrompt
 */

/**
 * @typedef {Object} SchedulerOptions
 * @property {string[]} [activeStates]
 * @property {string[]} [terminalStates]
 * @property {string[]} requiredLabels
 * @property {number} pollIntervalMs
 * @property {number} stallTimeoutMs
 * @property {{global: number, byLane?: Record<string, number>}} concurrency
 * @property {{baseMs: number, maxMs: number}} retry
 * @property {{delayMs: number, max: number}} continuation
 * @property {{maxAttemptsPerItem: number, maxDispatches?: number, maxTotalTokens?: number, maxTotalUsd?: number}} limits
 * @property {() => string[]} preflight
 */

/**
 * @typedef {Object} WorkspaceOptions
 * @property {string} root
 * @property {'directory'|'git-worktree'} strategy
 * @property {string} [repoRoot]
 * @property {string} baseRef
 * @property {string} branchPrefix
 * @property {{afterCreate: string|null, beforeRun: string|null, afterRun: string|null, beforeRemove: string|null, timeoutMs: number}} hooks
 */

/**
 * @param {{value: unknown}} arg0
 * @returns {string|null}
 */
function readString({ value }) {
    return typeof value === 'string' ? value : null;
}

/**
 * Epoch milliseconds to an ISO 8601 string; anything else is null.
 * @param {{value: unknown}} arg0
 * @returns {string|null}
 */
function toIsoString({ value }) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `blockedBy` becomes strings: a reference identifier, else its id, else its
 * state. A null entry is skipped and a blank result is dropped.
 * @param {{value: unknown}} arg0
 * @returns {string[]}
 */
function toBlockedBy({ value }) {
    if (!Array.isArray(value)) return [];
    /** @type {string[]} */
    const blocked = [];
    for (const entry of value) {
        if (entry === null || entry === undefined) continue;
        const ref = /** @type {{identifier?: unknown, id?: unknown, state?: unknown}} */ (entry);
        const candidate = ref.identifier ?? ref.id ?? ref.state ?? '';
        if (typeof candidate === 'string' && candidate !== '') blocked.push(candidate);
    }
    return blocked;
}

/**
 * The two metadata aliases a Symphony prompt may read, both accepted from the
 * file's snake_case or the SDK's camelCase.
 * @param {{metadata: unknown}} arg0
 * @returns {{branchName: string|null, assigneeId: string|null}}
 */
function metadataFields({ metadata }) {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { branchName: null, assigneeId: null };
    }
    const record = /** @type {Record<string, unknown>} */ (metadata);
    return {
        branchName: readString({ value: record.branch_name ?? record.branchName }),
        assigneeId: readString({ value: record.assignee_id ?? record.assigneeId })
    };
}

/**
 * The §3.9 table: scheduler `WorkItem` → Symphony-compatible `issue`, with both
 * naming styles. Exactly these keys; no others.
 * @param {{item: Record<string, unknown>}} arg0
 * @returns {Record<string, unknown>}
 */
function toIssueView({ item }) {
    const blocked = toBlockedBy({ value: item.blockedBy });
    const metadata = item.metadata ?? null;
    const { branchName, assigneeId } = metadataFields({ metadata });
    const nativeRef = item.nativeRef ?? null;
    return {
        id: item.id,
        identifier: item.identifier,
        title: item.title,
        state: item.state,
        url: item.url,
        lane: item.lane,
        dispatchable: item.dispatchable,
        description: item.description ?? null,
        priority: item.priority ?? null,
        labels: Array.isArray(item.labels) ? [...item.labels] : [],
        blocked_by: [...blocked],
        blockedBy: [...blocked],
        created_at: toIsoString({ value: item.createdAt }),
        createdAt: toIsoString({ value: item.createdAt }),
        updated_at: toIsoString({ value: item.updatedAt }),
        updatedAt: toIsoString({ value: item.updatedAt }),
        native_ref: nativeRef,
        nativeRef,
        metadata,
        branch_name: branchName,
        assignee_id: assigneeId
    };
}

/**
 * The live resolved config, or a `not_started` policy error. Mapping an
 * unstarted policy would silently emit defaults, which is worse than failing.
 * @param {{policy: PolicyLike}} arg0
 * @returns {import('./config.mjs').ResolvedWorkflowConfig}
 */
function configFor({ policy }) {
    const config = policy.getConfig();
    if (config === null) {
        throw new PolicyError({
            message: 'Workflow policy is not started',
            options: { reason: 'not_started' }
        });
    }
    return config;
}

/**
 * One `preflight` closure per policy instance. A fresh closure per mapping
 * would make every `applyConfig` report a `preflight` change — a prompt-only
 * reload would look like a scheduler reconfiguration. The closure still reads
 * the policy live, so health changes need no new options.
 * @type {WeakMap<object, () => string[]>}
 */
const PREFLIGHT = new WeakMap();

/**
 * @param {{policy: PolicyLike}} arg0
 * @returns {() => string[]}
 */
function preflightFor({ policy }) {
    // `configFor` has already read `getConfig()`, so a non-object policy is
    // impossible here; the map keeps one closure per instance.
    const cached = PREFLIGHT.get(policy);
    if (cached !== undefined) return cached;
    const fn = () => policy.preflight();
    PREFLIGHT.set(policy, fn);
    return fn;
}

/**
 * The scheduler options from the resolved policy. Empty state arrays are
 * omitted (the scheduler rejects `[]` and preserves the current value on
 * `applyConfig`), and so is an empty `byLane`; `retry`/`continuation` are full
 * pairs and an unset limit is omitted so a reload clears it.
 * @param {{policy: PolicyLike}} arg0
 * @returns {SchedulerOptions}
 */
export function policyToSchedulerOptions({ policy }) {
    const config = configFor({ policy });
    const { tracker, polling, agent, scheduler } = config;
    /** @type {Record<string, number>} */
    const byLane = {};
    for (const [state, limit] of Object.entries(agent.maxConcurrentAgentsByState)) {
        byLane[state] = limit;
    }
    return {
        ...(tracker.activeStates.length > 0 ? { activeStates: [...tracker.activeStates] } : {}),
        ...(tracker.terminalStates.length > 0 ? { terminalStates: [...tracker.terminalStates] } : {}),
        requiredLabels: [...tracker.requiredLabels],
        pollIntervalMs: polling.intervalMs,
        stallTimeoutMs: scheduler.stallTimeoutMs,
        concurrency: {
            global: agent.maxConcurrentAgents,
            ...(Object.keys(byLane).length > 0 ? { byLane } : {})
        },
        retry: { baseMs: scheduler.retryBaseMs, maxMs: agent.maxRetryBackoffMs },
        continuation: { delayMs: scheduler.continuationDelayMs, max: scheduler.continuationMax },
        limits: {
            maxAttemptsPerItem: scheduler.maxAttemptsPerItem,
            ...(scheduler.maxDispatches !== null ? { maxDispatches: scheduler.maxDispatches } : {}),
            ...(scheduler.maxTotalTokens !== null ? { maxTotalTokens: scheduler.maxTotalTokens } : {}),
            ...(scheduler.maxTotalUsd !== null ? { maxTotalUsd: scheduler.maxTotalUsd } : {})
        },
        preflight: preflightFor({ policy })
    };
}

/**
 * The construction-bound workspace options. `repoRoot` is emitted only when the
 * policy set one (which `git-worktree` requires); hooks are already camelCase in
 * the resolved config.
 * @param {{policy: PolicyLike}} arg0
 * @returns {WorkspaceOptions}
 */
export function policyToWorkspaceOptions({ policy }) {
    const config = configFor({ policy });
    const { workspace, hooks } = config;
    return {
        root: workspace.root,
        strategy: workspace.strategy,
        ...(workspace.repoRoot ? { repoRoot: workspace.repoRoot } : {}),
        baseRef: workspace.baseRef,
        branchPrefix: workspace.branchPrefix,
        hooks: {
            afterCreate: hooks.afterCreate,
            beforeRun: hooks.beforeRun,
            afterRun: hooks.afterRun,
            beforeRemove: hooks.beforeRemove,
            timeoutMs: hooks.timeoutMs
        }
    };
}

/**
 * The engine runner's `({ item, attempt, continuation }) => string` prompt
 * callback. A render error emits the stable base reason and the template path,
 * then rethrows the `PolicyError` so the scheduler can park the item.
 *
 * The scheduler numbers its dispatches from 1; the contract's `attempt` is a
 * retry index (`null` on the first dispatch, `1` on the first retry). A
 * continuation runs as dispatch 1 again but is a retry, and a failure retry is
 * dispatch 2, so the kind — not the ordinal alone — selects the index. The
 * mapping is what makes `{% if attempt %}` usable, since the template subset has
 * no comparisons.
 * @param {{policy: PolicyLike, eventEmitter?: import('node:events').EventEmitter|null}} arg0
 * @returns {(arg0: {item: Record<string, unknown>, attempt?: unknown, continuation?: boolean}) => string}
 */
export function createPolicyRenderer({ policy, eventEmitter = null }) {
    return ({ item, attempt = null, continuation = false }) => {
        const retryIndex = typeof attempt === 'number'
            ? (continuation ? attempt : attempt === 1 ? null : attempt - 1)
            : null;
        try {
            return policy.renderPrompt({ issue: toIssueView({ item }), attempt: retryIndex });
        } catch (err) {
            const { error, reason } = renderFailure({ err });
            emitEvent({
                emitter: eventEmitter,
                name: EVENTS.WORKFLOW_POLICY.RENDER_FAILED,
                payload: { reason, field: error.field }
            });
            throw error;
        }
    };
}
