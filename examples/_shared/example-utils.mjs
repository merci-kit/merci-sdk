// @ts-check
/**
 * Shared example plumbing — the single source of truth for every example's
 * bootstrap + observability helpers.
 *
 * Before this file, each example carried its own copy of the same helpers
 * (wireClient/wireObserver had SIX divergent copies, wireEvents had SEVEN
 * with real payload drift, trackUsage had a total_tokens=0 bug, and the
 * readline prompts crashed in non-interactive runs). One import fixes all of
 * them in one place:
 *
 *   const { provider, defaultModel, toolModel } = resolveExample();
 *   const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
 *   wireClient(client);
 *
 * resolveExample() resolves the backend from secret.env, picks both models and
 * configures the logger; initializeClient/wireClient then build the client and
 * wire observability. Examples that deliberately diverge (server children
 * logging to stderr, custom event subsets) use the smaller pieces below.
 *
 * @version 0.12.0
 */

/**
 * Shared example plumbing — the single source of truth for every example's
 * bootstrap + observability helpers.
 *
 * Before this file, each example carried its own copy of the same helpers
 * (wireClient/wireObserver had SIX divergent copies, wireEvents had SEVEN
 * with real payload drift, trackUsage had a total_tokens=0 bug, and the
 * readline prompts crashed in non-interactive runs). One import fixes all of
 * them in one place:
 *
 *   const { provider, defaultModel, toolModel } = resolveExample();
 *   const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
 *   wireClient(client);
 *
 * resolveExample() resolves the backend from secret.env, picks both models and
 * configures the logger; initializeClient/wireClient then build the client and
 * wire observability. Examples that deliberately diverge (server children
 * logging to stderr, custom event subsets) use the smaller pieces below.
 *
 * @version 0.12.0
 */

/**
 * Shared example plumbing — the single source of truth for every example's
 * bootstrap + observability helpers.
 *
 * Before this file, each example carried its own copy of the same helpers
 * (wireClient/wireObserver had SIX divergent copies, wireEvents had SEVEN
 * with real payload drift, trackUsage had a total_tokens=0 bug, and the
 * readline prompts crashed in non-interactive runs). One import fixes all of
 * them in one place:
 *
 *   const { provider, defaultModel, toolModel } = resolveExample();
 *   const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
 *   wireClient(client);
 *
 * resolveExample() resolves the backend from secret.env, picks both models and
 * configures the logger; initializeClient/wireClient then build the client and
 * wire observability. Examples that deliberately diverge (server children
 * logging to stderr, custom event subsets) use the smaller pieces below.
 *
 * @version 0.12.0
 */

/**
 * Shared example plumbing — the single source of truth for every example's
 * bootstrap + observability helpers.
 *
 * Before this file, each example carried its own copy of the same helpers
 * (wireClient/wireObserver had SIX divergent copies, wireEvents had SEVEN
 * with real payload drift, trackUsage had a total_tokens=0 bug, and the
 * readline prompts crashed in non-interactive runs). One import fixes all of
 * them in one place:
 *
 *   const { provider, defaultModel, toolModel } = resolveExample();
 *   const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
 *   wireClient(client);
 *
 * resolveExample() resolves the backend from secret.env, picks both models and
 * configures the logger; initializeClient/wireClient then build the client and
 * wire observability. Examples that deliberately diverge (server children
 * logging to stderr, custom event subsets) use the smaller pieces below.
 *
 * @version 0.12.0
 */


/**
 * Shared example plumbing — the single source of truth for every example's
 * bootstrap + observability helpers.
 *
 * Before this file, each example carried its own copy of the same helpers
 * (wireClient/wireObserver had SIX divergent copies, wireEvents had SEVEN
 * with real payload drift, trackUsage had a total_tokens=0 bug, and the
 * readline prompts crashed in non-interactive runs). One import fixes all of
 * them in one place:
 *
 *   const { provider, defaultModel, toolModel } = resolveExample();
 *   const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
 *   wireClient(client);
 *
 * resolveExample() resolves the backend from secret.env, picks both models and
 * configures the logger; initializeClient/wireClient then build the client and
 * wire observability. Examples that deliberately diverge (server children
 * logging to stderr, custom event subsets) use the smaller pieces below.
 *
 * @version 0.12.0
 */
import { spawn } from 'node:child_process';
import { ProviderType, resolveProvider, getDefaultModel, getToolModel, createLlmJudge, log, configureSdkLog, attachEventLogger } from '../../lib/index.mjs';
import { sortDagNodes } from '../../lib/agentic/planning/index.mjs';
import { BASE_EXIT_KEYWORDS } from '../../lib/core/constants/index.mjs';
import { createRunLog, exampleIdFromArgv } from './example-audit.mjs';
/**
 * Running token/credit counters accumulated by trackUsage and consumed by
 * reportUsage/deltaUsage.
 * @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number, credits?: object|null }} Usage
 */


/**
 * Minimal event-emitter shape shared by SDK clients/executors/sessions.
 * @typedef {Record<string, any>} Emitter
 * @property {(event: string, listener: (event: any) => void) => any} on
 */

/**
 * A WorkflowExecutor: an Emitter that can also resolve HITL approvals.
 * @typedef {Record<string, any>} WorkflowExecutor
 * @property {(event: string, listener: (event: any) => void) => any} on
 * @property {(approvalId: any, approved: boolean) => any} resolveApproval
 */

/**
 * A client with a callable `session` factory (monkey-patched by trackUsage).
 * @typedef {Record<string, any>} SessionClient
 * @property {(model?: any) => any} session
 */

/**
 * The readline/promises interface surface used by readlineSafe.
 * @typedef {Record<string, any>} ReadlineLike
 * @property {boolean} closed
 * @property {(event: string, listener: Function) => any} once
 * @property {(event: string, listener: Function) => any} removeListener
 * @property {(prompt: string) => Promise<string>} question
 */








// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------


/**
 * Parses the shared logging CLI flags into `configureSdkLog` options. Unknown
 * flags are ignored, so examples keep their own argv. Recognizes:
 *   `-v`/`--verbose`/`--debug` → debug · `--trace` → trace · `-q`/`--quiet` →
 *   warn · `--silent` · `--json` (NDJSON) · `--pretty` · `--no-color` ·
 *   `--log-level=<l>` · `--log-format=<f>`. `LOG_LEVEL`/`LOG_FORMAT`/`NO_COLOR`
 *   are honored by the logger itself.
 * @param {{argv?: string[]}} [arg0]
 * @returns {{level: string|null, format: string|null, colors: boolean|null, extended: boolean}}
 */
export function parseLogArgs({ argv = process.argv.slice(2) } = {}) {
    let level = null;
    let format = null;
    let colors = null;
    for (const a of argv) {
        if (a === '-v' || a === '--verbose' || a === '--debug') level = 'debug';
        else if (a === '--trace') level = 'trace';
        else if (a === '-q' || a === '--quiet') level = 'warn';
        else if (a === '--silent') level = 'silent';
        else if (a === '--json') format = 'json';
        else if (a === '--pretty') format = 'pretty';
        else if (a === '--no-color') colors = false;
        else if (a.startsWith('--log-level=')) level = a.slice('--log-level='.length);
        else if (a.startsWith('--log-format=')) format = a.slice('--log-format='.length);
    }
    return { level, format, colors, extended: level === 'debug' || level === 'trace' };
}


/**
 * Resolves the backend + both models from secret.env and configures logging.
 * The tier rule (best_practices.md §2): the DEFAULT model is the "brain"
 * (planner/judge/orchestrator), the TOOL model is the cheap leaf. Examples
 * pick per role; both are always available.
 * Logging also honors the shared CLI flags (`-v`/`--trace`/`--json`/`--no-color`
 * /`--log-level=`), so any example can be run with maximal verbosity.
 * @param {{ extended?: boolean, argv?: string[] }} [options] - extended logger output (default false).
 * @returns {{ provider: string, defaultModel: string, toolModel: string }}
 */
export function resolveExample({ extended = false, argv = process.argv.slice(2) } = {}) {
    const provider = resolveProvider();
    const defaultModel = getDefaultModel({ provider });
    const toolModel = getToolModel({ provider }) || defaultModel;
    const flags = parseLogArgs({ argv });
    configureSdkLog({
        extended: extended || flags.extended,
        ...(flags.level !== null ? { level: flags.level } : {}),
        ...(flags.format !== null ? { format: flags.format } : {}),
        ...(flags.colors !== null ? { colors: flags.colors } : {}),
    });
    return { provider, defaultModel, toolModel };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/** Events `wireClient` renders as framed `log.wire` briefs (the catch-all skips them). */
const WIRE_HANDLED = new Set(['api_request', 'api_response', 'api_retry']);


/**
 * Wires client observability: the three vendor-call events as `log.wire`
 * briefs (bodies only at `--trace`, always redacted), the raw `error`, and a
 * registry-driven catch-all (`attachEventLogger`) that logs every other
 * canonical event — `run:*`, `session:*`, `tool:*`, `phase:*`, `api_error`, … —
 * so a new event is visible the day it is registered. The catch-all is
 * level-gated (`info`), so `-q` silences it.
 * @param {{client: Record<string, any>}} arg0 - the initialized SDK client.
 * @returns {void}
 */
export function wireClient({ client }) {
    const emitter =  (client);
    emitter.on('api_request', /** @type {(...args: any[]) => any} */ ((m) => log.wire({ kind: 'request', meta: m })));
    emitter.on('api_response', /** @type {(...args: any[]) => any} */ ((m) => log.wire({ kind: 'response', meta: m })));
    emitter.on('api_retry', /** @type {(...args: any[]) => any} */ ((m) => log.wire({ kind: 'retry', meta: m })));
    emitter.on('error', /** @type {(...args: any[]) => any} */ ((err) => log.error({ m: 'SDK error', d: err?.message ?? err })));
    attachEventLogger({ emitter, level: 'info', filter: ({ name }) => !WIRE_HANDLED.has(name) });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * token total; total_tokens is the SUM of prompt+completion (the old copy
 * never updated it and printed 0). Backends that report quota credits
 * instead of tokens (JAI) fold the LAST {updated, spent} payload into
 * `credits` so reportUsage can display what the backend actually reports.
 * @param {{client: Record<string, any>}} arg0 - the initialized SDK client (session is monkey-patched).
 * @returns {{ prompt_tokens: number, completion_tokens: number, total_tokens: number, credits: Record<string, any>|null }} the accumulated totals.
 */
export function trackUsage({ client }) {
    const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, credits: null };
    const c =  (client);
    const origSession = c.session.bind(c);
    c.session = /** @type {(...args: any[]) => any} */ ((model) => {
        const session = origSession(model);
        const origStep = session.step.bind(session);
        
        /**
         * @returns {AsyncGenerator<any, any, any>}
         * /
          * @param {{messages: *, options?: *}} arg0
         */
                async function* stepGen({ messages, options = {} }) {
            const gen = origStep({ messages, options });
            let result = await gen.next();
            while (!result.done) {
                const ev = result.value;
                if (ev?.type === 'quota' && ev.data) {
                    const p = ev.data.prompt_tokens ?? 0;
                    const c = ev.data.completion_tokens ?? 0;
                    total.prompt_tokens = Math.max(total.prompt_tokens, p);
                    total.completion_tokens = Math.max(total.completion_tokens, c);
                    total.total_tokens = total.prompt_tokens + total.completion_tokens;
                    if (ev.data.updated || ev.data.spent) total.credits = ev.data;
                }
                const fwd = yield ev;
                result = await gen.next(fwd);
            }
            return result.value;
        }
        session.step = stepGen;
        return session;
    });
    return total;
}


/** @param {{u: *, base: *}} arg0 */
export function deltaUsage({ u, base }) {
    return {
        prompt_tokens: u.prompt_tokens - base.prompt_tokens,
        completion_tokens: u.completion_tokens - base.completion_tokens,
        total_tokens: u.total_tokens - base.total_tokens,
    };
}


/**
 * → print the [CREDITS] snapshot; every other backend prints [TOKENS] totals.
 * @param {{provider: string, usage: Record<string, any>, base?: *}} arg0 - ProviderType value of the active backend.
 * @returns {void}
 */
export function reportUsage({ provider, usage, base = null }) {
    const u =  (usage);
    if (provider === ProviderType.JAI) {
        if (u?.credits) log.credits({ u: u.credits });
        else log.event({ type: 'usage', payload: 'no credits reported by backend' });
        return;
    }
    if (!usage) return;
    const d = base ? deltaUsage({ u, base }) : u;
    if (d.total_tokens > 0) log.usage({ u: d });
}


/**
 * Non-fatal guard for a live agentic run: the model finished but returned no
 * final text (it ended on tool I/O). Makes the swallowed answer visible in the
 * log without turning a demonstration into a failed check.
 * @param {{answer: *, label?: string}} arg0 - the value `session.run()` returned.
 * @returns {void}
 */
export function warnEmptyAnswer({ answer, label = 'run' }) {
    if (!String(answer ?? '').trim()) log.warn({ m: `${label} produced no final answer — the model ended on tool I/O.` });
}

// ---------------------------------------------------------------------------
// DAG plan rendering
// ---------------------------------------------------------------------------


/**
 * @param {{steps: *, label?: string}} arg0 - plan label (default 'DAG').
 * @returns {void}
 */
export function showPlan({ steps, label = 'DAG' }) {
    log.section({ t: `${label} plan` });
    log.list({ title: 'steps', items: steps.map(/** @type {(...args: any[]) => any} */ (s => {
        const deps = s.dependencies ?? [];
        const depStr = deps.length
            ? `${log.gray({ t: 'deps' })} ${log.yellow({ t: deps.join(', ') })}`
            : log.gray({ t: 'no dependencies' });
        return `${log.cyan({ t: s.id })} (${s.title ?? s.description ?? s.id}) — ${depStr}`;
    })) });
    const order = sortDagNodes({ steps });
    log.info({ m: `${label} run order: ${log.bold({ t: order.join(' → ') })}` });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * - `axis`: label prefix for hierarchical examples ("X", "Y").
 * - `hitl`: a readline instance (prompts with a closed-stdin guard) OR an
 *   async fn(stepId) → boolean decision. Without it, HITL gates are logged
 *   but not answered (callers that auto-approve pass a fn).
 * - `onIterationLimit`: async fn(approvalId) → boolean for the
 *   workflow:hitl_iteration_limit gate (sub-DAGs auto-approve so they never
 *   degrade; leaf runs auto-decline). Defaults to auto-approve so a
 *   tool-budget-exhausted step never idles into a 120s auto-decline.
 * - `onStepComplete/onStepError`: extra per-step hooks (e.g. todo diffing).
 * @param {{executor: Record<string, any>, axis?: *, hitl?: *, onIterationLimit?: *, onStepComplete?: *, onStepError?: *}} arg0 - the WorkflowExecutor instance.
 * @returns {Record<string, any>} the executor, for chaining.
 */
export function wireWorkflowEvents({ executor, axis = null, hitl = null, onIterationLimit = null, onStepComplete = null, onStepError = null }) {
    const ex =  (executor);
    const tag = axis ? `${axis}-` : '';
    const label = /** @type {(...args: any[]) => any} */ (( id) => `"${tag}${id}"`);
    let streamOpen = false;

    ex.on('workflow:start', /** @type {(...args: any[]) => any} */ (({ totalSteps }) => log.event({ type: `workflow:start${axis ? ` (${axis})` : ''}`, payload: { totalSteps } })));
    ex.on('workflow:step_start', /** @type {(...args: any[]) => any} */ ((e) => log.info({ m: `\n▶ ${tag}Step: "${e.stepId}"` })));
    ex.on('workflow:step_text', /** @type {(...args: any[]) => any} */ ((e) => {
        if (!streamOpen && e.content) { log.assistant({ m: '', isStreaming: true }); streamOpen = true; }
        process.stdout.write(e.content ?? '');
    }));
    ex.on('workflow:step_stream_end', () => { if (streamOpen) { process.stdout.write('\n'); streamOpen = false; } });
    ex.on('workflow:step_thought', /** @type {(...args: any[]) => any} */ (({ stepId, content }) => log.thinking({ t: `  [${tag}${stepId}] ${content}` })));
    ex.on('workflow:step_iteration', /** @type {(...args: any[]) => any} */ (({ stepId, iteration, label: itLabel }) => log.event({ type: `workflow:step_iteration${axis ? ` (${axis})` : ''}`, payload: { stepId, iteration }, detail: itLabel })));
    ex.on('workflow:step_verify_start', /** @type {(...args: any[]) => any} */ (({ stepId }) => log.phase({ t: `verify [${stepId}]${axis ? ` (${axis})` : ''}`, sub: '' })));
    ex.on('workflow:step_verify_pass', /** @type {(...args: any[]) => any} */ (({ stepId, evidence }) => log.check({ name: `verify [${stepId}]${axis ? ` (${axis})` : ''}`, passed: true, detail: evidence || 'no evidence' })));
    ex.on('workflow:step_verify_fail', /** @type {(...args: any[]) => any} */ (({ stepId, attempt, evidence, classification, retries }) =>
        log.warn({ m: `↻ ${tag}Step ${label(stepId)} verification failed${classification ? ` — ${classification}` : ''} (attempt ${attempt + 1}${retries != null ? `/${retries}` : ''}) — retrying: ${evidence || 'no evidence'}` })));
    ex.on('workflow:step_verify_retry', /** @type {(...args: any[]) => any} */ (({ stepId, attempt, retries, evidence, classification }) =>
        log.warn({ m: `↻ ${tag}Step ${label(stepId)} verify retry ${attempt}/${retries ?? '?'}${classification ? ` — ${classification}` : ''}: ${evidence || 'no evidence'}` })));
    ex.on('workflow:step_complete', /** @type {(...args: any[]) => any} */ (({ stepId }) => {
        log.success({ m: `✓ ${tag}Step ${label(stepId)}` });
        if (onStepComplete) onStepComplete(stepId);
    }));
    ex.on('workflow:step_error', /** @type {(...args: any[]) => any} */ (({ stepId, error }) => {
        log.error({ m: `✗ ${tag}Step ${label(stepId)}`, d: error });
        if (onStepError) onStepError(stepId);
    }));
    ex.on('workflow:replan_triggered', /** @type {(...args: any[]) => any} */ (({ failedStepId, reason }) => log.warn({ m: `⟳ Replan: ${label(failedStepId)} — ${reason}` })));
    ex.on('workflow:failed', /** @type {(...args: any[]) => any} */ (({ failedSteps, reason }) => log.error({ m: `workflow failed — steps [${failedSteps.join(', ')}]: ${reason}` })));
    ex.on('workflow:template_warning', /** @type {(...args: any[]) => any} */ (({ stepId, message }) => log.warn({ m: `Template warning in ${tag}step ${label(stepId)}: ${message}` })));
    ex.on('workflow:hitl_timeout', /** @type {(...args: any[]) => any} */ (({ stepId }) => log.warn({ m: `HITL gate for ${tag}step ${label(stepId)} timed out — auto-declined.` })));
    ex.on('workflow:hitl_iteration_limit', /** @type {(...args: any[]) => any} */ (async ({ stepId, approvalId }) => {
        if (!onIterationLimit) {
            log.warn({ m: `HITL gate for ${tag}step ${label(stepId)} hit its iteration limit — auto-approving extension.` });
            ex.resolveApproval({ approvalId, approved: true });
            return;
        }
        ex.resolveApproval({ approvalId, approved: await onIterationLimit(approvalId, stepId) });
    }));

    if (hitl) {
        ex.on('workflow:hitl_pending', /** @type {(...args: any[]) => any} */ (async ({ stepId, approvalId }) => {
            const approved = typeof hitl === 'function'
                ? await hitl(stepId)
                : (await readlineSafe({ rl: hitl, prompt: `Approve ${tag}step ${label(stepId)}? [Y/n]: `, fallback: 'y' })).trim().toLowerCase() !== 'n';
            ex.resolveApproval({ approvalId, approved });
        }));
    }
    return executor;
}

// ---------------------------------------------------------------------------
// DiscussionSession event wiring (shared vocabulary)
// ---------------------------------------------------------------------------


/**
 * @param {{group: Record<string, any>}} arg0 - a DiscussionSession instance.
 * @returns {Record<string, any>} the group, for chaining.
 */
export function wireDiscussionEvents({ group }) {
    const g =  (group);
    let agentOpen = false;
    g.on('discussion:turn_start', /** @type {(...args: any[]) => any} */ (({ turn, total }) => log.info({ m: `\n--- Turn ${turn}/${total} ---` })));
    g.on('discussion:turn_end', /** @type {(...args: any[]) => any} */ (({ turn, ledgerCount }) => log.info({ m: `--- Turn ${turn} complete (${ledgerCount ?? '?'} ledger entries) ---` })));
    g.on('discussion:agent_start', /** @type {(...args: any[]) => any} */ (({ agent, type }) => log.info({ m: `  ${agent} (${type}):` })));
    g.on('discussion:agent_thought', /** @type {(...args: any[]) => any} */ (({ content }) => process.stdout.write(`\x1b[90m${content}\x1b[0m`)));
    g.on('discussion:agent_text', /** @type {(...args: any[]) => any} */ (({ content }) => {
        if (!agentOpen && content) { log.assistant({ m: '', isStreaming: true }); agentOpen = true; }
        process.stdout.write(content ?? '');
    }));
    g.on('discussion:agent_finish', /** @type {(...args: any[]) => any} */ (({ agent, type, content }) => {
        if (agentOpen) { process.stdout.write('\n'); agentOpen = false; }
        if (content) log.info({ m: `  ← ${String(content).replace(/\n/g, ' ')}` });
        log.info({ m: `  done: ${agent} (${type})` });
    }));
    g.on('discussion:agent_pass', /** @type {(...args: any[]) => any} */ (({ agent, type }) => log.condition({ label: 'agent passed', branch: agent, why: `type=${type} — deferred, no new content` })));
    g.on('discussion:agent_error', /** @type {(...args: any[]) => any} */ (({ agent, error }) => log.error({ m: `  ✗ ${agent}`, d: error })));
    g.on('task:hedge', /** @type {(...args: any[]) => any} */ (({ subagent_type, hedgeAfterMs }) => log.info({ m: `  ⏱ task ${subagent_type} hedged after ${hedgeAfterMs}ms` })));
    g.on('task:fallback', /** @type {(...args: any[]) => any} */ (({ subagent_type, fallbackModel, reason, error }) => log.warn({ m: `  ↻ task ${subagent_type} → fallback ${fallbackModel} (${reason}: ${log.truncate({ text: String(error ?? ''), n: 120 })})` })));
    g.on('discussion:tool_call_start', /** @type {(...args: any[]) => any} */ (({ agent, name, args }) => log.toolCall({ n: `${agent} → ${name}`, a: args })));
    g.on('discussion:tool_call_end', /** @type {(...args: any[]) => any} */ (({ agent, name, result }) => log.toolResult({ n: `${agent} ← ${name}`, r: result })));
    g.on('discussion:dag_order', /** @type {(...args: any[]) => any} */ (({ order, taskCount, agent }) => log.info({ m: `DAG order (${agent ?? 'swarm'}): ${order.join(' → ')} (${taskCount} tasks)` })));
    g.on('discussion:terminated', /** @type {(...args: any[]) => any} */ (({ reason, turn }) => log.condition({ label: 'discussion terminated', branch: reason, why: `after ${turn} turn(s)` })));
    g.on('discussion:judged', /** @type {(...args: any[]) => any} */ (({ passed, score, revision, round, reason }) => {
        log.check({ name: 'judge', passed, detail: `score=${score ?? 'n/a'} revision=${revision ?? '?'} round=${round ?? '?'}` });
        if (reason) log.info({ m: `  reason: ${reason}` });
    }));
    g.on('discussion:replan', /** @type {(...args: any[]) => any} */ (({ mode, round }) => log.condition({ label: 'replan', branch: mode, why: round != null ? `round=${round}` : '' })));
    return group;
}

// ---------------------------------------------------------------------------
// StateMachine node-stream wiring (shared vocabulary)
// ---------------------------------------------------------------------------


/**
 * @param {{sm: Record<string, any>, echoNode?: *}} arg0 - a StateMachine instance.
 * @returns {Record<string, any>} the state machine, for chaining.
 */
export function wireStateMachineEvents({ sm, echoNode = null }) {
    const s =  (sm);
    let streamOpen = false;
    s.on('state_machine:node_start', /** @type {(...args: any[]) => any} */ (({ nodeId, visitCount }) => {
        log.info({ m: `  ▶ ${nodeId}${visitCount != null ? ` (visit ${visitCount})` : ''}` });
        if (echoNode) echoNode(nodeId);
    }));
    s.on('state_machine:node_thought', /** @type {(...args: any[]) => any} */ (({ content }) => log.thinking({ t: content })));
    s.on('state_machine:node_text', /** @type {(...args: any[]) => any} */ (({ content }) => {
        if (!streamOpen && content) { log.assistant({ m: '', isStreaming: true }); streamOpen = true; }
        process.stdout.write(content ?? '');
    }));
    s.on('state_machine:node_stream_end', () => { if (streamOpen) { process.stdout.write('\n'); streamOpen = false; } });
    s.on('state_machine:node_end', /** @type {(...args: any[]) => any} */ (({ nodeId, from, to, terminal }) => log.success({ m: `  ✓ ${nodeId}${from ? ` (from ${from})` : ''}${to ? ` → ${to}` : ' → —'}${terminal ? ' [done]' : ''}` })));
    // ponytail: every verify event carries the gated node's id (machine.mjs
    s.on('state_machine:verify_start', /** @type {(...args: any[]) => any} */ ((e) => log.phase({ t: `verify [${e.nodeId ?? '?'}]`, sub: '' })));
    s.on('state_machine:verify_pass', /** @type {(...args: any[]) => any} */ ((e) => log.check({ name: `verify [${e.nodeId ?? '?'}]`, passed: true, detail: e.evidence })));
    s.on('state_machine:verify_fail', /** @type {(...args: any[]) => any} */ ((e) => log.warn({ m: `  verify_fail [${e.nodeId ?? '?'}] (${e.classification ?? '?'}): ${e.evidence}` })));
    s.on('state_machine:verify_retry', /** @type {(...args: any[]) => any} */ ((e) => log.warn({ m: `  retry ${e.attempt} [${e.nodeId ?? '?'}]: ${e.evidence}` })));
    s.on('state_machine:no_progress', /** @type {(...args: any[]) => any} */ ((e) => log.error({ m: `  no_progress: ${e.fingerprint}` })));
    s.on('state_machine:escalated', /** @type {(...args: any[]) => any} */ ((e) => log.error({ m: `  escalated — "${e.nodeId}": ${e.reason}${e.evidence ? ` (${e.evidence})` : ''}` })));
    s.on('state_machine:cycle_limit', /** @type {(...args: any[]) => any} */ ((e) => log.warn({ m: `  cycle_limit — "${e.nodeId}" (maxVisits=${e.maxVisits})` })));
    s.on('state_machine:completed', /** @type {(...args: any[]) => any} */ ((e) => log.info({ m: `  completion gate: verified=${e.verified} checks=[${(e.checks ?? []).map(/** @type {(...args: any[]) => any} */ (( c) => `${c.name}:${c.passed}`)).join(', ')}]` })));
    s.on('state_machine:failed', /** @type {(...args: any[]) => any} */ ((e) => log.error({ m: `  completion gate failed: ${e.reason}` })));
    s.on('state_machine:start', /** @type {(...args: any[]) => any} */ (({ entry, nodeCount, maxSteps }) => log.info({ m: `  state_machine:start — entry="${entry}", ${nodeCount} node(s), maxSteps=${maxSteps}` })));
    s.on('state_machine:done', /** @type {(...args: any[]) => any} */ (({ stepsTaken }) => log.info({ m: `  state_machine:done — ${stepsTaken} step(s)` })));
    s.on('state_machine:error', /** @type {(...args: any[]) => any} */ (({ message }) => log.error({ m: `  state_machine:error — ${message}` })));
    s.on('state_machine:replan_required', /** @type {(...args: any[]) => any} */ (({ failedNodeId, reason }) => log.warn({ m: `  replan_required: failed "${failedNodeId}" — ${reason}` })));
    return sm;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Gate a node/step artifact with the SDK's LLM judge: a cheap non-empty
 * invariant first (no API call), then `createLlmJudge` over the supplied
 * state. The judge — not a keyword checklist — decides the semantics against
 * the criteria; its evidence is exactly the `{ passed, evidence }` shape
 * `verify` expects, so the engines feed it back into the next attempt.
 * @param {{client: any, model: string, criteria: *, state: Record<string, any>, signal?: AbortSignal|null}} arg0
 * @returns {Promise<{ passed: boolean, evidence: string }>}
 */
export async function judgeArtifact({ client, model, criteria, state, signal = null }) {
    const artifact = String(state?.artifact ?? '').trim();
    if (!artifact) return { passed: false, evidence: 'empty output' };
    return createLlmJudge({ client, model, criteria })({ ctx: { getAll: () => ({ ...state, artifact }) }, signal });
}

// ---------------------------------------------------------------------------
// task-tool (subagent) event wiring (shared vocabulary)
// ---------------------------------------------------------------------------


/**
 * @param {{client: Record<string, any>, background?: *}} arg0 - the initialized SDK client.
 * @returns {Record<string, any>} the client, for chaining.
 */
export function wireTaskEvents({ client, background = null }) {
    const c =  (client);
    c.on('task:start', /** @type {(...args: any[]) => any} */ (({ subagent_type, description, background: isBg }) => {
        const label = String(description ?? '').trim() || '(no description)';
        const tag = isBg ? `${label} [background]` : label;
        log.toolCall({ n: `task → ${subagent_type}`, a: tag });
        if (isBg && background) background.started =  (background.started) + 1;
    }));
    c.on('task:finish', /** @type {(...args: any[]) => any} */ (({ subagent_type, description, result, id }) => {
        /** @type {string[]} */
                if (id && background)  (background.done).push(id);
        // ponytail: unconditional for background events; one blank line when it
        if (id) process.stdout.write('\n');
        const full = String(result ?? '');
        log.toolResult({ n: `task ← ${subagent_type}`, r: `${id ? `[${id}] ` : ''}${full}` });
    }));
    c.on('task:error', /** @type {(...args: any[]) => any} */ (({ subagent_type, error, id }) => {
        if (id) process.stdout.write('\n');
        log.error({ m: `task ✗ ${subagent_type}`, d: error });
    }));
    c.on('task:fallback', /** @type {(...args: any[]) => any} */ (({ subagent_type, fallbackModel, error, reason }) => log.warn({ m: `task ↻ ${subagent_type} → fallback ${fallbackModel} (${reason}: ${log.truncate({ text: String(error ?? ''), n: 120 })})` })));
    c.on('task:hedge', /** @type {(...args: any[]) => any} */ (({ subagent_type, hedgeAfterMs }) => log.info({ m: `task ⏱ ${subagent_type} hedged after ${hedgeAfterMs}ms` })));
    return client;
}

// ---------------------------------------------------------------------------
// readline / interactive helpers
// ---------------------------------------------------------------------------


/**
 * stdin, CI, automated probes) must never crash OR hang the example: when
 * stdin reaches EOF, readline's question() never settles (it neither resolves
 * nor rejects), and once the interface is closed it THROWS synchronously —
 * both paths end in `fallback`. The prompt answers while the pipe still
 * carries input (`printf 'x\n' | node …` answers the first prompt); once the
 * stream has ended, later prompts fall back — so REPL loops exit cleanly on
 * exhausted scripted input instead of hanging (fallbacks are chosen per
 * caller: 'exit' for REPLs, a default topic elsewhere).
 * Race the prompt against the interface's own 'close' event (which readline
 * fires when stdin EOFs) — this adds exactly ONE listener per call, removed
 * in the finally, so readline's internal stdin handling is never disturbed
 * and repeated prompts in a REPL keep working.
 * @param {{rl: Record<string, any>, prompt: string, fallback?: string}} arg0 - a readline/promises Interface.
 * @returns {Promise<string>} the trimmed answer, or the fallback.
 */
export async function readlineSafe({ rl, prompt, fallback = '' }) {
    const r =  (rl);
    if (r.closed) return fallback;
    let onClosed = null;
    const closed = new Promise((resolve) => {
        onClosed = () => resolve(fallback);
        r.once('close', onClosed);
    });
    try {
        const answer = await Promise.race([r.question(prompt), closed]);
        return String(answer ?? '').trim() || fallback;
    } catch {
        return fallback;
    } finally {
        if (onClosed) r.removeListener('close', onClosed);
    }
}


/**
 * @param {{line: string|undefined}} arg0 - the raw input line.
 * @returns {boolean}
 */
export function isExitKeyword({ line }) {
    return BASE_EXIT_KEYWORDS.includes(String(line ?? '').trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------


/**
 * Fails fast (timeout + early-exit detection) instead of hanging the parent —
 * the old copy resolved on the first stdout chunk with no failure path.
 * @param {{script: string, args?: string[], timeoutMs?: *, env?: *}} arg0 - absolute path to the child .mjs.
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, port: number }>}
 */
export function spawnChild({ script, args = [], timeoutMs = 15000, env = null }) {
    const proc = spawn('node', [script, ...args], { stdio: ['pipe', 'pipe', 'inherit'], env: env ? { ...process.env, ...env } : process.env });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`child ${script} did not announce a port within ${timeoutMs}ms`));
        }, timeoutMs);
        /** @param {{fn: *, val: *}} arg0 */
        /** @param {{fn: *, val: *}} arg0 */
        const settle = ({ fn, val }) => { clearTimeout(timer); fn(val); };
        proc.stdout.once('data', (d) => {
            const m = d.toString().match(/PORT:(\d+)/);
            if (m) settle({ fn: resolve, val: { proc, port: Number(m[1]) } });
            else settle({ fn: reject, val: new Error(`child ${script} printed no PORT line`) });
        });
        proc.once('error', (err) => settle({ fn: reject, val: err }));
        proc.once('exit', (code) => settle({ fn: reject, val: new Error(`child ${script} exited early (code ${code})`) }));
    });
}


/**
 * Server children must never write to stdout (the parent parses ONLY the
 * `PORT:<n>` line) — redirect the shared logger's sink to stderr.
 * @returns {Record<string, any>} the reconfigured log.
 */
export function childLog() {
    log.configure({ sink: {
        log: /** @type {(...args: any[]) => any} */ ((t) => console.error(t)),
        error: /** @type {(...args: any[]) => any} */ ((t) => console.error(t)),
        write: /** @type {(...args: any[]) => any} */ ((t) => process.stderr.write(t)),
    } });
    return log;
}

// ---------------------------------------------------------------------------
// footer
// ---------------------------------------------------------------------------


/**
 * Also auto-logs the FULL run to the example's own subdir
 * (`examples/.logs/<example>/latest.{log,json}`) so any example can be debugged
 * after the fact. Examples that opt into the richer audit spine use
 * `createAudit(...).run(main)` instead.
 * @param {{mainFn: Function}} arg0 - the example's async main function.
 * @returns {void}
 */
export function runMain({ mainFn }) {
    const exampleId = exampleIdFromArgv() ?? 'unknown';
    const runLog = createRunLog({ exampleId });
    Promise.resolve()
        .then(() => mainFn())
        .then(() => { runLog.finish({ status: 'ok' }); })
        .catch(( error) => {
            log.error({ m: 'Error', d: error.message });
            runLog.finish({ status: 'error', error });
            process.exit(1);
        });
}
