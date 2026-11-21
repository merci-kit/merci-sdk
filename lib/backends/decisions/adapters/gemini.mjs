// @ts-check
/**
 * @file Gemini Decisions wire adapter — `POST /v1beta/decisions`.
 * @version 0.23.0
 *
 * @description
 * Gemini takes `input` like OpenAI but keyed `questions` like the System One
 * shape, reports `usage.total_input_tokens` instead of `input_tokens`, and
 * authenticates with `x-goog-api-key` instead of a bearer token. Its only
 * envelope difference is the yes/no criteria names: `true_description` /
 * `false_description`, not `true` / `false`.
 *
 * Gemini Decision 1 is Gemini Developer API only, so the Vertex provider is not
 * wired to this adapter.
 */

import { BackendError } from '../../../core/errors.mjs';
import { isRecordObject } from '../../../support/validation.mjs';
import { joinUrl } from '../../transport/http.mjs';
import { assertWireLimit, numberOrNull, readKeyedAnswer, serializeState } from './decisions-common.mjs';

/**
 * Gemini's per-request caps.
 * @type {{questions: number, options: number, levels: number}}
 */
const CAPS = { questions: 1000, options: 255, levels: 255 };

/**
 * @type {import('./decisions-common.mjs').DecisionsAdapter}
 */
export const geminiDecisionsAdapter = {
    id: 'google_genai',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',

    endpoint({ baseURL }) {
        return joinUrl({ baseURL, path: '/v1beta/decisions' });
    },

    auth({ apiKey }) {
        return { name: 'x-goog-api-key', value: apiKey };
    },

    buildBody({ request }) {
        const entries = Object.entries(request.questions);
        assertWireLimit({ count: entries.length, min: 1, max: CAPS.questions, what: 'questions', wire: 'Gemini Decisions' });
        /** @type {Record<string, unknown>} */
        const questions = {};
        for (const [name, question] of entries) {
            if (question.type === 'choice') {
                assertWireLimit({ count: Object.keys(question.criteria).length, min: 2, max: CAPS.options, what: `options in '${name}'`, wire: 'Gemini Decisions' });
            }
            if (question.type === 'score') {
                assertWireLimit({ count: question.criteria.length, min: 2, max: CAPS.levels, what: `levels in '${name}'`, wire: 'Gemini Decisions' });
            }
            questions[name] = question.type === 'noul' ? toGeminiNoul({ question }) : question;
        }
        return { model: request.model, input: serializeState({ state: request.state }), questions };
    },

    readAnswers({ body }) {
        const record = /** @type {Record<string, any>} */ (body);
        if (!isRecordObject(record.answers)) {
            throw new BackendError({ message: 'The Gemini decision response has no answers object.' });
        }
        return {
            model: null,
            answers: Object.fromEntries(Object.entries(record.answers).map(([name, answer]) => [name, readKeyedAnswer({ name, answer })])),
            usage: readUsage({ usage: record.usage }),
        };
    },
};

/**
 * Gemini names the two sides of a yes/no question differently.
 * @param {{question: import('../../../messaging/decision.mjs').NoulQuestion}} arg0
 * @returns {Record<string, unknown>}
 */
function toGeminiNoul({ question }) {
    const criteria = question.criteria;
    if (!criteria) return { type: question.type, instructions: question.instructions };
    /** @type {Record<string, string>} */
    const renamed = {};
    if (typeof criteria.true === 'string') renamed.true_description = criteria.true;
    if (typeof criteria.false === 'string') renamed.false_description = criteria.false;
    return { type: question.type, instructions: question.instructions, criteria: renamed };
}

/**
 * @param {{usage: unknown}} arg0
 * @returns {{inputTokens: number|null, outputTokens: number|null, cost: number|null}}
 */
function readUsage({ usage }) {
    const record = isRecordObject(usage) ? usage : {};
    return {
        inputTokens: numberOrNull(record.total_input_tokens),
        outputTokens: numberOrNull(record.total_output_tokens),
        cost: null,
    };
}
