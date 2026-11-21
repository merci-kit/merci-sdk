// @ts-check
import { extractAndParseJson } from '../../support/json.mjs';
import { createUserMessage, getToolCallArguments } from '../../messaging/messages.mjs';
import { ERROR_CODES, ProviderType } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { sdkLog, sdkWarn } from '../../support/utils.mjs';
import { isAbortError, AbortedError, BudgetExceededError, OrchestrationExhaustedError } from '../../core/errors.mjs';
import { hasTimeoutCode } from '../../support/retry-policy.mjs';
import { createSession, adoptSessionId } from '../session-policy.mjs';

/**
 * The session surface these helpers drive: configure it, then run one turn.
 * It is the backend's own session object (typed structurally), so only the
 * methods the helpers call are named here.
 * @typedef {Object} UtilitySession
 * @property {string} [provider]
 * @property {string|null} [sessionId]
 * @property {(message: string) => UtilitySession} withSystemMessage
 * @property {(arg0: {params: Function}) => UtilitySession} withParameters
 * @property {(arg0: {tools: Array<Object>}) => UtilitySession} withTools
 * @property {(arg0: {initialInput: string, options?: Object}) => Promise<unknown>} run
 * @property {(arg0: {messages: Array<Object>, options?: Object}) => AsyncGenerator<{type?: string, content?: string, calls?: Array<Object>}, {content?: string}|undefined, unknown>} step
 * @property {(arg0: {timeout: {totalMs: number}}) => UtilitySession} [withTimeout] - Total per-step deadline (agentic sessions).
 */

/**
 * The backend client these helpers call: it opens a session for a model. The
 * four backends share no base type, so only the factories are named.
 * @typedef {Object} StructuredClient
 * @property {string} [provider]
 * @property {Function} [session]
 * @property {Function} [sessionWithId]
 */



/**
 * @file structuredLlmCall — the shared JSON-schema LLM helper.
 * @version 0.12.0
 *
 * @description
 * One "call the LLM and return JSON matching a schema" helper for the planner,
 * state machine, evaluator, summarizer and judge. Retries parse failures with
 * fresh sessions (aborts pass through immediately); on the OPENCODE backend it
 * routes through tool-capture mode because the gateway rejects json_schema
 * response formats.
 */

/**
 * @param {{parsed: import('../../support/json.mjs').ParseResult, text?: string}} arg0
 * @returns {string}
 */
function parseFailureMessage({ parsed, text }) {
    const snippet = String(text ?? '');
    return `Structured plan generation failed: ${describeParseFailure({ parsed })}${snippet ? ` Raw: ${snippet}` : ''}`;
}

/**
 * @param {{parsed: import('../../support/json.mjs').ParseResult}} arg0
 * @returns {string}
 */
export function describeParseFailure({ parsed }) {
    const issues = Array.isArray(parsed.details)
        ? parsed.details.map((d) => `${d.instancePath || '(root)'}: ${d.message}`)
        : [];
    return issues.length > 0 ? `${parsed.error} — ${issues.join('; ')}` : String(parsed.error ?? 'parse failed');
}

/**
 * @param {{steps: Array<Record<string, unknown>>}} arg0
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizePlanSteps({ steps }) {
    if (!Array.isArray(steps)) return steps;
    return steps.map((s) => ({
        ...s,
        systemPrompt: s.systemPrompt ?? s.description ?? '',
        userPromptTemplate: s.userPromptTemplate ?? s.description ?? ''
    }));
}

/**
 * @param {{client: StructuredClient|null|undefined, model: string|undefined, systemMessage?: string|null, parameters?: Function|null, sessionId?: string|null}} arg0
 * @returns {UtilitySession} a configured session
 */
export function utilitySession({ client, model, systemMessage = null, parameters = null, sessionId = null }) {
    let session = /** @type {UtilitySession} */ (createSession({ client: /** @type {import('../session-policy.mjs').SessionClientLike} */ (client), model, sessionId }));
    adoptSessionId({ session, sessionId });
    if (systemMessage) session = session.withSystemMessage(systemMessage);
    if (parameters) session = session.withParameters({ params: parameters });
    return session;
}

/**
 * Bounds one utility attempt with a total deadline.
 *
 * A provider stream that keeps producing text without ever sending its final
 * event resets the inactivity timeout on every chunk, so the stream's own
 * guard never fires and the call never returns. Only a total deadline stops
 * it. Sessions without the knob (test doubles) are left as they are.
 * @param {{session: UtilitySession, timeoutMs?: number}} arg0
 * @returns {UtilitySession}
 */
function withCallDeadline({ session, timeoutMs = LIMITS.structured_call_timeout_ms }) {
    const ms = Number(timeoutMs);
    const withTimeout = session?.withTimeout;
    if (!(ms > 0) || typeof withTimeout !== 'function') return session;
    return withTimeout.call(session, { timeout: { totalMs: ms } });
}

/**
 * Calls the LLM and returns structured data matching `schema`. Retries parse
 * failures with fresh sessions up to maxAttempts; aborts rethrow immediately.
 * Uses tool-capture mode when requested or on the OPENCODE backend.
 * Each attempt is bounded by `timeoutMs` (a total deadline — a stream that
 * never finishes would otherwise wait forever), and a timeout is retried on a
 * fresh session like a parse failure.
 * @template T
 * @param {{client: StructuredClient, model?: string, systemMessage: string, schema: import('../../support/json.mjs').SchemaLike, prompt: string, label?: string, schemaName?: string, useToolCapture?: boolean, maxAttempts?: number, timeoutMs?: number, sessionId?: string|null, signal?: AbortSignal|null, onUsage?: ((usage: Record<string, unknown>) => void)|null}} arg0
 *   LLM call so a cancelled parent run stops the planner/evaluator/judge.
 * @returns {Promise<T>} the parsed data (shape the caller's schema describes).
 */
export async function structuredLlmCall({ client, model, systemMessage, schema, prompt, label = '', schemaName = 'plan', useToolCapture, maxAttempts = LIMITS.planner_max_attempts, timeoutMs = LIMITS.structured_call_timeout_ms, sessionId, signal, onUsage = null }) {
  if (label) sdkLog({ prefix: 'STRUCTURED-LLM', args: [label] });

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return /** @type {T} */ (await (useToolCapture || client.provider === ProviderType.OPENCODE
        ? runToolCapture({ client, model, systemMessage, schema, prompt, schemaName, sessionId, signal, timeoutMs, onUsage })
        : runStructuredText({ client, model, systemMessage, schema, prompt, schemaName, sessionId, signal, timeoutMs, onUsage })));
    } catch (err) {
      // W2-4: a budget stop is the cap failing, not a parse failure. Retrying it
      // would discard a valid answer and spend the cap again, once per attempt.
      if (err instanceof BudgetExceededError || /** @type {any} */ (err)?.code === ERROR_CODES.BUDGET) throw err;
      // A timeout is abort-shaped but is this helper's own deadline: retry it
      // on a fresh session, as documented. A caller abort still rethrows.
      if (isAbortError({ err }) && !hasTimeoutCode({ error: /** @type {Error} */ (err) })) throw err;
      lastError = /** @type {Error} */ (err);
      if (attempt >= maxAttempts) break;
      sdkWarn({ prefix: 'STRUCTURED-LLM', args: [`${label || schemaName} attempt ${attempt}/${maxAttempts} failed: ${/** @type {Error} */ (err).message} — retrying`] });
    }
  }
  throw lastError;
}

/**
 * @param {{client: StructuredClient, model?: string, systemMessage: string, schema: import('../../support/json.mjs').SchemaLike, prompt: string, schemaName: string, sessionId?: string|null, signal?: AbortSignal|null, timeoutMs?: number, onUsage?: ((usage: Record<string, unknown>) => void)|null}} arg0
 * @returns {Promise<unknown>} the parsed JSON (the caller's schema gives it its shape).
 */
async function runStructuredText({ client, model, systemMessage, schema, prompt, schemaName, sessionId, signal, timeoutMs, onUsage = null }) {
  const session = withCallDeadline({ session: utilitySession({ client, model, systemMessage, parameters: (/** @type {(b: any) => any} */ ((b) => b.asJsonSchema({ config: { name: schemaName, schema } }))), sessionId }), timeoutMs });
  /** @type {Record<string, any>|null} */
  let usage = null;
  const onEvent = onUsage ? (/** @param {any} event */ (event) => { if (event?.type === 'quota' && event.data) usage = event.data; }) : null;
  const text = /** @type {string|import('../../support/json.mjs').JsonSchema} */ (await session.run({ initialInput: prompt, options: { maxSchemaRetries: 0, ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) } }));
  if (usage) onUsage?.(usage);
  const parsed = extractAndParseJson({ input: text, schema });
  if (!parsed.success) throw new OrchestrationExhaustedError({ message: parseFailureMessage({ parsed, text: typeof text === 'string' ? text : '' }) });
  return parsed.data;
}

/**
 * @param {{client: StructuredClient, model?: string, systemMessage: string, schema: import('../../support/json.mjs').SchemaLike, prompt: string, schemaName: string, sessionId?: string|null, signal?: AbortSignal|null, timeoutMs?: number, onUsage?: ((usage: Record<string, unknown>) => void)|null}} arg0
 * @returns {Promise<unknown>} the parsed JSON (the caller's schema gives it its shape).
 */
async function runToolCapture({ client, model, systemMessage, schema, prompt, schemaName, sessionId, signal, timeoutMs, onUsage = null }) {
  if (signal?.aborted) throw new AbortedError({ message: 'Structured tool capture aborted.', options: { cause: signal.reason } });
  let session = utilitySession({ client, model, systemMessage: `${systemMessage}\n\nUse the '${schemaName}' tool to return structured JSON. Return ONLY the tool call — no prose.`, parameters: (/** @type {(b: any) => any} */ ((b) => b.asJson())), sessionId });
  session = session.withTools({ tools: [{ name: schemaName, description: 'Return structured output matching the schema.', parameters: schema }] });
  session = withCallDeadline({ session, timeoutMs });
  /** @type {Record<string, any>|null} */
  let usage = null;
  const onEvent = onUsage ? (/** @param {any} event */ (event) => { if (event?.type === 'quota' && event.data) usage = event.data; }) : null;
  const gen = session.step({ messages: [createUserMessage({ provider: /** @type {string} */ (session.provider), content: prompt })], options: { ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) } });
  let repairs = 0;
  let result = await gen.next();
  while (!result.done) {
    if (signal?.aborted) throw new AbortedError({ message: 'Structured tool capture aborted.', options: { cause: signal.reason } });
    const ev = result.value;
    if (ev.type === 'tool_request' && ev.calls?.length) {
      let parsed = extractAndParseJson({ input: /** @type {string|Record<string, unknown>} */ (getToolCallArguments({ call: ev.calls[0] })), schema });
      if (!parsed.success) {
        for (const call of ev.calls.slice(1)) {
          parsed = extractAndParseJson({ input: /** @type {string|Record<string, unknown>} */ (getToolCallArguments({ call })), schema });
          if (parsed.success) break;
        }
      }
      if (parsed.success) { await gen.next(null); if (usage) onUsage?.(usage); return parsed.data; }
      repairs++;
      if (repairs > LIMITS.tool_capture_repairs) {
        await gen.return?.(undefined).catch?.(() => {});
        throw new OrchestrationExhaustedError({ message: parseFailureMessage({ parsed }) });
      }
      const repair = [{ result: `VALIDATION_ERROR: ${describeParseFailure({ parsed })}. Return the full object as valid JSON with no surrounding text.` }];
      result = await gen.next(repair);
      continue;
    }
    result = await gen.next();
  }
  const text = result?.value?.content || '';
  const parsed = extractAndParseJson({ input: text, schema });
  if (usage) onUsage?.(usage);
  if (!parsed.success) throw new OrchestrationExhaustedError({ message: parseFailureMessage({ parsed, text }) });
  return parsed.data;
}
