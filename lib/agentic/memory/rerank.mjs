// @ts-check
/**
 * @file Decision-gate reranker for the memory vector tier.
 * @version 0.24.0
 *
 * @description
 * `LocalFileMemoryProvider` ranks by cosine + lexical overlap; that is a
 * similarity score, not a relevance judgment. This adapter turns the decision
 * gate into a `reranker` the provider accepts: one `noul` per top candidate
 * ("is this fact relevant to the query?"), ordered by the answer's probability.
 * The head is bounded (`maxCandidates`, default 5) because every candidate is
 * one cheap request; the tail keeps its original order. A fact whose answer
 * escalates keeps its original rank instead of being dropped.
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { noulQuestion } from '../../messaging/decision.mjs';
import { createDecisionGate } from '../decision-gate.mjs';


/**
 * @typedef {Object} RerankableFact
 * @property {string} [content]
 * @property {number} [score]
 */

/**
 * Builds the `reranker` option `LocalFileMemoryProvider` accepts.
 * @param {{ask?: Function|null, instructions?: string, threshold?: number, maxCandidates?: number, emitter?: import('node:events').EventEmitter|null}} [arg0]
 *   `ask` is the bound decision surface (see `createRoleClients`).
 * @returns {(arg0: {text: string, facts: Array<RerankableFact>}) => Promise<Array<RerankableFact>>}
 */
export function createDecisionReranker({ ask = null, instructions = 'Is this memory fact relevant to the query?', threshold = LIMITS.decision_gate_threshold, maxCandidates = 5, emitter = null } = {}) {
    if (typeof ask !== 'function') {
        throw new ConfigurationError({ message: 'createDecisionReranker requires an ask function from the decision surface.', options: { option: 'ask' } });
    }
    const gate = createDecisionGate({ ask: /** @type {any} */ (ask), threshold, seam: 'memory.rerank', emitter });
    const question = noulQuestion({
        instructions,
        criteria: {
            true: 'The fact answers or directly supports the query.',
            false: 'The fact is unrelated to the query.',
        },
    });
    const headSize = Number.isInteger(maxCandidates) && maxCandidates >= 2 ? maxCandidates : 5;

    return async ({ text, facts }) => {
        if (!Array.isArray(facts) || facts.length < 2) return facts;
        const head = facts.slice(0, headSize);
        const tail = facts.slice(head.length);
        /** @type {Array<{fact: RerankableFact, probability: number|null, index: number}>} */
        const scored = [];
        for (let index = 0; index < head.length; index++) {
            const fact = head[index];
            const result = await gate.gate({ state: { query: text, fact: fact?.content ?? fact }, question });
            // An escalated answer is not a ranking signal: the fact keeps its slot.
            const probability = result.escalated || result.verdict === null || result.certainty === null
                ? null
                : Number.isFinite(result.answer?.probability)
                    ? Number(result.answer?.probability)
                    : result.verdict ? result.certainty : 1 - result.certainty;
            scored.push({ fact, probability, index });
        }
        // An escalated fact keeps its exact slot; the confident ones are reordered
        // around it. A stable sort would move it, so the slots are rebuilt by index.
        const confident = scored
            .filter((entry) => entry.probability !== null)
            .sort((a, b) => /** @type {number} */ (b.probability) - /** @type {number} */ (a.probability) || a.index - b.index);
        let next = 0;
        const headOut = scored.map((entry) => (entry.probability === null ? entry.fact : confident[next++].fact));
        return [...headOut, ...tail];
    };
}
