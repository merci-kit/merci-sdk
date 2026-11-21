// @ts-check
/**
 * @file Pure helpers lifted out of WorkflowExecutor.
 * @version 0.12.0
 *
 * @description
 * The executor's stateless seams: a row cap, a schema check, the two
 * dependency checks, and the one attempt tail every engine ends a retryable
 * attempt with (schema retry, verify verdict, error recording). They take
 * every input as an argument, so the class keeps its state and the helpers
 * stay testable on their own. The stateful clusters (session groups, step
 * strategies, plan lifecycle) stay in the class: moving them would expose
 * private fields without changing behavior.
 */
import { extractAndParseJson } from '../../support/json.mjs';
import { truncateForPrompt } from '../../support/utils.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { EVENTS } from '../../core/events.mjs';
import { BudgetExceededError, VerificationError, isAbortError } from '../../core/errors.mjs';
import { schemaCorrection, assertVerifyVerdict } from '../agentic-core.mjs';
import { stateSchemaViolation } from './graph-utils.mjs';
import { noulQuestion } from '../../messaging/decision.mjs';

/** @typedef {import('../../core/events.mjs').RunContext} RunContext */
/** @typedef {import('./executor.mjs').WorkflowStep} WorkflowStep */

/**
 * Caps one conversation row's text without changing its shape.
 * @param {{row: import('../chat-session.mjs').ChatRow, cap: number}} arg0
 * @returns {import('../chat-session.mjs').ChatRow}
 */
export function capSessionRow({ row, cap }) {
    const limit = Math.max(LIMITS.row_cap_floor, cap);
    const content = row?.content;
    if (typeof content === 'string') {
        return { ...row, content: truncateForPrompt({ text: content, maxChars: limit }) };
    }
    if (Array.isArray(content)) {
        return {
            ...row,
            content: content.map((/** @type {any} */ block) => (block && typeof block.text === 'string'
                ? { ...block, text: truncateForPrompt({ text: block.text, maxChars: limit }) }
                : block)),
        };
    }
    return row;
}

/**
 * Returns a VerificationError when the step's output violates `schema`, else null.
 * @param {{schema: unknown, node: {id: string}, result: unknown}} arg0
 * @returns {Error|null}
 */
export function schemaViolation({ schema, node, result }) {
    if (!schema) return null;
    const parsed = /** @type {{success: boolean, data: any}} */ (extractAndParseJson({ input: /** @type {any} */ (result) }));
    const value = parsed.success ? parsed.data : result;
    return stateSchemaViolation({ schema, value, label: `Step [${node.id}]` });
}

/**
 * `stepId→dep` pairs whose dependency names nothing in the new plan and no
 * known step in the run. `knownSteps` is either the run's step map — where a
 * dep counts only when that step reached `completed` — or a set of ids, where
 * any member counts as satisfied.
 * @param {{steps: Array<{id: string, dependencies?: Array<string>}>, knownSteps: Map<string, {status?: string}>|Set<string>}} arg0
 * @returns {string[]}
 */
export function danglingDependencies({ steps, knownSteps }) {
    const incoming = new Set(steps.map((step) => step.id));
    /** @type {string[]} */
    const dangling = [];
    for (const step of steps) {
        for (const dep of step.dependencies ?? []) {
            if (incoming.has(dep)) continue;
            const satisfied = knownSteps instanceof Set
                ? knownSteps.has(dep)
                : knownSteps.get(dep)?.status === 'completed';
            if (satisfied) continue;
            dangling.push(`${step.id}→${dep}`);
        }
    }
    return dangling;
}

/**
 * One schema-violation retry, shared by the four engines: emits the retry
 * notice and returns the correction for the next attempt's prompt. Rethrows
 * the same `VerificationError` once the retries are spent.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, attempt: number, maxRetries: number, error: Error, stepCtx: RunContext}} arg0
 * @returns {string}
 */
export function retrySchemaViolation({ host, node, attempt, maxRetries, error, stepCtx }) {
    if (attempt >= maxRetries) throw error;
    stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL, payload: {
        stepId: node.id,
        attempt,
        evidence: `stateSchema: ${error.message} — retrying (attempt ${attempt + 1}/${maxRetries + 1})`
    } });
    return schemaCorrection({ detail: error.message });
}

/**
 * One verify-verdict tail, shared by the four engines. A pass emits
 * `STEP_VERIFY_PASS` and returns null (nothing left to retry); a failure
 * emits `STEP_VERIFY_FAIL` and returns its evidence for the next attempt, or
 * throws `VerificationError` when the retries are spent. A verdict without a
 * boolean `passed` is a `ConfigurationError` (D-2), never a pass.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, attempt: number, maxRetries: number, verdict: {passed: boolean, evidence?: string}, stepCtx: RunContext}} arg0
 * @returns {string|undefined|null}
 */
export function retryVerification({ host, node, attempt, maxRetries, verdict, stepCtx }) {
    assertVerifyVerdict({ verdict, label: `Step [${node.id}]` });
    if (verdict.passed) {
        stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_PASS, payload: { stepId: node.id, attempt, evidence: verdict.evidence ?? '' } });
        return null;
    }
    if (attempt >= maxRetries) {
        throw new VerificationError({ message: `Step [${node.id}] failed verification after ${maxRetries + 1} attempt(s): ${verdict.evidence ?? 'no evidence'}`, options: {
            stepId: node.id,
            evidence: verdict.evidence ?? 'no evidence',
            attempts: attempt + 1
        } });
    }
    stepCtx.emit({ emitter: host, name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL, payload: { stepId: node.id, attempt, evidence: verdict.evidence ?? '' } });
    return verdict.evidence;
}

/**
 * The whole-method catch of every engine: a budget stop and an abort the
 * step did not cause propagate, everything else is recorded as the step's
 * failure so the run can continue.
 * @param {{host: import('./executor.mjs').WorkflowExecutor, node: WorkflowStep, err: unknown, stepCtx?: RunContext}} arg0
 */
export function recordOrRethrow({ host, node, err, stepCtx }) {
    if (err instanceof BudgetExceededError) throw err;
    if (!node._timedOut && isAbortError({ err, signal: host.signal })) throw err;
    host._recordStepError({ node, err, stepCtx });
}

/**
 * One decision-gate verdict on a completed step (the evaluator-outage seam).
 * A gate error is already contained by the gate (escalated); an abort still
 * propagates from it.
 * @param {{gate: import('../decision-gate.mjs').DecisionGate|null|undefined, node: {id: string, title?: string, output?: unknown}, outputs: Record<string, unknown>, objective?: string|null, signal?: AbortSignal|null}} arg0
 * @returns {Promise<{verdict: boolean|null, certainty: number|null, usage: import('../decision-gate.mjs').DecisionUsage|null, stateChars: number}|null>} null when no gate is available.
 */
export async function decisionStepVerdict({ gate, node, outputs, objective = null, signal = null }) {
    if (!gate?.available) return null;
    const state = { objective, stepId: node.id, stepTitle: node.title ?? node.id, output: node.output, context: outputs };
    // Same rule as the evaluator: no skip on an empty or truncated state. A
    // circular sibling output must fall back to the outage path, not throw
    // inside its catch and turn "ship unverified" into a failed run.
    if (typeof node.output !== 'string' || node.output.trim() === '') return null;
    let serialized;
    try {
        serialized = JSON.stringify(state);
    } catch {
        return null;
    }
    if (serialized.length > LIMITS.decision_state_max_chars) return null;
    const result = await gate.gate({
        state,
        question: noulQuestion({
            instructions: 'Does this step output satisfy the step objective and provide the evidence it claims?',
            criteria: {
                true: 'The output satisfies the objective and its claims are supported.',
                false: 'The output misses the objective, is empty, or claims evidence it does not contain.',
            },
        }),
        signal,
    });
    return { verdict: result.verdict, certainty: result.certainty, usage: result.usage ?? null, stateChars: result.stateChars ?? 0 };
}


/**
 * The tokens one decision-gate call cost, from the wire usage or the state size.
 * The executor charges this to its own cap, so a decision call cannot hide from
 * `remainingBudget()`.
 * @param {{result?: {usage?: import('../decision-gate.mjs').DecisionUsage|null, stateChars?: number}|null}} arg0
 * @returns {number}
 */
export function decisionTokensOf({ result = null }) {
    const reported = Number(result?.usage?.inputTokens ?? 0) + Number(result?.usage?.outputTokens ?? 0);
    if (Number.isFinite(reported) && reported > 0) return reported;
    return Math.ceil(Math.max(0, Number(result?.stateChars ?? 0)) / 4);
}
