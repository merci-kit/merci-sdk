// @ts-check
/**
 * @file Step-strategy cluster of WorkflowExecutor.
 * @version 0.12.0
 *
 * @description
 * The four engines (`naive`, `stateMachine`, `discussion`, `dag`) and the
 * helpers they share: verify resolution, empty-response retry, schema checks,
 * token accounting, and the event wiring each engine needs. The executor's
 * state is read through `host`; the class keeps one-line wrappers.
 */
import { sdkLog, sdkWarn, estimateMessageTokens, estimateTokens, safeStringify, truncateForPrompt } from '../../support/utils.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { getLeafOutput } from './graph-utils.mjs';
import { WorkflowPlanner } from './planner.mjs';
import { schemaViolation as schemaViolationOf, retrySchemaViolation, retryVerification, recordOrRethrow } from './executor-helpers.mjs';
import { sessionGroupKey, sessionGroup, sharedSessionRows, applySessionContract } from './executor-session.mjs';
import { WorkflowExecutor } from './executor.mjs';
import { StateMachine } from '../state-machine/machine.mjs';
import { DiscussionSession, isSubstantiveEntry } from '../discussion-session.mjs';
import { normalizeHandoff, goalBlockForHandoff, resolveHandoffTools } from '../agent-context.mjs';
import { fallbackKind, isTransientFallbackKind, assertVerifyVerdict, EMPTY_FALLBACK_CAUSE, SCHEMA_FALLBACK_CAUSE } from '../agentic-core.mjs';
import { remainingBudget as remainingBudgetOf, assertBudgetOverspent, sumNumericUsage } from '../budget-accounting.mjs';
import { runStep } from '../step.mjs';
import { ConfigurationError, VerificationError, OrchestrationExhaustedError } from '../../core/errors.mjs';
import { EVENTS } from '../../core/events.mjs';

/** @typedef {import('./executor.mjs').WorkflowStep} WorkflowStep */
/** @typedef {import('./executor.mjs').GroupSession} GroupSession */
/** @typedef {import('../../core/events.mjs').RunContext} RunContext */

// Intentional divergence (A5): matches the human-readable cause *substring*,
// unlike fallbackKind / isTransientFallbackKind which match the sentinel prefix —
// proven non-equivalent, do not reconcile (results/04-engine-hardening.md).
/** @param {{s: *}} arg0 */
const isTransientFallbackCause = ({ s }) =>
    s.includes(EMPTY_FALLBACK_CAUSE) || s.includes(SCHEMA_FALLBACK_CAUSE);

const TOOL_USE_SUFFIX = ' Use the available tools — do not ask the user for information that tools can provide.';

const STEP_GATE_REJECTED = Symbol('step-gate-rejected');
const STEP_RETRY = Symbol('step-retry');

/**
 * One verify resolution for every engine: a step's own `verify` wins,
 * otherwise the executor contract's criteria/judge. The SM, discussion and
 * nested-DAG engines used to ignore `node.verify` (and discussion ignored
 * the contract too), so a declared gate silently did nothing.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep}} arg0
 * @returns {Function|undefined}
 */
export function resolveVerify({ host, node }) {
    if (typeof node.verify === 'function') return node.verify;
    return host._buildStepVerify({ contract: host.contract });
}


/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, attempt: number, maxRetries: number, stepCtx: RunContext, detail: unknown}} arg0
 * @returns {symbol} STEP_RETRY
 */
export function retryEmpty({ host, node, attempt, maxRetries, stepCtx, detail }) {
    if (attempt >= maxRetries) {
        throw new OrchestrationExhaustedError({ message: `Step [${node.id}] produced no final answer after ${maxRetries + 1} attempt(s): ${String(detail)}`, options: { limit: maxRetries } });
    }
    stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL, payload: {
        stepId: node.id,
        attempt,
        evidence: `empty response — retrying (attempt ${attempt + 1}/${maxRetries + 1})`
    } });
    return STEP_RETRY;
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, result: unknown, attempt: number, maxRetries: number, stepCtx: RunContext}} arg0
 * @returns {unknown} the result or STEP_RETRY
 */
export function classifyFallback({ host, node, result, attempt, maxRetries, stepCtx }) {
    const kind = fallbackKind({ text: /** @type {string} */ (result) });
    if (kind === 'max_iterations') {
        throw new OrchestrationExhaustedError({ message: `Step [${node.id}] hit its iteration limit without a final answer — recorded as failed, not verified.` });
    }
    if (!isTransientFallbackKind({ kind })) return result;
    return retryEmpty({ host, node, attempt, maxRetries, stepCtx, detail: result });
}

/**
 * Returns a VerificationError when the step's output violates `stateSchema`,
 * else null. Parses JSON like `_recordStepOutput` so both agree on the value.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, result: unknown}} arg0
 * @returns {Error|null}
 */
export function schemaViolation({ host, node, result }) {
    return schemaViolationOf({ schema: host.stateSchema, node, result });
}


/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, stepCtx?: RunContext}} arg0
 */
export async function executeStepNodeNaive({ host, node, stepCtx = host._runCtx }) {
    try {
        const verifyFn = resolveVerify({ host, node }) ?? null;
        const maxRetries = node.maxRetries ?? LIMITS.default_retry_limit;
        let verifyFeedback = null;
        // Set only when the previous attempt failed its schema or verifier.
        let escalated = false;

        for (let attempt = 0; ; attempt++) {
            const result = await runStepAttempt({ host, node, verifyFeedback, attempt, escalated, stepCtx });
            if (result === STEP_GATE_REJECTED) return;
            const classified = classifyFallback({ host, node, result, attempt, maxRetries, stepCtx: /** @type {RunContext} */ (stepCtx) });
            if (classified === STEP_RETRY) continue;
            const schemaErr = schemaViolation({ host, node, result: classified });
            if (schemaErr) {
                verifyFeedback = retrySchemaViolation({ host, node, attempt, maxRetries, error: schemaErr, stepCtx: /** @type {RunContext} */ (stepCtx) });
                escalated = true;
                continue;
            }
            if (!verifyFn) {
                host._recordStepOutput({ node, result: /** @type {any} */ (classified), stepCtx });
                return;
            }
            const v = await verifyFn(classified, host.outputs);
            assertVerifyVerdict({ verdict: v, label: `Step [${node.id}]` });
            const evidence = retryVerification({ host, node, attempt, maxRetries, verdict: v, stepCtx: /** @type {RunContext} */ (stepCtx) });
            if (evidence === null) {
                host._recordStepOutput({ node, result: /** @type {any} */ (classified), stepCtx });
                return;
            }
            verifyFeedback = evidence ?? '';
            escalated = true;
        }
    } catch (err) {
        recordOrRethrow({ host, node, err, stepCtx });
    }
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, verifyFeedback?: string|null, attempt?: number, escalated?: boolean, stepCtx?: RunContext}} arg0
 */
async function runStepAttempt({ host, node, verifyFeedback = null, attempt = 0, escalated = false, stepCtx = /** @type {RunContext} */ (host._runCtx) }) {
    const stepModel = await host._stepModel(node);
    // Only a schema/verify failure escalates: a transient empty response
    // (`STEP_RETRY`) is not evidence that the model is too weak.
    const model = escalated && node.escalateModel
        ? await host._resolveModel({ node, requested: node.escalateModel })
        : stepModel;
    const groupKey = sessionGroupKey({ host, node, attempt });
    let group = sessionGroup({ host, key: groupKey, node, model });

    const { resolvedSystem: sys, resolvedUser: usr, transferRows } = await host._prepareStepPrompts({ node, preStep: true, stepCtx, model, provider: group.session.provider });
    const hitl = await host._resolveHitl({ node, resolvedSystem: sys, resolvedUser: usr, stepCtx });
    if (!hitl) return STEP_GATE_REJECTED;

    const handoff = normalizeHandoff({ handoff: node.handoff });
    const stepTools = resolveHandoffTools({ handoff: { tools: handoff.tools }, fallback: host.tools ?? [] }) ?? [];
    let resolvedSystem = hitl.system;
    let resolvedUser = hitl.user;
    if (stepTools.length > 0) resolvedSystem += TOOL_USE_SUFFIX;

    /** @type {any} */ (node)._sessionGroupKey = group.key;
    // The session group owns the prompt and the tool set: a node that changes
    // either would silently break the cached prefix and leak a stranger's
    // system prompt into the conversation, so it opens a boundary group.
    const toolsSignature = JSON.stringify(stepTools.map((t) => (typeof t === 'string'
        ? { name: t, description: '', parameters: null }
        : {
            name: String(t?.name ?? '?'),
            description: String(t?.description ?? ''),
            parameters: /** @type {any} */ (t).parameters ?? null,
        })));
    const sharedSystem = host.sessionSystemPrompt;
    const nodeSystem = resolvedSystem;
    group = applySessionContract({ host, group, node, model, systemPrompt: sharedSystem ?? nodeSystem, toolsSignature, stepCtx });
    if (sharedSystem) {
        resolvedSystem = sharedSystem;
        if (nodeSystem !== sharedSystem) resolvedUser = `${resolvedUser}\n\n[Step focus]\n${nodeSystem}`;
    } else {
        resolvedSystem = group.systemPrompt ?? nodeSystem;
    }

    // Ledger rows are injected once, on the step's first attempt. A retry
    // reuses node.messages (which already contain them) so they never double.
    // In a shared group the other members' rows come first: that is what makes
    // the group one conversation. The node's own earlier rows live in
    // node.messages, never twice.
    const ownMessages = (Array.isArray(node.messages) && node.messages.length > 0) ? node.messages : null;
    const sharedRows = ownMessages ? [] : sharedSessionRows({ host, group, node });
    const priorMessages = ownMessages
        ?? (sharedRows.length > 0 ? [...sharedRows, ...transferRows] : transferRows);

    sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Executing step [${node.id}] using model: ${model}${model !== stepModel ? ' (escalated)' : ''}`] });

    const stepBudget = remainingBudget({ host, stepCtx });
    const exhaustion = host._exhaustionOpts({ node });
    let outcome;
    try {
        outcome = await runStep({ step: node, deps: {
            client: host.client,
            model,
        session: group.session,
        journal: host._journal,
        journalBoundary: `${host._journalScope}${node.id}:`,
        contextProcessors: host.contextProcessors,
        systemPrompt: resolvedSystem,
        userText: resolvedUser,
        priorMessages,
        tools: stepTools,
        handoff,
        // D6: the step sees its own view, not the run's live context.
        agentContext: host._stepAgentContext(),
        capabilities: handoff.tools === 'none' ? null : {
            skills: host.skills,
            skillsPreload: host.skillsPreload,
            memoryProvider: host.memoryProvider,
            memoryOptions: host.memoryOptions,
            todoStore: host.todoStore,
            todoOptions: host._todoOptions,
            parallelToolCalls: true,
        },
        approvalPolicy: host._approvalPolicy,
        sessionPolicy: host.sessionPolicy,
        budget: stepBudget,
        decisionGate: host.decisionGate,
        promptCache: node.promptCache ?? host.promptCache,
        signal: (/** @type {any} */ (node))._stepSignal ?? host.signal,
        followUp: host.followUp,
        autoExtend: exhaustion.autoExtend ?? false,
        errorHandlers: exhaustion.errorHandlers ?? null,
        maxIterations: node.maxIterations ?? host.maxIterations,
        runContext: stepCtx,
        sessionId: host._runCtx?.runId ?? null,
        verifyFeedback,
        emitter: host,
        toolEvents: true,
        events: {
            text: EVENTS.WORKFLOW.STEP_TEXT,
            thought: EVENTS.WORKFLOW.STEP_THOUGHT,
            thoughtSignature: EVENTS.WORKFLOW.STEP_THOUGHT_SIGNATURE,
            streamEnd: EVENTS.WORKFLOW.STEP_STREAM_END,
            toolStart: EVENTS.WORKFLOW.STEP_TOOL_CALL_START,
            toolEnd: EVENTS.WORKFLOW.STEP_TOOL_CALL_END,
            /** @param {{content: *}} arg0 */
            makePayload: ({ content }) => ({ stepId: node.id, content }),
        },
        /** @param {{i: *, globalIteration: *, iterMax: *, extRound: *}} arg0 */
        onIterationStart: (/** @type {(arg0: {i: number, globalIteration: number, iterMax: number, extRound: number}) => void} */ (({ i, globalIteration, iterMax, extRound }) => {
            const num = globalIteration + 1;
            const total = extRound > 0
                ? `(batch ${extRound + 1}, iter ${i + 1}/${iterMax}, total ${num})`
                : `(${i + 1}/${iterMax})`;
            stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_ITERATION, payload: { stepId: node.id, iteration: num, label: total } });
        })),
        onLimitReached: (/** @type {(ctx: any) => Promise<boolean>} */ (async (ctx) => {
            const round = ctx?.extensionRound ?? 0;
            if (host._resumingRun && node._iterDecisions) {
                const decisions = node._iterDecisions;
                let queue = host._iterReplayQueue.get(node.id);
                if (!queue) {
                    queue = Object.keys(decisions)
                        .map(Number).sort((a, b) => a - b)
                        .map((r) => !!decisions[r]);
                    host._iterReplayQueue.set(node.id, queue);
                }
                if (queue.length > 0) {
                    const replayed = /** @type {boolean} */ (queue.shift());
                    sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] iteration-limit decision replayed from the checkpoint (approved=${replayed}).`] });
                    return replayed;
                }
            }
            if (host.listenerCount(EVENTS.WORKFLOW.HITL_ITERATION_LIMIT) === 0) {
                sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] hit its iteration limit but no listener is registered on '${EVENTS.WORKFLOW.HITL_ITERATION_LIMIT}' — declining the extension.`] });
                stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_GATE_REJECTED, payload: { stepId: node.id, reason: 'no_listener' } });
                return false;
            }
            const restoredGate = node._hitlGate?.gateEvent === EVENTS.WORKFLOW.HITL_ITERATION_LIMIT
                && node._hitlGate.extensionRound === round ? node._hitlGate : null;
            const approval = await host._openApprovalGate({ stepCtx, gateEvent: EVENTS.WORKFLOW.HITL_ITERATION_LIMIT, payload: {
                stepId: node.id,
                ...ctx
            }, onTimeout: null, node, restoredId: restoredGate?.approvalId ?? null });
            const approved = !!approval.approved;
            node._iterDecisions = { ...(node._iterDecisions ?? {}), [round]: approved };
            if (approved) {
                sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] iteration limit extended by HITL (round ${ctx.extensionRound}).`] });
                return true;
            }
            sdkWarn({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] iteration-limit extension was declined by the operator.`] });
            return false;
        })),
    } });
    } catch (err) {
        // A failed attempt still spent tokens. Charge it before the glue
        // records the step error, otherwise a retry/replan loop can run
        // forever without ever exhausting the workflow budget, and the
        // step's own cost would omit the discarded attempt (B7). Without a
        // budget the charge still accumulates the step usage; the cap check
        // is a no-op.
        chargeSessionUsage({ host, session: group.session, node, stepCtx, err });
        throw err;
    }

    recordStepUsage({ host, node, usage: /** @type {any} */ (outcome).usage });
    if (stepBudget) {
        const reported = (/** @type {any} */ (outcome)).usage?.total_tokens;
        const spent = Number.isFinite(reported) && reported > 0
            ? reported
            : estimateMessageTokens({ messages: outcome.messages });
        recordWorkflowTokens({ host, tokens: spent, costUsd: Number(/** @type {any} */ (outcome).usage?.cost_usd) || 0, stepCtx });
    }
    if (fallbackKind({ text: outcome.result }) === null) {
        node.messages = outcome.messages;
        node.deltaMessages = outcome.deltaMessages ?? outcome.messages;
        node._backend = outcome.provider;
    }
    return outcome.result;
}


// Intentional divergence (A6): kept separate from #wireDiscussionEvents /
// #wireNestedEvents — source→target mappings and payload shapes differ.
/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, sm: StateMachine, node: WorkflowStep, stepCtx: RunContext}} arg0
 */
export function wireStepSMEvents({ host, sm, node, stepCtx }) {
    sm.setMaxListeners?.(LIMITS.relay_max_listeners);
    sm.on(EVENTS.STATE_MACHINE.NODE_TEXT, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TEXT, payload: { stepId: node.id, content: e.content } }));
    sm.on(EVENTS.STATE_MACHINE.NODE_THOUGHT, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_THOUGHT, payload: { stepId: node.id, content: e.content } }));
    sm.on(EVENTS.STATE_MACHINE.NODE_STREAM_END, () => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_STREAM_END, payload: { stepId: node.id, content: '' } }));
    sm.on(EVENTS.WORKFLOW.STEP_TOOL_CALL_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TOOL_CALL_START, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.WORKFLOW.STEP_TOOL_CALL_END, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TOOL_CALL_END, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.STATE_MACHINE.NODE_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_NODE_START, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.STATE_MACHINE.NODE_END, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_NODE_END, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.STATE_MACHINE.VERIFY_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_START, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.STATE_MACHINE.VERIFY_PASS, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_PASS, payload: { stepId: node.id, attempt: 0, evidence: e.evidence ?? '', ...e } }));
    sm.on(EVENTS.STATE_MACHINE.VERIFY_FAIL, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL, payload: { stepId: node.id, attempt: (e.attempts ?? 1) - 1, evidence: e.evidence ?? '', ...e } }));
    sm.on(EVENTS.STATE_MACHINE.VERIFY_RETRY, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_RETRY, payload: { stepId: node.id, attempt: e.attempt ?? 0, evidence: e.evidence ?? '', ...e } }));
    sm.on(EVENTS.STATE_MACHINE.NO_PROGRESS, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_NO_PROGRESS, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.STATE_MACHINE.ESCALATED, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_ESCALATED, payload: { stepId: node.id, ...e } }));
    sm.on(EVENTS.STATE_MACHINE.CYCLE_LIMIT, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_CYCLE_LIMIT, payload: { stepId: node.id, ...e } }));
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, stepCtx?: RunContext}} arg0
 */
export async function executeStepNodeSM({ host, node, stepCtx = host._runCtx }) {
    try {
        const stepModel = await host._stepModel(node);
        const { resolvedSystem, resolvedUser } = await host._prepareStepPrompts({ node, preStep: host._agentContext?.objectivePolicy?.preStep === true, stepCtx, model: stepModel });
        const hitl = await host._resolveHitl({ node, resolvedSystem, resolvedUser, stepCtx });
        if (!hitl) return;

        let system = hitl.system;
        if (host.tools.length > 0) system += TOOL_USE_SUFFIX;

        const verify = resolveVerify({ host, node });
        const maxRetries = node.maxRetries ?? LIMITS.default_retry_limit;
        let schemaFeedback = '';

        for (let attempt = 0; ; attempt++) {
            const graph = /** @type {import('../state-machine/machine.mjs').SMGraph} */ ({
                entry: 'step',
                nodes: [{
                    id: 'step',
                    model: stepModel,
                    systemPrompt: system,
                    userPromptTemplate: hitl.user + schemaFeedback,
                    tools: node.tools ?? host.tools,
                    handoff: node.handoff ?? null,
                    ...(verify ? { verify } : {}),
                    maxIterations: node.maxIterations ?? host.maxIterations
                }],
                edges: []
            });
            const sm = new StateMachine({ graph, options: {
                client: host.client,
                defaultModel: host.defaultModel,
                journal: host._journal ?? undefined,
                journalScope: `${host._journalScope}${node.id}:`,
                contextProcessors: host.contextProcessors,
                objective: host.globalObjective,
                objectiveInjected: true,
                agentContext: normalizeHandoff({ handoff: node.handoff }).goal === 'clean' ? undefined : (host._stepAgentContext() ?? undefined),
                handoff: node.handoff ?? null,
                transfer: node.transfer ?? host.transfer ?? null,
                contract: host.contract ? { maxRetries: host.contract.maxRetries } : /** @type {any} */ (null),
                memoryProvider: /** @type {Object|undefined} */ (host.memoryProvider),
                memoryOptions: host.memoryOptions,
                todoStore: /** @type {Map<any, any>|undefined} */ (host.todoStore),
                todoOptions: host._todoOptions,
                approval: host._approvalPolicy,
                sessionPolicy: host.sessionPolicy,
                skills: host.skills,
                skillsPreload: host.skillsPreload,
                budget: remainingBudget({ host, stepCtx }),
                promptCache: node.promptCache ?? host.promptCache,
                ...host._exhaustionOpts({ node })
            } });
            wireStepSMEvents({ host, sm, node, stepCtx: /** @type {RunContext} */ (stepCtx) });

            sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Executing step [${node.id}] via stateMachine engine using model: ${stepModel}`] });
            try {
                await sm.run({ signal: /** @type {AbortSignal|undefined} */ ((/** @type {any} */ (node))._stepSignal ?? host.signal), followUp: /** @type {Function|undefined} */ (host.followUp), runContext: stepCtx });
            } catch (err) {
                const fe = /** @type {{ fallbackKind?: string }} */ (err);
                if (isTransientFallbackKind({ kind: fe?.fallbackKind })) {
                    retryEmpty({ host, node, attempt, maxRetries, stepCtx: /** @type {RunContext} */ (stepCtx), detail: /** @type {Error} */ (err).message });
                    continue;
                }
                throw err;
            }

            if (sm.phase === 'failed') throw new VerificationError({ message: `Step [${node.id}] failed acceptance criteria`, options: { stepId: node.id } });
            const payload = sm.toPayloadString();
            if (host.budget) {
                const used = Number(sm.usageTokens) > 0
                    ? Number(sm.usageTokens)
                    : estimateTokens({ text: hitl.user }) + estimateTokens({ text: payload });
                recordWorkflowTokens({ host, tokens: used, costUsd: Number(sm.usageUsd) || 0, stepCtx });
            }
            const classified = classifyFallback({ host, node, result: payload, attempt, maxRetries, stepCtx: /** @type {RunContext} */ (stepCtx) });
            if (classified === STEP_RETRY) continue;
            const schemaErr = schemaViolation({ host, node, result: classified });
            if (schemaErr) {
                schemaFeedback = `\n\n${retrySchemaViolation({ host, node, attempt, maxRetries, error: schemaErr, stepCtx: /** @type {RunContext} */ (stepCtx) })}`;
                continue;
            }
            host._recordStepOutput({ node, result: /** @type {any} */ (classified), stepCtx });
            return;
        }
    } catch (err) {
        recordOrRethrow({ host, node, err, stepCtx });
    }
}


/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, group: DiscussionSession, node: WorkflowStep, stepCtx: RunContext}} arg0
 */
export function wireDiscussionEvents({ host, group, node, stepCtx }) {
    group.setMaxListeners?.(LIMITS.relay_max_listeners);
    group.on(EVENTS.DISCUSSION.AGENT_TEXT, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TEXT, payload: { stepId: node.id, content: e.content } }));
    group.on(EVENTS.DISCUSSION.AGENT_THOUGHT, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_THOUGHT, payload: { stepId: node.id, content: e.content } }));
    group.on(EVENTS.DISCUSSION.AGENT_FINISH, () => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_STREAM_END, payload: { stepId: node.id, content: '' } }));
    group.on(EVENTS.DISCUSSION.TURN_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TURN_START, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.TURN_END, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TURN_END, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.AGENT_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_AGENT_START, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.AGENT_PASS, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_AGENT_PASS, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.JUDGED, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_JUDGED, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.TERMINATED, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TERMINATED, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.DAG_ORDER, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_DAG_ORDER, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.REPLAN, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_REPLAN, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.AGENT_ERROR, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_AGENT_ERROR, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.TOOL_CALL_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TOOL_CALL_START, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.TOOL_CALL_END, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_TOOL_CALL_END, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.AGENT_THOUGHT_SIGNATURE, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_AGENT_THOUGHT_SIGNATURE, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.VERIFY_START, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_START, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.VERIFY_PASS, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_PASS, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.VERIFY_FAIL, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL, payload: { stepId: node.id, ...e } }));
    group.on(EVENTS.DISCUSSION.VERIFY_RETRY, (e) => stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_RETRY, payload: { stepId: node.id, ...e } }));
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, stepCtx?: RunContext}} arg0
 */
export async function executeStepNodeDiscussion({ host, node, stepCtx = host._runCtx }) {
    try {
        const { resolvedSystem, resolvedUser } = await host._prepareStepPrompts({ node, preStep: host._agentContext?.objectivePolicy?.preStep === true, stepCtx });
        const hitl = await host._resolveHitl({ node, resolvedSystem, resolvedUser, stepCtx });
        if (!hitl) return;

        if (host.agents.length === 0) {
            throw new ConfigurationError({ message: `Discussion engine requires executor option agents[] (got none for step "${node.id}")` });
        }
        const maxRetries = node.maxRetries ?? LIMITS.default_retry_limit;
        let schemaFeedback = '';

        for (let attempt = 0; ; attempt++) {
            const group = new DiscussionSession({ client: host.client, options: {
                objective: host.globalObjective,
                journal: host._journal,
                journalScope: `${host._journalScope}${node.id}:`,
                agentContext: normalizeHandoff({ handoff: node.handoff }).goal === 'clean' ? undefined : (host._stepAgentContext() ?? undefined),
                runContext: stepCtx,
                contextProcessors: host.contextProcessors,
                handoff: node.handoff ?? null,
                transfer: node.transfer ?? host.transfer ?? null,
                todosStore: /** @type {Map<any, any>|undefined} */ (host.todoStore),
                todosOptions: host._todoOptions,
                memoryProvider: /** @type {Object|undefined} */ (host.memoryProvider),
                memoryOptions: host.memoryOptions,
                approval: host._approvalPolicy,
                sessionPolicy: host.sessionPolicy,
                skills: host.skills,
                skillsPreload: host.skillsPreload,
                budget: remainingBudget({ host, stepCtx }),
                ...host._exhaustionOpts({ node })
            } });
            for (const a of host.agents) {
                const agentHandoffTools = normalizeHandoff({ handoff: a.handoff ?? node.handoff }).tools;
                const agentTools = agentHandoffTools === 'none'
                    ? []
                    : [...(a.tools ?? []), ...(Array.isArray(agentHandoffTools) ? agentHandoffTools : (node.tools ?? host.tools))];
                group.addAgent({
                    ...a,
                    client: a.client ?? undefined,
                    handoff: a.handoff ?? node.handoff ?? null,
                    tools: agentTools,
                    maxIterations: a.maxIterations ?? node.maxIterations ?? host.maxIterations,
                });
            }
            wireDiscussionEvents({ host, group, node, stepCtx: /** @type {RunContext} */ (stepCtx) });

            const discussionObjective = goalBlockForHandoff({ ctx: host._agentContext, handoff: normalizeHandoff({ handoff: node.handoff }) });
            const constraints = discussionObjective && hitl.system.includes(discussionObjective)
                ? hitl.system.replace(discussionObjective, '').trim()
                : hitl.system;
            const instruction = hitl.user + (constraints ? `\n\nConstraints: ${constraints}` : '') + schemaFeedback;
            sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Executing step [${node.id}] via discussion engine (${host.agents.length} agents)`] });
            const stepSignal = /** @type {AbortSignal|undefined} */ ((/** @type {any} */ (node))._stepSignal ?? host.signal);
            await group.discuss({ instruction, turns: node.turns ?? 1, sequential: true, signal: stepSignal, followUp: /** @type {Function|undefined} */ (host.followUp) });
            // E-4: more than one voice is a group answer only after aggregation;
            // the last speaker is one agent's opinion, not the group's decision.
            const aggregated = host.agents.length > 1
                ? await group.aggregate({ instruction, options: { signal: stepSignal, followUp: /** @type {Function|undefined} */ (host.followUp) } })
                : null;
            const ledger = group.getLedger();
            if (host.budget) {
                const ledgerChars = ledger.map((/** @type {any} */ e) => String(e?.content ?? '')).join('\n');
                const used = Number(group.usageTokens) > 0
                    ? Number(group.usageTokens)
                    : estimateTokens({ text: instruction }) + estimateTokens({ text: ledgerChars });
                recordWorkflowTokens({ host, tokens: used, costUsd: Number(group.usageUsd) || 0, stepCtx });
            }
            const last = aggregated ?? /** @type {{content?: any}|undefined} */ (
                ledger.findLast((/** @type {any} */ e) => isSubstantiveEntry(e)
                    || (typeof e?.content === 'string' && isTransientFallbackCause({ s: e.content })))
            );
            if (!last) throw new OrchestrationExhaustedError({ message: `Step [${node.id}] discussion produced no usable output: no substantive entry in the ledger.` });
            const content = last.content;
            const text = String(content);
            if (text.startsWith('[error:') && !isTransientFallbackCause({ s: text })) {
                throw new OrchestrationExhaustedError({ message: `Step [${node.id}] discussion produced no usable output: ${text}` });
            }
            if (isTransientFallbackCause({ s: text })) {
                retryEmpty({ host, node, attempt, maxRetries, stepCtx: /** @type {RunContext} */ (stepCtx), detail: text });
                continue;
            }
            const classified = classifyFallback({ host, node, result: content, attempt, maxRetries, stepCtx: /** @type {RunContext} */ (stepCtx) });
            if (classified === STEP_RETRY) continue;
            const schemaErr = schemaViolation({ host, node, result: classified });
            if (schemaErr) {
                schemaFeedback = `\n\n${retrySchemaViolation({ host, node, attempt, maxRetries, error: schemaErr, stepCtx: /** @type {RunContext} */ (stepCtx) })}`;
                continue;
            }
            const verifyFn = resolveVerify({ host, node });
            if (verifyFn) {
                const v = await verifyFn(classified, host.outputs);
                assertVerifyVerdict({ verdict: v, label: `Step [${node.id}]` });
                const evidence = retryVerification({ host, node, attempt, maxRetries, verdict: v, stepCtx: /** @type {RunContext} */ (stepCtx) });
                if (evidence !== null) {
                    schemaFeedback = `\n\nYour previous output did not pass verification: ${evidence ?? 'no evidence'}. Revise it and return the corrected result.`;
                    continue;
                }
            }
            host._recordStepOutput({ node, result: /** @type {any} */ (classified), stepCtx });
            return;
        }
    } catch (err) {
        recordOrRethrow({ host, node, err, stepCtx });
    }
}


/**
 * PL1c: what a `decompose` node's planner sees — its own brief, the outputs its
 * ancestors produced, and the plan that is still pending.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, subObjective: string}} arg0
 * @returns {string}
 */
export function decompositionObjective({ host, node, subObjective }) {
    const brief = typeof node.brief === 'string' ? node.brief.trim() : '';
    // A title-only node resolves to an empty prompt; the brief (or the title) is what
    // the planner would otherwise have nothing to read.
    const parts = [subObjective.trim() ? subObjective : (brief || String(node.title ?? node.name ?? node.id))];
    if (brief) parts.push('', '## Acceptance', brief);
    const ancestors = host._ancestorIds({ node });
    /** @type {string[]} */
    const progress = [];
    for (const id of ancestors) {
        if (!Object.hasOwn(host.outputs, id)) continue;
        const out = host.outputs[id];
        const text = typeof out?.output === 'string' ? out.output : safeStringify({ value: out?.output ?? '' });
        // The intake block already carries an ancestor's output into the prompt;
        // repeating it would only make the planner read the same evidence twice.
        // Matched by the block's own marker, not by the output text: a short output
        // that happens to appear in the prompt is still a real prerequisite.
        if (subObjective.includes(`[Output from Step "${id}"]`)) continue;
        progress.push(`- ${id}: ${truncateForPrompt({ text, maxChars: LIMITS.evaluator_digest_chars })}`);
    }
    if (progress.length > 0) parts.push('', '## Completed prerequisites', ...progress);
    /** @type {string[]} */
    const remaining = [];
    for (const n of host.steps.values()) {
        if (n.id === node.id || n.historical || n.status === 'completed') continue;
        const brief = typeof n.brief === 'string' && n.brief.trim() ? n.brief : String(n.name ?? n.title ?? n.id);
        remaining.push(`- ${n.id}: ${brief}${n.status === 'running' ? ' (running)' : ''}`);
    }
    if (remaining.length > 0) parts.push('', '## Remaining plan', ...remaining);
    return parts.join('\n');
}

/**
 * W4-1: grants a nested run its share of the replan budget. `_replanCount` counts
 * reserved plus spent, so two concurrent nests split the remainder instead of
 * each being handed all of it. W4-7: a non-finite cap passes `undefined` (the
 * child's own default) rather than NaN, which no `used >= max` guard can stop.
 * @param {{host: import('./executor.mjs').WorkflowExecutor}} arg0
 * @returns {number|undefined}
 */
function reserveReplanGrant({ host }) {
    if (!Number.isFinite(host.maxReplanCount)) return undefined;
    const cap = /** @type {number} */ (host.maxReplanCount);
    const held = Number.isFinite(host._replanCount) ? Number(host._replanCount) : 0;
    const grant = Math.max(0, cap - held);
    host._replanCount = held + grant;
    return grant;
}

/**
 * W4-1: releases a grant and adds what the child actually spent, so a reserved
 * share the nest did not use returns to the run. `baseline` is the child's
 * carried count (a resumed child starts from its checkpoint), which the parent
 * already folded in before that checkpoint — only the new spend is added.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, grant: number|undefined, child: WorkflowExecutor|undefined, baseline: number}} arg0
 * @returns {void}
 */
function releaseReplanGrant({ host, grant, child, baseline = 0 }) {
    const carried = Number.isFinite(child?._replanCount) ? Number(child?._replanCount) : 0;
    const spent = Math.max(0, carried - baseline);
    const held = Number.isFinite(host._replanCount) ? Number(host._replanCount) : 0;
    const total = Math.max(0, held - (grant ?? 0) + spent);
    host._replanCount = Number.isFinite(host.maxReplanCount) ? Math.min(/** @type {number} */ (host.maxReplanCount), total) : total;
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, child: WorkflowExecutor, node: WorkflowStep, stepCtx: RunContext}} arg0
 */
export function wireNestedEvents({ host, child, node, stepCtx }) {
    const stream = [
        EVENTS.WORKFLOW.STEP_TEXT,
        EVENTS.WORKFLOW.STEP_THOUGHT,
        EVENTS.WORKFLOW.STEP_STREAM_END,
        EVENTS.WORKFLOW.STEP_ITERATION,
    ];
    for (const name of stream) {
        child.on(name, (/** @type {any} */ payload) => stepCtx.emit({ emitter: host, name, payload: { ...payload, stepId: node.id } }));
    }
    for (const name of [EVENTS.WORKFLOW.HITL_PENDING, EVENTS.WORKFLOW.HITL_ITERATION_LIMIT, EVENTS.WORKFLOW.HITL_TIMEOUT, EVENTS.WORKFLOW.STEP_GATE_REJECTED, EVENTS.WORKFLOW.STEP_DECOMPOSED]) {
        child.on(name, (/** @type {any} */ payload) => stepCtx.emit({ emitter: host, name, payload }));
    }
    // C-6/W4-4: a nested step's lifecycle is visible from the parent run, and so
    // is the nested run itself. The envelope is re-stamped on the parent's
    // context, so the child's run id rides the payload as `nestedRunId`;
    // `nestedIn` names the immediate parent node (one level, per forward).
    /** @type {() => string|null} */
    const childRunId = () => child._runCtx?.runId ?? null;
    for (const name of [EVENTS.WORKFLOW.STEP_START, EVENTS.WORKFLOW.STEP_COMPLETE, EVENTS.WORKFLOW.STEP_ERROR, EVENTS.WORKFLOW.START, EVENTS.WORKFLOW.END]) {
        child.on(name, (/** @type {any} */ payload) => stepCtx.emit({ emitter: host, name, payload: { ...payload, nestedIn: node.id, nestedRunId: childRunId() } }));
    }
    const snapshot = () => {
        try { node._childState = child.save(); } catch {   }
    };
    child.on(EVENTS.WORKFLOW.STEP_COMPLETE, snapshot);
    child.on(EVENTS.WORKFLOW.STEP_ERROR, snapshot);
}

/**
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, stepCtx?: RunContext}} arg0
 */
export async function executeStepNodeDag({ host, node, stepCtx = host._runCtx }) {
    try {
        if (host._dagDepth >= host.maxDepth) {
            throw new ConfigurationError({ message: `Step [${node.id}] requested a nested DAG but the depth limit (${host.maxDepth}) is reached — increase maxDepth to allow deeper nesting.` });
        }
        const stepModel = await host._stepModel(node);
        const { resolvedSystem, resolvedUser } = await host._prepareStepPrompts({ node, preStep: true, stepCtx, model: stepModel });
        const hitl = await host._resolveHitl({ node, resolvedSystem, resolvedUser, stepCtx });
        if (!hitl) return;

        const handoff = normalizeHandoff({ handoff: node.handoff });
        const planner = /** @type {{plan: Function}} */ (host._planner ?? new WorkflowPlanner({ options: { client: host.client, model: host.defaultModel } }));
        const maxRetries = node.maxRetries ?? LIMITS.default_retry_limit;
        let schemaFeedback = '';

        for (let attempt = 0; ; attempt++) {
            const baseObjective = node.subObjective ?? hitl.user;
            const subObjective = (node.expansion === 'decompose'
                ? decompositionObjective({ host, node, subObjective: baseObjective })
                : baseObjective) + schemaFeedback;
            // W4-1: reserve this attempt's share of the replan budget before the
            // child starts, so a concurrent nest cannot be granted it too.
            const grant = reserveReplanGrant({ host });
            /** @type {number} */
            let replanBaseline = 0;
            /** @type {WorkflowExecutor|undefined} */
            let child;
            try {
            const childOpts = {
                client: host.client,
                defaultModel: host.defaultModel,
                tools: node.tools ?? host.tools,
                transfer: node.transfer ?? host.transfer ?? undefined,
                contextProcessors: host.contextProcessors,
                memoryProvider: host.memoryProvider ?? undefined,
                memoryOptions: host.memoryOptions,
                skills: host.skills ?? undefined,
                skillsPreload: host.skillsPreload,
                todoStore: host.todoStore ?? undefined,
                todoOptions: host._todoOptions,
                hitlTimeoutMs: host.hitlTimeoutMs,
                maxIterations: host.maxIterations,
                // C-5/W4-1: the nest spends one replan budget, not one per level,
                // and the share is reserved on the host before the child starts.
                maxReplanCount: grant,
                stepTimeoutMs: host.stepTimeoutMs ?? undefined,
                maxConcurrency: host.maxConcurrency ?? undefined,
                budget: remainingBudget({ host, stepCtx }) ?? undefined,
                signal: (/** @type {any} */ (node))._stepSignal ?? host.signal ?? undefined,
                followUp: host.followUp ?? undefined,
                autoExtend: host.autoExtend,
                errorHandlers: host.errorHandlers ?? undefined,
                engine: node.subEngine ?? 'naive',
                contract: host.contract ?? undefined,
                agents: host.agents,
                approval: host._approvalPolicy ?? undefined,
                sessionPolicy: host.sessionPolicy,
                maxDepth: host.maxDepth,
                decisionGate: host.decisionGate,
                _dagDepth: host._dagDepth + 1,
                _approvalIdPrefix: `${host._approvalIdPrefix || ''}${node.id}:`,
                journal: host._journal ?? undefined,
                _journalScope: `${host._journalScope}${node.id}:`,
                agentContext: handoff.goal === 'clean' ? null : host._stepAgentContext(),
                // C-6: the nested run is a child of the step that started it, so
                // every inner event is reachable from the outer run tree.
                runContext: stepCtx,
            };

            let subSteps;
            let plannedNow = false;
            if (attempt === 0 && typeof node._childState === 'string' && node._childState.length > 0) {
                child = WorkflowExecutor.load({ json: node._childState, options: childOpts });
                // The restored count was folded into the parent before the
                // checkpoint, so only spend above it is new (W4-1 release).
                replanBaseline = Number.isFinite(child._replanCount) ? Number(child._replanCount) : 0;
                child._journal = host._journal;
                child._journalInjected = true;
                subSteps = Array.from(child.steps.values());
                sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Step [${node.id}] resuming nested DAG from the checkpoint (${subSteps.length} step(s)).`] });
            } else {
                child = new WorkflowExecutor({ options: childOpts });
                if (Array.isArray(node.subSteps) && node.subSteps.length > 0) {
                    subSteps = node.subSteps;
                } else if (Array.isArray(node._decomposedSteps) && node._decomposedSteps.length > 0) {
                    // The sub-plan this node was already decomposed into: a verify/schema
                    // retry reuses it instead of planning the same node again.
                    subSteps = node._decomposedSteps;
                } else {
                    const planned = await planner.plan({
                        objective: subObjective,
                        // The tools the sub-plan will actually run with, not the executor's.
                        availableTools: node.tools ?? host.tools,
                        signal: host.signal,
                        sessionId: host._runCtx?.runId ?? null,
                    });
                    subSteps = /** @type {any[]} */ (planned.steps);
                    if (node.expansion === 'decompose') plannedNow = true;
                }
                child.setSteps({ stepsList: subSteps });
                if (plannedNow) {
                    // Cached only after `setSteps` accepted it: an invalid sub-plan must
                    // not be replayed by every retry. It rides the checkpoint, so a retry
                    // or a resume reuses it (and it is excluded from the definition
                    // fingerprint, since the planner wrote it).
                    node._decomposedSteps = subSteps.map((x) => ({ ...x }));
                    (/** @type {RunContext} */ (stepCtx)).emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_DECOMPOSED, payload: {
                        stepId: node.id,
                        subSteps: subSteps.map((x) => x.id),
                        depth: host._dagDepth + 1,
                    } });
                }
            }

            host._nestedApprovals.set(node.id, child);
            wireNestedEvents({ host, child, node, stepCtx: /** @type {RunContext} */ (stepCtx) });
            sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: [`Executing step [${node.id}] via nested DAG (${subSteps.length} step(s), depth ${host._dagDepth + 1})`] });
            let outputs;
            try {
                outputs = await child.execute({ userGoal: subObjective, planner, evaluator: null, context: host.context });
            } finally {
                host._nestedApprovals.delete(node.id);
                if (host.budget && child._workflowTokensSpent > 0) {
                    recordWorkflowTokens({ host, tokens: child._workflowTokensSpent, costUsd: child._workflowUsdSpent ?? 0, stepCtx });
                }
            }
            const leaf = getLeafOutput({ stepsMap: child.steps, outputs: /** @type {Record<string, import('./graph-utils.mjs').LeafRecord|undefined>} */ (outputs) }).output;
            const schemaErr = schemaViolation({ host, node, result: leaf });
            if (schemaErr) {
                schemaFeedback = `\n\n${retrySchemaViolation({ host, node, attempt, maxRetries, error: schemaErr, stepCtx: /** @type {RunContext} */ (stepCtx) })}`;
                // W4-12: this child's replans are counted on release; a checkpoint
                // must not carry it into a resume and be folded a second time.
                delete (/** @type {any} */ (node))._childState;
                continue;
            }
            const verifyFn = resolveVerify({ host, node });
            if (verifyFn) {
                const v = await verifyFn(leaf, host.outputs);
                assertVerifyVerdict({ verdict: v, label: `Step [${node.id}]` });
                const evidence = retryVerification({ host, node, attempt, maxRetries, verdict: v, stepCtx: /** @type {RunContext} */ (stepCtx) });
                if (evidence !== null) {
                    schemaFeedback = `\n\nYour previous output did not pass verification: ${evidence ?? 'no evidence'}. Revise it and return the corrected result.`;
                    delete (/** @type {any} */ (node))._childState;
                    continue;
                }
            }
            host._recordStepOutput({ node, result: leaf, stepCtx });
            return;
            } finally {
                releaseReplanGrant({ host, grant, child, baseline: replanBaseline });
            }
        }
    } catch (err) {
        recordOrRethrow({ host, node, err, stepCtx });
    }
}


/**
 * Returns the token budget the next step may spend — the remaining cap
 * shared between the step and its wave siblings — or throws
 * `BudgetExceededError` if cumulative tokens have already exhausted it.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, stepCtx?: RunContext|null}} arg0
 * @returns {import('../budget-accounting.mjs').TokenBudget|null}
 */
export function remainingBudget({ host, stepCtx = host._runCtx }) {
    // A wave's steps share the remaining cap — otherwise every parallel step
    // is handed the whole remainder and the wave overspends (C2). The
    // divisor is the number of steps in the wave, NOT the concurrency
    // limit: with a bounded pool a step that starts after a slot frees
    // is authorised on a `remaining` that does not count the steps still
    // running, so dividing by the pool size overspends the cap.
    // ponytail: a fair share, not a reservation — a step that needs more
    // than its share fails with BudgetExceededError instead of taking the
    // wave's budget from its sibling. When the remainder is smaller than
    // the wave, the shares floor at 1 and the cap is exceeded by at most
    // (wave - 1) tokens, which `#recordWorkflowTokens` then fails closed on.
    return remainingBudgetOf({
        budget: host.budget,
        spent: host._workflowTokensSpent,
        spentUsd: host._workflowUsdSpent ?? 0,
        divisor: host._waveSize,
        floor: LIMITS.swarm_turn_floor,
        round: true,
        emit: ({ usage, maxTotalTokens }) => (stepCtx ?? host._runCtx)?.emit({ emitter: host, name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxTotalTokens } }),
    });
}

/**
 * Accumulates tokens and USD spent by a step and enforces the workflow-wide caps.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, tokens: number, costUsd?: number, stepCtx?: RunContext|null}} arg0
 */
export function recordWorkflowTokens({ host, tokens, costUsd = 0, stepCtx = host._runCtx }) {
    const chargedTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    const chargedUsd = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    if (chargedTokens <= 0 && chargedUsd <= 0) return;
    host._workflowTokensSpent += chargedTokens;
    host._workflowUsdSpent = (host._workflowUsdSpent ?? 0) + chargedUsd;
    assertBudgetOverspent({
        budget: host.budget,
        spent: host._workflowTokensSpent,
        spentUsd: host._workflowUsdSpent,
        emit: ({ usage, maxTotalTokens, maxBudgetUsd }) => (stepCtx ?? host._runCtx)?.emit({ emitter: host, name: EVENTS.CLIENT.BUDGET_EXCEEDED, payload: { usage, maxTotalTokens, maxBudgetUsd } }),
    });
}

/**
 * Adds one attempt's reported usage onto the step record (B7), so "what did
 * step X cost" is answerable per step and survives a checkpoint. Summed
 * across attempts: a discarded retry still spent its tokens. Numeric fields
 * only, so `cost_usd` and the cache counters ride along when reported.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, usage: Object|null}} arg0
 */
export function recordStepUsage({ host, node, usage }) {
    if (!usage || typeof usage !== 'object') return;
    const prev = (node.usage && typeof node.usage === 'object') ? node.usage : {};
    const next = sumNumericUsage({ usage, into: { ...prev } });
    if (Object.keys(next).length > 0) node.usage = next;
}

/**
 * Charges the usage a failed session run still consumed. `runStep`
 * rethrows but leaves `_lastRunUsage` on the session; the success path
 * already reads `outcome.usage`.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, session: GroupSession|null, node?: WorkflowStep|null, stepCtx?: RunContext|null, err?: unknown}} arg0
 */
export function chargeSessionUsage({ host, session, node = null, stepCtx = host._runCtx, err = null }) {
    // `runStep` attaches the attempt's merged usage (LLM + decision) to the error.
    const used = /** @type {any} */ (err)?.runUsage ?? session?._lastRunUsage;
    if (node) recordStepUsage({ host, node, usage: used ?? null });
    const tokens = Number(used?.total_tokens);
    if (Number.isFinite(tokens) && tokens > 0) recordWorkflowTokens({ host, tokens, costUsd: Number(used?.cost_usd) || 0, stepCtx });
}

