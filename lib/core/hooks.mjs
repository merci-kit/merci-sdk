// @ts-check


/**
 * @file Hook registry — the "intervene" layer of the event system.
 * @version 0.12.0
 *
 * @description
 * Events (core/emitter.mjs, core/events.mjs) are observe-only: sync, isolated,
 * never allowed to change a run. Hooks are the opposite — an ordered, async
 * chain that may mutate a shared context or transform and short-circuit a
 * value. The same mechanism powers request/step/tool middleware.
 *
 * Two shapes:
 *   - `runSerial({ name, ctx })`   — fire ordered hooks for side effects
 *     (logging, metrics, approval, mutation of `ctx`).
 *   - `runWaterfall({ name, value, ctx })` — each hook receives the current
 *     value and returns the next; returning `STOP` ends the chain and keeps the
 *     value as it stands (cancel / short-circuit).
 *
 * Order: higher `priority` first, then registration order. `add` returns an
 * unsubscribe function.
 */
/**
 * The sentinel a hook returns to end a waterfall chain without changing the
 * value.
 */
export const STOP = Symbol('merci.hooks.stop');


/**
 * Canonical hook-chain names shared by the built-in pipelines and users of
 * `withHooks` (`hooks.add({ name: HOOKS.TOOL_BEFORE, fn })`).
 */
export const HOOKS = Object.freeze({
    TOOL_BEFORE: 'tool:before',
    TOOL_AFTER: 'tool:after',
    TOOL_ERROR: 'tool:error',
    REQUEST_BEFORE: 'request:before',
    REQUEST_AFTER: 'request:after',
});


/**
 * The hook registry — an ordered chain of async hooks that can veto or transform a value.
 * @typedef {{ fn: Function, priority: number, seq: number }} HookReg
 */


export class HookRegistry {
    /** @type {Map<string, HookReg[]>} */
    #hooks = new Map();
    #seq = 0;

    /**
     * Registers an ordered hook. Returns an unsubscribe fn.
     * @param {{name: string, fn: Function, priority?: number}} arg0
     * @returns {() => void}
     */
    add({ name, fn, priority = 0 }) {
        if (typeof fn !== 'function') throw new TypeError('HookRegistry.add: fn must be a function');
        let list = this.#hooks.get(name);
        if (!list) { list = []; this.#hooks.set(name, list); }
        const reg = { fn, priority: Number(priority) || 0, seq: this.#seq++ };
        list.push(reg);
        return () => {
            const i = list.indexOf(reg);
            if (i >= 0) list.splice(i, 1);
        };
    }

    /** @param {{name: string, fn: Function, priority?: number}} arg0 @returns {() => void} */
    on({ name, fn, priority = 0 }) { return this.add({ name, fn, priority }); }

    /**
     * Ordered registrations for `name`.
     * @param {string} name
     * @returns {HookReg[]}
     */
    #ordered(name) {
        const list = this.#hooks.get(name);
        if (!list || list.length === 0) return [];
        return [...list].sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
    }

    /** @param {{name: string}} arg0 @returns {boolean} */
    has({ name }) { return this.#ordered(name).length > 0; }

    /** @param {{name: string}} arg0 @returns {number} */
    count({ name }) { return this.#ordered(name).length; }

    /**
     * Runs hooks in order, awaiting each. Returns the array of return values.
     * @param {{name: string, ctx?: Record<string, unknown>}} arg0
     * @returns {Promise<Array<unknown>>}
     */
    async runSerial({ name, ctx = {} }) {
        const results = [];
        for (const reg of this.#ordered(name)) results.push(await reg.fn(ctx));
        return results;
    }

    /**
     * Runs hooks as a waterfall; each receives (value, ctx) and returns the
     * next value. Returning `undefined` leaves the value unchanged; returning
     * `STOP` halts the chain and returns `STOP` to the caller (veto /
     * short-circuit).
     * @template T
     * @param {{name: string, value: T, ctx?: Record<string, unknown>}} arg0
     * @returns {Promise<T|typeof STOP>} The last value, or `STOP` when a hook vetoed.
     */
    async runWaterfall({ name, value, ctx = {} }) {
        let current = value;
        for (const reg of this.#ordered(name)) {
            const next = await reg.fn(current, ctx);
            if (next === STOP) return STOP;
            if (next !== undefined) current = next;
        }
        return current;
    }

    /** @param {{name?: string}} [arg0] Removes one chain, or all when name is omitted. */
    clear({ name } = {}) {
        if (name === undefined) this.#hooks.clear();
        else this.#hooks.delete(name);
    }
}


/**
 * Creates an empty hook registry.
 * @returns {HookRegistry}
 */
export function createHooks() {
    return new HookRegistry();
}
