// @ts-check
/**
 * @file TaskState — the serializable cross-stage carrier for a DAG run.
 * @version 0.12.0
 *
 * @description
 * One object that carries a workflow run across plan → execute → replan (and
 * across processes): the objective, the shared variable context (StateContext),
 * the direction envelope (AgentContext), and every step's status/output/
 * messages. `WorkflowExecutor.save()` / `WorkflowExecutor.load()` are thin
 * wrappers over it.
 */

import { StateContext } from '../state-machine/context.mjs';
import { AgentContext, contextChainJSON } from '../agent-context.mjs';
import { ExecutionJournal } from '../journal.mjs';
import { validateStrict } from '../../support/json.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
/**
 * One step's serialized record: the identity, the rows it sent, and every
 * engine-specific key a resume needs (status, output, attempts, …) as unknown.
 * @typedef {{id: string, messages?: Array<Object>, [key: string]: unknown}} StepRecord
 */

/**
 * A plain, JSON-safe snapshot of one run.
 * @typedef {Object} TaskStateSnapshot
 * @property {number} version
 * @property {string} objective
 * @property {Record<string, unknown>} context
 * @property {Record<string, unknown>} agentContext
 * @property {Array<StepRecord>} steps
 * @property {Record<string, unknown>} outputs
 * @property {number} replanCount
 * @property {number} tokensSpent
 * @property {number} usdSpent
 * @property {Array<[string, number]>} pendingEvaluations
 * @property {boolean} planSettled
 * @property {number} planReplans
 * @property {boolean} planEvalStopped
 * @property {Record<string, unknown>|null} journal
 */

/**
 * The executor fields this carrier reads and writes (structural view, so a
 * WorkflowExecutor assigns without a cast).
 * @typedef {Object} TaskStateExecutor
 * @property {string} [globalObjective]
 * @property {Record<string, unknown>} [context]
 * @property {Object|null} [_agentContext]
 * @property {Map<string, StepRecord>} steps
 * @property {Record<string, unknown>} [outputs]
 * @property {number} [_replanCount]
 * @property {Map<string, number>} [_pendingEvaluations]
 * @property {ExecutionJournal|null} [_journal]
 * @property {number} [_workflowTokensSpent]
 * @property {number} [_workflowUsdSpent]
 * @property {boolean} [_planSettled]
 * @property {number} [_planReplans]
 * @property {boolean} [_planEvalStopped]
 * @property {boolean} [_taskResume]
 */



/** Current snapshot format version; a mismatched payload is rejected on load. */
export const TASK_STATE_VERSION = 1;

const TASK_STATE_SCHEMA = { type: 'object' };


/**
 * The serializable state of one workflow (DAG) run.
 */
export class TaskState {
    /**
 * @param {{version?: number, objective?: string, context?: StateContext|Record<string, unknown>, agentContext?: Object|null, steps?: Array<StepRecord>, outputs?: Record<string, unknown>, replanCount?: number, pendingEvaluations?: Array<[string, number]>, journal?: import('../journal.mjs').ExecutionJournal|Record<string, unknown>|null, tokensSpent?: number, usdSpent?: number, planSettled?: boolean, planReplans?: number, planEvalStopped?: boolean}} arg0
 */
    constructor({ version = TASK_STATE_VERSION, objective = '', context = {}, agentContext = null, steps = [], outputs = {}, replanCount = 0, pendingEvaluations = [], journal = null, tokensSpent = 0, usdSpent = 0, planSettled = false, planReplans = 0, planEvalStopped = false } = {}) {
        this.version = version;
        this.objective = objective;
        this.context = context instanceof StateContext ? context : StateContext.fromJSON(context ?? {});
        this.agentContext = AgentContext.fromJSON(agentContext) ?? AgentContext.fromObjective({ objective });
        this.steps = Array.isArray(steps) ? steps : [];
        this.outputs = outputs ?? {};
        this.replanCount = replanCount;
        this.tokensSpent = Number.isFinite(tokensSpent) ? tokensSpent : 0;
        this.usdSpent = Number.isFinite(usdSpent) ? usdSpent : 0;
        this.pendingEvaluations = Array.isArray(pendingEvaluations) ? pendingEvaluations : [];
        this.journal = journal;
        // A plan the evaluator declared finished: a resumed run must not re-run the nodes
        // it decided to skip.
        this.planSettled = planSettled === true;
        // The plan-replan budget and a stopped evaluator ride the checkpoint too: a resume
        // must not hand the evaluator a fresh budget it already spent (N2).
        this.planReplans = Number.isFinite(planReplans) ? planReplans : 0;
        this.planEvalStopped = planEvalStopped === true;
    }

    /**
     * Shared variables as a plain object (the executor's `context` contract).
     * @returns {Record<string, unknown>}
     */
    get vars() {
        return this.context.getAll();
    }

    /**
     * Captures a live executor's cross-stage state.
     * @param {{executor: TaskStateExecutor}} arg0 - A WorkflowExecutor.
     * @returns {TaskState}
     */
    static fromExecutor({ executor }) {
        return new TaskState({
            objective: executor.globalObjective ?? '',
            context: executor.context ?? {},
            agentContext: executor._agentContext ?? null,
            steps: [...executor.steps.values()].map((s) => {
                const copy = /** @type {any} */ ({ ...s, messages: Array.isArray(s.messages) ? s.messages : [] });
                // A live AbortSignal serializes to {} and would break a resumed
                // tool call (`signal.addEventListener is not a function`).
                delete copy._stepSignal;
                // Function-valued step fields cannot travel; record that they
                // existed so a resume can say they were dropped (F4). Sticky: a
                // restored step has no function, and recomputing from the live step
                // wrote `false` over the marker the FIRST checkpoint carried, so the
                // next hop forgot the gate entirely (C-3). Only `setSteps`, which
                // re-attaches the function, clears it.
                copy.hasVerify = typeof (/** @type {any} */ (s)).verify === 'function' || (/** @type {any} */ (s)).hasVerify === true;
                copy.hasTools = (Array.isArray((/** @type {any} */ (s)).tools) && (/** @type {any} */ (s)).tools.length > 0) || (/** @type {any} */ (s)).hasTools === true;
                return copy;
            }),
            outputs: executor.outputs ?? {},
            replanCount: executor._replanCount ?? 0,
            pendingEvaluations: [...(executor._pendingEvaluations ?? new Map())],
            journal: executor._journal ?? null,
            tokensSpent: executor._workflowTokensSpent ?? 0,
            usdSpent: executor._workflowUsdSpent ?? 0,
            planSettled: executor._planSettled === true,
            planReplans: executor._planReplans ?? 0,
            planEvalStopped: executor._planEvalStopped === true,
        });
    }

    /**
     * Writes this state back onto an executor and marks it as resuming, so
     * `execute()` keeps the restored statuses/outputs instead of resetting them.
     * @template {TaskStateExecutor} T
     * @param {{executor: T}} arg0
     * @returns {T} the executor.
     */
    applyTo({ executor }) {
        executor.globalObjective = this.objective;
        executor.context = this.vars;
        executor._agentContext = this.agentContext;
        const steps = new Map(this.steps.map((s) => [s.id, s]));
        executor.steps = steps;
        for (const s of steps.values()) s._restored = true;
        executor.outputs = { ...this.outputs };
        executor._replanCount = this.replanCount;
        executor._workflowTokensSpent = this.tokensSpent;
        executor._workflowUsdSpent = this.usdSpent ?? 0;
        executor._pendingEvaluations = new Map(this.pendingEvaluations);
        if (this.journal) executor._journal = ExecutionJournal.fromJSON(this.journal);
        executor._planSettled = this.planSettled === true;
        executor._planReplans = this.planReplans ?? 0;
        executor._planEvalStopped = this.planEvalStopped === true;
        executor._taskResume = true;
        return executor;
    }

    /** @returns {TaskStateSnapshot} a plain, JSON-safe snapshot. */
    toJSON() {
        return {
            version: this.version,
            objective: this.objective,
            context: this.context.toJSON(),
            agentContext: {
                objective: this.agentContext?.objective ?? null,
                directive: this.agentContext?.directive ?? null,
                refs: this.agentContext?.refs ?? {},
                metadata: this.agentContext?.metadata ?? {},
                objectiveInitial: this.agentContext?.objectiveInitial ?? null,
                objectiveVersion: this.agentContext?.objectiveVersion ?? 0,
                objectiveHistory: this.agentContext?.objectiveHistory ?? [],
                objectivePolicy: this.agentContext?.objectivePolicy ?? null,
                objectiveTurn: this.agentContext?.objectiveTurn ?? 0,
                // D7: the delegated chain is provenance too; `fromJSON` caps it.
                parent: contextChainJSON({ ctx: this.agentContext?.parent ?? null }),
            },
            steps: this.steps,
            outputs: this.outputs,
            replanCount: this.replanCount,
            tokensSpent: this.tokensSpent,
            usdSpent: this.usdSpent,
            pendingEvaluations: this.pendingEvaluations,
            planSettled: this.planSettled === true,
            planReplans: this.planReplans ?? 0,
            planEvalStopped: this.planEvalStopped === true,
            journal: this.journal && typeof (/** @type {{toJSON?: Function}} */ (this.journal)).toJSON === 'function'
                ? /** @type {{toJSON: Function}} */ (this.journal).toJSON()
                : /** @type {Record<string, unknown>|null} */ (this.journal ?? null),
        };
    }

    /**
     * @param {string|Record<string, unknown>} json - A snapshot or its JSON string.
     * @returns {TaskState}
     */
    static fromJSON(json) {
        if (typeof json !== 'string') {
            return new TaskState(json && typeof json === 'object' ? json : {});
        }
        const parsed = validateStrict({ input: json, schema: TASK_STATE_SCHEMA });
        if (!parsed.originalValid) throw new ConfigurationError({ message: `Invalid TaskState JSON: ${parsed.error}` });
        const data = parsed.success && parsed.data && typeof parsed.data === 'object'
            ? /** @type {Record<string, unknown>} */ (parsed.data)
            : {};
        if (data.version != null && data.version !== TASK_STATE_VERSION) {
            throw new ConfigurationError({ message: `Unsupported TaskState version ${data.version} (expected ${TASK_STATE_VERSION}).` });
        }
        return new TaskState(data);
    }
}
