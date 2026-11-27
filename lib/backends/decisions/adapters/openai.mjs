// @ts-check
/**
 * @file OpenAI Decisions wire adapter — `POST /v1/decisions`.
 * @version 0.23.0
 *
 * @description
 * OpenAI's envelope is the odd one out: the evidence is `input`, the questions
 * are an ARRAY with a `name` per entry, a yes/no question is called
 * `predicate`, options are `choices[{value, description}]`, rubric levels are
 * `levels[{label, description}]`, and the answers come back as an ARRAY whose
 * `probabilities` are an array too. `client.decisions` speaks the canonical
 * model; this file is the whole translation.
 */

import { BackendError } from '../../../core/errors.mjs';
import { isRecordObject } from '../../../support/validation.mjs';
import { joinUrl } from '../../transport/http.mjs';
import { assertWireLimit, numberOrNull, readUsage, serializeState } from './decisions-common.mjs';

/**
 * OpenAI's per-request caps.
 * @type {{questions: number, options: number, levels: number}}
 */
const CAPS = { questions: 400, options: 255, levels: 10 };

/**
 * The canonical type to the OpenAI type.
 * @type {Record<string, string>}
 */
const WIRE_TYPE = { noul: 'predicate', choice: 'choice', score: 'score' };

/**
 * @type {import('./decisions-common.mjs').DecisionsAdapter}
 */
export const openaiDecisionsAdapter = {
    id: 'openai',
    defaultBaseURL: 'https://api.openai.com/v1',

    endpoint({ baseURL }) {
        return joinUrl({ baseURL, path: '/decisions' });
    },

    auth({ apiKey }) {
        return { name: 'Authorization', value: `Bearer ${apiKey}` };
    },

    buildBody({ request }) {
        const entries = Object.entries(request.questions);
        assertWireLimit({ count: entries.length, min: 1, max: CAPS.questions, what: 'questions', wire: 'OpenAI Decisions' });
        return {
            model: request.model,
            input: serializeState({ state: request.state }),
            questions: entries.map(([name, question]) => {
                const base = { type: WIRE_TYPE[question.type], name, instructions: question.instructions };
                if (question.type === 'choice') {
                    const options = Object.entries(question.criteria);
                    assertWireLimit({ count: options.length, min: 2, max: CAPS.options, what: 'options', wire: 'OpenAI Decisions' });
                    return { ...base, choices: options.map(([value, description]) => ({ value, description })) };
                }
                if (question.type === 'score') {
                    assertWireLimit({ count: question.criteria.length, min: 2, max: CAPS.levels, what: 'levels', wire: 'OpenAI Decisions' });
                    return { ...base, levels: question.criteria.map((label) => ({ label })) };
                }
                return base;
            }),
        };
    },

    readAnswers({ body }) {
        const answers = /** @type {Record<string, any>} */ (body).answers;
        if (!Array.isArray(answers)) {
            throw new BackendError({ message: 'The OpenAI decision response has no answers array.' });
        }
        return {
            model: /** @type {Record<string, any>} */ (body).model ?? null,
            answers: Object.fromEntries(answers.map((answer) => [answer?.name, readWireAnswer({ answer })])),
            usage: readUsage({ usage: /** @type {Record<string, any>} */ (body).usage }),
        };
    },
};

/**
 * One array answer to the canonical shape. The array is where OpenAI reports a
 * refusal, so it stays visible instead of becoming a missing key.
 * @param {{answer: unknown}} arg0
 * @returns {import('../../../messaging/decision.mjs').DecisionAnswer}
 */
function readWireAnswer({ answer }) {
    if (!isRecordObject(answer) || typeof answer.name !== 'string') {
        throw new BackendError({ message: 'An OpenAI decision answer carries no question name.' });
    }
    const typed = /** @type {Record<string, any>} */ (answer);
    const confidence = numberOrNull(typed.confidence);
    switch (typed.type) {
        case 'predicate':
            return { type: 'noul', probability: requiredNumber({ value: typed.probability, name: typed.name }), confidence };
        case 'choice':
            if (typeof typed.choice !== 'string') {
                throw new BackendError({ message: `The OpenAI choice answer for '${typed.name}' carries no choice.` });
            }
            return { type: 'choice', choice: typed.choice, probabilities: probabilityMap({ list: typed.probabilities }), confidence };
        case 'score':
            return { type: 'score', score: requiredNumber({ value: typed.score, name: typed.name }), probabilities: probabilityMap({ list: typed.probabilities }), legend: legendMap({ list: typed.probabilities }), confidence };
        case 'refusal':
            return { type: 'refusal', confidence: null };
        default:
            throw new BackendError({ message: `The OpenAI decision answer for '${typed.name}' has unknown type '${String(typed.type)}'.` });
    }
}

/**
 * @param {{value: unknown, name: string}} arg0
 * @returns {number}
 */
function requiredNumber({ value, name }) {
    const number = numberOrNull(value);
    if (number === null) {
        throw new BackendError({ message: `The OpenAI decision answer for '${name}' has no numeric result.` });
    }
    return number;
}

/**
 * OpenAI reports a distribution as `[{value, probability}]`; the canonical
 * shape keys it by value.
 * @param {{list: unknown}} arg0
 * @returns {Record<string, number>}
 */
function probabilityMap({ list }) {
    if (!Array.isArray(list)) return {};
    /** @type {Record<string, number>} */
    const map = {};
    for (const entry of list) {
        if (!isRecordObject(entry) || typeof entry.probability !== 'number') continue;
        map[String(entry.value)] = entry.probability;
    }
    return map;
}

/**
 * @param {{list: unknown}} arg0
 * @returns {Record<string, string>}
 */
function legendMap({ list }) {
    if (!Array.isArray(list)) return {};
    /** @type {Record<string, string>} */
    const map = {};
    for (const entry of list) {
        if (!isRecordObject(entry) || typeof entry.label !== 'string') continue;
        map[String(entry.value)] = entry.label;
    }
    return map;
}
