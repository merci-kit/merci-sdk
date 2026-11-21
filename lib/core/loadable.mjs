// @ts-check


/**
 * @file LoadableComponent — the dual-mode load/save contract + unified
 * capability ("extension") hooks.
 * @version 0.12.0
 *
 * @description
 * A LoadableComponent is an operational capability (skills, memory, …) whose
 * payload is consumed through `AbstractChatSession._prepareStepMessages` (it
 * is folded into the per-step system message, unless the host marks the
 * component volatile — then it rides the trailing, uncached row; the old row-injection writers
 * are gone). Every component is usable in two ways:
 *
 *   (a) AS A TOOL    — `toLoadTool()` / `toSaveTool()` return unified tools.
 *                      When the model calls them, the payload arrives as a
 *                      normal tool result (zero special-casing).
 *   (b) STANDALONE   — call `component.load(args)` /
 *                      `component.save({ args, options })` directly; the caller
 *                      owns persisting the result.
 *
 * Subclasses implement `load(args)` (returns the payload — a string the model
 * sees) and optionally `save(args)`. The base class turns those into the two
 * tool surfaces.
 *
 * Unified extension hooks (SOTA tools-first, system-prompt-minimal): a
 * component may declare a one-time `announce` (startup, folded into the base
 * system message once) and a conditional per-step block (`shouldInjectStep` +
 * `stepBlock`, folded into the per-step system context). Both default to
 * off — existing subclasses are unaffected until migrated.
 */
import { AbstractMethodError } from './errors.mjs';
import { EVENTS, emitEvent } from './events.mjs';
import { markBuiltIn } from './builtin-brand.mjs';


/**
 * A unified tool definition the component surfaces (`toLoadTool`/`toSaveTool`):
 * the agentic loop's contract — a name, a description, JSON-Schema parameters
 * and a re-runnable `execute`.
 * @typedef {Object} LoadableTool
 * @property {string} name
 * @property {string} description
 * @property {import('../support/json.mjs').JsonSchema} parameters
 * @property {(arg0: {args?: Record<string, unknown>, signal?: AbortSignal|null, context?: {runContext?: import('./events.mjs').RunContext|null}|null}) => Promise<unknown>} execute
 */

/**
 * Base class for operational capabilities (skills, memory, …) that surface a
 * payload to the model. Usable as a tool (`toLoadTool`/`toSaveTool`) or
 * standalone (`load(args)`/`save(args)`). Subclasses implement `load` and
 * optionally `save`; the base class turns them into unified tool surfaces.
 */
export class LoadableComponent {
    
    /**
 * @param {{id?: string, loadToolName?: string, saveToolName?: string, loadDescription?: string, saveDescription?: string, loadParameters?: import('../support/json.mjs').JsonSchema, saveParameters?: import('../support/json.mjs').JsonSchema, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, announce?: string|null}} arg0
 *   message once via _announceCapability; null = rely on the CAPABILITY_REGISTRY fallback).
 */
        constructor({
        id,
        loadToolName,
        saveToolName,
        loadDescription,
        saveDescription,
        loadParameters,
        saveParameters,
        eventEmitter = null,
        announce = null
    } = {}) {
        this.id = id;
        this.loadToolName = loadToolName ?? null;
        this.saveToolName = saveToolName ?? null;
        this.announce = announce ?? null;
        this.loadDescription = loadDescription || `Load the ${id} payload into the conversation.`;
        this.saveDescription = saveDescription || `Persist data for the ${id} capability.`;
        this.loadParameters = loadParameters || { type: 'object', properties: {}, required: [] };
        this.saveParameters = saveParameters || {
            type: 'object',
            properties: { content: { type: 'string', description: 'Data to persist.' } },
            required: ['content']
        };
        this.eventEmitter = eventEmitter;
    }

    
    /**
     * @param {{name: string, payload?: Record<string, unknown>, runContext?: import('./events.mjs').RunContext|null}} arg0 -
     */
        _emit({ name, payload, runContext = null }) {
        emitEvent({ emitter: this.eventEmitter, name, payload, runContext });
    }

    
    /**
     * Produces the payload to surface to the model. Returns a string (or null
     * when there is nothing to surface). Subclasses MUST override.
     * @param {Record<string, unknown>} [args={}]
     * @returns {Promise<string|null>}
     */
        async load(args = {}) {
        throw new AbstractMethodError({ message: `LoadableComponent[${this.id}].load must be implemented by subclass` });
    }

    
    /**
     * Tool-surface entry point for a load: the same payload as `load(args)`,
     * plus the caller's abort signal. Subclasses that do cancellable I/O
     * override this; the default forwards to `load` and ignores the signal.
     * @param {{args?: Record<string, unknown>, signal?: AbortSignal|null}} arg0
     * @returns {Promise<string|null>}
     */
        async loadWithSignal({ args = {}, signal = null } = {}) {
        void signal;
        return this.load(args);
    }

    
    /**
     * saving; the default throws so a missing override is loud.
     * @param {{args?: Record<string, unknown>, options?: Record<string, unknown>}} arg0 -
     * @returns {Promise<Record<string, unknown>>}
     */
        async save({ args = {}, options = {} } = {}) {
        throw new AbstractMethodError({ message: `LoadableComponent[${this.id}].save must be implemented by subclass` });
    }

    
    /**
     * The one-time startup announcement for this capability (folded into the
     * base system message once when the capability attaches). Null means
     * "no component-owned announce" — the caller falls back to the
     * CAPABILITY_REGISTRY entry. Subclasses may pass `announce` via the
     * constructor or override this method for dynamic text.
     * @returns {string|null}
     */
        startupAnnounce() {
        return this.announce ?? null;
    }

    
    /**
     * Whether this capability contributes a per-step system-context block on
     * this step. Default off — subclasses override (e.g. "store non-empty",
     * "mode !== 'off'", "preload enabled"). The session calls this before
     * `stepBlock`, so expensive loads stay skipped when there is nothing to show.
     * @param {Record<string, unknown>} [ctx] - Step context (e.g. `{ messages, preload }`).
     * @returns {boolean|Promise<boolean>}
     */
        shouldInjectStep(ctx = {}) {
        return false;
    }

    
    /**
     * The per-step system-context block (a string the model sees), or null
     * when there is nothing to surface. Only called when `shouldInjectStep`
     * is truthy. Errors propagate — the session decides warn-and-skip vs throw.
     * @param {Record<string, unknown>} [ctx] - Step context (e.g. `{ messages, preload }`).
     * @returns {Promise<string|null>}
     */
        async stepBlock(ctx = {}) {
        return null;
    }

    
    /**
     * Tool surface (a) for loading. The tool's execute() returns the payload,
     * which the agentic loop deposits in the row as a tool result.
     * @returns {LoadableTool|null} A unified tool, or null when no loadToolName.
     */
        toLoadTool() {
        if (!this.loadToolName) return null;
        const self = this;
        return markBuiltIn({ tool: {
            name: this.loadToolName,
            description: this.loadDescription,
            parameters: this.loadParameters,
            execute: async ({ args = {}, signal = null, context = null }) => {
                const rc = context?.runContext ?? null;
                try {
                    const payload = await self.loadWithSignal({ args: args || {}, signal: signal ?? null });
                    self._emit({ name: EVENTS.LOADABLE.LOAD, payload: { id: self.id, toolName: self.loadToolName, ok: true }, runContext: rc });
                    return payload == null ? '' : payload;
                } catch (err) {
                    self._emit({ name: EVENTS.LOADABLE.LOAD, payload: { id: self.id, toolName: self.loadToolName, ok: false, error: (/** @type {Error} */ (err))?.message ?? String(err) }, runContext: rc });
                    throw err;
                }
            }
        } });
    }

    
    /**
     * Tool surface (a) for saving.
     * @returns {LoadableTool|null} A unified tool, or null when no saveToolName.
     */
        toSaveTool() {
        if (!this.saveToolName) return null;
        const self = this;
        return markBuiltIn({ tool: {
            name: this.saveToolName,
            description: this.saveDescription,
            parameters: this.saveParameters,
            execute: async ({ args = {}, signal = null, context = null }) => {
                const rc = context?.runContext ?? null;
                try {
                    const res = await self.save({ args: args || {}, options: { runContext: rc, signal: signal ?? null } });
                    self._emit({ name: EVENTS.LOADABLE.SAVE, payload: { id: self.id, toolName: self.saveToolName, ok: true }, runContext: rc });
                    return res == null ? { success: true } : res;
                } catch (err) {
                    self._emit({ name: EVENTS.LOADABLE.SAVE, payload: { id: self.id, toolName: self.saveToolName, ok: false, error: (/** @type {Error} */ (err))?.message ?? String(err) }, runContext: rc });
                    throw err;
                }
            }
        } });
    }
}
