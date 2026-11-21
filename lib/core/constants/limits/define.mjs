// @ts-check
/**
 * @file Limit descriptor factory — the one shape every tunable declares.
 * @version 0.12.0
 *
 * @description
 * Every configurable number in the SDK declares itself here: env suffix,
 * default, clamp bounds, kill-switch value, and the flags the resolver needs.
 * The factory validates at module load, so a typo or an impossible bound fails
 * on import instead of at the first request.
 */

/** Largest delay Node's timers accept. A larger value fires after 1 ms. */
export const NODE_TIMER_MAX = 2_147_483_647;

/** Prefix every limit env key carries. */
export const LIMIT_ENV_PREFIX = 'MERCI_LIMIT_';


/**
 * Declares one tunable limit.
 *
 * `unbounded` is what the kill switch substitutes. It is per-limit because the
 * consumers disagree: a `.slice(0, n)` wants a huge number, `runCommand` wants
 * `0` to mean "no timeout", and a timer must stay under `NODE_TIMER_MAX`.
 *
 * @param {{env: string, legacyEnv?: Array<string>, default: number, min?: number, max?: number, unbounded: number, integer?: boolean, timer?: boolean, guard?: boolean, mutable?: boolean, doc: string}} arg0 -
 * @returns {Readonly<{env: string, legacyEnv: ReadonlyArray<string>, default: number, min: number|undefined, max: number|undefined, unbounded: number, integer: boolean, timer: boolean, guard: boolean, mutable: boolean, doc: string}>}
 */
export function defineLimit({
    env,
    legacyEnv = [],
    default: fallback,
    min,
    max,
    unbounded,
    integer = true,
    timer = false,
    guard = false,
    mutable = true,
    doc
}) {
    if (typeof env !== 'string' || env.length === 0) {
        throw new TypeError('defineLimit: env suffix is required');
    }
    if (typeof fallback !== 'number' || !Number.isFinite(fallback)) {
        throw new TypeError(`defineLimit(${env}): default must be a finite number`);
    }
    if (typeof unbounded !== 'number' || !Number.isFinite(unbounded)) {
        throw new TypeError(`defineLimit(${env}): unbounded must be a finite number`);
    }
    if (timer && unbounded > NODE_TIMER_MAX) {
        throw new TypeError(`defineLimit(${env}): a timer's unbounded value must be <= ${NODE_TIMER_MAX}`);
    }
    if (unbounded < fallback) {
        throw new TypeError(`defineLimit(${env}): unbounded ${unbounded} is below default ${fallback}; the switch would tighten it`);
    }
    if (max !== undefined && unbounded > max) {
        throw new TypeError(`defineLimit(${env}): unbounded ${unbounded} is above max ${max}; the switch would exceed the documented ceiling`);
    }
    if (!Array.isArray(legacyEnv) || legacyEnv.some((name) => typeof name !== 'string' || name.length === 0)) {
        throw new TypeError(`defineLimit(${env}): legacyEnv must be an array of env names`);
    }
    if (min !== undefined && fallback < min) {
        throw new TypeError(`defineLimit(${env}): default ${fallback} is below min ${min}`);
    }
    if (max !== undefined && fallback > max) {
        throw new TypeError(`defineLimit(${env}): default ${fallback} is above max ${max}`);
    }
    if (typeof doc !== 'string' || doc.length === 0) {
        throw new TypeError(`defineLimit(${env}): doc is required`);
    }
    return Object.freeze({
        env: `${LIMIT_ENV_PREFIX}${env}`,
        legacyEnv: Object.freeze([...legacyEnv]),
        default: fallback,
        min,
        max,
        unbounded,
        integer,
        timer,
        guard,
        mutable,
        doc
    });
}
