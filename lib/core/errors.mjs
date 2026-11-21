// @ts-check


/**
 * @file Typed error hierarchy for the Merci SDK.
 * @version 0.12.0
 *
 * @description
 * Replaces the historical mix of `throw new Error('string')` and raw
 * `console.error` with a small, structured hierarchy. Consumers can
 * branch on `instanceof` or on the `code` field for type discrimination
 * without depending on message strings.
 *
 * Hierarchy (all extend the native `Error`):
 *   MerciError             — base; carries `code` and the originating `cause`.
 *   ├── BackendError       — vendor SDK / transport errors; carries `status`, `vendorCode`.
 *   ├── MemoryError        — L1 load/store, L2 distillation, L3 skill failures.
 *   ├── ConfigurationError — missing/invalid args (distillationModel, etc.).
 *   ├── WorkspaceError     — per-item workspace key/path/lifecycle failures.
 *   ├── WorkSourceError    — work-source fetch or malformed-record failures.
 *   ├── SchedulerError     — scheduler lifecycle misuse (bound options, order).
 *   ├── AbortedError       — AbortSignal-triggered cancellation.
 *   ├── BudgetExceededError— the run exceeded a caller-configured token budget.
 *   ├── MaxTurnsExceededError— the tool-iteration budget ran out with no final answer.
 *   ├── AbstractMethodError— subclass contract violation (e.g. `step()` not overridden).
 *   └── OrchestrationError— DAG/SM/discussion control failures (verify, exhaustion,
 *       graph structure, unrecovered run), discriminated further by subclass + code.
 *
 * The `code` is stable, machine-readable, and prefixed per the ERROR_CODES
 * registry in limits.mjs. The `cause` is the underlying error so
 * `Error.cause` chaining works natively.
 *
 * @example
 * try {
 *   await session.run(input);
 * } catch (err) {
 *   if (err instanceof AbortedError) return; // user cancelled
 *   if (err instanceof BackendError && err.status === 429) return retry();
 *   throw err;
 * }
 */
import { ERROR_CODES, FALLBACK_MESSAGE } from './constants/index.mjs';
import { LIMITS } from './limit-config.mjs';

/**
 * Options accepted by every error: a stable `code` override, the originating
 * `cause`, and an optional diagnostic `context`. `nonRetryable` is the retry
 * policy's one flag: a failure that another attempt cannot lift (an over-budget
 * value, a spent budget) parks instead of retrying.
 * @typedef {Object} MerciErrorOptions
 * @property {string} [code]
 * @property {unknown} [cause]
 * @property {Record<string, unknown>} [context]
 * @property {boolean} [nonRetryable]
 */

/** @typedef {MerciErrorOptions & {status?: number, vendorCode?: string, provider?: string}} BackendErrorOptions */

/** @typedef {MerciErrorOptions & {layer?: string}} MemoryErrorOptions */

/** @typedef {MerciErrorOptions & {option?: string}} ConfigurationErrorOptions */

/** @typedef {MerciErrorOptions & {reason?: string, workItemId?: string|number, path?: string, stderrTail?: string}} WorkspaceErrorOptions */

/**
 * Stable work-source failure categories (Symphony §11.4). A scheduler branches
 * only on success/failure; the category is diagnostic and for host telemetry.
 * The values are owned by `WORK_SOURCE_CATEGORIES` in `./constants/work-sources.mjs`.
 * @typedef {typeof import('./constants/work-sources.mjs').WORK_SOURCE_CATEGORIES[number]} WorkSourceCategory
 */

/** @typedef {MerciErrorOptions & {category?: WorkSourceCategory, source?: string, retryable?: boolean, retryAfterMs?: number}} WorkSourceErrorOptions */

/**
 * Lifecycle-misuse reason carried by `SchedulerError`.
 * @typedef {'already_started'|'not_started'|'stopped'|'invalid_attempt'|'invalid_identifier'|'not_active'|'bound_option'} SchedulerErrorReason
 */

/** @typedef {MerciErrorOptions & {reason?: SchedulerErrorReason}} SchedulerErrorOptions */

/** @typedef {MerciErrorOptions & {maxTotalTokens?: number, maxBudgetUsd?: number, costUsd?: number, usage?: Record<string, number>}} BudgetExceededErrorOptions */

/** @typedef {MerciErrorOptions & {rule?: import('../agentic/guardrails.mjs').GuardrailRule|null, phase?: 'input'|'output'|null}} GuardrailViolationErrorOptions */

/** @typedef {MerciErrorOptions & {maxTurns?: number, iterationsUsed?: number, partialOutput?: string|null}} MaxTurnsExceededErrorOptions */

/** @typedef {MerciErrorOptions & {reason?: string|null, reasons?: string[], field?: string|null, path?: string|null, line?: number|null, column?: number|null}} PolicyErrorOptions */

/** @typedef {MerciErrorOptions & {reason?: string|null, reasons?: string[], field?: string|null, path?: string|null, line?: number|null, column?: number|null, issues?: Array<{reason: string, field: string|null, line: number|null, column: number|null}>}} AgentFileErrorOptions */

/** @typedef {MerciErrorOptions & {stepId?: string, nodeId?: string, classification?: string, evidence?: string, fingerprint?: string, attempts?: number, label?: string, issues?: Array<string>}} VerificationErrorOptions */

/** @typedef {MerciErrorOptions & {limit?: string|number}} OrchestrationExhaustedErrorOptions */

/** @typedef {MerciErrorOptions & {failedSteps?: Array<string>, failedOutputs?: Record<string, Object>}} OrchestrationFailedErrorOptions */


/**
 * Base class for every SDK-thrown error. Carries a stable `code` and
 * preserves the underlying error via the standard `cause` chain.
 */
export class MerciError extends Error {
    
    /**
 * @param {{message: string, options?: MerciErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super(message);
        this.name = this.constructor.name;
        this.code = options.code || ERROR_CODES.BASE;
        if (options.cause !== undefined) this.cause = options.cause;
        if (options.context !== undefined) this.context = options.context;
        if (options.nonRetryable === true) this.nonRetryable = true;
    }
}


/**
 * A vendor SDK / transport call failed. The original HTTP-style fields
 * (`status`, `vendorCode`) are preserved on the instance for diagnostic
 * branching without re-parsing the message.
 */
export class BackendError extends MerciError {
    
    /**
 * @param {{message: string, options?: BackendErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.BACKEND, cause: options.cause, context: options.context } });
        this.status = options.status;
        this.vendorCode = options.vendorCode;
        this.provider = options.provider;
    }
}


/**
 * A memory subsystem operation failed (L1 load/store, L2 distillation, L3
 * skill). Phase-1 fixes the L2 path to log via sdkError / emit a typed
 * event and store the error on `MemoryManager.lastDistillError` instead
 * of swallowing to `console.error`.
 */
export class MemoryError extends MerciError {
    
    /**
 * @param {{message: string, options?: MemoryErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.MEMORY, cause: options.cause, context: options.context } });
        this.layer = options.layer;
    }
}


/**
 * The SDK was mis-configured (missing required arg, invalid option,
 * conflicting flags). Should be raised at construction / first-use time,
 * not deep inside a request.
 */
export class ConfigurationError extends MerciError {
    
    /**
 * @param {{message: string, options?: ConfigurationErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.CONFIG, cause: options.cause, context: options.context, nonRetryable: options.nonRetryable } });
        this.option = options.option;
    }
}


/**
 * The one way a caller rejects an option: a `ConfigurationError` that also
 * names the option, so a consumer reads `error.option` instead of the message.
 * @param {{option: string, message: string}} arg0 -
 * @returns {ConfigurationError}
 */
export function configurationError({ option, message }) {
    return new ConfigurationError({ message, options: { option } });
}


/**
 * A `WORKFLOW.md` contract failed to load, parse, resolve, or render. `reason`
 * is the stable category; `reasons` carries every validation failure so one
 * edit reports all of them. `field` names the config path, `path` the workflow
 * file (never a value), and `line`/`column` locate a parse failure. The message
 * is fixed and never quotes YAML text: a parse error would otherwise echo the
 * offending line, and a line can hold a secret.
 */
export class PolicyError extends MerciError {
    
    /**
 * @param {{message?: string, options?: PolicyErrorOptions}} [arg0]
 */
        constructor({ message = 'Workflow policy error', options = {} } = {}) {
        super({ message, options: { code: ERROR_CODES.WORKFLOW_POLICY, cause: options.cause } });
        this.reason = options.reason ?? null;
        this.reasons = options.reasons ?? (this.reason ? [this.reason] : []);
        this.field = options.field ?? null;
        this.path = options.path ?? null;
        this.line = options.line ?? null;
        this.column = options.column ?? null;
    }
}

/**
 * An agent definition file (`*.agent.yaml`) failed validation or loading.
 * Mirrors `PolicyError`: `reason`/`reasons` are the stable machine-readable
 * causes, `field` names the offending path inside the document, and
 * `line`/`column` locate it. The message never quotes YAML text — a parse
 * error would echo the offending line, and a line can hold a secret.
 */
export class AgentFileError extends MerciError {

    /**
 * @param {{message?: string, options?: AgentFileErrorOptions}} [arg0]
 */
        constructor({ message = 'Agent definition error', options = {} } = {}) {
        super({ message, options: { code: ERROR_CODES.AGENT_FILE, cause: options.cause } });
        this.reason = options.reason ?? null;
        this.reasons = options.reasons ?? (this.reason ? [this.reason] : []);
        this.field = options.field ?? null;
        this.path = options.path ?? null;
        this.line = options.line ?? null;
        this.column = options.column ?? null;
        /** Every collected issue, in document order (never only the first). */
        this.issues = Array.isArray(options.issues) ? options.issues : [];
    }
}


/**
 * A workspace key, path, or lifecycle operation failed. `reason` is the stable
 * machine-readable cause (`outside_root`, `symlink`, `not_directory`, ...), so a
 * caller branches on it instead of on the message. `path` names the target that
 * was refused, and `stderrTail` keeps the last lines of a failing command
 * without putting them in the message.
 */
export class WorkspaceError extends MerciError {
    
    /**
 * @param {{message: string, options?: WorkspaceErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.WORKSPACE, cause: options.cause, context: options.context } });
        this.reason = options.reason;
        this.workItemId = options.workItemId;
        this.path = options.path;
        this.stderrTail = typeof options.stderrTail === 'string' ? options.stderrTail.slice(-LIMITS.stderr_tail_chars) : undefined;
    }
}


/**
 * A work source failed to list or refresh items. The adapter throws it; the
 * scheduler treats any throw as a failed call, branches only on success or
 * failure, and never inspects the provider payload. `category` is the stable
 * Symphony §11.4 label and is never guessed by this constructor: an omitted
 * category stays `undefined` rather than claiming a diagnosis. `retryable` and
 * `retryAfterMs` are advisory hints from a host adapter (never required for the
 * scheduler's decision); an absent `retryAfterMs` means "no hint".
 */
export class WorkSourceError extends MerciError {
    
    /**
 * @param {{message: string, options?: WorkSourceErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.WORK_SOURCE, cause: options.cause, context: options.context } });
        this.category = options.category;
        this.source = options.source ?? 'unknown';
        this.retryable = options.retryable === true;
        this.retryAfterMs = typeof options.retryAfterMs === 'number' && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0
            ? options.retryAfterMs
            : undefined;
    }
}


/**
 * The scheduler API was misused: a lifecycle call out of order, a reset of a
 * running item, or an attempt to rebind an option that was fixed at
 * construction. This is always a caller error, never a work-item data problem
 * (malformed records are `WorkSourceError`; bad configuration is
 * `ConfigurationError`).
 *
 * Thrown for: `already_started` (second `start()`), `not_started`
 * (`tick()`/`resetItem()`/`applyConfig()` before `start()`), `stopped` (after
 * `stop()`), `invalid_attempt` (`resetItem()` on a running item), and
 * `bound_option` (`applyConfig()` trying to replace a construction-bound
 * option).
 *
 * Every scheduler throw site passes a `reason`; the field is optional only
 * because the error hierarchy allows a bare construction.
 */
export class SchedulerError extends MerciError {
    
    /**
 * @param {{message: string, options?: SchedulerErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.SCHEDULER, cause: options.cause, context: options.context } });
        this.reason = options.reason;
    }
}


/**
 * The AbortSignal was triggered. Vendors surface this in many shapes
 * (DOMException, custom AbortError, plain `signal.aborted === true`).
 * The agentic helpers and `MemoryManager` translate the various shapes
 * into a single AbortedError so consumers can rely on a stable type.
 */
export class AbortedError extends MerciError {
    
    /**
 * @param {{message?: string, options?: MerciErrorOptions}} arg0
 */
        constructor({ message = 'Operation was aborted.', options = {} } = {}) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ABORTED, cause: options.cause } });
    }
}


/**
 * The run exceeded a token budget configured via `session.withBudget(...)`
 * (or the `budget` run option). Thrown from the agentic loop after a step's
 * usage pushes the accumulated total past `maxTotalTokens`, so callers can
 * stop a runaway run instead of discovering the overrun after the fact.
 */
export class BudgetExceededError extends MerciError {
    
    /**
 * @param {{message?: string, options?: BudgetExceededErrorOptions}} arg0
 */
        constructor({ message = 'Token budget exceeded.', options = {} } = {}) {
        super({ message, options: { code: options.code ?? ERROR_CODES.BUDGET, cause: options.cause, context: options.usage } });
        this.maxTotalTokens = options.maxTotalTokens;
        // The money side of the same budget: `failBudgetUsd` passes these, and a
        // caller reporting a USD stop needs the amount, not just the message.
        this.maxBudgetUsd = options.maxBudgetUsd;
        this.costUsd = options.costUsd;
        this.usage = options.usage;
    }
}


/**
 * A guardrail refused the content. The rule that tripped and the side it
 * watches (input or output) are on the error, so a caller can report *why*
 * the run was refused.
 */
export class GuardrailViolationError extends MerciError {
    
    /**
     * @param {{message?: string, options?: GuardrailViolationErrorOptions}} arg0
     */
        constructor({ message = 'A guardrail blocked this content.', options = {} } = {}) {
        super({ message, options: { code: options.code ?? ERROR_CODES.GUARDRAIL, cause: options.cause, context: options.context } });
        this.rule = options.rule ?? null;
        this.phase = options.phase ?? null;
    }
}


/**
 * The run exhausted its tool-iteration budget without producing a final text
 * response. Mirrors the OpenAI Agents SDK `MaxTurnsExceeded` contract: thrown
 * from the agentic loop unless `errorHandlers.max_turns` supplies a controlled
 * output. The default message IS the `FALLBACK_MESSAGE.MAX_ITERATIONS` sentinel
 * so downstream string-prefix guards (`IS_FALLBACK_ERROR`,
 * `isSdkFallbackOutput`) keep recognising an exhausted run.
 */
export class MaxTurnsExceededError extends MerciError {
    
    /**
 * @param {{message?: string, options?: MaxTurnsExceededErrorOptions}} arg0
 */
        constructor({ message = FALLBACK_MESSAGE.MAX_ITERATIONS, options = {} } = {}) {
        super({ message, options: {
            code: options.code ?? ERROR_CODES.MAX_TURNS,
            cause: options.cause,
            context: { maxTurns: options.maxTurns, iterationsUsed: options.iterationsUsed }
        } });
        this.maxTurns = options.maxTurns;
        this.iterationsUsed = options.iterationsUsed;
        this.partialOutput = options.partialOutput ?? null;
    }
}


/**
 * A subclass failed to implement an abstract method. Raised by
 * `AbstractChatSession.withParameters` when no backend override is provided
 * and the function form is used.
 */
export class AbstractMethodError extends MerciError {
    
    /**
 * @param {{message: string, options?: MerciErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ABSTRACT_METHOD } });
    }
}


/**
 * Base class for orchestration-control failures raised by the DAG executor,
 * the state machine, the discussion engine, and their shared verify gates.
 * Consumers can catch the whole family with `instanceof OrchestrationError`
 * and narrow on the subclass or the stable `code`. Coding/definition mistakes
 * (bad graph, misused API) stay `ConfigurationError`; this family is for
 * runtime control outcomes.
 */
export class OrchestrationError extends MerciError {
    
    /**
 * @param {{message: string, options?: MerciErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ORCH, cause: options.cause, context: options.context } });
    }
}


/**
 * A node/step output failed its verification or acceptance gate (deterministic
 * criteria, judge, or a user-supplied `verify`). Carries the machine-readable
 * evidence so a caller can replan/escalate without string-matching the message.
 */
export class VerificationError extends OrchestrationError {
    
    /**
 * @param {{message: string, options?: VerificationErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ORCH_VERIFY, cause: options.cause, context: options.context } });
        this.stepId = options.stepId;
        this.nodeId = options.nodeId;
        this.classification = options.classification;
        this.evidence = options.evidence;
        this.fingerprint = options.fingerprint;
        this.attempts = options.attempts;
        this.label = options.label;
        this.issues = options.issues;
    }
}


/**
 * An orchestration budget/retry/liveness cap was exhausted: step retries,
 * iteration limit, `maxSteps`, `maxVisits`, node timeout, or a run that never
 * produced a usable final answer.
 */
export class OrchestrationExhaustedError extends OrchestrationError {
    
    /**
 * @param {{message: string, options?: OrchestrationExhaustedErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ORCH_EXHAUSTED, cause: options.cause, context: options.context } });
        this.limit = options.limit;
    }
}


/**
 * The workflow graph is structurally unusable at runtime — a dependency cycle,
 * an unresolved/dangling dependency, or a deadlock with no runnable step.
 */
export class GraphError extends OrchestrationError {
    
    /**
 * @param {{message: string, options?: MerciErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ORCH_GRAPH, cause: options.cause, context: options.context } });
    }
}


/**
 * The run ended with unrecovered failed steps (self-heal/replan budget spent).
 * Carries the `failedSteps`/`failedOutputs` payload the executor already
 * attaches, on the instance AND in `context`.
 */
export class OrchestrationFailedError extends OrchestrationError {
    
    /**
 * @param {{message: string, options?: OrchestrationFailedErrorOptions}} arg0
 */
        constructor({ message, options = {} }) {
        super({ message, options: { code: options.code ?? ERROR_CODES.ORCH_FAILED, cause: options.cause, context: options.context } });
        this.failedSteps = options.failedSteps;
        this.failedOutputs = options.failedOutputs;
    }
}




/**
 * Structural shape of an error that may carry the ad-hoc diagnostic fields the
 * SDK reads off thrown values (`code`, `status`, `request`, `response`) and the
 * `cause` chain. The native `Error` type models none of these, so walking an
 * error chain requires this structural view.
 * @typedef {Object} ErrorLike
 * @property {string} name
 * @property {string} [message]
 * @property {string} [code]
 * @property {number} [status]
 * @property {unknown} [request]
 * @property {unknown} [response]
 * @property {unknown} [cause]
 */


/**
 * Best-effort detection of an AbortSignal-triggered failure. Returns
 * `true` when the error or any error in its `cause` chain has the
 * conventional abort shape (DOMException.name === 'AbortError', or the
 * AbortSignal's own `reason`). Used by the agentic loop and memory
 * subsystems before re-throwing as `AbortedError`.
 *
 * @param {{err: unknown, signal?: AbortSignal|null}} arg0 -
 * @returns {boolean}
 */
export function isAbortError({ err, signal }) {
    if (signal && signal.aborted) return true;
    if (!err) return false;
    let cur = /** @type {ErrorLike} */ (err);
    let depth = 0;
    while (cur && depth++ < LIMITS.cause_chain_depth) {
        if (cur.name === 'AbortError' || cur.name === 'CanceledError' || cur.name === 'AbortedError' || cur.name === 'APIUserAbortError') return true;
        if (cur.code === 'ABORT_ERR' || cur.code === 'ERR_CANCELED' || cur.code === ERROR_CODES.ABORTED) return true;
        if (signal && signal.reason && cur === signal.reason) return true;
        cur = /** @type {ErrorLike} */ (cur.cause);
    }
    return false;
}


/**
 * `isAbortError`, guarded for the settle paths: a hostile `name`/`code` getter
 * reads as "not an abort" instead of rejecting the caller's handling. The
 * matching itself stays the one canonical cause-walking rule.
 * @param {{error: unknown}} arg0 -
 * @returns {boolean}
 */
export function isAbortErrorSafe({ error }) {
    try {
        return isAbortError({ err: error });
    } catch {
        return false;
    }
}


/**
 * Wraps a thrown error in the most-specific MerciError subclass based on
 * the available hints. Vendor SDK errors with a `status` property become
 * `BackendError`; abort-shaped errors become `AbortedError`; anything else
 * is re-wrapped as a base `MerciError` if it isn't already one.
 *
 * @param {{err: unknown, hints?: {provider?: string, layer?: string, signal?: AbortSignal}}} arg0 - The original error.
 * @returns {Error}
 */
export function wrapError({ err, hints = {} }) {
    if (err instanceof MerciError) return err;
    if (!err) return new MerciError({ message: 'Unknown error' });
    const e = /** @type {ErrorLike} */ (err);
    if (isAbortError({ err: e, signal: hints.signal })) {
        return new AbortedError({ message: e.message || 'Operation was aborted.', options: { cause: e } });
    }
    if (typeof e.status === 'number' || e.request || e.response) {
        return new BackendError({ message: e.message || 'Backend call failed.', options: {
            status: e.status,
            vendorCode: e.code,
            provider: hints.provider,
            cause: e
        } });
    }
    return new MerciError({ message: e.message || 'SDK error', options: { cause: e } });
}
