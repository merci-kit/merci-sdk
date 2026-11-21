// @ts-check
import { EventEmitter } from 'node:events';
import { extractAndParseJson } from '../../support/json.mjs';
import { sdkLog, sdkWarn, sdkError, truncateForPrompt, safeStringify } from '../../support/utils.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { sortDagNodes, interpolateTemplate, stringifyTemplateValue, stepFingerprint, stepFnSources, fnSourcesDiffer, assertStateSchema, ancestorIds } from './graph-utils.mjs';
import { TaskState } from './task-state.mjs';
import { ApprovalCoordinator } from './approval.mjs';
import { TodoComponent } from '../todos/component.mjs';
import { AgentContext, normalizeHandoff, goalBlockForHandoff, HANDOFF_MODERATED_MARKER, OBJECTIVE_TAG } from '../agent-context.mjs';
import { normalizeObjectivePolicy, runObjectivePass, objectiveProgressDigest } from '../objective.mjs';
import { runCriteriaChecks, runDueSteps, fallbackKind, resolveExhaustionOpts, assertNotInFlight, throwIfAborted } from '../agentic-core.mjs';
import { normalizeTransfer, renderTransfer } from '../transfer.mjs';
import { claimReplan, RetryLedger, failureFingerprint, classifyFailure } from '../loops/policy.mjs';
import { ExecutionJournal } from '../journal.mjs';
import { BudgetExceededError, ConfigurationError, OrchestrationError, isAbortError, OrchestrationExhaustedError, GraphError, OrchestrationFailedError } from '../../core/errors.mjs';
import { EVENTS, RunContext, emitEvent } from '../../core/events.mjs';
import { enterPhase, PHASES } from '../../core/lifecycle.mjs';
import { createSaveArtifactTool } from '../artifacts.mjs';
import { schemaViolation, danglingDependencies, decisionStepVerdict, decisionTokensOf } from './executor-helpers.mjs';
import { sessionGroupKey, sessionGroup, sharedSessionRows, rememberSessionRows, forgetSessionRows, applySessionContract, warnLostStepFunctions, lostStepFunctions, sharedSessionGroupKey, sessionGroupGate } from './executor-session.mjs';
import { rejectPlan, validateStepTemplates, cleanOutputs, currentPlan, assertNoDanglingDependencies, evaluatePlan, applyReplan, requeueStep, resetInvalidatedStep, planProgress } from './executor-plan.mjs';
import { executeStepNodeNaive, executeStepNodeSM, executeStepNodeDiscussion, executeStepNodeDag, recordWorkflowTokens } from './executor-strategies.mjs';

/**
 * @file WorkflowExecutor — DAG step execution + evaluator replan + HITL gates.
 * @version 0.12.0
 *
 * @description
 * Executes a planned DAG of steps (Kahn-sorted, parallel-ready), each through
 * one of three engines ('naive' fresh session, 'stateMachine' verified SM, or
 * 'discussion' swarm). Handles step failure/iteration-limit detection, the
 * evaluator-driven replan loop (bounded by maxReplanCount), operator HITL
 * gates via serializable approval ids, and model-roster validation for
 * step-level model overrides.
 */

/**
 * @param {{steps: *, limit: number|null}} arg0
 * @returns {Promise<Array<{step: Object, status: string, value?: any, reason?: any}>>}
 */
async function runDueStepsBounded({ steps, limit }) {
    if (!limit || limit <= 0 || steps.length <= limit) return runDueSteps({ steps });
    const results = /** @type {Array<any>} */ (new Array(steps.length));
    let next = 0;
    const worker = async () => {
        while (next < steps.length) {
            const i = next++;
            try {
                results[i] = { step: steps[i], status: 'fulfilled', value: await steps[i].run() };
            } catch (reason) {
                results[i] = { step: steps[i], status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, steps.length) }, worker));
    return results;
}

/**
 * The client an executor drives. Structural: the real Merci client and a test
 * double that only answers `session()` both satisfy it.
 * @typedef {Object} ExecutorClient
 * @property {Function} [session]
 * @property {Function} [sessionWithId]
 * @property {Function} [getProfiles]
 * @property {string} [provider]
 */

/** The verdict a plan evaluator returns.
 * @typedef {Object} PlanVerdict
 * @property {string} verdict
 * @property {string} [reason]
 * @property {Object} [patch]
 */

/**
 * The plan-level evaluator the executor asks at a wave boundary (PL2b).
 * @typedef {Object} PlanEvaluator
 * @property {Function} evaluate
 */

/** The verdict a step evaluator returns.
 * @typedef {Object} StepVerdict
 * @property {boolean} [replanRequired]
 * @property {string} [reason]
 */

/**
 * The step evaluator `execute()` may hand in (per-node verdicts).
 * @typedef {Object} StepEvaluator
 * @property {Function} evaluate
 */

/**
 * The planner the executor runs a nested DAG or a `decompose` node through.
 * @typedef {Object} ExecutorPlanner
 * @property {Function} [plan]
 * @property {Function} [replan]
 */

/**
 * The verify contract a step inherits from the executor: retries, criteria and
 * an optional judge. Absent parts fall back to the step's own `verify`.
 * @typedef {Object} StepVerifyContract
 * @property {number} [maxRetries]
 * @property {Array<import('../agentic-core.mjs').Criterion>} [criteria]
 * @property {Function|null} [judge]
 */

/**
 * `new WorkflowExecutor({ options })`. Every member is optional: a checkpoint
 * restore passes only what the checkpoint did not carry.
 * @typedef {Object} WorkflowExecutorOptions
 * @property {ExecutorClient|null} [client]
 * @property {string} [defaultModel]
 * @property {Array<import('../../messaging/unified-parameter.mjs').Tool|string>} [tools]
 * @property {Array<Object>|null} [contextProcessors]
 * @property {string|Object|null} [transfer] - Preset name or a partial policy.
 * @property {boolean|number|Object|null} [promptCache]
 * @property {number} [intakeArtifactThreshold]
 * @property {string} [artifactDir]
 * @property {Object|null} [memoryProvider]
 * @property {Object} [memoryOptions]
 * @property {Array<Object>|null} [skills]
 * @property {boolean} [skillsPreload]
 * @property {number} [hitlTimeoutMs]
 * @property {number} [maxIterations]
 * @property {number} [maxReplanCount]
 * @property {PlanEvaluator|null} [planEvaluator]
 * @property {number} [planEvaluateEvery]
 * @property {number} [maxPlanReplans]
 * @property {number|null} [stepTimeoutMs]
 * @property {number|null} [maxConcurrency]
 * @property {import('../budget-accounting.mjs').TokenBudget|null} [budget]
 * @property {AbortSignal|null} [signal]
 * @property {Function|null} [followUp]
 * @property {boolean|Object} [autoExtend]
 * @property {Object|null} [errorHandlers]
 * @property {string} [engine]
 * @property {number} [maxDepth]
 * @property {number} [_dagDepth]
 * @property {import('../agent-context.mjs').AgentContext|null} [agentContext]
 * @property {string} [_approvalIdPrefix]
 * @property {string} [_journalScope]
 * @property {StepVerifyContract|null} [contract]
 * @property {Array<import('../discussion-session.mjs').DiscussionAgent>} [agents]
 * @property {{callback: Function, timeoutMs?: number}|null} [approval] - The engine's approval policy (the HITL coordinator's callback).
 * @property {Partial<import('../session-policy.mjs').SessionPolicy>|null} [sessionPolicy]
 * @property {'plan'|'branch'|'step'} [sessionScope]
 * @property {string|null} [sessionSystemPrompt]
 * @property {number} [sessionHistoryMaxChars]
 * @property {boolean} [allowLostStepFunctions] - Run a resumed step whose `verify` gate (or per-step `tools`) the checkpoint could not carry instead of failing closed (C-3). Off by default: a gate that vanishes silently is a weaker plan, not an option.
 * @property {boolean} [validateTemplateRefs]
 * @property {Object|null} [stateSchema]
 * @property {Map<string|number, import('../todos/component.mjs').TodoTask>|null} [todoStore]
 * @property {Object} [todoOptions]
 * @property {import('../journal.mjs').ExecutionJournal|null} [journal]
 * @property {import('../decision-gate.mjs').DecisionGate|null} [decisionGate] - Optional System One gate for the evaluator-outage and replan seams.
 * @property {RunContext|null} [runContext] - The enclosing run (the scheduler's work-item context); `execute()` parents this run's events to it.
 */

/**
 * One conversation shared by the steps the scope groups together. The group owns
 * the system prompt, the tool set and the growing row history; a member that would
 * change the first two opens a boundary group instead.
 * @typedef {Object} GroupSession
 * @property {string} provider
 * @property {string} [model]
 * @property {Object} [eventEmitter]
 * @property {{total_tokens?: number}} [_lastRunUsage]
 * @property {Array<import('../chat-session.mjs').ChatRow>} [_lastStepMessages]
 * @property {Function} [run]
 * @property {Function} [withTools]
 * @property {Function} [withSystemMessage]
 */

/**
 * @typedef {Object} SessionGroup
 * @property {string} key
 * @property {GroupSession} session
 * @property {string|undefined} systemPrompt
 * @property {string|undefined} toolsSignature
 * @property {string|undefined} model
 * @property {string|undefined} cacheSignature
 * @property {Array<{stepId: string, rows: Array<import('../chat-session.mjs').ChatRow>}>} history
 * @property {Set<string>} members
 * @property {Set<string>} completed
 */

/**
 * @typedef {Object} WorkflowStep
 * @property {string} id
 * @property {string} [name]
 * @property {string} [title]
 * @property {string} [brief] - The acceptance statement for a plan node (PL1); `title` is the fallback.
 * @property {'work'|'gate'} [kind] - A gate node's output is evidence: completing one triggers the plan gate.
 * @property {'atomic'|'static'|'decompose'} [expansion] - How the node is planned (PL1c: `decompose` plans at run time).
 * @property {string} [systemPrompt]
 * @property {string} [userPromptTemplate]
 * @property {string[]} [dependencies]
 * @property {string|string[]} [replaces] - The step id(s) this step replaces in a replan: a dropped, evaluator-rejected step's surviving references are rewired onto this step (C-2). A patch directive, stripped once applied; never part of the installed definition.
 * @property {string} [model]
 * @property {string} [escalateModel] - Model for a retry that follows a schema or verify failure (never a transient `STEP_RETRY`); the first attempt always uses `model`.
 * @property {number} [maxIterations]
 * @property {string} [engine]
 * @property {string} [subEngine] - Engine for a nested-DAG step's child executor (default 'naive').
 * @property {string} [subObjective] - Nested-DAG objective; defaults to the resolved user prompt.
 * @property {Array<WorkflowStep>} [subSteps] - Static nested plan; when absent the child is planned from subObjective.
 * @property {string} [_childState] - Serialized nested-DAG child state (S14/R3); rides the parent checkpoint so a resume does not re-run completed child steps.
 * @property {Array<WorkflowStep>} [_decomposedSteps] - The sub-plan a `decompose` node was planned into (PL1c); rides the checkpoint so a retry or resume reuses it instead of re-planning.
 * @property {Object[]} [tools]
 * @property {string} [session] - session grouping: 'inherit' (default), 'new', or a group id.
 * @property {string[]} [intakeSteps]
 * @property {string} [intakeMode]
 * @property {string|Object} [transfer] - Cross-step transfer policy (preset name or { mode, select, compact, tail }). Defaults to the executor's.
 * @property {boolean|number|Object} [promptCache] - Prompt-cache policy for this step's session (wave 4); defaults to the executor's.
 * @property {Object} [hitl]
 * @property {number} [turns]
 * @property {Function} [verify]
 * @property {number} [maxRetries]
 * @property {Object} [autoExtend]
 * @property {Object} [errorHandlers]
 * @property {Object} [handoff]
 * @property {string} [status]
 * @property {Object|null} [output]
 * @property {Array<import('../chat-session.mjs').ChatRow>} [messages]
 * @property {Array<import('../chat-session.mjs').ChatRow>} [deltaMessages] - The rows this step ADDED (the transfer unit, D1). `messages` keeps the cumulative transcript for retry continuity.
 * @property {Record<string, number>} [usage] - Tokens this step's attempts reported (B7), summed across attempts; rides the checkpoint.
 * @property {string} [_backend] - Backend the step's rows were shaped for (set on success; guides ledger replay).
 * @property {boolean} [hasVerify] - A checkpoint could not carry this step's `verify` function; the marker rides every later checkpoint so a resume fails closed instead of running ungated (C-3).
 * @property {boolean} [hasTools] - The same, for a per-step `tools` array.
 * @property {boolean} [historical]
 * @property {boolean} [rejected] - A replanner dropped this node: the run refused its output, so it satisfies no dependency, feeds no intake, and is kept as history only (C-2). Persisted with the step record; `setSteps` clears it when the id is re-admitted.
 * @property {number} [stepTimeoutMs] - Per-step deadline (D7); falls back to the executor option.
 * @property {string} [lastArtifact] - Last assistant text a failed attempt produced (D14).
 * @property {number} [_stepStartedAt]
 * @property {boolean} [_hitlGated]
 * @property {boolean} [_timedOut]
 * @property {string} [_stepFingerprint]
 * @property {Record<string,string>} [_stepFnSources] - Source text of the definition's functions (a checkpoint drops the functions themselves).
 * @property {boolean} [_restored]
 * @property {{approvalId: string, gateEvent: string, systemPrompt: string|null, userPrompt: string|null, extensionRound: number|null}} [_hitlGate] - Pending HITL gate, persisted so a mid-gate checkpoint re-opens the SAME gate (D16).
 * @property {{approved: boolean, systemPrompt: string|null, userPrompt: string|null}} [_hitlDecision] - Step-gate decision, persisted so a crash before the output is recorded never re-asks (D16).
 * @property {Record<number, boolean>} [_iterDecisions] - Iteration-limit extension decisions by round, persisted for resume (D16).
 */

/**
 * @typedef {Object} WorkflowOutput
 * @property {Object|null} output
 * @property {Object|null} data
 */

/**
 * Marks a usage sink this module installed, so a shared planner re-binds to the
 * executor that is calling it instead of staying on the first host (W2-9).
 */
const WORKFLOW_USAGE_SINK = Symbol('merci.workflowUsageSink');

/**
 * Gives a planner or evaluator the workflow's usage sink (C-7): a planning or
 * evaluation call is real model spend. A sink the caller provided is chained
 * after ours — both run exactly once — so host metering never disables the cap
 * (W2-9). Read live, so the instance can be bound after construction; a nested
 * DAG child executor receives the parent's planner, so the planner keeps the
 * parent's binding unless that child re-binds it — the planning spend is
 * charged once, to the cap of the executor that planned under it.
 * @param {{instance: unknown, host: WorkflowExecutor}} arg0
 * @returns {void}
 */
function bindWorkflowUsage({ instance, host }) {
    if (!instance || typeof instance !== 'object') return;
    const target = /** @type {Record<string|symbol, any>} */ (instance);
    /** @type {{host: WorkflowExecutor, hostSink: ((usage: any) => void)|null}|undefined} */
    const current = target[WORKFLOW_USAGE_SINK];
    // The caller's own sink: the one present before we ever touched the field.
    const hostSink = current ? current.hostSink : (typeof target.onUsage === 'function' ? target.onUsage : null);
    if (current && current.host === host && current.hostSink === hostSink) return;
    target.onUsage = (/** @type {{total_tokens?: number, prompt_tokens?: number, completion_tokens?: number}} */ usage) => {
        // The adapter's quota object carries `spent.amount` and the two halves;
        // `total_tokens` is the test/relay shape.
        const tokens = Number(usage?.total_tokens)
            || (Number(usage?.prompt_tokens ?? 0) + Number(usage?.completion_tokens ?? 0));
        /** @type {unknown} */
        let failure = null;
        try {
            if (Number.isFinite(tokens) && tokens > 0) recordWorkflowTokens({ host, tokens });
        } catch (err) {
            failure = err;
        }
        if (hostSink) {
            // The host's metering runs once even when the cap stopped us, and
            // its own throw never replaces the budget stop.
            try { hostSink(usage); } catch (err) { if (failure === null) failure = err; }
        }
        if (failure !== null) throw failure;
    };
    // Non-enumerable so a checkpoint or a spread copy of the options is clean.
    Object.defineProperty(target, WORKFLOW_USAGE_SINK, { value: { host, hostSink }, configurable: true });
}

/**
 * Executes a DAG of steps to completion, emitting `workflow:*` events on its
 * EventEmitter. Steps can be re-planned (evaluator-rejected or failed) within
 * maxReplanCount; HITL gates resolve via resolveApproval(). Rerunnable —
 * execute() resets non-historical steps and re-runs the whole plan.
 * @extends {EventEmitter}
 */
export class WorkflowExecutor extends EventEmitter {
    /**
 * @param {{options?: WorkflowExecutorOptions}} arg0
 *   extension forwarded to each step run (naive engine); see runAgenticLoop.
 *   handlers forwarded to each step run (naive engine).
 *   (same shape as session.withApproval); gated tools inside steps otherwise fail closed.
 */
    constructor({ options = {} } = {}) {
        super();
        this.client = options.client ?? null;
        this.defaultModel = options.defaultModel;
        this.tools = options.tools || [];
        this.contextProcessors = options.contextProcessors ?? null;
        this.transfer = options.transfer ?? null;
        /** Prompt-cache policy handed to every step's session (wave 4, 4.4). */
        this.promptCache = options.promptCache ?? null;
        this.intakeArtifactThreshold = Number(options.intakeArtifactThreshold) > 0 ? Number(options.intakeArtifactThreshold) : LIMITS.intake_artifact_threshold;
        this.artifactDir = options.artifactDir || 'artifacts';
        this._artifactTool = null;
        this.memoryProvider = options.memoryProvider || null;
        this.memoryOptions = options.memoryOptions || {};
        this.skills = options.skills || null;
        this.skillsPreload = options.skillsPreload === true;
        this.hitlTimeoutMs = options.hitlTimeoutMs || LIMITS.dag_hitl_timeout_ms;
        this.maxIterations = options.maxIterations ?? LIMITS.max_iterations;
        this.maxReplanCount = options.maxReplanCount ?? LIMITS.max_replan_count;
        /**
         * The plan-level evaluator (PL2b): it sees the whole plan and where the run
         * actually is, and answers `continue` / `replan` (with a patch) / `done` /
         * `abort`. Absent by default — no evaluator, no plan gate.
         */
        this.planEvaluator = options.planEvaluator ?? null;
        /** Evaluate after this many completed nodes (a gate node always triggers one). */
        this.planEvaluateEvery = Math.max(1, Number(options.planEvaluateEvery)) || LIMITS.plan_evaluate_every;
        /** How many plan patches a single run may apply. */
        this.maxPlanReplans = Number.isInteger(Number(options.maxPlanReplans))
            ? Math.max(0, Number(options.maxPlanReplans))
            : Math.max(1, options.maxReplanCount ?? LIMITS.plan_max_replans);
        this.stepTimeoutMs = options.stepTimeoutMs ?? null;
        this.maxConcurrency = options.maxConcurrency ?? (LIMITS.plan_max_concurrency || null);
        this.budget = options.budget ?? null;
        this.signal = options.signal || null;
        this.followUp = typeof options.followUp === 'function' ? options.followUp : null;
        this.autoExtend = options.autoExtend ?? false;
        this.errorHandlers = options.errorHandlers || null;
        this.engine = options.engine || 'naive';
        this.maxDepth = options.maxDepth ?? LIMITS.dag_max_depth;
        this._dagDepth = options._dagDepth ?? 0;
        this._seedAgentContext = options.agentContext ?? null;
        /** @type {RunContext|null} */
        this._runCtxSeed = options.runContext ?? null;
        this._approvalIdPrefix = options._approvalIdPrefix ?? '';
        this._journalScope = options._journalScope ?? '';
        this.contract = options.contract || null;
        this.agents = options.agents || [];
        this._approvalPolicy = options.approval || null;
        this.sessionPolicy = options.sessionPolicy ?? null;
        const sessionScope = options.sessionScope ?? 'step';
        if (!['plan', 'branch', 'step'].includes(sessionScope)) {
            throw new ConfigurationError({ message: `WorkflowExecutor: unknown sessionScope '${String(sessionScope)}' (expected plan, branch or step).` });
        }
        /** How steps share a conversation: a plan-wide group, per branch, or per step attempt (default). */
        this.sessionScope = sessionScope;
        /** A plan-level system prompt shared by every group; each node's own prompt becomes a step focus. */
        this.sessionSystemPrompt = typeof options.sessionSystemPrompt === 'string' && options.sessionSystemPrompt.length > 0
            ? options.sessionSystemPrompt
            : null;
        /** How many characters of inherited conversation a shared group may carry. */
        this.sessionHistoryMaxChars = Number(options.sessionHistoryMaxChars) > 0
            ? Number(options.sessionHistoryMaxChars)
            : LIMITS.shared_session_history_chars;
        /**
         * Opt out of the fail-closed gate: a resumed step whose `verify` function
         * the checkpoint could not carry runs without it instead of stopping the
         * run (C-3). Off by default — a gate that vanishes silently is a weaker
         * plan, not an option.
         */
        this.allowLostStepFunctions = options.allowLostStepFunctions === true;
        this.validateTemplateRefs = options.validateTemplateRefs !== false;
        this.stateSchema = options.stateSchema ?? null;

        this.steps = /** @type {Map<string, WorkflowStep>} */ (new Map());
        this.outputs = /** @type {Record<string, WorkflowOutput>} */ ({});
        this.globalObjective = "";
        this.context = {};
        this._replanCount = 0;
        this._planReplans = 0;
        this._planEvalNoops = 0;
        this._planEvalStopped = false;
        this._planSettled = false;
        this._completedSincePlanEval = 0;
        this._taskResume = false;
        this._agentContext = null;
        this._pendingApprovals = /** @type {Map<string, ApprovalCoordinator>} */ (new Map());
        this._approvalSeq = 0;
        this._nestedApprovals = /** @type {Map<string, WorkflowExecutor>} */ (new Map());
        this._planner = /** @type {ExecutorPlanner|null} */ (null);
        this._resumingRun = false;
        this._replayedStepDecisions = /** @type {Set<string>} */ (new Set());
        this._iterReplayQueue = /** @type {Map<string, boolean[]>} */ (new Map());
        this._pendingEvaluations = /** @type {Map<string, number>} */ (new Map());
        this._verifiedIds = /** @type {Set<string>} */ (new Set());
        this._failureLedger = new RetryLedger({ perFingerprintLimit: LIMITS.plan_fingerprint_replans });
        /** Per-step decision-gate retries already spent (one per step; the replan budget still caps the run). */
        this._decisionRetries = /** @type {Map<string, number>} */ (new Map());
        /** Optional System One gate; absent by default, so the run is unchanged. */
        this.decisionGate = options.decisionGate ?? null;

        this.todoStore = options.todoStore || null;
        this._todoOptions = options.todoOptions || {};
        this._modelRosterCache = /** @type {Set<string>|null} */ (null);
        /** @type {TodoComponent|null} */
        this._todoMirrorComp = null;
        this._journal = options.journal ?? null;
        this._journalInjected = options.journal != null;
        this._workflowTokensSpent = 0;
        /** USD the backend reported for this workflow (B-2); 0 until one reports. */
        this._workflowUsdSpent = 0;
        /** How many steps the current wave will run — the cap is split
         *  between them (C2). */
        this._waveSize = 1;
        /** @type {Set<string>} */
        this._intakeWarned = new Set();
        /** @type {Map<string, SessionGroup>} */
        this._sessionGroups = new Map();
        /** @type {Map<string, Promise<unknown>>} FIFO chain per shared session group (C-1). */
        this._sessionGroupChains = new Map();
        /** @type {Map<string, number>} Monotonic per-node visit counter (isolated steps). */
        this._stepVisits = new Map();
        /** @type {Set<string>} boundary warnings already emitted this run. */
        this._sessionBoundaryWarned = new Set();
        /** @type {Map<string, number>|null} topological index for a stable history order. */
        this._sessionOrder = null;
    }

    /**
     * @param {string|symbol} event
     * @param {...Object} args
     * @returns {boolean}
     */
    emit(event, ...args) {
        try {
            return super.emit(event, ...args);
        } catch (error) {
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Listener for '${String(event)}' threw: ${/** @type {Error} */ (error).message}`] });
            try {
                super.emit(EVENTS.WORKFLOW.LISTENER_ERROR, {
                    event: String(event),
                    error: /** @type {Error} */ (error).message
                });
            } catch {   }
            return false;
        }
    }

    /** @param {WorkflowStep} node */
    async _stepModel(node) {
        return this._resolveModel({ node, requested: node.model });
    }

    /**
     * Resolves one requested model against the backend roster. The single
     * resolver both the step model and `escalateModel` go through.
     * @param {{node: WorkflowStep, requested?: string|null}} arg0
     * @returns {Promise<string>}
     */
    async _resolveModel({ node, requested }) {
        /** The executor requires a default model; the cast keeps the resolver's contract `string`. */
        const fallback = /** @type {string} */ (this.defaultModel);
        const wanted = typeof requested === 'string' ? requested : '';
        if (!wanted || wanted === fallback) return fallback;
        const client = /** @type {ExecutorClient} */ (this.client);
        if (typeof client.getProfiles !== 'function') {
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] requests model "${requested}" but the client exposes no getProfiles() — using default "${fallback}".`] });
            return fallback;
        }
        if (!this._modelRosterCache) {
            try {
                const profiles = await client.getProfiles();
                this._modelRosterCache = /** @type {Set<string>} */ (new Set((profiles || []).map((/** @type {(p: any) => any} */ ((p) => p.id)))));
            } catch (error) {
                sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Could not fetch the model roster to verify step model "${requested}" (${/** @type {Error} */ (error).message}) — using default "${fallback}".`] });
                return fallback;
            }
        }
        if (!this._modelRosterCache.has(wanted)) {
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] requests model "${requested}" which is not in the backend's model roster — using default "${fallback}".`] });
            return fallback;
        }
        return wanted;
    }

    /**
 * Loads a new step list, re-queuing steps whose definition changed (and
 * transitively their dependents) while keeping identical steps and
 * historical context steps.
 * @param {{stepsList: Array<WorkflowStep>}} arg0
 * @returns {WorkflowExecutor}
 */
    setSteps({ stepsList }) {
        if (!Array.isArray(stepsList) || stepsList.length === 0) {
            rejectPlan({ host: this, message: 'WorkflowExecutor.setSteps() received an empty plan — a workflow needs at least one step.' });
        }
        const seenIds = new Set();
        const duplicateIds = new Set();
        for (const s of stepsList) {
            if (!s || typeof s.id !== 'string' || !s.id.trim()) {
                rejectPlan({ host: this, message: 'WorkflowExecutor.setSteps() requires every step to have a non-empty string id.' });
            }
            if (seenIds.has(s.id)) duplicateIds.add(s.id);
            seenIds.add(s.id);
        }
        if (duplicateIds.size > 0) {
            rejectPlan({ host: this, message: `WorkflowExecutor.setSteps() received duplicate step ids: ${[...duplicateIds].join(', ')}.` });
        }

        const incomingIds = new Set(stepsList.map(s => s.id));
        const retainedHistorical = [];
        for (const [id, existing] of this.steps.entries()) {
            const isHistorical = existing && (existing.status === 'completed' || existing.status === 'failed');
            if (!incomingIds.has(id) && isHistorical) {
                retainedHistorical.push(existing);
            }
        }
        // C7: a dependency that names no step in the plan and no retained completed
        // step is a plan error, not a deadlock twenty tokens later. Validated here, on
        // every plan and rewrite, before anything is mutated.
        assertNoDanglingDependencies({ host: this, steps: stepsList });
        this.#assertTemplateAncestry({ steps: stepsList, retained: retainedHistorical });
        try {
            sortDagNodes({ steps: [...stepsList, ...retainedHistorical] });
        } catch (error) {
            rejectPlan({ host: this, message: `Invalid DAG plan: ${/** @type {Error} */ (error).message}` });
        }

        // N1: adding work to a settled plan reopens it — but only once the new plan has
        // passed validation, so a rejected edit leaves the settlement alone. Re-supplying
        // the same plan (the documented restore path) does not reopen it.
        if (this._planSettled && [...incomingIds].some((id) => !this.steps.has(id))) {
            this._planSettled = false;
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: ['setSteps() added work to a plan the evaluator had settled — the plan is open again.'] });
        }

        for (const s of stepsList) {
            const existing = this.steps.get(s.id);
            // The fingerprint ignores function-valued fields (a checkpoint drops
            // them); the function SOURCES decide whether a function changed.
            // Both are compared against the SAVED definition, so a plan
            // re-supplied from a checkpoint still matches — and keeps its
            // durable HITL decision (D6/D16).
            const fingerprint = stepFingerprint({ step: s });
            const fnSources = stepFnSources({ step: s });
            const restored = existing?._restored === true;
            const changed = !!existing && (
                existing._stepFingerprint !== fingerprint
                || fnSourcesDiffer({
                    saved: existing._stepFnSources ?? {},
                    next: fnSources,
                    // Across a restore a missing function is indistinguishable
                    // from a checkpoint that dropped it — the durable approval
                    // wins there. On a live re-plan it is a removal.
                    missingIsChange: !restored,
                })
            );
            // C-2: a step the run dropped is history, not a definition. Re-admitting
            // its id puts it back in the plan, so it runs: a completed status and a
            // refused output are not resurrected from history.
            const readmitted = existing?.historical === true;
            const reset = changed || readmitted;
            const restoredMatch = existing?._restored === true && !reset;
            const restoredState = restoredMatch ? {
                _hitlGate: existing._hitlGate,
                _hitlDecision: existing._hitlDecision,
                _iterDecisions: existing._iterDecisions,
                _childState: existing._childState,
                _backend: existing._backend,
                _decomposedSteps: existing._decomposedSteps,
            } : (!reset && existing ? {
                ...(existing._childState ? { _childState: existing._childState } : {}),
                ...(existing._backend ? { _backend: existing._backend } : {}),
                // A learned sub-plan belongs to the definition it was planned for; a
                // re-supplied identical plan (the documented restore path) keeps it.
                ...(existing._decomposedSteps ? { _decomposedSteps: existing._decomposedSteps } : {}),
            } : {});
            this.steps.set(s.id, {
                ...s,
                // C-3: the checkpoint's record that a function existed survives a
                // re-supplied plan that does not re-attach it. Spreading only when
                // the function is still absent is what clears the marker: setSteps
                // re-attaching `verify` (or `tools`) drops it here.
                ...(existing?.hasVerify === true && typeof s.verify !== 'function' ? { hasVerify: true } : {}),
                ...(existing?.hasTools === true && !Array.isArray(s.tools) ? { hasTools: true } : {}),
                ...restoredState,
                status: reset ? 'pending' : (existing ? existing.status : 'pending'),
                output: reset ? null : (existing ? existing.output : null),
                messages: reset ? [] : (existing ? existing.messages : []),
                // B7: a restored executor keeps the spend it already reported; a
                // changed definition starts a fresh ledger.
                ...(existing && !reset && existing.usage ? { usage: existing.usage } : {}),
                historical: false,
                _stepFingerprint: fingerprint,
                _stepFnSources: Object.keys(fnSources).length > 0 ? fnSources : (existing?._stepFnSources ?? fnSources)
            });
            if (!existing) this._mirrorStepTodo({ node: this.steps.get(s.id), status: 'pending' });
            if (reset) this.#resetInvalidatedStep({ stepId: s.id });
        }

        this._sessionOrder = null;
        const droppedIds = /** @type {Array<string>} */ ([]);
        for (const id of this.steps.keys()) {
            const existing = this.steps.get(id);
            const isHistorical = existing && (existing.status === 'completed' || existing.status === 'failed');

            if (!incomingIds.has(id) && !isHistorical) {
                droppedIds.push(id);
                this.steps.delete(id);
                delete this.outputs[id];
                this.#forgetSessionRows({ stepId: id });
            } else if (!incomingIds.has(id)) {
                this.steps.set(id, /** @type {WorkflowStep} */ ({ ...existing, historical: true }));
                this.#forgetSessionRows({ stepId: id });
            }
        }

        if (droppedIds.length > 0) {
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Plan rewrite dropped pending step(s) not present in the new plan: ${droppedIds.join(', ')}.`] });
            emitEvent({ emitter: this, name: EVENTS.WORKFLOW.STEPS_DROPPED, payload: { stepIds: droppedIds, reason: 'not_in_updated_plan' }, runContext: this._runCtx ?? null });
        }

        return this;
    }

    /**
     * The C1 rule as a plan-time error: a `{{step.output}}` reference to a step the
     * step does not depend on (transitively) would render `[UNRESOLVED: …]` at run
     * time. Checked when a plan is installed, before anything is mutated.
     * @param {{steps: Array<WorkflowStep>, retained?: Array<WorkflowStep>}} arg0
     */
    #assertTemplateAncestry({ steps, retained = [] }) {
        const graph = [...steps, ...retained].map((s) => ({ id: s.id, dependencies: s.dependencies ?? [] }));
        try {
            validateStepTemplates({
                host: this,
                steps,
                graph,
                knownIds: retained.map((s) => s.id),
                quiet: true,
                ancestryOnly: true,
            });
        } catch (error) {
            rejectPlan({ host: this, message: `Plan rejected: ${/** @type {Error} */ (error).message}` });
        }
    }

    /**
     * JSON string of the completed step outputs.
     * @returns {string}
     */
    toPayloadString() { return JSON.stringify(this.outputs); }

    /**
     * Serializes the run's cross-stage state (objective, shared context,
     * agent-context direction, step statuses/outputs, replan budget).
     * @returns {string} JSON string.
     */
    save() {
        return JSON.stringify(TaskState.fromExecutor({ executor: this }));
    }

    /**
     * Resets failed (non-historical) steps to `pending` so a resumed checkpoint can
     * retry them (C6: a checkpoint that carries a failed step aborts before
     * scheduling). Completed steps are untouched. Returns the ids reset.
     * @returns {string[]}
     */
    retryFailedSteps() {
        /** @type {string[]} */
        const ids = [];
        for (const node of this.steps.values()) {
            if (node.historical || node.status !== 'failed') continue;
            node.status = 'pending';
            node.output = null;
            node.messages = [];
            node._timedOut = false;
            delete node.lastArtifact;
            delete this.outputs[node.id];
            ids.push(node.id);
        }
        return ids;
    }

    /**
 * Rehydrates an executor from a save() JSON string. The restored instance
 * resumes with its step statuses/outputs/context intact.
 * @param {{json: string, options?: Object}} arg0
 * @returns {WorkflowExecutor}
 */
    static load({ json, options = {} }) {
        const executor = new WorkflowExecutor({ options });
        TaskState.fromJSON(json).applyTo({ executor: /** @type {any} */ (executor) });
        for (const node of executor.steps.values()) {
            if (node.status !== 'running') continue;
            if (node.historical) {
                node.status = 'failed';
                node._stepStartedAt = undefined;
                node._timedOut = false;
                continue;
            }
            node.status = 'pending';
            node._stepStartedAt = undefined;
            node._timedOut = false;
            node._hitlGated = false;
        }
        let maxApprovalSeq = -1;
        for (const node of executor.steps.values()) {
            const match = /approval_(\d+)$/.exec(node._hitlGate?.approvalId ?? '');
            if (match) maxApprovalSeq = Math.max(maxApprovalSeq, Number(match[1]));
        }
        if (maxApprovalSeq >= 0) executor._approvalSeq = Math.max(executor._approvalSeq, maxApprovalSeq + 1);
        return executor;
    }

    /**
 * Completed steps whose outputs feed this node's intake, per `intakeMode`
 * ('all' | 'dependencies' | 'some' | 'none'). Shared by the stringified
 * context block and the ledger row builder so both select the same set.
 * @param {{node: WorkflowStep}} arg0
 * @returns {Array<WorkflowStep>}
 */
    _selectIntakeTargets({ node }) {
        const mode = node.intakeMode || 'dependencies';
        if (mode === 'none') return [];
        // C-2: a dropped (rejected) step is never an intake target, whatever its status.
        const completedNodeArray = Array.from(this.steps.values()).filter(s => s.status === 'completed' && s.rejected !== true);
        if (mode === 'dependencies') {
            const depSet = new Set((node.dependencies ?? []).map(String));
            return completedNodeArray.filter(s => depSet.has(s.id));
        }
        // C1: 'all' and 'some' are bounded by the step's ANCESTORS. A parallel
        // branch that happens to finish first is not this step's input; without
        // this, a retry absorbed whatever completed while it was waiting, and the
        // same step saw different inputs depending on timing.
        const ancestors = this._ancestorIds({ node });
        if (mode === 'all') {
            if (ancestors.size === 0 && completedNodeArray.length > 0) this.#warnEmptyAllIntake({ node });
            return completedNodeArray.filter(s => ancestors.has(s.id));
        }
        if (mode === 'some') {
            const requested = (node.intakeSteps || []).map(String);
            const dropped = requested.filter((id) => !ancestors.has(id));
            if (dropped.length > 0) this.#warnDroppedIntake({ node, dropped });
            const targetSet = new Set(requested.filter((id) => ancestors.has(id)));
            return completedNodeArray.filter(s => targetSet.has(s.id));
        }
        return [];
    }

    /**
     * The transitive dependency set of a step — the only steps whose outputs it
     * may read. A sibling that finishes first is not an input (C1).
     * @param {{node: WorkflowStep}} arg0
     * @returns {Set<string>}
     */
    _ancestorIds({ node }) {
        return ancestorIds({ nodes: this.steps, dependencies: node.dependencies });
    }

    /**
     * The outputs a step may read: its ancestors only, never the live completed
     * set (C1).
     * @param {{node: WorkflowStep}} arg0
     * @returns {Record<string, WorkflowOutput>}
     */
    _outputsForNode({ node }) {
        const ancestors = this._ancestorIds({ node });
        /** @type {Record<string, WorkflowOutput>} */
        const view = {};
        for (const id of ancestors) {
            if (Object.hasOwn(this.outputs, id)) view[id] = this.outputs[id];
        }
        return view;
    }

    /**
     * Resolves which conversation a step belongs to.
     * A node annotation always wins (`'new'` opens a group, a literal joins/opens
     * one). Otherwise the scope decides: one group per plan, per branch root, per
     * step (default) or per attempt.
     * @param {{node: WorkflowStep, attempt: number}} arg0
     * @returns {string}
     */
    #sessionGroupKey({ node, attempt }) {
        return sessionGroupKey({ host: this, node, attempt });
    }

    /** @param {{key: string, node: WorkflowStep, model: string|undefined, boundary?: boolean}} arg0 */
    #sessionGroup({ key, node, model, boundary = false }) {
        return sessionGroup({ host: this, key, node, model, boundary });
    }

    /** @param {{group: SessionGroup, node: WorkflowStep}} arg0 */
    #sharedSessionRows({ group, node }) {
        return sharedSessionRows({ host: this, group, node });
    }

    /** @param {{group: SessionGroup, stepId: string, rows: any[]}} arg0 */
    #rememberSessionRows({ group, stepId, rows }) {
        return rememberSessionRows({ group, stepId, rows });
    }

    /** @param {{stepId: string}} arg0 */
    #forgetSessionRows({ stepId }) {
        return forgetSessionRows({ host: this, stepId });
    }

    /** @param {{group: SessionGroup, node: WorkflowStep, model: string|undefined, systemPrompt: string, toolsSignature: string, stepCtx?: RunContext}} arg0 */
    #applySessionContract({ group, node, model, systemPrompt, toolsSignature, stepCtx }) {
        return applySessionContract({ host: this, group, node, model, systemPrompt, toolsSignature, stepCtx });
    }

    /**
     * How many distinct conversations (and therefore cache prefixes) the last run
     * used. `1` means "one session per plan"; the per-step default reports the
     * number of steps that ran.
     * @returns {number}
     */
    get cacheGroups() {
        return this._sessionGroups.size;
    }

    /**
     * Warns when a resumed step had a `verify` gate or per-step `tools` that the
     * checkpoint could not carry (functions are not serializable). The step would
     * otherwise run with no gate at all, which silently weakens the restored plan.
     */
    #warnLostStepFunctions() {
        return warnLostStepFunctions({ host: this });
    }

    /**
     * C-3: a gate the checkpoint could not carry is missing, not optional. A
     * resumed step that would run without its `verify` gate stops the run here,
     * with a `ConfigurationError` naming the step: a one-time warning is how the
     * next checkpoint forgot the gate and the unverified output shipped.
     * `allowLostStepFunctions: true` is the documented opt-out.
     */
    #assertRestorableGates() {
        if (this.allowLostStepFunctions) return;
        // A settled plan runs nothing: its skipped nodes are not a resume hazard.
        if (this._planSettled) return;
        for (const node of this.steps.values()) {
            // A completed step is not re-run by the restore; a historical one is
            // no longer part of the plan. Only a step the resume will run needs
            // the gate it was defined with.
            if (node.historical || node.status === 'completed') continue;
            if (!lostStepFunctions({ node }).includes('verify gate')) continue;
            const err = new ConfigurationError({ message: `Step '${node.id}' was checkpointed with a verify gate, but a checkpoint cannot carry functions: the restored step has none. Call setSteps({ stepsList }) with the same plan before resuming to re-attach it, or pass allowLostStepFunctions: true to continue without the gate.` });
            this._runCtx?.emit({ emitter: this, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [node.id], reason: err.message } });
            throw err;
        }
    }

    /**
     * Warns once when `intakeMode:'all'` selects nothing because the step has no
     * ancestors (a root step) — silent emptiness hides a plan mistake.
     * @param {{node: WorkflowStep}} arg0
     */
    #warnEmptyAllIntake({ node }) {
        this._intakeWarned ??= new Set();
        const key = `${node.id}:all-empty`;
        if (this._intakeWarned.has(key)) return;
        this._intakeWarned.add(key);
        const message = `Step '${node.id}' uses intakeMode 'all' but has no ancestors; its intake is empty.`;
        sdkWarn({ prefix: 'WORKFLOW-INTAKE', args: [message] });
        emitEvent({ emitter: this, name: EVENTS.WORKFLOW.TEMPLATE_WARNING, payload: {
            stepId: node.id,
            path: 'intakeMode',
            message,
        }, runContext: this._runCtx ?? null });
    }

    /**
     * Warns once per step about declared intake steps that are not ancestors.
     * @param {{node: WorkflowStep, dropped: string[]}} arg0
     */
    #warnDroppedIntake({ node, dropped }) {
        this._intakeWarned ??= new Set();
        const key = `${node.id}:${dropped.join(',')}`;
        if (this._intakeWarned.has(key)) return;
        this._intakeWarned.add(key);
        const message = `Step '${node.id}' declares intakeSteps that are not its ancestors (${dropped.join(', ')}); their outputs are not part of its intake.`;
        sdkWarn({ prefix: 'WORKFLOW-INTAKE', args: [message] });
        emitEvent({ emitter: this, name: EVENTS.WORKFLOW.TEMPLATE_WARNING, payload: {
            stepId: node.id,
            path: 'intakeSteps',
            dropped,
            message,
        }, runContext: this._runCtx ?? null });
    }

    /**
 * @param {{node: WorkflowStep, compact?: boolean}} arg0
 */
    async _buildIntakeContextBlock({ node, compact = false }) {
        const targets = this._selectIntakeTargets({ node });
        // D2: the transfer window is a policy decision, not a handoff-mode one.
        // This path renders text, so it honours `select`/`tail` and marks the drop
        // (a summary needs rows — that is the ledger path's job).
        const policy = normalizeTransfer({ transfer: node.transfer ?? this.transfer ?? null });
        const tailLimit = policy.select === 'tail' ? policy.tail : null;
        // An explicit `tail` wins over the moderated default; `moderated` without one
        // keeps the handoff's own window.
        const effectiveTail = compact ? (tailLimit ?? LIMITS.transfer_tail_rows) : tailLimit;
        const chosen = effectiveTail != null ? targets.slice(-effectiveTail) : targets;
        const maxChars = compact ? LIMITS.upstream_inline_min_chars : LIMITS.upstream_inline_chars;
        let contextBlock = '';
        if (compact && chosen.length < targets.length) {
            contextBlock += `\n[Handoff: context compacted; showing the last ${chosen.length} of ${targets.length} upstream steps]`;
        } else if (chosen.length < targets.length) {
            // Never drop silently, whichever mode asked for the window.
            contextBlock += `\n[${policy.markerLabel}]: ${targets.length - chosen.length} earlier upstream steps omitted (not selected).`;
        }

        if (chosen.length > 0) {
            contextBlock += '\n\n=== Upstream Step Context ===';
            for (const s of chosen) {
                const full = stringifyTemplateValue({ value: s.output });
                if (this.intakeArtifactThreshold > 0 && full.length > this.intakeArtifactThreshold) {
                    try {
                        const path = await this.#saveIntakeArtifact({ node, sourceId: s.id, content: full });
                        contextBlock += `\n[Output from Step "${s.id}"]: too large to inline (${full.length} chars) — read artifact ${path}\n`;
                        continue;
                    } catch (err) {
                        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Artifact intake failed for step "${s.id}": ${String((/** @type {any} */ (err))?.message ?? err)} — inlining truncated text.`] });
                    }
                }
                contextBlock += `\n[Output from Step "${s.id}"]: \n${truncateForPrompt({ text: full, maxChars })}\n`;
            }
        }
        return contextBlock;
    }

    /**
 * Ledger-mode intake: real message rows from the selected upstream steps,
 * rendered through the shared transfer primitive. Same-backend rows replay
 * verbatim (roles + tool pairing preserved); a foreign backend — or a step
 * whose rows were never shaped for a known backend — degrades to a digest row.
 * @param {{node: WorkflowStep, provider: string}} arg0
 * @returns {Promise<Array<import('../chat-session.mjs').ChatRow>>}
 */
    async _buildIntakeRows({ node, provider }) {
        const targets = this._selectIntakeTargets({ node });
        if (targets.length === 0) return [];
        const units = targets.map(s => ({
            id: s.id,
            output: s.output,
            ...(s._backend ? { messages: s.deltaMessages ?? s.messages, provider: s._backend } : {}),
        }));
        const rendered = await renderTransfer({
            units,
            transfer: node.transfer ?? this.transfer ?? null,
            targetProvider: provider,
            maxChars: LIMITS.max_intake_output_chars,
        });
        return rendered.rows;
    }

    /**
     * Persists an oversized upstream output and returns its path. Reuses the
     * SDK artifacts tool so the intake reference and the `save_artifact` tool
     * share one directory/manifest.
     * @param {{node: WorkflowStep, sourceId: string, content: string}} arg0
     * @returns {Promise<string>}
     */
    async #saveIntakeArtifact({ node, sourceId, content }) {
        if (!this._artifactTool) {
            this._artifactTool = createSaveArtifactTool({ dir: this.artifactDir, eventEmitter: this });
        }
        return this._artifactTool.execute({ args: { name: `${node.id}__${sourceId}.txt`, content } });
    }

    /**
 * @param {{node: WorkflowStep, stepCtx?: RunContext}} arg0
 */
    async _executeStepNode({ node, stepCtx = this._runCtx }) {
        const engine = node.engine ?? this.engine;
        // PL1c: a `decompose` node is planned when it becomes runnable. The nested
        // engine already carries the depth limit, the child checkpoint and the shared
        // journal, so "plan it later" is a routing decision, not a second engine.
        if (!node.engine && node.expansion === 'decompose') return this._executeStepNodeDag({ node, stepCtx });
        if (engine === 'stateMachine') return this._executeStepNodeSM({ node, stepCtx });
        if (engine === 'discussion') return this._executeStepNodeDiscussion({ node, stepCtx });
        if (engine === 'dag') return this._executeStepNodeDag({ node, stepCtx });
        if (node.engine && engine !== 'naive') {
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] requests unknown engine "${node.engine}" — falling back to the naive engine.`] });
        }
        return this._executeStepNodeNaive({ node, stepCtx });
    }

    /** @param {{node: WorkflowStep, stepCtx?: RunContext}} arg0 */
    async _executeStepNodeNaive({ node, stepCtx = this._runCtx }) {
        // C-1: one shared conversation runs one attempt at a time. The gate opens
        // before the attempt's prompt/rows are computed and closes after the
        // history append, so a wave composes the same rows a serial run would —
        // and the shared session never sees two runs in flight. Isolated attempts
        // (the default) take no gate and stay fully parallel.
        const key = sharedSessionGroupKey({ host: this, node });
        if (key === null) return executeStepNodeNaive({ host: this, node, stepCtx });
        // W2D-4: the deadline can expire while this attempt is queued for its
        // group. `#runWithTimeout` has already recorded the failure and dropped the
        // step's signal, so starting now would spend after the deadline and without
        // that signal. The signal is taken before waiting; the attempt is refused
        // after it. The failed status stays exactly as the timeout recorded it.
        const stepSignal = /** @type {any} */ (node)._stepSignal ?? null;
        const release = await sessionGroupGate({ host: this, key });
        try {
            if (node._timedOut === true || node.status !== 'running' || stepSignal?.aborted) return;
            return await executeStepNodeNaive({ host: this, node, stepCtx });
        } finally {
            release();
        }
    }

    /** @param {{node: WorkflowStep, stepCtx?: RunContext}} arg0 */
    async _executeStepNodeSM({ node, stepCtx = this._runCtx }) {
        return executeStepNodeSM({ host: this, node, stepCtx });
    }

    /** @param {{node: WorkflowStep, stepCtx?: RunContext}} arg0 */
    async _executeStepNodeDiscussion({ node, stepCtx = this._runCtx }) {
        return executeStepNodeDiscussion({ host: this, node, stepCtx });
    }

    /** @param {{node: WorkflowStep, stepCtx?: RunContext}} arg0 */
    async _executeStepNodeDag({ node, stepCtx = this._runCtx }) {
        return executeStepNodeDag({ host: this, node, stepCtx });
    }

    /**
 * @param {{node: WorkflowStep}} arg0
 * @returns {{autoExtend?: boolean|Object, errorHandlers?: Object|null}}
 */
    _exhaustionOpts({ node }) {
        return resolveExhaustionOpts({ source: node, autoExtend: this.autoExtend, errorHandlers: this.errorHandlers });
    }

    /**
     * D6: the context a STEP may see. It is a view of the run context with its own
     * `refs`/`metadata` (deep copies), so a step that mutates them cannot reach a
     * sibling; the objective fields are snapshotted here, after the objective pass of
     * this step, and the run context keeps the live ones.
     * @returns {AgentContext|null}
     */
    _stepAgentContext() {
        return this._agentContext ? this._agentContext.snapshot() : null;
    }

    /**
 * @param {{node: WorkflowStep, preStep?: boolean, stepCtx?: RunContext|null, model?: string|null, provider?: string|null}} arg0
 * @returns {Promise<{resolvedSystem: string, resolvedUser: string, transferRows: Array<import('../chat-session.mjs').ChatRow>}>}
 */
    async _prepareStepPrompts({ node, preStep = false, stepCtx = null, model = null, provider = null }) {
        if (preStep) {
            await runObjectivePass({ p: {
                ctx: this._agentContext,
                client: this.client,
                model: /** @type {string} */ (model ?? await this._stepModel(node)),
                progress: objectiveProgressDigest({ messages: node.messages ?? [] }),
                // G5: the restatement is its own session, but it announces a
                // run-scoped id instead of an auto uuid (it used to announce one).
                sessionId: this._runCtx?.runId ? `${this._runCtx.runId}:objective` : null,
                signal: /** @type {AbortSignal|null} */ ((/** @type {any} */ (node))._stepSignal ?? this.signal ?? null),
                approval: this._approvalPolicy ?? null,
                /** @param {{outcome: *}} arg0 */
                emit: ({ outcome }) => (stepCtx ?? this._runCtx)?.emit({ emitter: this, name: EVENTS.CLIENT.OBJECTIVE_UPDATED, payload: outcome }),
            } });
        }
        // C1: interpolate against the step's ANCESTORS, not the live completed set.
        const stepOutputs = this._outputsForNode({ node });
        const knownStepIds = new Set(this.steps.keys());
        const baseSystem = interpolateTemplate({ template: node.systemPrompt ?? '', outputs: stepOutputs, stepId: node.id, emitter: this, context: this.context, known: knownStepIds });
        let resolvedUser = interpolateTemplate({ template: node.userPromptTemplate ?? '', outputs: stepOutputs, stepId: node.id, emitter: this, context: this.context, known: knownStepIds });
        const alreadyInjected = (node.messages ?? []).some((/** @type {(m: any) => boolean} */ ((m) =>
            typeof m?.content === 'string' && m.content.includes(OBJECTIVE_TAG))))
            || baseSystem.includes(OBJECTIVE_TAG);
        const handoff = normalizeHandoff({ handoff: node.handoff });
        const _ob = alreadyInjected ? '' : goalBlockForHandoff({ ctx: this._agentContext, handoff });
        // Ledger mode replaces the stringified appendix with real rows, but only
        // when the target backend is known (Phase 1: the naive engine). Other
        // engines stay on stringify until wired.
        const policy = normalizeTransfer({ transfer: node.transfer ?? this.transfer ?? null });
        const useLedger = policy.mode === 'ledger' && !!provider && handoff.context !== 'clean';
        const transferRows = useLedger ? await this._buildIntakeRows({ node, provider: /** @type {string} */ (provider) }) : [];
        const contextAppendix = (handoff.context === 'clean' || useLedger) ? '' : await this._buildIntakeContextBlock({ node, compact: handoff.context === 'moderated' });
        const moderatedNote = handoff.context === 'moderated' && _ob && !_ob.includes(HANDOFF_MODERATED_MARKER)
            ? `\n${HANDOFF_MODERATED_MARKER}` : '';
        const resolvedSystem = [baseSystem, _ob + moderatedNote].filter(Boolean).join('\n\n');
        resolvedUser = [resolvedUser, contextAppendix].filter(Boolean).join('\n\n');
        return { resolvedSystem, resolvedUser, transferRows };
    }

    /**
 * @param {{stepCtx: RunContext, gateEvent: string, payload: {systemPrompt?: string|null, userPrompt?: string|null, extensionRound?: number|null, [key: string]: unknown}, onTimeout?: Function|null, node?: WorkflowStep|null, restoredId?: string|null}} arg0
 *   on the node so it survives a checkpoint (D16).
 *   resumed gate keeps its id (D16).
 * @returns {Promise<{approved: boolean, systemPrompt?: string, userPrompt?: string, timedOut?: boolean}>}
 */
    async _openApprovalGate({ stepCtx, gateEvent, payload, onTimeout = null, node = null, restoredId = null }) {
        const approvalId = restoredId ?? `${this._approvalIdPrefix}approval_${this._approvalSeq++}`;
        const coordinator = new ApprovalCoordinator({ timeoutMs: this.hitlTimeoutMs });
        this._pendingApprovals.set(approvalId, coordinator);
        if (onTimeout) coordinator.onTimeout({ cb: onTimeout });
        if (node) {
            node._hitlGate = {
                approvalId,
                gateEvent,
                systemPrompt: payload.systemPrompt ?? null,
                userPrompt: payload.userPrompt ?? null,
                extensionRound: payload.extensionRound ?? null
            };
        }
        stepCtx.emit({ emitter: this, name: gateEvent, payload: { approvalId, timeoutMs: this.hitlTimeoutMs, ...payload } });
        try {
            const res = await coordinator.wait({ signal: (/** @type {any} */ (node))?._stepSignal ?? this.signal });
            return coordinator.timedOut ? { ...res, timedOut: true } : res;
        } finally {
            this._pendingApprovals.delete(approvalId);
            if (node && node._hitlGate?.approvalId === approvalId) delete node._hitlGate;
        }
    }

    /**
 * @param {{node: WorkflowStep, resolvedSystem: string, resolvedUser: string, stepCtx?: RunContext}} arg0
 */
    async _resolveHitl({ node, resolvedSystem, resolvedUser, stepCtx = this._runCtx }) {
        if (!node.hitl) return { system: resolvedSystem, user: resolvedUser };
        sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] requires manual verification. Intercepting.`] });
        const restored = node._hitlGate?.gateEvent === EVENTS.WORKFLOW.HITL_PENDING ? node._hitlGate : null;
        let approval = null;
        if (node._hitlDecision && this._resumingRun && !this._replayedStepDecisions.has(node.id)) {
            this._replayedStepDecisions.add(node.id);
            approval = /** @type {{approved: boolean, systemPrompt?: string, userPrompt?: string}} */ (node._hitlDecision);
            sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] HITL decision replayed from the checkpoint (approved=${approval.approved}).`] });
        }
        if (!approval) {
            // Intentional divergence (A6): kept separate from the iteration-limit
            // no-listener check — different event, error handling and return value.
            if (this.listenerCount(EVENTS.WORKFLOW.HITL_PENDING) === 0) {
                const err = new OrchestrationError({ message: `Step [${node.id}] opened a HITL gate but no listener is registered on '${EVENTS.WORKFLOW.HITL_PENDING}' — failing the step.` });
                sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [err.message] });
                /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.STEP_GATE_REJECTED, payload: { stepId: node.id, reason: 'no_listener' } });
                this._markHitlGated({ node });
                this._recordStepError({ node, err, stepCtx });
                return null;
            }
            approval = await this._openApprovalGate({ stepCtx: /** @type {RunContext} */ (stepCtx), gateEvent: EVENTS.WORKFLOW.HITL_PENDING, payload: {
                    stepId: node.id,
                    systemPrompt: restored?.systemPrompt ?? resolvedSystem,
                    userPrompt: restored?.userPrompt ?? resolvedUser
                }, onTimeout: () => {
                    /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.HITL_TIMEOUT, payload: { stepId: node.id } });
                    /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.STEP_GATE_REJECTED, payload: { stepId: node.id, reason: 'timeout' } });
                }, node, restoredId: restored?.approvalId ?? null });
        }
        const resolved = {
            system: approval.systemPrompt || restored?.systemPrompt || resolvedSystem,
            user: approval.userPrompt || restored?.userPrompt || resolvedUser
        };
        node._hitlDecision = {
            approved: !!approval.approved,
            systemPrompt: resolved.system,
            userPrompt: resolved.user
        };
        if (!approval.approved) {
            if (!(/** @type {any} */ (approval)).timedOut) {
                sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] rejected by human operator.`] });
                /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.HITL_DECLINED, payload: { stepId: node.id, reason: 'declined' } });
                /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.STEP_GATE_REJECTED, payload: { stepId: node.id, reason: 'declined' } });
            }
            this._markHitlGated({ node });
            this._recordStepError({ node, err: new OrchestrationError({ message: `Step [${node.id}] was rejected by the human operator.` }), stepCtx });
            return null;
        }
        return resolved;
    }

    /**
 * Resolves a pending HITL gate by its serializable approvalId (emitted on
 * workflow:hitl_pending / workflow:hitl_iteration_limit). The replacement
 * for the legacy coordinator-in-payload contract: subscribers call this
 * instead of holding the live ApprovalCoordinator.
 * @param {{approvalId: string, approved: boolean, details?: Record<string, unknown>}} arg0
 * @returns {boolean} true when this call decided the gate; false for
 *   unknown/already-settled ids and for a duplicate decision on a gate that
 *   already took one (idempotent, late resolutions ignored).
 */
    resolveApproval({ approvalId, approved, details = {} }) {
        // C-4: a decision is a boolean or it is a bug. The old default (`true`)
        // turned a missing field into an approval; a string "false" was coerced
        // by truthiness. Both now fail loudly before any gate is touched.
        if (typeof approved !== 'boolean') {
            throw new ConfigurationError({ message: 'WorkflowExecutor.resolveApproval requires { approved: boolean }', options: { option: 'approved' } });
        }
        const coordinator = this._pendingApprovals.get(approvalId);
        if (coordinator) {
            return coordinator.resolve({ approved, details });
        }
        for (const [prefix, child] of this._nestedApprovals) {
            const fullPrefix = `${this._approvalIdPrefix || ''}${prefix}:`;
            if (approvalId.startsWith(fullPrefix) || approvalId.startsWith(`${prefix}:`)) {
                return child.resolveApproval({ approvalId, approved, details });
            }
        }
        return false;
    }

    /** @param {{contract: StepVerifyContract|null}} arg0 */
    _buildStepVerify({ contract }) {
        if (!contract || (!contract.criteria?.length && !contract.judge)) return undefined;
        return (/** @type {(_output: Object, ctx: RunContext) => Promise<Object>} */ (async (_output, ctx) => {
            const checks = await runCriteriaChecks({ ctx, criteria: contract.criteria, judge: contract.judge, signal: this.signal });
            const failed = checks.filter(x => !x.passed);
            return {
                passed: failed.length === 0,
                evidence: failed.length ? `criteria_failed: ${failed.map(x => x.name).join(', ')}` : 'criteria_passed',
                fingerprint: failed.length ? failed.map(x => `${x.name}:${x.evidence ?? ''}`).join('|') : null
            };
        }));
    }

    /**
 * @param {{stepId: string, reason: string|undefined}} arg0
 * @returns {Object}
 */
    _claimReplan({ stepId, reason }) {
        return claimReplan({ used: this._replanCount, max: this.maxReplanCount, onExhausted: () => {
                const err = new Error(
                    `Replan limit (${this.maxReplanCount}) reached — the evaluator still rejects step [${stepId}]. Shipping the unverified output is not allowed.`
                );
                (/** @type {RunContext} */ (this._runCtx)).emit({ emitter: this, name: EVENTS.WORKFLOW.REPLAN_LIMIT, payload: { stepId } });
                (/** @type {RunContext} */ (this._runCtx)).emit({ emitter: this, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [stepId], reason: err.message } });
                throw err;
            /** @param {{next: *, label: *}} arg0 */
            }, onClaim: (/** @type {(arg0: {next: number, label: string}) => string} */ (({ next, label }) => {
                this._replanCount = next;
                (/** @type {RunContext} */ (this._runCtx)).emit({ emitter: this, name: EVENTS.WORKFLOW.REPLAN_TRIGGERED, payload: { failedStepId: stepId, reason: `${label} ${reason}` } });
                return label;
            })) });
    }

    /**
     * The guiding plan as the caller can inspect it (a deep copy).
     * @returns {import('./plan.mjs').Plan}
     */
    currentPlan() {
        return currentPlan({ host: this });
    }

    /** @param {{trigger?: string}} [arg0] @returns {Promise<'continue'|'patched'|'settled'>} */
    async #evaluatePlan({ trigger = 'wave' } = {}) {
        // C-7: the plan evaluator's call is charged to the same cap.
        bindWorkflowUsage({ instance: this.planEvaluator, host: this });
        return evaluatePlan({ host: this, trigger });
    }

    /**
     * C-8: settles the step verdicts a failed evaluator call left deferred. In
     * `retry` mode the verdict is retried while the outage budget allows; `settled`
     * and `ended` name what will never be evaluated instead — each with its own
     * reason, so a run that never settled does not claim it did (W4-3).
     * @param {{evaluator: *, planner: *, mode?: 'retry'|'settled'|'ended'}} arg0
     * @returns {Promise<boolean>} true when a replan was applied (the caller continues)
     */
    async #drainDeferredEvaluations({ evaluator, planner, mode = 'retry' }) {
        for (const [stepId, attempts] of this._pendingEvaluations) {
            throwIfAborted({ signal: this.signal, message: 'Workflow aborted.' });
            const node = this.steps.get(stepId);
            // W4-11: a step a replan dropped is history — no verdict can land on it.
            if (!node || node.status !== 'completed' || node.historical) { this._pendingEvaluations.delete(stepId); continue; }

            if (mode !== 'retry') {
                this._pendingEvaluations.delete(stepId);
                this._verifiedIds.add(stepId);
                const reason = mode === 'settled'
                    ? 'plan settled before step evaluation'
                    : `Evaluator unavailable after ${attempts} attempt(s); the run ended before the verdict`;
                (/** @type {RunContext} */ (this._runCtx)).emit({ emitter: this, name: EVENTS.WORKFLOW.VERIFICATION_SKIPPED, payload: { stepId, reason } });
                continue;
            }

            const stepOutputs = cleanOutputs({ host: this });
            let evalResult;
            try {
                evalResult = await (/** @type {{evaluate: Function}} */ (evaluator)).evaluate({ node, outputs: stepOutputs, objective: this.globalObjective, signal: this.signal, sessionId: this._runCtx?.runId ?? null });
            } catch (err) {
                const next = attempts + 1;
                if (next >= LIMITS.evaluator_outage_attempts) {
                    const dm = await decisionStepVerdict({ gate: this.decisionGate, node, outputs: stepOutputs, objective: this.globalObjective, signal: this.signal });
                    const dmTokens = decisionTokensOf({ result: dm });
                    if (dmTokens > 0) recordWorkflowTokens({ host: this, tokens: dmTokens });
                    this._pendingEvaluations.delete(stepId);
                    this._verifiedIds.add(stepId);
                    if (dm && dm.verdict === true && dm.certainty !== null && dm.certainty >= LIMITS.decision_skip_certainty) {
                        (/** @type {RunContext} */ (this._runCtx)).emit({ emitter: this, name: EVENTS.WORKFLOW.VERIFICATION_SKIPPED, payload: {
                            stepId, reason: `decision_gate_pass after evaluator outage (${next} attempts): ${/** @type {Error} */ (err).message}`
                        } });
                    } else {
                        (/** @type {RunContext} */ (this._runCtx)).emit({ emitter: this, name: EVENTS.WORKFLOW.VERIFICATION_SKIPPED, payload: {
                            stepId, reason: `Evaluator still unavailable after ${next} attempts: ${/** @type {Error} */ (err).message}`
                        } });
                        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Evaluator still down for step [${node.id}] after ${next} attempts — shipping output unverified.`] });
                    }
                } else {
                    this._pendingEvaluations.set(stepId, next);
                }
                continue;
            }
            this._pendingEvaluations.delete(stepId);
            if (evalResult.replanRequired) {
                this._claimReplan({ stepId: node.id, reason: evalResult.reason });
                await this.#applyReplan({ node, reason: evalResult.reason, planner: /** @type {{replan: Function}} */ (planner) });
                delete this.outputs[node.id];
                this.#requeueStep({ stepId: node.id, status: 'completed' });
                return true;
            }
            this._verifiedIds.add(node.id);
        }
        return false;
    }

    /** @param {{node: WorkflowStep, reason: string|undefined, planner: *}} arg0 */
    async #applyReplan({ node, reason, planner }) {
        // C-7/W2-9: the executor that asks for the plan owns the charge. A
        // planner shared with a nested DAG child (which binds it to its own
        // ledger while it runs) is re-bound here, so a late replan is charged to
        // the run that asked for it instead of the first or the last host.
        bindWorkflowUsage({ instance: planner, host: this });
        const outcome = await applyReplan({ host: this, node, reason, planner });
        // The replan classifier is a decision call too: charge it to the run cap.
        const tokens = decisionTokensOf({ result: outcome?.decision ?? null });
        if (tokens > 0) recordWorkflowTokens({ host: this, tokens });
        return outcome;
    }

    /** @param {{stepId: string, status: string}} arg0 */
    #requeueStep({ stepId, status }) {
        return requeueStep({ host: this, stepId, status });
    }

    /** @param {{stepId: string}} arg0 */
    #resetInvalidatedStep({ stepId }) {
        return resetInvalidatedStep({ host: this, stepId });
    }

    /** @returns {{completed: Array<{id: string, brief: string, output: any}>, pending: string[], failed: string[], total: number}} */
    #planProgress() {
        return planProgress({ host: this });
    }

    /**
 * @param {{node: WorkflowStep, stepCtx: RunContext, run: Function}} arg0
 * @returns {Promise<any>}
 */
    async #runWithTimeout({ node, stepCtx, run }) {
        const timeoutMs = node.stepTimeoutMs ?? this.stepTimeoutMs;
        if (!timeoutMs || timeoutMs <= 0) return run();
        let timer;
        const stepController = new AbortController();
        const onParentAbort = () => stepController.abort(this.signal?.reason);
        if (this.signal) {
            if (this.signal.aborted) onParentAbort();
            else this.signal.addEventListener('abort', onParentAbort, { once: true });
        }
        (/** @type {any} */ (node))._stepSignal = stepController.signal;
        const timeoutError = new Error(`Step [${node.id}] timed out after ${timeoutMs}ms.`);
        try {
            return await Promise.race([
                run(),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => {
                        if (node.status === 'running') {
                            this._recordStepError({ node, err: timeoutError, stepCtx });
                            node._timedOut = true;
                        }
                        stepController.abort(timeoutError);
                        reject(timeoutError);
                    }, timeoutMs);
                }),
            ]);
        } catch (error) {
            if (error === timeoutError && node.status === 'running') {
                this._recordStepError({ node, err: timeoutError, stepCtx });
                node._timedOut = true;
            }
            throw error;
        } finally {
            clearTimeout(timer);
            if (this.signal) this.signal.removeEventListener('abort', onParentAbort);
            delete (/** @type {any} */ (node))._stepSignal;
        }
    }

    /**
 * @param {{node: WorkflowStep|undefined, status: string}} arg0
 */
    _mirrorStepTodo({ node, status }) {
        if (!this.todoStore || !node || node.historical) return;
        const comp = this._todoMirrorComp ??= new TodoComponent({ store: this.todoStore });
        const id = `dag:${node.id}`;
        const action = this.todoStore.has(id) ? 'update' : 'add';
        comp.save({ args: { action, id, title: node.name ?? node.id, status } }).catch(() => {});
    }

    /**
 * @param {{node: WorkflowStep, result: Object, stepCtx?: RunContext}} arg0
 */
    _recordStepOutput({ node, result, stepCtx = this._runCtx }) {
        if (node._timedOut) return;
        // Intentional divergence (A6): parses like #schemaViolation; extracting a
        // shared 2-line parse would add a method, so it is not shorter.
        const parsedResult = extractAndParseJson({ input: /** @type {import('../../support/json.mjs').JsonSchema} */ (result) });
        const outcomeValue = parsedResult.success ? /** @type {Object|null} */ (parsedResult.data) : result;
        assertStateSchema({ schema: this.stateSchema, value: outcomeValue, label: `Step [${node.id}]` });
        delete node._hitlGate;
        delete node._hitlDecision;
        delete node._iterDecisions;
        delete node._childState;
        this._mirrorStepTodo({ node, status: 'completed' });
        node.output = result;
        node.status = 'completed';
        // Only an accepted output joins the shared conversation. A rejected or
        // failed attempt contributes nothing, so a later member can never inherit
        // an answer the verifier refused.
        const group = this._sessionGroups.get(/** @type {any} */ (node)._sessionGroupKey);
        if (group && Array.isArray(node.deltaMessages) && node.deltaMessages.length > 0) {
            this.#rememberSessionRows({ group, stepId: node.id, rows: node.deltaMessages });
            group.completed.add(node.id);
        }
        // ponytail: outputs are keyed by unique step id (setSteps rejects
        this.outputs[node.id] = {
            output: result,
            data: outcomeValue
        };
        /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.STEP_COMPLETE, payload: {
            stepId: node.id,
            output: result,
            durationMs: node._stepStartedAt ? Date.now() - node._stepStartedAt : undefined
        } });
    }

    /**
 * @param {{node: WorkflowStep, err: unknown, stepCtx?: RunContext}} arg0
 */
    _recordStepError({ node, err, stepCtx = this._runCtx }) {
        const failure = /** @type {Error & {details?: Object}} */ (err);
        if (node._timedOut) return;
        delete node._hitlGate;
        delete node._hitlDecision;
        delete node._iterDecisions;
        delete node._childState;
        // `_decomposedSteps` stays: the next attempt reuses the sub-plan instead of
        // planning the same node again (cleared only when the definition changes).
        this._mirrorStepTodo({ node, status: 'failed' });
        // Serializing a circular / BigInt `details` must not throw from inside the
        // engine's catch: that is exactly the path C4 turns into a step failure.
        const detail = failure.details ? safeStringify({ value: failure.details }) : '';
        sdkError({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] failed: ${failure.message}${detail ? ` — ${detail}` : ''}`] });
        const priorOutput = typeof node.output === 'string' && !node.output.startsWith('Error:') ? node.output : null;
        const artifact = priorOutput ?? this.#lastArtifact(node);
        node.status = 'failed';
        node.output = `Error: ${failure.message}`;
        if (artifact != null) node.lastArtifact = artifact;
        this.outputs[node.id] = {
            output: node.output,
            data: { error: failure.message, ...(artifact != null ? { artifact } : {}) }
        };
        /** @type {any} */ (stepCtx).emit({ emitter: this, name: EVENTS.WORKFLOW.STEP_ERROR, payload: {
            stepId: node.id,
            error: failure.message,
            errorDetails: failure.details || null,
            durationMs: node._stepStartedAt ? Date.now() - node._stepStartedAt : undefined
        } });
    }

    /** @param {WorkflowStep} node @returns {string|null} */
    #lastArtifact(node) {
        const messages = node.messages ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = /** @type {any} */ (messages[i]);
            if (m?.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) return m.content;
        }
        return null;
    }

    /** @param {WorkflowStep[]} nodes @returns {Record<string, WorkflowOutput>} */
    #failedOutputs(nodes) {
        return Object.fromEntries(nodes.map(n => [n.id, this.outputs[n.id] ?? { output: n.output, data: { error: String(n.output ?? '') } }]));
    }

    /**
 * @param {{node: WorkflowStep}} arg0
 */
    _markHitlGated({ node }) {
        node._hitlGated = true;
        return node;
    }

    /**
 * Executes the DAG to completion. Runs pending steps (parallel when
 * independent), applies the evaluator's verdicts (replan or defer), fails
 * loudly on unrecoverable steps, and returns the step outputs.
 * @param {{userGoal: string, planner?: ExecutorPlanner|null, evaluator?: StepEvaluator|null, context?: Object, objectiveOptions?: Object}} arg0
 * @returns {Promise<Object>} stepId → { output, data }.
 */
    async execute({ userGoal, planner = null, evaluator = null, context = {}, objectiveOptions = {} }) {
        assertNotInFlight({ flag: this._executing, label: 'WorkflowExecutor.execute() is already in flight on this instance; concurrent executions are not supported.' });
        this._executing = true;
        // The scheduler's work-item context is the parent of this run, so every
        // workflow event is reachable from the attempt that started it (SCH-22).
        this._runCtx = this._runCtxSeed ? RunContext.child(this._runCtxSeed) : new RunContext();
        try {
            return await enterPhase({ ctx: { emitter: this, runContext: this._runCtx }, phase: PHASES.WORKFLOW, fn: () => this.#executeUnlocked({ userGoal, planner, evaluator, context, objectiveOptions }) });
        } finally {
            this._executing = false;
        }
    }

    /**
 * @param {{userGoal: string, planner?: *, evaluator?: *, context?: Object, objectiveOptions?: *}} arg0
 * @returns {Promise<Object>}
 */
    async #executeUnlocked({ userGoal, planner = null, evaluator = null, context = {}, objectiveOptions = {} }) {
        this._runCtx ??= new RunContext();
        const startedAt = Date.now();
        this._planner = planner;
        // C-7: planning and evaluation are model calls too, so their reported
        // usage is charged to the workflow cap.
        bindWorkflowUsage({ instance: planner, host: this });
        bindWorkflowUsage({ instance: evaluator, host: this });
        this._nestedApprovals = /** @type {Map<string, WorkflowExecutor>} */ (new Map());
        const resuming = this._taskResume === true;
        this._resumingRun = resuming;
        // `applyTo` restores the settled flag; a fresh run below clears it.
        this._replayedStepDecisions = /** @type {Set<string>} */ (new Set());
        this._iterReplayQueue = /** @type {Map<string, boolean[]>} */ (new Map());
        if (resuming) {
            if (!this.globalObjective) this.globalObjective = userGoal;
            if (!this._agentContext) this._agentContext = this._seedAgentContext ?? AgentContext.fromObjective({ objective: this.globalObjective });
            this._agentContext.objectivePolicy ??= normalizeObjectivePolicy({ opts: objectiveOptions });
            this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.RUN_RESUMED, payload: {
                globalObjective: this.globalObjective ?? null,
                steps: this.steps.size,
                replanCount: this._replanCount ?? 0
            } });
        } else {
            this.globalObjective = userGoal;
            this.context = context;
            this._journal = this._journalInjected ? this._journal : new ExecutionJournal();
            this._agentContext = this._seedAgentContext ?? AgentContext.fromObjective({ objective: userGoal });
            this._agentContext.objectivePolicy ??= normalizeObjectivePolicy({ opts: objectiveOptions });
            this._replanCount = 0;
            this._planReplans = 0;
            this._planEvalNoops = 0;
            this._planEvalStopped = false;
            this._planSettled = false;
            this._completedSincePlanEval = 0;
            this._workflowTokensSpent = 0;
            this._workflowUsdSpent = 0;
            for (const s of this.steps.values()) {
                if (s.historical) continue;
                s.status = 'pending';
                s.output = null;
                s.messages = [];
                s._timedOut = false;
                delete s.rejected;
                delete s.lastArtifact;
                delete s._hitlGate;
                delete s._hitlDecision;
                delete s._iterDecisions;
                delete s._childState;
                // A fresh run must plan a decompose node again: its sub-plan was written
                // against the previous run's context.
                delete s._decomposedSteps;
            }
            this.outputs = {};
            this._intakeWarned = new Set();
            this._sessionGroups = new Map();
            this._sessionGroupChains = new Map();
            this._stepVisits = new Map();
            this._sessionBoundaryWarned = new Set();
            this._sessionOrder = null;
        }
        this._journal ??= new ExecutionJournal();
        this._pendingApprovals = /** @type {Map<string, ApprovalCoordinator>} */ (new Map());
        if (!resuming) this._approvalSeq = 0;
        this._verifiedIds = /** @type {Set<string>} */ (new Set());
        if (!resuming) {
            this._pendingEvaluations = /** @type {Map<string, number>} */ (new Map());
            this._failureLedger = new RetryLedger({ perFingerprintLimit: LIMITS.plan_fingerprint_replans });
        }

        if (this.steps.size === 0) {
            const err = new ConfigurationError({ message: 'WorkflowExecutor.execute() called with an empty plan — no steps to run.' });
            this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: [], reason: err.message } });
            throw err;
        }

        validateStepTemplates({ host: this, steps: Array.from(this.steps.values()) });
        if (resuming) {
            this.#warnLostStepFunctions();
            this.#assertRestorableGates();
        }

        this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.START, payload: { totalSteps: this.steps.size } });

        // A resumed run whose plan was settled must not re-run the nodes the evaluator
        // decided to skip; the flag rides the checkpoint.
        while (!this._planSettled) {
            throwIfAborted({ signal: this.signal, message: 'Workflow aborted.' });
            const allNodes = Array.from(this.steps.values());
            const pendingNodes = allNodes.filter(n => n.status === 'pending');
            const runningNodes = allNodes.filter(n => n.status === 'running');
            const failedNodes = allNodes.filter(n => n.status === 'failed' && !n.historical);

            if (failedNodes.length > 0) {
                const ids = failedNodes.map(n => n.id);
                const firstFailure = failedNodes[0]?.output ? ` (${String(failedNodes[0].output)})` : '';
                const reason = `Workflow execution halted due to failures on steps: ${ids.join(', ')}${firstFailure}`;
                const failedOutputs = this.#failedOutputs(failedNodes);
                this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.FAILED, payload: { failedSteps: ids, reason, failedOutputs } });
                throw new OrchestrationFailedError({ message: reason, options: { failedSteps: ids, failedOutputs, context: { failedSteps: ids, failedOutputs } } });
            }

            if (pendingNodes.length === 0 && runningNodes.length === 0 && this._pendingEvaluations.size > 0) {
                if (await this.#drainDeferredEvaluations({ evaluator, planner })) continue;
                // W4-3: a verdict still deferred has retries left, so the loop gives
                // it another pass instead of leaving it behind as if the plan settled.
                if (this._pendingEvaluations.size > 0) continue;
            }

            const hasUnverified = !!(evaluator && planner) && Array.from(this.steps.values()).some(n =>
                n.status === 'completed' && !n.historical && !this._verifiedIds.has(n.id) && !this._pendingEvaluations.has(n.id));
            if (pendingNodes.length === 0 && runningNodes.length === 0 && !hasUnverified) {
                break;
            }

            const runnable = pendingNodes.filter(node => {
                return (node.dependencies ?? []).every(depId => {
                    const depNode = this.steps.get(depId);
                    // C-2: a step the replanner dropped keeps its history but is
                    // `rejected` — it satisfies nothing, so its dependents stop
                    // here instead of reading (or shipping) refused evidence.
                    return depNode && depNode.status === 'completed' && depNode.rejected !== true;
                });
            });
            const stepPromises = [];

            if (runnable.length === 0 && runningNodes.length === 0 && pendingNodes.length > 0) {
                // Membership, not completion: this backstop names the edges that
                // point outside the plan at all. A dep that exists but is stuck
                // (a cycle) stays a stuck step, not a dangling one.
                const dangling = danglingDependencies({ steps: pendingNodes, knownSteps: new Set(this.steps.keys()) });
                const stuck = pendingNodes.map(n => n.id).join(', ');
                throw new GraphError({ message: `Deadlock in DAG structure: Unresolved prerequisite steps exist.`
                    + (dangling.length ? ` Dangling dependencies (not in the plan): ${dangling.join(', ')}.` : '')
                    + ` Stuck steps: ${stuck}.` });
            }

            for (const node of runnable) {
                node.status = 'running';
                this._mirrorStepTodo({ node, status: 'in_progress' });
                node._stepStartedAt = Date.now();
                const stepCtx = RunContext.child(this._runCtx);
                stepCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.STEP_START, payload: { stepId: node.id } });
                (/** @type {any} */ (stepCtx))._stepId = node.id;
                stepPromises.push({ node, stepCtx });
            }

            // The wave will run `runnable.length` steps: split the remaining token cap
            // between them so a parallel wave cannot overspend the workflow
            // budget (C2). The divisor is the wave's step count, not
            // maxConcurrency — a bounded pool starts a step later, on a
            // `remaining` that no longer covers the steps still running.
            this._waveSize = Math.max(1, runnable.length);
            const outcomes = await runDueStepsBounded({ steps: stepPromises.map(({ node, stepCtx }) => ({
                key: node.id,
                run: () => this.#runWithTimeout({ node, stepCtx, run: () => this._executeStepNode({ node, stepCtx }) }),
            })), limit: this.maxConcurrency });
            this._waveSize = 1;
            const aborted = outcomes.find(r => r.status === 'rejected' && isAbortError({ err: r.reason, signal: this.signal }));
            if (aborted) throw aborted.reason;
            const budgetExceeded = outcomes.find(r => r.status === 'rejected' && r.reason instanceof BudgetExceededError);
            if (budgetExceeded) throw budgetExceeded.reason;
            // C4: every other rejection is an engine bug that escaped its own
            // catch. It used to be discarded, leaving the node 'running' forever —
            // the scheduler's terminal check needs running === 0, so it spun.
            // Record it as a step failure so the normal failure path reports it
            // (with the step named) and the run ends. A node its engine already
            // recorded is skipped, so a failure is never recorded twice.
            for (const outcome of outcomes) {
                if (outcome.status !== 'rejected') continue;
                const node = this.steps.get(String((/** @type {any} */ (outcome.step))?.key));
                if (!node || node.status !== 'running') continue;
                const entry = stepPromises.find(p => p.node === node);
                this._recordStepError({ node, err: outcome.reason, stepCtx: entry?.stepCtx });
            }

            let replanOccurred = false;
            if (evaluator && planner) {
                const unverified = Array.from(this.steps.values()).filter(n =>
                    n.status === 'completed' && !n.historical
                    && !this._verifiedIds.has(n.id) && !this._pendingEvaluations.has(n.id));
                for (const node of unverified) {
                    if (node.status !== 'completed') continue;

                    if (fallbackKind({ text: typeof node.output === 'string' ? node.output : '' }) !== null) {
                        sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] output is an iteration-limit error — skipping evaluator replan (handled by HITL).`] });
                        this._verifiedIds.add(node.id);
                        continue;
                    }

                    const stepOutputs = cleanOutputs({ host: this });
                    let evalResult;
                    try {
                        evalResult = /** @type {StepVerdict} */ (await evaluator.evaluate({ node, outputs: stepOutputs, objective: this.globalObjective, signal: this.signal, sessionId: this._runCtx?.runId ?? null }));
                    } catch (err) {
                        const attempts = (this._pendingEvaluations.get(node.id) ?? 0) + 1;
                        this._pendingEvaluations.set(node.id, attempts);
                        this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.VERIFICATION_DEFERRED, payload: {
                            stepId: node.id,
                            attempts,
                            reason: /** @type {Error} */ (err).message
                        } });
                        sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Evaluator failed for step [${node.id}] — verdict deferred (attempt ${attempts}): ${/** @type {Error} */ (err).message}`] });
                        continue;
                    }
                    if (evalResult.replanRequired) {
                        this._claimReplan({ stepId: node.id, reason: evalResult.reason });
                        await this.#applyReplan({ node, reason: evalResult.reason, planner: /** @type {{replan: Function}} */ (planner) });
                        delete this.outputs[node.id];
                        this.#requeueStep({ stepId: node.id, status: 'completed' });
                        replanOccurred = true;
                        break;
                    }
                    this._verifiedIds.add(node.id);
                }
            }
            if (replanOccurred) continue;

            const unrecovered = runnable.filter(n => n.status === 'failed');
            if (unrecovered.length > 0) {
                const ids = unrecovered.map(n => n.id).join(', ');
                const first = unrecovered[0];
                const reason = first?.output ? String(first.output) : '';

                if (planner) {
                    let replannedAny = false;
                    for (const node of unrecovered) {
                        if (node._hitlGated) continue;
                        const failureReason = node.output ? String(node.output) : 'step failed';
                        const fingerprint = failureFingerprint({ action: node.id, signature: failureReason });
                        const count = this._failureLedger.record({ fingerprint });
                        if (!this._failureLedger.canRetry({ fingerprint })) {
                            const classification = classifyFailure({ evidence: { source: 'verification', verificationFailed: true, sameFingerprint: count > 1 } });
                            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] repeated the same ${classification} failure ${count}x — fingerprint replan budget spent, not replanning again.`] });
                            continue;
                        }
                        if (this._replanCount >= this.maxReplanCount) {
                            this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.REPLAN_LIMIT, payload: { stepId: node.id } });
                            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Replan limit (${this.maxReplanCount}) reached — step [${node.id}] cannot be replanned.`] });
                            continue;
                        }
                        this._claimReplan({ stepId: node.id, reason: failureReason });
                        await this.#applyReplan({ node, reason: failureReason, planner: /** @type {{replan: Function}} */ (planner) });
                        delete this.outputs[node.id];
                        this.#requeueStep({ stepId: node.id, status: 'failed' });
                        replannedAny = true;
                    }
                    if (replannedAny) continue;
                }

                const failMessage = reason
                    ? `Step(s) execution failed and could not be self-healed: ${ids} — ${reason}`
                    : `Step(s) execution failed and could not be self-healed: ${ids}`;
                const failedOutputs = this.#failedOutputs(unrecovered);
                this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.FAILED, payload: {
                    failedSteps: unrecovered.map(n => n.id),
                    reason: reason || `Step(s) execution failed and could not be self-healed: ${ids}`,
                    failedOutputs
                } });
                throw new OrchestrationFailedError({ message: failMessage, options: {
                    failedSteps: unrecovered.map(n => n.id),
                    failedOutputs,
                    context: { failedSteps: unrecovered.map(n => n.id), failedOutputs }
                } });
            }

            // PL2b — the plan gate: after a wave, evaluate where the run is and, on a
            // `replan` verdict, patch the guiding plan instead of discarding the wave.
            if (this.planEvaluator && !this._planSettled) {
                const completedNow = stepPromises.filter((p) => p.node.status === 'completed').length;
                this._completedSincePlanEval += completedNow;
                const gateHit = stepPromises.some((p) => p.node.status === 'completed' && p.node.kind === 'gate');
                if (gateHit || this._completedSincePlanEval >= this.planEvaluateEvery) {
                    this._completedSincePlanEval = 0;
                    const planOutcome = await this.#evaluatePlan({ trigger: gateHit ? 'gate' : 'wave' });
                    if (planOutcome === 'settled') {
                        // C-8: the settle ends the loop, so a deferred verdict is named
                        // here rather than left behind in the pending map.
                        await this.#drainDeferredEvaluations({ evaluator, planner, mode: 'settled' });
                        break;
                    }
                    if (planOutcome === 'patched') continue;
                }
            }
        }

        // C-8/W4-3: a verdict still deferred when the loop ends is named, and the
        // reason tells the truth — a run whose plan never settled does not claim it.
        await this.#drainDeferredEvaluations({ evaluator, planner, mode: this._planSettled ? 'settled' : 'ended' });

        const stepsCompleted = Array.from(this.steps.values()).filter(s => s.status === 'completed').length;
        const stepsFailed = Array.from(this.steps.values()).filter(s => s.status === 'failed' && !s.historical).length;
        this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.END, payload: {
            stepsCompleted,
            stepsFailed,
            replans: this._replanCount,
            planReplans: this._planReplans,
            planSettled: this._planSettled,
            pendingSteps: this._planSettled ? this.#planProgress().pending : [],
            durationMs: Date.now() - startedAt
        } });

        // The resume flag is consumed only by a run that finishes: any failure —
        // including the failed-step abort that fires before scheduling — leaves the
        // instance resumable, so retryFailedSteps() followed by execute() continues
        // the restored run instead of silently starting over and discarding the
        // restored journal/replan budget (C5/F1).
        this._taskResume = false;
        return this.outputs;
    }
}
