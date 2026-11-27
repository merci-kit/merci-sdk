// @ts-check
import { EventEmitter } from 'node:events';
import { StateContext } from './context.mjs';
import { createRequire } from 'node:module';
import { compileConditionScript } from './condition-vm.mjs';
import { evaluateCondition } from './condition-evaluator.mjs';
import { AgentContext, normalizeHandoff, goalBlockForHandoff, OBJECTIVE_TAG, resolveHandoffTools } from '../agent-context.mjs';
import { RUN_STATE_MACHINE_TOOL_NAME } from '../../core/constants/capability.mjs';
import { getSmPlanSchema, SM_PLAN_PROMPT } from '../../core/prompts.mjs';
import { throwIfAborted, runCriteriaChecks, runDueSteps, isSdkFallbackOutput, resolveExhaustionOpts, fallbackKind, isTransientFallbackKind, assertNotInFlight, assertVerifyVerdict } from '../agentic-core.mjs';
import { runStep } from '../step.mjs';
import { normalizeTransfer, renderTransfer } from '../transfer.mjs';
import { ExecutionJournal } from '../journal.mjs';
import { sdkWarn, safeStringify, strictStringify, stringifyTemplateValue, walkPath } from '../../support/utils.mjs';
import { FailureClass, classifyFailure, claimReplan, failureFingerprint } from '../loops/policy.mjs';
import { ConfigurationError, OrchestrationExhaustedError, VerificationError, isAbortError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { EVENTS, RunContext } from '../../core/events.mjs';
import { remainingBudget } from '../budget-accounting.mjs';
import { noulQuestion } from '../../messaging/decision.mjs';

const require = createRequire(import.meta.url);

/**
 * @file StateMachine — verified node graph execution.
 * @version 0.12.0
 *
 * @description
 * Executes a graph of nodes with conditional transitions and cycles, sharing a
 * StateContext across steps. Nodes are LLM calls or JS `execute` functions;
 * optional `verify` gates re-run a node by failure fingerprint. `plan()` lets
 * the LLM design the graph; `replan()` regenerates it after a failed
 * hypothesis while preserving the context. Also exports the `run_state_machine`
 * tool factory and the condition-expression compiler.
 */
/**
 * @typedef {Object} SMNode
 * @property {string} id
 * @property {string} [name]
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [userPromptTemplate]
 * @property {number} [maxIterations]
 * @property {number} [maxVisits]
 * @property {number} [timeoutMs] - Wall-clock cap for one node attempt (the losing attempt is abandoned, not aborted).
 * @property {Object[]} [tools]
 * @property {boolean} [terminal]
 * @property {Function} [execute]
 * @property {Function} [verify]
 * @property {Object} [handoff]
 * @property {Object} [autoExtend]
 * @property {Object} [errorHandlers]
 * @property {string|Object} [transfer] - Cross-node transfer policy (preset name or { mode, select, compact, tail }). Defaults to the machine's.
 * @property {boolean|number|Object} [promptCache] - Prompt-cache policy for this node's session (wave 4); defaults to the machine's.
 */

/**
 * @typedef {Object} SMEdge
 * @property {string} from
 * @property {string} to
 * @property {Function|string|null} [condition]
 */

/**
 * @typedef {Object} SMGraph
 * @property {string} entry
 * @property {Array<SMNode>} nodes
 * @property {Array<SMEdge>} edges
 */

/**
 * A node graph machine with conditional transitions. Nodes share a
 * StateContext; each step runs the current node, resolves the transition and
 * emits `state_machine:*` events (node lifecycle, verify verdicts, replan,
 * completion). See save()/load() for durable checkpoints.
 * @extends {EventEmitter}
 */
export class StateMachine extends EventEmitter {
  /** @type {SMGraph} */
  #graph;
  #ctx;
  /** @type {string|null} */
  #current;
  /** @type {string|null} The node that ended the run with no matching transition (D-4). */
  #implicitTerminal = null;
  /** @type {Map<string, number>} */
  #visited;
  /** @type {Array<Object>} */
  #history;
  #phase;
  #client;
  #maxSteps;
  #defaultModel;
  #contract;
  #stateSchema;
  #contextProcessors;
  /** Per-node attempts consumed by the verify loop (persisted for resume). */
  #verifyAttempts = new Map();
  /** D-6: one step or run in flight; a second caller is refused, not doubled. */
  #stepBusy = false;
  #maxContextEntries;
  #replanCount;
  #maxReplanCount;
  #objective;
  /** Optional System One gate: a confident verdict can stand in for a verify. */
  #decisionGate;
  #objectiveInjected;
  #agentContext;
  #handoff;
  #approvalPolicy;
  /** @type {{maxTotalTokens: number}|null} */
  #budget = null;
  #sessionPolicy;
  #usageTokens = 0;
  /** USD the backend reported for this machine's nodes (B-2). */
  #usageUsd = 0;
  #memoryProvider;
  #memoryOptions;
  #skills;
  #skillsPreload;
  #todoStore;
  #todoOptions;
  #autoExtend;
  #errorHandlers;
  /** @type {ExecutionJournal|null} */
  #journal;
  #journalScope;
  #transfer;
  /** Prompt-cache policy for every node's session (wave 4, 4.4). */
  #promptCache = null;
  /** @type {Map<string, Array<any>>} Node message rows captured for ledger replay. */
  #nodeMessages = new Map();
  /** @type {Map<string, Array<any>>} The rows each node ADDED (the transfer unit, D1). */
  #nodeDelta = new Map();
  /** @type {Map<string, Array<any>>} A failed attempt's transcript, kept ONLY for its retry (A3).
   * Separate from `#nodeMessages` so a re-entered node id can never replay it as a transfer unit. */
  #retryRows = new Map();
  /** @type {Map<string, string>} The feedback that rejected the stashed attempt, so a RESUMED
   * retry still knows why it is revising (persisted with the stash). */
  #retryFeedback = new Map();
  /** @type {Map<string, string>} Backend each node's rows were shaped for. */
  #nodeBackend = new Map();

  /**
 * @param {{graph: Object, options?: Object}} arg0
 *   (same shape as session.withApproval).
 *   extension for node runs; a node's own `autoExtend` field wins if set.
 *   handlers for node runs; a node's own `errorHandlers` wins if set.
 *   ({ goal, context, tools }); a node's own `handoff` wins if set.
 */
  constructor({ graph, options = {} }) {
    super();
    const clonedGraph = graph && typeof graph === 'object' ? {
      ...graph,
      nodes: Array.isArray((/** @type {any} */ (graph)).nodes) ? (/** @type {any} */ (graph)).nodes.map((/** @type {any} */ n) => (n && typeof n === 'object' ? { ...n } : n)) : (/** @type {any} */ (graph)).nodes,
      edges: Array.isArray((/** @type {any} */ (graph)).edges) ? (/** @type {any} */ (graph)).edges.map((/** @type {any} */ e) => (e && typeof e === 'object' ? { ...e } : e)) : (/** @type {any} */ (graph)).edges,
    } : graph;
    validateGraph({ g: /** @type {SMGraph} */ (clonedGraph) });
    this._runCtx = new RunContext();
    this.#graph = /** @type {SMGraph} */ (clonedGraph);
    this.#ctx = new StateContext({ initial: /** @type {any} */ (options).context ?? {} });
    this.#current = (/** @type {SMGraph} */ (graph)).entry;
    this.#visited = new Map();
    this.#history = [];
    this.#phase = 'idle';
    this.#client = /** @type {any} */ (options).client;
    this.#defaultModel = /** @type {any} */ (options).defaultModel ?? /** @type {any} */ (options).model ?? this.#graph.nodes[0]?.model;
    if (/** @type {any} */ (options).maxIterations !== undefined) {
      throw new ConfigurationError({ message: 'StateMachine: "maxIterations" was renamed to "maxSteps" (the machine-wide node-visit budget). '
        + 'A node\'s session tool-loop turns stay on `node.maxIterations`.', options: { option: 'maxSteps' } });
    }
    this.#maxSteps = /** @type {any} */ (options).maxSteps ?? LIMITS.max_machine_steps;
    this.#contract = /** @type {any} */ (options).contract ?? null;
    this.#stateSchema = /** @type {any} */ (options).stateSchema ?? null;
    this.#contextProcessors = /** @type {any} */ (options).contextProcessors ?? null;
    this.#maxContextEntries = /** @type {any} */ (options).maxContextEntries ?? LIMITS.machine_max_context_entries;
    this.#replanCount = 0;
    this.#maxReplanCount = /** @type {any} */ (options).maxReplanCount ?? LIMITS.max_replan_count;
    this.#objective = /** @type {any} */ (options).objective ?? null;
    this.#decisionGate = /** @type {any} */ (options).decisionGate ?? null;
    this.#objectiveInjected = /** @type {any} */ (options).objectiveInjected === true;
    this.#agentContext = /** @type {any} */ (options).agentContext ?? null;
    this.#approvalPolicy = /** @type {any} */ (options).approval ?? null;
    this.#sessionPolicy = /** @type {any} */ (options).sessionPolicy ?? null;
    this.#budget = /** @type {any} */ (options).budget ?? null;
    this.#handoff = /** @type {any} */ (options).handoff ?? null;
    this.#transfer = /** @type {any} */ (options).transfer ?? null;
    this.#promptCache = /** @type {any} */ (options).promptCache ?? null;
    this.#journal = /** @type {any} */ (options).journal ?? new ExecutionJournal();
    this.#journalScope = /** @type {any} */ (options).journalScope ?? '';
    this.#memoryProvider = /** @type {any} */ (options).memoryProvider ?? null;
    this.#memoryOptions = /** @type {any} */ (options).memoryOptions ?? {};
    this.#skills = /** @type {any} */ (options).skills ?? null;
    this.#skillsPreload = /** @type {any} */ (options).skillsPreload === true;
    this.#todoStore = /** @type {any} */ (options).todoStore ?? null;
    this.#todoOptions = /** @type {any} */ (options).todoOptions ?? {};
    this.#autoExtend = /** @type {any} */ (options).autoExtend ?? false;
    this.#errorHandlers = /** @type {any} */ (options).errorHandlers ?? null;
  }

  /** Machine phase: 'idle' | 'running' | 'done' | 'error' | 'failed' | 'escalated'. */
  get phase() { return this.#phase; }
  /** The current node id. */
  get current() { return this.#current; }
  /** The node the run ended on with no matching transition (D-4), or null. */
  get implicitTerminal() { return this.#implicitTerminal; }
  /** Tokens reported by node sessions so far (run-level budget accounting). */
  get usageTokens() { return this.#usageTokens; }
  /** The execution journal this machine charges (used to persist intent, G1-1). */
  get journal() { return this.#journal; }
  /** USD the backend reported so far (0 when it reports none). */
  get usageUsd() { return this.#usageUsd; }
  /** The shared StateContext. */
  get context() { return this.#ctx; }
  /** Steps taken, oldest first. */
  get history() { return this.#history; }
  /** A copy of node-id → visit-count. */
  get visited() { return new Map(this.#visited); }
  /** A copy of the graph (entry, nodes, edges). */
  get graph() { return { entry: this.#graph.entry, nodes: this.#graph.nodes.map(n => ({ ...n })), edges: this.#graph.edges.map(e => ({ ...e })) }; }

  /**
 * Adds a node to the graph.
 * @param {{nodeDef: SMNode}} arg0
 * @returns {StateMachine}
 */
  addNode({ nodeDef }) {
    if (!nodeDef || !nodeDef.id) throw new ConfigurationError({ message: 'StateMachine.addNode: node requires id' });
    if (this.#getNode(nodeDef.id)) throw new ConfigurationError({ message: `StateMachine.addNode: node "${nodeDef.id}" already exists` });
    this.#graph.nodes.push({ ...nodeDef });
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_ADDED, payload: { nodeId: nodeDef.id } });
    return this;
  }

  /**
 * Removes a node and its incident edges (not allowed for the current node).
 * @param {{nodeId: string}} arg0
 * @returns {StateMachine}
 */
  removeNode({ nodeId }) {
    if (this.#current === nodeId) throw new ConfigurationError({ message: `StateMachine.removeNode: cannot remove current node "${nodeId}"` });
    const idx = this.#graph.nodes.findIndex(n => n.id === nodeId);
    if (idx === -1) throw new ConfigurationError({ message: `StateMachine.removeNode: node "${nodeId}" not found` });
    this.#graph.nodes.splice(idx, 1);
    this.#graph.edges = this.#graph.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_REMOVED, payload: { nodeId } });
    return this;
  }

  /**
 * Adds a directed edge between existing nodes.
 * @param {{edgeDef: SMEdge}} arg0
 * @returns {StateMachine}
 */
  addEdge({ edgeDef }) {
    if (!edgeDef || !edgeDef.from || !edgeDef.to) throw new ConfigurationError({ message: 'StateMachine.addEdge: edge requires from and to' });
    if (!this.#getNode(edgeDef.from)) throw new ConfigurationError({ message: `StateMachine.addEdge: source "${edgeDef.from}" not found` });
    if (!this.#getNode(edgeDef.to)) throw new ConfigurationError({ message: `StateMachine.addEdge: target "${edgeDef.to}" not found` });
    const edge = { ...edgeDef };
    const c = edge.condition;
    if (typeof c === 'string') {
      edge.condition = compileCondition({ src: c });
    } else if (c !== undefined && c !== null) {
      if (typeof c !== 'function') {
        throw new ConfigurationError({ message: `StateMachine: edge "${edge.from}"→"${edge.to}" condition must be a string expression or function, got ${typeof c}`, options: { option: 'condition' } });
      }
      if (c.constructor?.name === 'AsyncFunction') {
        throw new ConfigurationError({ message: 'StateMachine: edge condition must be synchronous', options: { option: 'condition' } });
      }
    }
    this.#graph.edges.push(edge);
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.EDGE_ADDED, payload: { from: edge.from, to: edge.to } });
    return this;
  }

  /**
 * Removes the edge from `from` to `to`.
 * @param {{from: string, to: string}} arg0
 * @returns {StateMachine}
 */
  removeEdge({ from, to }) {
    const initLen = this.#graph.edges.length;
    this.#graph.edges = this.#graph.edges.filter(e => !(e.from === from && e.to === to));
    if (this.#graph.edges.length === initLen) throw new ConfigurationError({ message: `StateMachine.removeEdge: edge "${from} → ${to}" not found` });
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.EDGE_REMOVED, payload: { from, to } });
    return this;
  }

  /**
 * Builds a machine whose graph is LLM-planned from an objective.
 * @param {{client: Object, objective: string, options?: Object}} arg0
 * @returns {Promise<StateMachine>}
 */
  static async planned({ client, objective, options = {} }) {
    const sm = new StateMachine({
      graph: { entry: '_unplanned', nodes: [{ id: '_unplanned', execute: () => {} }], edges: [] },
      options: { ...options, client },
    });
    await sm.plan({ objective, options });
    return sm;
  }

  /**
 * Replaces the graph with an LLM-planned one for the objective (retrying
 * until validateGraph passes), and resets the machine to a fresh run. Refused
 * while a run or step is in flight (W4-8): replacing the graph under a step
 * leaves the step writing its old node into the new graph.
 * @param {{objective: string, options?: Object}} arg0
 * @returns {Promise<StateMachine>}
 */
  async plan({ objective, options = {} }) {
    assertNotInFlight({ flag: this.#stepBusy || this.#phase === 'running', label: 'StateMachine.plan() cannot replace the graph while a run or step is in flight.' });
    if (!this.#client) throw new ConfigurationError({ message: 'StateMachine.plan: client is required' });
    const model = /** @type {any} */ (options).model ?? this.#defaultModel;
    if (!model) throw new ConfigurationError({ message: 'StateMachine.plan: model is required' });
    const rawAttempts = /** @type {any} */ (options).maxPlanAttempts;
    const maxAttempts = Number.isFinite(rawAttempts) && rawAttempts >= 1 ? Math.floor(rawAttempts) : LIMITS.machine_plan_attempts;
    const { structuredLlmCall } = require('../planning/planner-utils.mjs');
    const { validateTemplateRefs } = require('../planning/graph-utils.mjs');
    let plan;
    for (let attempt = 1; ; attempt++) {
      plan = await structuredLlmCall({
        client: this.#client, model,
        systemMessage: 'You are an expert StateMachine planner. Design a graph of nodes and edges with conditional transitions. Cycles are allowed.',
        schema: getSmPlanSchema(),
        prompt: SM_PLAN_PROMPT({ objective, toolsList: /** @type {any} */ (options).tools || [] }),
        label: `Planning SM for: "${objective}"`,
        signal: /** @type {any} */ (options).signal,
      });
      try {
        for (const e of plan.edges) {
          if (typeof e.condition === 'string') e.condition = compileCondition({ src: e.condition });
        }
        validateGraph({ g: plan });
        const { unknown } = validateTemplateRefs({ steps: plan.nodes, contextRoots: ['context'] });
        if (unknown.length > 0) {
          throw new ConfigurationError({ message: `StateMachine plan has unknown template reference(s): ${unknown.map(u => `'{{${u.expr}}}' in node '${u.stepId}'`).join(', ')}` });
        }
        break;
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        sdkWarn({ prefix: 'STATE-MACHINE', args: [`Planner validation failed (attempt ${attempt}/${maxAttempts}): ${/** @type {Error} */ (err).message} — retrying`] });
      }
    }
    this.#graph = plan;
    this.#current = plan.entry;
    // D-7: a replan keeps the visit guard and the history of the nodes the new
    // plan still has; only a fresh plan starts them empty. Handing a looping node
    // a new visit budget on every replan is how the cycle guard was defeated.
    const preserve = /** @type {any} */ (options)._preserveContext === true;
    /** @type {Set<string>|null} */
    let survivingIds = null;
    if (preserve) {
      survivingIds = new Set();
      for (const n of /** @type {Array<{id: string}>} */ (plan.nodes)) survivingIds.add(n.id);
    }
    this.#visited = survivingIds ? keepNodes({ map: this.#visited, ids: survivingIds }) : new Map();
    this.#history = survivingIds ? this.#history.filter((/** @type {any} */ h) => survivingIds.has(h.nodeId)) : [];
    // W4-9: a surviving node keeps its spent verify attempts — resetting them here
    // gave every replan a fresh retry budget and defeated the bound.
    this.#verifyAttempts = survivingIds ? keepNodes({ map: this.#verifyAttempts, ids: survivingIds }) : new Map();
    this.#implicitTerminal = null;
    this.#phase = 'idle';
    if (!preserve) {
      this.#ctx = new StateContext();
      this.#nodeMessages.clear();
      this.#nodeDelta.clear();
      this.#nodeBackend.clear();
      this.#retryRows.clear();
      this.#retryFeedback.clear();
      this.#replanCount = 0;
      if (this.#journal) {
        // A replan starts a fresh journal (new attempt), but the durability sink
        // must survive it or the next tool intent is never persisted (G1-1).
        const sink = (/** @type {any} */ (this.#journal)).onBegin ?? null;
        (/** @type {any} */ (this.#journal)).clear?.();
        this.#journal = new ExecutionJournal();
        this.#journal.onBegin = sink;
      }
    } else if (survivingIds) {
      // W4-10: a node the new plan dropped must not leave a transcript or a retry
      // prompt behind for an id the plan later re-admits — that reads as if the
      // new first attempt had already failed.
      this.#nodeMessages = keepNodes({ map: this.#nodeMessages, ids: survivingIds });
      this.#nodeDelta = keepNodes({ map: this.#nodeDelta, ids: survivingIds });
      this.#retryRows = keepNodes({ map: this.#retryRows, ids: survivingIds });
      this.#retryFeedback = keepNodes({ map: this.#retryFeedback, ids: survivingIds });
    }
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.PLANNED, payload: { nodeCount: plan.nodes.length, edgeCount: plan.edges.length } });
    return this;
  }

  /**
   * JSON string of the current StateContext.
   * @returns {string}
   */
  toPayloadString() { return this.#ctx.toPayloadString(); }

  /**
 * Executes one node: runs it (with optional verify-driven retries), resolves
 * the transition and returns the step outcome. Refused while another step or a
 * run is in flight (D-6): a concurrent step would execute the same node twice.
 * @param {{signal?: AbortSignal, followUp?: Function}} arg0
 * @returns {Promise<{done: boolean, from: string|null, to: string|null, nodeId: string, verified: boolean}>}
 */
  async step({ signal, followUp } = {}) {
    assertNotInFlight({ flag: this.#stepBusy, label: 'StateMachine.step() is already in flight; concurrent steps are not supported.' });
    this.#stepBusy = true;
    try {
      return await this.#stepOnce({ signal, followUp });
    } finally {
      this.#stepBusy = false;
    }
  }

  /**
 * The single-step path, shared by `step()` and each `run()` iteration.
 * @param {{signal?: AbortSignal, followUp?: Function}} arg0
 * @returns {Promise<{done: boolean, from: string|null, to: string|null, nodeId: string, verified: boolean}>}
 */
  async #stepOnce({ signal, followUp } = {}) {
    throwIfAborted({ signal, message: 'StateMachine aborted.' });
    const node = this.#getNode(this.#current);
    if (!node) throw new ConfigurationError({ message: `Unknown node: "${this.#current}"` });

    const visits = (this.#visited.get(node.id) ?? 0) + 1;
    if (visits > (node.maxVisits ?? LIMITS.max_visits_per_node)) {
      this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.CYCLE_LIMIT, payload: { nodeId: node.id, maxVisits: node.maxVisits } });
      throw new OrchestrationExhaustedError({ message: `Node "${node.id}" visited ${visits} times (max ${node.maxVisits ?? LIMITS.max_visits_per_node})`, options: { limit: node.maxVisits ?? LIMITS.max_visits_per_node } });
    }
    this.#visited.set(node.id, visits);

    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_START, payload: { nodeId: node.id, visitCount: visits } });

    const { result, verified } = await this.#executeNodeWithVerify({ node, signal, followUp });

    const next = this.#resolveTransition(node.id);
    const terminal = node.terminal === true || !next;
    const implicitTerminal = terminal && node.terminal !== true;
    if (implicitTerminal) {
      // D-4: the warning rides the run emitter (a host with no `onEvent` does
      // not see it); DONE always names the node.
      this.#implicitTerminal = node.id;
      this._runCtx.emit({ emitter: this, name: EVENTS.CLIENT.WARNING, payload: {
        code: 'IMPLICIT_TERMINAL',
        message: `Node "${node.id}" is not marked terminal but no transition was taken — treating it as terminal.`
      } });
    }

    this.#history.push({ nodeId: node.id, visitCount: visits, enteredAt: Date.now(), output: result, to: next, verified });
    const prev = this.#current;
    // D-5: a terminal node leaves nothing to run next, even when a transition is
    // declared — otherwise the pointer walks past the end and a re-run continues.
    this.#current = terminal ? null : next;

    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_END, payload: { nodeId: node.id, from: prev, to: next, terminal, implicitTerminal, verified, context: this.#ctx.getAll() } });

    return { done: terminal, from: prev, to: next, nodeId: node.id, verified };
  }

  /**
 * Runs the machine to a terminal node (bounded by maxSteps), then runs
 * the completion gate (contract criteria/judge) when configured. A failed
 * gate marks phase='failed'; iteration exhaustion throws.
 * @param {{signal?: AbortSignal, followUp?: Function, contract?: Object|null, runContext?: RunContext}} arg0
 * @returns {Promise<StateContext>}
 */
  async run({ signal, followUp, contract, runContext } = {}) {
    assertNotInFlight({ flag: this.#stepBusy || this.#phase === 'running', label: 'StateMachine.run() is already in flight; concurrent runs are not supported.' });
    // D-5: a finished machine has nothing left to run; stepping it again would
    // either execute stale nodes or destroy the terminal phase.
    if (this.#phase === 'done' || this.#phase === 'failed') {
      throw new ConfigurationError({ message: `StateMachine.run() cannot run a machine in phase '${this.#phase}' — call replan() to start a new attempt.`, options: { option: 'phase' } });
    }
    const previousContract = this.#contract;
    if (contract) {
      this.#contract = contract;
    }
    const previousRunCtx = this._runCtx;
    if (runContext) this._runCtx = RunContext.child(runContext);
    this.#stepBusy = true;
    try {
    const c = this.#contract;
    // A fresh run must not report a previous run's dead end on DONE.
    this.#implicitTerminal = null;
    this.#phase = 'running';
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.START, payload: { entry: this.#graph.entry, nodeCount: this.#graph.nodes.length, maxSteps: this.#maxSteps } });

    try {
      for (let i = 0; i < this.#maxSteps; i++) {
        const { done } = await this.#stepOnce({ signal, followUp });
        if (done) { this.#phase = 'done'; break; }
      }
    } catch (err) {
      if (this.#phase === 'running') this.#phase = 'error';
      throw err;
    }

    if (this.#phase !== 'done') {
        this.#phase = 'error';
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.ERROR, payload: { message: `Exceeded maxSteps (${this.#maxSteps})` } });
        throw new OrchestrationExhaustedError({ message: `StateMachine exceeded maxSteps (${this.#maxSteps})`, options: { limit: this.#maxSteps } });
    }

    if (c && (c.criteria?.length || c.judge)) {
      let checks;
      try {
        checks = await this.#runCompletionGate({ c, signal });
      } catch (err) {
        this.#phase = 'error';
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.ERROR, payload: { message: String(/** @type {Error} */ (err)?.message ?? err) } });
        throw err;
      }
      const verified = checks.every(x => x.passed);
      if (!verified) {
        this.#phase = 'failed';
        const failedNames = checks.filter(x => !x.passed).map(x => x.name);
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.FAILED, payload: { reason: `Acceptance criteria not met: ${failedNames.join(', ')}`, checks } });
        return this.#ctx;
      }
      this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.COMPLETED, payload: { verified, checks, finalContext: this.#ctx.getAll() } });
    }

    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.DONE, payload: { finalContext: this.#ctx.getAll(), stepsTaken: this.#history.length, implicitTerminal: this.#implicitTerminal } });
    return this.#ctx;
    } finally {
      this.#stepBusy = false;
      if (contract) this.#contract = previousContract;
      if (runContext) this._runCtx = previousRunCtx;
    }
  }

  /**
 * Replan after a failed hypothesis: emits the failure, then regenerates the
 * graph while PRESERVING #ctx — completed nodes stay visible to the new plan
 * as context (the SM's branch-invalidation equivalent). Caller catches the
 * verification error from run()/step() and resumes with replan() + run().
 * @param {{objective: string, failedNodeId?: string, reason?: string, evidence?: string, model?: string, tools?: Array<Object>, signal?: AbortSignal}} arg0
 * @returns {Promise<StateMachine>}
 */
  async replan({ objective, failedNodeId, reason = '', evidence = '', model, tools, signal }) {
    // W4-8: a listener-driven replan mid-run would reset the graph under the step
    // in flight; refuse before claiming a replan or emitting the failure.
    assertNotInFlight({ flag: this.#stepBusy || this.#phase === 'running', label: 'StateMachine.replan() cannot replace the graph while a run or step is in flight.' });
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.REPLAN_REQUIRED, payload: { failedNodeId, reason, evidence } });
    claimReplan({ used: this.#replanCount, max: this.#maxReplanCount, onExhausted: () => {
        this.#phase = 'error';
        const err = new Error(`StateMachine exceeded maxReplanCount (${this.#maxReplanCount})`);
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.ERROR, payload: { message: err.message } });
        throw err;
      /** @param {{next: *}} arg0 */
      }, onClaim: (/** @type {(arg0: {next: number}) => any} */ (({ next }) => {
        this.#replanCount = next;
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.REPLAN_ATTEMPT, payload: { attempt: next, maxReplanCount: this.#maxReplanCount } });
      })) });
    const prompt = (reason || evidence || failedNodeId)
      ? `${objective}\n\nA previous attempt failed at node "${failedNodeId ?? '?'}": ${reason}\nEvidence: ${evidence}\nDesign a revised plan that avoids repeating this failure. Completed work is preserved in the shared context and may be reused.`
      : objective;
    await this.plan({ objective: prompt, options: { model, tools, signal, _preserveContext: true } });
    return this;
  }

  /**
   * Serializes the full machine state (phase, current, visited, history,
   * context, retry ledger) for durable checkpoints. Throws past
   * `safe_stringify_max_nodes` instead of writing a truncated checkpoint.
   * @returns {string} JSON string.
   */
  save() {
    return strictStringify({ value: {
      phase: this.#phase === 'running' ? 'idle' : this.#phase,
      current: this.#current,
      visited: [...this.#visited],
      history: this.#history,
      context: this.#ctx.getAll(),
      verifyAttempts: [...this.#verifyAttempts],
      nodeMessages: [...this.#nodeMessages],
      nodeDelta: [...this.#nodeDelta],
      retryRows: [...this.#retryRows],
      retryFeedback: [...this.#retryFeedback],
      nodeBackend: [...this.#nodeBackend],
      replanCount: this.#replanCount,
      usageTokens: this.#usageTokens,
      usageUsd: this.#usageUsd,
      implicitTerminal: this.#implicitTerminal,
      objective: this.#objective,
      objectiveInjected: this.#objectiveInjected,
      agentContext: this.#agentContext ? {
        objective: this.#agentContext.objective ?? null,
        directive: this.#agentContext.directive ?? null,
        refs: this.#agentContext.refs ?? {},
        metadata: this.#agentContext.metadata ?? {},
        objectiveInitial: this.#agentContext.objectiveInitial ?? null,
        objectiveVersion: this.#agentContext.objectiveVersion ?? 0,
        objectiveHistory: this.#agentContext.objectiveHistory ?? [],
        objectivePolicy: this.#agentContext.objectivePolicy ?? null,
        objectiveTurn: this.#agentContext.objectiveTurn ?? 0,
        parent: this.#agentContext.parent ?? null,
      } : null,
      handoff: this.#handoff,
      journal: this.#journal?.toJSON?.() ?? null,
    } });
  }

  /**
 * Restores a machine from a save() JSON string. The retry ledger is restored
 * too so a resumed machine keeps its fingerprint budget.
 * @param {{json: string, graph: Object, options?: Object}} arg0
 * @returns {StateMachine}
 */
  static load({ json, graph, options = {} }) {
    const d = JSON.parse(json);
    const sm = new StateMachine({ graph, options });
    const phase = d.phase === 'running' ? 'idle' : (d.phase || 'idle');
    // W2C-2: a failed/error checkpoint is a retryable attempt, and its saved
    // `current` is null after the terminal node. Start the attempt over from the
    // entry with a fresh visit budget; the journal (at-most-once for tool
    // effects) and the history stay. A `done` checkpoint keeps its phase so the
    // runner can answer completed without stepping it.
    const retryable = phase === 'failed' || phase === 'error';
    sm.#phase = retryable ? 'idle' : phase;
    sm.#current = retryable ? sm.#graph.entry : d.current;
    sm.#visited = retryable ? new Map() : new Map(d.visited);
    sm.#history = d.history;
    sm.#ctx = StateContext.fromJSON(d.context);
    sm.#replanCount = d.replanCount ?? 0;
    sm.#usageTokens = Number.isFinite(d.usageTokens) ? d.usageTokens : 0;
    sm.#usageUsd = Number.isFinite(d.usageUsd) ? d.usageUsd : 0;
    // D-4: a checkpoint written before this field existed has no dead end.
    sm.#implicitTerminal = typeof d.implicitTerminal === 'string' ? d.implicitTerminal : null;
    if (d.verifyAttempts) sm.#verifyAttempts = new Map(d.verifyAttempts);
    if (d.nodeMessages) sm.#nodeMessages = new Map(d.nodeMessages);
    // A checkpoint written before wave 2 has no `nodeDelta`: the old cumulative
    // `nodeMessages` is then replayed as the unit (verbose, never wrong). The
    // format carries no version field, so absence must stay meaningful.
    if (d.nodeDelta) sm.#nodeDelta = new Map(d.nodeDelta);
    // A checkpoint written before wave 3 has no `retryRows`: its first retry after
    // a resume degrades to the pre-wave prompt (no failed answer) instead of leaking.
    if (d.retryRows) sm.#retryRows = new Map(d.retryRows);
    if (d.retryFeedback) sm.#retryFeedback = new Map(d.retryFeedback);
    if (d.nodeBackend) sm.#nodeBackend = new Map(d.nodeBackend);
    if (d.objective !== undefined) sm.#objective = d.objective;
    if (d.objectiveInjected !== undefined) sm.#objectiveInjected = d.objectiveInjected === true;
    if (d.agentContext) sm.#agentContext = AgentContext.fromJSON(d.agentContext);
    if (d.handoff !== undefined) sm.#handoff = d.handoff;
    if (d.journal) sm.#journal = ExecutionJournal.fromJSON(d.journal);
    sm._runCtx.emit({ emitter: sm, name: EVENTS.STATE_MACHINE.LOAD_RESUMED, payload: {
      phase: sm.#phase,
      historyLength: sm.#history.length,
      verifyAttempts: [...sm.#verifyAttempts]
    } });
    return sm;
  }

  /** @param {string|null} id */
  #getNode(id) { return this.#graph.nodes.find(n => n.id === id); }

  /**
 * @param {{node: SMNode, signal?: AbortSignal|undefined, followUp?: Function|undefined}} arg0
 */
  async #executeNodeWithVerify({ node, signal, followUp }) {
    const maxRetries = this.#contract?.maxRetries ?? LIMITS.default_retry_limit;
    let lastFingerprint = null;
    let attempts = this.#verifyAttempts.get(node.id) ?? 0;
    /** @type {string|null} */
    let lastFeedback = this.#retryFeedback.get(node.id) ?? null;
    while (true) {
      attempts++;
      this.#verifyAttempts.set(node.id, attempts);
      let result;
      const attemptController = node.timeoutMs ? new AbortController() : null;
      const attemptSignal = attemptController ? attemptController.signal : signal;
      const onParentAbort = attemptController && signal
        ? () => (/** @type {AbortController} */ (attemptController)).abort(signal.reason)
        : null;
      if (attemptController && signal) {
        if (signal.aborted) onParentAbort?.();
        else if (onParentAbort) signal.addEventListener('abort', onParentAbort, { once: true });
      }
      try {
        const attemptRun = runDueSteps({ steps: [{
          key: node.id,
          run: () => node.execute
            ? node.execute(this.#ctx, { client: this.#client, machine: this, signal: attemptSignal })
            : this.#callLLM({ node, signal: attemptSignal, followUp, verifyFeedback: lastFeedback ?? undefined, isRetry: attempts > 1 }),
        }] });
        const [attemptOutcome] = attemptController
          ? await this.#raceTimeout({ promise: attemptRun, ms: /** @type {number} */ (node.timeoutMs), nodeId: node.id, controller: attemptController })
          : await attemptRun;
        if (attemptOutcome.status === 'rejected') throw attemptOutcome.reason;
        result = attemptOutcome.value;
      } catch (err) {
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_ERROR, payload: { nodeId: node.id, error: /** @type {Error} */ (err).message } });
        throw err;
      } finally {
        if (onParentAbort && signal) signal.removeEventListener('abort', onParentAbort);
      }

      if (isSdkFallbackOutput({ text: result })) {
        const kind = fallbackKind({ text: result });
        if (isTransientFallbackKind({ kind })) {
          const maxVisits = node.maxVisits ?? LIMITS.max_visits_per_node;
          if ((this.#visited.get(node.id) ?? 0) >= maxVisits) {
            this.#phase = 'escalated';
            const reason = `Node "${node.id}" exhausted maxVisits (${maxVisits}) across verification retries`;
            this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NO_PROGRESS, payload: { nodeId: node.id, classification: FailureClass.NO_PROGRESS, attempts, reason: 'maxVisits' } });
            this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.ESCALATED, payload: { nodeId: node.id, reason } });
            throw new OrchestrationExhaustedError({ message: `Node "${node.id}" failed verification (${FailureClass.NO_PROGRESS}): ${reason}`, options: { limit: maxVisits } });
          }
          if (attempts <= maxRetries) {
            this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.VERIFY_RETRY, payload: {
              nodeId: node.id,
              attempt: attempts,
              retries: attempts,
              evidence: `${kind === 'schema' ? 'schema-validation' : 'empty-response'} fallback (transient) — retrying`,
              classification: FailureClass.NO_PROGRESS
            } });
            lastFeedback = kind === 'schema'
              ? 'Your previous attempt did not match the required output schema. Return only the JSON object matching the schema.'
              : 'Your previous attempt returned no text. Produce the final answer now.';
            this.#visited.set(node.id, (this.#visited.get(node.id) ?? 0) + 1);
            continue;
          }
        }
        const err = /** @type {OrchestrationExhaustedError & { fallbackKind?: string }} */ (
          new OrchestrationExhaustedError({ message: `Node "${node.id}" produced an SDK fallback (no usable output).` }));
        err.fallbackKind = kind ?? 'max_iterations';
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_ERROR, payload: { nodeId: node.id, error: err.message } });
        throw err;
      }

      let schemaErr = null;
      if (result !== undefined) {
        // ponytail: a stateSchema violation is a synthetic verify failure so the
        // existing bounded loop retries it with feedback; invalid state is never stored.
        const { stateSchemaViolation } = require('../planning/graph-utils.mjs');
        schemaErr = stateSchemaViolation({ schema: this.#stateSchema, value: result, label: `Node "${node.id}"` });
        if (!schemaErr) this.#ctx.set({ k: node.id, v: result });
      }

      const verifyFn = node.verify;
      // Intentional divergence (A7): guards the field *type* (`verify` must be a
      // function), distinct from `assertVerifyVerdict`'s verdict-*shape* guard below.
      if (verifyFn !== undefined && verifyFn !== null && typeof verifyFn !== 'function') {
        throw new ConfigurationError({ message: `StateMachine: node "${node.id}" verify must be a function`, options: { option: 'verify' } });
      }
      let v = schemaErr
        ? { passed: false, evidence: schemaErr.message, fingerprint: null }
        : (typeof verifyFn === 'function' ? await this.#runVerify({ node, result, signal }) : null);
      // A gate may only stand in for an ABSENT verify: an explicit check always wins.
      if (!v) v = await this.#decisionVerify({ node, result, signal });
      if (!v) { this.#verifyAttempts.delete(node.id); return { result, verified: true }; }

      if (v.passed) {
        this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.VERIFY_PASS, payload: { nodeId: node.id, evidence: v.evidence } });
        this.#verifyAttempts.delete(node.id);
        return { result, verified: true };
      }

      const fingerprint = v.fingerprint || failureFingerprint({ action: node.id, input: String(result ?? ''), signature: v.evidence });
      const sameFingerprint = fingerprint === lastFingerprint;
      lastFingerprint = fingerprint;
      const classification = classifyFailure({ evidence: { source: 'verification', verificationFailed: true, sameFingerprint } });
      const capHit = attempts > maxRetries;
      const stopClass = capHit ? FailureClass.NO_PROGRESS : classification;

      this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.VERIFY_FAIL, payload: { nodeId: node.id, evidence: v.evidence, fingerprint, classification, retries: attempts, attempts } });
      if (result !== undefined) {
        // A3 — the retry needs this attempt's transcript, but a transfer unit must
        // not. Stash it under the retry channel and keep the unit maps clean: a
        // later node that reuses this id without running (a checkpoint resumed with
        // an `execute` node) must not replay the failed attempt to its siblings.
        const failedRows = this.#nodeMessages.get(node.id);
        if (Array.isArray(failedRows) && failedRows.length > 0) this.#retryRows.set(node.id, failedRows);
        // The feedback is part of what a RESUMED retry needs: `attempts` survives a
        // checkpoint, so the retry can start in a new process with no local state.
        if (typeof v.evidence === 'string') this.#retryFeedback.set(node.id, v.evidence);
        this.#ctx.delete({ k: node.id });
        this.#nodeMessages.delete(node.id);
        this.#nodeDelta.delete(node.id);
        this.#nodeBackend.delete(node.id);
      }

      if (!capHit) {
        const maxVisits = node.maxVisits ?? LIMITS.max_visits_per_node;
        if ((this.#visited.get(node.id) ?? 0) >= maxVisits) {
          this.#phase = 'escalated';
          const reason = `Node "${node.id}" exhausted maxVisits (${maxVisits}) across verification retries`;
          this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NO_PROGRESS, payload: { nodeId: node.id, fingerprint, retries: attempts, classification: FailureClass.NO_PROGRESS, attempts, reason: 'maxVisits' } });
          this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.ESCALATED, payload: { nodeId: node.id, reason, evidence: v.evidence, fingerprint } });
          throw new OrchestrationExhaustedError({ message: `Node "${node.id}" failed verification (${FailureClass.NO_PROGRESS}): ${reason}`, options: { limit: maxVisits } });
        }
        // A repeated fingerprint plus a confident "will not converge" ends the
        // retry loop early: it falls through to the one final VerificationError.
        if (sameFingerprint && attempts >= 2 && await this.#decisionNoProgress({ node, evidence: v.evidence, fingerprint, attempts, signal })) {
          v = { ...v, evidence: `${v.evidence} (decision gate: retry unlikely to converge)` };
        } else {
          this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.VERIFY_RETRY, payload: { nodeId: node.id, attempt: attempts, retries: attempts, evidence: v.evidence, classification } });
          lastFeedback = v.evidence;
          this.#visited.set(node.id, (this.#visited.get(node.id) ?? 0) + 1);
          continue;
        }
      }

      this.#phase = 'escalated';
      this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NO_PROGRESS, payload: { nodeId: node.id, fingerprint, retries: attempts, classification: stopClass, attempts } });
      this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.ESCALATED, payload: {
        nodeId: node.id,
        reason: `Node "${node.id}" failed verification (${stopClass}) after ${attempts} attempt(s)`,
        evidence: v.evidence,
        fingerprint
      } });
      throw new VerificationError({ message: `Node "${node.id}" failed verification (${stopClass}): ${v.evidence}`, options: {
        nodeId: node.id,
        classification: stopClass,
        evidence: v.evidence,
        fingerprint,
        attempts
      } });
    }
  }

  /**
 * @param {{node: SMNode, result: any, signal?: AbortSignal|undefined}} arg0
 */
  async #runVerify({ node, result, signal }) {
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.VERIFY_START, payload: { nodeId: node.id } });
    let v;
    try {
      v = await (/** @type {Function} */ (node.verify))(result, this.#ctx, signal);
    } catch (err) {
      if (isAbortError({ err })) throw err;
      const message = `verify threw: ${(/** @type {Error} */ (err)).message}`;
      this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.NODE_ERROR, payload: { nodeId: node.id, error: message } });
      return { passed: false, evidence: message, fingerprint: null };
    }
    assertVerifyVerdict({ verdict: v, label: `StateMachine: node "${node.id}"` });
    return { passed: !!v.passed, evidence: v.evidence ?? '', fingerprint: v.fingerprint ?? null };
  }

  /**
   * Stands in for an absent `node.verify` when a decision gate is configured.
   * Only a confident verdict is used; an escalation/error returns null, which
   * keeps the node verified-by-default.
   * @param {{node: SMNode, result: any, signal?: AbortSignal|undefined}} arg0
   * @returns {Promise<{passed: boolean, evidence: string, fingerprint: string|null}|null>}
   */
  async #decisionVerify({ node, result, signal }) {
    if (!this.#decisionGate?.available) return null;
    // Only an LLM node has a directive to judge. A bookkeeping `execute` node
    // (no systemPrompt) or a node with no output keeps today's verified-by-default.
    if (result === undefined || typeof node.systemPrompt !== 'string' || node.systemPrompt === '') return null;
    this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.VERIFY_START, payload: { nodeId: node.id } });
    const dm = await this.#decisionGate.gate({
      state: { nodeId: node.id, directive: node.systemPrompt ?? node.id, objective: this.#objective ?? null, output: result },
      question: noulQuestion({ instructions: 'Does this node output satisfy the node directive and the run objective?', criteria: { true: 'The output satisfies the directive and the objective.', false: 'The output misses the directive, is empty, or contradicts the objective.' } }),
      signal,
    });
    if (dm.escalated || dm.certainty === null || dm.certainty < LIMITS.decision_skip_certainty) return null;
    if (dm.verdict === true) return { passed: true, evidence: 'decision_gate_pass', fingerprint: null };
    return { passed: false, evidence: `decision_gate_fail (certainty ${Number(dm.certainty).toFixed(2)})`, fingerprint: 'decision_gate_fail' };
  }

  /**
   * True when a repeated failure will not converge on a retry (a confident gate
   * "no"). Any escalation keeps today's bounded retry.
   * @param {{node: SMNode, evidence: string, fingerprint: string, attempts: number, signal?: AbortSignal|undefined}} arg0
   * @returns {Promise<boolean>}
   */
  async #decisionNoProgress({ node, evidence, fingerprint, attempts, signal }) {
    if (!this.#decisionGate?.available) return false;
    const dm = await this.#decisionGate.gate({
      state: { nodeId: node.id, directive: node.systemPrompt ?? node.id, evidence, fingerprint, attempts },
      question: noulQuestion({ instructions: 'The same verification failure has repeated; is another retry likely to converge?', criteria: { true: 'The next attempt can plausibly pass.', false: 'The next attempt will fail the same way.' } }),
      signal,
    });
    return !dm.escalated && dm.verdict === false && dm.certainty !== null && dm.certainty >= LIMITS.decision_skip_certainty;
  }

  /**
 * @param {{c: *, signal: AbortSignal|undefined}} arg0
 */
  async #runCompletionGate({ c, signal }) {
    return runCriteriaChecks({ ctx: this.#ctx, criteria: c.criteria, judge: c.judge, judgeOnPass: true, signal });
  }

  /**
 * Races an attempt against `node.timeoutMs`; the timer is always cleared and
 * the losing attempt is aborted (a timeout must not leave a live agent run
 * spending tokens or producing side effects after the machine moved on).
 * @param {{promise: Promise<any>, ms: number, nodeId: string, controller: AbortController}} arg0
 * @returns {Promise<any>}
 */
  async #raceTimeout({ promise, ms, nodeId, controller }) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new OrchestrationExhaustedError({ message: `Node "${nodeId}" timed out after ${ms}ms`, options: { limit: ms } });
        controller.abort(err);
        reject(err);
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} fromId */
  #resolveTransition(fromId) {
    const edges = this.#graph.edges.filter(e => e.from === fromId);
    for (const e of edges) {
      if (e.condition === undefined || e.condition === null) return e.to;
      if (typeof e.condition === 'string') {
        e.condition = compileCondition({ src: e.condition });
      }
      if (typeof e.condition === 'function') {
        try {
          const res = e.condition(this.#ctx);
          // D-1: never probe a value a *sandbox* produced (a string condition
          // now yields a primitive boolean). A host function is trusted, so a
          // thenable it returns is a forgotten `await` and must be refused —
          // `res instanceof Promise` alone let a custom thenable read as true.
          if (isThenable({ value: res })) {
            if (res instanceof Promise) res.catch(() => {});
            throw new ConfigurationError({ message: 'StateMachine: edge condition must be synchronous', options: { option: 'condition' } });
          }
          if (res) return e.to;
        } catch (err) {
          this._runCtx.emit({ emitter: this, name: EVENTS.STATE_MACHINE.CONDITION_EVAL_ERROR, payload: {
            nodeId: fromId,
            from: fromId,
            error: /** @type {Error} */ (err).message
          } });
          throw err;
        }
      }
    }
    return null;
  }

  /**
   * The budget the next node may spend: the machine-level cap minus the
   * tokens already reported by previous nodes. Without this decrement every
   * node received the full cap and a 10-node machine could spend 10x it.
   * @returns {import('../budget-accounting.mjs').TokenBudget|null}
   */
  #nodeBudget() {
    return remainingBudget({
      budget: this.#budget,
      spent: this.#usageTokens,
      spentUsd: this.#usageUsd,
      emit: ({ usage, maxTotalTokens, maxBudgetUsd }) => this._runCtx.emit({ emitter: this, name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxTotalTokens, maxBudgetUsd } }),
    });
  }

  /**
 * @param {{node: SMNode, signal?: AbortSignal|undefined, followUp?: Function|undefined, verifyFeedback?: string|undefined, isRetry?: boolean}} arg0
 */
  async #callLLM({ node, signal, followUp, verifyFeedback, isRetry = false }) {
    const nodeModel = node.model || this.#defaultModel;
    if (!nodeModel) throw new ConfigurationError({ message: `StateMachine: node "${node.id}" has no model and no defaultModel` });
    const handoff = normalizeHandoff({ handoff: node.handoff ?? this.#handoff });
    const fullCtx = handoff.context === 'full';
    // Ledger mode replaces the stringified context view with real message rows
    // from the nodes completed so far. Returns null (keep the default view) when
    // ledger is not requested, the handoff is clean, or the backend is unknown.
    const transfer = node.transfer ?? this.#transfer ?? null;
    const ledgerRows = await this.#buildLedgerRows({ node, transfer, model: nodeModel, clean: handoff.context === 'clean' });
    const useLedger = ledgerRows !== null;
    // A3 — a verify retry must see what it is revising. The failed attempt's
    // transcript is stashed in `#retryRows` (never in `#nodeMessages`, so a node
    // id that re-enters the context without running cannot replay it as a unit).
    // Gated on the retry FLAG, not on the feedback string: a verdict may carry no
    // evidence (`{passed:false}`), and the failed answer must still be visible.
    const attemptRows = isRetry ? (this.#retryRows.get(node.id) ?? []) : [];
    const priorMessages = attemptRows.length > 0 ? attemptRows : (ledgerRows ?? []);
    const userText = node.userPromptTemplate
      ? this.#interpolate({ template: node.userPromptTemplate, nodeId: node.id })
      : (handoff.context === 'clean' || useLedger)
        ? 'Execute your task.'
        : `Current working state:\n${safeStringify({ value: fullCtx ? this.#ctx.getAll() : this.#ctxView() })}\n\nExecute your task.`;
    const objectiveBlock = this.#objective && !this.#objectiveInjected && handoff.goal !== 'clean'
      && !userText.includes(OBJECTIVE_TAG)
      ? goalBlockForHandoff({ ctx: this.#objective, handoff })
      : '';
    const systemPrompt = [this.#interpolate({ template: node.systemPrompt ?? '', nodeId: node.id }), objectiveBlock].filter(Boolean).join('\n\n');
    // A5 — tools resolve through the one helper (a node's own list is the
    // 'inherit' fallback) instead of a hand-rolled ternary per module.
    const nodeTools = resolveHandoffTools({ handoff, fallback: node.tools ?? [] }) ?? [];
    const agentContext = handoff.goal === 'clean' ? null
      : (this.#agentContext ?? (this.#objective ? AgentContext.fromObjective({ objective: this.#objective }) : null));
    const exhaustion = resolveExhaustionOpts({ source: node, autoExtend: this.#autoExtend, errorHandlers: this.#errorHandlers });

    const outcome = await runStep({ step: node, deps: {
      client: this.#client,
      model: nodeModel,
      decisionGate: this.#decisionGate,
      journal: this.#journal,
      journalBoundary: `${this.#journalScope}${node.id}:v${this.#visited.get(node.id) ?? 0}:`,
      systemPrompt,
      userText,
      priorMessages,
      tools: nodeTools,
      handoff,
      agentContext,
      contextProcessors: this.#contextProcessors,
      capabilities: handoff.tools === 'none' ? null : {
        skills: this.#skills,
        skillsPreload: this.#skillsPreload,
        memoryProvider: this.#memoryProvider,
        memoryOptions: this.#memoryOptions,
        todoStore: this.#todoStore,
        todoOptions: this.#todoOptions,
      },
      approvalPolicy: this.#approvalPolicy,
      sessionPolicy: this.#sessionPolicy,
      budget: this.#nodeBudget(),
      promptCache: node.promptCache ?? this.#promptCache,
      signal,
      followUp,
      autoExtend: exhaustion.autoExtend ?? false,
      errorHandlers: exhaustion.errorHandlers ?? null,
      maxIterations: node.maxIterations ?? LIMITS.max_iterations,
      verifyFeedback,
      runContext: this._runCtx,
      // F2: adopt the run id, so `session:start` and every later event agree
      // (the task path already does this; the SM path was the one that did not).
      sessionId: this._runCtx?.runId ?? null,
      emitter: this,
      toolEvents: true,
      events: {
        text: EVENTS.STATE_MACHINE.NODE_TEXT,
        thought: EVENTS.STATE_MACHINE.NODE_THOUGHT,
        thoughtSignature: EVENTS.STATE_MACHINE.NODE_THOUGHT_SIGNATURE,
        streamEnd: EVENTS.STATE_MACHINE.NODE_STREAM_END,
        toolStart: EVENTS.WORKFLOW.STEP_TOOL_CALL_START,
        toolEnd: EVENTS.WORKFLOW.STEP_TOOL_CALL_END,
        /** @param {{content: *}} arg0 */
        makePayload: ({ content }) => ({ nodeId: node.id, content }),
      },
    } }).catch((err) => {
        // A thrown attempt still spent tokens: step.mjs attaches the session's
        // usage to the error. Charge it, then let the node fail — the budget must
        // see what the attempt cost, exactly as a verify-failed attempt does.
        // The whole attempt (`runUsage`), else whatever the error carried.
        const charged = /** @type {any} */ (err)?.runUsage ?? /** @type {any} */ (err)?.usage;
        this.#usageTokens += Number(charged?.total_tokens) || 0;
        this.#usageUsd += Number(charged?.cost_usd) || 0;
        throw err;
    });
    this.#usageTokens += Number(outcome.usage?.total_tokens) || 0;
    this.#usageUsd += Number(outcome.usage?.cost_usd) || 0;
    const { result, messages, deltaMessages, provider } = outcome;
    this.#nodeMessages.set(node.id, messages);
    // The unit a downstream node replays is only what THIS node added. Replaying
    // the whole transcript re-carried every upstream unit (D1: a 3-node chain
    // sent 7 rows where 5 suffice).
    this.#nodeDelta.set(node.id, Array.isArray(deltaMessages) ? deltaMessages : messages);
    this.#nodeBackend.set(node.id, provider);
    // A committed attempt is the new truth: any retry stash is obsolete.
    this.#retryRows.delete(node.id);
    this.#retryFeedback.delete(node.id);
    return result;
  }

  /**
 * Ledger-mode rows for a node: real message rows from the context entries
 * completed so far (excluding this node), rendered through the shared transfer
 * primitive. Returns null when ledger is not active — not requested, clean
 * handoff, or the target backend is unknown — so the caller keeps the default
 * stringified context view.
 * @param {{node: SMNode, transfer: any, model: string, clean: boolean}} arg0
 * @returns {Promise<Array<any>|null>}
 */
  async #buildLedgerRows({ node, transfer, model, clean }) {
    const policy = normalizeTransfer({ transfer });
    if (policy.mode !== 'ledger' || clean) return null;
    // G4: a real client knows its backend — read it, do not build a session just to
    // ask (that throwaway session fired `session:start`). A bare stub that has no
    // `backend` still falls back to the old probe, which is where the model→backend
    // mapping lives for such clients.
    const targetProvider = /** @type {any} */ (this.#client)?.provider
        ?? /** @type {any} */ (this.#client)?.session?.(model)?.provider
        ?? null;
    if (!targetProvider) return null;
    const rendered = await renderTransfer({
      units: this.#transferUnits({ exclude: node.id }),
      transfer,
      targetProvider,
      maxChars: LIMITS.max_intake_output_chars,
    });
    return rendered.rows;
  }

  /**
 * Context entries in insertion order as transfer units. A node's captured rows
 * ride along when its backend is known (same-backend verbatim replay);
 * otherwise the unit degrades to a digest row inside the renderer. The unit
 * carries the node's DELTA — the rows it added — never its cumulative
 * transcript, which already holds every earlier node's rows (D1).
 * @param {{exclude?: string|null}} [arg0]
 * @returns {Array<import('../transfer.mjs').TransferUnit>}
 */
  #transferUnits({ exclude = null } = {}) {
    const all = this.#ctx.getAll();
    /** @type {Array<import('../transfer.mjs').TransferUnit>} */
    const units = [];
    for (const [id, output] of Object.entries(all)) {
      if (id === exclude) continue;
      const delta = this.#nodeDelta.get(id) ?? this.#nodeMessages.get(id);
      const provider = this.#nodeBackend.get(id);
      units.push(delta && provider ? { id, output, messages: delta, provider } : { id, output });
    }
    return units;
  }

  /**
 * @param {{template: string, nodeId?: string}} arg0
 */
  #interpolate({ template, nodeId = '' }) {
    return template.replace(/\{\{context\.([^}]+)\}\}/g, (_ /** @type {string} */, expr /** @type {string} */) => {
      const walked = walkPath({ value: this.#ctx.getAll(), parts: expr.split('.') });
      if (!walked.ok || walked.value === undefined || walked.value === null) {
        const message = `Template error in node '${nodeId}': Cannot resolve context property 'context.${expr}'.`;
        sdkWarn({ prefix: 'STATE-MACHINE', args: [message] });
        this._runCtx.emit({ emitter: this, name: EVENTS.WORKFLOW.TEMPLATE_WARNING, payload: { nodeId, path: `context.${expr}`, message } });
        return `[UNRESOLVED: ${expr}]`;
      }
      return stringifyTemplateValue({ value: walked.value });
    });
  }

  #ctxView() {
    const all = this.#ctx.getAll();
    const entries = Object.entries(all);
    if (entries.length <= this.#maxContextEntries) return all;
    const omitted = entries.length - this.#maxContextEntries;
    return {
      __omittedEntries: omitted,
      __note: `${omitted} earlier node outputs are omitted from this view — reference them explicitly via {{context.<nodeId>}} if needed.`,
      ...Object.fromEntries(entries.slice(-this.#maxContextEntries)),
    };
  }
}

/**
 * Builds the `run_state_machine` tool definition for a graph. The objective is
 * read lazily at call time, so the tool can be registered before withObjective().
 * @param {{graph: Object, options?: Object}} arg0
 * @returns {Object} a standard Merci SDK tool definition.
 */
export function createStateMachineTool({ graph, options = {} }) {
  const client = /** @type {any} */ (options).client;
  const objective = typeof /** @type {any} */ (options).objective === 'function'
    ? () => (/** @type {Function} */ (/** @type {any} */ (options).objective))() ?? null
    : () => /** @type {any} */ (options).objective ?? null;
  return {
    name: /** @type {any} */ (options).toolName ?? RUN_STATE_MACHINE_TOOL_NAME,
    description: /** @type {any} */ (options).description ?? `Execute a ${(/** @type {SMGraph} */ (graph)).nodes.length}-node state machine with cycles and conditional transitions. Provide initial context variables. Returns the final state as JSON.`,
    parameters: {
      type: 'object',
      properties: {
        context: { type: 'object', description: 'Initial variables for the state machine context.', additionalProperties: true }
      }
    },
    /** @param {{args?: *, signal: *}} arg0 */
    execute: (/** @type {(args: { args: { context?: Object }, signal?: AbortSignal }) => Promise<any>} */ (async ({ args: { context } = {}, signal }) => {
      const opts = /** @type {any} */ (options ?? {});
      /** @param {any} value */
      const resolve = (value) => (typeof value === 'function' ? value() : value);
      const sm = new StateMachine({ graph, options: {
        ...opts,
        client,
        context: context ?? {},
        objective: objective(),
        agentContext: resolve(opts.agentContext),
        sessionPolicy: resolve(opts.sessionPolicy),
        skills: resolve(opts.skills),
        skillsPreload: resolve(opts.skillsPreload),
      } });
      await sm.run({ signal: /** @type {AbortSignal|undefined} */ (signal) });
      if (sm.phase === 'failed') {
        return {
          success: false,
          error: `State machine failed its acceptance criteria. ${sm.toPayloadString()}`
        };
      }
      return sm.toPayloadString();
    }))
  };
}

/**
 * True for a real Promise or any object/function with a callable `then`.
 * Only trusted host values reach this check: for a sandbox value the probe
 * must happen inside the VM, or its getter runs on the host (D-1).
 * @param {{value: unknown}} arg0
 * @returns {boolean}
 */
function isThenable({ value }) {
    if (value instanceof Promise) return true;
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return typeof (/** @type {{then?: unknown}} */ (value)).then === 'function';
}

/**
 * Compiles a transition condition: passes functions through, parses string
 * expressions into a function that evaluates them against the StateContext in
 * a hardened `node:vm` sandbox (code generation disabled, hard timeout).
 *
 * Security (D-1): the script evaluated inside the sandbox coerces to a primitive
 * boolean there (`!!(expr)`), so the host never receives, reads a property of,
 * or calls a method on a sandbox object. The old `.then`/`.catch` probe handed
 * the sandbox a host function (`f.constructor` was the host `Function`), which
 * escaped the sandbox entirely.
 *
 * Memory (D-8): a planner-authored expression such as `new Array(10_000_000)` is
 * a host-kill vector — `node:vm` bounds time, not memory, and V8's OOM handler
 * aborts the process. String conditions therefore evaluate in a child process
 * with its own `--max-old-space-size` (`MERCI_LIMIT_CONDITION_MEMORY_MB`); an
 * OOM there is a typed `ConfigurationError` here and the next call still works.
 * When the host refuses child processes (Node's permission model without
 * `--allow-child-process`) evaluation falls back, once and with a warning, to
 * the in-process sandbox, which bounds CPU only. Host functions are trusted and
 * never cross the process boundary.
 * @param {{src?: Function|string, expr?: Function|string}} arg0
 * @returns {Function} (ctx) => boolean, or the original function.
 */
export function compileCondition({ src, expr }) {
  const raw = src !== undefined ? src : expr;
  if (typeof raw === 'function') {
    if (raw.constructor?.name === 'AsyncFunction') {
      throw new ConfigurationError({ message: 'StateMachine: condition must be synchronous — async/await/Promise are not allowed', options: { option: 'condition' } });
    }
    return raw;
  }
  if (typeof raw !== 'string') {
    throw new ConfigurationError({ message: `StateMachine: condition must be a string expression, got ${typeof raw}`, options: { option: 'condition' } });
  }
  if (raw.length > LIMITS.condition_max_length) {
    throw new ConfigurationError({ message: `StateMachine: condition expression too long (${raw.length} > ${LIMITS.condition_max_length})`, options: { option: 'condition' } });
  }
  if (/\basync\b|\bawait\b|\bimport\s*\(|\bPromise\b/.test(raw)) {
    throw new ConfigurationError({ message: `StateMachine: condition must be synchronous — async/await/import()/Promise are not allowed`, options: { option: 'condition' } });
  }
  try {
    compileConditionScript({ src: raw });
  } catch {
    throw new ConfigurationError({ message: `StateMachine: invalid condition expression: "${raw}"`, options: { option: 'condition' } });
  }
  const src2 = raw;
  return (/** @type {(ctx: any) => boolean} */ ((ctx) => evaluateCondition({
    src: src2,
    // Strict: a truncated payload made a condition read "[truncated]" as the
    // value of a key that sits after a large one (D-3) — the route went false.
    payloadJson: strictStringify({ value: typeof ctx?.getAll === 'function' ? ctx.getAll() : (ctx ?? {}) }),
  })));
}

/**
 * W4-9/W4-10: a per-node map reduced to the nodes the new graph still has.
 * @template T
 * @param {{map: Map<string, T>, ids: Set<string>}} arg0
 * @returns {Map<string, T>}
 */
function keepNodes({ map, ids }) {
  return new Map([...map].filter(([id]) => ids.has(id)));
}

/**
 * @param {{g: SMGraph}} arg0
 */
function validateGraph({ g }) {
  if (!g) throw new ConfigurationError({ message: 'StateMachine: graph is required' });
  if (!g.entry) throw new ConfigurationError({ message: 'StateMachine: graph requires entry node id' });
  if (!Array.isArray(g.nodes)) throw new ConfigurationError({ message: 'StateMachine: graph.nodes must be an array' });
  if (!Array.isArray(g.edges)) throw new ConfigurationError({ message: 'StateMachine: graph.edges must be an array' });
  const ids = new Set(g.nodes.map(n => n.id));
  if (ids.size !== g.nodes.length) {
    const seen = new Set();
    const dupes = new Set();
    for (const n of g.nodes) { if (seen.has(n.id)) dupes.add(n.id); seen.add(n.id); }
    throw new ConfigurationError({ message: `StateMachine: duplicate node ids: ${[...dupes].join(', ')}`, options: { option: 'nodes' } });
  }
  if (!ids.has(g.entry)) throw new ConfigurationError({ message: `StateMachine: entry "${g.entry}" not found in nodes` });
  for (const e of g.edges) {
    if (!ids.has(e.from)) throw new ConfigurationError({ message: `StateMachine: edge from "${e.from}" not in nodes` });
    if (!ids.has(e.to)) throw new ConfigurationError({ message: `StateMachine: edge to "${e.to}" not in nodes` });
    const c = e.condition;
    if (c === undefined || c === null) continue;
    if (typeof c === 'string') {
      e.condition = compileCondition({ src: c });
      continue;
    }
    if (typeof c !== 'function') {
      throw new ConfigurationError({ message: `StateMachine: edge "${e.from}"→"${e.to}" condition must be a string expression or function, got ${typeof c}`, options: { option: 'condition' } });
    }
    if (c.constructor?.name === 'AsyncFunction') {
      throw new ConfigurationError({ message: 'StateMachine: edge condition must be synchronous', options: { option: 'condition' } });
    }
  }
}
