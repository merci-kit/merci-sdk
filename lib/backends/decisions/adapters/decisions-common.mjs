// @ts-check
/**
 * @file Shared helpers for the decision wire adapters.
 * @version 0.23.0
 *
 * @description
 * The three wires disagree on the envelope, not on the idea: they all name a
 * state, a map of typed questions, and one answer per question. These are the
 * pieces every adapter needs, so a wire file only holds what is specific to it.
 */

import { configurationError, BackendError } from '../../../core/errors.mjs';
import { isRecordObject } from '../../../support/validation.mjs';

/**
 * Wires that take text evidence (OpenAI, Gemini) need the state serialized;
 * OpenRouter takes the object as-is. `buildDecisionRequest` already refused
 * arrays and empty strings.
 *
 * shortcut: a structured state is JSON text, not OpenAI's `input_json` part or
 * Gemini's concatenated text blocks; upgrade when prompt fidelity on structured
 * evidence matters more than one portable serialization.
 * @param {{state: string|Record<string, unknown>}} arg0
 * @returns {string}
 */
export function serializeState({ state }) {
    return typeof state === 'string' ? state : JSON.stringify(state);
}

/**
 * A vendor number, or `null`. Every wire omits `confidence` somewhere
 * (OpenAI's `predicate`, the keyed `noul`), so a missing number is data, not a
 * defect.
 * @param {unknown} value
 * @returns {number|null}
 */
export function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A per-wire request cap, refused before the call instead of by a 400.
 * @param {{count: number, min: number, max: number, what: string, wire: string}} arg0
 * @returns {void}
 */
export function assertWireLimit({ count, min, max, what, wire }) {
    if (count < min || count > max) {
        throw configurationError({ option: 'questions', message: `${wire} accepts ${min}-${max} ${what}; this request has ${count}.` });
    }
}

/**
 * Normalizes one answer of a keyed response (`questions` is an object keyed by
 * name, which OpenRouter, TypeSafe and Gemini all return).
 * @param {{name: string, answer: unknown}} arg0
 * @returns {import('../../../messaging/decision.mjs').DecisionAnswer}
 */
export function readKeyedAnswer({ name, answer }) {
    if (!isRecordObject(answer) || typeof answer.type !== 'string') {
        throw new BackendError({ message: `The decision answer for '${name}' is not a typed answer.` });
    }
    const typed = /** @type {Record<string, any>} */ (answer);
    switch (typed.type) {
        case 'noul': {
            const probability = numberOrNull(typed.noul);
            if (probability === null) throw new BackendError({ message: `The decision answer for '${name}' has no noul probability.` });
            return { type: 'noul', probability, confidence: numberOrNull(typed.confidence) };
        }
        case 'choice':
            if (typeof typed.choice !== 'string') throw new BackendError({ message: `The decision answer for '${name}' carries no choice.` });
            return { type: 'choice', choice: typed.choice, probabilities: isRecordObject(typed.probabilities) ? /** @type {Record<string, number>} */ (typed.probabilities) : {}, confidence: numberOrNull(typed.confidence) };
        case 'score':
            if (typeof typed.score !== 'number') throw new BackendError({ message: `The decision answer for '${name}' carries no score.` });
            return {
                type: 'score',
                score: typed.score,
                probabilities: isRecordObject(typed.probabilities) ? /** @type {Record<string, number>} */ (typed.probabilities) : {},
                legend: isRecordObject(typed.legend) ? /** @type {Record<string, string>} */ (typed.legend) : {},
                confidence: numberOrNull(typed.confidence),
            };
        case 'box':
            return { type: 'box', box: isRecordObject(typed.box) ? /** @type {Record<string, number>} */ (typed.box) : {}, confidence: numberOrNull(typed.confidence) };
        default:
            throw new BackendError({ message: `The decision answer for '${name}' has unknown type '${typed.type}'.` });
    }
}

/**
 * The decision adapter contract — one member per wire difference.
 *
 * Every decision wire agrees on the job (one state, named typed questions, one
 * typed answer each) and disagrees on the envelope, the endpoint, the auth
 * header, the per-request caps, and the answer's field names. An adapter owns
 * exactly those differences, so the shared client never grows a provider branch.
 *
 * @typedef {Object} DecisionsAdapter
 * @property {string} id - The provider id this adapter serves.
 * @property {string} defaultBaseURL - Root used when the provider has none.
 * @property {(arg0: {baseURL: string}) => string} endpoint - The absolute request URL.
 * @property {(arg0: {apiKey: string}) => {name: string, value: string}} auth - The credential header.
 * @property {(arg0: {request: import('../../../messaging/decision.mjs').DecisionRequest}) => Record<string, unknown>} buildBody
 *   Canonical request to this wire's JSON body; also enforces this wire's caps.
 * @property {(arg0: {body: unknown}) => {model: string|null, answers: Record<string, import('../../../messaging/decision.mjs').DecisionAnswer>, usage: {inputTokens: number|null, outputTokens: number|null, cost: number|null}}} readAnswers
 *   This wire's JSON body to canonical answers.
 */

