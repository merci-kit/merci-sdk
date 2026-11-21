// @ts-check


/**
 * @file Unified event layer for the Merci SDK.
 * @version 0.12.0
 *
 * @description
 * Every event the SDK emits — on the client emitter, on orchestrator
 * EventEmitters (DiscussionSession / StateMachine / WorkflowExecutor), or
 * through the runAgenticLoop onEvent stream — is an SDKEvent envelope with
 * correlation fields, and its name is defined once in the EVENTS registry
 * instead of being scattered as string literals.
 *
 * Envelope (stamped by RunContext.emit / stampEvent):
 *   { event, runId, parentRunId, sessionId?, ts, ...domainPayload }
 *
 *   - event       canonical name from EVENTS
 *   - runId       correlation id of the emitting execution (per run()/step()/
 *                 orchestrator invocation; LangGraph run_id parity)
 *   - parentRunId the runId of the enclosing execution (LangGraph parent_ids
 *                 parity) — null when the emitter is the run root
 *   - sessionId   the conversation id of the owning session, when the context
 *                 carries one (additive; absent when none is set)
 *   - ts          epoch milliseconds of emission (AutoGen created_at parity)
 *
 * Exception: the client-level 'error' event keeps its raw Error payload —
 * it is the Node convention (throw-compatible) and subscribers read
 * `err.message` off the payload itself. It is still listed in EVENTS.
 *
 * The onEvent stream keeps its `{ type, ... }` contract and gains the two
 * additive correlation fields `runId` and `ts` (see stampStreamEvent).
 *
 * All payloads are JSON-serializable plain objects, with one documented
 * exception: the client 'error' event carries the raw Error (Node
 * convention). The HITL gates (workflow:hitl_pending /
 * workflow:hitl_iteration_limit) carry a serializable { approvalId,
 * timeoutMs, ... } handle — resolve them via
 * executor.resolveApproval(approvalId, approved, details).
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';


/**
 * Ambient correlation store. `runWithRunContext(ctx, fn)` installs a
 * RunContext for the duration of `fn` (including across awaits and child
 * generators); every `emitEvent`/`stampEvent` inside then correlates
 * automatically instead of relying on a manually threaded parameter.
 * @type {AsyncLocalStorage<RunContext|null>}
 */
const runContextStore = new AsyncLocalStorage();


/**
 * Canonical event-name registry. Every string the library emits lives here —
 * emit sites reference the constant, never a literal. Frozen at all depths.
 * @type {Record<string, Record<string, string>>}
 *
 * Payload contracts (all JSON-serializable):
 *  - api_request     { url?, method?, body?, headers?, model?, messages?, params?, contents?, config?, provider }
 *  - api_response    { url?, status, ok, headers?, model?, durationMs? }
 *  - api_retry       { vendor?, attempt, nextDelayMs, error, reason? } — error is a
 *                    plain { name, message, status? } object (JSON-safe)
 *  - parameter_warning { model, parameter, message, provider, standard }
 *  - tool_start      { calls, runId }   /   tool_finish { results, runId }
 *  - tool_warning    { message }
 *  - agent_changed   { from, to }
 *  - warning         { code?, message }
 *  - token_refresh_start {} / token_refresh_success { ok } / token_refresh_failure { status?, message }
 *  - run:start       { provider, model } / run:end { finishReason (stop|length|empty|schema|content_filtered|max_turns|budget|error|aborted), failureClass?, usage, durationMs, steps, truncated }
 *  - run:iteration_start { iteration, globalIteration, maxIterations }
 *  - aborted         { reason }
 *  - session:start   { provider, model }
 *  - session:step_start { messageCount } / session:step_end { done, toolCalls, truncated?, error?, contentLength? }
 *  - session:stream_timeout { message, partialLength? }
 *  - session:params_filtered { profile, omitted: string[] }
 *  - stream:first_token { provider, model, latencyMs }
 *  - stream:parse_error { message, linePreview? }
 *  - embed_start { model, inputLen } / embed_finish { model, inputLen, vectorLen?, durationMs, retries }
 *    / embed_error { model, inputLen, durationMs, retries, error } — a hard embed failure (graceful
 *    unsupported-endpoint returns still finish via embed_finish).
 *  - api_stream_start { model, provider } / api_stream_end { model, provider, durationMs, status } —
 *    the step-scoped vendor stream consumption (one pair per step; retries may span several wire streams).
 *  - task:start/finish/error { subagent_type, description, background?, id?, result?/error? }
 *  - task:fallback { subagent_type, fallbackModel, error } / task:hedge { subagent_type, hedgeAfterMs }
 *  - task:background_started { id, subagent_type }
 *  - plan:exit_requested { planPath } / plan:exit_resolved { planPath, approved, timedOut?, details? }
 *  - plan:patched { ops, reason, verdict, applied?, rejected?, rewired?, noop?, capped? } — the plan
 *    evaluator edited the guiding plan; `ops` is what it asked for, `applied` what landed,
 *    `rewired` the dependents a declared `replaces` moved onto the replacement.
 *  - plan:settled { verdict, reason, trigger, pending } — the evaluator declared the plan
 *    finished; `pending` names the nodes it decided not to run.
 *  - memory:distill_start { deltaTurns, model } / memory:distill_success { newFacts, obsoleteFacts, fromTurn, toTurn, model }
 *    / memory:distill_error { error, model?, provider? } / memory:injected { factCount }
 *  - memory:fact_added { id, content, category, targetBanks } / memory:fact_obsolete { id }
 *  - web_search:start { query, provider, mode } / :success { query, provider, mode,
 *    resultCount, sources, durationMs } / :error { query, provider, mode, durationMs, error } —
 *    emitted by WebSearchComponent around each tool-leg search.
 *  - web_scrape:start { url, provider, mode } (one per requested URL) /
 *    :success { url, provider, mode, chars, truncated, durationMs, error? } (one per
 *    result; error is a per-item field present on partial failure — not a separate
 *    error event) / :error { provider, mode, durationMs, error } (batch-level only;
 *    no url) — emitted by WebScrapeComponent around each tool-leg scrape.
 *  - browser:navigate_start { url, provider, mode } (one per requested URL) /
 *    :success { url, provider, mode, chars, truncated, durationMs, error? } (one per
 *    result) / :error { provider, mode, durationMs, error } (batch-level only;
 *    no url) — emitted by BrowserComponent around each tool-leg navigation.
 *  - browser:interact_start { action, provider, mode } /
 *    :success { action, provider, mode, url?, durationMs } /
 *    :error { action, provider, mode, durationMs, error } — emitted by
 *    BrowserComponent around each interactive (Playwright) action.
 *  - session:store_saved { threadId, path } / :loaded { threadId, messageCount? } / :miss { threadId }
 *  - session:checkpoint_saved { threadId, path? } / :loaded { threadId }
 *  - context:instructions_loaded { root, stopAt, files, chars }
 *  - artifact:saved { name, path, bytes }
 *  - todo:changed { action, taskId, status? }
 *  - cli:command { command, kind }
 *  - error:thrown { code, name, message, context? }
 *  - event:listener_error { sourceEvent, error } — a throwing event listener never
 *    breaks a run; it is surfaced here instead.
 *  - event:unhandled { event } — opt-in (`new MerciEventEmitter({ strict: true })`): an
 *    event with zero matching listeners, so a mistyped name or a missing subscriber is visible.
 *  - api_error { name, message, code? } — JSON-safe projection of a thrown vendor error.
 *  - session:params_applied { model, provider, keys } / session:step_error { name, message, code? } /
 *    session:step_timeout { timeoutMs, message } / session:history_compacted { dropped, summarized }
 *  - phase:start { phase } / phase:end { phase, durationMs, status, error? } — the uniform
 *    lifecycle umbrella (`enterPhase`); one shape for every unit (run/step/workflow).
 *  - run:iteration_end { iteration, globalIteration, maxIterations, steps, hadToolRound }
 *  - context:processor_applied { name, order, messages, contextParts } / context:processor_error { name, order, error }
 *  - todo:loaded { filePath, taskCount } / artifact:save_error { name, error }
 *  - workflow:run_resumed { globalObjective, steps, replanCount }
 *  - tool:round_start { count } / tool:round_end { count, durationMs, okCount, failCount }
 *  - tool:call_start { id, name, args } / tool:call_end { id, name, success, durationMs, error? }
 *  - tool:error { id, name, error } / tool:not_found { id, name } /
 *    tool:output_truncated { id, name, inLen, outLen } (string results only)
 *  - tool:approval_requested { id, name, args } / :granted { id, name } /
 *    :denied { id, name, reason, timedOut? } — the generic per-tool HITL gate
 *    (shell tools keep their own shell:approval_* events).
 *  - shell:approval_requested { command, args } / :granted / :denied { command, args, reason? }
 *  - shell:blocked { command } / shell:command_start { command, args } / shell:command_end { command, args, exitCode, truncated?, durationMs }
 *  - mcp:server_start { command, args, era, protocolVersion } (or { url, protocol, era, protocolVersion })
 *    / mcp:server_error { error } / mcp:server_stop {} / mcp:tools_fetched { count }
 *  - mcp:call_start { name } / mcp:call_end { name, durationMs } / mcp:call_error { name, error, durationMs }
 *  - a2a:card_loaded { url, toolCount } / a2a:card_error { url, error }
 *  - a2a:delegate_start { url, method, id } / :end { url, method, id, ok } / :error { url, method, id?, error } / :timeout { url, method, id }
 *  - skills:loaded { count, names } / skills:load_error { dir, error }
 *  - tool:path_denied { path, reason }
 *  - loadable:load / loadable:save { id, toolName, ok, error? }
 *  - scheduler:start { pollIntervalMs, concurrency, activeStates, terminalStates } /
 *    stop { reason, running, retrying, parked, drained } /
 *    tick { outcome, fetched, dispatched, running, retrying, parked, claimed } /
 *    validation_error { errors } / work_source_error { op, category } /
 *    internal_error { op, errorName, errorCode } / configured { source, changed }
 *  - work_item:skipped { source, index, file, reason } /
 *    claimed { workItemId, identifier, attempt, owner } /
 *    claim_failed { workItemId, identifier, reason } /
 *    dispatched { workItemId, identifier, attempt, lane, state, priority, runId } /
 *    completed { workItemId, identifier, attempt, durationMs, usage } /
 *    failed { workItemId, identifier, attempt, failureClass, errorName, errorCode } /
 *    released { workItemId, identifier, reason }
 *  - discussion:* — see discussion-session.mjs; workflow:* — see executor.mjs;
 *    state_machine:* — see machine.mjs (payloads documented inline there).
 *  - onEvent stream types (EVENTS.STEP): text { content }, thought { content },
 *    thought_signature { signature }, quota { data }, tool_calls { calls },
 *    tool_request { calls, thoughtSignature }, tool_call_start { name, args },
 *    tool_call_end { name, result }, stream_end {}, compaction { dropped, summarized },
 *    truncated {}, schema_validation_failed { error, content }, error { error_message,
 *    error_type } (mid-stream vendor errors — forwarded raw).
 */
export const EVENTS = Object.freeze({
    CLIENT: Object.freeze({
        API_REQUEST: 'api_request',
        API_RESPONSE: 'api_response',
        API_RETRY: 'api_retry',
        API_ERROR: 'api_error',
        ERROR: 'error',
        WARNING: 'warning',
        PARAMETER_WARNING: 'parameter_warning',
        TOOL_START: 'tool_start',
        TOOL_FINISH: 'tool_finish',
        TOOL_WARNING: 'tool_warning',
        AGENT_CHANGED: 'agent_changed',
        TOKEN_REFRESH_START: 'token_refresh_start',
        TOKEN_REFRESH_SUCCESS: 'token_refresh_success',
        TOKEN_REFRESH_FAILURE: 'token_refresh_failure',
        RUN_START: 'run:start',
        RUN_END: 'run:end',
        RUN_ITERATION_START: 'run:iteration_start',
        RUN_ITERATION_END: 'run:iteration_end',
        OBJECTIVE_UPDATED: 'run:objective_updated',
        BUDGET_EXCEEDED: 'run:budget_exceeded',
        /** The USD budget could not be enforced: the backend reported no cost for the run. */
        BUDGET_UNREPORTED: 'run:budget_unreported',
        /** A capped turn's shared pool left it less than `step_min_output_tokens` (B-3). */
        BUDGET_STARVED: 'run:budget_starved',
        MAX_TURNS_EXTENDED: 'run:max_turns_extended',
        MAX_TURNS_EXCEEDED: 'run:max_turns_exceeded',
        ABORTED: 'aborted',
        SESSION_START: 'session:start',
        SESSION_STEP_START: 'session:step_start',
        SESSION_STEP_END: 'session:step_end',
        SESSION_STREAM_TIMEOUT: 'session:stream_timeout',
        SESSION_PARAMS_FILTERED: 'session:params_filtered',
        SESSION_PARAMS_APPLIED: 'session:params_applied',
        SESSION_STEP_ERROR: 'session:step_error',
        SESSION_STEP_TIMEOUT: 'session:step_timeout',
        SESSION_HISTORY_COMPACTED: 'session:history_compacted',
        EMBED_START: 'embed_start',
        EMBED_FINISH: 'embed_finish',
        EMBED_ERROR: 'embed_error',
        DECISIONS_START: 'decisions_start',
        DECISIONS_FINISH: 'decisions_finish',
        DECISIONS_ERROR: 'decisions_error',
        DECISION_GATE: 'decision_gate',
        STREAM_FIRST_TOKEN: 'stream:first_token',
        STREAM_PARSE_ERROR: 'stream:parse_error',
        API_STREAM_START: 'api_stream_start',
        API_STREAM_END: 'api_stream_end'
    }),
    STEP: Object.freeze({
        TEXT: 'text',
        THOUGHT: 'thought',
        THOUGHT_SIGNATURE: 'thought_signature',
        QUOTA: 'quota',
        TOOL_CALLS: 'tool_calls',
        TOOL_REQUEST: 'tool_request',
        TOOL_CALL_START: 'tool_call_start',
        TOOL_CALL_END: 'tool_call_end',
        STREAM_END: 'stream_end',
        COMPACTION: 'compaction',
        TRUNCATED: 'truncated',
        /** The provider's content moderation stopped the response (JAI PrematureEnd). */
        CONTENT_FILTERED: 'content_filtered',
        SCHEMA_VALIDATION_FAILED: 'schema_validation_failed',
        FIRST_TOKEN: 'first_token',
        // NOTE: the mid-stream vendor error type is the same canonical 'error'
        // string as EVENTS.CLIENT.ERROR (the registry forbids duplicate values);
        // reference EVENTS.CLIENT.ERROR where a stream error type is needed.
        REDACTED_THINKING: 'redacted_thinking',
        TOOL_CALL_DELTA: 'tool_call_delta',
        REASONING_ITEM: 'reasoning_item',
        THINKING_BLOCKS: 'thinking_blocks',
        THOUGHT_PARTS: 'thought_parts',
        FINISH: 'finish',
        /** The vendor's source citations for the answer (Gemini grounding, Anthropic citations). */
        CITATIONS: 'citations',
        PREMATURE_END: 'premature_end',
        RESTART: 'restart',
        UNKNOWN: 'unknown'
    }),
    TOOL: Object.freeze({
        ROUND_START: 'tool:round_start',
        ROUND_END: 'tool:round_end',
        CALL_START: 'tool:call_start',
        CALL_END: 'tool:call_end',
        OUTPUT_TRUNCATED: 'tool:output_truncated',
        ERROR: 'tool:error',
        NOT_FOUND: 'tool:not_found',
        PATH_DENIED: 'tool:path_denied',
        APPROVAL_REQUESTED: 'tool:approval_requested',
        APPROVAL_GRANTED: 'tool:approval_granted',
        APPROVAL_DENIED: 'tool:approval_denied'
    }),
    SHELL: Object.freeze({
        APPROVAL_REQUESTED: 'shell:approval_requested',
        APPROVAL_GRANTED: 'shell:approval_granted',
        APPROVAL_DENIED: 'shell:approval_denied',
        BLOCKED: 'shell:blocked',
        COMMAND_START: 'shell:command_start',
        COMMAND_END: 'shell:command_end'
    }),
    MCP: Object.freeze({
        SERVER_START: 'mcp:server_start',
        SERVER_ERROR: 'mcp:server_error',
        SERVER_STOP: 'mcp:server_stop',
        SERVER_RETRY: 'mcp:server_retry',
        TOOLS_FETCHED: 'mcp:tools_fetched',
        TOOLS_CHANGED: 'mcp:tools_changed',
        RESOURCES_FETCHED: 'mcp:resources_fetched',
        RESOURCE_READ: 'mcp:resource_read',
        PROMPTS_FETCHED: 'mcp:prompts_fetched',
        PROMPT_FETCHED: 'mcp:prompt_fetched',
        CALL_START: 'mcp:call_start',
        CALL_PROGRESS: 'mcp:call_progress',
        CALL_END: 'mcp:call_end',
        CALL_ERROR: 'mcp:call_error',
        TASK_STATUS: 'mcp:task_status'
    }),
    A2A: Object.freeze({
        CARD_LOADED: 'a2a:card_loaded',
        CARD_ERROR: 'a2a:card_error',
        DELEGATE_START: 'a2a:delegate_start',
        DELEGATE_END: 'a2a:delegate_end',
        DELEGATE_ERROR: 'a2a:delegate_error',
        DELEGATE_TIMEOUT: 'a2a:delegate_timeout',
        STREAM_UPDATE: 'a2a:stream_update'
    }),
    SKILLS: Object.freeze({
        LOADED: 'skills:loaded',
        LOAD_ERROR: 'skills:load_error'
    }),
    LOADABLE: Object.freeze({
        LOAD: 'loadable:load',
        SAVE: 'loadable:save'
    }),
    MEMORY: Object.freeze({
        DISTILL_START: 'memory:distill_start',
        DISTILL_SUCCESS: 'memory:distill_success',
        DISTILL_ERROR: 'memory:distill_error',
        INJECTED: 'memory:injected',
        FACT_ADDED: 'memory:fact_added',
        FACT_OBSOLETE: 'memory:fact_obsolete'
    }),
    WEB_SEARCH: Object.freeze({
        SEARCH_START: 'web_search:start',
        SEARCH_SUCCESS: 'web_search:success',
        SEARCH_ERROR: 'web_search:error'
    }),
    WEB_SCRAPE: Object.freeze({
        SCRAPE_START: 'web_scrape:start',
        SCRAPE_SUCCESS: 'web_scrape:success',
        SCRAPE_ERROR: 'web_scrape:error'
    }),
    BROWSER: Object.freeze({
        NAVIGATE_START: 'browser:navigate_start',
        NAVIGATE_SUCCESS: 'browser:navigate_success',
        NAVIGATE_ERROR: 'browser:navigate_error',
        INTERACT_START: 'browser:interact_start',
        INTERACT_SUCCESS: 'browser:interact_success',
        INTERACT_ERROR: 'browser:interact_error'
    }),
    TASK: Object.freeze({
        START: 'task:start',
        FINISH: 'task:finish',
        ERROR: 'task:error',
        FALLBACK: 'task:fallback',
        HEDGE: 'task:hedge',
        BACKGROUND_STARTED: 'task:background_started',
        FORK_DEGRADED: 'task:fork_degraded'
    }),
    PLAN: Object.freeze({
        EXIT_REQUESTED: 'plan:exit_requested',
        EXIT_RESOLVED: 'plan:exit_resolved',
        PATCHED: 'plan:patched',
        SETTLED: 'plan:settled'
    }),
    SESSION: Object.freeze({
        STORE_SAVED: 'session:store_saved',
        STORE_LOADED: 'session:store_loaded',
        STORE_MISS: 'session:store_miss',
        STORE_CORRUPT: 'session:store_corrupt',
        STORE_FORK: 'session:store_fork',
        CHECKPOINT_SAVED: 'session:checkpoint_saved',
        CHECKPOINT_LOADED: 'session:checkpoint_loaded',
        INPUT_ENQUEUED: 'session:input_enqueued',
        INPUT_DELIVERED: 'session:input_delivered',
        INPUT_CANCELLED: 'session:input_cancelled',
        INPUT_DELIVERY_CHANGED: 'session:input_delivery_changed'
    }),
    CONTEXT: Object.freeze({
        INSTRUCTIONS_LOADED: 'context:instructions_loaded',
        PROCESSOR_APPLIED: 'context:processor_applied',
        PROCESSOR_ERROR: 'context:processor_error'
    }),
    ARTIFACT: Object.freeze({
        SAVED: 'artifact:saved',
        SAVE_ERROR: 'artifact:save_error'
    }),
    TODO: Object.freeze({
        CHANGED: 'todo:changed',
        LOADED: 'todo:loaded'
    }),
    CLI: Object.freeze({
        COMMAND: 'cli:command'
    }),
    ERRORS: Object.freeze({
        THROWN: 'error:thrown',
        LISTENER_ERROR: 'event:listener_error',
        UNHANDLED: 'event:unhandled'
    }),
    PERMISSIONS: Object.freeze({
        /** `bypassPermissions` was enabled — every gated tool is approved without asking. */
        BYPASS: 'permissions:bypass'
    }),
    GUARDRAIL: Object.freeze({
        /** A guardrail matched; `{ rule, phase, action, blocked }` says which one and what it did. */
        TRIPPED: 'guardrail:tripped'
    }),
    WORKSPACE: Object.freeze({
        /** `{ workItemId, key, path, strategy, branch, createdNow: true }` — a workspace directory was created. */
        CREATED: 'workspace:created',
        /** `{ workItemId, key, path, strategy, branch, createdNow: false }` — an existing workspace was reused. */
        REUSED: 'workspace:reused',
        /** `{ workItemId, key, path, strategy, forced }` — the workspace directory was removed. */
        REMOVED: 'workspace:removed',
        /** `{ workItemId, key, path, reason }` — removal was refused (in_use, not_empty, missing). */
        REMOVE_REFUSED: 'workspace:remove_refused',
        /** `{ workItemId, key, path, hook }` — a lifecycle hook started. Never carries the script text. */
        HOOK_STARTED: 'workspace:hook_started',
        /** `{ workItemId, key, hook, durationMs, exitCode }` — a lifecycle hook exited 0. */
        HOOK_FINISHED: 'workspace:hook_finished',
        /** `{ workItemId, key, hook, durationMs, exitCode, timedOut, fatal }` — a hook failed; never carries stderr. */
        HOOK_FAILED: 'workspace:hook_failed',
        /** `{ workItemId, key, path, reason }` — a handle or target path was refused before any IO. */
        PATH_REJECTED: 'workspace:path_rejected'
    }),
    WORKFLOW_POLICY: Object.freeze({
        /** `{ path, source: 'startup', promptChars, warnings }` — the startup load succeeded. */
        LOADED: 'workflow_policy:loaded',
        /** `{ path, promptChars, changed: true }` — a reload applied a new config/prompt. */
        RELOADED: 'workflow_policy:reloaded',
        /** `{ path, reasons }` — a reload failed; the last good config is kept. */
        RELOAD_FAILED: 'workflow_policy:reload_failed',
        /** `{ path, reasons }` — the startup load failed; the host may retry after a fix. */
        LOAD_FAILED: 'workflow_policy:load_failed',
        /** `{ path, reason }` — the file watcher failed; the policy is degraded, not unhealthy. */
        WATCH_FAILED: 'workflow_policy:watch_failed',
        /** `{ reason, field }` — one prompt render failed; the stored AST is kept. */
        RENDER_FAILED: 'workflow_policy:render_failed'
    }),
    SCHEDULER: Object.freeze({
        /** `{ pollIntervalMs, concurrency, activeStates, terminalStates }` — the loop is armed. */
        START: 'scheduler:start',
        /** `{ reason, running, retrying, parked, drained }` — the loop stopped. */
        STOP: 'scheduler:stop',
        /** `{ outcome, fetched, dispatched, running, retrying, parked, claimed }` — one per tick path. */
        TICK: 'scheduler:tick',
        /** `{ errors: string[] }` — config or preflight blocked dispatch for this tick. */
        VALIDATION_ERROR: 'scheduler:validation_error',
        /** `{ op, category }` — a work-source call failed; the category is diagnostic. */
        WORK_SOURCE_ERROR: 'scheduler:work_source_error',
        /** `{ limit, totals }` — an aggregate budget stopped new dispatch; sent once per scheduler lifetime, never for a running attempt. `totals` is `{ inputTokens, outputTokens, totalTokens, costUsd, dispatches, attempts, failures, usageComplete, costComplete }`. */
        BUDGET_EXHAUSTED: 'scheduler:budget_exhausted',
        /** `{ op, errorName, errorCode }` — a contained scheduler failure; never carries a message. */
        INTERNAL_ERROR: 'scheduler:internal_error',
        /** `{ source, changed }` — a live configuration patch was applied. */
        CONFIGURED: 'scheduler:configured'
    }),
    WORK_ITEM: Object.freeze({
        /** `{ source, index, file, reason }` — a work-source record was skipped as malformed, duplicated, or unsafe (the file name cannot name an id on every platform). */
        SKIPPED: 'work_item:skipped',
        /** `{ workItemId, identifier, attempt, owner }` — the claim transitioned to this owner. */
        CLAIMED: 'work_item:claimed',
        /** `{ workItemId, identifier, reason }` — the claim was not acquired (`not_acquired` or `error`). */
        CLAIM_FAILED: 'work_item:claim_failed',
        /** `{ workItemId, identifier, attempt, lane, state, priority, runId }` — one attempt started. */
        DISPATCHED: 'work_item:dispatched',
        /** `{ workItemId, identifier, attempt, delayMs }` — a clean completion scheduled a continuation retry; the claim is kept. */
        CONTINUED: 'work_item:continued',
        /** `{ workItemId, identifier, attempt, delayMs, dueAtMs, failureClass }` — a failure retry is queued; `failureClass` is null for a source-error or no-slot re-queue. */
        RETRY_SCHEDULED: 'work_item:retry_scheduled',
        /** `{ workItemId, identifier, attempt, idleMs }` — the stall watchdog aborted an attempt; never carries a message. */
        STALLED: 'work_item:stalled',
        /** `{ workItemId, identifier, reason, cleanup }` — reconciliation terminated the attempt; `cleanup` is the workspace intent. */
        RECONCILED: 'work_item:reconciled',
        /** `{ workItemId, identifier, attempt, durationMs, usage }` — the item finished on a completed attempt (no continuation scheduled; `usage` is numeric only). */
        COMPLETED: 'work_item:completed',
        /** `{ workItemId, identifier, attempt, failureClass, errorName, errorCode }` — the item stopped retrying and parked; never carries a message. */
        FAILED: 'work_item:failed',
        /** `{ workItemId, identifier, reason }` — the claim was released (`terminal`, `inactive`, `unroutable`, `missing`, `reset`, `claim_failed`, `settle_error`, or the `stop()` reason). */
        RELEASED: 'work_item:released',
        /** `{ workItemId, identifier, reason, attempts, continuations, nextCheckAt }` — the item is parked with its claim held and will be re-checked. */
        PARKED: 'work_item:parked',
        /** `{ workItemId, identifier, reason }` — a terminal workspace cleanup was refused (`dirty`, `not_empty`, `in_use`, `unreachable_head`); the workspace is retained, never forced. */
        WORKSPACE_CLEANUP_REFUSED: 'work_item:workspace_cleanup_refused'
    }),
    PHASE: Object.freeze({
        START: 'phase:start',
        END: 'phase:end'
    }),
    HOOKS: Object.freeze({
        /** A `request:before` hook chain ran; `{ changed, vetoed, hooks }` records whether it transformed or short-circuited the vendor request. */
        REQUEST_BEFORE: 'hook:request_before',
        /** A `request:after` hook chain ran; `{ hooks, durationMs, ok }` records the round trip. */
        REQUEST_AFTER: 'hook:request_after'
    }),
    DISCUSSION: Object.freeze({
        AGENT_START: 'discussion:agent_start',
        AGENT_TEXT: 'discussion:agent_text',
        AGENT_THOUGHT: 'discussion:agent_thought',
        AGENT_THOUGHT_SIGNATURE: 'discussion:agent_thought_signature',
        TOOL_CALL_START: 'discussion:tool_call_start',
        TOOL_CALL_END: 'discussion:tool_call_end',
        AGENT_PASS: 'discussion:agent_pass',
        AGENT_FINISH: 'discussion:agent_finish',
        AGENT_ERROR: 'discussion:agent_error',
        TURN_START: 'discussion:turn_start',
        TURN_END: 'discussion:turn_end',
        TERMINATED: 'discussion:terminated',
        REPLAN: 'discussion:replan',
        JUDGED: 'discussion:judged',
        DAG_ORDER: 'discussion:dag_order',
        LEDGER_ENTRY: 'discussion:ledger_entry',
        LEDGER_PRUNED: 'discussion:ledger_pruned',
        VERIFY_START: 'discussion:verify_start',
        VERIFY_PASS: 'discussion:verify_pass',
        VERIFY_FAIL: 'discussion:verify_fail',
        VERIFY_RETRY: 'discussion:verify_retry'
    }),
    STATE_MACHINE: Object.freeze({
        NODE_ADDED: 'state_machine:node_added',
        NODE_REMOVED: 'state_machine:node_removed',
        EDGE_ADDED: 'state_machine:edge_added',
        EDGE_REMOVED: 'state_machine:edge_removed',
        PLANNED: 'state_machine:planned',
        START: 'state_machine:start',
        DONE: 'state_machine:done',
        ERROR: 'state_machine:error',
        FAILED: 'state_machine:failed',
        COMPLETED: 'state_machine:completed',
        REPLAN_REQUIRED: 'state_machine:replan_required',
        REPLAN_ATTEMPT: 'state_machine:replan_attempt',
        CYCLE_LIMIT: 'state_machine:cycle_limit',
        NODE_START: 'state_machine:node_start',
        NODE_END: 'state_machine:node_end',
        NODE_ERROR: 'state_machine:node_error',
        NODE_TEXT: 'state_machine:node_text',
        NODE_THOUGHT: 'state_machine:node_thought',
        NODE_THOUGHT_SIGNATURE: 'state_machine:node_thought_signature',
        NODE_STREAM_END: 'state_machine:node_stream_end',
        VERIFY_START: 'state_machine:verify_start',
        VERIFY_PASS: 'state_machine:verify_pass',
        VERIFY_FAIL: 'state_machine:verify_fail',
        VERIFY_RETRY: 'state_machine:verify_retry',
        NO_PROGRESS: 'state_machine:no_progress',
        ESCALATED: 'state_machine:escalated',
        LOAD_RESUMED: 'state_machine:load_resumed',
        CONDITION_EVAL_ERROR: 'state_machine:condition_eval_error'
    }),
    WORKFLOW: Object.freeze({
        START: 'workflow:start',
        RUN_RESUMED: 'workflow:run_resumed',
        END: 'workflow:end',
        FAILED: 'workflow:failed',
        STEP_START: 'workflow:step_start',
        STEP_COMPLETE: 'workflow:step_complete',
        STEP_ERROR: 'workflow:step_error',
        STEP_ITERATION: 'workflow:step_iteration',
        STEP_TEXT: 'workflow:step_text',
        STEP_THOUGHT: 'workflow:step_thought',
        STEP_THOUGHT_SIGNATURE: 'workflow:step_thought_signature',
        STEP_STREAM_END: 'workflow:step_stream_end',
        STEP_NODE_START: 'workflow:step_node_start',
        STEP_NODE_END: 'workflow:step_node_end',
        STEP_VERIFY_START: 'workflow:step_verify_start',
        STEP_VERIFY_PASS: 'workflow:step_verify_pass',
        STEP_VERIFY_FAIL: 'workflow:step_verify_fail',
        LISTENER_ERROR: 'workflow:listener_error',
        STEPS_DROPPED: 'workflow:steps_dropped',
        STEP_VERIFY_RETRY: 'workflow:step_verify_retry',
        STEP_NO_PROGRESS: 'workflow:step_no_progress',
        STEP_ESCALATED: 'workflow:step_escalated',
        STEP_CYCLE_LIMIT: 'workflow:step_cycle_limit',
        STEP_TURN_START: 'workflow:step_turn_start',
        STEP_TURN_END: 'workflow:step_turn_end',
        STEP_AGENT_START: 'workflow:step_agent_start',
        STEP_AGENT_PASS: 'workflow:step_agent_pass',
        STEP_AGENT_ERROR: 'workflow:step_agent_error',
        STEP_AGENT_THOUGHT_SIGNATURE: 'workflow:step_agent_thought_signature',
        STEP_TOOL_CALL_START: 'workflow:step_tool_call_start',
        STEP_TOOL_CALL_END: 'workflow:step_tool_call_end',
        STEP_JUDGED: 'workflow:step_judged',
        STEP_TERMINATED: 'workflow:step_terminated',
        STEP_DAG_ORDER: 'workflow:step_dag_order',
        STEP_REPLAN: 'workflow:step_replan',
        HITL_PENDING: 'workflow:hitl_pending',
        HITL_TIMEOUT: 'workflow:hitl_timeout',
        HITL_ITERATION_LIMIT: 'workflow:hitl_iteration_limit',
        HITL_DECLINED: 'workflow:hitl_declined',
        STEP_GATE_REJECTED: 'workflow:step_gate_rejected',
        REPLAN_TRIGGERED: 'workflow:replan_triggered',
        REPLAN_LIMIT: 'workflow:replan_limit',
        VERIFICATION_SKIPPED: 'workflow:verification_skipped',
        VERIFICATION_DEFERRED: 'workflow:verification_deferred',
        TEMPLATE_WARNING: 'workflow:template_warning',
        RESTORE_WARNING: 'workflow:restore_warning',
        STEP_DECOMPOSED: 'workflow:step_decomposed',
        SESSION_GROUP: 'workflow:session_group',
        SESSION_BOUNDARY: 'workflow:session_boundary'
    })
});



/**
 * The run context — the identity (run id, parent run) every event of a run carries.
 * Per-execution correlation context. One instance per run()/step()/
 * orchestrator invocation; children stamp their parent's runId so a full
 * execution tree is reconstructible from any single event (LangGraph
 * run_id/parent_ids parity).
 * @param {{ctx?: { runId?: string|null, parentRunId?: string|null, sessionId?: string|null }}} arg0
 */
function baseStamp({ ctx = {} } = {}) {
    return {
        runId: ctx.runId ?? null,
        parentRunId: ctx.parentRunId ?? null,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ts: Date.now(),
    };
}
/**
 * The run context — the identity (run id, parent run) every event of a run
 * carries.
 */
export class RunContext {
    
    /**
 * @param {{runId?: string, parentRunId?: string|null, sessionId?: string|null}} arg0
 *   this execution belongs to (stamped on every wrapped event when set).
 */
        constructor({ runId = randomUUID(), parentRunId = null, sessionId = null } = {}) {
        this.runId = runId;
        this.parentRunId = parentRunId;
        this.sessionId = sessionId;
        // Internal bookkeeping (not public API): every ancestor run id, root
        // first. Budget admission uses it to ignore a reservation held by a
        // caller that is already blocked on this run (waiting there can only
        // deadlock — the ancestor releases only when this run returns).
        this._ancestorRunIds = /** @type {Array<string>} */ ([]);
    }

    
    /**
     * Creates a child context of `parentRunId` (a runId string or a RunContext).
     * The child inherits the parent context's sessionId when one is present.
     * @param {string|RunContext|null} parent
     * @returns {RunContext}
     */
        static child(parent) {
        if (parent instanceof RunContext) {
            const child = new RunContext({ parentRunId: parent.runId, sessionId: parent.sessionId });
            // Deduplicated so a repeated link (a retry re-parenting the same
            // run) cannot grow the list without bound.
            child._ancestorRunIds = [...new Set([...(parent._ancestorRunIds ?? []), parent.runId])];
            // The step id a step context carries is executor bookkeeping a tool may need
            // to name the node it runs for; a child context inherits it (N1).
            if (typeof (/** @type {any} */ (parent)._stepId) === 'string') /** @type {any} */ (child)._stepId = /** @type {any} */ (parent)._stepId;
            return child;
        }
        return new RunContext({ parentRunId: parent });
    }

    
    /**
     * Builds the stamped SDKEvent envelope.
     * @param {{name: string, payload?: Record<string, unknown>}} arg0 - Canonical event name (use EVENTS constants).
     * @returns {Record<string, unknown>} { ...payload, event, runId, parentRunId, sessionId?, ts }
     */
        wrap({ name, payload = {} }) {
        return { ...payload, event: name, ...baseStamp({ ctx: this }) };
    }

    
    /**
     * Emits the stamped envelope on an EventEmitter. Safe against bare
     * { emit } objects and null emitters (no throw, no unhandled 'error').
     * @param {{emitter: import('node:events').EventEmitter|null, name: string, payload?: Record<string, unknown>}} arg0 -
     */
        emit({ emitter, name, payload = {} }) {
        emitEvent({ emitter, name, payload, runContext: this });
    }
}


/**
 * Standalone envelope builder for emission points outside any RunContext
 * (parameter building, agent switching). Resolves the ambient RunContext from
 * AsyncLocalStorage when none is passed; runId is null when no context exists.
 * @param {{name: string, payload?: Record<string, unknown>, runContext?: RunContext|null}} arg0 - Canonical event name.
 * @returns {Record<string, unknown>} { ...payload, event, runId, parentRunId, sessionId?, ts }
 */
export function stampEvent({ name, payload = {}, runContext = null }) {
    const ctx = runContext instanceof RunContext ? runContext : currentRunContext();
    return buildEnvelope({ name, payload, ctx });
}


/**
 * Adds the additive correlation fields to an onEvent stream event
 * ({ type, ... }) without changing its shape contract.
 * @param {{event: Record<string, unknown>, runContext?: RunContext|null}} arg0 - Stream event ({ type: 'text', ... }).
 * @returns {Record<string, unknown>} { ...event, runId, ts }
 */
export function stampStreamEvent({ event, runContext = null }) {
    if (!event || typeof event !== 'object') return event;
    const ctx = runContext ?? currentRunContext();
    if (!ctx) return { ...event, ts: Date.now() };
    return {
        ...event,
        runId: ctx.runId,
        ts: Date.now(),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    };
}


/**
 * Builds the stamped SDKEvent envelope for a resolved context (or no context).
 * @param {{name: string, payload?: Record<string, unknown>, ctx?: RunContext|null}} arg0
 * @returns {Record<string, unknown>}
 */
function buildEnvelope({ name, payload = {}, ctx = null }) {
    if (ctx instanceof RunContext) return ctx.wrap({ name, payload });
    return { ...payload, event: name, ...baseStamp() };
}


/**
 * Installs `runContext` as the ambient correlation context for `fn`. Every
 * `emitEvent`/`stampEvent` executed inside (across awaits and child
 * generators) correlates automatically. Returns whatever `fn` returns.
 * @template T
 * @param {{runContext: RunContext|null, fn: () => T}} arg0
 * @returns {T}
 */
export function runWithRunContext({ runContext = null, fn }) {
    return runContextStore.run(runContext, fn);
}


/**
 * The ambient RunContext of the current async execution, or null outside a run.
 * @returns {RunContext|null}
 */
export function currentRunContext() {
    return runContextStore.getStore() ?? null;
}


/**
 * The single event sink. Resolves the context (explicit `runContext`, else the
 * ambient one), stamps the envelope, and emits defensively: a throwing
 * listener never breaks the run and never goes silent — it surfaces as
 * `event:listener_error`. A null/invalid emitter is a no-op.
 * @param {{emitter: import('node:events').EventEmitter|null, name: string, payload?: Record<string, unknown>, runContext?: RunContext|null}} arg0
 */
export function emitEvent({ emitter, name, payload = {}, runContext = null }) {
    if (!emitter || typeof emitter.emit !== 'function') return;
    const ctx = runContext instanceof RunContext ? runContext : currentRunContext();
    const envelope = buildEnvelope({ name, payload, ctx });
    // MerciEventEmitter adds per-listener isolation + glob dispatch; plain
    // EventEmitter falls back to a diagnosed emit below. A duck-typed
    // `emitSafe` that throws is contained the same way as a failing listener.
    const safe = (/** @type {{emitSafe?: Function}} */ (emitter)).emitSafe;
    try {
        if (typeof safe === 'function') safe.call(emitter, name, envelope);
        else emitter.emit(name, envelope);
    } catch (err) {
        if (name === EVENTS.ERRORS.LISTENER_ERROR) return;
        try {
            emitter.emit(EVENTS.ERRORS.LISTENER_ERROR, buildEnvelope({
                name: EVENTS.ERRORS.LISTENER_ERROR,
                payload: {
                    sourceEvent: name,
                    error: (/** @type {{message?: any}} */ (err))?.message ?? String(err),
                },
                ctx,
            }));
        } catch {   }
    }
}
