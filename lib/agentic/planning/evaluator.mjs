// @ts-check
import { structuredLlmCall } from './planner-utils.mjs';
import {
    DAG_WORKFLOW_EVAL_SCHEMA,
    DAG_WORKFLOW_EVAL_PROMPT
} from '../../core/prompts.mjs';
import { noulQuestion } from '../../messaging/decision.mjs';
import { LIMITS } from '../../core/limit-config.mjs';

/**
 * @file WorkflowEvaluator — per-step output quality audit.
 * @version 0.12.0
 *
 * @description
 * Verifies a completed DAG step's output against the global objective through
 * a structured LLM call, returning { replanRequired, reason, ... }. An
 * evaluator outage THROWS (the executor's defer/re-check machinery is the
 * designed fallback — a swallowed error used to read as "verified OK"). A
 * confident decision-gate pass may skip the LLM call entirely.
 */

/**
 * The evaluator's options: the backend client, the model, and whether the
 * structured call uses tool capture.
 * @typedef {Object} EvaluatorOptions
 * @property {import('./planner-utils.mjs').StructuredClient} [client]
 * @property {string} [model]
 * @property {string} [structuredOutput] - 'tool' selects tool-capture mode.
 * @property {number} [timeoutMs] - Total deadline per evaluation attempt (ms). Defaults to the stream-timeout budget.
 * @property {import('../decision-gate.mjs').DecisionGate|null} [decisionGate] - Optional System One pre-check; a confident pass skips the LLM.
 * @property {((usage: Record<string, unknown>) => void)|null} [onUsage] - Reports each evaluation call's usage. The executor binds it to the workflow cap when the instance has none.
 */

/**
 * Structured LLM verifier for completed workflow steps.
 */
export class WorkflowEvaluator {
    /**
 * @param {{options?: EvaluatorOptions}} arg0
 */
    constructor({ options = {} } = {}) {
        this.client = options.client;
        this.model = options.model;
        this._useToolCapture = options.structuredOutput === 'tool';
        this._timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : undefined;
        this.decisionGate = options.decisionGate ?? null;
        /**
         * Each evaluation call's reported usage. Read live, so an executor can
         * bind it after construction (C-7); a caller-provided sink always wins.
         * @type {((usage: Record<string, unknown>) => void)|null}
         */
        this.onUsage = options.onUsage ?? null;
    }

    /**
 * Evaluates a completed step's output against the global objective.
 * Throws on evaluator outage — never returns a fabricated "verified OK".
 * @param {{node: {id: string, title?: string, output?: string}, outputs: Record<string, unknown>, objective?: string|null, signal?: AbortSignal|null, sessionId?: string|null}} arg0
 * @returns {Promise<{replanRequired: boolean, reason: string} & Record<string, unknown>>}
 */
    async evaluate({ node, outputs, objective = null, signal = null, sessionId = null }) {
        const gateState = { objective, stepId: node.id, stepTitle: node.title ?? node.id, output: node.output };
        // A skip needs the whole output: an empty or truncated state cannot justify
        // replacing the LLM verifier, so the LLM path handles it instead.
        const gateEligible = typeof node.output === 'string'
            && node.output.trim() !== ''
            && JSON.stringify(gateState).length <= LIMITS.decision_state_max_chars;
        if (this.decisionGate?.available && gateEligible) {
            const result = await this.decisionGate.gate({
                state: gateState,
                question: noulQuestion({
                    instructions: 'Does this step output satisfy the step objective and provide the evidence it claims?',
                    criteria: {
                        true: 'The output satisfies the objective and its claims are supported.',
                        false: 'The output misses the objective, is empty, or claims evidence it does not contain.',
                    },
                }),
                signal,
            });
            if (!result.escalated && result.verdict === true && result.certainty !== null && result.certainty >= LIMITS.decision_skip_certainty) {
                return { replanRequired: false, reason: 'decision_gate_pass', decision: { verdict: true, certainty: result.certainty } };
            }
        }
        return structuredLlmCall({
            // The executor wires a client before any evaluation runs; the option
            // stays optional because the evaluator is constructed with the plan.
            client: /** @type {import('./planner-utils.mjs').StructuredClient} */ (this.client),
            model: this.model,
            systemMessage: 'You are an expert Verification and Strategy Quality Auditor.',
            schema: DAG_WORKFLOW_EVAL_SCHEMA,
            prompt: DAG_WORKFLOW_EVAL_PROMPT({ stepId: node.id, output: /** @type {string} */ (node.output), context: outputs, objective }),
            label: `Evaluating outcome quality of step: [${node.id}]`,
            schemaName: 'workflow_evaluation',
            useToolCapture: this._useToolCapture,
            sessionId,
            signal,
            timeoutMs: this._timeoutMs,
            onUsage: this.onUsage,
        });
    }
}
