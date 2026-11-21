// @ts-check


/**
 * @file LLM completion judge factory — the "optional model reviewer" half of
 * the verification story. Deterministic criteria (`contract.criteria`) gate;
 * this judge adds semantic review on top, reusing the same structured-LLM-call
 * path as WorkflowPlanner/WorkflowEvaluator.
 * @version 0.12.0
 */
import { structuredLlmCall } from '../planning/planner-utils.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import { z } from 'zod';

export const JUDGE_SCHEMA = z.strictObject({
    passed: z.boolean(),
    evidence: z.string()
});


/**
 * Returns `(ctx) => ({ passed, evidence })` ready for a LoopContract `judge`.
 * @param {{client: object, model: string, criteria?: Array<{name: string}>}} arg0
 * @returns {(arg0: {ctx: {getAll: () => Record<string, unknown>}, signal?: AbortSignal|null}) => Promise<{passed: boolean, evidence: string}>}
 */
export function createLlmJudge({ client, model, criteria = [] }) {
    const criteriaBlock = criteria.length
        ? `\nAcceptance criteria:\n${criteria.map((c) => `- ${c.name}`).join('\n')}`
        : '';
    return async ({ ctx, signal = null }) => {
        const result = await structuredLlmCall({
            client,
            model,
            systemMessage: 'You are a strict acceptance judge. Decide whether the final state satisfies the task objective.',
            schema: JUDGE_SCHEMA,
            prompt: `Evaluate the final state against the objective${criteriaBlock}.\n\nFinal state:\n${JSON.stringify(ctx.getAll(), null, 2)}\n\nReturn JSON: { "passed": boolean, "evidence": string }.`,
            label: 'Completion judge',
            schemaName: 'acceptance_judge',
            signal: signal ?? undefined
        });
        const judged =  (result);
        return { passed: !!judged.passed, evidence: judged.evidence ?? JSON.stringify(result) };
    };
}


/**
 * A typed, scored grader. Same structured-LLM path as createLlmJudge (so the
 * caller-supplied `schema` is validated by structuredLlmCall — a non-conforming
 * response is rejected, not silently accepted), but returns the full score
 * object instead of collapsing to {passed}. The returned judge carries an
 * `aggregate(scores)` reducer for combining several judges deterministically:
 * the default is the mean of the numeric `scoreField`, and an `aggregate`
 * override receives the raw scores array.
 * @param {{client: object, model: string, schema: object, systemMessage?: string, scoreField?: string, aggregate?: (arg0: { scores: Array<object> }) => number}} arg0
 * @returns {Function} `async (ctx) => scoreObject`, with `.aggregate(scores)` attached
 */
export function createScoredJudge({ client, model, schema, systemMessage, scoreField = 'score', aggregate }) {
    if (!schema) throw new ConfigurationError({ message: 'createScoredJudge requires a schema', options: { option: 'schema' } });
    /** @param {{ctx: *, signal?: *}} arg0 */
    const judge = async ({ ctx, signal = null }) => structuredLlmCall({
        client,
        model,
        systemMessage: systemMessage ?? 'You are a strict grader. Score the final state against the objective.',
        schema: /** @type {import('../../support/json.mjs').SchemaLike} */ (schema),
        prompt: `Score the final state against the objective.\n\nFinal state:\n${JSON.stringify(ctx.getAll(), null, 2)}\n\nReturn JSON matching the schema.`,
        label: 'Scored judge',
        schemaName: 'scored_judge',
        signal: signal ?? undefined
    });
    judge.scoreField = scoreField;
    judge.aggregate = /** @type {(...args: any[]) => any} */ (( scores) => typeof aggregate === 'function'
        ? aggregate({ scores: /** @type {object[]} */ (scores) })
        : meanBy({ scores, field: scoreField }));
    return judge;
}


/**
 * Returns null when no usable score exists (caller decides how to treat that).
 * @param {{scores: Array<Record<string, unknown>>, field: string}} arg0 -
 * @returns {number|null}
 */
function meanBy({ scores, field }) {
    const values = (scores ?? []).map(s => Number(s?.[field])).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
