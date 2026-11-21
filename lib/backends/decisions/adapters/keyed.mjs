// @ts-check
/**
 * @file Keyed decision wire adapter — OpenRouter `POST /api/alpha/decisions`.
 * @version 0.23.0
 *
 * @description
 * The keyed envelope is the System One shape: the evidence is `state` (string,
 * object or an array of media parts), `questions` is an OBJECT keyed by the
 * caller's names, a yes/no question is `noul`, and every answer comes back
 * under the same key. TypeSafe's own `/v1/systemone` speaks this same body, so
 * a second provider is a second descriptor here, not a second translator.
 *
 * The endpoint lives OUTSIDE the `/api/v1` base the OpenRouter chat client uses,
 * which is why the adapter reads the origin instead of joining a path.
 */

import { BackendError } from '../../../core/errors.mjs';
import { isRecordObject } from '../../../support/validation.mjs';
import { assertWireLimit, numberOrNull, readKeyedAnswer } from './decisions-common.mjs';

/**
 * Jev's caps: 255 options, 10 rubric levels.
 * @type {{options: number, levels: number}}
 */
const CAPS = { options: 255, levels: 10 };

/**
 * @type {import('./decisions-common.mjs').DecisionsAdapter}
 */
export const openrouterDecisionsAdapter = {
    id: 'openrouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',

    endpoint({ baseURL }) {
        return `${new URL(baseURL).origin}/api/alpha/decisions`;
    },

    auth({ apiKey }) {
        return { name: 'Authorization', value: `Bearer ${apiKey}` };
    },

    buildBody: keyedBody,

    readAnswers: keyedAnswers,
};

/**
 * OpenCode sells the same keyed wire on its own path (`/zen/v1/systemone`,
 * Console: `/inference/systemone/v1/systemone`) with `jev-1.13`,
 * `jev-1.13-free`, `gpt-6-luna-decision` and `gemini-decision-1`.
 *
 * The chat client's default base is the Go tier (`/zen/go/v1`), which is not
 * where Jev is sold, so an unrecognized base maps to the documented Zen path
 * instead of appending `/systemone` to a tier that has no such model.
 *
 * @type {import('./decisions-common.mjs').DecisionsAdapter}
 */
export const opencodeDecisionsAdapter = {
    id: 'opencode',
    defaultBaseURL: 'https://opencode.ai/zen/v1',

    endpoint({ baseURL }) {
        const url = new URL(baseURL);
        const path = url.pathname.replace(/\/+$/, '');
        if (path.endsWith('/zen/v1') || path.endsWith('/inference/systemone/v1')) {
            return `${url.origin}${path}/systemone`;
        }
        return `${url.origin}/zen/v1/systemone`;
    },

    auth({ apiKey }) {
        return { name: 'Authorization', value: `Bearer ${apiKey}` };
    },

    buildBody: keyedBody,

    readAnswers: keyedAnswers,
};

/**
 * The keyed envelope: `state` + `questions{}`, one answer per key. OpenRouter
 * and OpenCode differ only in endpoint, so both adapters share this body and
 * answer reader.
 * @param {{request: import('../../../messaging/decision.mjs').DecisionRequest}} arg0
 * @returns {Record<string, unknown>}
 */
function keyedBody({ request }) {
    for (const [name, question] of Object.entries(request.questions)) {
        if (question.type === 'choice') {
            assertWireLimit({ count: Object.keys(question.criteria).length, min: 2, max: CAPS.options, what: `options in '${name}'`, wire: 'The keyed decisions wire' });
        }
        if (question.type === 'score') {
            assertWireLimit({ count: question.criteria.length, min: 2, max: CAPS.levels, what: `levels in '${name}'`, wire: 'The keyed decisions wire' });
        }
    }
    return {
        model: request.model,
        state: request.state,
        // OpenRouter validates `criteria` as an object when present, so a noul
        // without criteria must omit the key instead of sending null.
        questions: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, keyedQuestion({ question })])),
    };
}

/**
 * @param {{question: import('../../../messaging/decision.mjs').DecisionQuestion}} arg0
 * @returns {Record<string, unknown>}
 */
function keyedQuestion({ question }) {
    if (question.type === 'noul' && question.criteria === null) {
        return { type: question.type, instructions: question.instructions };
    }
    return question;
}

/**
 * @param {{body: unknown}} arg0
 * @returns {{model: string|null, answers: Record<string, import('../../../messaging/decision.mjs').DecisionAnswer>, usage: {inputTokens: number|null, outputTokens: number|null, cost: number|null}}}
 */
function keyedAnswers({ body }) {
    const record = /** @type {Record<string, any>} */ (body);
    if (!isRecordObject(record.answers)) {
        throw new BackendError({ message: 'The keyed decision response has no answers object.' });
    }
    return {
        model: typeof record.model === 'string' ? record.model : null,
        answers: Object.fromEntries(Object.entries(record.answers).map(([name, answer]) => [name, readKeyedAnswer({ name, answer })])),
        usage: readUsage({ usage: record.usage }),
    };
}

/**
 * @param {{usage: unknown}} arg0
 * @returns {{inputTokens: number|null, outputTokens: number|null, cost: number|null}}
 */
function readUsage({ usage }) {
    const record = isRecordObject(usage) ? usage : {};
    return {
        inputTokens: numberOrNull(record.input_tokens),
        outputTokens: numberOrNull(record.output_tokens),
        cost: numberOrNull(record.cost),
    };
}
