// @ts-check
/**
 * @file Plan-lifecycle cluster of WorkflowExecutor.
 * @version 0.12.0
 *
 * @description
 * Everything between "a plan is installed" and "the evaluator changed it":
 * template validation, the plan snapshot the evaluator reads, the patch and
 * replan machinery, and the requeue/invalidation that keeps a discarded output
 * from shipping. The state lives on the executor, so every function takes it as
 * `host`; the class keeps thin wrappers for the private entry points.
 */
import { sortDagNodes, validateTemplateRefs } from './graph-utils.mjs';
import { Plan } from './plan.mjs';
import { applyPlanPatch, diffStepsToPatch } from './plan-patch.mjs';
import { danglingDependencies } from './executor-helpers.mjs';
import { forgetSessionRows } from './executor-session.mjs';
import { ConfigurationError, OrchestrationFailedError, OrchestrationExhaustedError } from '../../core/errors.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { choiceQuestion } from '../../messaging/decision.mjs';

/**
 * Step fields that name another step id directly. `subSteps`/`_decomposedSteps`
 * are a child plan: their ids are the child's own, so they are not rewired here.
 * @type {readonly string[]}
 */
const STEP_ID_FIELDS = Object.freeze(['dependencies', 'intakeSteps']);

/**
 * Step fields whose `{{id…}}` refs are interpolated against another step's
 * output (`systemPrompt` and `userPromptTemplate` at run time, `subObjective`
 * when the node plans a child), so a reference to a dropped id must follow the
 * replacement or the dependent would read `[UNRESOLVED: …]`.
 * @type {readonly string[]}
 */
const STEP_TEMPLATE_FIELDS = Object.freeze(['systemPrompt', 'userPromptTemplate', 'subObjective']);

/**
 * Rejects a plan with a `workflow:failed` event and a ConfigurationError.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, message: string}} arg0
 * @returns {never}
 */
export function rejectPlan({ host, message }) {
    emitEvent({ emitter: host, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [], reason: message }, runContext: host._runCtx ?? null });
    throw new ConfigurationError({ message });
}

/**
 * Validates every step's template references against known step ids, the run's
 * shared context keys, and the C1 rule: a step id a step reads must be one of its
 * **ancestors**. Runs at execute time (context is known), when a plan is installed,
 * and again for replanned or patched steps. Opt out with
 * `options.validateTemplateRefs: false`.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, steps: Array<import('./executor.mjs').WorkflowStep>, knownIds?: Array<string>, quiet?: boolean, graph?: Array<{id: string, dependencies?: string[]}>|null, ancestryOnly?: boolean}} arg0
 *   `quiet` is for a patch being validated: a rejected edit is not a failed run.
 *   `ancestryOnly` skips the existence check, which needs the run's context roots
 *   (a plan can be installed before they are known).
 */
export function validateStepTemplates({ host, steps, knownIds = [], quiet = false, graph = null, ancestryOnly = false }) {
    if (!host.validateTemplateRefs) return;
    // History first, the list being validated last: an edit that ADDS the missing
    // dependency must be judged on its new definition, not the stored one.
    const fullGraph = graph ?? [
        ...Array.from(host.steps.values()).map((s) => ({ id: s.id, dependencies: s.dependencies ?? [] })),
        ...steps.map((s) => ({ id: s.id, dependencies: s.dependencies ?? [] })),
    ];
    const { unknown, nonAncestor } = validateTemplateRefs({
        steps,
        contextRoots: ['context', ...Object.keys(host.context ?? {})],
        knownIds,
        ancestorsOnly: true,
        graph: fullGraph,
    });
    /** @type {string[]} */
    const problems = [];
    if (!ancestryOnly && unknown.length > 0) {
        problems.push(`Unknown template reference(s): ${unknown.map(u => `'{{${u.expr}}}' in step '${u.stepId}'`).join(', ')}`);
    }
    if (nonAncestor.length > 0) {
        problems.push(`Template reference(s) to a non-ancestor: ${nonAncestor.map(u => `'{{${u.expr}.output}}' in step '${u.stepId}'`).join(', ')} — a step reads only its ancestors (add the dependency)`);
    }
    if (problems.length > 0) {
        const message = problems.join(' ');
        if (!quiet) emitEvent({ emitter: host, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [], reason: message }, runContext: host._runCtx ?? null });
        throw new ConfigurationError({ message });
    }
}

/**
 * JSON map of the completed step outputs (the `data` half).
 * @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0
 * @returns {Record<string, unknown>}
 */
export function cleanOutputs({ host }) {
    /** @type {Record<string, unknown>} */
    const clean = {};
    for (const [id, val] of Object.entries(host.outputs)) clean[id] = val.data;
    return clean;
}

/**
 * The guiding plan as the caller can inspect it: every node the run knows,
 * history included (a retained completed node still satisfies dependencies).
 * @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0
 * @returns {Plan}
 */
export function currentPlan({ host }) {
    // Deep-copied, not aliased: an evaluator that pushes to `dependsOn` or edits a
    // nested step field must not edit the live run behind the patch machinery's back.
    /** @type {WeakMap<object, any>} */
    const seen = new WeakMap();
    const clone = (/** @type {any} */ value) => {
        if (value === null || typeof value !== 'object') return value;
        if (seen.has(value)) return seen.get(value);
        if (value instanceof Date) return new Date(value.getTime());
        if (value instanceof Map) {
            const map = new Map();
            for (const [k, v] of value) map.set(clone(k), clone(v));
            return map;
        }
        if (value instanceof Set) {
            const set = new Set();
            for (const item of value) set.add(clone(item));
            return set;
        }
        if (Array.isArray(value)) {
            const list = /** @type {any[]} */ ([]);
            seen.set(value, list);
            for (const item of value) list.push(clone(item));
            return list;
        }
        const out = /** @type {Record<string, any>} */ ({});
        seen.set(value, out);
        for (const [key, item] of Object.entries(value)) out[key] = clone(item);
        return out;
    };
    const plan = Plan.fromDag({
        steps: Array.from(host.steps.values()).map((n) => clone(n)),
        objective: host.globalObjective,
    });
    for (const node of plan.nodes) {
        if (/** @type {{historical?: unknown}} */ (node.step)?.historical) node.meta = { ...(node.meta ?? {}), historical: true };
    }
    return plan;
}

/**
 * Ids of completed nodes the run still holds as **accepted** evidence (history
 * included). A `rejected` node — one a replanner dropped after the run refused
 * its output — is not evidence: a patch or a template may not read it (C-2).
 * @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0 @returns {Set<string>}
 */
export function completedIds({ host }) {
    return new Set(Array.from(host.steps.values())
        .filter((n) => n.status === 'completed' && n.rejected !== true)
        .map((n) => n.id));
}

/** @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0 @returns {Array<import('./executor.mjs').WorkflowStep>} the nodes this run still owns (history excluded). */
export function liveStepList({ host }) {
    return Array.from(host.steps.values()).filter((n) => !n.historical);
}

/**
 * Where the run actually is — the part the per-step evaluator never sees.
 * @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0
 * @returns {{completed: Array<{id: string, brief: string, output: unknown}>, pending: string[], failed: string[], total: number}}
 */
export function planProgress({ host }) {
    const live = liveStepList({ host });
    /** @param {import('./executor.mjs').WorkflowStep} n */
    const briefOf = (n) => (typeof n.brief === 'string' && n.brief.trim()) ? n.brief : String(n.name ?? n.title ?? n.id);
    return {
        completed: live.filter((n) => n.status === 'completed').map((n) => ({
            id: n.id,
            brief: briefOf(n),
            // Copied for the same reason the plan is: an evaluator must not edit the run.
            output: n.output && typeof n.output === 'object' ? JSON.parse(JSON.stringify(n.output)) : n.output,
        })),
        pending: live.filter((n) => n.status === 'pending' || n.status === 'running').map((n) => n.id),
        failed: live.filter((n) => n.status === 'failed').map((n) => n.id),
        total: live.length,
    };
}

/**
 * A patch must leave a runnable DAG before it is installed. Throws without
 * emitting `workflow:failed`: a bad patch is a rejected edit, not a dead run.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, steps: Array<import('./executor.mjs').WorkflowStep>}} arg0
 */
export function assertPatchIsValid({ host, steps }) {
    const dangling = danglingDependencies({ steps, knownSteps: host.steps });
    if (dangling.length > 0) {
        throw new ConfigurationError({ message: `dangling dependencies: ${dangling.join(', ')}` });
    }
    const retained = Array.from(host.steps.values()).filter((n) => n.historical && n.status === 'completed');
    sortDagNodes({ steps: [...steps, ...retained] });
}

/**
 * The plan gate (PL2b). Called at a wave boundary. A broken evaluator, an
 * invalid patch or one that changes nothing never wedges the run and never
 * corrupts the plan: each becomes a warning and a `plan:patched` journal row.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, trigger?: string}} arg0
 * @returns {Promise<'continue'|'patched'|'settled'>}
 */
export async function evaluatePlan({ host, trigger = 'wave' }) {
    const evaluator = host.planEvaluator;
    if (!evaluator || typeof evaluator.evaluate !== 'function' || host._planEvalStopped) return 'continue';
    let result;
    try {
        result = /** @type {import('./executor.mjs').PlanVerdict} */ (await evaluator.evaluate({
            plan: currentPlan({ host }),
            progress: planProgress({ host }),
            objective: host.globalObjective,
            context: host.context,
            signal: host.signal,
        }));
    } catch (err) {
        host._planEvalStopped = true;
        const reason = `Plan evaluator unavailable — the plan is not re-evaluated again this run: ${/** @type {Error} */ (err).message}`;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.VERIFICATION_SKIPPED, payload: { stepId: 'plan', reason } });
        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [reason] });
        return 'continue';
    }
    const verdict = result?.verdict ?? 'continue';
    if (!['continue', 'replan', 'done', 'abort'].includes(verdict)) {
        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Plan evaluator returned unknown verdict '${String(verdict)}' — ignoring it.`] });
        return 'continue';
    }
    if (verdict === 'continue') {
        host._planEvalNoops = 0;
        return 'continue';
    }
    if (verdict === 'done') {
        host._planSettled = true;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.SETTLED, payload: {
            verdict: 'done',
            reason: typeof result?.reason === 'string' ? result.reason : null,
            trigger,
            pending: planProgress({ host }).pending,
        } });
        return 'settled';
    }
    if (verdict === 'abort') {
        const message = `Plan aborted by the plan evaluator: ${typeof result?.reason === 'string' ? result.reason : 'no reason given'}`;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: planProgress({ host }).pending, reason: message } });
        throw new OrchestrationFailedError({ message });
    }
    return applyEvaluatorPatch({ host, result, trigger });
}

/**
 * Applies a plan evaluator's patch through the same machinery as any plan
 * (historical retention, fingerprint invalidation, dangling rejection).
 * @param {{host: import('./executor.mjs').WorkflowExecutor, result: unknown, trigger: string}} arg0
 * @returns {'continue'|'patched'}
 */
export function applyEvaluatorPatch({ host, result, trigger }) {
    const verdict = /** @type {{reason?: unknown, patch?: {ops?: Array<Object>}}} */ (result ?? {});
    const reason = typeof verdict.reason === 'string' ? verdict.reason : null;
    const ops = Array.isArray(verdict.patch?.ops) ? verdict.patch.ops : [];
    /** @param {Array<{op: unknown, error: string}>} rejected */
    const noop = (rejected) => {
        host._planEvalNoops += 1;
        // Two consecutive no-ops mean the evaluator cannot express its edit; stop
        // asking rather than loop forever (a replan verdict is not a licence to spin).
        if (host._planEvalNoops >= LIMITS.noop_patch_limit) host._planEvalStopped = true;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
            ops, applied: [], rejected, reason, verdict: 'replan', trigger, noop: true
        } });
        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Plan evaluator asked for a replan with no applicable patch (${rejected[0]?.error ?? 'empty patch'}) — keeping the current plan.`] });
        return /** @type {const} */ ('continue');
    };
    if (ops.length === 0) return noop([]);
    if (host._planReplans >= host.maxPlanReplans) {
        host._planEvalStopped = true;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
            ops, applied: [], rejected: [], reason, verdict: 'replan', trigger, capped: true, planReplans: host._planReplans
        } });
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.REPLAN_LIMIT, payload: { stepId: 'plan', replans: host._planReplans } });
        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Plan replan limit (${host.maxPlanReplans}) reached — the plan evaluator's patch is not applied.`] });
        return 'continue';
    }
    // A `replaces` on a step this patch adds or updates is the same directive the
    // replan path honours: the patch removes a step its dependents still name, so
    // the replacement id is retargeted on the live list first — applyPlanPatch
    // would otherwise report the surviving dependents as dangling.
    /** @type {Array<{from: string, to: string, steps: string[]}>} */
    const rewired = [];
    /** @type {Set<string>} */
    const removedIds = new Set(ops
        .map((raw) => /** @type {Record<string, any>} */ (raw ?? {}))
        .filter((op) => op.op === 'remove' && typeof op.id === 'string')
        .map((op) => /** @type {string} */ (op.id)));
    /** @type {Map<string, string[]>} */
    const candidates = new Map(Array.from(removedIds, (id) => [id, /** @type {string[]} */ ([])]));
    for (const raw of ops) {
        const op = /** @type {Record<string, any>} */ (raw ?? {});
        if (op.op !== 'add' && op.op !== 'replace') continue;
        const node = /** @type {Record<string, any>|undefined} */ (op.node);
        // `add` carries the id on the node; `replace` may omit it and keep the
        // target's id, so the op id is the replacement's id there.
        const replacementId = typeof node?.id === 'string' ? node.id : (typeof op.id === 'string' ? op.id : null);
        const targets = declaredReplaces(node?.replaces);
        if (targets === null) {
            return noop([{ op: /** @type {any} */ (op), error: `step '${String(replacementId ?? '?')}' declares malformed replaces: expected a step id or an array of step ids` }]);
        }
        if (targets.length > 0 && replacementId === null) {
            return noop([{ op: /** @type {any} */ (op), error: 'step declares replaces: but the patch names no replacement id' }]);
        }
        for (const target of targets) {
            const list = candidates.get(target);
            if (!list) {
                return noop([{ op: /** @type {any} */ (op), error: `step '${String(replacementId ?? '?')}' declares replaces: '${target}', but this patch does not remove '${target}'` }]);
            }
            list.push(/** @type {string} */ (replacementId));
        }
    }
    let steps = liveStepList({ host });
    for (const [from, ids] of candidates) {
        if (ids.length === 0) continue;
        if (ids.length > 1) {
            return noop([{ op: /** @type {any} */ ({ op: 'remove', id: from }), error: `step '${from}' is removed, but the patch declares more than one replacement for it (${ids.join(', ')}); keep one (a replacement step may declare replaces: '${from}')` }]);
        }
        // Copied: rewireStepId mutates the nodes, and the live run must not be edited
        // before the patched list has been validated and installed.
        steps = steps.map((s) => ({ ...s }));
        rewired.push({ from, to: ids[0], steps: rewireStepId({ steps, from, to: ids[0] }) });
    }
    const outcome = applyPlanPatch({ steps, patch: /** @type {any} */ (verdict.patch), completedIds: completedIds({ host }) });
    if (outcome.rejected.length > 0) return noop(outcome.rejected);
    if (outcome.applied.length === 0) return noop([]);
    try {
        assertPatchIsValid({ host, steps: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps) });
        if (host.validateTemplateRefs) {
            validateStepTemplates({
                host,
                steps: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps),
                knownIds: Array.from(completedIds({ host })),
                quiet: true,
            });
        }
    } catch (err) {
        return noop([{ op: /** @type {any} */ ({ op: 'validate' }), error: /** @type {Error} */ (err).message }]);
    }
    host._planReplans += 1;
    host._planEvalNoops = 0;
    // `replaces` is a patch directive, not a step definition: it must not enter the
    // installed plan (or its fingerprint).
    for (const step of /** @type {Array<Record<string, any>>} */ (outcome.steps)) delete step.replaces;
    host.setSteps({ stepsList: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps) });
    for (const op of outcome.applied) {
        const id = typeof op.id === 'string' ? op.id : (op.node && typeof op.node.id === 'string' ? op.node.id : null);
        const target = id ? host.steps.get(id) : undefined;
        if (target && target.status === 'failed' && !target.historical) requeueStep({ host, stepId: target.id, status: 'failed' });
    }
    (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
        ops: verdict.patch?.ops, applied: outcome.applied, ...(rewired.length > 0 ? { rewired } : {}), reason, verdict: 'replan', trigger, planReplans: host._planReplans
    } });
    return 'patched';
}

/** @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0 @returns {Array<Record<string, unknown>>} */
export function planSnapshot({ host }) {
    return Array.from(host.steps.values()).map((n) => ({
        id: n.id,
        title: n.name ?? n.id,
        status: n.status,
        dependencies: n.dependencies ?? [],
        systemPrompt: n.systemPrompt ?? '',
        userPromptTemplate: n.userPromptTemplate ?? '',
        model: n.model ?? null,
        engine: n.engine ?? null,
        historical: !!n.historical,
    }));
}

/**
 * Rejects a plan whose dependency names nothing. C7: the plan used to be accepted
 * and only the scheduler noticed, after other branches had already spent tokens.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, steps: Array<import('./executor.mjs').WorkflowStep>}} arg0
 */
export function assertNoDanglingDependencies({ host, steps }) {
    const dangling = danglingDependencies({ steps, knownSteps: host.steps });
    if (dangling.length === 0) return;
    const what = host.steps.size === 0 ? 'Plan rejected' : 'Plan rewrite rejected';
    rejectPlan({ host, message: `${what}: dangling dependencies (no such step, and no completed step to reuse): ${dangling.join(', ')}.` });
}

/**
 * Validates a replanned step list: dependencies resolve, `replaces` declarations
 * are sound, and template refs name an ancestor.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, steps: Array<import('./executor.mjs').WorkflowStep>, rejectedId?: string|null}} arg0
 *   `rejectedId` is the step the replan is for; a replacement may target it.
 */
export function validateReplanSteps({ host, steps, rejectedId = null }) {
    const dangling = danglingDependencies({ steps, knownSteps: host.steps });
    if (dangling.length > 0) {
        const err = new ConfigurationError({ message: `Replan rejected: dangling dependencies (not in the rewritten plan or already completed): ${dangling.join(', ')}.` });
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [], reason: err.message } });
        throw err;
    }
    validateReplacements({ host, steps, rejectedId });
    // A replan may keep referencing the output of a completed node it dropped from
    // the list; that node is history, and its output is still readable (N5).
    validateStepTemplates({ host, steps, knownIds: Array.from(completedIds({ host })) });
}

/**
 * The ids a step declares it replaces (`replaces: 'x'` or `replaces: ['x', …]`).
 * `null` is a malformed declaration, which rejects the patch like any other bad
 * step field.
 * @param {unknown} value
 * @returns {string[]|null}
 */
function declaredReplaces(value) {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    if (list.some((id) => typeof id !== 'string' || id.trim() === '')) return null;
    return list;
}

/**
 * A `replaces` declaration is a claim about the plan it arrives with: it must
 * name a live or historical step, not itself, and not a step whose evidence the
 * run accepted. The step under replan is the one exception — its output is the
 * thing being refused, which is why a replacement is allowed to target it.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, steps: Array<import('./executor.mjs').WorkflowStep>, rejectedId?: string|null}} arg0
 */
function validateReplacements({ host, steps, rejectedId = null }) {
    /** @type {Map<string, {id: string, status?: string}>} */
    const known = new Map(host.steps);
    for (const s of /** @type {Array<{id: string, status?: string}>} */ (steps)) known.set(s.id, s);
    for (const step of /** @type {Array<Record<string, any>>} */ (steps)) {
        const targets = declaredReplaces(step.replaces);
        if (targets === null) {
            throw new ConfigurationError({ message: `Replan rejected: step '${step.id}' declares malformed replaces: expected a step id or an array of step ids.` });
        }
        for (const target of targets) {
            if (target === step.id) {
                throw new ConfigurationError({ message: `Replan rejected: step '${step.id}' declares replaces: its own id ('${target}').` });
            }
            const knownTarget = known.get(target);
            if (!knownTarget) {
                throw new ConfigurationError({ message: `Replan rejected: step '${step.id}' declares replaces: unknown step '${target}'.` });
            }
            if (knownTarget.status === 'completed' && target !== rejectedId) {
                throw new ConfigurationError({ message: `Replan rejected: step '${step.id}' declares replaces: '${target}', but '${target}' is completed — its evidence cannot be replaced.` });
            }
        }
    }
}

/**
 * Retargets every surviving reference to `from` onto `to` within a step list:
 * the id lists above, and the `{{id…}}` refs in the interpolated fields. Returns
 * the ids of the steps that changed, so the journal names the dependents. A
 * replacement that itself names `from` becomes a self-reference and is caught by
 * the patch's DAG/template validation, which refuses it.
 * @param {{steps: Array<Record<string, any>>, from: string, to: string}} arg0
 * @returns {string[]}
 */
function rewireStepId({ steps, from, to }) {
    /** @type {string[]} */
    const changed = [];
    for (const step of steps) {
        let touched = false;
        for (const field of STEP_ID_FIELDS) {
            const list = step[field];
            if (!Array.isArray(list) || !list.includes(from)) continue;
            step[field] = Array.from(new Set(list.map((/** @type {string} */ id) => (id === from ? to : id))));
            touched = true;
        }
        for (const field of STEP_TEMPLATE_FIELDS) {
            if (typeof step[field] !== 'string' || !step[field].includes('{{')) continue;
            const next = step[field].replace(/\{\{([^}]+)\}\}/g, (/** @type {string} */ whole, /** @type {string} */ expr) => {
                const trimmed = expr.trim();
                if (trimmed.split('.')[0] !== from) return whole;
                return `{{${to}${trimmed.slice(from.length)}}}`;
            });
            if (next !== step[field]) {
                step[field] = next;
                touched = true;
            }
        }
        if (touched) changed.push(step.id);
    }
    return changed;
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: import('./executor.mjs').WorkflowStep, reason: string|undefined, planner: {replan: Function}}} arg0
 * @returns {Promise<{retried?: boolean, decision: import('../decision-gate.mjs').GateChoice|null}>} the gate result, for the caller's cap accounting
 */
export async function applyReplan({ host, node, reason, planner }) {
    /** @type {import('../decision-gate.mjs').GateChoice|null} */
    let decision = null;
    /**
     * A replan the run refuses: journaled, warned, and a no-op so the current
     * plan continues. `ops` is what had been built when the refusal was decided
     * (empty before a patch exists).
     * @param {{error: string, ops?: Array<Object>}} arg0
     * @returns {{decision: import('../decision-gate.mjs').GateChoice|null}}
     */
    const refuse = ({ error, ops = [] }) => {
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
            ops, applied: [], rejected: [{ op: /** @type {any} */ ({ op: 'validate' }), error }], reason, verdict: 'replan', source: 'planner', noop: true
        } });
        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Replan rejected: ${error} — keeping the current plan.`] });
        return { decision };
    };
    if (host.decisionGate?.available && (host._decisionRetries.get(node.id) ?? 0) < 1) {
        const dm = await host.decisionGate.choose({
            state: {
                objective: host.globalObjective,
                stepId: node.id,
                stepTitle: node.title ?? node.id,
                failureReason: reason,
                replanCount: host._replanCount,
                maxReplanCount: host.maxReplanCount,
            },
            question: choiceQuestion({
                instructions: 'How should the run respond to this rejected step?',
                criteria: {
                    retry_same: 'The same step definition should run again unchanged.',
                    replan: 'The plan should be rewritten because the step itself is wrong.',
                    abort: 'The run cannot recover and must stop.',
                    other: 'None of these fits.',
                },
            }),
            signal: host.signal,
        });
        decision = dm;
        if (!dm.escalated && dm.choice === 'retry_same') {
            // Bounded to one DM retry per step, and the caller's replan budget still caps the run.
            host._decisionRetries.set(node.id, (host._decisionRetries.get(node.id) ?? 0) + 1);
            return { retried: true, decision };
        }
        if (!dm.escalated && dm.choice === 'abort') {
            throw new OrchestrationExhaustedError({ message: `Decision gate aborted the run after step [${node.id}]: ${reason ?? 'no reason'}` });
        }
    }
    const updatedPlan = await planner.replan({
        objective: host.globalObjective,
        failedStepId: node.id,
        failureReason: reason,
        currentOutputs: cleanOutputs({ host }),
        signal: host.signal,
        sessionId: host._runCtx?.runId ?? null,
        plan: planSnapshot({ host }),
    });
    const steps = Array.isArray(updatedPlan?.steps) ? updatedPlan.steps : [];
    if (steps.length === 0) {
        // An empty "new plan" would delete the run; it is not an edit. Refuse it and
        // let the failure path account for the step (the replan budget still bounds it).
        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Planner returned no steps for step [${node.id}] — keeping the current plan.`] });
        return { decision };
    }
    // A `replaces` declaration is read on the INCOMING list, before the diff: a
    // dropped step (completed or failed) leaves its dependents naming it, and
    // `applyPlanPatch` reports that as a dangling dependency — too late for a
    // post-apply pass to see the replacement. Rewiring here is what lets the
    // normal failed-step path heal instead of aborting.
    validateReplacements({ host, steps, rejectedId: node.id });
    /** @type {Array<{from: string, to: string, steps: string[]}>} */
    const rewired = [];
    if (!steps.some((/** @type {any} */ s) => s.id === node.id)) {
        const candidates = /** @type {Array<Record<string, any>>} */ (steps)
            .filter((s) => declaredReplaces(s.replaces)?.includes(node.id));
        if (candidates.length > 1) {
            const ids = candidates.map((c) => c.id).join(', ');
            return refuse({ error: `step '${node.id}' was rejected, but the new plan declares more than one replacement for it (${ids}); keep one (a replacement step may declare replaces: '${node.id}')` });
        }
        if (candidates.length === 1) {
            const replacement = /** @type {{id: string}} */ (candidates[0]);
            const changed = rewireStepId({ steps: /** @type {Array<Record<string, any>>} */ (steps), from: node.id, to: replacement.id });
            rewired.push({ from: node.id, to: replacement.id, steps: changed });
        }
    }
    // `replaces` is a patch directive, not a definition: the diff must never see it.
    for (const step of /** @type {Array<Record<string, any>>} */ (steps)) delete step.replaces;
    // PL2b: a whole-list planner response is a patch by diff. A node the planner
    // re-describes identically keeps its live definition — tools, HITL, timeouts,
    // a verify function — which a whole-list rewrite silently dropped.
    const live = liveStepList({ host });
    let patch;
    try {
        patch = diffStepsToPatch({ previous: live, next: steps });
    } catch (error) {
        const message = `Replan rejected: ${/** @type {Error} */ (error).message}`;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
            ops: [], applied: [], rejected: [{ op: /** @type {any} */ ({ op: 'diff' }), error: /** @type {Error} */ (error).message }],
            reason, verdict: 'replan', source: 'planner'
        } });
        const err = new ConfigurationError({ message });
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [], reason: message } });
        throw err;
    }
    // A planner-authored whole list may drop a node it no longer lists, history included.
    const outcome = applyPlanPatch({ steps: live, patch, allowRemoveCompleted: true, completedIds: completedIds({ host }) });
    if (outcome.rejected.length > 0) {
        const message = `Replan rejected: ${outcome.rejected.map(r => r.error).join('; ')}.`;
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
            ops: patch.ops, applied: [], rejected: outcome.rejected, reason, verdict: 'replan', source: 'planner'
        } });
        const err = new ConfigurationError({ message });
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [], reason: message } });
        throw err;
    }
    validateReplanSteps({ host, steps: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps), rejectedId: node.id });
    // A rewired list must still be a runnable DAG whose refs resolve; a replacement
    // that (say) keeps the old id in its own dependencies would be a cycle, and
    // refusing is the only exit that installs nothing.
    if (rewired.length > 0) {
        try {
            assertPatchIsValid({ host, steps: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps) });
            if (host.validateTemplateRefs) {
                validateStepTemplates({ host, steps: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps), knownIds: Array.from(completedIds({ host })), quiet: true });
            }
        } catch (err) {
            return refuse({ error: `step '${node.id}' was rejected and its replacement '${rewired[0].to}' leaves an invalid plan: ${/** @type {Error} */ (err).message}`, ops: patch.ops });
        }
    }
    // C-2: a node the planner drops would strand every dependent that still names
    // it. Dropping it would re-install output the run just refused, so the rewrite
    // is refused unless the patch declares a replacement (`replaces`), which the
    // pre-diff pass has already applied. The post-apply pass stays only as a
    // safety net for a declaration the diff introduced.
    if (!outcome.steps.some((s) => s.id === node.id)) {
        if (rewired.length === 0) {
            const candidates = /** @type {Array<Record<string, any>>} */ (outcome.steps)
                .filter((s) => declaredReplaces(s.replaces)?.includes(node.id));
            if (candidates.length > 1) {
                const ids = candidates.map((c) => c.id).join(', ');
                return refuse({ error: `step '${node.id}' was rejected, but the new plan declares more than one replacement for it (${ids}); keep one (a replacement step may declare replaces: '${node.id}')`, ops: patch.ops });
            }
            if (candidates.length === 1) {
                const replacement = /** @type {{id: string}} */ (candidates[0]);
                const changed = rewireStepId({ steps: /** @type {Array<Record<string, any>>} */ (outcome.steps), from: node.id, to: replacement.id });
                rewired.push({ from: node.id, to: replacement.id, steps: changed });
            }
        }
        const dependents = /** @type {Array<any>} */ (outcome.steps).filter((s) => (s.dependencies ?? []).includes(node.id));
        if (dependents.length > 0) {
            const pairs = dependents.map((s) => `${s.id}→${node.id}`).join(', ');
            return refuse({ error: `step '${node.id}' was rejected, but the new plan still makes dependent step(s) read it (${pairs}); rewire them or keep the step (a replacement step may declare replaces: '${node.id}')`, ops: patch.ops });
        }
        // C-2: a node the planner no longer lists is dropped, not satisfied. The run
        // itself refused its output (that is why it is being replanned), so the node
        // keeps no output and is marked `rejected`: what `runnable`, the intake
        // selection and every later patch read. Completed dependents are reset while
        // the node is still live (the refusal above makes this the dropped-dependent
        // case; `setSteps` keeps the node as history, where `resetInvalidatedStep`
        // would stop at the history guard).
        for (const other of host.steps.values()) {
            if (!other.historical && other.status === 'completed' && (other.dependencies ?? []).includes(node.id)) {
                resetInvalidatedStep({ host, stepId: other.id });
            }
        }
        node.output = null;
        node.rejected = true;
        delete host.outputs[node.id];
        forgetSessionRows({ host, stepId: node.id });
    }
    // `replaces` is a patch directive, not a step definition: it must not enter
    // the installed plan (or its fingerprint) once the patch has been applied.
    for (const step of /** @type {Array<Record<string, any>>} */ (outcome.steps)) delete step.replaces;
    host.setSteps({ stepsList: /** @type {Array<import('./executor.mjs').WorkflowStep>} */ (outcome.steps) });
    if (rewired.length > 0) {
        (/** @type {import('../../core/events.mjs').RunContext} */ (host._runCtx)).emit({ emitter: host, name: EVENTS.PLAN.PATCHED, payload: {
            ops: patch.ops, applied: outcome.applied, rewired, reason, verdict: 'replan', source: 'planner'
        } });
    }
    for (const s of steps) {
        const st = host.steps.get(s.id);
        if (st && st.status === 'failed' && !st.historical && !st._hitlGated) {
            requeueStep({ host, stepId: s.id, status: 'failed' });
        }
    }
    return { decision };
}

/**
 * Re-queues a step still in `status` after a plan rewrite so it is re-run and
 * re-verified instead of being shipped. A no-op rewrite (the planner returns
 * the identical step) leaves an evaluator-rejected step `completed`, which
 * would otherwise ship its rejected output as a successful result. Completed
 * dependents are invalidated too: their output was computed from the output
 * that is being discarded.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, stepId: string, status: string}} arg0
 */
export function requeueStep({ host, stepId, status }) {
    const node = host.steps.get(stepId);
    if (!node || node.historical || node.status !== status) return;
    resetInvalidatedStep({ host, stepId });
}

/**
 * Resets a step and its already-completed dependents to pending, dropping
 * their outputs and verification marks so they re-run and are re-verified
 * against the new upstream output instead of shipping a stale result.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, stepId: string}} arg0
 */
export function resetInvalidatedStep({ host, stepId }) {
    const node = host.steps.get(stepId);
    if (!node) return;
    // A step that was completed and then dropped by a replan keeps its output as
    // history but must not keep its exchange: a later member would inherit an
    // answer the evaluator refused.
    forgetSessionRows({ host, stepId });
    if (node.historical) return;
    host._verifiedIds?.delete(stepId);
    node.status = 'pending';
    node.output = null;
    delete node.rejected;
    node.messages = [];
    node.deltaMessages = [];
    delete node.usage;
    node._timedOut = false;
    delete node.lastArtifact;
    delete node._hitlGate;
    delete node._hitlDecision;
    delete node._iterDecisions;
    delete node._childState;
    delete node._decomposedSteps;
    delete node._backend;
    delete (/** @type {any} */ (node))._sessionGroupKey;
    delete host.outputs[stepId];
    forgetSessionRows({ host, stepId });
    host._mirrorStepTodo({ node, status: 'pending' });
    for (const other of host.steps.values()) {
        if (other.status === 'completed' && !other.historical && (other.dependencies ?? []).includes(stepId)) {
            resetInvalidatedStep({ host, stepId: other.id });
        }
    }
}
