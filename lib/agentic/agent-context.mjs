// @ts-check


/**
 * @file Typed context envelope threaded through agentic runs.
 * @version 0.12.0
 *
 * @description
 * Carries the objective (the "general direction"), the system directive, a
 * parent pointer for delegation chains, and structured refs/metadata. The
 * objective is ALWAYS re-injected into model-visible context at every hop
 * (DAG steps, state-machine nodes, evaluator, subagents), so direction never
 * depends on the model's recall — the SOTA pattern (OpenAI RunContextWrapper,
 * Anthropic orchestrator-worker) for "subagents lose the general direction".
 */
import { ConfigurationError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
/**
 * The objective restatement policy (see `objective.mjs`).
 * @typedef {Object} ObjectivePolicy
 * @property {boolean} [adaptable] - Restate the objective on the cadence.
 * @property {boolean} [hitl] - Gate a change through the approval policy.
 * @property {number} [firstUpdate] - Turn of the first pass.
 * @property {number} [updateTurns] - Turns between passes.
 * @property {boolean} [preStep] - Restate before the step prompt is built (stateMachine/discussion engines).
 */

/**
 * How a delegated hop receives direction: which goal block, which context, and
 * which tools.
 * @typedef {Object} HandoffOptions
 * @property {string} [goal] - 'clean' | 'full' | 'moderated'.
 * @property {string} [context] - 'clean' | 'full' | 'moderated' | 'fork'. 'fork' seeds the child with the parent's real conversation rows (delegation only).
 * @property {string|Array<string|Object>} [tools] - 'inherit' | 'none' | explicit tool list (names or tool objects).
 */





/**
 * The durable form of one context: what `fromJSON` restores and `toJSON`
 * writes. `parent` chains it, capped on restore (D7).
 * @typedef {Object} AgentContextJSON
 * @property {string|null} [objective]
 * @property {string|null} [directive]
 * @property {Record<string, unknown>} [refs]
 * @property {Record<string, unknown>} [metadata]
 * @property {string|null} [objectiveInitial]
 * @property {number} [objectiveVersion]
 * @property {Array<string|null>} [objectiveHistory]
 * @property {ObjectivePolicy|null} [objectivePolicy]
 * @property {number} [objectiveTurn]
 * @property {AgentContextJSON|null} [parent]
 */

/**
 * The direction an inter-agent envelope carries (`_merci`).
 * @typedef {Object} MerciEnvelope
 * @property {string} [objective]
 * @property {string} [directive]
 * @property {Record<string, unknown>} [refs]
 * @property {string} [idempotencyKey] - The call's journal key, so a retried hop is not re-applied.
 */

/**
 * Deep copy of a plain payload (`refs`/`metadata`). `structuredClone` handles
 * dates and maps; a value it rejects (a function, a class instance) falls back to
 * a JSON round-trip and then to a shallow copy, so a step view never shares a
 * nested object with the run context (D6).
 * @param {{value: any, depth?: number}} arg0
 * @returns {any}
 */
function deepCopyValue({ value, depth = 0 }) {
    if (value == null || typeof value !== 'object') return value;
    if (depth > LIMITS.max_context_chain_depth) return null;
    try {
        return structuredClone(value);
    } catch {
        // A function or an exotic instance: fall through.
    }
    // A function, a symbol or an exotic instance: clone structurally by hand so a
    // Map keeps its entries and a Map holding a function keeps the function by
    // reference instead of collapsing to `{}` (JSON would do that).
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Map) {
        /** @type {Map<any, any>} */
        const mapped = new Map();
        for (const [k, v] of value) mapped.set(deepCopyValue({ value: k, depth: depth + 1 }), deepCopyValue({ value: v, depth: depth + 1 }));
        return mapped;
    }
    if (value instanceof Set) {
        /** @type {Set<any>} */
        const set = new Set();
        for (const v of value) set.add(deepCopyValue({ value: v, depth: depth + 1 }));
        return set;
    }
    if (Array.isArray(value)) return value.map((v) => deepCopyValue({ value: v, depth: depth + 1 }));
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCopyValue({ value: v, depth: depth + 1 });
    return out;
}

/**
 * The context envelope threaded through agentic runs. Child contexts inherit
 * parent values via `child()`; `fromJSON` is the single rehydration point.
 */
export class AgentContext {
    
    /**
 * @param {{objective?: string|null, directive?: string|null, parent?: AgentContext|null, refs?: Record<string, unknown>|null, metadata?: Record<string, unknown>|null, objectiveInitial?: string|null, objectiveVersion?: number, objectiveHistory?: Array<string|null>|null, objectivePolicy?: ObjectivePolicy|null, objectiveTurn?: number}} arg0
 */
        constructor({ objective = null, directive = null, parent = null, refs = null, metadata = null,
        objectiveInitial = null, objectiveVersion = 0, objectiveHistory = null, objectivePolicy = null, objectiveTurn = 0 } = {}) {
        this.objective = objective;
        this.directive = directive;
        this.parent = parent;
        this.refs = refs ?? {};
        this.metadata = metadata ?? {};
        this.objectiveInitial = objectiveInitial ?? objective ?? null;
        this.objectiveVersion = objectiveVersion;
        
        /** @type {Array<string|null>} */
                this.objectiveHistory = objectiveHistory ?? [];
        
        /** @type {ObjectivePolicy|null} */
                this.objectivePolicy = objectivePolicy;
        this.objectiveTurn = objectiveTurn;
    }

    
    /**
     * the version. Returns false (a no-op) when the text is empty or unchanged,
     * so a same-text pass never churns the version or emits an event.
     * @param {{next: string|null}} arg0 -
     * @returns {boolean} true when the objective actually changed.
     */
        applyObjective({ next }) {
        const text = String(next ?? '').trim();
        if (!text || text === this.objective) return false;
        this.objectiveHistory.push(this.objective);
        if (this.objectiveHistory.length > 20) this.objectiveHistory.shift();
        this.objective = text;
        this.objectiveVersion += 1;
        return true;
    }

    
    /**
 * Derives the context a delegated hop inherits: the child objective wins,
 * everything else falls back to the parent's values.
 * @param {{objective?: string|null, directive?: string|null, refs?: Record<string, unknown>|null, metadata?: Record<string, unknown>|null}} arg0
 * @returns {AgentContext} a new context whose parent is this one.
 */
        child({ objective = null, directive = null, refs = null, metadata = null } = {}) {
        return new AgentContext({
            objective: objective ?? this.objective,
            directive: directive ?? this.directive,
            parent: this,
            refs: { ...(refs ?? this.refs) },
            metadata: { ...(metadata ?? this.metadata) },
            objectiveInitial: this.objectiveInitial,
            objectiveVersion: this.objectiveVersion,
            objectiveHistory: [...this.objectiveHistory],
            objectivePolicy: this.objectivePolicy,
            objectiveTurn: this.objectiveTurn,
        });
    }

    
    /**
     * A step's own view of the context (D6). The objective fields are a snapshot
     * taken when the step is prepared — the run context keeps the live ones, and
     * the objective pass writes there, so a later step sees the update. `refs` and
     * `metadata` are deep copies: a step that mutates them cannot reach a sibling.
     * @returns {AgentContext}
     */
    snapshot() {
        const view = new AgentContext({
            objective: this.objective,
            directive: this.directive,
            parent: this,
            refs: deepCopyValue({ value: this.refs }),
            metadata: deepCopyValue({ value: this.metadata }),
            objectiveInitial: this.objectiveInitial,
            objectiveVersion: this.objectiveVersion,
            objectiveHistory: [...this.objectiveHistory],
            objectivePolicy: deepCopyValue({ value: this.objectivePolicy }),
            objectiveTurn: this.objectiveTurn,
        });
        // N7: a policy edit on a view is a view-local edit.
        /** @type {any} */ (view)._isStepView = true;
        return view;
    }

    /**
     * D6: adopts an objective restatement the step's session made on its view.
     * The view is isolated so `refs`/`metadata` cannot leak between siblings, but
     * the OBJECTIVE belongs to the run: a restatement inside a step must be seen by
     * the steps that follow it. Only a newer version is adopted, so a stale view
     * (or a parallel sibling that prepared earlier) cannot roll it back.
     * @param {{from: AgentContext|null}} arg0
     * @returns {boolean} true when the run context adopted a newer objective.
     */
    absorbObjective({ from }) {
        if (!from) return false;
        const incoming = Number.isInteger(from.objectiveVersion) ? from.objectiveVersion : 0;
        const current = Number.isInteger(this.objectiveVersion) ? this.objectiveVersion : 0;
        // The version is the contract: a view that did not bump it has nothing new
        // to say, and an older view must not roll the run back.
        if (incoming <= current) return false;
        // A parallel sibling that prepared before the run's current restatement and
        // restated twice has a HIGHER version built on a stale objective. Its history
        // does not pass through the run's current text, so it is not a successor.
        const history = Array.isArray(from.objectiveHistory) ? from.objectiveHistory : [];
        if (current > 0 && !history.includes(this.objective)) return false;
        this.objective = from.objective;
        this.objectiveVersion = Math.max(incoming, current);
        this.objectiveHistory = [...(from.objectiveHistory ?? [])];
        this.objectiveTurn = Number.isInteger(from.objectiveTurn) ? from.objectiveTurn : this.objectiveTurn;
        this.objectiveInitial = from.objectiveInitial ?? this.objectiveInitial;
        return true;
    }

    /**
     * @param {{label?: string}} arg0 -
     * @returns {string}
     */
        toModelBlock({ label = 'Global Objective' } = {}) {
        const parts = [];
        if (this.objective) parts.push(`[${label}]\n${this.objective}\n${OBJECTIVE_AUTHORITY_NOTE}`);
        if (this.directive) parts.push(`[Directive]\n${this.directive}`);
        return parts.join('\n\n');
    }

    
    /**
     * @param {{objective: string}} arg0 -
     * @returns {AgentContext}
     */
        static fromObjective({ objective }) {
        return new AgentContext({ objective });
    }

    
    /**
     * Rehydrates a context from a JSON checkpoint (or passes an instance
     * through). A plain-object restore would break every toModelBlock()
     * consumer — this is the single rehydration point.
     * @param {AgentContextJSON|null} json
     * @returns {AgentContext|null}
     */
        static fromJSON(json) {
        return restoreContext({ json, depth: 0 });
    }
}

/**
 * D7: `fromJSON` used to rebuild only the tail of the chain, although the chain
 * was serialized (the live object is written, so `parent` rides along). The depth
 * cap makes a malformed or enormous checkpoint finite.
 * @param {{json: any, depth: number}} arg0
 * @returns {AgentContext|null}
 */
function restoreContext({ json, depth }) {
    if (!json || typeof json !== 'object') return null;
    if (json instanceof AgentContext) return json;
    const j = /** @type {AgentContextJSON} */ (json);
    // `MERCI_LIMIT_MAX_CONTEXT_CHAIN_DEPTH` counts restored nodes, the tail included.
    const parent = depth + 1 < LIMITS.max_context_chain_depth ? restoreContext({ json: j.parent ?? null, depth: depth + 1 }) : null;
    return new AgentContext({
        objective: j.objective ?? null,
        directive: j.directive ?? null,
        parent,
        refs: j.refs ?? null,
        metadata: j.metadata ?? null,
        objectiveInitial: j.objectiveInitial ?? null,
        objectiveVersion: Number.isInteger(j.objectiveVersion) ? j.objectiveVersion : 0,
        objectiveHistory: Array.isArray(j.objectiveHistory) ? j.objectiveHistory : null,
        objectivePolicy: j.objectivePolicy ?? null,
        objectiveTurn: Number.isInteger(j.objectiveTurn) ? j.objectiveTurn : 0,
    });
}

/**
 * A plain, depth-capped copy of a context chain — for a checkpoint that is consumed
 * in memory (`new TaskState(saved.toJSON())`) as well as by JSON. Without it the
 * snapshot would alias the live chain and skip the restore cap.
 * @param {{ctx: AgentContext|null, depth?: number}} arg0
 * @returns {AgentContextJSON|null}
 */
export function contextChainJSON({ ctx, depth = 0 }) {
    if (!ctx || typeof ctx !== 'object' || depth >= LIMITS.max_context_chain_depth) return null;
    return {
        objective: ctx.objective ?? null,
        directive: ctx.directive ?? null,
        refs: deepCopyValue({ value: ctx.refs }),
        metadata: deepCopyValue({ value: ctx.metadata }),
        objectiveInitial: ctx.objectiveInitial ?? null,
        objectiveVersion: ctx.objectiveVersion ?? 0,
        objectiveHistory: Array.isArray(ctx.objectiveHistory) ? [...ctx.objectiveHistory] : [],
        objectivePolicy: deepCopyValue({ value: ctx.objectivePolicy }),
        objectiveTurn: ctx.objectiveTurn ?? 0,
        parent: contextChainJSON({ ctx: ctx.parent ?? null, depth: depth + 1 }),
    };
}

export const OBJECTIVE_TAG = '[Global Objective]';


/**
 * Fixed suffix appended to the objective part of the model-visible block. The
 * objective is the run's authority: a conflicting instruction elsewhere in a
 * prompt must not substitute a different deliverable. Exact text is
 * test-locked; it is never summarized or omitted.
 */
export const OBJECTIVE_AUTHORITY_NOTE = 'Authoritative: deliver what this objective asks; do not substitute a different deliverable.';


/**
 * Handoff marker appended after the full goal block when goal:'moderated'.
 * The goal itself is NEVER summarized (no-drift rule) — the marker only notes
 * that the accompanying context was compacted. Exact text is test-locked.
 */
export const HANDOFF_MODERATED_MARKER = '[Handoff: context compacted; goal carried in full]';


/** Valid `goal` modes for a handoff. */
export const HANDOFF_GOAL_MODES = ['clean', 'full', 'moderated'];

/** Valid `context` modes for a handoff. */
export const HANDOFF_CONTEXT_MODES = ['clean', 'full', 'moderated', 'fork'];




/**
 * @param {{ctx: AgentContext|string|null|undefined, label?: string}} arg0 -
 * @returns {string}
 */
export function objectiveBlock({ ctx, label = 'Global Objective' }) {
    if (typeof ctx === 'string') return ctx ? `[${label}]\n${ctx}` : '';
    return ctx?.toModelBlock?.({ label }) ?? '';
}


/**
 * Free combination: goal and context vary independently; tools defaults to
 * inherit. `context` stays undefined when unset so each engine keeps its own
 * current default (DAG intakeMode, SM window, discussion tail, task clean).
 * @param {{handoff?: HandoffOptions|null}} arg0 -
 * @returns {{goal: string, context: string|undefined, tools: string|Array<string|Object>}}
 */
export function normalizeHandoff({ handoff = null } = {}) {
    const goal = handoff?.goal ?? 'full';
    if (!HANDOFF_GOAL_MODES.includes(goal)) throw new ConfigurationError({ message: `handoff.goal must be one of ${HANDOFF_GOAL_MODES.join('|')} (got "${goal}")`, options: { option: 'goal' } });
    const context = handoff?.context ?? undefined;
    if (context !== undefined && !HANDOFF_CONTEXT_MODES.includes(context)) {
        throw new ConfigurationError({ message: `handoff.context must be one of ${HANDOFF_CONTEXT_MODES.join('|')} (got "${context}")`, options: { option: 'context' } });
    }
    const tools = handoff?.tools ?? 'inherit';
    if (tools !== 'inherit' && tools !== 'none' && !Array.isArray(tools)) {
        throw new ConfigurationError({ message: `handoff.tools must be 'inherit', 'none', or a tool list`, options: { option: 'tools' } });
    }
    return { goal, context, tools };
}


/**
 * empties, `'inherit'`/undefined keeps the fallback. Shared by the DAG engine
 * and the task tool so the two can never drift.
 * @template T
 * @param {{handoff: HandoffOptions|string|null, fallback: Array<T>|null}} arg0 - The tools to keep on 'inherit'.
 * @returns {Array<T>|null}
 */
export function resolveHandoffTools({ handoff, fallback }) {
    const tools = typeof handoff === 'string' ? handoff : handoff?.tools;
    if (Array.isArray(tools)) return /** @type {Array<T>} */ (tools);
    if (tools === 'none') return [];
    return fallback;
}


/**
 * block when full, the exact full block + marker when moderated.
 * @param {{ctx: AgentContext|string|null|undefined, handoff?: HandoffOptions|null, label?: string}} arg0 -
 * @returns {string}
 */
export function goalBlockForHandoff({ ctx, handoff = null, label = 'Global Objective' }) {
    const { goal } = normalizeHandoff({ handoff });
    if (goal === 'clean') return '';
    const block = objectiveBlock({ ctx, label });
    if (!block) return '';
    return goal === 'moderated' ? `${block}\n${HANDOFF_MODERATED_MARKER}` : block;
}


/**
 * `{ objective, directive, refs }`, nulls omitted. Unknown-field-tolerant
 * peers ignore it; our receivers restore direction from it.
 * @param {{ctx: AgentContext|null}} arg0 -
 * @returns {MerciEnvelope}
 */
export function merciEnvelope({ ctx }) {
    /** @type {MerciEnvelope} */
    const out = {};
    if (ctx?.objective) out.objective = ctx.objective;
    if (ctx?.directive) out.directive = ctx.directive;
    if (ctx?.refs && Object.keys(ctx.refs).length > 0) out.refs = { ...ctx.refs };
    return out;
}


/**
 * through). Absent/null/empty envelopes carry nothing and restore null; a
 * present-but-malformed envelope is a caller bug and throws (never silently
 * nulled) so a mistyped field cannot drop direction without a trace.
 * @param {{env: MerciEnvelope|AgentContext|null}} arg0 -
 * @returns {AgentContext|null}
 * @throws {Error} when `env` is present but malformed.
 */
export function contextFromMerciEnvelope({ env }) {
    if (env === null || env === undefined) return null;
    if (env instanceof AgentContext) return env;
    if (typeof env !== 'object') throw new ConfigurationError({ message: `_merci envelope must be an object (got ${typeof env})`, options: { option: '_merci' } });
    const { objective, directive, refs } = /** @type {MerciEnvelope} */ (env);
    if (objective != null && typeof objective !== 'string') throw new ConfigurationError({ message: '_merci.objective must be a string', options: { option: 'objective' } });
    if (directive != null && typeof directive !== 'string') throw new ConfigurationError({ message: '_merci.directive must be a string', options: { option: 'directive' } });
    if (refs != null && (typeof refs !== 'object' || Array.isArray(refs))) throw new ConfigurationError({ message: '_merci.refs must be an object', options: { option: 'refs' } });
    if (!objective && !directive && !refs) return null;
    return new AgentContext({ objective: objective ?? null, directive: directive ?? null, refs: refs ?? null });
}
