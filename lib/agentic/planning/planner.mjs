// @ts-check
import { structuredLlmCall, normalizePlanSteps } from './planner-utils.mjs';
import {
    DAG_WORKFLOW_PLAN_SCHEMA,
    DAG_WORKFLOW_REPLAN_SCHEMA,
    DAG_WORKFLOW_PLAN_PROMPT,
    DAG_WORKFLOW_REPLAN_PROMPT
} from '../../core/prompts.mjs';

/**
 * @file WorkflowPlanner — LLM DAG plan/replan.
 * @version 0.12.0
 *
 * @description
 * Plans a DAG workflow for an objective and re-plans after a failed/rejected
 * step, both through the shared structuredLlmCall path.
 */

/**
 * The options `new WorkflowPlanner(...)` takes: the client/model the structured
 * call runs on, whether structured output goes through a tool call, and the
 * total deadline for one planning attempt.
 * @typedef {Object} PlannerOptions
 * @property {Object|null} [client]
 * @property {string} [model]
 * @property {'tool'|'json'} [structuredOutput]
 * @property {number} [timeoutMs] - Total deadline per planning attempt (ms). Defaults to the stream-timeout budget.
 * @property {((usage: Record<string, unknown>) => void)|null} [onUsage] - Reports each planning call's usage. The executor binds it to the workflow cap when the instance has none.
 */

/**
 * LLM DAG planner: produces the step plan and the self-healing replan.
 */
export class WorkflowPlanner {
    /**
 * @param {{options?: PlannerOptions}} arg0
 */
    constructor({ options = {} } = {}) {
        /** @type {Object|null} */
        this.client = options.client ?? null;
        /** @type {string|undefined} */
        this.model = options.model;
        this._useToolCapture = options.structuredOutput === 'tool';
        this._timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : undefined;
        /**
         * Each planning call's reported usage. Read live, so an executor can bind
         * it after construction (C-7); a caller-provided sink always wins.
         * @type {((usage: Record<string, unknown>) => void)|null}
         */
        this.onUsage = options.onUsage ?? null;
    }

    /**
 * Plans a DAG workflow for the objective.
 * @param {{objective: string, availableTools?: Array<Object>, signal?: AbortSignal|null, sessionId?: string|null}} arg0
 * @returns {Promise<{steps: Array<Record<string, unknown>>} & Record<string, unknown>>} the parsed plan.
 */
    async plan({ objective, availableTools = [], signal = null, sessionId = null }) {
        const cleanTools = availableTools.map((rawTool) => {
            const t = /** @type {Record<string, unknown>} */ (rawTool);
            return {
                name: t.name,
                description: t.description,
                parameters: t.parameters || { type: 'object', properties: {} }
            };
        });
        const parsed = await structuredLlmCall({
            client: /** @type {import('./planner-utils.mjs').StructuredClient} */ (this.client),
            model: this.model,
            systemMessage: 'You are an expert Strategic DAG Workflow Planner.',
            schema: DAG_WORKFLOW_PLAN_SCHEMA,
            prompt: DAG_WORKFLOW_PLAN_PROMPT({ objective, toolsList: cleanTools }),
            label: `Planning workflow DAG for goal: "${objective}"`,
            useToolCapture: this._useToolCapture,
            sessionId,
            signal,
            timeoutMs: this._timeoutMs,
            onUsage: this.onUsage,
        });
        return { ...parsed, steps: normalizePlanSteps({ steps: parsed?.steps }) };
    }

    /**
 * Re-plans after a failed/rejected step, feeding the failure reason, the
 * other steps' outputs AND the live plan (ids/statuses/deps) back into the
 * planner — without the plan it rewrote blind and could silently delete
 * pending work or leave dangling dependencies (D5).
 * @param {{objective: string, failedStepId: string, failureReason: string, currentOutputs: Record<string, unknown>, signal?: AbortSignal|null, sessionId?: string|null, plan?: Array<Object>|null}} arg0
 * @returns {Promise<{steps: Array<Record<string, unknown>>} & Record<string, unknown>>} the revised plan.
 */
    async replan({ objective, failedStepId, failureReason, currentOutputs, signal = null, sessionId = null, plan = null }) {
        const planBlock = Array.isArray(plan) && plan.length > 0
            ? `\n\n=== Current Plan (live step statuses) ===\n${JSON.stringify(plan, null, 2)}\n\n=== Rewrite Rules ===\n1. Keep every step id unique and valid.\n2. Every dependency must name a step in your answer or a step already completed.\n3. Do not drop a pending step unless you replace its work — a dropped pending step is discarded.\n4. To retry the failed step unchanged, return the same id and definition.\n5. To replace the failed/rejected step, add the replacement step with "replaces": "<failed step id>"; the executor rewires its dependents onto it. A dependent that still names the rejected id without that declaration refuses the whole patch.`
            : '';
        const parsed = await structuredLlmCall({
            client: /** @type {import('./planner-utils.mjs').StructuredClient} */ (this.client),
            model: this.model,
            systemMessage: 'You are a Strategic Self-Healing Dynamic Replanner.',
            schema: DAG_WORKFLOW_REPLAN_SCHEMA,
            prompt: DAG_WORKFLOW_REPLAN_PROMPT({ objective, failedStepId, failureReason, currentOutputs }) + planBlock,
            label: `Replanning after step [${failedStepId}]: ${failureReason}`,
            useToolCapture: this._useToolCapture,
            sessionId,
            signal,
            timeoutMs: this._timeoutMs,
            onUsage: this.onUsage,
        });
        return { ...parsed, steps: normalizePlanSteps({ steps: parsed?.steps }) };
    }
}
