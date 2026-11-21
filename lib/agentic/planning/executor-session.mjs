// @ts-check
/**
 * @file Session-group cluster of WorkflowExecutor.
 * @version 0.12.0
 *
 * @description
 * The conversation-sharing machinery: which group a step joins, which rows it
 * may inherit (ancestors only), the prompt/tools/model contract that keeps a
 * cached prefix stable, and the restore warnings. The state lives on the
 * executor (`_sessionGroups`, `_stepVisits`, `_sessionOrder`), so every function
 * takes the executor as `host` and the class keeps thin wrappers.
 */
import { sortDagNodes } from './graph-utils.mjs';
import { capSessionRow } from './executor-helpers.mjs';
import { applyApprovalPolicy } from '../agentic-core.mjs';
import { createSession } from '../session-policy.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';

/**
 * The key of the group a step will join when that group is SHARED — a plan or
 * branch scope, or an explicit group annotation. `null` when the attempt owns
 * its session (`sessionScope: 'step'`, or a node that asks for `'new'`): those
 * runs are already isolated and stay fully parallel.
 * Pure: no visit counter, so it is safe to ask before the attempt starts.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: import('./executor.mjs').WorkflowStep}} arg0
 * @returns {string|null}
 */
export function sharedSessionGroupKey({ host, node }) {
    const annotated = /** @type {any} */ (node).session;
    if (typeof annotated === 'string' && annotated.length > 0 && annotated !== 'inherit') {
        return annotated === 'new' ? null : annotated;
    }
    if (host.sessionScope === 'plan') return '__plan__';
    if (host.sessionScope === 'branch') return branchGroupKey({ host, node });
    return null;
}

/**
 * Which session group a step attempt joins.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: import('./executor.mjs').WorkflowStep, attempt: number}} arg0
 * @returns {string}
 */
export function sessionGroupKey({ host, node, attempt }) {
    const annotated = /** @type {any} */ (node).session;
    const shared = sharedSessionGroupKey({ host, node });
    if (shared !== null) return shared;
    // 'new': one session for this node, persisted across its retries.
    if (annotated === 'new') return node.id;
    // 'step' keeps retries isolated: a fresh session per attempt (the contract
    // dag-engine pins), while a chosen group persists across them. The counter is
    // monotonic per node, so a requeued step (attempt 0 again) also starts fresh.
    void attempt;
    const visit = (host._stepVisits.get(node.id) ?? 0) + 1;
    host._stepVisits.set(node.id, visit);
    return `${node.id}#visit:${visit}`;
}

/**
 * One conversation runs one attempt at a time.
 *
 * Every member of a group shares ONE session object, and a real session refuses
 * a second run while one is in flight (`assertNotInFlight` in `runAgenticLoop`).
 * A per-key promise chain in call order gives each member the group for its
 * whole attempt — `runStep`'s session mutation and run, and the history append
 * that follows — so a wave composes the same conversation, in the same order, a
 * serial run composes. Different keys, and `sessionScope: 'step'`, are untouched.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, key: string}} arg0
 * @returns {Promise<() => void>} resolves when the group is this attempt's to
 *   use, with the release; call the release exactly once, from a `finally`.
 */
export async function sessionGroupGate({ host, key }) {
    const chains = host._sessionGroupChains;
    const prior = chains.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let resolveHeld = () => {};
    const held = new Promise((resolve) => { resolveHeld = () => resolve(undefined); });
    const tail = prior.then(() => held);
    chains.set(key, tail);
    // The tail drops the entry once it is the last link, so the map holds one
    // entry per group instead of one per attempt.
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    await prior;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        resolveHeld();
    };
}

/**
 * The nearest ancestor (or the node itself) that opens a branch scope: a plan
 * root or a node with more than one dependant.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: import('./executor.mjs').WorkflowStep}} arg0
 * @returns {string}
 */
export function branchGroupKey({ host, node }) {
    /** @type {Map<string, number>} */
    const dependents = new Map();
    for (const step of host.steps.values()) {
        for (const dep of step.dependencies ?? []) {
            dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
        }
    }
    /** @type {import('./executor.mjs').WorkflowStep|undefined} */
    let cursor = node;
    /** @type {Set<string>} */
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if ((cursor.dependencies ?? []).length === 0 || (dependents.get(cursor.id) ?? 0) > 1) return cursor.id;
        const parentId = /** @type {string|undefined} */ ((cursor.dependencies ?? [])[0]);
        cursor = parentId ? host.steps.get(parentId) : undefined;
    }
    return node.id;
}

/**
 * Looks up (or opens) a session group.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, key: string, node: import('./executor.mjs').WorkflowStep, model: string|undefined, boundary?: boolean}} arg0
 * @returns {import('./executor.mjs').SessionGroup}
 */
export function sessionGroup({ host, key, node, model, boundary = false }) {
    let group = host._sessionGroups.get(key);
    if (!group) {
        group = {
            key,
            // F1: build the step session with the run id, so `session:start`
            // announces the id later events carry (createSession prefers
            // `sessionWithId`; a plain `session(model)` announces an auto uuid).
            session: /** @type {import('./executor.mjs').GroupSession} */ (applyApprovalPolicy({ session: createSession({ client: /** @type {import('../session-policy.mjs').SessionClientLike} */ (host.client), model, sessionId: host._runCtx?.runId ?? null }), policy: host._approvalPolicy })),
            systemPrompt: undefined,
            toolsSignature: undefined,
            model: undefined,
            cacheSignature: undefined,
            history: [],
            members: new Set(),
            completed: new Set(),
        };
        host._sessionGroups.set(key, group);
        host._runCtx?.emit({ emitter: host, name: EVENTS.WORKFLOW.SESSION_GROUP, payload: { key, stepId: node.id, boundary } });
    }
    group.members.add(node.id);
    return group;
}

/**
 * The rows a member may inherit from its group: **ancestors only** (the C1
 * contract — a step never reads a sibling branch), in plan order (so a run with
 * `maxConcurrency > 1` produces the same prompt as a serial one), capped so a
 * long plan cannot blow the context budget.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, group: import('./executor.mjs').SessionGroup, node: import('./executor.mjs').WorkflowStep}} arg0
 * @returns {Array<import('../chat-session.mjs').ChatRow>}
 */
export function sharedSessionRows({ host, group, node }) {
    const ancestors = host._ancestorIds({ node });
    /** @type {Map<string, number>|null} */
    const order = host._sessionOrder ?? (host._sessionOrder = new Map(
        sortDagNodes({ steps: [...host.steps.values()].map((n) => ({ id: n.id, dependencies: n.dependencies ?? [] })) })
            .map((id, index) => [id, index])
    ));
    const entries = group.history
        .filter((entry) => entry.stepId !== node.id && ancestors.has(entry.stepId))
        .sort((x, y) => (order.get(x.stepId) ?? 0) - (order.get(y.stepId) ?? 0));
    const rows = entries.flatMap((entry) => entry.rows);
    if (rows.length === 0) return rows;

    const cap = host.sessionHistoryMaxChars;
    /** @type {any[]} */
    const kept = [];
    let used = 0;
    let truncated = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const size = JSON.stringify(row).length;
        if (used + size > cap && kept.length > 0) break;
        if (size > cap) {
            // A single oversized row still has to fit: keep its head, visibly cut.
            kept.unshift(capSessionRow({ row, cap }));
            used = cap;
            truncated += 1;
            continue;
        }
        kept.unshift(row);
        used += size;
    }
    const omitted = rows.length - kept.length;
    if (omitted === 0 && truncated === 0) return rows;
    const note = omitted > 0
        ? `[Session history: ${omitted} earlier row(s) omitted to fit the context budget]`
        : `[Session history: ${truncated} oversized row(s) truncated to fit the context budget]`;
    return [{ role: 'user', content: note }, ...kept];
}

/**
 * Records a member's completed exchange in the group, replacing its earlier entry
 * (a retry's transcript already contains the rows it had produced).
 * @param {{group: import('./executor.mjs').SessionGroup, stepId: string, rows: Array<import('../chat-session.mjs').ChatRow>}} arg0
 */
export function rememberSessionRows({ group, stepId, rows }) {
    let entry = group.history.find((e) => e.stepId === stepId);
    if (!entry) {
        entry = { stepId, rows: [] };
        group.history.push(entry);
    }
    for (const row of rows) {
        if (!entry.rows.includes(row)) entry.rows.push(row);
    }
}

/**
 * Drops a step's rows from every group. A requeued or invalidated step re-runs
 * from scratch, so its previous exchange must not reach a later member as
 * history (that is how a stale upstream output would leak into a dependent).
 * @param {{host: import('./executor.mjs').WorkflowExecutor, stepId: string}} arg0
 */
export function forgetSessionRows({ host, stepId }) {
    for (const group of host._sessionGroups.values()) {
        group.history = group.history.filter((e) => e.stepId !== stepId);
        group.completed.delete(stepId);
    }
}

/**
 * Enforces the group's prompt/tools contract. The first member defines it; a
 * member that changes either opens a boundary group instead of corrupting the
 * shared prefix.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, group: import('./executor.mjs').SessionGroup, node: import('./executor.mjs').WorkflowStep, model: string|undefined, systemPrompt: string, toolsSignature: string, stepCtx?: import('../../core/events.mjs').RunContext}} arg0
 * @returns {import('./executor.mjs').SessionGroup}
 */
export function applySessionContract({ host, group, node, model, systemPrompt, toolsSignature, stepCtx }) {
    const cacheSignature = JSON.stringify(/** @type {any} */ (node).promptCache ?? host.promptCache ?? null);
    if (group.systemPrompt === undefined) {
        group.systemPrompt = systemPrompt;
        group.toolsSignature = toolsSignature;
        group.model = model;
        group.cacheSignature = cacheSignature;
        return group;
    }
    const field = group.systemPrompt !== systemPrompt
        ? 'systemPrompt'
        : group.toolsSignature !== toolsSignature
            ? 'tools'
            : group.model !== model
                ? 'model'
                : group.cacheSignature !== cacheSignature ? 'promptCache' : null;
    if (!field) return group;

    const boundaryGroup = sessionGroup({ host, key: `${group.key}#${node.id}`, node, model, boundary: true });
    boundaryGroup.systemPrompt ??= systemPrompt;
    boundaryGroup.toolsSignature ??= toolsSignature;
    boundaryGroup.model ??= model;
    boundaryGroup.cacheSignature ??= cacheSignature;
    const warned = `${group.key}|${node.id}|${field}`;
    if (host._sessionBoundaryWarned.has(warned)) return boundaryGroup;
    host._sessionBoundaryWarned.add(warned);
    const message = `Step '${node.id}' changed the ${field} of session group '${group.key}' — it runs in its own session so the group's prefix, tools and model stay stable.`;
    sdkWarn({ prefix: 'WORKFLOW-SESSION', args: [message] });
    emitEvent({ emitter: host, name: EVENTS.WORKFLOW.SESSION_BOUNDARY, payload: {
        stepId: node.id,
        group: group.key,
        field,
        message,
    }, runContext: stepCtx ?? host._runCtx ?? null });
    return boundaryGroup;
}

/**
 * The function-valued fields a checkpoint could not carry and the step no longer
 * has: a `verify` gate and per-step `tools`. The `hasVerify`/`hasTools` markers
 * are sticky across checkpoints, so the list survives every later save (C-3).
 * @param {{node: import('./executor.mjs').WorkflowStep}} arg0
 * @returns {string[]}
 */
export function lostStepFunctions({ node }) {
    /** @type {string[]} */
    const lost = [];
    const marked = /** @type {any} */ (node);
    if (marked.hasVerify && typeof node.verify !== 'function') lost.push('verify gate');
    if (marked.hasTools && !Array.isArray(node.tools)) lost.push('tools');
    return lost;
}

/**
 * Warns when a resumed step had a `verify` gate or per-step `tools` that the
 * checkpoint could not carry (functions are not serializable). The step would
 * otherwise run with no gate at all, which silently weakens the restored plan.
 * A lost gate is not merely warned about: the executor refuses to run it unless
 * `allowLostStepFunctions` opts out.
 * @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0
 */
export function warnLostStepFunctions({ host }) {
    for (const node of host.steps.values()) {
        if (node.historical) continue;
        const lost = lostStepFunctions({ node });
        if (lost.length === 0) continue;
        const message = `Step '${node.id}' was checkpointed with a ${lost.join(' and ')}, but functions are not serializable: the restored step has none. Call setSteps() with the same plan before resuming to re-attach them.`;
        sdkWarn({ prefix: 'WORKFLOW-RESTORE', args: [message] });
        emitEvent({ emitter: host, name: EVENTS.WORKFLOW.RESTORE_WARNING, payload: { stepId: node.id, lost, message }, runContext: host._runCtx ?? null });
    }
}
