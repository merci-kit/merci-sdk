// @ts-check


/**
 * @file `createEngineRunner`: adapts one scheduler attempt to an engine.
 * @version 0.12.0
 *
 * @description
 * The scheduler owns claims, retries, parking, and workspaces; this module owns
 * exactly one attempt. Each adapter builds the configured engine, passes the
 * attempt's `signal`, `runContext`, tools, budget, and a normalized approval,
 * restores a checkpoint with the engine's real rehydration args, and reports
 * the attempt's tree usage: a pooled session's own spend plus its children's.
 *
 * A budgeted `dag`, `stateMachine` or `discussion` attempt gets one cap-less
 * ledger per `run()`, created before any host hook so a plan, graph, tools
 * factory or agent that spends through the provided client is folded in. The
 * `finally` in `run()` takes the delta and releases the ledger.
 *
 * Resume is per engine: `agentic` resumes the saved conversation plus a
 * continuation prompt and attaches an explicit journal (cross-attempt
 * at-most-once is not guaranteed); `dag` and `stateMachine` restore their own
 * checkpoints and save in a `finally`; `discussion` has no checkpoint and
 * refuses a store with `resume`.
 *
 * Progress comes from the engine's own events: a plain DAG step refreshes it on
 * `STEP_START`/`STEP_COMPLETE`/`STEP_ERROR`, a nested state-machine step on
 * `STEP_NODE_*`, a machine node on `NODE_START`/`NODE_END`, and a discussion
 * agent on `AGENT_START`/`AGENT_FINISH`/`JUDGED`. The host `onEvent` sees the
 * engine run's correlation: `workflow:start`/`state_machine:start` is the
 * engine's own envelope, directly parented to the supplied `runContext`.
 *
 * This module never calls `workspace.remove`; cleanup belongs to the
 * scheduler's terminal sites.
 */

import { configurationError, isAbortError } from '../../core/errors.mjs';
import { EVENTS, RunContext } from '../../core/events.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { createUserMessage } from '../../messaging/messages.mjs';
import { fallbackKind } from '../agentic-core.mjs';
import { EMPTY_OUTPUT_CODE } from '../../support/retry-policy.mjs';
import { attemptPoolView, createBudgetPool, ensureBudgetPool, poolUsageSnapshot } from '../budget-pool.mjs';
import { pooledClient, releaseAttemptLedger } from '../pooled-client.mjs';
import { normalizeApproval } from '../approval.mjs';
import { ExecutionJournal, attachJournalSink, restoreJournalSibling } from '../journal.mjs';
import { CHECKPOINT_KIND, restoreCheckpoint, saveCheckpoint } from '../planning/checkpoint.mjs';
import { WorkflowExecutor } from '../planning/executor.mjs';
import { StateMachine } from '../state-machine/machine.mjs';
import { DiscussionSession } from '../discussion-session.mjs';
import { projectUsage, workThreadId } from './state.mjs';

/** @typedef {import('./normalize.mjs').WorkItem} WorkItem */
/** @typedef {import('../planning/executor.mjs').WorkflowStep} WorkflowStep */
/** @typedef {import('../../messaging/unified-parameter.mjs').Tool|string} RunnerTool */

/**
 * The failure code a moderation stop carries: its own code, never the
 * retryable `EMPTY_OUTPUT`, because a retry cannot lift a vendor filter.
 */
const CONTENT_FILTERED_CODE = 'CONTENT_FILTERED';

/**
 * @typedef {'completed'|'failed'|'canceled'} RunnerStatus
 */

/**
 * The one-attempt result the scheduler normalizes. `progress` defaults to
 * true; `summary` never appears in an event.
 * @typedef {Object} RunnerResult
 * @property {RunnerStatus} status
 * @property {boolean} progress
 * @property {object|null} usage
 * @property {string} [summary]
 * @property {unknown} [error]
 */

/**
 * A checkpoint store (`LocalFileSessionStore` or `InMemorySessionStore`).
 * @typedef {Object} RunnerStore
 * @property {(threadId: string) => Promise<Record<string, unknown>|null>} load
 * @property {(arg0: {threadId: string, data: Record<string, unknown>}) => Promise<unknown>} save
 */

/**
 * A checkpoint record as the session store returns it.
 * @typedef {Object} RunnerCheckpoint
 * @property {unknown[]} [messages]
 * @property {unknown} [journal]
 */

/**
 * The fluent chat session surface this module configures. Every method is
 * optional because a host may supply its own builder-shaped object.
 * @typedef {Object} RunnerSession
 * @property {string} [provider]
 * @property {Record<string, number>|null} [_lastRunUsage]
 * @property {(arg0: {store: RunnerStore, threadId: string}) => RunnerSession} [withSessionStore]
 * @property {(arg0: {journal: ExecutionJournal}) => RunnerSession} [withExecutionJournal]
 * @property {(arg0: {tools: Array<RunnerTool>}) => RunnerSession} [withTools]
 * @property {(arg0: {budget: object}) => RunnerSession} [withBudget]
 * @property {(arg0: {fn: Function, options: {timeoutMs?: number}}) => RunnerSession} [withApproval]
 * @property {() => Promise<RunnerCheckpoint|null>} [loadCheckpoint]
 * @property {(arg0: {
 *   initialInput: string|Array<Record<string, unknown>>,
 *   options: {signal?: AbortSignal, runContext?: object|null, onEvent: (event: unknown) => void}
 * }) => Promise<string>} run
 */

/**
 * @typedef {Object} RunnerClient
 * @property {(model: string) => RunnerSession} session
 */

/**
 * The normalized approval both the chat builder and the engines accept.
 * @typedef {Object} NormalizedApproval
 * @property {Function} callback
 * @property {number} [timeoutMs]
 */

/**
 * A DAG plan returned by `planFor`. `steps` is optional: a plan may rely on
 * the restored checkpoint's steps.
 * @typedef {Object} RunnerPlan
 * @property {string} [objective]
 * @property {Record<string, unknown>} [context]
 * @property {Array<WorkflowStep>} [steps]
 */

/**
 * Resolve a value-or-function option for this attempt. The bag is additive: a
 * callback that ignores `client`, `budgetPool` and `runContext` is unchanged.
 * `client`/`budgetPool` are null for `agentic`, which keeps its own pool.
 * @param {{value: unknown, item: WorkItem, attempt: number|null, workspace?: Record<string, unknown>|null, client?: unknown, budgetPool?: unknown, runContext?: RunContext|null}} arg0 -
 * @returns {unknown}
 */
function resolveOption({ value, item, attempt, workspace = null, client = null, budgetPool = null, runContext = null }) {
    return typeof value === 'function' ? value({ item, attempt, workspace, client, budgetPool, runContext }) : value;
}

/**
 * @param {{value: unknown, item: WorkItem, attempt: number|null, continuation?: boolean}} arg0 -
 * @returns {string}
 */
function resolveText({ value, item, attempt, continuation = false }) {
    // A text resolver is item/attempt scoped: it gets no client and no ledger.
    const resolved = typeof value === 'function' ? value({ item, attempt, continuation }) : value;
    if (typeof resolved === 'string') return resolved;
    return resolved === null || resolved === undefined ? '' : String(resolved);
}

/**
 * @param {{value: unknown, item: WorkItem, attempt: number|null, workspace?: Record<string, unknown>|null, client?: unknown, budgetPool?: unknown, runContext?: RunContext|null}} arg0 -
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function resolveAgents({ value, item, attempt, workspace = null, client = null, budgetPool = null, runContext = null }) {
    const resolved = resolveOption({ value, item, attempt, workspace, client, budgetPool, runContext });
    // Like graphFor: only a real Promise is awaited, so a thenable array passes through.
    const agents = resolved instanceof Promise ? await resolved : resolved;
    return Array.isArray(agents) ? /** @type {Array<Record<string, unknown>>} */ (agents) : [];
}

/**
 * @param {{value: unknown, item: WorkItem, attempt: number|null, workspace: Record<string, unknown>|null, client?: unknown, budgetPool?: unknown, runContext?: RunContext|null}} arg0 -
 * @returns {Promise<Array<RunnerTool>>}
 */
async function resolveTools({ value, item, attempt, workspace, client = null, budgetPool = null, runContext = null }) {
    const resolved = resolveOption({ value, item, attempt, workspace, client, budgetPool, runContext });
    // Like graphFor: only a real Promise is awaited, so a thenable array passes through.
    const tools = resolved instanceof Promise ? await resolved : resolved;
    return Array.isArray(tools) ? /** @type {Array<RunnerTool>} */ (tools) : [];
}

/**
 * Cap a summary at the documented character limit.
 * @param {{value: unknown}} arg0 -
 * @returns {string}
 */
function capSummary({ value }) {
    const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
    const maxChars = LIMITS.runner_summary_chars;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Sum every finite numeric usage field across the executor's steps. A step may
 * carry no usage at all; no field is invented.
 * @param {{steps: Map<string, WorkflowStep>}} arg0 -
 * @returns {Record<string, number>}
 */
function usageTotals({ steps }) {
    /** @type {Record<string, number>} */
    const totals = {};
    for (const step of steps.values()) {
        const usage = step.usage;
        if (!usage || typeof usage !== 'object') continue;
        for (const [key, value] of Object.entries(usage)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            totals[key] = (totals[key] ?? 0) + value;
        }
    }
    return totals;
}

/**
 * Only the change this attempt added. Fields that did not change are omitted;
 * an empty result is `null`, so the scheduler reports "no usage" rather than
 * zeroes it did not observe.
 * @param {{before: Record<string, number>, after: Record<string, number>}} arg0 -
 * @returns {Record<string, number>|null}
 */
function usageDiff({ before, after }) {
    /** @type {Record<string, number>} */
    const diff = {};
    for (const [key, value] of Object.entries(after)) {
        const previous = Number.isFinite(before[key]) ? before[key] : 0;
        const delta = value - previous;
        if (delta !== 0) diff[key] = delta;
    }
    return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * The tree ledger of the attempt's session: its own model calls plus every
 * delegated child. `null` when the session has no budget and therefore no pool.
 * `pool` is the live ledger, so a replaced pool is distinguishable from the same
 * one.
 * @typedef {Object} PoolUsageSnapshot
 * @property {Object} pool
 * @property {number} prompt_tokens
 * @property {number} completion_tokens
 * @property {number} total_tokens
 * @property {number|null} cost_usd
 */

/**
 * @param {{session: RunnerSession}} arg0 -
 * @returns {PoolUsageSnapshot|null}
 */
function poolUsage({ session }) {
    // The live pool, not `getBudgetPool`'s copy: identity is what the delta needs.
    const pool = ensureBudgetPool({ session });
    if (pool === null) return null;
    return {
        pool,
        prompt_tokens: pool.usage.prompt_tokens,
        completion_tokens: pool.usage.completion_tokens,
        total_tokens: pool.usage.total_tokens,
        cost_usd: pool.usage.cost_usd
    };
}

/**
 * The spend this attempt added: after minus before, never negative, in the
 * scheduler's spelling. A null before-cost means "no cost reported yet" and
 * counts as zero, so the first costed attempt still reports it; a null after-cost
 * stays unknown because the pool never saw a price. Nothing observed and nothing
 * reported is `null`, not a zero block. A replaced pool is unknown too.
 * @param {{before: PoolUsageSnapshot|null, after: PoolUsageSnapshot|null}} arg0 -
 * @returns {Record<string, number|null>|null}
 */
function usageDelta({ before, after }) {
    if (before === null || after === null || before.pool !== after.pool) return null;
    const cost = typeof after.cost_usd === 'number' && Number.isFinite(after.cost_usd)
        ? Math.max(0, after.cost_usd - (before.cost_usd ?? 0))
        : null;
    const projected = projectUsage({
        usage: {
            prompt_tokens: Math.max(0, after.prompt_tokens - before.prompt_tokens),
            completion_tokens: Math.max(0, after.completion_tokens - before.completion_tokens),
            total_tokens: Math.max(0, after.total_tokens - before.total_tokens),
            cost_usd: cost
        }
    });
    if (projected === null) return null;
    const input = projected.inputTokens ?? 0;
    const output = projected.outputTokens ?? 0;
    if (input === 0 && output === 0 && projected.totalTokens === 0 && projected.costUsd === null) return null;
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: projected.totalTokens,
        cost_usd: projected.costUsd
    };
}

/**
 * The pool's usage with the ledger attached, so a delta can tell the same pool
 * from a replaced one.
 * @param {{pool: import('../budget-pool.mjs').BudgetPool}} arg0 -
 * @returns {PoolUsageSnapshot}
 */
function poolSnapshot({ pool }) {
    return { pool, ...poolUsageSnapshot({ pool }) };
}

/**
 * The spend this attempt added. A pooled attempt that observed nothing reports an
 * explicit zero so the scheduler's `usageComplete` stays true; no pool reports
 * nothing (the old contract).
 * @param {{before: PoolUsageSnapshot|null, after: PoolUsageSnapshot|null}} arg0 -
 * @returns {Record<string, number|null>}
 */
function attemptUsage({ before, after }) {
    return usageDelta({ before, after }) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: null };
}

/**
 * Whether this budget carries a cap the engine would enforce — the same positive
 * rule `withBudget` applies. No cap means no attempt ledger.
 * @param {{budget: object|null}} arg0 -
 * @returns {boolean}
 */
function hasPositiveCap({ budget }) {
    const caps = engineBudget({ budget });
    if (caps === null) return false;
    const tokens = Number(caps.maxTotalTokens);
    return (Number.isFinite(tokens) && tokens > 0)
        || (typeof caps.maxBudgetUsd === 'number' && caps.maxBudgetUsd > 0);
}

/**
 * @param {{record: object, key: string}} arg0 -
 * @returns {unknown}
 */
function safeBudgetField({ record, key }) {
    try {
        return /** @type {Record<string, unknown>} */ (record)[key];
    } catch {
        return undefined;
    }
}

/**
 * The engine's budget spelling: the coordination layer writes `maxTotalUsd`,
 * the chat builder reads `maxBudgetUsd`. Both usages are the same cap, so the
 * smaller positive one wins and a hostile or non-numeric value is ignored, never
 * coerced. The scheduler's aggregate limits never reach here.
 * @param {{budget: unknown}} arg0 -
 * @returns {{maxTotalTokens?: unknown, maxBudgetUsd?: number}|null}
 */
function engineBudget({ budget }) {
    if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) return null;
    /** @type {number[]} */
    const caps = [];
    for (const key of ['maxBudgetUsd', 'maxTotalUsd']) {
        const value = safeBudgetField({ record: budget, key });
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) caps.push(value);
    }
    /** @type {{maxTotalTokens?: unknown, maxBudgetUsd?: number}} */
    const out = {};
    const tokens = safeBudgetField({ record: budget, key: 'maxTotalTokens' });
    if (tokens !== undefined) out.maxTotalTokens = tokens;
    if (caps.length > 0) out.maxBudgetUsd = Math.min(...caps);
    return out;
}

/**
 * Record a checkpoint failure on an attempt that already failed: the run's own
 * error stays the message, the durability failure rides it for the audit (W2C-1).
 * @param {{error: unknown, durabilityError: unknown}} arg0 -
 * @returns {void}
 */
function attachDurabilityError({ error, durabilityError }) {
    if (error === null || typeof error !== 'object') return;
    try {
        (/** @type {Record<string, unknown>} */ (error)).durabilityError = durabilityError;
    } catch {
        // A frozen error keeps its own message; the attempt is failed either way.
    }
}

/**
 * @param {{client: RunnerClient, model: string, store: RunnerStore|null, tools: Array<RunnerTool>, budget: object|null, approval: NormalizedApproval|null, prompt: unknown, resume: boolean, resumePrompt: string, onEvent: ((event: unknown) => void)|null, item: WorkItem, attempt: number|null, continuation: boolean, signal: AbortSignal, runContext: RunContext|null, reportProgress: () => void, measured: {usage: Record<string, number|null>|null}, threadId: string}} arg0 -
 * @returns {Promise<RunnerResult>}
 */
async function runAgentic({
    client,
    model,
    store,
    tools,
    budget,
    approval,
    prompt,
    resume,
    resumePrompt,
    onEvent,
    item,
    attempt,
    continuation,
    signal,
    runContext,
    reportProgress,
    measured,
    threadId
}) {
    const session = client.session(model);
    if (store !== null && typeof session.withSessionStore === 'function') {
        session.withSessionStore({ store, threadId });
    }
    // A fresh journal covers in-run retries; a resume's loadCheckpoint replaces
    // it with the saved one (SCH-07).
    session.withExecutionJournal?.({ journal: new ExecutionJournal() });
    session.withTools?.({ tools });
    if (budget !== null) session.withBudget?.({ budget });
    if (approval !== null) {
        session.withApproval?.({ fn: approval.callback, options: { timeoutMs: approval.timeoutMs } });
    }

    /** @type {string|Array<Record<string, unknown>>} */
    let initialInput = resolveText({ value: prompt, item, attempt, continuation });
    const resumeAttempt = resume && attempt !== null && store !== null;
    if (resumeAttempt && typeof session.loadCheckpoint === 'function') {
        const saved = await session.loadCheckpoint();
        const messages = Array.isArray(saved?.messages) ? saved.messages : [];
        if (messages.length > 0) {
            initialInput = [
                .../** @type {Array<Record<string, unknown>>} */ (messages),
                createUserMessage({ provider: String(session.provider ?? ''), content: resumePrompt })
            ];
        }
    }

    const wrapped = (/** @type {unknown} */ event) => {
        reportProgress();
        onEvent?.(event);
    };
    const poolBefore = poolUsage({ session });
    /** @type {string} */
    let text = '';
    try {
        text = await session.run({ initialInput, options: { signal, runContext, onEvent: wrapped } });
    } finally {
        // A failed or canceled attempt still spent tree tokens; the delta is the
        // only honest report for it.
        measured.usage = poolBefore === null ? null : usageDelta({ before: poolBefore, after: poolUsage({ session }) });
    }
    // A fallback sentinel is the loop's "no answer" notice, not an answer.
    const kind = fallbackKind({ text });
    if (kind !== null) {
        /** @type {any} */
        const error = new Error(`The agentic attempt produced no usable answer (${kind} fallback).`);
        if (kind === 'filtered') {
            // Moderation is the vendor's final verdict: an empty-output retry
            // cannot lift it, so it gets its own code and parks.
            error.code = CONTENT_FILTERED_CODE;
            error.nonRetryable = true;
        } else {
            error.code = EMPTY_OUTPUT_CODE;
        }
        return { status: 'failed', progress: true, usage: poolBefore === null ? session._lastRunUsage ?? null : measured.usage, error };
    }
    return {
        status: 'completed',
        progress: true,
        usage: poolBefore === null ? session._lastRunUsage ?? null : measured.usage,
        summary: capSummary({ value: text })
    };
}

/**
 * @param {{client: RunnerClient, model: string, store: RunnerStore|null, tools: Array<RunnerTool>, budget: object|null, approval: NormalizedApproval|null, objective: unknown, planFor: Function, pool: import('../budget-pool.mjs').BudgetPool|null, resume: boolean, item: WorkItem, attempt: number|null, signal: AbortSignal, runContext: RunContext|null, onEvent: ((event: unknown) => void)|null, reportProgress: () => void, threadId: string}} arg0 -
 * @returns {Promise<RunnerResult>}
 */
async function runDag({
    client,
    model,
    store,
    tools,
    budget,
    approval,
    objective,
    planFor,
    pool,
    resume,
    item,
    attempt,
    signal,
    runContext,
    onEvent,
    reportProgress,
    threadId
}) {
    const resumeAttempt = resume && attempt !== null && store !== null;
    const plan = /** @type {RunnerPlan} */ (await planFor({ item, attempt, signal, client, budgetPool: attemptPoolView({ pool }), runContext }));
    const executorOptions = {
        client,
        defaultModel: model,
        tools,
        signal,
        budget: /** @type {{maxTotalTokens: number}|null} */ (budget),
        approval,
        runContext,
        maxConcurrency: LIMITS.runner_step_concurrency,
        // G1-1: an INJECTED journal is the one `execute()` keeps; the executor
        // replaces a non-injected journal on every run, which would drop the sink.
        ...(store !== null ? { journal: new ExecutionJournal() } : {}),
    };

    /** @type {WorkflowExecutor|null} */
    let executor = null;
    if (resumeAttempt) {
        const saved = await store.load(threadId);
        // The rehydration arg is the options object, not `{ options }` (SCH-04).
        executor = /** @type {WorkflowExecutor|null} */ (/** @type {unknown} */ (restoreCheckpoint({
            saved,
            kind: CHECKPOINT_KIND.WORKFLOW,
            args: [executorOptions]
        })));
    }
    executor ??= new WorkflowExecutor({ options: executorOptions });
    // G1-1: the journal's INTENT row reaches disk before a tool runs. A resumed
    // attempt also folds in the sibling written by the crashed incarnation.
    // `execute()` creates the journal lazily, so create it here to attach the
    // sink; the same object is then used for the run.
    if (store !== null) {
        executor._journal ??= new ExecutionJournal();
        if (resumeAttempt) await restoreJournalSibling({ journal: executor._journal, store, threadId });
        attachJournalSink({ journal: executor._journal, store, threadId });
    }
    if (Array.isArray(plan.steps) && plan.steps.length > 0) {
        // The same plan reattaches verify/tools while preserving statuses (SCH-05).
        executor.setSteps({ stepsList: plan.steps });
    }
    if (resumeAttempt) executor.retryFailedSteps();

    const onStep = () => { reportProgress(); };
    // A plain DAG step emits STEP_START/COMPLETE/ERROR only; a nested
    // state-machine step also emits STEP_NODE_*. Both refresh progress (AC12).
    executor.on(EVENTS.WORKFLOW.STEP_START, onStep);
    executor.on(EVENTS.WORKFLOW.STEP_COMPLETE, onStep);
    executor.on(EVENTS.WORKFLOW.STEP_ERROR, onStep);
    executor.on(EVENTS.WORKFLOW.STEP_NODE_START, onStep);
    executor.on(EVENTS.WORKFLOW.STEP_NODE_END, onStep);
    // The engine run's START is parented to the supplied runContext; forward it
    // unchanged so the host sees the correlation (SCH-22).
    if (typeof onEvent === 'function') executor.on(EVENTS.WORKFLOW.START, (event) => onEvent(event));

    const before = usageTotals({ steps: executor.steps });
    /** @type {Record<string, number>|null} */
    let usage = null;
    /** @type {unknown} */
    let failure = null;
    try {
        await executor.execute({
            userGoal: plan.objective ?? resolveText({ value: objective, item, attempt }),
            context: plan.context ?? {}
        });
    } catch (error) {
        failure = error;
    } finally {
        usage = usageDiff({ before, after: usageTotals({ steps: executor.steps }) });
    }
    if (store !== null) {
        try {
            // Saved even when execute throws: a failed attempt must not lose
            // the state it reached (SCH-33).
            await saveCheckpoint({ store, threadId, kind: CHECKPOINT_KIND.WORKFLOW, payload: executor.save() });
        } catch (error) {
            // W2C-1: a checkpoint that did not land cannot be resumed, so the
            // attempt fails instead of claiming completion.
            if (failure === null) return { status: 'failed', progress: true, usage, error };
            attachDurabilityError({ error: failure, durabilityError: error });
        }
    }
    if (failure !== null) throw failure;
    return {
        status: 'completed',
        progress: true,
        usage,
        summary: capSummary({ value: executor.toPayloadString() })
    };
}

/**
 * D-4: an implicit terminal is a dead end, not an answer — the node ran but no
 * transition matched, so the goal was never reached. Direct `StateMachine.run()`
 * still ends `done` with a warning; the scheduler must not report completion.
 * @param {{machine: StateMachine}} arg0 -
 * @returns {Error}
 */
function implicitTerminalError({ machine }) {
    return new Error(`StateMachine ended on a dead end at node "${String(machine.implicitTerminal)}" (no matching transition); the run did not complete its goal.`);
}

/**
 * @param {{client: RunnerClient, model: string, store: RunnerStore|null, tools: Array<RunnerTool>, budget: object|null, approval: NormalizedApproval|null, graphFor: Function, contract: object|null, pool: import('../budget-pool.mjs').BudgetPool|null, resume: boolean, item: WorkItem, attempt: number|null, signal: AbortSignal, runContext: RunContext|null, onEvent: ((event: unknown) => void)|null, reportProgress: () => void, threadId: string}} arg0 -
 * @returns {Promise<RunnerResult>}
 */
async function runStateMachine({
    client,
    model,
    store,
    tools,
    budget,
    approval,
    graphFor,
    contract,
    pool,
    resume,
    item,
    attempt,
    signal,
    runContext,
    onEvent,
    reportProgress,
    threadId
}) {
    const resumeAttempt = resume && attempt !== null && store !== null;
    const built = graphFor({ item, attempt, signal, client, budgetPool: attemptPoolView({ pool }), runContext });
    // A graph may carry a `then` transition verb, so only a real Promise is awaited.
    const graph = /** @type {Record<string, unknown>} */ (built instanceof Promise ? await built : built);
    const smOptions = { client, defaultModel: model, tools, budget, approval, runContext, contract };

    /** @type {StateMachine|null} */
    let machine = null;
    if (resumeAttempt) {
        const saved = await store.load(threadId);
        machine = /** @type {StateMachine|null} */ (/** @type {unknown} */ (restoreCheckpoint({
            saved,
            kind: CHECKPOINT_KIND.STATE_MACHINE,
            args: [graph, smOptions]
        })));
    }
    machine ??= new StateMachine({ graph, options: smOptions });
    if (machine.phase === 'done') {
        // W2C-2: a finished checkpoint is the answer; stepping it starts from
        // `current: null` and fails with `Unknown node: "null"`.
        // D-4: a finished dead end is not a finished goal.
        if (machine.implicitTerminal !== null) {
            return { status: 'failed', progress: false, usage: { total_tokens: 0 }, error: implicitTerminalError({ machine }) };
        }
        return { status: 'completed', progress: true, usage: { total_tokens: 0 }, summary: capSummary({ value: machine.toPayloadString() }) };
    }
    // G1-1: same seam as the DAG — durable intent before a tool effect.
    if (store !== null) {
        if (resumeAttempt) await restoreJournalSibling({ journal: machine.journal, store, threadId });
        attachJournalSink({ journal: machine.journal, store, threadId });
    }

    const onNode = () => { reportProgress(); };
    machine.on(EVENTS.STATE_MACHINE.NODE_START, onNode);
    machine.on(EVENTS.STATE_MACHINE.NODE_END, onNode);
    if (typeof onEvent === 'function') {
        machine.on(EVENTS.STATE_MACHINE.START, (event) => onEvent(event));
        // D-4: the implicit-terminal warning is an event, not a log line that is off by default.
        machine.on(EVENTS.CLIENT.WARNING, (event) => onEvent(event));
    }

    const before = machine.usageTokens;
    /** @type {{total_tokens: number}|null} */
    let usage = null;
    /** @type {unknown} */
    let failure = null;
    try {
        await machine.run({ signal, runContext: runContext ?? undefined });
    } catch (error) {
        failure = error;
    } finally {
        usage = { total_tokens: machine.usageTokens - before };
    }
    if (store !== null) {
        try {
            await saveCheckpoint({ store, threadId, kind: CHECKPOINT_KIND.STATE_MACHINE, payload: machine.save() });
        } catch (error) {
            // W2C-1: no durable checkpoint, no completed attempt.
            if (failure === null) return { status: 'failed', progress: true, usage, error };
            attachDurabilityError({ error: failure, durabilityError: error });
        }
    }
    if (failure !== null) throw failure;
    if (machine.phase !== 'done') {
        // F2-1: no completion, no success — a failed gate (or any other phase) is a failed attempt.
        return {
            status: 'failed',
            progress: true,
            usage,
            error: new Error(`StateMachine attempt did not complete (phase: ${machine.phase}).`)
        };
    }
    if (machine.implicitTerminal !== null) {
        // D-4: the machine ended on a node with no matching transition; the
        // warning was already forwarded, and the attempt is not a completion.
        return { status: 'failed', progress: false, usage, error: implicitTerminalError({ machine }) };
    }
    return {
        status: 'completed',
        progress: true,
        usage,
        summary: capSummary({ value: machine.toPayloadString() })
    };
}

/**
 * @param {{client: RunnerClient, budget: object|null, approval: NormalizedApproval|null, objective: unknown, agents: unknown, pool: import('../budget-pool.mjs').BudgetPool|null, item: WorkItem, attempt: number|null, workspace: Record<string, unknown>|null, signal: AbortSignal, runContext: RunContext|null, reportProgress: () => void}} arg0 -
 * @returns {Promise<RunnerResult>}
 */
async function runDiscussion({
    client,
    budget,
    approval,
    objective,
    agents,
    pool,
    item,
    attempt,
    workspace,
    signal,
    runContext,
    reportProgress
}) {
    const objectiveText = resolveText({ value: objective, item, attempt });
    const session = new DiscussionSession({
        client,
        options: { objective: objectiveText, budget, approval, runContext, budgetPool: pool }
    });
    const onAgent = () => { reportProgress(); };
    session.on(EVENTS.DISCUSSION.AGENT_START, onAgent);
    session.on(EVENTS.DISCUSSION.AGENT_FINISH, onAgent);
    session.on(EVENTS.DISCUSSION.JUDGED, onAgent);
    for (const agent of await resolveAgents({ value: agents, item, attempt, workspace, client, budgetPool: attemptPoolView({ pool }), runContext })) {
        session.addAgent(/** @type {Parameters<DiscussionSession['addAgent']>[0]} */ (agent));
    }
    /** @type {Record<string, unknown>} */
    const outcome = /** @type {Record<string, unknown>} */ (await session.conclude({
        instruction: objectiveText,
        options: { signal }
    }));
    return {
        status: outcome.accepted === true ? 'completed' : 'failed',
        progress: true,
        usage: { total_tokens: session.usageTokens },
        summary: capSummary({ value: outcome.content })
    };
}

/** @type {ReadonlySet<string>} */
const SUPPORTED_ENGINES = new Set(['agentic', 'dag', 'stateMachine', 'discussion']);

/** Every option `createEngineRunner` reads; an unknown key is refused, never dropped. */
const RUNNER_OPTIONS = Object.freeze({
    engine: true,
    client: true,
    model: true,
    store: true,
    tools: true,
    budget: true,
    approval: true,
    prompt: true,
    objective: true,
    planFor: true,
    graphFor: true,
    agents: true,
    resume: true,
    resumePrompt: true,
    threadId: true,
    onEvent: true,
    contract: true
});

/**
 * Build the one-attempt runner for a scheduler. Construction validates the
 * options; nothing touches a client, store, or engine until `run()`. A
 * function `threadId` must be pure and unique per item: the same id resolved
 * for a different item identifier is refused as `thread_collision`.
 *
 * A host hook gets its own bag. `tools` and `agents` get
 * `{ item, attempt, workspace, client, budgetPool, runContext }`; `planFor` and
 * `graphFor` get `{ item, attempt, signal, client, budgetPool, runContext }`;
 * `prompt`, `objective` and `threadId` get `{ item, attempt }` — and `prompt`
 * also gets `continuation`, the scheduler's dispatch kind, so a retry prompt can
 * tell a continuation from a first run. `budgetPool` is
 * a frozen read-only view of the attempt ledger (caps via getters, usage as a
 * frozen copy), so hooks charge it by calling `client`, never by writing the
 * handle. The attempt's ledger exists before any hook runs, so a model call made
 * through `client` is inside the delta. `agentic` keeps its own session pool, so
 * `client` and `budgetPool` are null there. A host hook that ignores the keys
 * behaves as before. `tools`, `agents`, `planFor` and `graphFor` may return a
 * Promise and are awaited; a thenable non-Promise (a graph object with a `then`
 * transition verb) is passed through as is.
 * @param {{
 *   engine?: string,
 *   client?: unknown,
 *   model?: unknown,
 *   store?: unknown,
 *   tools?: unknown,
 *   budget?: unknown,
 *   approval?: unknown,
 *   prompt?: unknown,
 *   objective?: unknown,
 *   planFor?: unknown,
 *   graphFor?: unknown,
 *   agents?: unknown,
 *   contract?: unknown,
 *   resume?: boolean,
 *   resumePrompt?: string,
 *   threadId?: string|((arg0: {item: WorkItem, attempt: number|null}) => string)|null,
 *   onEvent?: ((event: unknown) => void)|null
 * }} [options] -
 * @returns {{
 *   run: (arg0: {
 *     item: WorkItem,
 *     attempt?: number|null,
 *     workspace?: Record<string, unknown>|null,
 *     signal: AbortSignal,
 *     runContext?: RunContext|null,
 *     reportProgress?: () => void,
 *     threadId?: string|null
 *   }) => Promise<RunnerResult>
 * }}
 */
export function createEngineRunner(options = {}) {
    const unknown = Object.keys(options).filter((key) => !Object.hasOwn(RUNNER_OPTIONS, key));
    if (unknown.length > 0) {
        throw configurationError({ option: 'unknown_option', message: `createEngineRunner does not accept: ${unknown.join(', ')}.` });
    }
    const {
        engine,
        client = null,
        model = null,
        store = null,
        tools = [],
        budget = null,
        approval = null,
        prompt = null,
        objective = null,
        planFor = null,
        graphFor = null,
        agents = null,
        contract = null,
        resume = true,
        resumePrompt = 'Continue the task from where you left off. Do not repeat completed work.',
        threadId = null,
        onEvent = null
    } = options;
    if (typeof engine !== 'string' || !SUPPORTED_ENGINES.has(engine)) {
        throw configurationError({ option: 'unsupported_engine', message: `createEngineRunner: unsupported engine '${String(engine)}'.` });
    }
    if (client === null || typeof client !== 'object' || typeof (/** @type {Record<string, unknown>} */ (client)).session !== 'function') {
        throw configurationError({ option: 'missing_client', message: 'createEngineRunner: client.session(model) is required.' });
    }
    if (typeof model !== 'string' || model.length === 0) {
        throw configurationError({ option: 'missing_model', message: 'createEngineRunner: a non-empty model is required.' });
    }
    if (engine === 'agentic' && typeof prompt !== 'string' && typeof prompt !== 'function') {
        throw configurationError({ option: 'missing_prompt', message: 'createEngineRunner: agentic needs a prompt string or function.' });
    }
    if (engine === 'dag' && typeof planFor !== 'function') {
        throw configurationError({ option: 'missing_plan', message: 'createEngineRunner: dag needs planFor({ item, attempt, signal }).' });
    }
    if (engine === 'stateMachine' && typeof graphFor !== 'function') {
        throw configurationError({ option: 'missing_graph', message: 'createEngineRunner: stateMachine needs graphFor({ item, attempt }).' });
    }
    if (engine === 'discussion' && !Array.isArray(agents) && typeof agents !== 'function') {
        throw configurationError({ option: 'missing_agents', message: 'createEngineRunner: discussion needs an agents array or function.' });
    }
    if (contract !== null && engine !== 'stateMachine') {
        // W2C-9: only the state machine runs a completion contract; silently
        // ignoring it would report a gate that never ran.
        throw configurationError({
            option: 'contract',
            message: `createEngineRunner: contract is only supported by the stateMachine engine, not '${engine}'.`
        });
    }
    if (store !== null) {
        const candidate = /** @type {Record<string, unknown>} */ (store);
        if (typeof candidate.load !== 'function' || typeof candidate.save !== 'function') {
            throw configurationError({ option: 'invalid_store', message: 'createEngineRunner: store needs load(threadId) and save({ threadId, data }).' });
        }
    }
    if (engine === 'discussion' && resume && store !== null) {
        throw configurationError({ option: 'discussion_no_resume', message: 'createEngineRunner: discussion has no checkpoint and cannot resume.' });
    }
    if (threadId !== null && typeof threadId !== 'string' && typeof threadId !== 'function') {
        throw configurationError({ option: 'invalid_thread_id', message: 'createEngineRunner: threadId must be a string or ({ item, attempt }) => string.' });
    }
    if (typeof threadId === 'string' && threadId.trim() === '') {
        throw configurationError({ option: 'invalid_thread_id', message: 'createEngineRunner: threadId must be non-empty.' });
    }
    const approvalPolicy = normalizeApproval({ value: approval });
    const runnerClient = /** @type {RunnerClient} */ (client);
    const runnerModel = /** @type {string} */ (model);
    const runnerStore = /** @type {RunnerStore|null} */ (store);
    const runnerBudget = engineBudget({ budget });

    /** @type {Map<string, string>} */
    const threadOwners = new Map();
    /**
     * The run's thread id: the scheduler's attempt identity wins, then the
     * caller's configured string or resolver, then the scheduler's own rule.
     * @param {{item: WorkItem, attempt: number|null, runThreadId: unknown}} arg0 -
     * @returns {string}
     */
    const resolveThreadId = ({ item, attempt, runThreadId }) => {
        /** @type {unknown} */
        let resolved;
        if (runThreadId !== undefined && runThreadId !== null) resolved = runThreadId;
        else if (typeof threadId === 'function') resolved = threadId({ item, attempt });
        else if (typeof threadId === 'string') resolved = threadId;
        else resolved = workThreadId({ identifier: item.identifier });
        if (typeof resolved !== 'string' || resolved.trim() === '') {
            throw configurationError({ option: 'invalid_thread_id', message: 'createEngineRunner: the resolved threadId must be a non-empty string.' });
        }
        const owner = threadOwners.get(resolved);
        if (owner !== undefined && owner !== item.identifier) {
            throw configurationError({
                option: 'thread_collision',
                message: `createEngineRunner: thread '${resolved}' already belongs to '${owner}', not '${item.identifier}'.`
            });
        }
        threadOwners.set(resolved, item.identifier);
        return resolved;
    };

    /**
     * @param {{
     *   item: WorkItem,
     *   attempt?: number|null,
     *   continuation?: boolean,
     *   workspace?: Record<string, unknown>|null,
     *   signal: AbortSignal,
     *   runContext?: RunContext|null,
     *   reportProgress?: () => void,
     *   threadId?: string|null
     * }} arg0 -
     * @returns {Promise<RunnerResult>}
     */
    async function run({
        item,
        attempt = null,
        continuation = false,
        workspace = null,
        signal,
        runContext = null,
        reportProgress = () => {},
        threadId: runThreadId = null
    }) {
        /** @type {{usage: Record<string, number|null>|null}} */
        const measured = { usage: null };
        const resolvedThreadId = resolveThreadId({ item, attempt, runThreadId });
        if (engine === 'agentic') {
            try {
                // The agentic engine owns its session pool, so it gets the raw client
                // and no attempt ledger.
                return await runAgentic({
                    client: runnerClient,
                    model: runnerModel,
                    store: runnerStore,
                    tools: await resolveTools({ value: tools, item, attempt, workspace }),
                    budget: runnerBudget,
                    approval: approvalPolicy,
                    prompt,
                    resume,
                    resumePrompt,
                    onEvent,
                    item,
                    attempt,
                    continuation,
                    signal,
                    runContext,
                    reportProgress,
                    measured,
                    threadId: resolvedThreadId
                });
            } catch (error) {
                if (isAbortError({ err: error, signal })) {
                    return { status: 'canceled', progress: true, usage: measured.usage };
                }
                return { status: 'failed', progress: true, usage: measured.usage, error };
            }
        }
        // One cap-less ledger per run(): every session the engine creates reports to
        // it, including the ones a host hook makes before planFor/graphFor returns.
        const pool = hasPositiveCap({ budget: runnerBudget }) ? createBudgetPool() : null;
        const engineClient = pool === null ? runnerClient : /** @type {RunnerClient} */ (pooledClient({ client: runnerClient, pool }));
        const poolBefore = pool === null ? null : poolSnapshot({ pool });
        /** @type {RunnerResult|null} */
        let result = null;
        /** @type {{error: unknown}|null} */
        let thrown = null;
        try {
            const bag = { item, attempt, workspace, client: engineClient, budgetPool: attemptPoolView({ pool }), runContext };
            const resolvedTools = await resolveTools({ value: tools, ...bag });
            if (engine === 'dag') {
                result = await runDag({
                    client: engineClient,
                    model: runnerModel,
                    store: runnerStore,
                    tools: resolvedTools,
                    budget: runnerBudget,
                    approval: approvalPolicy,
                    objective,
                    planFor: /** @type {Function} */ (planFor),
                    pool,
                    resume,
                    item,
                    attempt,
                    signal,
                    runContext,
                    onEvent,
                    reportProgress,
                    threadId: resolvedThreadId
                });
            } else if (engine === 'stateMachine') {
                result = await runStateMachine({
                    client: engineClient,
                    model: runnerModel,
                    store: runnerStore,
                    tools: resolvedTools,
                    budget: runnerBudget,
                    approval: approvalPolicy,
                    graphFor: /** @type {Function} */ (graphFor),
                    contract: /** @type {object|null} */ (contract),
                    pool,
                    resume,
                    item,
                    attempt,
                    signal,
                    runContext,
                    onEvent,
                    reportProgress,
                    threadId: resolvedThreadId
                });
            } else {
                result = await runDiscussion({
                    client: engineClient,
                    budget: runnerBudget,
                    approval: approvalPolicy,
                    objective,
                    agents,
                    pool,
                    item,
                    attempt,
                    workspace,
                    signal,
                    runContext,
                    reportProgress
                });
            }
        } catch (error) {
            thrown = { error };
        } finally {
            if (pool !== null) {
                // A failed or canceled attempt still spent tree tokens; the delta is
                // the only honest report for it. The release runs after the delta.
                measured.usage = attemptUsage({ before: poolBefore, after: poolSnapshot({ pool }) });
                releaseAttemptLedger({ pool });
            }
        }
        if (thrown === null && result !== null) {
            if (pool !== null) result.usage = measured.usage;
            return result;
        }
        if (isAbortError({ err: thrown?.error, signal })) {
            return { status: 'canceled', progress: true, usage: measured.usage };
        }
        return { status: 'failed', progress: true, usage: measured.usage, error: thrown?.error };
    }

    return { run };
}
