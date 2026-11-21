// @ts-check


/**
 * @file Evals — run a suite of cases against a session and score each run.
 * @version 0.12.0
 *
 * @description
 * `runEvals({ cases, makeSession, scorers, concurrency })` gives every case a
 * fresh session (`makeSession`), runs it, observes the run — the final output,
 * the tool calls (from `tool:call_*`), the usage (from `run:end`), the latency
 * and a thrown error, tagged with `classifyFailure` — and asks every scorer for
 * a verdict. A case passes when every scorer passes; `passRate` is the share of
 * passing cases.
 *
 * The scorers in `EVAL_SCORERS` read their expectations from the case
 * (`case.expected`), so one scorer list serves the whole suite:
 *
 *   - `outputMatches()` — `expected.output`: a RegExp, or a string the
 *     trimmed output must equal.
 *   - `outputSchema()` — `expected.schema` (JSON Schema or Zod): the output
 *     parsed as JSON must satisfy it.
 *   - `toolsCalled()` — `expected.tools`: every named tool ran successfully.
 *   - `toolSequence()` — `expected.toolSequence`: the tool calls, in order.
 *   - `withinBudget()` — `expected.maxTotalTokens` / `expected.maxLatencyMs`.
 *   - `judge({ judge, threshold })` — an LLM judge from `createLlmJudge` or
 *     `createScoredJudge`, fed `{ input, output, expected, toolCalls }`.
 *   - `decision({ ask, question, threshold })` — the decision gate on the run's
 *     output; an escalation is skipped, never failed.
 *
 * A scorer whose expectation is absent from a case passes it (`skipped`). A
 * scorer is any `({ observation, signal }) => verdict`, so custom ones fit.
 * Pair a suite with a cassette (`withCassette`) to run it offline and
 * deterministically.
 */
import { randomUUID } from 'node:crypto';
import { EVENTS } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { AbortedError, ConfigurationError, GuardrailViolationError } from '../core/errors.mjs';
import { createLimiter } from '../support/limiter.mjs';
import { guardedParse, validateValue } from '../support/json.mjs';
import { getErrorStatus } from '../support/utils.mjs';
import { hasTimeoutCode } from '../support/retry-policy.mjs';
import { classifyFailure } from './loops/policy.mjs';
import { assertUsableOutput } from './agentic-core.mjs';
import { createDecisionGate } from './decision-gate.mjs';


/**
 * One case of a suite.
 * @typedef {Object} EvalCase
 * @property {string} [name]
 * @property {string|Array<Object>} input - The run's initial input.
 * @property {EvalExpectations} [expected] - What the scorers check.
 */

/**
 * @typedef {Object} EvalExpectations
 * @property {RegExp|string} [output]
 * @property {import('../support/json.mjs').SchemaLike} [schema]
 * @property {string[]} [tools]
 * @property {string[]} [toolSequence]
 * @property {number} [maxTotalTokens]
 * @property {number} [maxLatencyMs]
 */

/**
 * What a scorer sees of one run.
 * @typedef {Object} EvalObservation
 * @property {EvalCase} case
 * @property {string|null} output - The run's final answer (null when it threw).
 * @property {Array<{name: string, success: boolean}>} toolCalls - In the order they ended.
 * @property {{prompt_tokens?: number, completion_tokens?: number, total_tokens?: number}|null} usage
 * @property {number} durationMs
 * @property {Error|null} error
 * @property {string|null} failureClass - A `FailureClass` when the run threw.
 */

/**
 * @typedef {Object} EvalVerdict
 * @property {string} name
 * @property {boolean} passed
 * @property {number} [score]
 * @property {string} [evidence]
 * @property {boolean} [skipped] - The case set no expectation for this scorer.
 */

/**
 * @typedef {(arg0: {observation: EvalObservation, signal?: AbortSignal|null}) => EvalVerdict|Promise<EvalVerdict>} EvalScorer
 */

/**
 * @typedef {Object} EvalResult
 * @property {string} name
 * @property {boolean} passed
 * @property {Array<EvalVerdict>} verdicts
 * @property {EvalObservation} observation
 */

/** The session surface a case runs on. */
/**
 * @typedef {Object} EvalSession
 * @property {(arg0: {initialInput: string|Array<Object>, options?: {signal?: AbortSignal|null}}) => Promise<unknown>} run
 * @property {import('node:events').EventEmitter|null} [eventEmitter]
 */


/**
 * The `FailureClass` of a run that threw.
 * @param {{error: unknown}} arg0
 * @returns {string}
 */
function failureClassOf({ error }) {
    const status = getErrorStatus({ error });
    const err = /** @type {any} */ (error);
    return classifyFailure({ evidence: {
        ...(error instanceof GuardrailViolationError ? { source: 'policy' } : {}),
        ...(hasTimeoutCode({ error: /** @type {Error} */ (error) }) || err?.name === 'TimeoutError' ? { timedOut: true } : {}),
        ...(status === 429 ? { errorCode: 'rate_limit' } : (status ?? 0) >= 500 ? { errorCode: 'service_unavailable' } : {}),
        // A configuration gap (a missing key, a cassette with no recording) is the environment's.
        ...(error instanceof ConfigurationError ? { environmentMissing: true } : {}),
    } });
}

/**
 * Runs one case on a fresh session and observes it.
 * @param {{evalCase: EvalCase, index: number, makeSession: (arg0: {evalCase: EvalCase, index: number}) => EvalSession|Promise<EvalSession>, signal: AbortSignal|null}} arg0
 * @returns {Promise<EvalObservation>}
 */
async function observeCase({ evalCase, index, makeSession, signal }) {
    /** @type {Array<{name: string, success: boolean}>} */
    const toolCalls = [];
    /** @type {any} */
    let usage = null;
    const started = Date.now();
    let session = null;
    /** @type {Array<() => void>} */
    const detach = [];
    try {
        session = await makeSession({ evalCase, index });
        // Sessions of one client share its emitter: a case hears only its own session's events,
        // so concurrent cases never read each other's tool calls or usage.
        const live = /** @type {any} */ (session);
        if (!live?.sessionId && typeof live?.withSessionId === 'function') live.withSessionId({ id: `eval-${index}-${randomUUID()}` });
        const sessionId = live?.sessionId ?? null;
        /** @param {any} e */
        const mine = (e) => !sessionId || e?.sessionId === sessionId;
        const emitter = session?.eventEmitter ?? null;
        if (emitter) {
            /** @param {any} e */
            const onToolEnd = (e) => { if (mine(e)) toolCalls.push({ name: String(e?.name ?? ''), success: e?.success !== false }); };
            /** @param {any} e */
            const onRunEnd = (e) => { if (mine(e) && (!e?.parentRunId || usage === null)) usage = e?.usage ?? usage; };
            emitter.on(EVENTS.TOOL.CALL_END, onToolEnd);
            emitter.on(EVENTS.CLIENT.RUN_END, onRunEnd);
            detach.push(() => emitter.off(EVENTS.TOOL.CALL_END, onToolEnd), () => emitter.off(EVENTS.CLIENT.RUN_END, onRunEnd));
        }
        const output = await session.run({ initialInput: evalCase.input, options: { signal } });
        const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
        // A sentinel or an empty answer is not a scored output: the case fails
        // with the guard's error instead of scoring a non-answer.
        assertUsableOutput({ text, what: 'The eval case produced no usable output.' });
        return { case: evalCase, output: text, toolCalls, usage, durationMs: Date.now() - started, error: null, failureClass: null };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return { case: evalCase, output: null, toolCalls, usage, durationMs: Date.now() - started, error, failureClass: failureClassOf({ error }) };
    } finally {
        for (const off of detach) off();
    }
}

/**
 * Runs a suite: every case on a fresh session, every scorer on every run.
 *
 * @param {{cases: Array<EvalCase>, makeSession: (arg0: {evalCase: EvalCase, index: number}) => EvalSession|Promise<EvalSession>, scorers?: Array<EvalScorer>, concurrency?: number, signal?: AbortSignal|null}} arg0
 *   `makeSession` builds the session for one case (a fresh one each time, so
 *   cases never share history). `concurrency` bounds the cases in flight
 *   (default 1). A scorer that throws fails its case, with the error as evidence.
 * @returns {Promise<{results: Array<EvalResult>, passRate: number}>}
 */
export async function runEvals({ cases, makeSession, scorers = [], concurrency = LIMITS.evals_concurrency, signal = null }) {
    if (!Array.isArray(cases)) throw new ConfigurationError({ message: 'runEvals: cases must be an array.', options: { option: 'cases' } });
    if (typeof makeSession !== 'function') throw new ConfigurationError({ message: 'runEvals: makeSession must be a function returning a session.', options: { option: 'makeSession' } });
    const limiter = createLimiter({ maxConcurrent: concurrency });
    const results = await Promise.all(cases.map((evalCase, index) => limiter.run(async () => {
        // Checked before the session is built: an aborted run must not start
        // work it will only throw away.
        if (signal?.aborted) throw new AbortedError({ message: 'runEvals aborted before the case started.', options: { cause: signal.reason } });
        const observation = await observeCase({ evalCase, index, makeSession, signal });
        /** @type {Array<EvalVerdict>} */
        const verdicts = [];
        for (const scorer of scorers) {
            try {
                verdicts.push(await scorer({ observation, signal }));
            } catch (err) {
                verdicts.push({ name: scorer.name || 'scorer', passed: false, evidence: `the scorer threw: ${err instanceof Error ? err.message : String(err)}` });
            }
        }
        // A run that threw fails its case even when no scorer looked at the output.
        const passed = observation.error === null && verdicts.every((v) => v.passed);
        return { name: evalCase.name ?? `case ${index + 1}`, passed, verdicts, observation };
    })));
    const passRate = results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length;
    return { results, passRate };
}


/**
 * @param {{name: string}} arg0
 * @returns {EvalVerdict}
 */
const skipped = ({ name }) => ({ name, passed: true, skipped: true });

/**
 * The built-in scorers. Each is a factory returning an `EvalScorer` that reads
 * its expectation from `case.expected`.
 */
export const EVAL_SCORERS = Object.freeze({
    /** @returns {EvalScorer} */
    outputMatches: () => ({ observation }) => {
        const want = observation.case.expected?.output;
        if (want === undefined) return skipped({ name: 'outputMatches' });
        const got = observation.output ?? '';
        // search, not test: a /g or /y pattern carries no state from one run to the next.
        const passed = want instanceof RegExp ? got.search(want) !== -1 : got.trim() === String(want).trim();
        return { name: 'outputMatches', passed, evidence: passed ? 'matched' : `expected ${String(want)}, got ${JSON.stringify(got.slice(0, 200))}` };
    },

    /** @returns {EvalScorer} */
    outputSchema: () => ({ observation }) => {
        const schema = observation.case.expected?.schema;
        if (!schema) return skipped({ name: 'outputSchema' });
        // Strict: a nearly-valid answer is not healed into a pass.
        const parsed = guardedParse({ input: observation.output ?? '', options: { heal: false } });
        if (!parsed.success) return { name: 'outputSchema', passed: false, evidence: `the output is not JSON: ${parsed.error ?? 'parse failed'}` };
        const verdict = validateValue({ value: parsed.data, schema });
        return { name: 'outputSchema', passed: verdict.ok, evidence: verdict.ok ? 'valid' : JSON.stringify(verdict.details).slice(0, 300) };
    },

    /** @returns {EvalScorer} */
    toolsCalled: () => ({ observation }) => {
        const want = observation.case.expected?.tools;
        if (!Array.isArray(want)) return skipped({ name: 'toolsCalled' });
        const ok = new Set(observation.toolCalls.filter((c) => c.success).map((c) => c.name));
        const missing = want.filter((name) => !ok.has(name));
        return { name: 'toolsCalled', passed: missing.length === 0, evidence: missing.length === 0 ? 'all called' : `not called (successfully): ${missing.join(', ')}` };
    },

    /** @returns {EvalScorer} */
    toolSequence: () => ({ observation }) => {
        const want = observation.case.expected?.toolSequence;
        if (!Array.isArray(want)) return skipped({ name: 'toolSequence' });
        const got = observation.toolCalls.map((c) => c.name);
        const passed = got.length === want.length && got.every((name, i) => name === want[i]);
        return { name: 'toolSequence', passed, evidence: passed ? 'in order' : `expected [${want.join(', ')}], got [${got.join(', ')}]` };
    },

    /** @returns {EvalScorer} */
    withinBudget: () => ({ observation }) => {
        const { maxTotalTokens, maxLatencyMs } = observation.case.expected ?? {};
        if (maxTotalTokens === undefined && maxLatencyMs === undefined) return skipped({ name: 'withinBudget' });
        const tokens = observation.usage?.total_tokens ?? ((observation.usage?.prompt_tokens ?? 0) + (observation.usage?.completion_tokens ?? 0));
        /** @type {string[]} */
        const over = [];
        // An unobserved usage is not a pass: the budget cannot be shown to hold.
        if (maxTotalTokens !== undefined && observation.usage == null) over.push('token usage unknown (no run:end usage observed)');
        else if (maxTotalTokens !== undefined && tokens > maxTotalTokens) over.push(`${tokens} tokens > ${maxTotalTokens}`);
        if (maxLatencyMs !== undefined && observation.durationMs > maxLatencyMs) over.push(`${observation.durationMs}ms > ${maxLatencyMs}ms`);
        return { name: 'withinBudget', passed: over.length === 0, evidence: over.length === 0 ? `${tokens} tokens, ${observation.durationMs}ms` : over.join('; ') };
    },

    /**
     * An LLM judge as a scorer. A `createLlmJudge` judge answers `passed`; a
     * `createScoredJudge` one answers a score object, which passes at or above
     * `threshold` (its `scoreField`, default `score`).
     * @param {{judge: (arg0: {ctx: {getAll: () => Record<string, unknown>}, signal?: AbortSignal|null}) => Promise<unknown>, threshold?: number, name?: string}} arg0
     * @returns {EvalScorer}
     */
    judge: ({ judge, threshold = 0.5, name = 'judge' }) => {
        if (typeof judge !== 'function') throw new ConfigurationError({ message: 'EVAL_SCORERS.judge requires a judge from createLlmJudge or createScoredJudge.', options: { option: 'judge' } });
        return async ({ observation, signal = null }) => {
            const state = { input: observation.case.input, output: observation.output, expected: observation.case.expected ?? null, toolCalls: observation.toolCalls };
            const answer = /** @type {any} */ (await judge({ ctx: { getAll: () => state }, signal }));
            if (typeof answer?.passed === 'boolean') return { name, passed: answer.passed, evidence: String(answer.evidence ?? '') };
            const field = /** @type {any} */ (judge).scoreField ?? 'score';
            const score = Number(answer?.[field]);
            return { name, passed: Number.isFinite(score) && score >= threshold, score, evidence: JSON.stringify(answer).slice(0, 300) };
        };
    },

    /**
     * The decision gate as a scorer. An escalation (or an uncalibrated answer)
     * is skipped: it must never fail a correct output. A confident verdict is
     * the pass/fail, with its certainty as the score.
     * @param {{ask?: Function|null, question?: import('../messaging/decision.mjs').DecisionQuestion|null, threshold?: number, name?: string}} [arg0]
     * @returns {EvalScorer}
     */
    decision: ({ ask = null, question = null, threshold = LIMITS.decision_gate_threshold, name = 'decision' } = {}) => {
        if (typeof ask !== 'function') throw new ConfigurationError({ message: 'EVAL_SCORERS.decision requires an ask function from the decision surface.', options: { option: 'ask' } });
        if (question === null) throw new ConfigurationError({ message: 'EVAL_SCORERS.decision requires a noul question.', options: { option: 'question' } });
        const gate = createDecisionGate({ ask: /** @type {any} */ (ask), threshold, seam: 'evals.decision' });
        return async ({ observation, signal = null }) => {
            if (!observation.output) return skipped({ name });
            const result = await gate.gate({ state: { output: observation.output }, question, signal });
            if (result.escalated || result.verdict === null) {
                return { name, passed: true, skipped: true, evidence: 'decision gate escalated; needs an LLM judge' };
            }
            return { name, passed: result.verdict, score: result.certainty ?? undefined, evidence: 'certainty=' + String(result.certainty) };
        };
    },
});
