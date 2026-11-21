// @ts-check


/**
 * @file Standalone multi-agent discussion session.
 * @version 0.12.0
 *
 * @description
 * Zero required coupling to workflows, planning, or memory (all optional).
 * Interoperates with the
 * rest of the library via:
 *   - ChatSession  (for agent execution via session.run)
 *   - EventEmitter (for events — same pattern as WorkflowExecutor)
 *   - Text strings (returned as agent output, consumed by any caller)
 *   - Tool calls   (agents can use any tool, including WorkflowExecutor / A2A)
 *
 * Plug into a DAG: give a step agent a "run_discussion" tool → tool.create(DiscussionSession) → tool returns text.
 * Plug into a discussion: give an agent a "plan_workflow" tool → tool.calls(WorkflowExecutor) → text back to ledger.
 * Both directions work through the existing tool system. Zero bridge code.
 *
 * Agents are STATELESS per turn: each LLM turn runs in a fresh session rebuilt
 * from the shared `#ledger` (own entries become assistant rows, peers become
 * `[author]: …` user rows). For a memorizer/verifier-style agent that needs the
 * full prior conversation, delegate via the `task` tool with
 * `handoff.context:'fork'` (which seeds the child with real rows) rather than
 * widening the ledger.
 */
import { EventEmitter } from 'node:events';
import { createUserMessage, createAssistantMessage } from '../messaging/messages.mjs';
import { extractAndParseJson } from '../support/json.mjs';
import { sortDagNodes, interpolateTemplate, validateTemplateRefs, stateSchemaViolation } from './planning/graph-utils.mjs';
import { Plan } from './planning/plan.mjs';
import { StateMachine } from './state-machine/machine.mjs';
import { MemoryComponent } from './memory/component.mjs';
import { WorkflowPlanner } from './planning/planner.mjs';
import { structuredLlmCall } from './planning/planner-utils.mjs';
import { CONVERSATION_SUMMARY_PROMPT, CONVERSATION_SUMMARY_SCHEMA } from '../core/prompts.mjs';
import { throwIfAborted, forwardToolEvents, normalizeAgentOutput, runDueSteps, isSdkFallbackOutput, fallbackKind, resolveExhaustionOpts, EMPTY_FALLBACK_CAUSE, SCHEMA_FALLBACK_CAUSE, assertUsableOutput, assertVerifyVerdict, schemaCorrection } from './agentic-core.mjs';
import { runStep } from './step.mjs';
import { foldContext } from './context-fold.mjs';
import { normalizeTransfer, renderTransfer } from './transfer.mjs';
import { getSpawnRegistry } from './spawn-registry.mjs';
import { AgentContext, normalizeHandoff, goalBlockForHandoff, merciEnvelope } from './agent-context.mjs';
import { applySessionPolicy } from './session-policy.mjs';
import { runTaskChild, runDelegationLadder, resolveAgentClient } from './task.mjs';
import { pooledClient } from './pooled-client.mjs';
import { attemptPoolView, ensureBudgetPool } from './budget-pool.mjs';
import { remainingBudget } from './budget-accounting.mjs';
import { CLIENT_VIEW_BASE } from '../support/utils.mjs';
import { isAbortError, ConfigurationError, VerificationError, BudgetExceededError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { getCircuitBreaker, circuitKey } from '../support/retry-policy.mjs';
import { truncateForPrompt } from '../support/utils.mjs';
import { EVENTS, RunContext } from '../core/events.mjs';
import { noulQuestion, choiceQuestion } from '../messaging/decision.mjs';

/**
 * @typedef {Object} DiscussionAgent
 * @property {string} name
 * @property {string} [persona]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {Object|null} [client] - A ready backend client for this agent's turns; wins over `provider`. Its `provider` must match when both are set.
 * @property {Array<Object>} [tools]
 * @property {number} [maxIterations]
 * @property {boolean|Object} [autoExtend]
 * @property {Object|null} [errorHandlers]
 * @property {Object|null} [handoff]
 * @property {string|Object|null} [transfer] - Per-agent transfer policy (preset name or { mode, select, compact, tail }). Defaults to the session's; unset keeps the native ledger rendering.
 * @property {Function} [execute]
 * @property {Function} [verify] - Per-agent verify for discussion/task turns.
 * @property {string} [fallbackModel] - Task-ladder degrade model for planForEach steps (fresh session on transient/empty failure or open breaker).
 * @property {number} [hedgeAfterMs] - Race a second identical planForEach attempt after this delay (stall protection).
 * @property {number} [timeoutMs] - Per-step header (time-to-first-byte) budget.
 * @property {number} [maxElapsedMs] - Total retry budget for a planForEach step.
 * @property {import('../support/retry-policy.mjs').CircuitBreaker|null} [circuitBreaker] - Shared breaker for a planForEach step (defaults to the client registry).
 * @property {Object} [retryPolicy] - Per-agent retry policy for planForEach steps (wins over the group's).
 */

/**
 * @typedef {Object} LedgerEntry
 * @property {string} author
 * @property {string} content
 * @property {string} [type]
 * @property {string|null} [thoughtSignature]
 * @property {boolean} [pass]
 * @property {boolean} [error]
 * @property {number} [turn] - The discussion round that committed the entry; 0 for a row committed outside `discuss`.
 */

/**
 * @typedef {Object} TurnOptions
 * @property {AbortSignal} [signal]
 * @property {Function} [followUp]
 * @property {Function} [verify]
 * @property {number} [maxRetries]
 * @property {number} [tail]
 * @property {Function} [summarize]
 * @property {boolean} [allowPass]
 * @property {boolean} [deferred]
 */

/**
 * @typedef {Object} VerdictEntry
 * @property {boolean} passed
 * @property {number} score
 * @property {string} revision
 * @property {string} reason
 * @property {string} content
 */

/**
 * @typedef {Object} DiscussionTask
 * @property {string} title
 * @property {string} [description]
 * @property {string} [assignee]
 * @property {string} [subagent_type]
 * @property {string[]} [dependsOn]
 * @property {Function} [verify]
 * @property {number} [maxRetries]
 */

/**
 * @typedef {Object} PlannedStep
 * @property {string} id
 * @property {string} [systemPrompt]
 * @property {string} [userPromptTemplate]
 * @property {string[]} [dependencies]
 * @property {Array<Object>} [tools]
 * @property {number} [maxIterations]
 * @property {boolean} [autoExtend]
 * @property {Object} [errorHandlers]
 * @property {string} [fallbackModel] - Per-step override of the agent's degrade model.
 * @property {number} [hedgeAfterMs] - Per-step override of the agent's hedge delay.
 * @property {number} [timeoutMs] - Per-step override of the agent's header budget.
 * @property {number} [maxElapsedMs] - Per-step override of the agent's retry budget.
 * @property {import('../support/retry-policy.mjs').CircuitBreaker|null} [circuitBreaker] - Per-step breaker override.
 * @property {Object} [retryPolicy] - Per-step retry-policy override.
 */

/**
 * @typedef {Object} PhaseOptions
 * @property {number} [turns]
 * @property {boolean} [sequential]
 * @property {number} [tail]
 * @property {Function} [summarize]
 * @property {string|string[]|Function} [termination]
 * @property {string} [instruction]
 * @property {number} [minScore]
 * @property {string} [model]
 * @property {string} [persona]
 * @property {Function} [execute]
 * @property {Array<Object>} [tools]
 */

/**
 * @typedef {Object} ConcludeOptions
 * @property {{tasks?: Array<DiscussionTask>, context?: Object, sequential?: boolean}} [plan]
 * @property {PhaseOptions} [discuss]
 * @property {PhaseOptions} [judge]
 * @property {PhaseOptions} [aggregate]
 * @property {number} [maxRounds]
 * @property {number} [tail]
 * @property {Function} [summarize]
 * @property {AbortSignal} [signal]
 * @property {Function} [followUp]
 */


export { EMPTY_FALLBACK_CAUSE };


/**
 * A substantive ledger entry is real content: not a pass/deferral, not empty,
 * not an SDK fallback, not an `[error: …]` record. Shared by judge's
 * empty-ledger guard and conclude's acceptance gate so the two can never
 * disagree about whether the discussion produced anything.
 * @param {LedgerEntry|undefined} entry
 * @returns {boolean}
 */
export function isSubstantiveEntry(entry) {
    if (!entry) return false;
    if (entry.pass === true) return false;
    const content = String(entry.content ?? '').trim();
    return content.length > 0 && !isSdkFallbackOutput({ text: entry.content }) && !content.startsWith('[error:');
}


/**
 * E-6: every verdict-shaped object is read, never only the last one. Two that
 * disagree on `passed`, or a verdict that does not end the text, are malformed
 * and fail closed — a contribution's quoted verdict can never override the
 * judge's own.
 * @returns {any}
  * @param {{content: *}} arg0
 */
function extractVerdictJson({ content }) {
    const text = String(content ?? '');
    /** @type {Array<{parsed: any, data: any, end: number}>} */
    const found = [];
    for (let i = text.indexOf('{'); i !== -1;) {
        const end = closingBraceIndex({ text, start: i });
        const parsed =  (extractAndParseJson({ input: text.slice(i) }));
        const data = parsed?.data;
        if (end !== -1 && parsed?.success && data && typeof data === 'object'
            && ('passed' in data || 'score' in data || 'revision' in data || 'reason' in data)) {
            found.push({ parsed, data, end });
            i = text.indexOf('{', end + 1);
        } else {
            i = text.indexOf('{', i + 1);
        }
    }
    // W2E-3: a verdict-shaped object with no `passed` (a score-only judgment)
    // is a different answer from one that says `passed`, so the two are a
    // conflict, and the chosen trailing verdict must say `passed` itself —
    // otherwise a quoted contribution decides the outcome.
    const passed = new Set(found.map(c => 'passed' in c.data ? c.data.passed : undefined));
    if (passed.size > 1) return { success: false };
    const last = found[found.length - 1];
    if (!last || typeof last.data.passed !== 'boolean') return { success: false };
    let trimmed = text.trim();
    if (trimmed.endsWith('```')) trimmed = trimmed.slice(0, -3).trimEnd();
    if (last.end !== trimmed.length - 1) return { success: false };
    return last.parsed;
}


/**
 * Index of the `}` that closes the `{` at `start`, or -1.
 * @param {{text: string, start: number}} arg0
 * @returns {number}
 */
function closingBraceIndex({ text, start }) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
}


















/**
 * W4-5: the author a judge/aggregate turn is recorded under. A name an agent
 * already uses would make that agent replay the turn as its own — the same
 * collision `addAgent` refuses, reached through the per-call override instead.
 * @param {{name?: string|null, agents: Array<{name: string}>, fallback: string}} arg0
 * @returns {string}
 */
function assertAuthorName({ name, agents, fallback }) {
    const author = name || fallback;
    if (agents.some((a) => a.name === author)) {
        throw new ConfigurationError({ message: `DiscussionSession: an agent named "${author}" already exists — the "${fallback}" turn would be read as its own. Pick another name.`, options: { option: 'name' } });
    }
    return author;
}

/**
 * W4-6: the stringify-path window. A per-call `tail` wins; then the transfer's
 * own window. An explicit non-positive tail means "no window" — the ledger path
 * maps it to the default row count, and that default must not window this path.
 * @param {{base: import('./transfer.mjs').TransferPolicy, raw: *, tail: number|null|undefined}} arg0
 * @returns {number|null}
 */
function stringifyWindow({ base, raw, tail }) {
    if (Number.isFinite(tail)) return Number(tail) > 0 ? Math.floor(Number(tail)) : null;
    if (base.select !== 'tail') return null;
    const declared = raw && typeof raw === 'object' && Object.hasOwn(raw, 'tail') ? Number(raw.tail) : null;
    if (declared === null || !Number.isFinite(declared)) return base.tail;
    return declared > 0 ? Math.floor(declared) : null;
}

/**
 * @returns {{check: (ledger: Array<LedgerEntry>) => string|null}}
  * @param {{termination: *}} arg0
 */
function normalizeTermination({ termination }) {
    if (termination == null) return { check: () => null };
    if (typeof termination === 'function') {
        return { check: (ledger) => (termination({ ledger }) ? 'termination condition met' : null) };
    }
    const tokens = (Array.isArray(termination) ? termination : [termination])
        .map(t => String(t).trim()).filter(Boolean);
    return {
        check: (ledger) => {
            const last = ledger[ledger.length - 1];
            if (!last) return null;
            const text = String(last.content ?? '');
            const hit = tokens.find(tok => tok && text.includes(tok));
            return hit ? `agent mentioned "${hit}"` : null;
        }
    };
}

/**
 * The client handle a discussion group runs its agents on. Structural: the group
 * reads the backend label, hands the handle to delegation, and builds sessions.
 * @typedef {Object} DiscussionClient
 * @property {string} [provider]
 * @property {Object|null} [client]
 * @property {Function} [session]
 * @property {Object} [tasks]
 */

/**
 * A child session the group configures (a backend ChatSession).
 * @typedef {Object} GroupSession
 * @property {string} [provider]
 * @property {string} [model]
 * @property {Function} [withRetryPolicy]
 * @property {Function} [withStreamTimeout]
 * @property {Function} [withCircuitBreaker]
 * @property {Object|null} [_circuitBreaker]
 */

/**
 * Options accepted by `new DiscussionSession(...)`.
 * @typedef {Object} DiscussionSessionOptions
 * @property {Map<string, Object>|null} [todosStore]
 * @property {Object} [todosOptions]
 * @property {Object|null} [memoryProvider]
 * @property {Object} [memoryOptions]
 * @property {Array<Object>|null} [skills]
 * @property {boolean} [skillsPreload]
 * @property {string|null} [objective]
 * @property {Object|null} [handoff]
 * @property {string|Object|null} [transfer]
 * @property {import('./agent-context.mjs').AgentContext|null} [agentContext]
 * @property {import('./chat-session.mjs').RetryPolicyLike|null} [retryPolicy]
 * @property {import('./chat-session.mjs').StreamTimeoutPolicyLike|null} [streamTimeoutPolicy]
 * @property {Object|null} [approval]
 * @property {Partial<import('./session-policy.mjs').SessionPolicy>|null} [sessionPolicy]
 * @property {{maxTotalTokens?: number, maxBudgetUsd?: number}|null} [budget]
 * @property {Object|null} [budgetPool] - The runner's attempt ledger, so every delegated task charges the same tree.
 * @property {import('../core/events.mjs').RunContext|null} [runContext]
 * @property {boolean|Object} [autoExtend]
 * @property {Object|null} [errorHandlers]
 * @property {import('./journal.mjs').ExecutionJournal|null} [journal]
 * @property {string} [journalScope]
 * @property {Array<Object>|null} [contextProcessors]
 * @property {Object|null} [stateSchema]
 * @property {number|null} [maxLedgerEntries]
 * @property {'marker'|'summarize'} [ledgerPruneMode]
 * @property {Function|boolean|Object} [ledgerSummarize]
 * @property {import('./decision-gate.mjs').DecisionGate|null} [decisionGate] - Optional System One gate: a confident consensus skips the judge turn and a confident choice assigns an unassigned task.
 */

/**
 * A multi-agent debate group: agents converse on a shared ledger, optionally
 * judged/aggregated into a conclusion. Emits `discussion:*` events on its own
 * EventEmitter; the ledger is the single source of truth between turns.
 * @extends {EventEmitter}
 */
export class DiscussionSession extends EventEmitter {
    
    /** @type {DiscussionAgent[]} */
        #agents = [];
    
    /** @type {LedgerEntry[]} */
        #ledger = [];
    
    /** @type {Map<Function, {lastEntry: LedgerEntry, value: Promise<string|null>}>} */
        #summaryCache = new Map();
    
    /** @type {boolean|string} */
        #stopRequested = false;
    
    /** @type {number} */
        #turn = 0;

    /**
     * W2E-1: the round id stamped on ledger rows. Monotonic for the session's
     * lifetime — `discuss` restarts `#turn` at 1 for every call, so a per-call
     * value would let a later judge's "latest round" match an earlier call's
     * rows.
     * @type {number}
     */
    #round = 0;

    /**
     * The round id of the most recent `discuss` round — `#turn` is reset to 0
     * after a round, so judge reads the latest round from this.
     * @type {number}
     */
    #lastTurn = 0;

    /**
     * D9: one spawn tree for the whole discussion. `#taskParentSession` builds a
     * fresh parent per task, so without a shared counter every stage would open a
     * new tree and `maxSpawns` would never bite.
     * @type {{root: string|null, count: number}|null}
     */
    #spawnTree = null;
    
    /** @type {LedgerEntry[]|null} */
        #ledgerView = null;
    
    /** @type {number} */
        #maxLedgerEntries;
    
    /** @type {number} */
        #prunedCount = 0;
    
    /** @type {number} */
        #prunedCap = 0;
    
    /** @type {string|null} */
        #prunedSummary = null;
    
    /** @type {'marker'|'summarize'} */
        #ledgerPruneMode = 'marker';
    
    /** @type {Function|boolean|Object} */
        #ledgerSummarize = true;
    
    /** @type {Promise<any>} */
        #summaryChain = Promise.resolve();

    
    /**
     *   (same shape as session.withApproval).
     *   extension for every group session; an agent's own `autoExtend` wins.
     *   handlers for every group session; an agent's own `errorHandlers` wins.
     *   ({ goal, context, tools }); an agent's own `handoff` wins per turn.
     *   ledger entries (memory safety valve). `0`/`Infinity`/`null` disables.
     *   overflow eviction leaves behind: a count marker, or a rolling summary
     *   folded in the background via `ledgerSummarize`.
     *   summarizer for `ledgerPruneMode:'summarize'` (function | true | {model}).
     *   `false` falls back to the count marker.
      * @param {{client: DiscussionClient|null, options?: DiscussionSessionOptions}} arg0
     */
        constructor({ client, options = {} }) {
        super();
        this.client = client;
        this._todosStore = /** @type {Map<string, Object>|null} */ (options.todosStore || null);
        this._todosOptions = /** @type {Object} */ (options.todosOptions || {});
        this._memoryProvider = /** @type {Object|null} */ (options.memoryProvider || null);
        this._memoryOptions = /** @type {Object} */ (options.memoryOptions || {});
        this._skills = /** @type {Array<Object>|null} */ (options.skills || null);
        this._skillsPreload = options.skillsPreload === true;
        this._objective = /** @type {string|null} */ (options.objective ?? null);
        this._handoff = /** @type {Object|null} */ (options.handoff ?? null);
        this._transfer = /** @type {string|Object|null} */ (options.transfer ?? null);
        const groupGoalClean = normalizeHandoff({ handoff: this._handoff }).goal === 'clean';
        this._agentContext = /** @type {import('./agent-context.mjs').AgentContext|null} */ (options.agentContext ?? (!groupGoalClean && this._objective ? AgentContext.fromObjective({ objective: this._objective }) : null));
        this._retryPolicy = /** @type {import('./chat-session.mjs').RetryPolicyLike|null} */ (options.retryPolicy || null);
        this._streamTimeoutPolicy = /** @type {import('./chat-session.mjs').StreamTimeoutPolicyLike|null} */ (options.streamTimeoutPolicy || null);
        this._approvalPolicy = /** @type {Object|null} */ (options.approval || null);
        this._sessionPolicy = /** @type {import('./session-policy.mjs').SessionPolicy|null} */ (/** @type {unknown} */ (options.sessionPolicy || null));
        this._budget = /** @type {{maxTotalTokens?: number, maxBudgetUsd?: number}|null} */ (options.budget || null);
        // E-1: ONE ledger for the whole group. A per-turn snapshot let every
        // parallel agent (and every delegated task) spend the same remainder.
        // The pool caps the group; each turn's session joins it by reference.
        const providedPool = /** @type {import('./budget-pool.mjs').BudgetPool|null} */ (options.budgetPool || null);
        // A client view is already attached to a ledger (the scheduler attempt).
        // A group pool of our own cannot be joined by those sessions, and creating
        // one made every budgeted DAG discussion turn fail with
        // `session_reused_across_attempts` (A-3). Keep the per-unit budget there.
        const clientIsView = Boolean(/** @type {any} */ (this.client)?.[CLIENT_VIEW_BASE]
            && /** @type {any} */ (this.client)[CLIENT_VIEW_BASE] !== this.client);
        // A standalone group creates ONE pool from its budget (E-1); a scheduler
        // attempt already hands in a cap-less ledger that reports to the attempt,
        // and keeps the documented per-unit budget behaviour.
        this._budgetPool = providedPool
            ?? (this._budget && !clientIsView ? ensureBudgetPool({ session: /** @type {any} */ ({ _budget: this._budget }) }) : null);
        this._ownBudgetPool = this._budgetPool !== null && this._budgetPool !== providedPool;
        this._usageTokens = 0;
        this._usageUsd = 0;
        this._runCtx = RunContext.child(options?.runContext ?? null);
        this._autoExtend = /** @type {boolean|Object} */ (options.autoExtend ?? false);
        this._errorHandlers = /** @type {Object|null} */ (options.errorHandlers ?? null);
        this._decisionGate = /** @type {import('./decision-gate.mjs').DecisionGate|null} */ (options.decisionGate ?? null);
        this._journal = /** @type {import('./journal.mjs').ExecutionJournal|null} */ (options.journal ?? null);
        this._journalScope = /** @type {string} */ (options.journalScope ?? '');
        this._contextProcessors = /** @type {Array<Object>|null} */ (options.contextProcessors ?? null);
        this._stateSchema = /** @type {Object|null} */ (options.stateSchema ?? null);
        const ledgerMax = options.maxLedgerEntries === undefined ? LIMITS.discussion_ledger_max : options.maxLedgerEntries;
        this.#maxLedgerEntries = Number.isFinite(/** @type {number} */ (ledgerMax)) &&  (/** @type {number} */ (ledgerMax)) > 0
            ? Math.floor( (/** @type {number} */ (ledgerMax)))
            : Infinity;
        const pruneMode = options.ledgerPruneMode ?? 'marker';
        if (pruneMode !== 'marker' && pruneMode !== 'summarize') {
            throw new ConfigurationError({ message: `DiscussionSession: ledgerPruneMode must be 'marker' or 'summarize' (got ${JSON.stringify(pruneMode)})` });
        }
        this.#ledgerPruneMode = pruneMode;
        this.#ledgerSummarize = options.ledgerSummarize ?? true;
    }

    
    /**
     * @param {{agent: Object}} arg0
     * @returns {{autoExtend?: boolean|Object, errorHandlers?: Object|null}}
     */
    _exhaustionOpts({ agent }) {
        const source = /** @type {{autoExtend?: boolean|Object, errorHandlers?: Object|null}} */ (agent);
        return resolveExhaustionOpts({ source, autoExtend: this._autoExtend, errorHandlers: this._errorHandlers });
    }

    
    /**
      * @param {{session: *, owner?: *}} arg0
     */
    /** Tokens reported by the group's turns so far. */
    get usageTokens() { return this._usageTokens; }
    /** USD the backend reported for the group's turns so far (0 when unreported). */
    get usageUsd() { return this._usageUsd; }

    /**
     * The budget the next turn may spend: the group cap minus the tokens
     * already reported. Without this decrement every turn received the full
     * cap and a long discussion could spend N× it.
     * @returns {{maxTotalTokens?: number, maxBudgetUsd?: number}|null}
     */
    _remainingBudget() {
        const pool = /** @type {any} */ (this._budgetPool);
        // The group's own cap is the budget; a host attempt ledger is cap-less by
        // design, so its usage must not count against the unit's remaining budget.
        const budget = this._budget
            ?? (pool ? { maxTotalTokens: pool.maxTotalTokens ?? undefined, maxBudgetUsd: pool.maxBudgetUsd ?? undefined } : null);
        return remainingBudget({
            budget,
            // The pool is the live ledger; the group counter can only be larger
            // when a host (or a test) seeds it directly.
            spent: this._ownBudgetPool ? Math.max(pool.usage.total_tokens, this._usageTokens) : this._usageTokens,
            spentUsd: this._ownBudgetPool ? Math.max(pool.usage.cost_usd ?? 0, this._usageUsd) : this._usageUsd,
            emit: ({ usage, maxTotalTokens, maxBudgetUsd }) => this._runCtx.emit({ emitter: this, name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxTotalTokens, maxBudgetUsd } }),
        });
    }

    /**
     * A turn runs in a child context so parallel agents cannot race on the
     * parent. On a sequential turn we commit the child's objective and turn
     * counter back, so cadence advances and the update is not discarded.
     * @param {any} ctx
     */
    #commitObjectiveFrom(ctx) {
        if (!ctx || !this._agentContext || ctx === this._agentContext) return;
        if (ctx.objective && ctx.objective !== this._agentContext.objective) {
            this._agentContext.applyObjective({ next: ctx.objective });
        }
        this._agentContext.objectiveTurn = Math.max(this._agentContext.objectiveTurn ?? 0, ctx.objectiveTurn ?? 0);
    }

    /**
     * Parallel agents must keep isolated children (a single agent cannot leak
     * an update or race the parent), but the group still needs to advance its
     * cadence or every turn restates from turn 0. Advance to the max child
     * turn; adopt an objective only when every agent independently produced
     * the same update (consensus). A lone restatement stays in its child.
     * @param {{contexts?: any[]}} arg0
     */
    #commitParallelObjective({ contexts = [] }) {
        const groupCtx = this._agentContext;
        if (!groupCtx) return;
        const children = contexts.filter(Boolean);
        if (children.length === 0) return;
        const maxTurn = Math.max(...children.map((c) => c.objectiveTurn ?? 0));
        groupCtx.objectiveTurn = Math.max(groupCtx.objectiveTurn ?? 0, maxTurn);
        // A non-participating agent (goal clean, or a turn that failed before
        // its context existed) must not turn a lone restatement into "consensus".
        if (children.length !== this.#agents.length) return;
        const changed = children.filter((c) => c.objective && c.objective !== groupCtx.objective);
        if (changed.length === children.length && changed.every((c) => c.objective === changed[0].objective)) {
            groupCtx.applyObjective({ next: changed[0].objective });
        }
    }

    /**
     * @template {GroupSession} T
     * @param {{session: T, owner?: DiscussionClient|null}} arg0
     * @returns {T}
     */
        _applyPolicies({ session, owner = this.client }) {
        if (this._retryPolicy) session.withRetryPolicy?.({ policy: this._retryPolicy });
        if (this._streamTimeoutPolicy) session.withStreamTimeout?.({ policy: this._streamTimeoutPolicy });
        if (!session._circuitBreaker) {
            session.withCircuitBreaker?.({ breaker: getCircuitBreaker({ client: owner, key: circuitKey({ provider: session.provider, model: session.model }) }) });
        }
        return session;
    }

    /**
     * The client an agent's turns run on. An agent that resolved to its own
     * client still charges the attempt ledger: the owner becomes a view over the
     * runner's ledger.
     * @param {{agent: Object}} arg0
     * @returns {any}
     */
    #agentOwner({ agent }) {
        const owner = resolveAgentClient({ parent: this.client, agent });
        if (this._budgetPool) {
            // Wrap even when the owner IS the base client: the turn's session must
            // join the group ledger, or its spend leaves the group cap blind.
            return /** @type {DiscussionClient} */ (pooledClient({ client: owner, pool: this._budgetPool }));
        }
        return owner;
    }

    
    /**
 * Registers a discussion agent. Requires a name and either a model+provider
 * (LLM agent) or an `execute` callback (code/remote agent). The callback gets the
 * turn bag plus `client`/`budgetPool` (a frozen view); spend through `client` is reported.
 * @param {{name: string, persona?: string, model?: string, provider?: string, client?: Object, tools?: Array<Object>, maxIterations?: number, autoExtend?: boolean|Object, errorHandlers?: Object|null, handoff?: Object|null, transfer?: string|Object|null, execute?: Function, verify?: Function, fallbackModel?: string, hedgeAfterMs?: number, timeoutMs?: number, maxElapsedMs?: number, circuitBreaker?: import('../support/retry-policy.mjs').CircuitBreaker|null, retryPolicy?: Object}} arg0
 *   progress-aware tool-budget extension.
 *   group's controlled-output handlers.
 * @returns {DiscussionSession}
 */
        addAgent({ name, persona, model, provider, client, tools = [], maxIterations, autoExtend, errorHandlers, handoff, transfer, execute, verify, fallbackModel, hedgeAfterMs, timeoutMs, maxElapsedMs, circuitBreaker, retryPolicy }) {
        if (!name) throw new ConfigurationError({ message: 'DiscussionSession.addAgent requires name' });
        // E-5: the ledger identifies an author by name. Two agents sharing one, or an
        // agent claiming the judge/aggregator author, makes each read the other's
        // turns as its own — the transcript then lies about who said what.
        if (name === 'Judge' || name === 'Aggregator') {
            throw new ConfigurationError({ message: `DiscussionSession.addAgent: "${name}" is a reserved author name (the judge and aggregator turns are recorded under it) — pick another name.`, options: { option: 'name' } });
        }
        if (this.#agents.some((a) => a.name === name)) {
            throw new ConfigurationError({ message: `DiscussionSession.addAgent: an agent named "${name}" already exists — duplicate names make each agent read the other's turns as its own.`, options: { option: 'name' } });
        }
        const resolvedBackend = provider ?? /** @type {any} */ (client)?.provider ?? null;
        if (!execute && (!model || !resolvedBackend)) throw new ConfigurationError({ message: 'DiscussionSession.addAgent requires model and provider, or execute' });
        this.#agents.push({ name, persona, model, provider: resolvedBackend, client: client ?? null, tools, maxIterations, autoExtend, errorHandlers, handoff: handoff ?? null, transfer: transfer ?? null, execute, verify, fallbackModel, hedgeAfterMs, timeoutMs, maxElapsedMs, circuitBreaker, retryPolicy });
        return this;
    }

    /** @param {{agent: *, instruction?: *, tail?: *, summarize?: *, signal?: *}} arg0 */
    async #buildContext( { agent, instruction = null, tail = null, summarize = null, signal = null }) {
        const msgs = [];
        const handoff = normalizeHandoff({ handoff: agent.handoff ?? this._handoff });
        const _ob = goalBlockForHandoff({ ctx: this._agentContext, handoff });
        if (_ob) msgs.push(createUserMessage({ provider: agent.provider, content: _ob }));
        await this.#summaryChain;
        if (handoff.context !== 'clean' && !this.#ledgerView) {
            if (this.#prunedSummary) {
                msgs.push(createUserMessage({ provider: agent.provider, content: `[Earlier discussion summary]: ${this.#prunedSummary}` }));
            } else if (this.#prunedCount > 0) {
                msgs.push(createUserMessage({ provider: agent.provider, content: `[Earlier discussion entries omitted]: ${this.#prunedCount} entries pruned (ledger cap ${this.#prunedCap}).` }));
            }
        }
        const ledger = handoff.context === 'clean' ? [] : (this.#ledgerView ?? this.#ledger);
        const rawTransfer = agent.transfer ?? this._transfer ?? null;
        const base = normalizeTransfer({ transfer: rawTransfer });
        if (base.mode === 'ledger') {
            msgs.push(...await this.#renderLedgerTransfer({ agent, ledger, base, tail, summarize, signal }));
        } else {
            // E-7/W4-6: a stringify transfer's own window applies too; a non-positive
            // tail means no window, and an explicit markerLabel frames what it drops.
            // `compact` stays a ledger-renderer concern here: this path folds the
            // prefix only when the caller passes a `summarize`.
            const effectiveTail = stringifyWindow({ base, raw: rawTransfer, tail });
            const dropped = effectiveTail && ledger.length > effectiveTail ? ledger.length - effectiveTail : 0;
            const markerLabel = rawTransfer && typeof rawTransfer === 'object' && typeof rawTransfer.markerLabel === 'string' && rawTransfer.markerLabel
                ? rawTransfer.markerLabel
                : 'Earlier discussion entries omitted';            let entries = ledger;
            if (dropped > 0) {
                const fold = await foldContext({ rows: ledger, cut: dropped, summarize: summarize
                        ? /** @type {(...args: any[]) => any} */ (( prefixRows) => this.#summarizePrefix({ dropped: prefixRows.length, summarize, signal }))
                        /** @param {{summary: *}} arg0 */
                        : null, wrapSummary: /** @type {(...args: any[]) => any} */ (({ summary }) => createUserMessage({ provider: agent.provider, content: `[Earlier discussion summary]: ${summary}` })), wrapMarker: /** @type {(...args: any[]) => any} */ (({ n, reason }) => createUserMessage({ provider: agent.provider, content: `[${markerLabel}]: ${n} entries (${reason}).` })) });
                if (fold.folded) msgs.push(fold.rows[0]);
                entries = /** @type {LedgerEntry[]} */ (fold.rows.slice(1));
            }
            /** @type {LedgerEntry} */
            for (const entry of entries) {
                if (entry.pass === true) continue;
                if (entry.author === agent.name) {
                    if (entry.content && String(entry.content).trim()) {
                        msgs.push(createAssistantMessage({ provider: agent.provider, content: entry.content, thoughtSignature: entry.thoughtSignature }));
                    }
                } else {
                    msgs.push(createUserMessage({ provider: agent.provider, content: `[${entry.author}]: ${entry.content}` }));
                }
            }
        }
        if (instruction) msgs.push(createUserMessage({ provider: agent.provider, content: instruction }));
        if (msgs.length === 0) msgs.push(createUserMessage({ provider: agent.provider, content: 'Begin.' }));
        return msgs;
    }

    /**
     * Ledger-mode context rows. Each ledger entry becomes one transfer unit
     * shaped for the target agent — own entries replay as assistant rows, peers
     * as `[author]: …` user rows — then the shared transfer primitive windows and
     * renders them. Passes and empty own entries contribute no row, so they are
     * dropped before windowing. A caller-supplied `summarize` (function | true |
     * {model}) is adapted to the renderer's row-based summarizer.
     * @param {{agent: *, ledger: Array<LedgerEntry>, base: import('./transfer.mjs').TransferPolicy, tail: number|null, summarize: *, signal?: *}} arg0
     * @returns {Promise<Array<Record<string, any>>>}
     */
    async #renderLedgerTransfer({ agent, ledger, base, tail, summarize, signal = null }) {
        /** @type {import('./transfer.mjs').TransferPolicy} */
        const policy = { ...base, ...(tail ? { select: 'tail', tail } : {}) };
        /** @type {Array<import('./transfer.mjs').TransferUnit>} */
        const units = [];
        for (const entry of ledger) {
            if (entry.pass === true) continue;
            const own = entry.author === agent.name;
            if (own && !(entry.content && String(entry.content).trim())) continue;
            const content = own ? entry.content : `[${entry.author}]: ${entry.content}`;
            units.push({
                id: entry.author,
                output: content,
                provider: agent.provider,
                messages: [own
                    ? createAssistantMessage({ provider: agent.provider, content: entry.content, thoughtSignature: entry.thoughtSignature })
                    : createUserMessage({ provider: agent.provider, content })],
            });
        }
        const summarizeFn = summarize
            ? /** @type {(...args: any[]) => any} */ (async ( rows) => this.#doSummarize({
                text: rows.map(/** @type {(...args: any[]) => any} */ (( m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))).join('\n'),
                summarize,
                signal,
            }))
            : null;
        const rendered = await renderTransfer({ units, transfer: policy, targetProvider: agent.provider, summarize: summarizeFn });
        return rendered.rows;
    }

    /** @param {{dropped: *, summarize: *, signal?: *}} arg0 */
    async #summarizePrefix( { dropped, summarize, signal = null }) {
        const boundary = this.#ledger[dropped - 1];
        const prior = this.#summaryCache.get(summarize);
        if (prior && prior.lastEntry === boundary) {
            this.#summaryCache.delete(summarize);
            this.#summaryCache.set(summarize, prior);
            return await prior.value;
        }
        const startIdx = prior ? this.#ledger.indexOf(prior.lastEntry) + 1 : 0;
        const promise = (async () => {
            const priorText = prior ? await prior.value : null;
            const slice = this.#ledger.slice(startIdx, dropped);
            if (slice.length === 0) return priorText;
            const delta = slice.map(e => `[${e.author}]: ${e.content}`).join('\n');
            const text = priorText ? `${priorText}\n${delta}` : delta;
            return this.#doSummarize({ text, summarize, signal });
        })();
        this.#summaryCache.set(summarize, { lastEntry: boundary, value: promise });
        if (this.#summaryCache.size > LIMITS.discussion_summary_cache_max) {
            const oldest = this.#summaryCache.keys().next().value;
            this.#summaryCache.delete( (/** @type {Function} */ (oldest)));
        }
        return await promise;
    }

    /** @param {{text: *, summarize: *, signal?: *}} arg0 */
    async #doSummarize( { text, summarize, signal = null }) {
        try {
            if (typeof summarize === 'function') return String((await summarize(text)) ?? '');
            const model = (summarize && typeof summarize === 'object' && summarize.model)
                || this.#agents[0]?.model || null;
            const data = await structuredLlmCall({
                client: /** @type {import('./planning/planner-utils.mjs').StructuredClient} */ (this.client),
                model,
                systemMessage: CONVERSATION_SUMMARY_PROMPT,
                schema: CONVERSATION_SUMMARY_SCHEMA,
                schemaName: 'conversation_summary',
                prompt: text,
                maxAttempts: 1,
                sessionId: this._runCtx?.runId,
                signal: signal ?? undefined,
            });
            return data?.summary ?? '';
        } catch (err) {
            if (isAbortError({ err, signal })) throw err;
            return null;
        }
    }

    /** @param {{agent: *, instruction: *, type?: *, options?: *}} arg0 @returns {Promise<any>} */
    async #runAgentTurn( { agent, instruction, type = 'discussion', options = {} }) {
        const { signal, followUp, verify, maxRetries, tail, summarize } = options;
        throwIfAborted({ signal, message: 'Discussion aborted.' });
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_START, payload: { agent: agent.name, type, turn: this.#turn } });
        let content;
        
        /** @type {string|null} */
                let contentSignature = null;
        try {
            if (agent.execute) {
                const handoff = normalizeHandoff({ handoff: agent.handoff ?? this._handoff });
                const goalClean = handoff.goal === 'clean';
                const execCtx = goalClean || !this._agentContext ? null : this._agentContext.child();
                options.onContext?.(execCtx);
                // A code agent's own model calls join the attempt ledger only
                // through this view.
                const execClient = this.#agentOwner({ agent });
                const raw = await agent.execute({
                    instruction, type, signal,
                    ledger: [...this.#ledger],
                    agent: { name: agent.name, persona: agent.persona },
                    objective: goalClean ? null : (this._objective ?? null),
                    agentContext: execCtx,
                    _merci: execCtx ? merciEnvelope({ ctx: execCtx }) : {},
                    handoff,
                    runContext: this._runCtx,
                    client: execClient,
                    budgetPool: /** @type {any} */ (attemptPoolView({ pool: /** @type {any} */ (this._budgetPool) })),
                });
                content = normalizeAgentOutput({ raw });
                if (!options.deferred) this.#commitObjectiveFrom(execCtx);
            } else if (verify) {
                const owner = this.#agentOwner({ agent });
                const turnGoalCleanForVerify = normalizeHandoff({ handoff: agent.handoff ?? this._handoff }).goal === 'clean';
                const verifyContext = turnGoalCleanForVerify || !this._agentContext ? undefined : this._agentContext.child();
                options.onContext?.(verifyContext);
                const ledgerText = (await this.#buildContext({ agent, instruction, tail:  (tail), summarize, signal }))
                    .map(( m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
                    .join('\n');
                const graph = {
                    entry: 'turn',
                    nodes: [{
                        id: 'turn',
                        model: agent.model,
                        systemPrompt: agent.persona || null,
                        userPromptTemplate: ledgerText,
                        tools: agent.tools || [],
                        verify,
                        ...(agent.maxIterations ? { maxIterations: agent.maxIterations } : {})
                    }],
                    edges: []
                };
                const sm = new StateMachine({ graph: graph, options: {
                    client: owner,
                    defaultModel: agent.model,
                    journal: this._journal ?? undefined,
                    journalScope: `${this._journalScope}${agent.name}:`,
                    contextProcessors: this._contextProcessors,
                    objective: turnGoalCleanForVerify ? undefined : this._objective ?? undefined,
                    agentContext: verifyContext,
                    handoff: agent.handoff ?? this._handoff ?? null,
                    contract: { maxRetries },
                    approval: this._approvalPolicy,
                    sessionPolicy: this._sessionPolicy,
                    ...(this._budget ? { budget: this._remainingBudget() } : {}),
                    memoryProvider:  (this._memoryProvider),
                    memoryOptions: this._memoryOptions,
                    todoStore:  (this._todosStore),
                    todoOptions: this._todosOptions,
                    autoExtend: agent.autoExtend ?? this._autoExtend,
                    errorHandlers:  (agent.errorHandlers ?? this._errorHandlers)
                } });
                sm.on(EVENTS.STATE_MACHINE.NODE_TEXT, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_TEXT, payload: { agent: agent.name, type, content: e.content } }));
                sm.on(EVENTS.STATE_MACHINE.NODE_THOUGHT, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_THOUGHT, payload: { agent: agent.name, type, content: e.content } }));
                sm.on(EVENTS.STATE_MACHINE.NODE_THOUGHT_SIGNATURE, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_THOUGHT_SIGNATURE, payload: { agent: agent.name, type, signature: e.signature } }));
                sm.on(EVENTS.STATE_MACHINE.VERIFY_START, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.VERIFY_START, payload: { agent: agent.name, type, ...e } }));
                sm.on(EVENTS.STATE_MACHINE.VERIFY_PASS, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.VERIFY_PASS, payload: { agent: agent.name, type, attempt: 0, evidence: e.evidence ?? '', ...e } }));
                sm.on(EVENTS.STATE_MACHINE.VERIFY_FAIL, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.VERIFY_FAIL, payload: { agent: agent.name, type, attempt: (e.attempts ?? 1) - 1, evidence: e.evidence ?? '', ...e } }));
                sm.on(EVENTS.STATE_MACHINE.VERIFY_RETRY, (e) => this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.VERIFY_RETRY, payload: { agent: agent.name, type, attempt: e.attempt ?? 0, evidence: e.evidence ?? '', ...e } }));
                await sm.run({ signal, followUp, runContext: this._runCtx });
                this._usageTokens += Number(sm.usageTokens) || 0;
                this._usageUsd += Number(sm.usageUsd) || 0;
                if (!options.deferred) this.#commitObjectiveFrom(verifyContext);
                const nodeOutput = sm.context.get({ k: 'turn' });
                content = nodeOutput === undefined ? sm.toPayloadString() : /** @type {string} */ (nodeOutput);
            } else {
                const owner = this.#agentOwner({ agent });
                const turnGoalClean = normalizeHandoff({ handoff: agent.handoff ?? this._handoff }).goal === 'clean';
                const turnContext = this._agentContext && !turnGoalClean ? this._agentContext.child() : null;
                options.onContext?.(turnContext);
                const history = await this.#buildContext({ agent, instruction, tail:  (tail), summarize, signal });
                const exhaustion = this._exhaustionOpts({ agent });
                const hedgeMs =  (agent.hedgeAfterMs);
                const useLadder = !!agent.fallbackModel || (Number.isFinite(hedgeMs) && hedgeMs > 0);
                /** @param {{modelOverride?: *, runSignal: *}} arg0 */
                const runTurn = ( { modelOverride, runSignal }) => {
                    const model = modelOverride ?? agent.model;
                    const session = this._applyPolicies({ session: owner.session(model), owner });
                    return runStep({ step: agent, deps: {
                        client: owner,
                        model,
                        session,
                        decisionGate: this._decisionGate,
                        journal: this._journal,
                        journalBoundary: `${this._journalScope}${agent.name}:`,
                        contextProcessors: this._contextProcessors,
                        systemPrompt: agent.persona || '',
                        messages: history,
                        tools: agent.tools || [],
                        handoff: normalizeHandoff({ handoff: agent.handoff ?? this._handoff }),
                        agentContext: turnContext,
                        capabilities: {
                            skills: this._skills,
                            skillsPreload: this._skillsPreload,
                            memoryProvider: this._memoryProvider,
                            memoryOptions: this._memoryOptions,
                            todoStore: this._todosStore,
                            todoOptions: this._todosOptions,
                        },
                        approvalPolicy: this._approvalPolicy,
                        sessionPolicy: this._sessionPolicy,
                        // The turn sees the group's remaining budget (the documented
                        // contract). The pool is still the live cap and the pre-call
                        // reservation is what stops a parallel wave from spending the
                        // same remainder twice (E-1).
                        budget: this._remainingBudget(),
                        signal: runSignal,
                        followUp,
                        autoExtend: exhaustion.autoExtend ?? false,
                        errorHandlers: exhaustion.errorHandlers ?? null,
                        maxIterations: agent.maxIterations,
                        sessionId: this._runCtx?.runId ?? null,
                        runContext: this._runCtx,
                        emitter: this,
                        toolEvents: true,
                        events: {
                            text: EVENTS.DISCUSSION.AGENT_TEXT,
                            thought: EVENTS.DISCUSSION.AGENT_THOUGHT,
                            thoughtSignature: EVENTS.DISCUSSION.AGENT_THOUGHT_SIGNATURE,
                            toolStart: EVENTS.DISCUSSION.TOOL_CALL_START,
                            toolEnd: EVENTS.DISCUSSION.TOOL_CALL_END,
                            /** @param {{content: *}} arg0 */
                            makePayload: ({ content }) => ({ agent: agent.name, type, content }),
                        },
                    } }).then(( outcome) => {
                        if (agent.fallbackModel) assertUsableOutput({ text: outcome.result, what: 'agent produced no usable text' });
                        return outcome;
                    });
                };
                const outcome = useLadder
                    ? await runDelegationLadder({
                        profile:  (agent),
                        breaker: agent.circuitBreaker ?? getCircuitBreaker({ client: owner, key: circuitKey({ provider: owner.provider ?? agent.provider, model: agent.model }) }),
                        provider: owner.provider ?? agent.provider,
                        signal,
                        eventEmitter: this,
                        stepRun: this._runCtx,
                        attempt: runTurn,
                    })
                    : await runTurn({ runSignal: signal });
                content = outcome.result;
                contentSignature = outcome.signature;
                this._usageTokens += Number(outcome.usage?.total_tokens) || 0;
                this._usageUsd += Number(outcome.usage?.cost_usd) || 0;
                if (!options.deferred) this.#commitObjectiveFrom(turnContext);
            }
        } catch (err) {
            // A thrown turn still spent tokens: step.mjs attaches the run-level
            // usage to the error (the SM and the DAG charge theirs; this one did not).
            // The whole attempt (`runUsage`), else whatever the error carried.
            // E-2: a budget refusal carries the GROUP total in `err.usage`; charging
            // it adds the spend to itself (60 -> 120 -> 240 ...). A refusal spends
            // nothing, so it is never charged.
            // A pre-call refusal carries the group total in `usage` and no attempt
            // usage; a post-charge failure carries `runUsage` and did spend.
            const refused = err instanceof BudgetExceededError && !/** @type {any} */ (err)?.runUsage;
            const charged = refused ? null : (/** @type {any} */ (err)?.runUsage ?? /** @type {any} */ (err)?.usage);
            this._usageTokens += Number(charged?.total_tokens) || 0;
            this._usageUsd += Number(charged?.cost_usd) || 0;
            return this.#recordAgentError({ name: agent.name, type, err: ( (err)), signal, deferred: options.deferred });
        }
        if (isSdkFallbackOutput({ text: content })) {
            return this.#recordAgentError({ name: agent.name, type, err: new Error(this.#fallbackCause(content)), signal, deferred: options.deferred });
        }
        if (!String(content ?? '').trim()) {
            return this.#recordAgentError({ name: agent.name, type, err: new Error('agent produced no text'), signal, deferred: options.deferred });
        }

        // ponytail: opt-in `stateSchema` validates a content-bearing turn and
        // re-runs it with the violation as feedback, bounded by maxRetries.
        // Judge verdicts (type 'verdict') shape their own JSON and are exempt.
        if (this._stateSchema && type !== 'verdict') {
            const parsed = extractAndParseJson({ input: content });
            const value = parsed.success ? parsed.data : content;
            const schemaErr = stateSchemaViolation({ schema: this._stateSchema, value, label: `Agent "${agent.name}"` });
            if (schemaErr) {
                const prior = /** @type {any} */ (options)._schemaAttempt;
                const attempt = Number.isInteger(prior) ? prior : 0;
                const schemaRetries = Number.isFinite(maxRetries) && /** @type {number} */ (maxRetries) > 0 ? Math.floor(/** @type {number} */ (maxRetries)) : LIMITS.default_retry_limit;
                if (attempt < schemaRetries) {
                    const feedback = schemaCorrection({ detail: schemaErr.message });
                    this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.VERIFY_RETRY, payload: { agent: agent.name, type, attempt, evidence: feedback } });
                    return this.#runAgentTurn({ agent, instruction: `${instruction}\n\nCorrection required: ${feedback}`, type, options: { ...options, _schemaAttempt: attempt + 1 } });
                }
                return this.#recordAgentError({ name: agent.name, type, err: new VerificationError({ message: `Agent "${agent.name}" output failed stateSchema: ${schemaErr.message}`, options: { evidence: schemaErr.message } }), signal, deferred: options.deferred });
            }
        }

        if (String(content).trim().toUpperCase() === 'PASS') {
            if (type === 'verdict' || type === 'aggregation') {
                return this.#recordAgentError({ name: agent.name, type, err: new Error('PASS is not allowed for a ' + type + ' turn'), signal, deferred: options.deferred });
            }
            if (!options.allowPass) {
                return this.#recordAgentError({ name: agent.name, type, err: new Error('agent passed the turn without allowPass'), signal, deferred: options.deferred });
            }
            const entry = { author: agent.name, content: '[pass]', type, thoughtSignature: null, pass: true };
            return options.deferred ? entry : this.#commitEntry(entry);
        }
        const entry = { author: agent.name, content, type, thoughtSignature: contentSignature };
        return options.deferred ? entry : this.#commitEntry(entry);
    }

    /** @param {LedgerEntry} entry */
    #appendLedgerEntry( entry) {
        this.#ledger.push(entry);
        this.#pruneLedger();
    }

    #pruneLedger() {
        const max = this.#maxLedgerEntries;
        if (this.#ledger.length <= max) return;
        const dropped = this.#ledger.length - max;
        const evicted = this.#ledger.splice(0, dropped);
        this.#prunedCount += dropped;
        this.#prunedCap = max;
        this.#summaryCache.clear();
        if (this.#ledgerPruneMode === 'summarize' && this.#ledgerSummarize !== false) {
            const prunedTotal = this.#prunedCount;
            void this.#enqueueSummary(() => this.#foldEvicted({ evicted, cap: max, prunedTotal }));
            return;
        }
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.LEDGER_PRUNED, payload: {
            dropped,
            prunedTotal: this.#prunedCount,
            cap: max,
            summarized: false,
        } });
    }

    
    /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
        #enqueueSummary(fn) {
        const run = this.#summaryChain.then(fn, fn);
        this.#summaryChain = run.then(() => undefined, () => undefined);
        return run;
    }

    
    /**
     * @returns {Promise<{summarized: boolean, dropped: number, summary: string|null}>}
      * @param {{evicted: *, cap: *, prunedTotal: *, summarize?: *, signal?: *}} arg0
     */
        async #foldEvicted({ evicted, cap, prunedTotal, summarize = this.#ledgerSummarize, signal = null }) {
        const delta = truncateForPrompt({ text: evicted.map(/** @type {(...args: any[]) => any} */ (e => `[${e.author}]: ${e.content}`)).join('\n'), maxChars: LIMITS.discussion_summary_input_chars });
        const prior = this.#prunedSummary;
        let summary = null;
        try {
            summary = await this.#doSummarize({ text: prior ? `${prior}\n${delta}` : delta, summarize, signal });
        } catch (err) {
            if (isAbortError({ err, signal })) throw err;
            summary = null;
        }
        if (summary && String(summary).trim()) {
            summary = truncateForPrompt({ text: String(summary).trim(), maxChars: LIMITS.discussion_summary_chars });
            this.#prunedSummary = summary;
        } else {
            summary = null;
        }
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.LEDGER_PRUNED, payload: {
            dropped: evicted.length,
            prunedTotal,
            cap,
            summarized: !!summary,
            ...(summary ? { summary } : {}),
        } });
        return { summarized: !!summary, dropped: evicted.length, summary: summary ?? this.#prunedSummary };
    }

    /** @param {LedgerEntry} entry */
    #stampTurn( entry) {
        entry.turn = this.#turn > 0 ? this.#round : 0;
    }

    /** @param {LedgerEntry} entry */
    #commitEntry( entry) {
        this.#stampTurn(entry);
        this.#appendLedgerEntry(entry);
        const index = this.#ledger.length - 1;
        if (entry.pass === true) {
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_PASS, payload: { agent: entry.author, type: entry.type, turn: this.#turn } });
        } else {
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_FINISH, payload: { agent: entry.author, content: entry.content, type: entry.type, turn: this.#turn } });
        }
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.LEDGER_ENTRY, payload: { author: entry.author, type: entry.type, index, turn: this.#turn } });
        return entry;
    }

    /** @param {LedgerEntry} entry */
    #pushEntry( entry) {
        this.#stampTurn(entry);
        this.#appendLedgerEntry(entry);
        const index = this.#ledger.length - 1;
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.LEDGER_ENTRY, payload: { author: entry.author, type: entry.type, index, turn: this.#turn } });
        return entry;
    }

    
    /** @param {string} content @returns {string} */
        #fallbackCause(content) {
        const kind = fallbackKind({ text: content });
        if (kind === 'schema') return SCHEMA_FALLBACK_CAUSE;
        return kind === 'empty' ? EMPTY_FALLBACK_CAUSE : 'iteration limit reached';
    }

    /** @param {{name: *, type: *, err: *, signal: *, deferred?: *}} arg0 */
    #recordAgentError( { name, type, err, signal, deferred = false }) {
        if (isAbortError({ err, signal })) throw err;
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: { agent: name, type, error: err.message, turn: this.#turn } });
        const entry = { author: name, content: `[error: ${err.message}]`, type, thoughtSignature: null };
        return deferred ? entry : this.#commitEntry(entry);
    }

    
    /**
     * each agent in order; parallel mode runs them concurrently and commits in
     * registration order. Termination conditions (mention tokens or a ledger
     * predicate) are checked at the turn boundary.
     * @param {{instruction: string, turns?: number, sequential?: boolean, signal?: AbortSignal, followUp?: Function, tail?: number, summarize?: Function, termination?: string|string[]|Function, allowPass?: boolean}} arg0 -
     * @returns {Promise<{stopped: boolean, reason: string|null, turns: number}>}
     */
        async discuss({ instruction, turns = LIMITS.discussion_turns, sequential = false, signal, followUp, tail, summarize, termination, allowPass = false }) {
        const opts = { signal, followUp, tail, summarize, allowPass };
        const passHint = allowPass
            ? ' If you have nothing to contribute that is not already on the table, reply with exactly PASS.'
            : '';
        const term = normalizeTermination({ termination });
        let stoppedReason = null;
        let t = 0;
        for (; t < turns; t++) {
            throwIfAborted({ signal, message: 'Discussion aborted.' });
            this.#turn = t + 1;
            this.#round += 1;
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.TURN_START, payload: { turn: t + 1, total: turns } });
            if (sequential) {
                for (const agent of this.#agents) {
                    const [turnOutcome] = await runDueSteps({ steps: [{
                        key: agent.name,
                        run: () => this.#runAgentTurn({ agent, instruction: instruction + passHint, type: 'discussion', options: { ...opts, verify: agent.verify } }),
                    }] });
                    if (turnOutcome.status === 'rejected') throw turnOutcome.reason;
                }
            } else {
                await this.#runParallelTurn({ instruction: instruction + passHint, opts });
            }
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.TURN_END, payload: { turn: t + 1, ledgerCount: this.#ledger.length } });

            if (this.#stopRequested) {
                stoppedReason = this.#stopRequested === true ? 'operator stop requested' : String(this.#stopRequested);
                break;
            }
            const termReason = term.check(this.#ledger);
            if (termReason) { stoppedReason = termReason; break; }
        }
        this.#stopRequested = false;
        const stopped = stoppedReason !== null;
        const turnsRan = stopped ? t + 1 : t;
        this.#lastTurn = this.#round;
        this.#turn = 0;
        if (stopped) {
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.TERMINATED, payload: { reason: stoppedReason, turn: turnsRan } });
        }
        return { stopped, reason: stoppedReason, turns: turnsRan };
    }

    
    /**
     * discuss() breaks with a `discussion:terminated` event. Contrast the hard
     * abort (signal), which throws mid-turn.
     * @param {{reason?: string|boolean}} arg0 - Stop reason, or true for the default.
     * @returns {DiscussionSession}
     */
        requestStop({ reason = true } = {}) {
        this.#stopRequested = reason;
        return this;
    }

    
    /**
     * Clears the ledger, summary folds and stop latch so the next discussion
     * starts clean.
     * @returns {DiscussionSession}
     */
        reset() {
        this.#ledger.length = 0;
        this.#summaryCache.clear();
        this.#stopRequested = false;
        this.#lastTurn = 0;
        this.#prunedCount = 0;
        this.#prunedCap = 0;
        this.#prunedSummary = null;
        return this;
    }

    /** @param {{instruction: *, opts: *}} arg0 */
    async #runParallelTurn( { instruction, opts }) {
        /** @type {any[]} */
        const contexts = [];
        const outcomes = await runDueSteps({ steps: this.#agents.map(a => ({
                key: a.name,
                run: () => this.#runAgentTurn({ agent: a, instruction, type: 'discussion', options: { ...opts, verify: a.verify, deferred: true, onContext: (/** @type {any} */ ctx) => contexts.push(ctx) } }),
            })) });
        const aborted = outcomes.find(/** @type {(...args: any[]) => any} */ (r => r.status === 'rejected' && isAbortError({ err: r.reason, signal: opts.signal })));
        if (aborted) throw aborted.reason;
        for (const r of outcomes) {
            if (r.status === 'fulfilled' && r.value) this.#commitEntry(/** @type {LedgerEntry} */ (r.value));
        }
        this.#commitParallelObjective({ contexts });
    }

    
    /**
     * returns a machine-readable verdict `{ passed, score, revision, reason,
     * content }`; otherwise the raw ledger entry is returned.
     * @param {{instruction?: string, options?: {asVerdict?: boolean, name?: string, persona?: string, model?: string, provider?: string, tools?: Array<Object>, execute?: Function, signal?: AbortSignal, followUp?: Function, tail?: number, summarize?: Function}}} arg0 -
     * @returns {Promise<Object|null>} the ledger entry or parsed verdict.
     */
        async judge({ instruction, options = {} }) {
        if (this.#agents.length === 0) throw new ConfigurationError({ message: 'No agents in discussion' });
        const judgeName = assertAuthorName({ name: options.name, agents: this.#agents, fallback: 'Judge' });
        const ref = this.#agents[0];
        const tail = options.tail;
        const prompt = options.asVerdict
            ? `Evaluate the discussion below. Identify the strongest contribution and explain why.\n\n${instruction || ''}\n\n` +
              'Return your verdict as a single JSON object at the END of your response, with EXACTLY these fields:\n' +
              '{ "passed": boolean, "score": number (0-100), "reason": string, "revision": "minor" | "full" }\n' +
              'where "minor" means only targeted corrections are needed, and "full" means the case must be re-planned from scratch.'
            : `Evaluate the discussion below. Identify the strongest contribution and explain why.\n\n${instruction || ''}`;

        if (options.asVerdict && !this.#ledger.some(isSubstantiveEntry)) {
            return { passed: false, score: 0, revision: 'minor', reason: 'No substantive discussion to judge.', content: '' };
        }

        // A confident System One consensus skips the judge turn entirely. More
        // than eight substantive entries may hide a dissent outside the window,
        // so that case keeps the LLM judge. E-3: only the latest round counts,
        // and a pass or an error is not agreement; W2E-9: a round that is
        // already uncovered is never put to the gate (that would spend a model
        // call on a state that cannot be a consensus).
        const round = this.#lastTurn > 0 ? this.#ledger.filter(e => e.turn === this.#lastTurn) : this.#ledger;
        const substantive = round.filter(isSubstantiveEntry);
        const answered = new Set(substantive.map(e => e.author));
        const covered = this.#agents.every(a => answered.has(a.name));
        const passed = round.filter(e => e.pass === true).length;
        const errors = round.filter(e => String(e.content ?? '').startsWith('[error:')).length;
        if (options.asVerdict && covered && this._decisionGate?.available && substantive.length <= 8) {
            // Keep the full entries: the decision state is compacted for the DM,
            // but the verdict must return the contribution, not its excerpt.
            const excerptOf = (/** @type {string} */ text) => text.length > 800 ? `${text.slice(0, 600)} … ${text.slice(-200)}` : text;
            const entries = substantive.map(e => ({ author: e.author, type: e.type, content: excerptOf(String(e.content)) }));
            const agreement = await this._decisionGate.gate({
                state: { instruction: instruction ?? '', entries, registered: this.#agents.length, substantive: substantive.length, passes: passed, errors },
                question: noulQuestion({ instructions: 'Do the substantive entries agree on one recommendation with no unresolved objection?', criteria: { true: 'They converge on one recommendation and no entry raises an open objection.', false: 'They disagree or an objection remains unresolved.' } }),
                signal: options.signal,
            });
            if (covered && !agreement.escalated && agreement.verdict === true && agreement.certainty !== null && agreement.certainty >= LIMITS.decision_skip_certainty) {
                const strongest = await this._decisionGate.choose({
                    state: { instruction: instruction ?? '', entries },
                    question: choiceQuestion({ instructions: 'Which entry is the strongest contribution?', criteria: { ...Object.fromEntries(entries.map((e, i) => ['e' + i, (e.author + ': ' + e.content).slice(0, 240)])), other: 'None of these is the strongest.' } }),
                    signal: options.signal,
                });
                const match = /^e(\d+)$/.exec(String(strongest.choice ?? ''));
                const index = match ? Number(match[1]) : -1;
                if (!strongest.escalated && !strongest.escaped && index >= 0 && index < substantive.length) {
                    return { passed: true, score: Math.round(agreement.certainty * 100), revision: 'minor', reason: 'decision_gate_consensus', content: String(substantive[index].content) };
                }
            }
        }

        const entry = await this.#runAgentTurn({
            agent: {
                name: judgeName,
                persona: options.persona || 'You are a quality evaluator. Examine all contributions and determine the best one. Explain your reasoning.',
                model: options.model || ref.model,
                provider: options.provider || ref.provider,
                client: (/** @type {any} */ (options)).client ?? ref.client ?? null,
                tools: options.tools || [],
                execute: options.execute,
            },
            instruction: prompt,
            type: 'verdict',
            options: { signal: options.signal, followUp: options.followUp, tail, summarize: options.summarize }
        });
        if (!options.asVerdict) return entry;
        const content = entry?.content ?? '';
        const parsed =  (extractVerdictJson({ content }));
        if (parsed.success && parsed.data && typeof parsed.data === 'object') {
            const raw = parsed.data.score;
            const hasScore = typeof raw === 'number' && Number.isFinite(raw);
            return {
                passed: parsed.data.passed === true,
                score: hasScore ? raw : NaN,
                revision: parsed.data.revision === 'full' ? 'full' : 'minor',
                reason: String(parsed.data.reason ?? ''),
                content
            };
        }
        return { passed: false, score: 0, revision: 'minor', reason: content, content };
    }

    
    /**
     * verdict) into a final answer.
     * @param {{instruction?: string, options?: {name?: string, persona?: string, model?: string, provider?: string, tools?: Array<Object>, execute?: Function, signal?: AbortSignal, followUp?: Function, tail?: number, summarize?: Function}}} arg0 -
     * @returns {Promise<LedgerEntry>} the aggregation ledger entry.
     */
        async aggregate({ instruction, options = {} }) {
        if (this.#agents.length === 0) throw new ConfigurationError({ message: 'No agents in discussion' });
        const aggregatorName = assertAuthorName({ name: options.name, agents: this.#agents, fallback: 'Aggregator' });
        if (!this.#ledger.some(isSubstantiveEntry)) {
            const name = aggregatorName;
            const reason = 'No substantive discussion to aggregate.';
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: { agent: name, type: 'aggregation', error: reason, turn: this.#turn } });
            return { author: name, content: `[error: ${reason}]`, type: 'aggregation', thoughtSignature: null, error: true };
        }
        const ref = this.#agents[0];
        return this.#runAgentTurn({
            agent: {
                name: aggregatorName,
                persona: options.persona || 'You synthesize diverse inputs into a definitive, comprehensive answer.',
                model: options.model || ref.model,
                provider: options.provider || ref.provider,
                client: (/** @type {any} */ (options)).client ?? ref.client ?? null,
                tools: options.tools || [],
                execute: options.execute,
            },
            instruction: `Synthesize the entire discussion and any verdict below into a single final answer.\n\n${instruction || ''}`,
            type: 'aggregation',
            options: { signal: options.signal, followUp: options.followUp, tail: options.tail, summarize: options.summarize }
        });
    }

    
    /**
     * turn per agent; 'full' re-runs per-agent DAG planning with the feedback
     * injected. Emits `discussion:replan`.
     * @param {{instruction: string, mode?: string, round?: number, tail?: number, signal?: AbortSignal, followUp?: Function, summarize?: Function, context?: Object}} arg0 -
     * @returns {Promise<void>}
     */
        async replan({ instruction, mode = 'minor', round, tail, signal, followUp, summarize, context }) {
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.REPLAN, payload: { mode, ...(round != null ? { round } : {}) } });
        if (mode === 'full') {
            await this.planForEach({ instruction, options: { signal, followUp, context } });
            return;
        }
        for (const agent of this.#agents) {
            await this.#runAgentTurn({ agent, instruction, type: 'revision', options: { tail, signal, followUp, summarize, verify: agent.verify } });
        }
    }

    
    /**
     * (replan → rediscuss)* → aggregate, bounded by maxRounds. The judge
     * verdict decides the branch (pass / minor revision / full re-plan); the
     * returned entry carries `accepted` and the `verdict`.
     * @param {{instruction: string, options?: ConcludeOptions}} arg0 -
     * @returns {Promise<Object>} the aggregate entry + { accepted, verdict }.
     */
        async conclude({ instruction, options = {} }) {
        if (this.#agents.length === 0) throw new ConfigurationError({ message: 'No agents in discussion' });
        const { plan, discuss = {}, judge = {}, aggregate = {}, tail, summarize } = options;
        const signal = options.signal;
        const followUp = options.followUp;
        const discussTail = discuss.tail ?? tail;
        const judgeTail = judge.tail ?? tail;
        const aggTail = aggregate.tail ?? tail;
        const discussSummarize = discuss.summarize ?? summarize;
        const judgeSummarize = judge.summarize ?? summarize;
        const aggSummarize = aggregate.summarize ?? summarize;
        const rawRounds = options.maxRounds ?? LIMITS.discuss_max_rounds;
        const maxRounds = Number.isFinite(rawRounds) ? Math.max(1, Math.floor( (rawRounds))) : LIMITS.discuss_max_rounds;
        if (rawRounds !== maxRounds) {
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: {
                agent: 'conclude',
                type: 'config',
                error: `maxRounds ${rawRounds} is not a finite integer >= 1 — using ${maxRounds}.`
            } });
        }
        const judgeOpts = {
            asVerdict: true, tail: judgeTail, signal, followUp, summarize: judgeSummarize,
            model: judge.model, provider: (/** @type {any} */ (judge)).provider, client: (/** @type {any} */ (judge)).client,
            persona: judge.persona, execute: judge.execute, tools: judge.tools
        };
        const aggregateOpts = {
            tail: aggTail, signal, followUp, summarize: aggSummarize,
            model: aggregate.model, provider: (/** @type {any} */ (aggregate)).provider, client: (/** @type {any} */ (aggregate)).client,
            persona: aggregate.persona, execute: aggregate.execute, tools: aggregate.tools
        };
        const sequential = discuss.sequential ?? true;
        
        /** @type {{score: number, ledger: LedgerEntry[]|null}} */
                let best = { score: -Infinity, ledger: null };
        
        /** @type {VerdictEntry|null} */
                let verdict = null;
        
        /** @param {VerdictEntry} v */
                /** @param {{v: *}} arg0 */
                const trackBest = ({ v }) => {
            if (Number.isFinite(v.score) && v.score > best.score) best = { score: v.score, ledger: this.#ledger.slice() };
        };
        try {
            if (plan?.tasks) {
                await this.runTasks({ tasks: plan.tasks, signal, followUp, sequential: plan.sequential });
            } else if (plan) {
                await this.planForEach({ instruction, options: { context: plan.context, signal, followUp } });
            }

            const crossExamine = discuss.instruction
                ?? 'All arguments are on the table. Rebut the strongest point of each opposing argument and defend your own.';
            const opened = await this.discuss({ instruction: crossExamine, turns: discuss.turns ?? LIMITS.discussion_turns, sequential, signal, followUp, tail: discussTail, summarize: discussSummarize, termination: discuss.termination });
            if (opened.stopped) {
                const entry = await this.aggregate({ instruction: aggregate.instruction, options: aggregateOpts });
                const substantive = isSubstantiveEntry(entry);
                if (substantive) await this.#persistConclusion(entry);
                return {
                    ...entry,
                    accepted: false,
                    error: !substantive,
                    stopped: true,
                    stopReason: opened.reason,
                    verdict: null
                };
            }

            const minScore = judge.minScore ?? 0;
            verdict = /** @type {VerdictEntry|null} */ (await this.judge({ instruction: judge.instruction, options: judgeOpts }));
            trackBest({ v: verdict });
            /** @param {{v: *}} arg0 */
            const accepted = ({ v }) => v.passed === true && Number.isFinite(v.score) && v.score >= minScore;
            let acceptedState = accepted({ v: verdict });
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.JUDGED, payload: { passed: acceptedState, score: /** @type {any} */ (verdict).score, revision: /** @type {any} */ (verdict).revision, round: 0, reason: /** @type {any} */ (verdict).reason } });

            for (let round = 1; round <= maxRounds && !acceptedState; round++) {
                if (this.#stopRequested) {
                    this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.TERMINATED, payload: { reason: 'operator stop requested', turn: 0 } });
                    break;
                }
                const mode = /** @type {any} */ (verdict).revision === 'full' ? 'full' : 'minor';
                const feedback = `The judge rejected the current state (score ${/** @type {any} */ (verdict).score ?? '?'}/100): ${/** @type {any} */ (verdict).reason}\n${mode === 'full' ? 'Re-plan your entire case from scratch' : 'Revise your argument'}, incorporating this feedback.`;
                await this.replan({ instruction: feedback, mode, round, tail: judgeTail, signal, followUp, summarize: judgeSummarize });
                const rediscussed = await this.discuss({ instruction: 'Re-examine the revised arguments. Press any remaining weaknesses or concede them.', turns: discuss.turns ?? LIMITS.discussion_turns, sequential, signal, followUp, tail: discussTail, summarize: discussSummarize, termination: discuss.termination });
                if (rediscussed.stopped) break;
                verdict = /** @type {VerdictEntry|null} */ (await this.judge({ instruction: judge.instruction, options: judgeOpts }));
                trackBest({ v: verdict });
                acceptedState = accepted({ v: verdict });
                this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.JUDGED, payload: { passed: acceptedState, score: /** @type {any} */ (verdict).score, revision: /** @type {any} */ (verdict).revision, round, reason: /** @type {any} */ (verdict).reason } });
            }

            const snapshot = best.ledger && best.ledger.length < this.#ledger.length ? best.ledger : null;
            
            let entry;
            if (snapshot) this.#ledgerView = snapshot;
            try {
                entry = await this.aggregate({ instruction: aggregate.instruction, options: aggregateOpts });
            } finally {
                this.#ledgerView = null;
            }
            const substantive = isSubstantiveEntry(entry);
            if (substantive) await this.#persistConclusion(entry);
            const finalVerdict =  (verdict);
            return {
                ...entry,
                accepted: acceptedState && substantive,
                error: !substantive,
                verdict: {
                    passed: /** @type {any} */ (finalVerdict).passed,
                    score: /** @type {any} */ (finalVerdict).score,
                    revision: /** @type {any} */ (finalVerdict).revision,
                    reason: /** @type {any} */ (finalVerdict).reason
                }
            };
        } catch (err) {
            if (isAbortError({ err, signal })) throw err;
            this.#ledgerView = null;
            const message = (/** @type {any} */ (err)).message;
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: { agent: 'conclude', type: 'pipeline', error: message, turn: this.#turn } });
            return {
                author: 'Aggregator',
                content: `[error: ${message}]`,
                type: 'aggregation',
                thoughtSignature: null,
                error: true,
                accepted: false,
                verdict: verdict ? {
                    passed: verdict.passed,
                    score: verdict.score,
                    revision: verdict.revision,
                    reason: verdict.reason
                } : null
            };
        }
    }

    
    /**
     * duplicate/unknown-dependency validation). Each task's output is a ledger
     * entry visible to every later task and phase.
     * @param {{tasks: Array<Object>, signal?: AbortSignal, followUp?: Function, allowPass?: boolean, sequential?: boolean}} arg0 - [{ title, description, assignee, dependsOn, subagent_type?, verify?, maxRetries? }].
     * @returns {Promise<void>}
     */
        async runTasks({ tasks, signal, followUp, allowPass = false, sequential = false }) {
        if (!tasks || tasks.length === 0) return;
        const seen = new Set();
        for (const t of tasks) {
            if (seen.has(/** @type {any} */ (t).title)) {
                throw new ConfigurationError({ message: `runTasks: duplicate task title "${/** @type {any} */ (t).title}"` });
            }
            seen.add(/** @type {any} */ (t).title);
        }
        const titles = new Set(tasks.map(t => /** @type {any} */ (t).title));
        for (const t of tasks) {
            for (const dep of /** @type {any} */ (t).dependsOn ?? []) {
                if (!titles.has(dep)) {
                    this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: {
                        agent: /** @type {any} */ (t).title,
                        type: 'task',
                        error: `Task "${/** @type {any} */ (t).title}" depends on unknown task "${dep}" — dependency ignored.`
                    } });
                }
            }
        }
        const byTitle = new Map(tasks.map(t => [/** @type {any} */ (t).title, t]));
        const steps = tasks.map(t => ({ id: /** @type {any} */ (t).title, dependencies: /** @type {any} */ (t).dependsOn || [] }));
        const order = sortDagNodes({ steps });
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.DAG_ORDER, payload: { order, taskCount: tasks.length } });

        
        /** @type {Set<string>} */
                const failed = new Set();
        
        /** @param {DiscussionTask} task @returns {boolean} */
                /** @param {{task: *}} arg0 */
                const skipIfDepFailed = ({ task }) => {
            const failedDep = (task.dependsOn ?? []).find(/** @type {(...args: any[]) => any} */ (d => failed.has(d)));
            if (!failedDep) return false;
            const author = task.assignee ?? task.subagent_type ?? task.title;
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: {
                agent: author,
                type: 'task',
                error: `Task "${task.title}" skipped: dependency "${failedDep}" failed.`,
                turn: this.#turn,
            } });
            this.#pushEntry({ author, content: `[error: dependency "${failedDep}" failed]`, type: 'task', thoughtSignature: null });
            failed.add(task.title);
            return true;
        };
        
        /** @param {DiscussionTask} task @param {boolean} deferred */
                /** @param {{task: *, deferred: *}} arg0 */
                const runOne = ({ task, deferred }) => task.subagent_type
            ? this.#runSubagentTask({ task, signal, followUp, allowPass, deferred })
            : this.#runAgentTurnForTask({ task, signal, followUp, allowPass, deferred });
        
        /** @param {string} title @param {LedgerEntry|undefined} entry */
                /** @param {{title: *, entry: *}} arg0 */
                const markFailed = ({ title, entry }) => {
            if (!entry || String(entry.content ?? '').startsWith('[error:')) failed.add(title);
        };

        if (sequential) {
            for (const title of order) {
                const task = byTitle.get(title);
                if (!task || skipIfDepFailed({ task })) continue;
                const [taskOutcome] = await runDueSteps({ steps: [{ key: /** @type {any} */ (task).title, run: () => runOne({ task, deferred: false }) }] });
                if (taskOutcome.status === 'rejected') throw taskOutcome.reason;
                markFailed({ title: /** @type {any} */ (task).title, entry: taskOutcome.value });
            }
            return;
        }

        const remaining = new Set(tasks.map(t => /** @type {any} */ (t).title));
        while (remaining.size > 0) {
            const due = tasks.filter(t => remaining.has(/** @type {any} */ (t).title)
                && (/** @type {any} */ (t).dependsOn ?? []).every(/** @type {(...args: any[]) => any} */ (d => !remaining.has(d) || !byTitle.has(d))));
            if (due.length === 0) break;
            
            /** @type {DiscussionTask[]} */
                        const runnable = [];
            for (const task of due) {
                remaining.delete(/** @type {any} */ (task).title);
                if (!skipIfDepFailed({ task })) runnable.push(/** @type {DiscussionTask} */ (task));
            }
            if (runnable.length === 0) continue;
            const outcomes = await runDueSteps({ steps: runnable.map(task => ({
                key: task.title,
                run: () => runOne({ task, deferred: true }),
            })) });
            const aborted = outcomes.find(/** @type {(...args: any[]) => any} */ (r => r.status === 'rejected' && isAbortError({ err: r.reason, signal })));
            if (aborted) throw aborted.reason;
            for (let i = 0; i < outcomes.length; i++) {
                const r = outcomes[i];
                if (r.status === 'rejected') throw r.reason;
                if (r.value) this.#commitEntry( (/** @type {LedgerEntry} */ (r.value)));
                markFailed({ title: runnable[i].title, entry: r.value });
            }
        }
    }

    /** @param {{task: *, signal: *, followUp: *, allowPass: *, deferred?: *}} arg0 */
    async #runAgentTurnForTask( { task, signal, followUp, allowPass, deferred = false }) {
        const assignee = task.assignee ?? await this.#decideAssignee({ task, signal });
        if (!assignee) {
            const error = `Task "${task.title}" has no assignee or subagent_type.`;
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: { agent: task.title, type: 'task', error, turn: this.#turn } });
            const entry = { author: task.title, content: `[error: ${error}]`, type: 'task', thoughtSignature: null };
            return deferred ? entry : this.#pushEntry(entry);
        }
        const agent = this.#agents.find(a => a.name === assignee);
        if (!agent) {
            const error = `No agent named "${assignee}"`;
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: { agent: assignee, type: 'task', error, turn: this.#turn } });
            const entry = { author: assignee, content: `[error: ${error}]`, type: 'task', thoughtSignature: null };
            return deferred ? entry : this.#pushEntry(entry);
        }
        return await this.#runAgentTurn({
            agent,
            instruction:  (task.description),
            type: 'task',
            options: {
                signal, followUp,
                verify: task.verify ?? agent.verify,
                maxRetries: task.maxRetries,
                allowPass,
                deferred
            }
        });
    }

    /**
     * Picks an assignee for a task that names none. A confident choice only;
     * an escalation, the escape option, or a roster of one returns null (the
     * caller then records today's "no assignee" error).
     * @param {{task: *, signal?: AbortSignal}} arg0
     * @returns {Promise<string|null>}
     */
    async #decideAssignee({ task, signal }) {
        if (!this._decisionGate?.available || this.#agents.length < 2) return null;
        const picked = await this._decisionGate.choose({
            state: { task: task.title, description: task.description ?? '' },
            question: choiceQuestion({ instructions: 'Which agent is the best fit for this task?', criteria: { ...Object.fromEntries(this.#agents.map(a => [a.name, String(a.persona ?? a.name).slice(0, 200)])), other: 'None of these agents fits this task.' } }),
            signal,
        });
        return !picked.escalated && !picked.escaped ? picked.choice : null;
    }

    
    /**
     * and executes every step on a fresh subagent context (isolated, no shared
     * history). Step outputs feed dependents via template interpolation.
     * @param {{instruction: string, options?: {model?: string, context?: Object, allowPass?: boolean, signal?: AbortSignal, followUp?: Function}}} arg0 -
     * @returns {Promise<void>}
     */
        async planForEach({ instruction, options = {} }) {
        if (this.#agents.length === 0) throw new ConfigurationError({ message: 'No agents in discussion' });
        const allowPass = options.allowPass === true;
        const planner = new WorkflowPlanner({ options: { client: this.client, model: options.model ?? this.#agents[0].model } });
        // C8: every agent's plan is planned and validated BEFORE any step runs. The old
        // loop warned on an unknown dependency and carried on, so a dependent ran with
        // an `[UNRESOLVED: …]` reference — and in a multi-agent group the first agent
        // had already spent its turns when the second agent's plan turned out invalid.
        /** @type {Array<{agent: any, steps: any[], order: string[]}>} */
        const prepared = [];
        for (const agent of this.#agents) {
            const plan = await planner.plan({ objective: `${instruction}\n\nAssignment for "${agent.name}": ${agent.persona ?? ''}`.trim(), availableTools: [], signal: options.signal ?? null });
            const steps =  (plan.steps ?? []);
            let validated;
            try {
                validated = Plan.fromDag({ steps, objective: instruction }).toDag().steps;
                const { unknown } = validateTemplateRefs({ steps: validated, contextRoots: ['context', ...Object.keys(options.context ?? {})] });
                if (unknown.length > 0) {
                    throw new ConfigurationError({ message: `Unknown template reference(s): ${unknown.map((/** @type {any} */ u) => `'{{${u.expr}}}' in step '${u.stepId}'`).join(', ')}` });
                }
            } catch (error) {
                throw new ConfigurationError({ message: `planForEach: agent "${agent.name}" planned an invalid DAG — ${/** @type {Error} */ (error).message}` });
            }
            const order = sortDagNodes({ steps: validated.map(s => ({ id: s.id, dependencies: s.dependencies ?? [] })) });
            prepared.push({ agent, steps: validated, order });
        }

        for (const { agent, steps, order } of prepared) {
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.DAG_ORDER, payload: { order, taskCount: steps.length, agent: agent.name } });

            /** @type {Record<string, {output: string}>} */
                        const outputs = {};

            /** @type {Set<string>} */
                        const failedSteps = new Set();
            for (const id of order) {
                const step = steps.find(s => s.id === id);
                if (!step) continue;
                const failedDep = (step.dependencies ?? []).find(/** @type {(...args: any[]) => any} */ (d => failedSteps.has(d)));
                if (failedDep) {
                    this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: {
                        agent: agent.name,
                        type: 'task',
                        error: `Planned step "${id}" skipped: dependency "${failedDep}" failed.`,
                        turn: this.#turn,
                    } });
                    this.#pushEntry({ author: agent.name, content: `[error: dependency "${failedDep}" failed]`, type: 'task', thoughtSignature: null });
                    failedSteps.add(id);
                    continue;
                }
                const prompt = interpolateTemplate({ template: step.userPromptTemplate, outputs, stepId: step.id, emitter: this, context: /** @type {Record<string, unknown>} */ (options.context ?? {}) });
                const [stepOutcome] = await runDueSteps({ steps: [{
                    key: step.id,
                    run: () => this.#runSubagentStep({ agent, step, prompt, signal: options.signal, followUp: options.followUp, allowPass }),
                }] });
                if (stepOutcome.status === 'rejected') throw stepOutcome.reason;
                const { content, failed } =  (/** @type {{content?: string|null, failed?: boolean}} */ (stepOutcome.value));
                if (failed) {
                    failedSteps.add(id);
                } else if (content !== null && content !== undefined) {
                    outputs[step.id] = { output: content };
                }
            }
        }
    }

    #taskParentSession() {
        const ref = this.#agents[0];
        const parent = /** @type {any} */ ({
            // The base client, never the runner's view: a task child then gets a
            // capped pool from `_budget` below, not the attempt's report ledger.
            client: /** @type {any} */ (this.client)?.[CLIENT_VIEW_BASE] ?? this.client,
            model: ref?.model ?? null,
            provider: ref?.provider ?? null,
            sessionId: this._runCtx?.runId ?? null,
            _sessionRunCtx: this._runCtx,
            _taskDepth: 0,
            // Every task in this discussion counts against the same tree (D9).
            _spawnTree: (this.#spawnTree ??= { root: this._runCtx?.runId ?? null, count: 0 }),
            _agentContext: this._agentContext,
            _retryPolicy: this._retryPolicy,
            _headerTimeoutMs: null,
            _maxElapsedMs: null,
            _approvalPolicy: this._approvalPolicy,
            _budget: null,
            _streamTimeoutPolicy: this._streamTimeoutPolicy,
            _lastStepMessages: null,
            _journal: this._journal,
            _journalScope: this._journalScope,
        });
        applySessionPolicy({ session: parent, policy: this._sessionPolicy });
        // The policy carries what the group has left, not the cap again. The
        // child pool is parented to the group ledger, so its spend is enforced
        // once and reported once (E-1).
        parent._budget = this._remainingBudget();
        ensureBudgetPool({ session: parent, parent: /** @type {import('./budget-pool.mjs').BudgetPool|null} */ (this._budgetPool) });
        return parent;
    }

    /** @param {{task: *, signal: *, followUp: *, allowPass?: *, deferred?: *}} arg0 */
    async #runSubagentTask( { task, signal, followUp, allowPass = false, deferred = false }) {
        const profile = this.client ? getSpawnRegistry({ client: this.client }).agents?.get(task.subagent_type) : undefined;
        if (!profile) {
            this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_ERROR, payload: { agent: task.subagent_type, type: 'task', error: `No subagent profile "${task.subagent_type}"`, turn: this.#turn } });
            const entry = { author:  (task.subagent_type), content: `[error: No subagent profile "${task.subagent_type}"]`, type: 'task', thoughtSignature: null };
            return deferred ? entry : this.#pushEntry(entry);
        }
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_START, payload: { agent: task.subagent_type, type: 'task', turn: this.#turn } });
        const args =  ({ description: task.description, prompt: task.description, subagent_type: task.subagent_type });
        const parent = this.#taskParentSession();
        const guardOutput = /** @type {(...args: any[]) => any} */ (( result) => assertUsableOutput({
            text: result,
            what: isSdkFallbackOutput({ text: result }) ? this.#fallbackCause(result) : 'subagent produced no text',
        }));
        const attempts = Number.isFinite(task.maxRetries) && (task.maxRetries) > 0
            ? Math.floor((task.maxRetries)) + 1
            : (profile.execute
                ? 1
                : (this._stateSchema || typeof task.verify === 'function' ? LIMITS.default_retry_limit + 1 : 1));
        let schemaFeedback = '';
        for (let attempt = 0; attempt < attempts; attempt++) {
            let content;
            try {
                const raw = await runTaskChild({
                    session: /** @type {any} */ (parent),
                    profile,
                    args: { ...args, prompt: `${args.prompt}${schemaFeedback}` },
                    signal,
                    eventEmitter: this,
                    stepRun: this._runCtx,
                    guardOutput,
                    runOptions: { followUp, .../** @type {{autoExtend?: boolean, errorHandlers?: Function}} */ (this._exhaustionOpts({ agent: profile })) },
                    /** @param {{name: *, payload: *}} arg0 */
                    onChildEvent: forwardToolEvents({ emit: /** @type {(...args: any[]) => any} */ (({ name, payload }) => this._runCtx.emit({ emitter: this, name, payload })), textEvent: EVENTS.DISCUSSION.AGENT_TEXT, thoughtEvent: EVENTS.DISCUSSION.AGENT_THOUGHT, toolStartEvent: EVENTS.DISCUSSION.TOOL_CALL_START, toolEndEvent: EVENTS.DISCUSSION.TOOL_CALL_END, thoughtSignatureEvent: /** @type {any} */ (EVENTS.DISCUSSION).AGENT_THOUGHT_SIGNATURE, makePayload: ({ content }) => ({ agent: task.subagent_type, type: 'task', content, turn: this.#turn }) }),
                });
                content = normalizeAgentOutput({ raw });
            } catch (err) {
                return this.#recordAgentError({ name:  (task.subagent_type), type: 'task', err: ( (err)), signal, deferred });
            }
            if (String(content).trim().toUpperCase() === 'PASS') {
                if (!allowPass) {
                    return this.#recordAgentError({ name:  (task.subagent_type), type: 'task', err: new Error('subagent passed the stage without allowPass'), signal, deferred });
                }
                const passEntry = { author:  (task.subagent_type), content: '[pass]', type: 'task', thoughtSignature: null, pass: true };
                return deferred ? passEntry : this.#commitEntry(passEntry);
            }
            let schemaErr = null;
            if (this._stateSchema) {
                const parsed = extractAndParseJson({ input: content });
                schemaErr = stateSchemaViolation({ schema: this._stateSchema, value: parsed.success ? parsed.data : content, label: `Task "${task.subagent_type}"` });
            }
            if (task.verify || schemaErr) {
                let verdict;
                if (task.verify) {
                    try {
                        verdict = await task.verify(content);
                    } catch (verifyErr) {
                        if (isAbortError({ err: verifyErr, signal })) throw verifyErr;
                        verdict = { passed: false, evidence: (/** @type {any} */ (verifyErr))?.message ?? String(verifyErr) };
                    }
                } else {
                    verdict = { passed: true };
                }
                assertVerifyVerdict({ verdict, label: `Task "${task.subagent_type}"` });
                if (schemaErr || !verdict?.passed) {
                    if (attempt < attempts - 1) {
                        if (schemaErr) schemaFeedback = `\n\nCorrection required: your previous output did not match the required stateSchema: ${schemaErr.message}. Return output matching the schema.`;
                        else schemaFeedback = `\n\nCorrection required: your previous output failed verification: ${verdict?.evidence ?? 'no evidence'}. Revise it and return a corrected result.`;
                        continue;
                    }
                    const evidence = schemaErr ? schemaErr.message : (verdict?.evidence ?? 'no evidence');
                    return this.#recordAgentError({
                        name:  (task.subagent_type),
                        type: 'task',
                        err: new VerificationError({ message: schemaErr ? `subagent stage failed stateSchema: ${schemaErr.message}` : `subagent stage failed verification: ${evidence}`, options: { evidence } }),
                        signal, deferred
                    });
                }
            }
            const entry = { author:  (task.subagent_type), content, type: 'task', thoughtSignature: null };
            return deferred ? entry : this.#commitEntry(entry);
        }
    }

    
    /** @param {{agent: *, step: *, prompt: *, signal: *, followUp: *, allowPass?: *}} arg0 */
    async #runSubagentStep( { agent, step, prompt, signal, followUp, allowPass = false }) {
        this._runCtx.emit({ emitter: this, name: EVENTS.DISCUSSION.AGENT_START, payload: { agent: agent.name, type: 'task', turn: this.#turn } });
        const profile =  ({
            name: agent.name,
            model: agent.model,
            provider: agent.provider ?? null,
            client: agent.client ?? null,
            systemPrompt: step.systemPrompt ?? agent.persona ?? null,
            tools: [...(agent.tools ?? []), ...(step.tools ?? [])],
            maxIterations: step.maxIterations ?? agent.maxIterations,
            execute: agent.execute,
            handoff: agent.handoff ?? this._handoff,
            fallbackModel: step.fallbackModel ?? agent.fallbackModel,
            hedgeAfterMs: step.hedgeAfterMs ?? agent.hedgeAfterMs,
            timeoutMs: step.timeoutMs ?? agent.timeoutMs,
            maxElapsedMs: step.maxElapsedMs ?? agent.maxElapsedMs,
            circuitBreaker: step.circuitBreaker ?? agent.circuitBreaker,
            retryPolicy: step.retryPolicy ?? agent.retryPolicy,
        });
        const parent = this.#taskParentSession();
        const guardOutput = /** @type {(...args: any[]) => any} */ (( result) => assertUsableOutput({
            text: result,
            what: isSdkFallbackOutput({ text: result }) ? this.#fallbackCause(result) : 'planned step produced no text',
        }));
        let content;
        try {
            const raw = await runTaskChild({
                session: /** @type {any} */ (parent),
                profile,
                args: { description: prompt, prompt, subagent_type: agent.name },
                signal,
                eventEmitter: this,
                stepRun: this._runCtx,
                guardOutput,
                /** @param {{name: *, payload: *}} arg0 */
                onChildEvent: forwardToolEvents({ emit: /** @type {(...args: any[]) => any} */ (({ name, payload }) => this._runCtx.emit({ emitter: this, name, payload })), textEvent: EVENTS.DISCUSSION.AGENT_TEXT, thoughtEvent: EVENTS.DISCUSSION.AGENT_THOUGHT, toolStartEvent: EVENTS.DISCUSSION.TOOL_CALL_START, toolEndEvent: EVENTS.DISCUSSION.TOOL_CALL_END, thoughtSignatureEvent: /** @type {any} */ (EVENTS.DISCUSSION).AGENT_THOUGHT_SIGNATURE, makePayload: ({ content }) => ({ agent: agent.name, type: 'task', content, turn: this.#turn }) }),
                runOptions: {
                    followUp,
                    .../** @type {{autoExtend?: boolean, errorHandlers?: Function}} */ (this._exhaustionOpts({ agent: { autoExtend: step.autoExtend ?? agent.autoExtend, errorHandlers: step.errorHandlers ?? agent.errorHandlers } })),
                },
            });
            content = normalizeAgentOutput({ raw });
        } catch (err) {
            this.#recordAgentError({ name: agent.name, type: 'task', err: ( (err)), signal });
            return { content: null, failed: true };
        }
        if (String(content).trim().toUpperCase() === 'PASS') {
            if (!allowPass) {
                this.#recordAgentError({ name: agent.name, type: 'task', err: new Error('planned step passed without allowPass'), signal });
                return { content: null, failed: true };
            }
            this.#commitEntry({ author: agent.name, content: '[pass]', type: 'task', thoughtSignature: null, pass: true });
            return { content: null, failed: false };
        }
        this.#commitEntry({ author: agent.name, content, type: 'task', thoughtSignature: null });
        return { content, failed: false };
    }

    
    /**
     * Registered agent roster (name + tools only).
     * @returns {Array<{name: string, tools: Array<Object>|undefined}>}
     */
        getAgents() { return this.#agents.map(a => ({ name: a.name, tools: a.tools })); }

    
    /**
     * The committed discussion ledger — a SHALLOW copy. The array is yours; the
     * row objects are the session's, so editing `rows[0].content` does change
     * this session (the rows are the same objects `appendLedger` stored). Seed a
     * ledger with `appendLedger`, never by mutating this array.
     * @returns {Array<Object>}
     */
        getLedger() {
        return [...this.#ledger];
    }

    /**
     * Append rows to the ledger — the public seeding seam. It replaces the
     * `getLedger().push(…)` side channel, which worked by redefining `push` on
     * a copy (a mutation that looked like a read). Invalid rows are refused
     * loudly rather than silently dropped: a caller that seeds a malformed row
     * gets a `ConfigurationError`, not a ledger that quietly differs from what
     * it asked for. It appends exactly what it is given and does NOT prune: a
     * seed restores history, and the cap applies on the next committed turn.
     * @param {{entries: Array<LedgerEntry>}} arg0
     * @returns {number} How many rows were appended.
     */
        appendLedger({ entries }) {
        if (!Array.isArray(entries)) {
            throw new ConfigurationError({ message: 'appendLedger: entries must be an array.', options: { option: 'entries' } });
        }
        entries.forEach((entry, i) => {
            if (!entry || typeof entry !== 'object' || typeof entry.author !== 'string' || typeof entry.content !== 'string' || !('thoughtSignature' in entry)) {
                throw new ConfigurationError({ message: `appendLedger: entry ${i} must be { author: string, content: string, thoughtSignature } .`, options: { option: 'entries' } });
            }
        });
        const seedMax = LIMITS.discussion_ledger_seed_max;
        if (this.#ledger.length + entries.length > seedMax) {
            throw new ConfigurationError({ message: `appendLedger: refusing to restore ${entries.length} row(s) onto a ledger of ${this.#ledger.length}; the seed seam holds at most ${seedMax} rows.`, options: { option: 'entries' } });
        }
        for (const entry of entries) this.#ledger.push(entry);
        return entries.length;
    }

    
    /**
 * Phase 2: fold the oldest ledger entries into a retained rolling summary,
 * on demand — call it at any time between discuss/judge/aggregate turns.
 * Unlike the automatic Phase-1 cap (a bare count marker), this keeps the
 * evicted content in compressed form; every later turn's context shows
 * `[Earlier discussion summary]: …` instead of the omission count.
 * Best-effort: a failed/empty summarizer returns null and leaves the count
 * marker in place (never silent, never a throw).
 * @param {{summarize?: Function|boolean|Object, keep?: number, signal?: AbortSignal}} arg0
 * @returns {Promise<{summarized: boolean, dropped: number, summary: string|null}>}
 */
        async summarizeLedger({ summarize = true, keep, signal } = {}) {
        const cap = typeof keep === 'number' && Number.isFinite(keep) && keep >= 0
            ? Math.floor(keep)
            : this.#maxLedgerEntries;
        if (!Number.isFinite(cap)) {
            return { summarized: false, dropped: 0, summary: this.#prunedSummary };
        }
        const cut = this.#ledger.length - cap;
        if (cut <= 0) {
            return { summarized: false, dropped: 0, summary: this.#prunedSummary };
        }
        const evicted = this.#ledger.splice(0, cut);
        this.#prunedCount += evicted.length;
        this.#prunedCap = cap;
        this.#summaryCache.clear();
        return this.#enqueueSummary(() => this.#foldEvicted({ evicted, cap, prunedTotal: this.#prunedCount, summarize, signal }));
    }

    /** @param {LedgerEntry} entry */
    async #persistConclusion( entry) {
        if (!this._memoryProvider || !entry?.content) return;
        try {
            const memory = new MemoryComponent({ provider: this._memoryProvider });
            await memory.save({ args: { content: String(entry.content), category: 'discussion' } });
        } catch {
            return;
        }
    }
}
