// @ts-check
import { ConfigurationError } from '../../core/errors.mjs';
import { stepFingerprint, stepFnSources } from './graph-utils.mjs';
import { danglingDependencies } from './executor-helpers.mjs';

/**
 * @file Plan patches — a replan edits the plan instead of replacing it.
 * @version 0.12.0
 *
 * @description
 * A whole-list replan is how a rewrite silently drops fields: the planner
 * re-describes every step from a partial snapshot, and anything it did not
 * mention (tools, HITL, timeouts, a verify function) disappears from the
 * untouched nodes too.
 *
 * A patch names the edit — `add`, `remove`, `rewire`, `replace`, `split`,
 * `expand` — and every node the patch does not name keeps the definition it
 * already had. The result is still a plain step list, so it goes through
 * `executor.setSteps()` and inherits its guarantees (historical retention,
 * fingerprint invalidation, dangling-dependency rejection).
 *
 * Rules the module enforces (all-or-nothing: one rejected op rejects the patch):
 *  - an op must name an existing node (`add` must not collide);
 *  - a **completed** node cannot be removed by an evaluator patch — its evidence is
 *    the run's history. A whole-list planner response is different: the planner
 *    authored the entire next plan, so `allowRemoveCompleted` lets the diff
 *    conversion drop a node it no longer lists (the node becomes history, exactly
 *    as it did when the whole list was installed directly);
 *  - a `split` target must be pending (splitting a running or finished node is
 *    not an edit, it is a rewrite of what already happened);
 *  - the merged list must not contain a dependency that names nothing
 *    (a completed node that the patch dropped still satisfies its dependants).
 *
 * `diffStepsToPatch()` turns a whole-list planner response back into a patch, so
 * the planner keeps its current contract while untouched nodes keep their fields.
 */

/**
 * The operations a patch may carry.
 * @type {readonly string[]}
 */
export const PLAN_PATCH_OPS = Object.freeze(['add', 'remove', 'rewire', 'replace', 'split', 'expand']);

/**
 * A node a patch carries: a full step for `add`, or only the fields to change
 * for `replace` (an omitted field keeps its current value). `dependencies: null`
 * means "none", exactly as a whole-list plan always did.
 * @typedef {Partial<Omit<import('./executor.mjs').WorkflowStep, 'dependencies'>> & {dependencies?: string[]|null}} PlanPatchNode
 */

/**
 * @typedef {Object} PlanPatchOp
 * @property {'add'|'remove'|'rewire'|'replace'|'split'|'expand'} op
 * @property {string} [id] - the target node (every op except `add`).
 * @property {PlanPatchNode} [node] - the node for `add` (full) or `replace` (fields to change).
 * @property {string[]} [dependsOn] - the new dependencies for `rewire`.
 * @property {Array<PlanPatchNode>} [nodes] - the successors for `split`.
 * @property {string} [leaf] - which successor the dependants attach to (default: the last).
 * @property {Array<PlanPatchNode>} [steps] - the sub-plan for `expand`.
 */

/**
 * A patch is a list of operations plus the reason the evaluator gave for them.
 * @typedef {Object} PlanPatch
 * @property {PlanPatchOp[]} ops
 * @property {string} [reason]
 */

/**
 * @typedef {Object} PlanPatchResult
 * @property {Array<import('./executor.mjs').WorkflowStep>} steps - the merged list (the input, copied, when rejected).
 * @property {PlanPatchOp[]} applied - the ops that took effect (empty when rejected).
 * @property {Array<{op: PlanPatchOp, error: string}>} rejected
 */

/**
 * @param {any} value
 * @returns {value is Record<string, any> & {id: string}}
 */
function isStep(value) {
    return !!value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0;
}

/**
 * Applies a patch to a step list, all or nothing.
 * @param {{steps: Array<import('./executor.mjs').WorkflowStep>, patch: PlanPatch, allowRemoveCompleted?: boolean, completedIds?: Set<string>|string[]}} arg0
 *   `steps` is the live plan; `completedIds` names completed nodes that are no longer
 *   in it (history retained by the run) so a dependency on them stays satisfiable.
 * @returns {PlanPatchResult}
 */
export function applyPlanPatch({ steps, patch, allowRemoveCompleted = false, completedIds = [] }) {
    if (!Array.isArray(steps)) {
        throw new ConfigurationError({ message: 'applyPlanPatch() requires an array of steps.' });
    }
    const original = steps.map((s) => ({ ...s }));
    const ops = Array.isArray(patch?.ops) ? patch.ops : [];
    /** @type {Array<{op: PlanPatchOp, error: string}>} */
    const rejected = [];
    /** @type {PlanPatchOp[]} */
    const applied = [];
    /** @type {Array<Record<string, any>>} */
    let working = original.map((s) => ({ ...s }));
    /** @type {Set<string>} */
    const completedBefore = new Set([
        ...original.filter((s) => s.status === 'completed').map((s) => s.id),
        ...(completedIds instanceof Set ? completedIds : completedIds),
    ]);

    if (ops.length === 0) {
        return { steps: original, applied: [], rejected };
    }

    /** @param {string} id @returns {Record<string, any>|undefined} */
    const find = (id) => working.find((s) => s.id === id);

    for (const raw of ops) {
        const op = raw ?? /** @type {any} */ ({});
        if (!PLAN_PATCH_OPS.includes(String(op.op))) {
            rejected.push({ op, error: `unknown op '${String(op.op)}'; expected one of ${PLAN_PATCH_OPS.join(', ')}` });
            continue;
        }
        if (op.op !== 'add') {
            const target = typeof op.id === 'string' ? find(op.id) : undefined;
            if (!target) {
                rejected.push({ op, error: `${op.op}: unknown node '${String(op.id)}'` });
                continue;
            }
        }

        switch (op.op) {
            case 'add': {
                const node = op.node;
                if (!isStep(node)) {
                    rejected.push({ op, error: 'add: node must be an object with a string id' });
                    break;
                }
                if (find(node.id)) {
                    rejected.push({ op, error: `add: node '${node.id}' already exists; use replace` });
                    break;
                }
                if (node.dependencies !== undefined && node.dependencies !== null && !Array.isArray(node.dependencies)) {
                    rejected.push({ op, error: `add: node '${node.id}' has non-array dependencies` });
                    break;
                }
                working = [...working, { ...node, id: node.id, ...(node.dependencies === null ? { dependencies: [] } : {}) }];
                applied.push(op);
                break;
            }
            case 'remove': {
                const target = /** @type {Record<string, any>} */ (find(/** @type {string} */ (op.id)));
                if (target.status === 'completed' && !allowRemoveCompleted) {
                    rejected.push({ op, error: `remove: node '${target.id}' is completed — its evidence cannot be removed` });
                    break;
                }
                if (target.status === 'running') {
                    rejected.push({ op, error: `remove: node '${target.id}' is running` });
                    break;
                }
                working = working.filter((s) => s.id !== target.id);
                applied.push(op);
                break;
            }
            case 'rewire': {
                if (!Array.isArray(op.dependsOn) || op.dependsOn.some((d) => typeof d !== 'string')) {
                    rejected.push({ op, error: `rewire: '${String(op.id)}' needs dependsOn as an array of node ids` });
                    break;
                }
                working = working.map((s) => (s.id === op.id ? { ...s, dependencies: [.../** @type {string[]} */ (op.dependsOn)] } : s));
                applied.push(op);
                break;
            }
            case 'replace': {
                if (!op.node || typeof op.node !== 'object') {
                    rejected.push({ op, error: `replace: '${String(op.id)}' needs a node` });
                    break;
                }
                if (op.node.id !== undefined && op.node.id !== op.id) {
                    rejected.push({ op, error: `replace: node id '${String(op.node.id)}' does not match target '${String(op.id)}'` });
                    break;
                }
                if (op.node.dependencies !== undefined && op.node.dependencies !== null && !Array.isArray(op.node.dependencies)) {
                    rejected.push({ op, error: `replace: '${String(op.id)}' has non-array dependencies` });
                    break;
                }
                const { dependencies: replacedDeps, ...replacedRest } = op.node;
                working = working.map((s) => (s.id === op.id
                    ? { ...s, ...replacedRest, id: s.id, ...(replacedDeps !== undefined ? { dependencies: Array.isArray(replacedDeps) ? [...replacedDeps] : [] } : {}) }
                    : s));
                applied.push(op);
                break;
            }
            case 'split': {
                const target = /** @type {Record<string, any>} */ (find(/** @type {string} */ (op.id)));
                if (target.status === 'completed' || target.status === 'failed' || target.status === 'running') {
                    rejected.push({ op, error: `split: node '${target.id}' is ${String(target.status)} — only a pending node can be split` });
                    break;
                }
                const successors = Array.isArray(op.nodes) ? op.nodes : [];
                if (successors.length === 0 || successors.some((n) => !isStep(n))) {
                    rejected.push({ op, error: 'split: nodes must be a non-empty array of nodes with string ids' });
                    break;
                }
                const ids = successors.map((n) => /** @type {string} */ (n.id));
                if (new Set(ids).size !== ids.length) {
                    rejected.push({ op, error: `split: duplicate successor ids (${ids.join(', ')})` });
                    break;
                }
                const colliding = ids.filter((id) => id !== target.id && find(id));
                if (colliding.length > 0) {
                    rejected.push({ op, error: `split: successor id(s) already in the plan: ${colliding.join(', ')}` });
                    break;
                }
                if (successors.some((n) => Array.isArray(n.dependencies) && n.dependencies.includes(target.id))) {
                    rejected.push({ op, error: `split: a successor of '${target.id}' depends on '${target.id}'` });
                    break;
                }
                const leaf = typeof op.leaf === 'string' ? op.leaf : ids[ids.length - 1];
                if (!ids.includes(/** @type {string} */ (leaf))) {
                    rejected.push({ op, error: `split: leaf '${String(leaf)}' is not one of the successors` });
                    break;
                }
                // A declared dependency list is used as-is; an empty one means "inherit
                // from the split" — the first successor takes the target's dependencies,
                // each later one depends on its predecessor.
                const chain = successors.map((n, index) => {
                    const declared = Array.isArray(n.dependencies) && n.dependencies.length > 0 ? n.dependencies : null;
                    const inherited = index === 0 ? (target.dependencies ?? []) : [ids[index - 1]];
                    return { ...n, dependencies: [...(declared ?? inherited)] };
                });
                // Replace the target in place, then re-attach every dependant to the leaf.
                const at = working.findIndex((s) => s.id === target.id);
                working = /** @type {Array<Record<string, any>>} */ ([...working.slice(0, at), ...chain, ...working.slice(at + 1)]
                    .map((/** @type {Record<string, any>} */ s) => (s.id === target.id ? s : {
                        ...s,
                        ...((s.dependencies ?? []).includes(target.id)
                            ? { dependencies: Array.from(new Set((s.dependencies ?? []).map((/** @type {string} */ d) => (d === target.id ? leaf : d)))) }
                            : {}),
                    })));
                applied.push(op);
                break;
            }
            case 'expand': {
                const subSteps = Array.isArray(op.steps) ? op.steps : [];
                if (subSteps.length === 0 || subSteps.some((n) => !isStep(n))) {
                    rejected.push({ op, error: 'expand: steps must be a non-empty array of steps with string ids' });
                    break;
                }
                working = working.map((s) => (s.id === op.id ? { ...s, subSteps: subSteps.map((n) => ({ ...n })) } : s));
                applied.push(op);
                break;
            }
            default:
                rejected.push({ op, error: `unknown op '${String(/** @type {any} */ (op).op)}'` });
        }
    }

    if (rejected.length > 0) {
        return { steps: original, applied: [], rejected };
    }

    // The merged list must still be a DAG. A dependency is satisfiable when it is in
    // the list, or when it named a completed node before the patch (that node is
    // retained as history and its output is still readable).
    const dangling = danglingDependencies({
        steps: /** @type {Array<{id: string, dependencies?: Array<string>}>} */ (working),
        knownSteps: completedBefore
    });
    if (dangling.length > 0) {
        return {
            steps: original,
            applied: [],
            rejected: [{ op: /** @type {any} */ ({ op: 'validate' }), error: `dangling dependencies introduced by the patch: ${dangling.join(', ')}` }],
        };
    }
    const duplicateIds = working.map((s) => s.id).filter((id, index, all) => all.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
        return {
            steps: original,
            applied: [],
            rejected: [{ op: /** @type {any} */ ({ op: 'validate' }), error: `duplicate node ids after the patch: ${Array.from(new Set(duplicateIds)).join(', ')}` }],
        };
    }

    return { steps: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (working), applied, rejected };
}

/**
 * Converts a whole-list planner response into a patch against the current plan.
 * A node the planner did not mention is removed (unless it already completed —
 * its evidence stays), and a node that changed is replaced. Nodes the planner
 * re-describes identically produce no op, so their live definition (and every
 * field the planner's snapshot omits) survives.
 * @param {{previous: Array<import('./executor.mjs').WorkflowStep>, next: Array<import('./executor.mjs').WorkflowStep>}} arg0
 * @returns {PlanPatch}
 */
export function diffStepsToPatch({ previous, next }) {
    const nextSteps = (next ?? []).filter(isStep);
    const nextIds = nextSteps.map((s) => s.id);
    if (new Set(nextIds).size !== nextIds.length) {
        throw new ConfigurationError({ message: `diffStepsToPatch(): the re-described plan has duplicate ids (${nextIds.join(', ')}).` });
    }
    const before = new Map((previous ?? []).filter(isStep).map((s) => [s.id, s]));
    const after = new Map(nextSteps.map((s) => [s.id, s]));
    /** @type {PlanPatchOp[]} */
    const ops = [];
    for (const [id, step] of after) {
        const old = before.get(id);
        if (!old) {
            ops.push({ op: 'add', node: step });
            continue;
        }
        // Compare against the fingerprint the executor saved for the definition it
        // installed: a live node also carries runtime fields, and hashing those would
        // read every node that has already run as "changed".
        const oldFp = typeof old._stepFingerprint === 'string' ? old._stepFingerprint : stepFingerprint({ step: old });
        const changed = oldFp !== stepFingerprint({ step }) || !sameFnSources({ a: old, b: step });
        if (changed) ops.push({ op: 'replace', id, node: step });
    }
    for (const [id] of before) {
        if (after.has(id)) continue;
        ops.push({ op: 'remove', id });
    }
    return { ops, reason: 'converted from a whole-list replan' };
}

/**
 * Two step definitions hold the same functions when their sources match (a value
 * comparison cannot identify a closure).
 * @param {{a: Record<string, any>, b: Record<string, any>}} arg0
 * @returns {boolean}
 */
function sameFnSources({ a, b }) {
    const sa = stepFnSources({ step: a });
    const sb = stepFnSources({ step: b });
    const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
    for (const key of keys) if (sa[key] !== sb[key]) return false;
    return true;
}
