// @ts-check
/**
 * @file The shared decision gate — one System One call, one verdict.
 * @version 0.24.0
 *
 * @description
 * Wraps a bound decision surface (`ask`, from `createRoleClients`) into the
 * four shapes an agentic caller needs: a boolean verdict, a closed-world
 * choice, a score, and the certainty that says whether the answer may be
 * trusted. Below the threshold (or on any non-answer), the gate escalates to
 * the LLM path instead of guessing. Never throws on a backend failure; an
 * abort is the caller's own cancellation and is rethrown.
 *
 * `certainty` is the gate's single calibration primitive:
 *  - `noul`: `confidence`, else the distance of `probability` from 0.5
 *    (a 0.5 coin flip carries zero certainty, a 0.95 answer carries 0.95).
 *  - `choice`: `confidence`, else the top probability.
 *  - `score`: `confidence` (a score has no probability to calibrate).
 */

import { LIMITS } from '../core/limit-config.mjs';
import { ConfigurationError, isAbortError } from '../core/errors.mjs';
import { EVENTS, stampEvent } from '../core/events.mjs';

/** @typedef {import('../messaging/decision.mjs').DecisionAnswer} DecisionAnswer */
/** @typedef {import('../messaging/decision.mjs').DecisionQuestion} DecisionQuestion */
/** @typedef {{inputTokens?: number|null, outputTokens?: number|null, cost?: number|null}} DecisionUsage */
/**
 * What a bound decision surface answers: the canonical answers, plus whatever
 * usage the surface reported (absent when it reports none).
 * @typedef {{model?: string, answers: Record<string, Record<string, unknown>>, usage?: DecisionUsage|null}} SurfaceResult
 */

/** Question name the gate uses for its one question. */
const GATE_QUESTION = 'decision';


/**
 * Clamps a value into 0..1, or null when it is not a finite number.
 * @param {unknown} value
 * @returns {number|null}
 */
function clampCertainty(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, /** @type {number} */ (value))) : null;
}


/**
 * A wire probability, or null when it is not a finite number inside 0..1. A
 * vendor that reports percent (0..100) or a negative score must escalate, not
 * arrive as a certain answer.
 * @param {unknown} value
 * @returns {number|null}
 */
function validProbability(value) {
    return Number.isFinite(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) <= 1
        ? /** @type {number} */ (value)
        : null;
}


/**
 * The certainty an answer carries, 0..1, or null when it cannot be calibrated.
 * @param {{answer?: DecisionAnswer|null}} [arg0] - One canonical DecisionAnswer.
 * @returns {number|null}
 */
export function certaintyOf({ answer = null } = {}) {
    if (!answer || typeof answer !== 'object') return null;
    if (answer.type === 'noul') {
        const p = validProbability(answer.probability);
        if (p === null) return clampCertainty(answer.confidence);
        return clampCertainty(Number.isFinite(answer.confidence) ? answer.confidence : Math.max(p, 1 - p));
    }
    if (answer.type === 'choice') {
        const values = Object.values(answer.probabilities ?? {}).filter((v) => Number.isFinite(v));
        if (Number.isFinite(answer.confidence)) return clampCertainty(answer.confidence);
        return values.length ? clampCertainty(Math.max(...values)) : null;
    }
    if (answer.type === 'score') {
        if (Number.isFinite(answer.confidence)) return clampCertainty(answer.confidence);
        const values = Object.values(answer.probabilities ?? {}).filter((v) => Number.isFinite(v));
        return values.length ? clampCertainty(Math.max(...values)) : null;
    }
    return null;
}


/**
 * Keeps the decision state within the character cap.
 * @param {{state: unknown, maxStateChars: number}} arg0
 * @returns {unknown}
 */
function cappedState({ state, maxStateChars }) {
    if (typeof state === 'string') return state.length > maxStateChars ? state.slice(0, maxStateChars) : state;
    if (state && typeof state === 'object') {
        let json;
        try {
            json = JSON.stringify(state);
        } catch {
            // A circular state cannot be capped; the gate must never throw on it.
            return state;
        }
        // A truncated state is sent as a string on purpose: a sliced JSON object is not valid JSON.
        if (typeof json === 'string' && json.length > maxStateChars) return json.slice(0, maxStateChars);
    }
    return state;
}


/**
 * What a gate call answers. `reason` is null on a normal escalation, 'error'
 * when the backend failed, and 'undeclared' when a choice named an option the
 * question never declared.
 * @typedef {Object} GateVerdict
 * @property {boolean|null} verdict
 * @property {number|null} certainty
 * @property {boolean} escalated
 * @property {DecisionAnswer|null} answer
 * @property {string|null} reason
 * @property {DecisionUsage|null} usage - The wire usage of the call, when it reported one.
 * @property {number} stateChars - Characters of state actually sent.
 */

/**
 * @typedef {Object} GateChoice
 * @property {string|null} choice
 * @property {number|null} certainty
 * @property {boolean} escaped
 * @property {boolean} escalated
 * @property {DecisionAnswer|null} answer
 * @property {string|null} reason
 * @property {DecisionUsage|null} usage - The wire usage of the call, when it reported one.
 * @property {number} stateChars - Characters of state actually sent.
 */

/**
 * @typedef {Object} GateScore
 * @property {number|null} score
 * @property {number|null} certainty
 * @property {boolean} escalated
 * @property {DecisionAnswer|null} answer
 * @property {string|null} reason
 * @property {DecisionUsage|null} usage - The wire usage of the call, when it reported one.
 * @property {number} stateChars - Characters of state actually sent.
 */

/**
 * @typedef {Object} DecisionGate
 * @property {boolean} available
 * @property {(arg0: {state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal|null}) => Promise<SurfaceResult|null>} ask
 * @property {(arg0: {state: unknown, question: DecisionQuestion, threshold?: number|null, signal?: AbortSignal|null}) => Promise<GateVerdict>} gate
 * @property {(arg0: {state: unknown, question: DecisionQuestion, escape?: string, threshold?: number|null, signal?: AbortSignal|null}) => Promise<GateChoice>} choose
 * @property {(arg0: {state: unknown, question: DecisionQuestion, threshold?: number|null, signal?: AbortSignal|null}) => Promise<GateScore>} score
 * @property {(arg0: {onUsage: (arg0: {usage: DecisionUsage|null, seam: string, stateChars?: number}) => void}) => DecisionGate} withUsage - A derived gate that reports every call's usage to one more listener.
 */

/**
 * Builds the gate over a bound decision surface.
 * @param {{ask?: ((arg0: {state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal|null}) => Promise<SurfaceResult>)|null, threshold?: number, maxStateChars?: number, seam?: string, emitter?: import('node:events').EventEmitter|null, onUsage?: ((arg0: {usage: DecisionUsage|null, seam: string, stateChars?: number}) => void)|null}} [arg0]
 *   `ask` is the bound decision surface (see `createRoleClients`); `onUsage`
 *   receives the wire usage of every answered call (the accounting seam).
 * @returns {DecisionGate}
 */
export function createDecisionGate({ ask = null, threshold = LIMITS.decision_gate_threshold, maxStateChars = LIMITS.decision_state_max_chars, seam = 'decision', emitter = null, onUsage = null } = {}) {
    const available = typeof ask === 'function';

    /**
     * One decision request plus the size of the state that was sent; null when
     * no surface is configured.
     * @param {{state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal|null}} arg0
     * @returns {Promise<{result: SurfaceResult, stateChars: number}|null>}
     */
    async function askWithMeta({ state, questions, signal = null }) {
        if (!available) return null;
        const capped = cappedState({ state, maxStateChars });
        let stateChars = 0;
        if (typeof capped === 'string') stateChars = capped.length;
        else {
            try { stateChars = String(JSON.stringify(capped) ?? '').length; } catch { stateChars = 0; }
        }
        const result = await ask({ state: capped, questions, signal });
        if (typeof onUsage === 'function') {
            // Accounting must never break a judgment: a listener's throw is dropped.
            try { onUsage({ usage: result?.usage ?? null, seam, stateChars }); } catch { /* ignore */ }
        }
        return { result, stateChars };
    }

    /**
     * The public raw surface: the result only, null when no surface is configured.
     * @param {{state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal|null}} arg0
     * @returns {Promise<SurfaceResult|null>}
     */
    async function askDecision({ state, questions, signal = null }) {
        const meta = await askWithMeta({ state, questions, signal });
        return meta ? meta.result : null;
    }

    /**
     * The one answer the gate asked for, keyed by the gate's question name.
     * @param {{result?: SurfaceResult|null}} arg0
     * @returns {DecisionAnswer|null}
     */
    function answerOf({ result }) {
        const answers = result?.answers;
        if (!answers || typeof answers !== 'object') return null;
        return /** @type {DecisionAnswer|null} */ (answers[GATE_QUESTION] ?? Object.values(answers)[0] ?? null);
    }

    /**
     * One yes/no decision.
     * @param {{state: unknown, question: DecisionQuestion, threshold?: number|null, signal?: AbortSignal|null}} arg0
     * @returns {Promise<GateVerdict>}
     */
    async function gate({ state, question, threshold: localThreshold = null, signal = null }) {
        const effective = localThreshold ?? threshold;
        const payload = { verdict: /** @type {boolean|null} */ (null), certainty: /** @type {number|null} */ (null), escalated: true, answer: /** @type {DecisionAnswer|null} */ (null), reason: /** @type {string|null} */ (null), usage: /** @type {DecisionUsage|null} */ (null), stateChars: 0 };
        if (available) {
            try {
                const meta = await askWithMeta({ state, questions: { [GATE_QUESTION]: question }, signal });
                const answer = answerOf({ result: meta?.result });
                payload.usage = meta?.result?.usage ?? null;
                payload.stateChars = meta?.stateChars ?? 0;
                const certainty = certaintyOf({ answer });
                const probability = answer?.type === 'noul' ? validProbability(answer.probability) : null;
                const verdict = probability === null ? null : probability >= 0.5;
                payload.verdict = verdict;
                payload.certainty = certainty;
                payload.answer = answer;
                payload.escalated = verdict === null || certainty === null || certainty < effective || answer?.type !== 'noul';
            } catch (error) {
                if (isAbortError({ err: error })) throw error;
                payload.reason = 'error';
            }
        }
        emitGate({ emitter, seam, payload: { primitive: 'noul', verdict: payload.verdict, certainty: payload.certainty, escalated: payload.escalated, reason: payload.reason } });
        return payload;
    }

    /**
     * @param {{state: unknown, question: DecisionQuestion, signal?: AbortSignal|null}} arg0
     * @returns {Promise<{result: SurfaceResult, stateChars: number}|null>}
     */
    async function askOne({ state, question, signal = null }) {
        return askWithMeta({ state, questions: { [GATE_QUESTION]: question }, signal });
    }

    /**
     * One closed-world choice. The escape option must be in `question.criteria`,
     * so the model cannot answer with an option the caller never declared.
     * @param {{state: unknown, question: DecisionQuestion, escape?: string, threshold?: number|null, signal?: AbortSignal|null}} arg0
     * @returns {Promise<GateChoice>}
     */
    async function choose({ state, question, escape = 'other', threshold: localThreshold = null, signal = null }) {
        const criteria = question?.criteria;
        if (!criteria || typeof criteria !== 'object' || !Object.prototype.hasOwnProperty.call(criteria, escape)) {
            throw new ConfigurationError({ message: `A choice question's criteria must declare the escape option '${escape}' (closed-world trap guard).`, options: { option: 'criteria' } });
        }
        const effective = localThreshold ?? threshold;
        /** @type {GateChoice} */
        const result = { choice: null, certainty: null, escaped: false, escalated: true, answer: null, reason: null, usage: null, stateChars: 0 };
        try {
            const meta = await askOne({ state, question, signal });
            const answer = answerOf({ result: meta?.result });
            result.usage = meta?.result?.usage ?? null;
            result.stateChars = meta?.stateChars ?? 0;
            const choice = answer?.choice === undefined || answer?.choice === null ? null : String(answer.choice);
            result.answer = answer;
            result.choice = choice;
            result.certainty = certaintyOf({ answer });
            result.escaped = choice === escape;
            const declared = choice !== null && Object.prototype.hasOwnProperty.call(criteria, choice);
            if (!declared && choice !== null) result.reason = 'undeclared';
            result.escalated = !declared || result.certainty === null || result.certainty < effective || answer?.type !== 'choice';
        } catch (error) {
            if (isAbortError({ err: error })) throw error;
            result.reason = 'error';
        }
        emitGate({ emitter, seam, payload: { primitive: 'choice', choice: result.choice, certainty: result.certainty, escaped: result.escaped, escalated: result.escalated, reason: result.reason } });
        return result;
    }

    /**
     * One score on an ordered rubric.
     * @param {{state: unknown, question: DecisionQuestion, threshold?: number|null, signal?: AbortSignal|null}} arg0
     * @returns {Promise<GateScore>}
     */
    async function score({ state, question, threshold: localThreshold = null, signal = null }) {
        const effective = localThreshold ?? threshold;
        /** @type {GateScore} */
        const result = { score: null, certainty: null, escalated: true, answer: null, reason: null, usage: null, stateChars: 0 };
        try {
            const meta = await askOne({ state, question, signal });
            const answer = answerOf({ result: meta?.result });
            result.usage = meta?.result?.usage ?? null;
            result.stateChars = meta?.stateChars ?? 0;
            result.answer = answer;
            const value = answer?.score;
            result.score = Number.isFinite(value) ? /** @type {number} */ (value) : null;
            result.certainty = certaintyOf({ answer });
            result.escalated = result.score === null || result.certainty === null || result.certainty < effective || answer?.type !== 'score';
        } catch (error) {
            if (isAbortError({ err: error })) throw error;
            result.reason = 'error';
        }
        emitGate({ emitter, seam, payload: { primitive: 'score', score: result.score, certainty: result.certainty, escalated: result.escalated, reason: result.reason } });
        return result;
    }

    /**
     * A derived gate that reports usage to one more listener while keeping this
     * gate's surface, threshold, cap and seam. Used by a session to charge a
     * run's budget without sharing a mutable callback across sessions.
     * @param {{onUsage: (arg0: {usage: DecisionUsage|null, seam: string, stateChars?: number}) => void}} arg0
     * @returns {DecisionGate}
     */
    function withUsage({ onUsage: extra }) {
        const composed = (/** @type {{usage: DecisionUsage|null, seam: string, stateChars?: number}} */ event) => {
            try { onUsage?.(event); } catch { /* ignore */ }
            try { extra?.(event); } catch { /* ignore */ }
        };
        const derived = createDecisionGate({ ask, threshold, maxStateChars, seam, emitter, onUsage: composed });
        // Ownership travels with derivation: a gate derived from a session gate
        // must still be refused by another session.
        for (const symbol of Object.getOwnPropertySymbols(api)) {
            Object.defineProperty(derived, symbol, { value: /** @type {any} */ (api)[symbol], enumerable: true, configurable: true });
        }
        return derived;
    }

    const api = { available, ask: askDecision, gate, choose, score, withUsage };
    return api;
}


/**
 * Emits the gate outcome on the caller's emitter, once per call. The payload is
 * the primitive's own shape (`noul` verdict, `choice` pick, or `score`) plus
 * `seam`, so one listener can attribute every gate to the flow that ran it.
 * @param {{emitter: import('node:events').EventEmitter|null, seam: string, payload: Record<string, unknown>}} arg0
 */
function emitGate({ emitter, seam, payload }) {
    if (!emitter || typeof emitter.emit !== 'function') return;
    const name = EVENTS.CLIENT.DECISION_GATE;
    emitter.emit(name, stampEvent({ name, payload: { seam, ...payload } }));
}
