// @ts-check
/**
 * @file Canonical decision envelope — the question/answer model every
 * discriminative ("System One") wire projects onto.
 * @version 0.23.0
 *
 * @description
 * A decision model reads one shared `state` and answers named, typed questions
 * with calibrated probabilities instead of text. Three vendors ship that idea
 * in three envelopes (OpenAI `input` + `questions[]`, the keyed `state` +
 * `questions{}` of OpenRouter / TypeSafe, Gemini `input` + `questions{}`), so
 * this module owns the ONE shape a caller writes and reads, and
 * `lib/backends/decisions/adapters/` owns the translation to each wire.
 *
 * Two rules the canonical answer encodes once for every provider:
 * - Every answer carries `type`; check it before reading a field, because a
 *   key or a type that does not match is a vendor defect, not a default.
 * - `confidence` is always present and is `number|null`: OpenAI's `predicate`
 *   and the keyed `noul` answer report no confidence at all.
 */

import { configurationError, BackendError } from '../core/errors.mjs';
import { isPlainObject, isRecordObject } from '../support/validation.mjs';

/**
 * The question types every decision wire recognizes.
 * @type {{NOUL: 'noul', CHOICE: 'choice', SCORE: 'score'}}
 */
export const DECISION_QUESTION_TYPE = Object.freeze({
    NOUL: 'noul',
    CHOICE: 'choice',
    SCORE: 'score',
});

/**
 * A yes/no question: the probability that a statement is true.
 * @typedef {Object} NoulQuestion
 * @property {'noul'} type
 * @property {string} instructions - The statement to judge, in full.
 * @property {{true?: string, false?: string}|null} [criteria] - What counts as yes and no.
 */

/**
 * One option from a defined set.
 * @typedef {Object} ChoiceQuestion
 * @property {'choice'} type
 * @property {string} instructions - The judgment that picks one option.
 * @property {Record<string, string>} criteria - Option name to when it applies (2..255).
 */

/**
 * A position on an ordered rubric; level descriptions start at zero.
 * @typedef {Object} ScoreQuestion
 * @property {'score'} type
 * @property {string} instructions - The dimension being rated.
 * @property {Array<string>} criteria - Level descriptions, lowest first (2..255).
 */

/** @typedef {NoulQuestion|ChoiceQuestion|ScoreQuestion} DecisionQuestion */

/**
 * The caller-facing request: one state, named questions, one model.
 * @typedef {Object} DecisionRequest
 * @property {string} model
 * @property {string|Record<string, unknown>} state
 * @property {Record<string, DecisionQuestion>} questions
 */

/**
 * A normalized answer. `confidence` is `null` when the wire does not report it.
 * @typedef {Object} DecisionAnswer
 * @property {'noul'|'choice'|'score'|'box'|'refusal'} type
 * @property {number|null} [probability] - `noul` only; a wire may answer null.
 * @property {string|number} [choice] - `choice` only.
 * @property {Record<string, number>} [probabilities]
 * @property {number} [score] - `score` only.
 * @property {Record<string, string>} [legend] - `score` only.
 * @property {number|null} [confidence]
 * @property {Record<string, number>} [box]
 */

/**
 * @typedef {Object} DecisionResult
 * @property {string} model - The build that answered, as the vendor reported it.
 * @property {Record<string, DecisionAnswer>} answers - Keyed by question name.
 * @property {{inputTokens: number|null, outputTokens: number|null, cost: number|null}} usage
 */

/**
 * Question names are opaque to the model and are validated by every wire.
 * @type {RegExp}
 */
const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Builds a yes/no question. Validation happens once, in
 * {@link buildDecisionRequest}, so a factory never rejects a shape the caller
 * may still be assembling.
 * @param {{instructions?: string, criteria?: {true?: string, false?: string}|null}} [arg0]
 * @returns {NoulQuestion}
 */
export function noulQuestion({ instructions = '', criteria = null } = {}) {
    return { type: DECISION_QUESTION_TYPE.NOUL, instructions, criteria };
}

/**
 * @param {{instructions?: string, criteria?: Record<string, string>}} [arg0]
 * @returns {ChoiceQuestion}
 */
export function choiceQuestion({ instructions = '', criteria = {} } = {}) {
    return { type: DECISION_QUESTION_TYPE.CHOICE, instructions, criteria };
}

/**
 * @param {{instructions?: string, criteria?: Array<string>}} [arg0]
 * @returns {ScoreQuestion}
 */
export function scoreQuestion({ instructions = '', criteria = [] } = {}) {
    return { type: DECISION_QUESTION_TYPE.SCORE, instructions, criteria };
}

/**
 * Validates one request and returns it unchanged. This is the trust boundary
 * every adapter relies on: a shape that reaches an adapter has a non-empty
 * model, a serializable state, and at least one well-formed question.
 * @param {{model?: string, state?: unknown, questions?: unknown}} [arg0]
 * @returns {DecisionRequest}
 * @throws {import('../core/errors.mjs').ConfigurationError} On any caller error.
 */
export function buildDecisionRequest({ model, state, questions } = {}) {
    if (typeof model !== 'string' || model.trim() === '') {
        throw configurationError({ option: 'model', message: 'A decision request needs a model: decision catalogs change, so the SDK never picks one for you.' });
    }
    const isTextState = typeof state === 'string';
    if (!isTextState && !isPlainObject(state)) {
        throw configurationError({
            option: 'state',
            message: 'Decision state must be a string or a plain object. Media content blocks are not supported yet: serialize the evidence to text or JSON.',
        });
    }
    if (isTextState && /** @type {string} */ (state).trim() === '') {
        throw configurationError({ option: 'state', message: 'Decision state must not be empty.' });
    }
    if (!isRecordObject(questions) || Object.keys(questions).length === 0) {
        throw configurationError({ option: 'questions', message: 'A decision request needs at least one named question.' });
    }
    for (const [name, question] of Object.entries(questions)) {
        validateQuestion({ name, question });
    }
    return { model, state: /** @type {string|Record<string, unknown>} */ (state), questions: /** @type {Record<string, DecisionQuestion>} */ (questions) };
}

/**
 * @param {{name: string, question: unknown}} arg0
 * @returns {void}
 */
function validateQuestion({ name, question }) {
    if (!QUESTION_KEY.test(name)) {
        throw configurationError({ option: 'questions', message: `Question name '${name}' is invalid: use 1-64 characters from A-Z, a-z, 0-9, '_' and '-'.` });
    }
    if (!isPlainObject(question)) {
        throw configurationError({ option: 'questions', message: `Question '${name}' must be an object.` });
    }
    const shaped = /** @type {{type?: unknown, instructions?: unknown, criteria?: unknown}} */ (question);
    const type = shaped.type;
    if (type !== DECISION_QUESTION_TYPE.NOUL && type !== DECISION_QUESTION_TYPE.CHOICE && type !== DECISION_QUESTION_TYPE.SCORE) {
        throw configurationError({ option: 'questions', message: `Question '${name}' has unknown type '${String(type)}'. Supported: noul, choice, score.` });
    }
    if (typeof shaped.instructions !== 'string' || shaped.instructions.trim() === '') {
        throw configurationError({ option: 'questions', message: `Question '${name}' needs non-empty instructions: the model never sees the question name.` });
    }
    if (type === DECISION_QUESTION_TYPE.NOUL) {
        const criteria = shaped.criteria ?? null;
        if (criteria === null) return;
        if (!isRecordObject(criteria) || Object.keys(criteria).some((key) => key !== 'true' && key !== 'false')) {
            throw configurationError({ option: 'questions', message: `Question '${name}' criteria must be null or { true, false }.` });
        }
        for (const value of Object.values(criteria)) {
            if (typeof value !== 'string') {
                throw configurationError({ option: 'questions', message: `Question '${name}' criteria must map true and false to strings.` });
            }
        }
        return;
    }
    if (type === DECISION_QUESTION_TYPE.CHOICE) {
        if (!isRecordObject(shaped.criteria) || Object.keys(shaped.criteria).length < 2) {
            throw configurationError({ option: 'questions', message: `Question '${name}' needs at least two named options in criteria.` });
        }
        for (const value of Object.values(shaped.criteria)) {
            if (typeof value !== 'string') {
                throw configurationError({ option: 'questions', message: `Question '${name}' criteria must map each option to a description string.` });
            }
        }
        return;
    }
    if (!Array.isArray(shaped.criteria) || shaped.criteria.length < 2) {
        throw configurationError({ option: 'questions', message: `Question '${name}' needs at least two ordered level descriptions in criteria.` });
    }
    for (const level of shaped.criteria) {
        if (typeof level !== 'string' || level.trim() === '') {
            throw configurationError({ option: 'questions', message: `Question '${name}' needs every level description to be a non-empty string.` });
        }
    }
}

/**
 * Reads one answer from a result, refusing a missing key or a type the caller
 * did not expect. A schema-valid answer can still be the wrong label; this
 * guard covers the structural half only.
 * @param {{answers?: Record<string, DecisionAnswer>|null, name?: string, type?: string|null}} [arg0]
 * @returns {DecisionAnswer}
 * @throws {BackendError} When the vendor omitted the answer or changed its type.
 */
export function readDecisionAnswer({ answers = null, name = '', type = null } = {}) {
    if (!isRecordObject(answers) || !Object.hasOwn(answers, name)) {
        throw new BackendError({ message: `The decision response has no answer for '${name}'.` });
    }
    const answer = answers[name];
    if (!isRecordObject(answer) || typeof answer.type !== 'string') {
        throw new BackendError({ message: `The decision answer for '${name}' is not a typed answer.` });
    }
    if (type !== null && answer.type !== type) {
        throw new BackendError({ message: `The decision answer for '${name}' is '${answer.type}', not '${type}'.` });
    }
    return answer;
}
