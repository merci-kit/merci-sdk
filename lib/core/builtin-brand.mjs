// @ts-check

/**
 * The built-in tool tier is forged-proof against the DATA: SDK tool factories
 * brand their definitions with a module-scoped Symbol, and `executeTools`
 * trusts ONLY the brand — a caller-supplied plain `builtIn: true` boolean is
 * inert, so a planted plain-object tool can never hijack the tier (and
 * displace a confined built-in at e.g. the plan-exit HITL gate) by stamping
 * itself. Ceiling: the Symbol is exported for the SDK factories, so a
 * same-process consumer that imports markBuiltIn can brand its own tool —
 * accepted: such a consumer could equally monkey-patch any SDK function.
 * @type {symbol}
 */
export const BUILTIN_BRAND = Symbol('merci.tools.builtIn');


/**
 * Stamps a tool definition as an SDK built-in. Non-enumerable — the brand
 * never leaks into `Object.keys`, JSON serialization, or wire mappings.
 * @template {Object} T
 * @param {{tool: T}} arg0 -
 * @returns {T}
 */
export function markBuiltIn({ tool }) {
    Object.defineProperty(tool, BUILTIN_BRAND, { value: true, enumerable: false });
    return tool;
}


/**
 * @param {{tool: Object|null|undefined}} arg0 -
 * @returns {boolean}
 */
export function isBuiltIn({ tool }) {
    return !!(tool && /** @type {any} */ (tool)[BUILTIN_BRAND]);
}
