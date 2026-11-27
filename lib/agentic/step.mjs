// @ts-check
/**
 * @file step — the atomic, engine-agnostic agentic step primitive.
 * @version 0.12.0
 *
 * @description
 * One `step` is the data of a single agentic unit; `runStep` executes it.
 * Every engine (glue) — naive, DAG, StateMachine, MAA — consumes the same
 * `Step` shape and runs its steps through this one primitive, so the
 * per-step session build (approval policy, circuit breaker, handoff,
 * objective/AgentContext, tools/memory/todos, run options, stream events,
 * last-step capture) lives in exactly one place instead of being duplicated
 * per engine.
 *
 * The CLI REPL (`lib/agentic/cli/launcher.mjs`) is the one deliberate
 * exemption (A7): it must SUSPEND a run on a `tool_request` — yield the call to
 * the terminal, then resume with the results — while `runStep` drives the loop
 * to completion and reports events one-way. The REPL is an interactive loop, not
 * a step; routing it through `runStep` would need a tool-approval channel in the
 * primitive, which no engine wants. Session reuse is NOT the reason: `runStep`
 * accepts a caller-provided `session`.
 *
 * The glue still owns: prompt interpolation/intake, HITL gating, fallback
 * classification, verify/retry policy, and result recording — those differ
 * per engine. `runStep` returns the raw outcome and lets the glue decide.
 */

import { createUserMessage, createAssistantMessage } from '../messaging/messages.mjs';
import { MERCI_ID_KEY } from '../core/constants/index.mjs';
import { normalizeHandoff, resolveHandoffTools } from './agent-context.mjs';
import { applyApprovalPolicy, forwardStreamEvents, forwardToolEvents } from './agentic-core.mjs';
import { getCircuitBreaker, circuitKey } from '../support/retry-policy.mjs';
import { enterPhase, PHASES } from '../core/lifecycle.mjs';
import { applySessionPolicy, createSession, adoptSessionId } from './session-policy.mjs';
import { attachDecisionUsage, decisionTokensFromEvent, mergeRunUsage } from './decision-usage.mjs';
import { interleavePendingRows, claimInboxRows, restoreInboxRows } from './pending-inbox.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';

/**
 * The canonical shape of one agentic step. `WorkflowStep` (DAG) and `SMNode`
 * (StateMachine) both conform to it; a glue may add engine-specific fields.
 * @typedef {Object} Step
 * @property {string} [id] - DAG/SM steps carry an id; MAA turns are identified by `name`.
 * @property {string} [name]
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [userPromptTemplate]
 * @property {Array<Object>} [tools]
 * @property {import('./agent-context.mjs').HandoffOptions|null} [handoff]
 * @property {Function} [verify]
 * @property {number} [maxIterations]
 * @property {number} [maxRetries]
 * @property {number} [timeoutMs]
 * @property {string} [engine]
 * @property {string[]} [dependencies]
 * @property {Array<import('./chat-session.mjs').ChatRow>} [messages] - Prior history rows (retry continuity).
 * @property {Object} [autoExtend]
 * @property {Object} [errorHandlers]
 */

/**
 * @typedef {Object} RunStepCapabilities
 * @property {Array<Object>|null} [skills] - Skill tools (from loadSkillsFromDirectory / withSkills).
 * @property {boolean} [skillsPreload] - Preload the skill listing each step.
 * @property {Object|null} [memoryProvider]
 * @property {Object} [memoryOptions]
 * @property {Map<unknown, unknown>|null} [todoStore]
 * @property {Object} [todoOptions]
 * @property {boolean} [parallelToolCalls] - Enable parallel tool calls when todos are attached.
 */

/**
 * @typedef {Object} RunStepEvents
 * @property {string} text
 * @property {string} thought
 * @property {string} [thoughtSignature]
 * @property {string} [streamEnd]
 * @property {string} [toolStart] - When set with `toolEvents`, tool-call-start events are forwarded.
 * @property {string} [toolEnd]
 * @property {(arg0: {content: string}) => Object} makePayload
 */

/**
 * The usage snapshot a step reports for the attempt it ran: vendor token names,
 * as `_lastRunUsage` carries them (null when the backend reported none).
 * @typedef {Object} RunStepUsage
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]
 * @property {number} [total_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [reasoning_tokens]
 * @property {number|null} [cost_usd]
 * @property {number} [decision_tokens] - A subset of `total_tokens`; never add the two.
 * @property {number} [decision_cost_usd] - Decision cost when the LLM cost is unknown.
 * @property {Object} [credits]
 */

/**
 * What `runStep` executes a step with: the session inputs the glue supplies and
 * the hooks it listens on. Every field is optional, and `deps` wins over the
 * fields mapped from `Step` (see `stepToDeps`).
 * @typedef {Object} StepDeps
 * @property {Object|null} [client] - The backend client; a `session` factory is all the step needs.
 * @property {string} [model]
 * @property {Object} [session] - A caller-provided session (skips creation).
 * @property {string} [systemPrompt]
 * @property {string} [userText]
 * @property {Array<import('./chat-session.mjs').ChatRow>} [priorMessages]
 * @property {Array<import('./chat-session.mjs').ChatRow>} [messages] - A full explicit history; wins over `priorMessages`/`userText`.
 * @property {Array<Object>} [tools]
 * @property {import('./agent-context.mjs').HandoffOptions|null} [handoff]
 * @property {Object|null} [agentContext]
 * @property {RunStepCapabilities|null} [capabilities]
 * @property {Object|null} [approvalPolicy]
 * @property {Object|null} [budget]
 * @property {import('./decision-gate.mjs').DecisionGate|null} [decisionGate]
 * @property {AbortSignal|null} [signal]
 * @property {Function|null} [followUp]
 * @property {boolean|Object} [autoExtend]
 * @property {Object|null} [errorHandlers]
 * @property {number} [maxIterations]
 * @property {Object|null} [runContext]
 * @property {string|null} [sessionId]
 * @property {string|null} [verifyFeedback]
 * @property {Object|null} [emitter]
 * @property {RunStepEvents} [events]
 * @property {boolean} [toolEvents]
 * @property {Function|null} [onIterationStart]
 * @property {Function|null} [onLimitReached]
 * @property {boolean} [configureSession]
 * @property {Function|null} [onEvent]
 * @property {Object|null} [journal]
 * @property {string|null} [journalBoundary]
 * @property {Array<Object>|null} [contextProcessors]
 * @property {Object|null} [sessionPolicy]
 * @property {boolean|number|Object|null} [promptCache]
 */










/**
 * Maps a documented `Step` onto the deps bag `runStep` executes. Every field a
 * caller can reasonably supply is mapped; `deps` wins on conflict, so the engines
 * that pass an explicit bag are unaffected. Without this mapper the published
 * `Step` typedef was not the contract — 1 of its 16 fields was ever read.
 * Engine-level fields (`engine`, `dependencies`, `verify`, `maxRetries`,
 * `timeoutMs`) are the glue's, not the step primitive's, and are not mapped.
 * @param {{step?: Step|null}} arg0
 * @returns {StepDeps}
 */
function stepToDeps({ step = null }) {
    if (!step || typeof step !== 'object') return {};
    /** @type {StepDeps} */
    const out = {};
    if (step.model != null) out.model = step.model;
    if (step.systemPrompt != null) out.systemPrompt = step.systemPrompt;
    if (step.userPromptTemplate != null) out.userText = step.userPromptTemplate;
    if (Array.isArray(step.tools)) out.tools = step.tools;
    if (step.handoff != null) out.handoff = step.handoff;
    if (Array.isArray(step.messages) && step.messages.length > 0) out.priorMessages = step.messages;
    if (step.maxIterations != null) out.maxIterations = step.maxIterations;
    if (step.autoExtend != null) out.autoExtend = step.autoExtend;
    if (step.errorHandlers != null) out.errorHandlers = step.errorHandlers;
    return out;
}

/**
 * The one place the initial message row is assembled. `explicitMessages` is a
 * full history and wins; `verifyFeedback` must reach the model on BOTH paths, so
 * it is applied here instead of only in the `userText` branch (A4).
 * @param {{explicitMessages?: Array<any>|null, priorMessages?: Array<any>, userText?: any, verifyFeedback?: string|null, provider: string}} arg0
 * @returns {Array<any>}
 */
function assembleMessagesRow({ explicitMessages = null, priorMessages = [], userText = '', verifyFeedback = null, provider }) {
    const feedback = verifyFeedback
        ? `[Verification feedback from the previous attempt]\n${verifyFeedback}\nRevise your approach accordingly and try again.`
        : '';
    if (Array.isArray(explicitMessages) && explicitMessages.length > 0) {
        // No prompt row to append to: the feedback arrives as its own user turn.
        return feedback
            ? [...explicitMessages, createUserMessage({ provider, content: feedback })]
            : explicitMessages;
    }
    const user = feedback ? `${userText ?? ''}\n\n${feedback}` : (userText ?? '');
    return [...priorMessages, createUserMessage({ provider, content: user })];
}

/**
 * Runs ONE agentic step attempt in a fresh session: builds the session with
 * the glue's policy/capabilities, runs the agentic loop, forwards stream
 * events through the glue's event names, and captures the step's full message
 * row + reasoning signature for the next attempt/step.
 * Aborts and fallbacks are returned/thrown raw — the glue classifies them.
 * @param {{step?: Step|null, deps?: StepDeps}} arg0
 * @returns {Promise<{result: string, messages: Array<import('./chat-session.mjs').ChatRow>, deltaMessages: Array<import('./chat-session.mjs').ChatRow>, signature: string|null, provider: string, usage: RunStepUsage|null}>}
 */
export async function runStep({ step = null, deps = {} }) {
    // The deps bag is typed at the boundary (`StepDeps`); inside, the session is
    // the backend's own object and every field is read defensively.
    const d = /** @type {Record<string, any>} */ ({ ...stepToDeps({ step }), ...deps });
    const {
        client, model, session: providedSession, systemPrompt, userText,
        priorMessages = [], messages: explicitMessages, tools = [], handoff: rawHandoff = null, agentContext = null,
        capabilities = null, approvalPolicy = null, budget = null, decisionGate = null,
        signal = null, followUp = null, autoExtend = false, errorHandlers = null,
        maxIterations, runContext = null, sessionId = null, verifyFeedback = null,
        emitter = null, events, toolEvents = false, onIterationStart = null, onLimitReached = null,
        configureSession = true, onEvent: providedOnEvent = null,
        journal = null, journalBoundary = null, contextProcessors = null,
        sessionPolicy = null, promptCache = null,
    } = d;

    // A5 — the handoff is validated once, here, instead of each module reading
    // the raw object and re-inventing the defaults.
    const handoff = rawHandoff == null ? null : normalizeHandoff({ handoff: rawHandoff });
    const goal = handoff?.goal ?? 'full';
    const session = providedSession ?? createSession({ client, model, sessionId });
    const provider = session.provider;
    if (journal) session._journal = journal;
    // The journal scope must ride the session: a subagent spawned from this
    // step reads `session._journalScope` (task.mjs) to build its own boundary.
    // Without it, sibling steps with the same profile/args share one key and
    // replay each other's tool results.
    if (journalBoundary) session._journalScope = journalBoundary;
    const toolsNone = handoff?.tools === 'none';
    if (configureSession) {
        // A6 — stripping the tools store is a session mutation, so it belongs
        // under the same flag as every other one: a caller-configured child
        // (task.mjs) has already decided its tools and must not be re-stripped.
        if (toolsNone) {
            if (Array.isArray(session._toolsStore)) session._toolsStore = [];
            session._capabilityTools?.delete('task');
        }
        if (sessionPolicy) applySessionPolicy({ session, policy: sessionPolicy });
        // 4.4 — prompt caching is a session policy like the rest: enabled by the
        // engine, applied only where the caller lets us configure the session.
        // `true` = defaults; a number = that many breakpoints; an object =
        // {points, type, ttl}.
        if (promptCache && typeof (/** @type {any} */ (session)).withPromptCache === 'function') {
            const policy = promptCache === true ? {} : (typeof promptCache === 'object' ? promptCache : { points: promptCache });
            (/** @type {any} */ (session)).withPromptCache(policy);
        }
        if (Array.isArray(contextProcessors) && contextProcessors.length > 0) {
            const existing = session._contextProcessors ?? [];
            const additions = contextProcessors.filter((p) => !existing.includes(p));
            if (additions.length > 0) session._contextProcessors = [...existing, ...additions];
        }
        adoptSessionId({ session, sessionId });
        applyApprovalPolicy({ session, policy: approvalPolicy });
        if (!session._circuitBreaker) {
            session.withCircuitBreaker?.({ breaker: getCircuitBreaker({ client, key: circuitKey({ provider, model }) }) });
        }
        if (agentContext && goal !== 'clean') session._agentContext = agentContext;

        session.withSystemMessage(systemPrompt ?? '');
        // A5 — a handoff tool list is a decision, not decoration: it used to be
        // validated and then ignored here, so `handoff.tools: [...]` silently did
        // nothing while the deps list won. 'inherit'/undefined keep the deps list.
        const sessionTools = resolveHandoffTools({ handoff, fallback: tools }) ?? [];
        if (!toolsNone && sessionTools.length > 0) session.withTools({ tools: sessionTools });
        if (capabilities && !toolsNone) {
            if (capabilities.skills) {
                session.withSkills?.({ skills: capabilities.skills, options: { preload: capabilities.skillsPreload ?? false } });
            }
            if (capabilities.memoryProvider) session.withMemory({ provider: capabilities.memoryProvider, options: capabilities.memoryOptions });
            if (capabilities.todoStore) {
                session.withTodos({ store: capabilities.todoStore, options: capabilities.todoOptions });
                if (capabilities.parallelToolCalls) {
                    session.withParameters({ params: (/** @type {any} */ b) => b.parallelToolCalls({ v: true }) });
                }
            }
        }
    }

    // A background delegation's result must reach the parent's NEXT turn. The
    // loop owns `_lastStepMessages`, so a row pushed into it mid-run is lost;
    // the result waits here instead and is drained into the initial input.
    // Peeked, not consumed: a turn that throws must not lose a queued result.
    // They precede the new prompt — they belong to the previous turn.
    const pending = Array.isArray(/** @type {any} */ (session)._pendingInputRows)
        ? [.../** @type {any} */ (session)._pendingInputRows]
        : [];
    // A notification belongs to the turn that just ended: after the history and
    // before the new prompt. With no history it folds into the prompt instead
    // (a request must not start with an assistant row) — see pending-inbox.mjs.
    const messagesRow = interleavePendingRows({
        rows: assembleMessagesRow({ explicitMessages, priorMessages, userText, verifyFeedback, provider }),
        pending,
    });
    
    /** @type {any} */
        let signature = null;
    /** @param {{name: *, payload: *}} arg0 */
    /** @param {{name: *, payload: *}} arg0 */
    const emitFn = (/** @type {(args: { name: string, payload: any }) => void} */ (({ name, payload }) => {
        if (emitter && runContext) runContext.emit({ emitter, name, payload });
        else if (emitter) emitter.emit(name, payload);
        if (events?.thoughtSignature && name === events.thoughtSignature) signature = payload.signature || signature;
    }));
    const onEvent = providedOnEvent ?? (events
        ? (toolEvents
            ? forwardToolEvents({ emit: emitFn, textEvent: events.text, thoughtEvent: events.thought, toolStartEvent: events.toolStart, toolEndEvent: events.toolEnd, thoughtSignatureEvent: events.thoughtSignature, makePayload: events.makePayload })
            : forwardStreamEvents({ emit: emitFn, textEvent: events.text, thoughtEvent: events.thought, makePayload: events.makePayload, thoughtSignatureEvent: events.thoughtSignature, streamEndEvent: events.streamEnd }))
        : null);

    // The transcript the step COMMITS is owned by the loop that ran it
    // (`agentic-core` writes it after every turn). Clearing the field before the
    // run is what keeps the fallback below alive for a session that honours the
    // documented `step()` contract but never touches this private field — and
    // it stops a reused session from replaying the previous run's rows.
    (/** @type {any} */ (session))._lastRunUsage = null;
    (/** @type {any} */ (session))._lastStepMessages = null;
    (/** @type {any} */ (session))._lastRunText = null;
    (/** @type {any} */ (session))._lastRunFinishReason = null;
    (/** @type {any} */ (session))._lastRunTruncated = false;
    (/** @type {any} */ (session))._lastRunTruncatedBy = null;
    (/** @type {any} */ (session))._lastRunContentFiltered = false;
    (/** @type {any} */ (session))._lastRunFallbackKind = null;
/**
 * D6: a step's session may restate the objective before a model call and write to
 * the step's view. The view isolates `refs`/`metadata`, but the objective is the
 * run's: adopt the restatement back so the steps after it see the new version.
 * @param {{agentContext: any}} arg0
 */
function absorbStepObjective({ agentContext }) {
    const view = agentContext;
    if (!view?._isStepView || !view.parent || typeof view.parent.absorbObjective !== 'function') return;
    try {
        view.parent.absorbObjective({ from: view });
    } catch {
        // A context merge must never turn a step into a failure.
    }
}

    // The gate is attached BEFORE any mutation: a foreign derived gate throws,
    // and that must not leave the inbox claimed or the session altered.
    // A session that already carries the same gate (withDecisionGate) is not
    // wrapped twice.
    // A direct runStep on a withDecisionGate session uses the session gate too.
    const effectiveGate = decisionGate ?? /** @type {any} */ (session)._decisionGate ?? null;
    const sessionGate = effectiveGate
        ? (/** @type {any} */ (session)._decisionGate === effectiveGate ? effectiveGate : attachDecisionUsage({ session, gate: effectiveGate }))
        : null;
    // A per-step sink: a session-wide accumulator would overlap when two steps
    // of one group run concurrently. Each step counts only its own calls.
    // `cost` is `null` once one of them reported no price (G3-6).
    /** @type {{tokens: number, cost: number|null}} */
    const decisionSink = { tokens: 0, cost: 0 };
    const stepGate = sessionGate && typeof sessionGate.withUsage === 'function'
        ? sessionGate.withUsage({ onUsage: (/** @type {{usage: any, stateChars?: number}} */ event) => {
            const counted = decisionTokensFromEvent(event);
            decisionSink.tokens += counted.tokens;
            decisionSink.cost = counted.cost === null || decisionSink.cost === null ? null : decisionSink.cost + counted.cost;
        } })
        : sessionGate;
    // The inbox is CLAIMED before the run (not cleared after it): `session.run`
    // drains the same inbox, so leaving the rows in place made it interleave
    // them a second time. A failed turn puts them back, so nothing is lost, and
    // a result that lands DURING the turn was never part of this claim.
    claimInboxRows({ session, rows: pending, onClaim: (/** @type {any} */ row) => emitEvent({
        emitter,
        name: EVENTS.SESSION.INPUT_DELIVERED,
        payload: { inboxId: row?.merciId ?? null, delivery: row?.delivery ?? null },
        runContext
    }) });
    /** @type {any} */
    let result;
    try {
        result = await enterPhase({ ctx: { emitter, runContext }, phase: PHASES.STEP, fn: () => session.run({ initialInput: messagesRow, options: {
        maxIterations,
        signal,
        followUp,
        runContext,
        ...(budget ? { budget } : {}),
        ...(stepGate ? { decisionGate: stepGate } : {}),
        ...(autoExtend ? { autoExtend } : {}),
        ...(errorHandlers ? { errorHandlers } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(onIterationStart ? { onIterationStart } : {}),
        ...(onLimitReached ? { onLimitReached } : {}),
        ...(journalBoundary ? { boundaryPrefix: journalBoundary } : {}),
        // The journal rides the RUN options too: a session the engine reuses can
        // carry an older `_journal`, and the loop must charge the one whose sink
        // is attached (G1-1).
        ...(journal ? { journal } : {}),
    } }) });
    } catch (err) {
        restoreInboxRows({ session, rows: pending });
        absorbStepObjective({ agentContext });
        // A failed attempt still spent tokens. Attach the session's usage to the
        // error so the caller's ledger can charge it: the DAG reads
        // `session._lastRunUsage` on its own throw path, the state machine had no
        // way to see it and silently under-charged every thrown node.
        if (err && typeof err === 'object') {
            // A separate field, never `err.usage`: the loop already puts the FAILED
            // STEP's usage on the error, and a budget error carries the POOL's total
            // there — overwriting it made a child report its own 50 instead of the
            // tree's 110. `runUsage` is the whole attempt (it spans iterations and
            // retries), which is what a caller's ledger must charge.
            const runUsage = mergeRunUsage({
                usage: /** @type {any} */ (session)._lastRunUsage ?? null,
                decisionTokens: decisionSink.tokens,
                decisionCost: decisionSink.cost,
            });
            if (runUsage) {
                try { /** @type {any} */ (err).runUsage = runUsage; } catch { /* non-extensible: keep the original error */ }
            }
        }
        throw err;
    }
    absorbStepObjective({ agentContext });

    const finalMessages = /** @type {any} */ (session)._lastStepMessages;
    const messages = Array.isArray(finalMessages) && finalMessages.length > 0
        ? finalMessages
        : [...messagesRow, createAssistantMessage({ provider, content: result, thoughtSignature: signature })];

    // The rows THIS step contributed as a conversation turn (D1): everything
    // after the rows it received from its upstream — i.e. its own prompt row
    // plus its answer — never the cumulative `messages`, which already holds
    // every upstream unit. Replaying that made a 3-node chain send 7 rows where
    // 5 suffice. The prompt row is part of the unit on purpose: a unit that
    // carried only the answer would make the downstream history start with an
    // assistant row (a prefill on Anthropic, a rejected shape on Gemini).
    // Matched by identity (or `merciId`) only: a session that rewrote its
    // history (compaction) must not have that rewritten prefix sliced off.
    const deltaBase = (Array.isArray(explicitMessages) && explicitMessages.length > 0)
        ? explicitMessages
        : priorMessages;
    const samePrefix = messages.length >= deltaBase.length && deltaBase.every((/** @type {any} */ row, /** @type {number} */ i) => {
        const got = messages[i];
        if (got === row) return true;
        const id = row?.[MERCI_ID_KEY];
        return id != null && got?.[MERCI_ID_KEY] === id;
    });
    const deltaMessages = samePrefix ? messages.slice(deltaBase.length) : messages;

    const usage = mergeRunUsage({
        usage: /** @type {any} */ (session)._lastRunUsage ?? null,
        decisionTokens: decisionSink.tokens,
        decisionCost: decisionSink.cost,
    });
    return { result, messages, deltaMessages, signature, provider, usage };
}
