// @ts-check


/**
 * @file XML tool-call extraction and execution.
 * @version 0.12.0
 *
 * @description
 * Parses `<tool_call>` blocks out of model text, validates their arguments
 * against the tool schemas, and executes them against a tool library.
 * Owns the shared EMPTY_OBJECT_SCHEMA, MCP/A2A result flattening, and the
 * JAI V9 tools-config mapping.
 */
import { randomUUID } from 'node:crypto';
import { guardedParse, validateValue } from '../support/json.mjs';
import { sdkWarn, canonicalJson } from '../support/utils.mjs';
import { isAbortError, AbortedError } from '../core/errors.mjs';
import { EVENTS } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { ApprovalCoordinator } from '../agentic/planning/approval.mjs';
import { toolJournalKey, journalKey, JOURNAL_STATUS } from '../agentic/journal.mjs';
import { capToolOutputValue } from './external-capability.mjs';
import { stillRequiresApproval } from '../agentic/permissions.mjs';
import { createLimiter } from '../support/limiter.mjs';
import { isBuiltIn } from '../core/builtin-brand.mjs';
import { STOP, HOOKS } from '../core/hooks.mjs';
/** @typedef {import('../core/events.mjs').RunContext} RunContext */





/** Frozen empty JSON schema, used wherever a tool declares no parameters. */
export const EMPTY_OBJECT_SCHEMA = Object.freeze({ type: 'object', properties: {} });


/**
 * Marks a tool error as a **pre-effect** failure: the tool knows its side
 * effect did not start, so a resume may safely run the call again.
 *
 * A tool that throws any other error is journaled as an unknown-outcome side
 * effect and is never re-executed (G1-2), because the effect may have landed.
 * A tool declared `idempotent: true` always retries. Use this helper (or set
 * the same property by hand) before throwing:
 *
 *     throw markToolErrorRetryable(new Error('invalid input'));
 *
 * @template {Error} T
 * @param {T} error
 * @returns {T}
 */
export function markToolErrorRetryable(error) {
    return Object.assign(error, { retryable: true });
}


/**
 * ignores the signal can no longer wedge the whole tool round. The losing
 * promise keeps running (at-least-once, journal-protected) — the round
 * unblocks immediately.
 * @param {{promise: Promise<T>, signal: AbortSignal|null|undefined}} arg0 -
 * @template T
 * @returns {Promise<T>}
 */
export function raceWithAbort({ promise, signal }) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new AbortedError({ message: 'Tool execution aborted.', options: { cause: signal.reason } }));
        if (signal.aborted) {
            Promise.resolve(promise).then(() => {}, () => {});
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}


/**
 * Renders a schema-validation failure as one readable line.
 * @param {{ details: any }} arg0 -
 * @returns {string}
 */
function formatSchemaErrors({ details }) {
    if (!Array.isArray(details) || details.length === 0) return 'schema violation';
    return details
        .slice(0, LIMITS.tool_error_schema_lines)
        .map((d) => `${d?.instancePath || '/'} ${d?.message ?? 'is invalid'}`)
        .join('; ');
}


/**
 * Caps a tool call that outlives its budget.
 *
 * The tool's own promise keeps running (the SDK cannot cancel arbitrary
 * user code), but the **round** unblocks immediately with a timeout error
 * instead of stalling the whole agent turn.
 *
 * @param {{ promise: Promise<T>, timeoutMs?: number|null, signal?: AbortSignal|null }} arg0 -
 * @template T
 * @returns {Promise<T>}
 */
export function withToolTimeout({ promise, timeoutMs = null, signal = null }) {
    const ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        // The timer is NOT unref'd: it is the mechanism that unblocks the
        // round, so it must keep the process alive while the tool is pending.
        // An unref'd timer never fires when the hanging tool is the only
        // pending work — the process dies with "unsettled top-level await"
        // before the timeout can report anything. It is cleared as soon as the
        // tool settles — or the round is aborted — so it never outlives the
        // round it belongs to.
        const timer = setTimeout(() => {
            const error = new Error(`Tool execution exceeded its ${ms}ms timeout.`);
            error.name = 'ToolTimeoutError';
            reject(error);
        }, ms);
        const onAbort = () => { clearTimeout(timer); };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        /**
         * @param {{ fn: Function, value: any }} arg0
         */
        const settle = ({ fn, value }) => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(value);
        };
        promise.then(
            (value) => settle({ fn: resolve, value }),
            (error) => settle({ fn: reject, value: error })
        );
    });
}


/**
 * string the other tool families produce. Raw strings, non-array results,
 * and arrays without text blocks pass through untouched.
 * @param {{result: unknown}} arg0 - Any tool payload (a string, a content-block array, or a whole result row).
 * @returns {unknown} The flattened text when the payload carries text blocks, else the payload untouched.
 */
export function flattenContent({ result }) {
    if (typeof result === 'string') return result;
    const content = Array.isArray(result) ? result : /** @type {{content?: unknown}} */ (result)?.content;
    if (!Array.isArray(content)) return result;
    const texts = content
        .map((b) => (typeof b === 'string' ? b : (b && typeof b === 'object' && b.type === 'text' ? b.text : null)))
        .filter((t) => t !== null && t !== undefined);
    if (texts.length > 0) return texts.join('');
    return result;
}


/**
 * fields (name/description/parameters) and wraps each schema under
 * `parameters.schema`.
 * @param {{tools: Array<Record<string, unknown>>}} arg0 - Tool definitions; extra runtime-only fields are dropped, not sent.
 * @returns {Array<Object>}
 */
export function mapToolsToConfig({ tools }) {
    return (tools || []).map(( { name, description, parameters }) => ({
        name,
        description,
        parameters: { schema: parameters || EMPTY_OBJECT_SCHEMA }
    }));
}


/**
 * Malformed blocks are skipped with a warning (the model gets no silent loss).
 * @param {{text: string}} arg0 -
 * @returns {Array<{id: string, name: string, arguments: string}>}
 */
export function extractXmlToolCalls({ text }) {
    const toolCalls = [];
    const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const parseResult = guardedParse({ input: match[1].trim() });
        if (!parseResult.success || !parseResult.data) {
            sdkWarn({ prefix: 'TOOLS', args: [`Malformed <tool_call> block skipped: ${parseResult.error || 'empty data'}`] });
            continue;
        }
        const callData = /** @type {{name?: string, arguments?: unknown}} */ (parseResult.data);
        if (callData.name) {
            toolCalls.push({
                id: `call_${randomUUID()}`,
                name: callData.name,
                arguments: typeof callData.arguments === 'string'
                    ? callData.arguments
                    : JSON.stringify(callData.arguments || {})
            });
        }
    }
    return toolCalls;
}


/**
  * @param {{tool: *, args: *, callId: *, approval: *, signal: *, emitter?: *, runContext?: *}} arg0
 */
async function _awaitApproval({ tool, args, callId, approval, signal, emitter = null, runContext = null }) {
    const name = tool.name;
    runContext?.emit({ emitter, name: EVENTS.TOOL.APPROVAL_REQUESTED, payload: { id: callId, name, args } });
    const coordinator = new ApprovalCoordinator({ timeoutMs: approval.timeoutMs });
    if (!signal?.aborted) {
        Promise.resolve()
            .then(() => approval.callback(name, args, { tool, id: callId }))
            .then((decision) => {
                const approved = decision === true || decision?.approved === true;
                coordinator.resolve({ approved, details: decision && typeof decision === 'object' ? decision : {} });
            })
            .catch((err) => coordinator.resolve({ approved: false, details: { reason: ( (err))?.message ?? String(err) } }));
    }
    const { approved, reason } = await coordinator.wait({ signal });
    if (!approved) {
        const text = coordinator.timedOut ? 'Approval timed out.' : (reason || 'Execution denied by user.');
        runContext?.emit({ emitter, name: EVENTS.TOOL.APPROVAL_DENIED, payload: {
            id: callId, name, reason: text, timedOut: coordinator.timedOut
        } });
        return { approved: false, reason: text };
    }
    runContext?.emit({ emitter, name: EVENTS.TOOL.APPROVAL_GRANTED, payload: { id: callId, name } });
    return { approved: true };
}


/**
 * One model-emitted tool call as the adapters surface it: the field spellings
 * vary by backend (`args`/`arguments`/`input`, flat or under `function`).
 * @typedef {Object} ToolCallRow
 * @property {string} [id]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 * @property {unknown} [args]
 * @property {unknown} [arguments]
 * @property {unknown} [input]
 * @property {{name?: string, arguments?: unknown}|null} [function]
 */

/**
 * A callable tool as `executeTools` consumes it: a `LoadableTool`, or a
 * provider-shaped definition (fields under `function`, extra runtime flags).
 * @typedef {Object} ToolDefinition
 * @property {string} [name]
 * @property {{name?: string}|null} [function]
 * @property {string} [description]
 * @property {import('../support/json.mjs').JsonSchema} [parameters]
 * @property {import('../support/json.mjs').JsonSchema} [outputSchema]
 * @property {Function} [execute]
 * @property {boolean|Function} [requiresApproval]
 * @property {boolean} [runsCode] - The tool executes code (a skill script, a shell). `acceptEdits` never auto-approves it.
 * @property {boolean} [idempotent]
 * @property {number} [timeoutMs] - A per-tool budget that overrides the round's default.
 * @property {Object} [annotations] - MCP tool annotations, advertised verbatim.
 * @property {'forbidden'|'optional'|'required'} [taskSupport] - Advertise the tool as task-augmentable over MCP (legacy 2025-11-25 era only).
 */

/**
 * A tool definition as a factory builds it: the executor's shape with `execute`
 * and `parameters` always present (a provider-shaped definition may omit them,
 * a factory-built one never does).
 * @typedef {ToolDefinition & {execute: Function, parameters: import('../support/json.mjs').JsonSchema}} ReadyTool
 * @property {number} [timeoutMs]
 */

/**
 * `{ id, tool_call_id, name, success, result|error }` envelope; tool errors
 * are returned (not thrown), while AbortError rethrows as cancellation.
 * Duplicate tool names resolve tier-aware: a branded SDK built-in (the
 * module-private Symbol from builtin-brand.mjs — NOT the forgeable surface)
 * wins over a non-builtIn duplicate regardless of registration order — a
 * planted skill must never run in place of a confined built-in — and within
 * the same tier the FIRST definition wins (later duplicates warn, ignored).
 * @param {{toolCalls: Array<ToolCallRow>, toolLibrary: Array<ToolDefinition|null|undefined>, signal?: AbortSignal|null, emitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, runContext?: RunContext|null, approval?: {callback: Function, timeoutMs?: number}|null, journal?: import('../agentic/journal.mjs').ExecutionJournal|null, boundary?: string|number|null, hooks?: import('../core/hooks.mjs').HookRegistry|null, toolTimeoutMs?: number|null, maxParallelTools?: number|null, permissionMode?: 'default'|'acceptEdits'|'bypassPermissions'}} arg0 -
 *   `callback(name, args, ctx)` returns boolean|Promise<boolean> (or
 *   `{approved, reason}`). Consulted only for tools whose definition sets
 *   `requiresApproval` (boolean or `(args)=>boolean`); a gated tool with no
 *   handler is denied (fail closed).
 *   `toolTimeoutMs` is the default per-tool budget for the round; a tool may
 *   override it with its own `timeoutMs`. `maxParallelTools` caps how many of
 *   the round's calls run at once (the rest queue; result order is unchanged).
 *   `journal` is the execution journal: a call is marked INTENT before
 *   `tool.execute()` and DONE when it resolves. A throw is journaled `failed`;
 *   a resume treats that as unknown state (the effect may have landed) unless
 *   the error carries `retryable: true` — set it with
 *   `markToolErrorRetryable` when the tool knows the effect did not start — or
 *   the tool declares `idempotent: true`.
 * @returns {Promise<Array<Object>>} One result envelope per call.
 */
export async function executeTools({ toolCalls, toolLibrary, signal, emitter = null, runContext = null, approval = null, journal = null, boundary = null, hooks = null, toolTimeoutMs = null, maxParallelTools = null, permissionMode = 'default' }) {
    const tCalls = Array.isArray(toolCalls) ? toolCalls : [];
    const toolTimeoutMsDefault = Number(toolTimeoutMs) > 0 ? Number(toolTimeoutMs) : null;
    /** @type {Array<ToolDefinition>} */
    const tLibrary = /** @type {Array<ToolDefinition>} */ ((Array.isArray(toolLibrary) ? toolLibrary : []).filter(Boolean));
    const toolMap = new Map();
    for (const t of tLibrary) {
        const name = t.name || t.function?.name;
        if (!name) continue;
        const existing = toolMap.get(name);
        if (!existing) {
            toolMap.set(name, t);
        } else if (!isBuiltIn({ tool: existing }) && isBuiltIn({ tool: t })) {
            sdkWarn({ prefix: 'TOOLS', args: [`duplicate tool name "${name}" — the built-in definition wins over the non-built-in duplicate`] });
            toolMap.set(name, t);
        } else {
            sdkWarn({ prefix: 'TOOLS', args: [`duplicate tool name "${name}" — the first definition wins, later duplicate ignored`] });
        }
    }

    const roundStart = Date.now();
    runContext?.emit({ emitter, name: EVENTS.TOOL.ROUND_START, payload: { count: tCalls.length } });

    // Two identical calls in one round are legitimate: the model asked twice.
    // They must not share a journal key, or the second sees the first's INTENT
    // row and is refused as unknown-state. n = 0 keeps the pre-0.9 key, so a
    // journal written by an earlier release still replays.
    /** @type {Map<string, number>} */
    const occurrenceCounts = new Map();
    /** @param {{name: string|undefined, rawArgs: unknown}} arg0 */
    const nextOccurrence = ({ name, rawArgs }) => {
        // Strict (G1-10): the occurrence key must not collapse two calls whose
        // arguments differ only in a non-JSON field a hook added.
        const key = `${String(name ?? '')}\u0000${canonicalJson({ value: rawArgs ?? null, strict: true })}`;
        const n = occurrenceCounts.get(key) ?? 0;
        occurrenceCounts.set(key, n + 1);
        return n;
    };

    const parallelCap = Number.isInteger(maxParallelTools) && /** @type {number} */ (maxParallelTools) > 0 ? /** @type {number} */ (maxParallelTools) : 0;
    const limiter = parallelCap > 0 && parallelCap < tCalls.length ? createLimiter({ maxConcurrent: parallelCap }) : null;
    const executionPromises = tCalls.map((call) => {
        /** @type {() => Promise<any>} */
        const runOne = async () => {
        const name = call.name || call.function?.name;
        const tool = toolMap.get(name);
        const callId = call.id ?? call.tool_call_id ?? `call_${randomUUID()}`;
        const callStart = Date.now();

        if (!tool) {
            runContext?.emit({ emitter, name: EVENTS.TOOL.NOT_FOUND, payload: { id: callId, name } });
            return {
                id: callId,
                tool_call_id: callId,
                name,
                success: false,
                error: `Tool '${name}' not found.`
            };
        }

        const rawArgs = call.args ?? call.arguments ?? call.input ?? call.function?.['arguments'] ?? '{}';

        // The call starts here, before the "can this tool even run?" branch: a
        // call end without a start is unpaired (W2-10).
        runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_START, payload: { id: callId, name, args: rawArgs } });

        if (!tool.execute) {
            const error = `Tool '${name}' has no execute implementation.`;
            runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                id: callId, name, success: false, durationMs: 0, error
            } });
            return {
                id: callId,
                tool_call_id: callId,
                name,
                success: false,
                error
            };
        }

        try {
            const result = guardedParse({ input: rawArgs, schema: tool.parameters, options: { heal: false } });
            if (!result.success) {
                const raw = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                const previewChars = LIMITS.raw_args_preview_chars;
                runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                    id: callId, name, success: false, durationMs: Date.now() - callStart,
                    error: `Invalid tool arguments: ${result.error}`
                } });
                return {
                    id: callId,
                    tool_call_id: callId,
                    name,
                    success: false,
                    error: `Invalid tool arguments: ${result.error}`,
                    details: result.details,
                    result: { raw: raw.length > previewChars ? raw.slice(0, previewChars) + '…' : raw }
                };
            }
            let parsedArgs = result.data;
            // Counted on the PARSED args: the journal key is derived from them,
            // so two calls that differ only in whitespace or in string-vs-object
            // encoding are the same call and must not share a key.
            const occurrence = nextOccurrence({ name, rawArgs: parsedArgs });
            if (hooks) {
                const decision = await hooks.runWaterfall({ name: HOOKS.TOOL_BEFORE, value: { id: callId, name, args: parsedArgs }, ctx: { tool, signal, runContext, emitter } });
                if (decision === STOP) {
                    const error = `Tool '${name}' blocked by a tool:before hook.`;
                    runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                        id: callId, name, success: false, durationMs: Date.now() - callStart, error
                    } });
                    return { id: callId, tool_call_id: callId, name, success: false, error, blocked: true };
                }
                if (decision && typeof decision === 'object' && decision.args !== undefined) parsedArgs = decision.args;
            }
            let requiresApproval = tool.requiresApproval;
            if (typeof requiresApproval === 'function') requiresApproval = await requiresApproval({ args: parsedArgs });
            // The permission mode decides whether a gated tool still asks.
            requiresApproval = stillRequiresApproval({ name: /** @type {string} */ (name), mode: permissionMode, requiresApproval, tool });
            if (requiresApproval) {
                if (!approval?.callback) {
                    const error = 'Tool requires approval but no approval handler is configured.';
                    runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                        id: callId, name, success: false, durationMs: Date.now() - callStart, error
                    } });
                    return { id: callId, tool_call_id: callId, name, success: false, error };
                }
                const gate = await _awaitApproval({ tool, args: parsedArgs, callId, approval:  (approval), signal, emitter, runContext });
                if (!gate.approved) {
                    runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                        id: callId, name, success: false, durationMs: Date.now() - callStart, error: gate.reason
                    } });
                    return { id: callId, tool_call_id: callId, name, success: false, error: gate.reason };
                }
            }
            const executionResult = await (async () => {
                if (signal?.aborted) {
                    throw new AbortedError({ message: 'Tool execution aborted.', options: { cause: signal.reason } });
                }
                const entryBaseKey = journal
                    ? toolJournalKey({ runId: journal.runId, boundary, name, args: parsedArgs })
                    : null;
                const entryKey = entryBaseKey === null
                    ? null
                    : (occurrence > 0 ? journalKey({ parts: [entryBaseKey, occurrence] }) : entryBaseKey);
                if (entryKey) {
                    const prior = journal?.get({ key: entryKey });
                    if (prior?.status === JOURNAL_STATUS.DONE) {
                        // Fail closed (B1): only an outcome that SAYS it succeeded
                        // replays as a success. A missing, null or malformed
                        // outcome is an unknown result, not a success.
                        const ok = prior.outcome?.success === true;
                        runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                            id: callId, name, success: ok, durationMs: 0, replayed: true
                        } });
                        return ok
                            ? { replayed: true, result: prior.outcome?.result }
                            : { replayed: true, failed: true, error: prior.outcome?.error ?? 'Tool execution failed.' };
                    }
                    // G1-2: a FAILED row is retryable only when the tool is
                    // idempotent or the failure is known to precede the effect.
                    // Otherwise it is the same unknown state as an interrupted call.
                    const failedUnknown = prior?.status === JOURNAL_STATUS.FAILED
                        && prior?.retryable !== true
                        && tool.idempotent !== true;
                    if ((prior?.status === JOURNAL_STATUS.INTENT || prior?.status === JOURNAL_STATUS.INTERRUPTED || failedUnknown)
                        && tool.idempotent !== true) {
                        const error = `Tool '${name}' was invoked by an earlier attempt and its side-effect state is unknown; not re-executed.`;
                        runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                            id: callId, name, success: false, durationMs: 0, interrupted: true, error
                        } });
                        // G1-6: `emitted` stops the caller below from pairing the
                        // same call a second time.
                        return { failed: true, error, emitted: true };
                    }
                    journal?.begin({ key: entryKey, meta: {
                        kind: 'tool',
                        name,
                        // B6: the row says which step/branch it belongs to and what it was
                        // called with, not only the hash of them.
                        boundary: boundary ?? null,
                        args: parsedArgs ?? null,
                        sessionId: runContext?.sessionId ?? null,
                        parentRunId: runContext?.parentRunId ?? null,
                    } });
                    // G1-1: the INTENT row must be on disk BEFORE the effect. A sink
                    // that throws aborts the call: without a durable intent the
                    // restart cannot know the side effect is unknown.
                    await journal?.persistIntent?.();
                }
                // Declared outside the try: the catch needs it to tell a
                // timeout from a clean failure.
                /** @type {AbortSignal|null} */
                let timeoutSignal = null;
                try {
                    const toolTimeoutMs = Number(tool.timeoutMs ?? toolTimeoutMsDefault) > 0
                        ? Number(tool.timeoutMs ?? toolTimeoutMsDefault)
                        : null;
                    // The tool sees a signal that fires when its own timeout
                    // expires, so a well-behaved tool can stop early.
                    /** @type {AbortSignal[]} */
                    const toolSignals = [];
                    if (signal) toolSignals.push(signal);
                    // Kept so the catch can tell "the tool's own timeout fired"
                    // from a clean failure: the tool may reject with the signal's
                    // reason, a DOMException named TimeoutError that isAbortError
                    // does not recognize.
                    timeoutSignal = toolTimeoutMs ? AbortSignal.timeout(toolTimeoutMs) : null;
                    if (timeoutSignal) toolSignals.push(timeoutSignal);
                    const toolSignal = toolSignals.length === 1 ? toolSignals[0] : (toolSignals.length > 1 ? AbortSignal.any(toolSignals) : null);
                    let out = await raceWithAbort({
                        promise: withToolTimeout({
                            promise: tool.execute({ args: parsedArgs, signal: toolSignal, context: { runContext, idempotencyKey: entryKey ?? undefined } }),
                            timeoutMs: toolTimeoutMs,
                            signal
                        }),
                        signal
                    });
                    // G1-2: the effect is COMPLETE the moment execute() resolves.
                    // A later hook, schema check or output cap must not turn a
                    // performed side effect into a `failed` row a resume re-runs.
                    if (entryKey) {
                        const ok = !(out && typeof out === 'object' && out.success === false);
                        const recorded = capToolOutputValue({ value: out }).value;
                        journal?.complete({ key: entryKey, outcome: ok ? { success: true, result: recorded } : { success: false, error: out.error ?? 'Tool execution failed.' } });
                    }
                    if (hooks) {
                        const transformed = await hooks.runWaterfall({ name: HOOKS.TOOL_AFTER, value: out, ctx: { id: callId, name, tool, runContext, emitter } });
                        if (transformed !== STOP) out = transformed;
                    }
                    // A tool that declares an output schema must honour it: a
                    // result the model cannot trust is a failed call, not a
                    // silent wrong answer.
                    if (tool.outputSchema && !(out && typeof out === 'object' && out.success === false)) {
                        const verdict = validateValue({ value: out, schema: tool.outputSchema });
                        if (!verdict.ok) {
                            const error = `Tool '${name}' returned a result that does not match its outputSchema: ${formatSchemaErrors({ details: verdict.details })}`;
                            runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                                id: callId, name, success: false, durationMs: Date.now() - callStart, error
                            } });
                            return { failed: true, error, emitted: true };
                        }
                    }
                    const capped = capToolOutputValue({ value: out });
                    if (capped.truncated) {
                        runContext?.emit({ emitter, name: EVENTS.TOOL.OUTPUT_TRUNCATED, payload: {
                            id: callId, name,
                            inLen: typeof out === 'string' ? out.length : null,
                            outLen: typeof capped.value === 'string' ? capped.value.length : null,
                            shape: typeof out === 'string' ? 'text' : typeof out
                        } });
                    }
                    out = capped.value;
                    return { result: out };
                } catch (e) {
                    // A row already marked DONE is not rewritten: the effect ran,
                    // and a post-effect observer's failure must not re-execute it.
                    const alreadyDone = entryKey ? journal?.get({ key: entryKey })?.status === JOURNAL_STATUS.DONE : false;
                    if (entryKey && !alreadyDone) {
                        // A timed-out tool is NOT a clean failure: the SDK cannot
                        // cancel arbitrary user code, so the losing promise may
                        // still complete its side effect. Mark it interrupted
                        // (unknown state) so a retry refuses to re-execute a
                        // non-idempotent tool instead of doubling the effect.
                        const timedOut = (/** @type {any} */ (e))?.name === 'ToolTimeoutError'
                            || (/** @type {any} */ (e))?.code === 'TOOL_TIMEOUT'
                            || timeoutSignal?.aborted === true;
                        if (isAbortError({ err: e }) || timedOut) journal?.interrupt({ key: entryKey, reason: String( (/** @type {any} */ (e))?.message ?? e) });
                        else {
                            // G1-2 escape hatch: a `failed` row is unknown state
                            // unless the tool KNOWS the effect did not start and
                            // says so with `retryable: true` (see
                            // markToolErrorRetryable). A tool declared idempotent
                            // is retried anyway. Everything else may have landed
                            // and must not run twice.
                            const preEffect = (/** @type {any} */ (e))?.retryable === true;
                            journal?.fail({ key: entryKey, error: e, retryable: preEffect });
                        }
                    }
                    throw e;
                }
            })();
            if (executionResult.replayed && executionResult.failed) {
                return {
                    id: callId, tool_call_id: callId, name,
                    success: false, error: executionResult.error, replayed: true, failed: true
                };
            }
            if (executionResult.failed) {
                if (!executionResult.emitted) {
                    runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                        id: callId, name, success: false, durationMs: Date.now() - callStart, error: executionResult.error
                    } });
                }
                return {
                    id: callId, tool_call_id: callId, name,
                    success: false, error: executionResult.error
                };
            }
            if (executionResult.replayed) {
                const replayedVal = capToolOutputValue({ value: executionResult.result }).value;
                return {
                    id: callId, tool_call_id: callId, name,
                    success: true, result: replayedVal, replayed: true
                };
            }
            const executionResultValue = executionResult.result;
            const cappedResultValue = executionResultValue;
            if (executionResultValue && typeof executionResultValue === 'object' && executionResultValue.success === false) {
                runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                    id: callId, name, success: false, durationMs: Date.now() - callStart,
                    error: executionResultValue.error || 'Tool execution failed.'
                } });
                return {
                    id: callId,
                    tool_call_id: callId,
                    name,
                    success: false,
                    error: executionResultValue.error || 'Tool execution failed.',
                    result: executionResultValue
                };
            }
            runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                id: callId, name, success: true, durationMs: Date.now() - callStart
            } });
            return {
                id: callId,
                tool_call_id: callId,
                name,
                success: true,
                result: cappedResultValue
            };
        } catch (e) {
            if (isAbortError({ err: e })) {
                // G1-6: an abort tears the round down, so no other branch is left
                // to pair this call's start. The round itself is closed below.
                runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                    id: callId, name, success: false, aborted: true, durationMs: Date.now() - callStart
                } });
                throw e;
            }
            sdkWarn({ prefix: 'TOOLS', args: [`Tool "${name}" failed: ${( (/** @type {any} */ (e)))?.message ?? e}`] });
            const message = String(( (/** @type {any} */ (e)))?.message ?? e);
            if (hooks) {
                try {
                    await hooks.runSerial({ name: HOOKS.TOOL_ERROR, ctx: { id: callId, name, tool, error: message, runContext, emitter } });
                } catch {   }
            }
            runContext?.emit({ emitter, name: EVENTS.TOOL.ERROR, payload: { id: callId, name, error: message } });
            runContext?.emit({ emitter, name: EVENTS.TOOL.CALL_END, payload: {
                id: callId, name, success: false, durationMs: Date.now() - callStart, error: message
            } });
            return {
                id: callId,
                tool_call_id: callId,
                name,
                success: false,
                error: message
            };
        }
        };
        return limiter ? limiter.run(runOne) : runOne();
    });

    // G1-6: the round's end is emitted exactly once — on the normal path, or on
    // the abort path, which never reaches it.
    let roundClosed = false;
    /** @param {{results?: Array<any>, aborted?: number}} [arg0] */
    const closeRound = ({ results = [], aborted = 0 } = {}) => {
        if (roundClosed) return;
        roundClosed = true;
        runContext?.emit({ emitter, name: EVENTS.TOOL.ROUND_END, payload: {
            count: tCalls.length,
            durationMs: Date.now() - roundStart,
            okCount: results.filter(r => r && r.success).length,
            // A call that rejected (cancelled) is a failed call, so the counts
            // still add up to `count`.
            failCount: results.filter(r => r && !r.success).length + aborted
        } });
    };

    try {
        const results = await Promise.all(executionPromises);
        closeRound({ results });
        return results;
    } catch (error) {
        // W2-10: `Promise.all` rejects on the first cancellation while its
        // siblings are still settling, so closing the round here would put
        // `round_end` before a late `call_end`. Wait for every call, count a
        // rejected one as failed, and let the round end stay last.
        const settled = await Promise.allSettled(executionPromises);
        const fulfilled = settled.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []);
        closeRound({ results: fulfilled, aborted: settled.length - fulfilled.length });
        throw error;
    }
}
