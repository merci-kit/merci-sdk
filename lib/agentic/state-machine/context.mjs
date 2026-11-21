// @ts-check
import { safeStringify } from '../../support/utils.mjs';

/**
 * @file StateContext — the StateMachine's shared key/value context.
 * @version 0.12.0
 *
 * @description
 * A simple key/value bag shared across StateMachine nodes: set/get/push/
 * increment/patch plus JSON serialization (toPayloadString/fromJSON).
 * Stringified with safeStringify so circular payloads (a node returning the
 * context itself) never throw.
 */

/**
 * The shared key/value context of a StateMachine run.
 */
export class StateContext {
  /** @type {Record<string, any>} */
  #data = {};

  /**
   * @param {{initial?: Record<string, unknown>}} [arg0]
   */
  constructor({ initial = {} } = {}) { this.#data = { ...initial }; }

  /**
   * Reads a key.
   * @param {{k: string}} arg0
   * @returns {unknown} Whatever was stored (anything JSON-serializable).
   */
  get({ k }) { return this.#data[k]; }

  /**
   * Sets a key (chainable).
   * @param {{k: string, v: unknown}} arg0
   * @returns {StateContext}
   */
  set({ k, v }) { this.#data[k] = v; return this; }

  /**
   * Removes a key (chainable) — used to drop a failed candidate so a retry
   * cannot leave a stale artifact behind.
   * @param {{k: string}} arg0
   * @returns {StateContext}
   */
  delete({ k }) { delete this.#data[k]; return this; }

  /**
   * Appends a value to the array at `k` (coercing a non-array to one).
   * @param {{k: string, v: unknown}} arg0
   * @returns {StateContext}
   */
  push({ k, v }) {
    if (!Array.isArray(this.#data[k])) this.#data[k] = [];
    this.#data[k].push(v);
    return this;
  }

  /**
   * Increments the number at `k` (from 0 when absent).
   * @param {{k: string}} arg0
   * @returns {StateContext}
   */
  increment({ k }) { this.#data[k] = (this.#data[k] ?? 0) + 1; return this; }

  /**
   * A shallow copy of all entries.
   * @returns {Record<string, unknown>}
   */
  getAll() { return { ...this.#data }; }

  /**
   * Merges entries into the context (chainable).
   * @param {{obj: Record<string, unknown>}} arg0
   * @returns {StateContext}
   */
  patch({ obj }) { Object.assign(this.#data, obj); return this; }

  /**
   * JSON string of the context (cycle-safe).
   * @returns {string}
   */
  toPayloadString() { return safeStringify({ value: this.#data }); }

  /**
   * Merges a JSON string back into the context (chainable).
   * @param {{str: string}} arg0
   * @returns {StateContext}
   */
  fromPayloadString({ str }) {
    const d = JSON.parse(str);
    Object.assign(this.#data, d);
    return this;
  }

  /**
   * The raw backing object.
   * @returns {Record<string, unknown>}
   */
  toJSON() { return this.#data; }

  /**
   * Rehydrates a context from a plain object.
   * @param {Record<string, unknown>} j
   * @returns {StateContext}
   */
  static fromJSON(j) { const c = new StateContext(); c.#data = j; return c; }
}
