// @ts-check
/**
 * @file ProviderMemoryEngine — the memory component's engine.
 * @version 0.12.0
 *
 * @description
 * Adapts a MemoryProvider (query/store contract) to the component's load/save
 * tool calls: load renders relevant facts as a system block, save stores a
 * fact. Accepts any object exposing the provider contract, not just
 * MemoryProvider subclasses.
 */

import { DEFAULT_MEMORY_CATEGORY } from '../../core/constants/index.mjs';
import { MemoryProvider, assertProvider, buildMemoryBlock, ENGINE_PROVIDER_METHODS } from './providers.mjs';




/**
 * The provider contract the engine drives: recall for a query, persist a fact.
 * `MemoryProvider` is the built-in; a duck type with these methods fits (that is
 * exactly what `assertProvider` checks), so the type is structural.
 * @typedef {Object} EngineProvider
 * @property {(() => Promise<unknown>)} [load]
 * @property {(arg0: {text: string, limit?: number, embedder?: Function|null}) => Promise<Array<import('./providers.mjs').MemoryFact>>} query
 * @property {(arg0: {content: string, category?: string, targetBanks?: Array<string>, embedder?: Function|null, opts?: Object}) => Promise<import('./providers.mjs').MemoryFact|null>} store
 */

/**
 * Memory engine over a single provider. `load` queries and renders a block;
 * `save` stores a fact (with an optional session-scoped embedder threaded
 * per-call so the shared provider is never mutated).
 */
export class ProviderMemoryEngine {
    /** @type {EngineProvider} */
    provider;
    /** @type {Function|null} */
    embedder;

    /**
      * @param {{provider: EngineProvider, embedder?: Function|null}} arg0
     */
        constructor({ provider, embedder = null }) {
        assertProvider({ provider, owner: 'ProviderMemoryEngine', requiredMethods: ENGINE_PROVIDER_METHODS });
        this.provider = provider;
        this.embedder = embedder;
    }

    
    /**
     * system block (or null when nothing matches).
     * @param {{query: string, ctx?: Record<string, unknown>}} arg0 -
     * @returns {Promise<string|null>}
     */
        async load({ query, ctx = {} }) {
        await ( (this.provider)).load?.();
        const facts = await ( (this.provider)).query({ text: query || '', embedder: this.embedder });
        if (!facts || facts.length === 0) return null;
        return buildMemoryBlock({ facts });
    }

    
    /**
     * @param {{data: string|Record<string, unknown>, ctx?: Record<string, unknown>}} arg0 -
     * @returns {Promise<{success: boolean, id?: string, error?: string}>}
     */
        async save({ data, ctx = {} }) {
        const content = typeof data === 'string' ? data : (data && /** @type {string} */ (data.content));
        if (!content) return { success: false, error: 'No content provided to store.' };
        const category = ( (/** @type {any} */ (data)).category) || DEFAULT_MEMORY_CATEGORY;
        const targetBanks = ( (/** @type {any} */ (data)).targetBanks) || [];
        const fact = await ( (this.provider)).store({ content, category, targetBanks, embedder: this.embedder });
        return { success: !!fact, id: fact?.id };
    }
}
