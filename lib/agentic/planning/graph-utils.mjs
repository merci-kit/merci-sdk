// @ts-check
import { createHash } from 'node:crypto';
import { sdkWarn, safeStringify, strictStringify, stringifyTemplateValue, walkPath } from '../../support/utils.mjs';
import { GraphError, VerificationError } from '../../core/errors.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { LIMITS } from '../../core/limit-config.mjs';

/**
 * @file DAG graph utilities — sort, interpolation, leaf output.
 * @version 0.12.0
 *
 * @description
 * Pure helpers shared by the executor, planner and state machine: Kahn's
 * topological sort, the `{{expr}}` template interpolator (with a shared
 * dotted-path walker) and the leaf-output picker. Template misses warn and
 * resolve to `[UNRESOLVED: ...]` instead of throwing.
 */

/**
 * A Zod-like state schema: only `safeParse` is read.
 * @typedef {{safeParse: Function}} StateSchema
 */

/**
 * One step's recorded output: the value plus the status the engines stamp on it.
 * @typedef {Object} LeafRecord
 * @property {unknown} [output]
 * @property {string} [status]
 * @property {unknown} [data] - Whatever the step stored beside its output (a string, a number, an envelope).
 */

/**
 * Walks a dotted path through an object (prototype-key safe via Object.hasOwn).
 * @param {{value: Record<string, unknown>, parts: Array<string>}} arg0
 * @returns {{ok: boolean, value: unknown}}
 */
export { stringifyTemplateValue, walkPath };

/**
 * The step fields that carry no definition: they are the executor's runtime
 * bookkeeping and the fields a JSON checkpoint drops (functions, cycles).
 * They must not change the fingerprint of a definition (D6).
 */
const STEP_FINGERPRINT_EXCLUDED = new Set([
    // Runtime accounting, not definition: a node that has run carries `usage` and
    // `deltaMessages`, and re-supplying that node (a plan patch keeps untouched
    // nodes) must not read as "the definition changed" and requeue the plan.
    'usage', 'deltaMessages',
    'status', 'output', 'messages', 'historical', 'lastArtifact',
    '_restored', '_stepFingerprint', '_stepFnSources', '_backend', '_childState',
    '_hitlGate', '_hitlDecision', '_iterDecisions', '_stepStartedAt', '_timedOut', '_hitlGated',
    '_sessionGroupKey', '_decomposedSteps',
]);

/**
 * Stable identity of a step DEFINITION, **ignoring function-valued fields**.
 *
 * Every JSON-safe field participates, so a changed definition (different
 * tools, limits, handoff, intake, timeout, …) yields a different fingerprint
 * and the restored step is re-run instead of shipping the pre-edit output.
 * Functions are excluded on purpose: a JSON checkpoint cannot carry them, so a
 * plan re-supplied from a checkpoint (functions gone) must still match the
 * saved fingerprint — otherwise the durable HITL decision is dropped and the
 * gate is re-asked (D6/D16). A changed function is detected separately, by
 * source — see `stepFnSources`.
 *
 * KNOWN LIMIT: across a RESTORE, a function the plan no longer carries is
 * indistinguishable from a checkpoint that dropped it — the two plans are
 * identical — so the durable approval wins and the step is not re-run. On a
 * LIVE re-plan the same removal IS detected (the executor passes
 * `missingIsChange` there).
 * @param {{step: Object}} arg0
 * @returns {string} 12-char hex fingerprint
 */
export function stepFingerprint({ step }) {
    const rec = /** @type {Record<string, unknown>} */ (step);
    /** @type {Record<string, unknown>} */
    const payload = {};
    for (const key of Object.keys(rec ?? {}).sort()) {
        if (STEP_FINGERPRINT_EXCLUDED.has(key)) continue;
        payload[key] = rec[key];
    }
    // Strict: a truncated payload made an edited step above the node budget
    // fingerprint as unchanged, so the old output shipped (D-3).
    return createHash('sha256')
        .update(strictStringify({ value: payload }), 'utf8')
        .digest('hex')
        .slice(0, LIMITS.graph_hash_chars);
}

/**
 * The source text of every function in a step definition, keyed by its path.
 * A function cannot be fingerprinted by value (two plans may hold equivalent
 * but distinct closures), so its source text is the identity — the encoding
 * the live step comparison used. Stored beside the fingerprint so a changed
 * `verify`/`errorHandlers` is a changed step even though the JSON checkpoint
 * drops the functions themselves.
 * @param {{step: Object}} arg0
 * @returns {Record<string, string>} path → source text (empty when there is none)
 */
export function stepFnSources({ step }) {
    const rec = /** @type {Record<string, unknown>} */ (step);
    /** @type {Record<string, string>} */
    const sources = {};
    /** @type {Set<any>} */
    const seen = new Set();
    /**
     * @param {{value: any, path: string}} arg0
     */
    const walk = ({ value, path }) => {
        if (typeof value === 'function') { sources[path] = value.toString(); return; }
        if (value && typeof value === 'object') {
            // A cyclic definition must not blow the stack — the fingerprint
            // tolerates cycles, this walker must too.
            if (seen.has(value)) return;
            seen.add(value);
        }
        if (Array.isArray(value)) {
            value.forEach((item, i) => walk({ value: item, path: `${path}[${i}]` }));
            return;
        }
        if (value && typeof value === 'object') {
            for (const key of Object.keys(value).sort()) walk({ value: value[key], path: path ? `${path}.${key}` : key });
        }
    };
    for (const key of Object.keys(rec ?? {}).sort()) {
        if (STEP_FINGERPRINT_EXCLUDED.has(key)) continue;
        walk({ value: rec[key], path: key });
    }
    return sources;
}

/**
 * True when a function-valued field of the new definition differs from the
 * one the saved fingerprint was taken from — including a function the new
 * definition ADDS.
 *
 * A function the new definition no longer carries is a change only when
 * `missingIsChange` is set. Across a RESTORE the two cases are
 * indistinguishable: a plan rebuilt from a checkpoint has lost every function
 * (a JSON checkpoint cannot carry them) and so has a plan whose `verify` was
 * deleted on purpose — the plans are identical. The durable HITL approval
 * (D16) wins there, so the caller sets the flag only off the restore path.
 * @param {{saved: Record<string, string>, next: Record<string, string>, missingIsChange?: boolean}} arg0
 * @returns {boolean}
 */
export function fnSourcesDiffer({ saved, next, missingIsChange = false }) {
    for (const [path, source] of Object.entries(next ?? {})) {
        if (saved?.[path] !== source) return true;
    }
    if (missingIsChange) {
        for (const path of Object.keys(saved ?? {})) {
            if (!Object.prototype.hasOwnProperty.call(next ?? {}, path)) return true;
        }
    }
    return false;
}

/**
 * Kahn's topological sort of the given steps. Throws on a cycle.
 * A dependency naming no known step is SKIPPED — it adds no ordering
 * constraint and does not throw. Callers that must detect dangling deps do
 * it themselves (the DAG executor reports them in its deadlock message:
 * "Dangling dependencies (not in the plan): a→x").
 * @param {{steps: Array<{id: string, dependencies?: Array<string>}>}} arg0
 * @returns {Array<string>} step ids in execution order.
 */
export function sortDagNodes({ steps }) {
    const adj = /** @type {Map<string, Array<string>>} */ (new Map());
    const inDegree = /** @type {Map<string, number>} */ (new Map());

    for (const step of steps) {
        adj.set(step.id, []);
        inDegree.set(step.id, 0);
    }

    for (const step of steps) {
        for (const dep of step.dependencies ?? []) {
            if (adj.has(dep)) {
                (/** @type {Array<string>} */ (adj.get(dep))).push(step.id);
                inDegree.set(step.id, (/** @type {number} */ (inDegree.get(step.id))) + 1);
            }
        }
    }

    const queue = /** @type {Array<string>} */ ([]);
    for (const [id, deg] of inDegree.entries()) {
        if (deg === 0) queue.push(id);
    }

    const order = /** @type {Array<string>} */ ([]);
    let head = 0;
    while (head < queue.length) {
        const curr = queue[head++];
        order.push(curr);
        const neighbors = adj.get(curr) || [];
        for (const neighbor of neighbors) {
            inDegree.set(neighbor, (/** @type {number} */ (inDegree.get(neighbor))) - 1);
            if (inDegree.get(neighbor) === 0) {
                queue.push(neighbor);
            }
        }
    }

    if (order.length !== steps.length) {
        throw new GraphError({ message: "Cycle or unresolved dependency detected in DAG configuration." });
    }
    return order;
}

/**
 * The transitive dependency set of one node — the only steps whose outputs it
 * may read (C1). Iterative DFS over `nodes`, holding every id reached from the
 * node's direct dependencies.
 * @param {{nodes: Map<string, {dependencies?: Array<string>}>, dependencies: Array<string>|null|undefined}} arg0
 *   `dependencies` is the root node's own list: the caller passes the node it
 *   holds, which may be a shallow copy rather than the map entry.
 * @returns {Set<string>}
 */
export function ancestorIds({ nodes, dependencies }) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const stack = [...(dependencies ?? [])].map(String);
    while (stack.length > 0) {
        const next = /** @type {string} */ (stack.pop());
        if (seen.has(next)) continue;
        seen.add(next);
        const dep = nodes.get(next);
        for (const parent of dep?.dependencies ?? []) stack.push(String(parent));
    }
    return seen;
}

/**
 * Interpolates `{{expr}}` references in a template against step outputs and
 * run context (dotted paths supported). Unresolvable references warn, emit a
 * `workflow:template_warning` when an emitter is given, and render
 * `[UNRESOLVED: ...]`. `known` (the plan's step ids) lets the warning say
 * "not an ancestor" instead of the generic "does not exist or has not
 * completed" — the executor bounds `outputs` to the step's ancestors (C1).
 * @param {{template: string, outputs: Record<string, unknown>, stepId: string, emitter?: import('node:events').EventEmitter|null, context?: Record<string, unknown>, known?: Set<string>|null}} arg0
 * @returns {string}
 */
export function interpolateTemplate({ template, outputs, stepId, emitter, context = {}, known = null }) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
        const expr = expression.trim();
        const parts = expr.split('.');
        const targetStepId = parts[0];

        if (targetStepId === 'context') {
            const walked = walkPath({ value: context, parts: parts.slice(1) });
            if (!walked.ok) {
                const warnMsg = `Template error in step '${stepId}': Cannot resolve context property '${expr}'.`;
                sdkWarn({ prefix: 'WORKFLOW-INTERPOLATE', args: [warnMsg] });
                if (emitter) {
                    emitEvent({ emitter, name: EVENTS.WORKFLOW.TEMPLATE_WARNING, payload: {
                        stepId,
                        path: expr,
                        message: warnMsg
                    } });
                }
                return `[UNRESOLVED: ${match}]`;
            }
            return stringifyTemplateValue({ value: walked.value });
        }

        if (!Object.hasOwn(outputs, targetStepId)) {
            if (Object.hasOwn(context, targetStepId) && parts.length === 1) return stringifyTemplateValue({ value: context[targetStepId] });
            // C1: the executor only hands over ancestors, so a known step id that
            // is missing here is a non-ancestor reference — say so precisely.
            const warnMsg = known && known.has(targetStepId)
                ? `Template error in step '${stepId}': step '${targetStepId}' is not an ancestor — only dependencies and their ancestors may be referenced.`
                : `Template Resolution Warning in step '${stepId}': Step '${targetStepId}' does not exist or has not completed execution.`;
            sdkWarn({ prefix: 'WORKFLOW-INTERPOLATE', args: [warnMsg] });
            if (emitter) {
                emitEvent({ emitter, name: EVENTS.WORKFLOW.TEMPLATE_WARNING, payload: {
                    stepId,
                    referencedStepId: targetStepId,
                    message: warnMsg
                } });
            }
            return `[UNRESOLVED: ${match}]`;
        }

        const val = outputs[targetStepId];

        if (parts.length === 1) {
            const rec = /** @type {Record<string, unknown>} */ (val);
            const out = val !== null && typeof val === 'object' && Object.hasOwn(rec, 'output') ? rec.output : val;
            return stringifyTemplateValue({ value: out });
        }

        const direct = parts[1] === 'output' || parts[1] === 'data';
        /** @type {unknown} */
        let base = val;
        if (!direct && val !== null && typeof val === 'object' && Object.hasOwn(/** @type {Record<string, unknown>} */ (val), 'data')) {
            base = /** @type {Record<string, unknown>} */ (val).data;
        }
        const walked = walkPath({ value: /** @type {Record<string, unknown>} */ (base), parts: parts.slice(1) });
        if (!walked.ok) {
            const warnMsg = `Template error in step '${stepId}': Cannot resolve property path '${expr}' on referenced step output.`;
            sdkWarn({ prefix: 'WORKFLOW-INTERPOLATE', args: [warnMsg] });
            if (emitter) {
                emitEvent({ emitter, name: EVENTS.WORKFLOW.TEMPLATE_WARNING, payload: {
                    stepId,
                    path: expr,
                    message: warnMsg
                } });
            }
            return `[UNRESOLVED: ${match}]`;
        }
        return stringifyTemplateValue({ value: walked.value });
    });
}

/**
 * Collects `{{expr}}` template references from a string. Pure.
 * @param {{template: unknown}} arg0
 * @returns {Array<{expr: string, head: string}>}
 */
export function collectTemplateRefs({ template }) {
    if (typeof template !== 'string') return [];
    /** @type {Array<{expr: string, head: string}>} */
    const refs = [];
    for (const m of template.matchAll(/\{\{([^}]+)\}\}/g)) {
        const expr = m[1].trim();
        if (!expr) continue;
        refs.push({ expr, head: expr.split('.')[0] });
    }
    return refs;
}

/**
 * Validates that every `{{...}}` reference in each step's `userPromptTemplate`
 * names a known step id or an allowed context root, and — with `ancestorsOnly` —
 * that a step id it names is one of that step's **ancestors**. Returns both lists so
 * the caller decides how to fail: an unknown head is a typo, a non-ancestor is a
 * plan that would render `[UNRESOLVED: …]` at run time (C1: a step reads only what
 * it depends on, transitively).
 * @param {{steps: Array<{id: string, userPromptTemplate?: string, subObjective?: string}>, contextRoots?: Array<string>, fields?: Array<string>, knownIds?: Array<string>, ancestorsOnly?: boolean, graph?: Array<{id: string, dependencies?: string[]}>|null}} arg0
 *   `knownIds` names steps the caller can still read that are not in this list (a
 *   completed node that became history). `graph` is the full dependency graph when it
 *   is wider than `steps` (defaults to `steps`).
 * @returns {{unknown: Array<{stepId: string, expr: string}>, nonAncestor: Array<{stepId: string, expr: string, via: string[]}>}}
 */
export function validateTemplateRefs({ steps, contextRoots = ['context'], fields = ['userPromptTemplate', 'subObjective'], knownIds = [], ancestorsOnly = false, graph = null }) {
    const ids = new Set([...(steps ?? []).map(s => s && s.id).filter(Boolean), ...knownIds]);
    const roots = new Set(contextRoots);
    /** @type {Map<string, string[]>} */
    const deps = new Map();
    for (const node of /** @type {Array<{id: string, dependencies?: string[]}>} */ (graph ?? steps ?? [])) {
        if (node?.id) deps.set(node.id, [...(node.dependencies ?? [])]);
    }
    /**
     * Transitive dependencies of a node, following the graph (not just the list).
     * @param {string} id
     * @returns {Set<string>}
     */
    const ancestorsOf = (id) => {
        /** @type {Set<string>} */
        const seen = new Set();
        /** @type {string[]} */
        const stack = [...(deps.get(id) ?? [])];
        while (stack.length > 0) {
            const next = String(stack.pop());
            if (seen.has(next)) continue;
            seen.add(next);
            for (const parent of deps.get(next) ?? []) stack.push(parent);
        }
        return seen;
    };
    /** @type {Array<{stepId: string, expr: string}>} */
    const unknown = [];
    /** @type {Array<{stepId: string, expr: string, via: string[]}>} */
    const nonAncestor = [];
    for (const step of steps ?? []) {
        if (!step) continue;
        const ancestors = ancestorsOnly ? ancestorsOf(step.id) : null;
        for (const field of fields) {
            for (const ref of collectTemplateRefs({ template: /** @type {any} */ (step)[field] })) {
                if (roots.has(ref.head)) continue;
                if (!ids.has(ref.head)) {
                    unknown.push({ stepId: step.id, expr: ref.head });
                    continue;
                }
                if (ancestorsOnly && ancestors && !ancestors.has(ref.head)) {
                    nonAncestor.push({ stepId: step.id, expr: ref.head, via: [...(deps.get(step.id) ?? [])] });
                }
            }
        }
    }
    return { unknown, nonAncestor };
}

/**
 * Asserts a step/node output against an optional Zod-like state schema
 * (`safeParse`). No-op when no schema is configured. On failure throws a
 * `VerificationError` carrying the flattened issues, so the engine records a
 * step failure instead of storing malformed state.
 * Callers pass the value their engine stores: the DAG passes parsed `data`
 * (JSON-parsed, raw-text fallback); the StateMachine passes the raw node result
 * string (it does not parse). Author the schema for the value the engine stores.
 * Every engine (DAG naive/StateMachine/discussion/nested, StateMachine,
 * Discussion/MAA) feeds a violation into its bounded corrective-retry loop via
 * {@link stateSchemaViolation}; a typed error surfaces only after exhaustion.
 * @param {{schema: unknown, value: unknown, label: string}} arg0
 */
export function assertStateSchema({ schema, value, label }) {
    const probe = /** @type {StateSchema} */ (schema);
    if (!probe || typeof probe.safeParse !== 'function') return;
    const res = probe.safeParse(value);
    if (res.success) return;
    const issues = Array.isArray(res.error?.issues)
        ? res.error.issues.map((/** @type {any} */ i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('; ')
        : String(res.error);
    throw new VerificationError({ message: `${label} output failed stateSchema: ${issues}`, options: { label, issues } });
}

/**
 * Non-throwing form of {@link assertStateSchema}: the `VerificationError` a
 * violation would raise, or null when the value satisfies the schema (or no
 * schema is configured). Lets a retry loop feed the error back into its next
 * attempt instead of hard-failing the unit.
 * @param {{schema: unknown, value: unknown, label: string}} arg0
 * @returns {Error|null}
 */
export function stateSchemaViolation({ schema, value, label }) {
    try {
        assertStateSchema({ schema, value, label });
        return null;
    } catch (err) {
        return /** @type {Error} */ (err);
    }
}

/**
 * Returns the last (leaf) healthy step output from a completed workflow.
 * Failed steps' `Error: ...` outputs never win the scan.
 * @param {{stepsMap: Map<string, Object>, outputs: Record<string, LeafRecord|undefined>}} arg0
 * @returns {{output: string, sourceId: string|null}}
 */
export function getLeafOutput({ stepsMap, outputs }) {
    const nodes = /** @type {Array<{id: string, dependencies?: Array<string>}>} */ ([...stepsMap.values()]);
    const sortedIds = sortDagNodes({ steps: nodes });
    /** @type {unknown} */
    let leafResult = "";
    let sourceId = null;

    for (let i = sortedIds.length - 1; i >= 0; i--) {
        const sid = sortedIds[i];
        const stepNode = /** @type {{status?: string}|undefined} */ (stepsMap.get(sid));
        const record = outputs[sid];
        const out = record && record.output;
        const data = /** @type {{status?: string, error?: string}|null} */ (record?.data ?? null);
        const isFailed = stepNode?.status === 'failed'
            || (!!record && typeof record === 'object' && !Array.isArray(record)
                && (record.status === 'failed'
                    || data?.status === 'failed'
                    || (!!data && typeof data === 'object' && typeof data.error === 'string' && out === `Error: ${data.error}`)));
        if (out !== undefined && out !== null && out !== '' && !isFailed) {
            leafResult = out;
            sourceId = sid;
            break;
        }
    }

    if (sourceId === null) {
        leafResult = "Workflow completed, but no output was produced by any step. Check execution logs.";
    }

    return { output: /** @type {string} */ (leafResult), sourceId };
}
