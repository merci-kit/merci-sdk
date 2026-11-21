// @ts-check


/**
 * @file MerciEventEmitter — a drop-in EventEmitter with glob subscriptions,
 * priority ordering, and per-listener isolation.
 * @version 0.12.0
 *
 * @description
 * Extends `node:events` so `instanceof EventEmitter` still holds and `on()`
 * still chains, and adds the three things plain EventEmitter lacks:
 *
 *   - glob namespaces: `on('run:*')` (one segment), `on('session:**')` (across
 *     segments), and `onAny(fn)` (every event);
 *   - deterministic order: `{ priority }` (higher first) and `{ prepend }`;
 *   - isolation: `emit`/`emitSafe` run every matching listener even when one
 *     throws; the throw surfaces as the listener-error event instead of
 *     stopping the dispatch. `emitSerial` awaits listeners in order.
 *
 * Layer note: Events observe (sync, isolated) — this class; Hooks intervene
 * (ordered, async, transform/cancel) — see core/hooks.mjs.
 *
 * Listener storage is owned here (not in EventEmitter internals) so priority
 * and globs compose. `on`/`once` return `this` for chainability; use
 * `subscribe`/`onAny` when you want an unsubscribe function back.
 */
import { EventEmitter } from 'node:events';
import { EVENTS } from './events.mjs';


const GLOB = /[*?]/;
/** @type {Map<string, RegExp>} */
const globCache = new Map();


/**
 * Escapes a single non-glob character for use in a RegExp.
 * @param {string} ch
 * @returns {string}
 */
const escapeRegExpChar = (ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch);


/**
 * Compiles a glob into an anchored RegExp. `*` matches within one `:`-segment,
 * `**` matches across segments, `?` matches a single non-`:` character.
 * @param {string} pattern
 * @returns {RegExp}
 */
const globToRegExp = (pattern) => {
    const cached = globCache.get(pattern);
    if (cached) return cached;
    let body = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') { body += '.*'; i += 1; } else { body += '[^:]*'; }
        } else if (ch === '?') {
            body += '[^:]';
        } else {
            body += escapeRegExpChar(ch);
        }
    }
    const re = new RegExp(`^${body}$`);
    globCache.set(pattern, re);
    return re;
};


/**
 * The SDK's event emitter — per-listener isolation, glob dispatch and the unhandled-event report.
 * @typedef {{ fn: Function, once: boolean, priority: number, seq: number }} Registration
 */

/**
 * Per-subscription options: higher `priority` dispatches first, `prepend` jumps
 * the queue, `once` removes after the first dispatch.
 * @typedef {Object} ListenerOptions
 * @property {number} [priority]
 * @property {boolean} [prepend]
 * @property {boolean} [once]
 */


export class MerciEventEmitter extends EventEmitter {
    /** @type {Map<string, Registration[]>} */
    #patterns = new Map();
    /** @type {Registration[]} */
    #any = [];
    #seq = 0;

    /**
     * @param {{listenerErrorEvent?: string|null, strict?: boolean}} [arg0] - Event name a throwing
     *   listener is surfaced as (default `event:listener_error`); null disables. `strict` surfaces
     *   zero-listener events as `event:unhandled`.
     */
    constructor({ listenerErrorEvent = EVENTS.ERRORS.LISTENER_ERROR, strict = false } = {}) {
        super();
        this.listenerErrorEvent = listenerErrorEvent;
        this.strict = strict;
    }

    // ── registration ────────────────────────────────────────────────────────

    /** @param {string} event */
    #ensure(event) {
        let list = this.#patterns.get(event);
        if (!list) { list = []; this.#patterns.set(event, list); }
        return list;
    }

    /**
     * Appends a registration to `list`; returns an unsubscribe fn.
     * @param {{list: Registration[], fn: Function, options?: number|{priority?: number, prepend?: boolean, once?: boolean}}} arg0
     * @returns {() => void}
     */
    #push({ list, fn, options }) {
        if (typeof fn !== 'function') throw new TypeError('MerciEventEmitter: listener must be a function');
        const opts = typeof options === 'number' ? { priority: options } : (options || {});
        const reg = {
            fn,
            once: !!opts.once,
            priority: opts.prepend ? Number.MAX_SAFE_INTEGER : (Number(opts.priority) || 0),
            seq: this.#seq++,
        };
        list.push(reg);
        return () => {
            const i = list.indexOf(reg);
            if (i >= 0) list.splice(i, 1);
        };
    }

    /**
     * @param {{event: string, fn: Function, options?: number|{priority?: number, prepend?: boolean, once?: boolean}}} arg0
     * @returns {() => void}
     */
    #add({ event, fn, options }) {
        return this.#push({ list: this.#ensure(event), fn, options });
    }

    /**
     * Subscribes, returning an unsubscribe fn. Accepts a glob event name.
     * @param {[event: string, listener: Function, options?: number|ListenerOptions]} args
     * @returns {() => void}
     */
    subscribe(...args) {
        const [event, listener, options] = args;
        return this.#add({ event, fn: listener, options });
    }

    /**
     * Subscribes to every event, returning an unsubscribe fn.
     * @param {Function} listener
     * @returns {() => void}
     */
    onAny(listener) {
        return this.#push({ list: this.#any, fn: listener });
    }

    /**
     * @param {[event: string, listener: Function, options?: number|ListenerOptions]} args
     * @returns {this}
     */
    on(...args) {
        const [event, listener, options] = args;
        this.#add({ event, fn: listener, options });
        return this;
    }

    /** @param {[event: string, listener: Function, options?: number|ListenerOptions]} args @returns {this} */
    addListener(...args) { return this.on(...args); }

    /** @param {[event: string, listener: Function, options?: number|ListenerOptions]} args @returns {this} */
    once(...args) {
        const [event, listener, options] = args;
        const normalizedOptions = typeof options === 'number'
            ? { priority: options, once: true }
            : { ...(typeof options === 'object' ? options : {}), once: true };
        this.#add({ event, fn: listener, options: normalizedOptions });
        return this;
    }

    /** @param {[event: string, listener: Function]} args @returns {this} */
    prependListener(...args) {
        const [event, listener] = args;
        this.#add({ event, fn: listener, options: { prepend: true } });
        return this;
    }

    /** @param {[event: string, listener: Function]} args @returns {this} */
    prependOnceListener(...args) {
        const [event, listener] = args;
        this.#add({ event, fn: listener, options: { prepend: true, once: true } });
        return this;
    }

    /** @param {[event: string, listener: Function]} args @returns {this} */
    off(...args) {
        const [event, listener] = args;
        const list = this.#patterns.get(event);
        if (list) {
            const i = list.findIndex((r) => r.fn === listener);
            if (i >= 0) list.splice(i, 1);
            if (list.length === 0) this.#patterns.delete(event);
        }
        const ai = this.#any.findIndex((r) => r.fn === listener);
        if (ai >= 0) this.#any.splice(ai, 1);
        return this;
    }

    /** @param {[event: string, listener: Function]} args @returns {this} */
    removeListener(...args) { return this.off(...args); }

    /**
     * Removes a registration from whichever list holds it.
     * @param {Registration} reg
     */
    #removeReg(reg) {
        for (const list of this.#patterns.values()) {
            const i = list.indexOf(reg);
            if (i >= 0) { list.splice(i, 1); return; }
        }
        const ai = this.#any.indexOf(reg);
        if (ai >= 0) this.#any.splice(ai, 1);
    }

    // ── introspection ───────────────────────────────────────────────────────

    /**
     * Every registration matching `event`, in dispatch order
     * (priority desc, then insertion order).
     * @param {string} event
     * @returns {Registration[]}
     */
    #collect(event) {
        const out = [];
        for (const [pattern, regs] of this.#patterns) {
            if (this.#patternMatches({ pattern, event })) for (const r of regs) out.push(r);
        }
        for (const r of this.#any) out.push(r);
        out.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
        return out;
    }

    /**
     * @param {{pattern: string, event: string}} arg0
     * @returns {boolean}
     */
    #patternMatches({ pattern, event }) {
        return GLOB.test(pattern) ? globToRegExp(pattern).test(event) : pattern === event;
    }

    /** @param {[event?: string|symbol, listener?: Function]} args @returns {number} */
    listenerCount(...args) {
        const [event, listener] = args;
        if (event === undefined) {
            let n = this.#any.length;
            for (const list of this.#patterns.values()) n += list.length;
            return n;
        }
        if (typeof event === 'symbol') return 0;
        const regs = this.#collect(event);
        return listener ? regs.filter((r) => r.fn === listener).length : regs.length;
    }

    /** @param {string|symbol} event @returns {Array<(...args: unknown[]) => void>} */
    listeners(event) {
        return /** @type {Array<(...args: unknown[]) => void>} */ (this.#collect(/** @type {string} */ (event)).map((r) => r.fn));
    }

    /** @returns {string[]} */
    eventNames() { return [...this.#patterns.keys()]; }

    /** @param {string} [event] @returns {this} */
    removeAllListeners(event) {
        if (event === undefined) { this.#patterns.clear(); this.#any = []; }
        else this.#patterns.delete(event);
        return this;
    }

    // ── dispatch ────────────────────────────────────────────────────────────

    /**
     * @param {{sourceEvent: string, error: any}} arg0
     */
    #reportListenerError({ sourceEvent, error }) {
        const target = this.listenerErrorEvent;
        if (!target || target === sourceEvent) return;
        const payload = { sourceEvent, error: (/** @type {{message?: any}} */ (error))?.message ?? String(error) };
        for (const reg of this.#collect(target)) {
            if (reg.once) this.#removeReg(reg);
            try {
                const res = reg.fn.call(this, payload);
                if (res && typeof res.then === 'function') Promise.resolve(res).catch(() => {});
            } catch { /* listener-error handlers must never throw */ }
        }
    }

    /**
     * Runs every matching listener synchronously, isolating throws.
     * @param {{event: string, args: any[]}} arg0
     * @returns {number} listeners invoked
     */
    #invokeSync({ event, args }) {
        const regs = this.#collect(event);
        for (const reg of regs) {
            if (reg.once) this.#removeReg(reg);
            try {
                const result = reg.fn.apply(this, args);
                if (result && typeof result.then === 'function') {
                    Promise.resolve(result).catch((error) => this.#reportListenerError({ sourceEvent: event, error }));
                }
            } catch (error) {
                this.#reportListenerError({ sourceEvent: event, error });
            }
        }
        return regs.length;
    }

    /**
     * Opt-in strict mode: surfaces an event no listener matched as
     * `event:unhandled`. Never recurses and never throws.
     * @param {{event: string}} arg0
     */
    #reportUnhandled({ event }) {
        if (!this.strict) return;
        const target = EVENTS.ERRORS.UNHANDLED;
        if (event === target || event === 'error' || event === this.listenerErrorEvent) return;
        for (const reg of this.#collect(target)) {
            if (reg.once) this.#removeReg(reg);
            try {
                const res = reg.fn.call(this, { event });
                if (res && typeof res.then === 'function') Promise.resolve(res).catch(() => {});
            } catch { /* unhandled handlers must never throw */ }
        }
    }

    /**
     * Isolated dispatch: no listener throw escapes. Returns the invoked count.
     * @param {[event: string, ...rest: unknown[]]} args
     * @returns {number}
     */
    emitSafe(...args) {
        const [event, ...rest] = args;
        const invoked = this.#invokeSync({ event, args: rest });
        if (invoked === 0) this.#reportUnhandled({ event });
        return invoked;
    }

    /**
     * EventEmitter-compatible dispatch (isolated). The `error` event keeps the
     * Node convention: with no listener it delegates to EventEmitter, which
     * throws.
     * @param {[event: string, ...rest: unknown[]]} args
     * @returns {boolean}
     */
    emit(...args) {
        const [event, ...rest] = args;
        const regs = this.#collect(event);
        if (regs.length === 0) {
            if (event === 'error') return super.emit('error', ...rest);
            this.#reportUnhandled({ event });
            return false;
        }
        this.#invokeSync({ event, args: rest });
        return true;
    }

    /**
     * Awaitable ordered dispatch (the intervene layer). Each listener is
     * awaited before the next; throws are isolated like `emitSafe`.
     * @param {[event: string, ...rest: unknown[]]} args
     * @returns {Promise<number>} listeners invoked
     */
    async emitSerial(...args) {
        const [event, ...rest] = args;
        const regs = this.#collect(event);
        for (const reg of regs) {
            if (reg.once) this.#removeReg(reg);
            try {
                await reg.fn.apply(this, rest);
            } catch (error) {
                this.#reportListenerError({ sourceEvent: event, error });
            }
        }
        return regs.length;
    }

    [Symbol.dispose]() {
        this.removeAllListeners();
    }
}
