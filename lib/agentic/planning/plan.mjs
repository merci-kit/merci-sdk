// @ts-check
import { GraphError, ConfigurationError } from '../../core/errors.mjs';
import { sortDagNodes } from './graph-utils.mjs';

/**
 * @file Plan — the guiding artifact both executors project onto.
 * @version 0.12.0
 *
 * @description
 * A plan is a DAG of **intents**: `{ id, brief, dependsOn }` plus the engine
 * payload (`step`) that will carry it out. The DAG executor consumes the plan
 * through `toDag()`; the StateMachine consumes it through `toStateMachine()`. Both
 * projections report what they could not carry, so nothing is lost silently.
 *
 * The two engines do not share a template dialect (`{{step_id.output}}` in the DAG,
 * `{{context.step_id}}` in the machine), so projections translate the unambiguous
 * references and report the rest.
 *
 * The type is JSON-safe: functions inside `step` do not round-trip, exactly like a
 * workflow checkpoint (see docs/PROVIDERS.md, "the checkpoint contract").
 */

export const PLAN_VERSION = 1;

/**
 * @typedef {Object} PlanLoss
 * @property {'join'|'sequence'|'condition'|'cycle'|'node-execute'|'early-terminal'|'reentry'|'entry'|'fan-out'|'unreachable'|'template-dialect'|'shared-context'|'timeout'} kind
 * @property {string} [at] - the node or edge the loss happened at.
 * @property {string} [detail]
 */

/**
 * One StateMachine node as the projection reads it. The graph is the machine's
 * own shape: only the fields this module interprets are named, and the node is
 * otherwise carried verbatim into the plan's step payload.
 * @typedef {Object} StateMachineNode
 * @property {string} id
 * @property {string} [systemPrompt]
 * @property {string} [userPromptTemplate]
 * @property {Function} [execute]
 * @property {boolean} [terminal]
 * @property {number} [maxVisits]
 * @property {number} [timeoutMs]
 */

/**
 * One StateMachine edge.
 * @typedef {Object} StateMachineEdge
 * @property {string} from
 * @property {string} to
 * @property {unknown} [condition]
 */

/**
 * @typedef {Object} PlanNode
 * @property {string} id
 * @property {string} brief - what must be true when the node is done.
 * @property {string[]} dependsOn
 * @property {'work'|'gate'} [kind]
 * @property {'atomic'|'static'|'decompose'} [expansion]
 * @property {string} [session] - 'inherit' | 'new' | a group id.
 * @property {Object} [step] - the DAG step payload (`WorkflowStep`); open, because a node may carry any engine's step.
 * @property {Record<string, unknown>} [meta] - projection-specific facts.
 */

/**
 * @param {any} step
 * @returns {string}
 */
function briefFor({ step }) {
    const explicit = step?.brief ?? step?.title ?? step?.name ?? step?.description;
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const prompt = typeof step?.userPromptTemplate === 'string'
        ? step.userPromptTemplate
        : (typeof step?.systemPrompt === 'string' ? step.systemPrompt : '');
    const firstLine = prompt.split('\n').map((/** @type {string} */ l) => l.trim()).find(Boolean);
    return firstLine || String(step?.id ?? '');
}

/**
 * @param {{nodes: Array<{id: string, dependsOn?: string[]}>, from: string, target: string}} arg0
 * @returns {boolean} whether `from` already depends (transitively) on `target`.
 */
function dependsTransitively({ nodes, from, target }) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const seen = new Set();
    /** @type {string[]} */
    const stack = [from];
    while (stack.length > 0) {
        const id = /** @type {string} */ (stack.pop());
        if (id === target) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const dep of byId.get(id)?.dependsOn ?? []) stack.push(dep);
    }
    return false;
}

/**
 * Rewrites the unambiguous template references between the two dialects:
 * `{{id.output}}` ⇄ `{{context.id}}`. Anything it cannot rewrite is returned so the
 * caller can report it; nothing is rewritten by guesswork.
 * @param {{text: any, nodes: string[], to: 'dag'|'sm'}} arg0
 * @returns {{text: any, untranslated: string[]}}
 */
function translateTemplates({ text, nodes, to }) {
    if (typeof text !== 'string' || !text.includes('{{')) return { text, untranslated: [] };
    /** @type {string[]} */
    const untranslated = [];
    const rewritten = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, expr) => {
        const ref = String(expr);
        if (to === 'sm') {
            const match = /^([A-Za-z0-9_-]+)\.output(.*)$/.exec(ref);
            if (match && nodes.includes(match[1])) return `{{context.${match[1]}${match[2]}}}`;
            if (ref.startsWith('context.') || /^[A-Za-z0-9_-]+\.output/.test(ref)) return whole;
            if (ref.includes('.')) untranslated.push(ref);
            return whole;
        }
        const match = /^context\.([A-Za-z0-9_-]+)(.*)$/.exec(ref);
        if (match) {
            if (!nodes.includes(match[1])) {
                untranslated.push(ref);
                return whole;
            }
            const rest = match[2].startsWith('.output') ? match[2].slice('.output'.length) : match[2];
            return `{{${match[1]}.output${rest}}}`;
        }
        if (/^[A-Za-z0-9_-]+\.output/.test(ref) || ref.startsWith('context.')) return whole;
        if (ref.includes('.')) untranslated.push(ref);
        return whole;
    });
    return { text: rewritten, untranslated };
}

/**
 * One plan, two executor views.
 */
export class Plan {
    /**
     * @param {{objective?: string, nodes?: PlanNode[], meta?: Record<string, unknown>, version?: number}} [arg0]
     */
    constructor({ objective = '', nodes = [], meta = {}, version = PLAN_VERSION } = {}) {
        this.version = version;
        this.objective = objective;
        this.nodes = nodes.map((n) => {
            if (n?.dependsOn !== undefined && !Array.isArray(n.dependsOn)) {
                throw new ConfigurationError({ message: `Plan node '${n?.id ?? '?'}' has a non-array dependsOn; use an array of node ids.` });
            }
            return {
                id: n.id,
                brief: n.brief,
                dependsOn: [...(n.dependsOn ?? [])],
                kind: n.kind ?? 'work',
                expansion: n.expansion ?? 'atomic',
                session: n.session ?? 'inherit',
                ...(n.step ? { step: n.step } : {}),
                ...(n.meta ? { meta: n.meta } : {}),
            };
        });
        this.meta = meta;
    }

    /** @param {{id: string}} arg0 @returns {PlanNode|undefined} */
    node({ id }) {
        return this.nodes.find((n) => n.id === id);
    }

    /**
     * Builds a plan from the DAG step list the executor already accepts.
     * Every step field survives verbatim in `node.step`; `dependsOn` mirrors
     * `dependencies`, and the brief prefers `brief`/`title`/`name`/`description`
     * over the prompt's first line.
     * @param {{steps: Array<Object>, objective?: string, meta?: Record<string, unknown>}} arg0
     * @returns {Plan}
     */
    static fromDag({ steps, objective = '', meta = {} }) {
        if (!Array.isArray(steps)) {
            throw new ConfigurationError({ message: 'Plan.fromDag() requires an array of steps.' });
        }
        const plan = new Plan({
            objective,
            meta: { ...meta, source: meta.source ?? 'dag' },
            nodes: steps.map((rawStep) => {
                const step = /** @type {Record<string, unknown>} */ (rawStep);
                return {
                id: String(step.id),
                brief: briefFor({ step }),
                dependsOn: [.../** @type {Array<string>} */ (Array.isArray(step.dependencies) ? step.dependencies : [])],
                kind: step.kind === 'gate' ? 'gate' : 'work',
                // An explicit sub-plan is `static` even when the node also carries the
                // `decompose` label: the executor would use the sub-plan, not plan it.
                // An explicit sub-plan is `static`; the `decompose` label is inert on a node
                // that pins a non-DAG engine (the executor keeps that engine).
                expansion: Array.isArray(step.subSteps) && step.subSteps.length > 0
                    ? 'static'
                    : (step.expansion === 'decompose' && (!step.engine || step.engine === 'dag') ? 'decompose' : 'atomic'),
                session: 'inherit',
                step: rawStep,
                };
            }),
        });
        return plan.validate();
    }

    /**
     * Projects a StateMachine graph into a plan. Conditions, cycles, JS `execute`
     * nodes, terminal/early-stop semantics, fan-out, unreachable nodes and the
     * template dialect are reported in `meta.lossy`.
     * @param {{graph: {entry?: string, nodes?: Array<StateMachineNode|Object>, edges?: Array<StateMachineEdge|Object>}, objective?: string, lossyCycles?: boolean}} arg0
     * @returns {Plan}
     */
    static fromStateMachine({ graph, objective = '', lossyCycles = true }) {
        const smNodes = Array.isArray(graph?.nodes) ? /** @type {Array<StateMachineNode>} */ (graph.nodes) : [];
        const smEdges = Array.isArray(graph?.edges) ? /** @type {Array<StateMachineEdge>} */ (graph.edges) : [];
        const ids = smNodes.map((n) => n.id);
        /** @type {PlanLoss[]} */
        const lossy = [];
        /** @type {PlanNode[]} */
        const nodes = smNodes.map((n) => {
            const { execute, terminal, maxVisits, ...rest } = n;
            const restFields = /** @type {Record<string, unknown>} */ (rest);
            if (typeof execute === 'function') lossy.push({ kind: 'node-execute', at: n.id, detail: 'a JS execute node is not a plan intent' });
            if (terminal === true) lossy.push({ kind: 'early-terminal', at: n.id });
            if (typeof maxVisits === 'number' && maxVisits > 1) lossy.push({ kind: 'reentry', at: n.id, detail: `maxVisits ${maxVisits}` });
            if (typeof n.timeoutMs === 'number') lossy.push({ kind: 'timeout', at: n.id, detail: 'the DAG uses stepTimeoutMs; this timeout is not carried' });
            for (const field of /** @type {const} */ (['systemPrompt', 'userPromptTemplate'])) {
                if (typeof restFields[field] !== 'string') continue;
                const { text, untranslated } = translateTemplates({ text: restFields[field], nodes: ids, to: 'dag' });
                restFields[field] = text;
                for (const ref of untranslated) {
                    lossy.push({ kind: ref.startsWith('context.') ? 'shared-context' : 'template-dialect', at: n.id, detail: `{{${ref}}} has no DAG equivalent` });
                }
            }
            return {
                id: n.id,
                brief: briefFor({ step: n }),
                dependsOn: [],
                kind: 'work',
                expansion: 'atomic',
                session: 'inherit',
                step: rest,
                meta: {
                    ...(terminal === true ? { terminal: true } : {}),
                    ...(typeof maxVisits === 'number' ? { maxVisits } : {}),
                    ...(typeof execute === 'function' ? { hasExecute: true } : {}),
                },
            };
        });

        const known = new Set(ids);
        const entry = typeof graph?.entry === 'string' ? graph.entry : '';
        if (entry && !known.has(entry)) {
            lossy.push({ kind: 'entry', at: entry, detail: 'the entry names no node' });
        }
        /** @type {Map<string, string[]>} */
        const outgoing = new Map(ids.map((id) => [id, []]));
        for (const edge of smEdges) {
            if (!known.has(edge.from) || !known.has(edge.to)) {
                lossy.push({ kind: 'template-dialect', at: `${edge.from}->${edge.to}`, detail: 'edge names an unknown node' });
                continue;
            }
            /** @type {string[]} */ (outgoing.get(edge.from)).push(edge.to);
        }

        const reachable = new Set();
        if (entry && known.has(entry)) {
            /** @type {string[]} */
            const stack = [entry];
            while (stack.length > 0) {
                const id = /** @type {string} */ (stack.pop());
                if (reachable.has(id)) continue;
                reachable.add(id);
                for (const next of outgoing.get(id) ?? []) stack.push(next);
            }
            for (const node of nodes) {
                if (reachable.has(node.id)) continue;
                lossy.push({ kind: 'unreachable', at: node.id, detail: 'not reachable from the entry; the plan still contains it' });
            }
        }

        for (const id of ids) {
            if ((outgoing.get(id) ?? []).length > 1) {
                lossy.push({ kind: 'fan-out', at: id, detail: 'the machine takes the first matching edge; the DAG runs every branch' });
            }
        }

        for (const edge of smEdges) {
            if (!known.has(edge.from) || !known.has(edge.to)) continue;
            const target = /** @type {PlanNode} */ (nodes.find((n) => n.id === edge.to));
            if (edge.condition !== undefined && edge.condition !== null) {
                lossy.push({ kind: 'condition', at: `${edge.from}->${edge.to}`, detail: 'the branch predicate is dropped; the ordering is kept' });
            }
            if (entry && known.has(entry) && !reachable.has(edge.from)) continue;
            if (target.dependsOn.includes(edge.from)) continue;
            if (dependsTransitively({ nodes, from: edge.from, target: edge.to })) {
                if (lossyCycles === false) {
                    throw new GraphError({ message: `Plan.fromStateMachine() cannot express the cycle ${edge.from}->${edge.to} as a DAG (pass lossyCycles:true to cut it).` });
                }
                lossy.push({ kind: 'cycle', at: `${edge.from}->${edge.to}`, detail: 'the back edge is cut' });
                continue;
            }
            target.dependsOn.push(edge.from);
        }

        const start = nodes.find((n) => n.id === entry);
        if (start && start.dependsOn.length > 0) {
            lossy.push({ kind: 'entry', at: entry, detail: 'the entry has prerequisites in the plan, so the plan cannot start there' });
        }
        const roots = nodes.filter((n) => n.dependsOn.length === 0);
        if (roots.length > 1) {
            lossy.push({ kind: 'entry', at: roots.map((n) => n.id).join(', '), detail: 'the machine starts at one entry; the plan runs every root' });
        }

        return new Plan({
            objective,
            nodes,
            meta: { source: 'state-machine', entry: graph?.entry ?? null, lossy },
        }).validate();
    }

    /**
     * The DAG view: the step list `WorkflowExecutor.setSteps` accepts. DependsOn is
     * authoritative; the rest of each step comes from the node's payload.
     * @returns {{steps: Array<import('./executor.mjs').WorkflowStep>, lossy: PlanLoss[]}}
     */
    toDag() {
        this.validate();
        const lossy = [.../** @type {PlanLoss[]} */ (this.meta.lossy ?? [])];
        /** @type {Array<import('./executor.mjs').WorkflowStep>} */
        const steps = this.nodes.map((node) => {
            const dependsOn = [...node.dependsOn];
            if (!node.step) {
                return {
                    id: node.id,
                    name: node.brief,
                    title: node.brief,
                    systemPrompt: node.brief,
                    userPromptTemplate: node.brief,
                    dependencies: dependsOn,
                };
            }
            // DependsOn is authoritative; keep `dependencies` absent when the step
            // never had them and the plan has none, so a round trip is verbatim.
            const step = /** @type {Record<string, unknown>} */ ({ ...node.step, id: node.id });
            if (dependsOn.length > 0 || Object.hasOwn(node.step, 'dependencies')) {
                step.dependencies = dependsOn;
            }
            return /** @type {import('./executor.mjs').WorkflowStep} */ (step);
        });
        return { steps, lossy };
    }

    /**
     * The StateMachine view. A DAG has no conditions and no re-entry, so the graph
     * is a topological chain: every dependency is satisfied before its node, at the
     * cost of parallelism (reported as `sequence`/`join`). References are translated
     * to the machine's dialect; the rest are reported.
     * @param {{entry?: string}} [arg0]
     * @returns {{graph: {entry: string, nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>>}, lossy: PlanLoss[]}}
     */
    toStateMachine({ entry = '' } = {}) {
        this.validate();
        const lossy = [.../** @type {PlanLoss[]} */ (this.meta.lossy ?? [])];
        const order = sortDagNodes({ steps: this.nodes.map((n) => ({ id: n.id, dependencies: n.dependsOn })) });
        const ids = this.nodes.map((n) => n.id);
        if (entry && entry !== order[0]) {
            throw new ConfigurationError({ message: `Plan.toStateMachine() needs an entry that is a root of the plan; '${entry}' is not (the chain starts at '${order[0]}').` });
        }
        const nodes = order.map((id) => {
            const node = /** @type {PlanNode} */ (this.node({ id }));
            const stepRecord = /** @type {Record<string, unknown>} */ (node.step ?? {});
            const { id: _id, dependencies: _deps, ...rest } = stepRecord;
            if (typeof rest.stepTimeoutMs === 'number') {
                lossy.push({ kind: 'timeout', at: id, detail: 'the machine uses timeoutMs; stepTimeoutMs is not carried' });
            }
            for (const field of /** @type {const} */ (['systemPrompt', 'userPromptTemplate'])) {
                if (typeof rest[field] !== 'string') continue;
                const { text, untranslated } = translateTemplates({ text: rest[field], nodes: ids, to: 'sm' });
                rest[field] = text;
                for (const ref of untranslated) {
                    lossy.push({ kind: 'template-dialect', at: id, detail: `{{${ref}}} has no StateMachine equivalent` });
                }
            }
            return {
                ...rest,
                id,
                name: node.brief,
                systemPrompt: rest.systemPrompt ?? node.brief,
                userPromptTemplate: rest.userPromptTemplate ?? node.brief,
                terminal: id === order[order.length - 1],
            };
        });
        /** @type {Array<Record<string, unknown>>} */
        const edges = [];
        for (let i = 1; i < order.length; i++) {
            edges.push({ from: order[i - 1], to: order[i], condition: null });
        }
        for (const node of this.nodes) {
            if (node.dependsOn.length > 1) {
                lossy.push({ kind: 'join', at: node.id, detail: `waits for ${node.dependsOn.join(', ')}` });
            }
        }
        if (this.nodes.length > 1) {
            lossy.push({ kind: 'sequence', at: order.join(' > '), detail: 'a DAG runs independent nodes in parallel; the machine runs them in order' });
        }
        const roots = this.nodes.filter((n) => n.dependsOn.length === 0);
        if (roots.length > 1) {
            lossy.push({ kind: 'entry', at: roots.map((n) => n.id).join(', '), detail: 'the machine has one entry; the plan has several roots' });
        }
        return {
            graph: { entry: order[0] ?? '', nodes, edges },
            lossy,
        };
    }

    /**
     * Rejects a malformed plan: empty/duplicate ids, unknown or self dependencies,
     * and cycles. Idempotent; returns the plan.
     * @returns {Plan}
     */
    validate() {
        if (this.nodes.length === 0) {
            throw new ConfigurationError({ message: 'Plan has no nodes — a plan needs at least one intent.' });
        }
        const ids = new Set();
        for (const node of this.nodes) {
            if (typeof node.id !== 'string' || !node.id.trim()) {
                throw new ConfigurationError({ message: 'Plan nodes require a non-empty string id.' });
            }
            if (ids.has(node.id)) {
                throw new ConfigurationError({ message: `Plan has duplicate node ids: ${node.id}.` });
            }
            ids.add(node.id);
        }
        for (const node of this.nodes) {
            for (const dep of node.dependsOn) {
                if (typeof dep !== 'string') {
                    throw new ConfigurationError({ message: `Plan node '${node.id}' has a non-string dependency.` });
                }
                if (dep === node.id) {
                    throw new GraphError({ message: `Plan node '${node.id}' depends on itself.` });
                }
                if (!ids.has(dep)) {
                    throw new GraphError({ message: `Plan node '${node.id}' depends on unknown node '${dep}'.` });
                }
            }
        }
        try {
            sortDagNodes({ steps: this.nodes.map((n) => ({ id: n.id, dependencies: n.dependsOn })) });
        } catch (error) {
            throw new GraphError({ message: `Plan is not a DAG: ${/** @type {Error} */ (error).message}` });
        }
        return this;
    }

    /**
     * The JSON-safe document. Functions and aliases cannot leak: the copy is made
     * through JSON, like a workflow checkpoint.
     * @returns {{version: number, objective: string, meta: Record<string, unknown>, nodes: Array<PlanNode>}}
     */
    toJSON() {
        const raw = { version: this.version, objective: this.objective, meta: this.meta, nodes: this.nodes };
        return JSON.parse(JSON.stringify(raw));
    }

    /**
     * Reads a plan document and validates it. Fail-closed: a document from a newer
     * version, a missing node list or a malformed graph is rejected.
     * @param {string|{version?: number, objective?: string, meta?: Record<string, unknown>, nodes?: Array<PlanNode>}} json
     * @returns {Plan}
     */
    static fromJSON(json) {
        /** @type {any} */
        let parsed;
        try {
            parsed = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (error) {
            throw new ConfigurationError({ message: `Plan.fromJSON() could not parse the document: ${/** @type {Error} */ (error).message}` });
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new ConfigurationError({ message: 'Plan.fromJSON() requires a plan object or a JSON string.' });
        }
        const version = parsed.version ?? PLAN_VERSION;
        if (typeof version !== 'number' || version > PLAN_VERSION) {
            throw new ConfigurationError({ message: `Plan.fromJSON() cannot read plan version ${String(version)}; this SDK reads up to ${PLAN_VERSION}.` });
        }
        if (!Array.isArray(parsed.nodes)) {
            throw new ConfigurationError({ message: 'Plan.fromJSON() requires a nodes array.' });
        }
        return new Plan({
            version,
            objective: parsed.objective ?? '',
            meta: parsed.meta ?? {},
            nodes: parsed.nodes,
        }).validate();
    }
}
