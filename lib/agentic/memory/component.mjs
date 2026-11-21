// @ts-check
/**
 * @file Memory capability — load/save tool component.
 * @version 0.12.0
 *
 * @description
 * Thin LoadableComponent wrapper over a memory engine: load() recalls facts
 * for a query, save() persists a new fact. Wired into sessions via
 * ChatSessionBuilder.withMemory.
 */

import { CAPABILITY, CAPABILITY_REGISTRY, LOAD_MEMORY_TOOL_NAME, SAVE_MEMORY_TOOL_NAME } from '../../core/constants/index.mjs';
import { EVENTS } from '../../core/events.mjs';
import { LoadableComponent } from '../../core/loadable.mjs';
import { ProviderMemoryEngine } from './engine.mjs';




/**
 * The memory engine the component drives: recall for one query, persist one
 * fact. `ProviderMemoryEngine` is the built-in one; a duck type fits too.
 * @typedef {Object} MemoryEngine
 * @property {Function} load
 * @property {Function} save
 */

/**
 * The manager the component asks for a per-step block. Only `buildMemoryBlock`
 * is read here (the session owns distill/sync).
 * @typedef {Object} MemoryManagerLike
 * @property {Function} buildMemoryBlock
 */

/**
 * The memory capability component: long-term recall/persist exposed as the
 * memory load/save tools.
 * @extends {LoadableComponent}
 */
export class MemoryComponent extends LoadableComponent {
    
    /**
 * @param {{engine?: MemoryEngine, provider?: Object, manager?: MemoryManagerLike|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 */
        constructor({ engine, provider, manager = null, eventEmitter = null } = {}) {
        super({
            id: CAPABILITY.MEMORY,
            loadToolName: LOAD_MEMORY_TOOL_NAME,
            saveToolName: SAVE_MEMORY_TOOL_NAME,
            announce: CAPABILITY_REGISTRY[CAPABILITY.MEMORY]?.announce ?? null,
            eventEmitter,
            loadDescription: 'Recall long-term memory relevant to the given topic/keywords. Returns stored facts.',
            saveDescription: 'Persist a new long-term memory fact.',
            loadParameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Topic or keywords to recall memory for.' } },
                required: []
            },
            saveParameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The fact to store.' },
                    category: { type: 'string', description: 'Optional category.' }
                },
                required: ['content']
            }
        });
        /** @type {MemoryEngine} */
        this.engine = engine || new ProviderMemoryEngine({ provider: /** @type {import('./engine.mjs').EngineProvider} */ (provider) });
        /** @type {MemoryManagerLike|null} */
        this.manager = manager ?? null;
    }

    async shouldInjectStep( ctx = {}) {
        return !!/** @type {any} */ (ctx)?.preload && !!this.manager;
    }

    /** @param {Record<string, unknown>} [ctx] @returns {Promise<string|null>} */
    async stepBlock( ctx = {}) {
        const memory = await ( (/** @type {MemoryManagerLike} */ (this.manager))).buildMemoryBlock({ messages: /** @type {any} */ (ctx).messages ?? [] });
        if (!memory) return null;
        this._emit({ name: EVENTS.MEMORY.INJECTED, payload: { factCount: memory.factCount }, runContext: /** @type {any} */ (ctx).runContext ?? null });
        return memory.block;
    }

    
    /**
     * Recalls memory facts relevant to the query (system-block string or null).
     * @param {Record<string, unknown>} [args]
     * @returns {Promise<string|null>}
     */
        async load(args = {}) {
        return this.engine.load({ query: args.query || '', ctx: args });
    }

    
    /**
     * @param {{args?: Record<string, unknown>, options?: Record<string, unknown>}} arg0 -
     * @returns {Promise<{success: boolean, id?: string}>}
     */
        async save({ args = {}, options = {} } = {}) {
        return this.engine.save({ data: args, ctx: args });
    }
}
