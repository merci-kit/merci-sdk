// @ts-check
/**
 * @file The one resolution layer for every tunable limit.
 * @version 0.12.0
 *
 * @description
 * Turns the declarative registry in `./constants/limits/` into effective
 * values. Precedence is fixed:
 *
 *   code default -> merci-limits.json -> MERCI_LIMIT_* env -> setLimits()
 *
 * and the kill switch sits above all four:
 *
 *   MERCI_LIMITS=limits_off      (or setLimits({ disabled: true }))
 *   MERCI_LIMITS_DISABLED=a,b    (per key)
 *   MERCI_LIMIT_<KEY>=off        (per key, any source)
 *
 * Disabling never mutates a stored value. It short-circuits resolution to the
 * descriptor's `unbounded` value, so switching back on restores exactly the
 * value that won before. Reads happen per call, never at import, because a
 * host sets `secret.env` after this module is loaded.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LIMIT_REGISTRY } from './constants/limits.mjs';
// This import closes a cycle: errors.mjs reads LIMITS.stderr_tail_chars. It is
// safe because both sides only touch the binding inside a function body, never
// at module evaluation time.
import { ConfigurationError } from './errors.mjs';

/** Default project config file, relative to `process.cwd()`. */
export const LIMITS_CONFIG_FILE = 'merci-limits.json';

/** Env key of the global kill switch. */
export const LIMITS_SWITCH_ENV = 'MERCI_LIMITS';

/** Env key listing individually disabled limit keys. */
export const LIMITS_DISABLED_ENV = 'MERCI_LIMITS_DISABLED';

/** Env key pointing at a non-default config file. */
export const LIMITS_FILE_ENV = 'MERCI_LIMITS_FILE';

/** Env key that lets the switch disable a `guard` limit. */
export const LIMITS_GUARD_ENV = 'MERCI_LIMITS_ALLOW_GUARD_OFF';

/** Values accepted as "off" for one limit. */
const OFF_VALUES = new Set(['off', 'limits_off', 'none', 'unlimited', 'disabled', 'null']);

/**
 * @typedef {Object} LimitEntry
 * @property {string} env
 * @property {ReadonlyArray<string>} legacyEnv
 * @property {number} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} unbounded
 * @property {boolean} integer
 * @property {boolean} timer
 * @property {boolean} guard
 * @property {boolean} mutable
 * @property {string} doc
 */

/** Registry with a string index; built once. */
const REGISTRY = /** @type {Record<string, LimitEntry>} */ (LIMIT_REGISTRY);

const KEYS = Object.keys(REGISTRY);

/** Programmatic overrides applied by setLimits(). */
const overrides = new Map();

/** Keys disabled programmatically or through config. */
const disabledKeys = new Set();

/** Programmatic global switch. */
let disabled = false;

/** Whether the global switch may disable a safety guard. */
let allowGuardOff = false;

/** Cached config file; reloadable via reloadLimits(). */
let fileState = /** @type {{loaded: boolean, path: string, values: Record<string, unknown>, disabled: Array<string>}} */ ({ loaded: false, path: '', values: {}, disabled: [] });

/** Warnings already emitted, keyed by a stable id. */
const warned = new Set();

/** @type {(message: string) => void} */
let warnHandler = (message) => { console.warn(message); };


/**
 * Replaces the warning sink (tests and hosts that route SDK warnings).
 * @param {{handler: (message: string) => void}} arg0 -
 * @returns {void}
 */
export function setLimitWarningHandler({ handler }) {
    warnHandler = handler;
}


/**
 * Emits one warning per key, then stays quiet.
 * @param {{id: string, message: string}} arg0 -
 * @returns {void}
 */
function warnOnce({ id, message }) {
    if (warned.has(id) || warned.size > 1_000) return;
    warned.add(id);
    warnHandler(`merci limits: ${message}`);
}


/**
 * @param {unknown} value -
 * @returns {boolean}
 */
function isOff(value) {
    return typeof value === 'string' && OFF_VALUES.has(value.trim().toLowerCase());
}


/**
 * Whether a raw string is an explicit "on" so the per-key env can cancel a
 * previous `off`; kept for symmetry with the accepted switch vocabulary.
 * @param {unknown} value -
 * @returns {boolean}
 */
function isOn(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim().toLowerCase();
    return v === 'on' || v === 'limits_on' || v === '1' || v === 'true' || v === 'enabled';
}


/**
 * @returns {boolean}
 */
function envSwitchOff() {
    const value = process.env[LIMITS_SWITCH_ENV];
    return isOff(value) || value === '0' || value === 'false';
}


/**
 * @returns {Set<string>}
 */
function envDisabledKeys() {
    const raw = process.env[LIMITS_DISABLED_ENV];
    if (!raw) return new Set();
    return new Set(raw.split(',').map((part) => part.trim()).filter(Boolean));
}


/**
 * @returns {boolean}
 */
function guardOffAllowed() {
    if (allowGuardOff) return true;
    const raw = process.env[LIMITS_GUARD_ENV];
    return raw === '1' || raw === 'true' || (isOn(raw) && !isOff(raw));
}


/**
 * Loads `merci-limits.json` once. A malformed or missing file is not fatal:
 * it warns once and behaves as if absent.
 * @returns {{loaded: boolean, path: string, values: Record<string, unknown>, disabled: Array<string>}}
 */
function loadFile() {
    if (fileState.loaded) return fileState;
    fileState.loaded = true;
    const path = process.env[LIMITS_FILE_ENV]?.trim() || resolve(process.cwd(), LIMITS_CONFIG_FILE);
    fileState.path = path;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)
            ? parsed.values
            : {};
        const disabledList = Array.isArray(parsed?.disabled) ? parsed.disabled.map(String) : [];
        for (const key of Object.keys(values)) {
            if (!REGISTRY[key]) warnOnce({ id: `file:unknown:${key}`, message: `ignoring unknown key '${key}' in ${path}.` });
        }
        for (const key of disabledList) {
            if (!REGISTRY[key]) warnOnce({ id: `file:unknown:${key}`, message: `ignoring unknown key '${key}' in ${path}.disabled.` });
        }
        fileState.values = values;
        fileState.disabled = disabledList;
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const message = error instanceof Error ? error.message : String(error);
        if (code !== 'ENOENT') {
            warnOnce({ id: `file:${path}`, message: `ignoring ${path}: ${message}` });
        }
    }
    return fileState;
}


/**
 * @param {{entry: LimitEntry, key: string}} arg0 -
 * @returns {{raw: unknown, source: string}|null}
 */
function pickRaw({ entry, key }) {
    if (overrides.has(key)) return { raw: overrides.get(key), source: 'programmatic' };
    const envValue = process.env[entry.env];
    if (envValue !== undefined && envValue !== '') {
        if (!entry.mutable) {
            warnOnce({
                id: `fixed:env:${key}`,
                message: `'${key}' is fixed (${entry.doc}); ${entry.env} is ignored.`
            });
            return null;
        }
        return { raw: envValue, source: 'environment' };
    }
    for (const legacy of entry.legacyEnv ?? []) {
        const legacyValue = process.env[legacy];
        if (legacyValue === undefined || legacyValue === '') continue;
        if (!entry.mutable) {
            warnOnce({ id: `fixed:env:${key}`, message: `'${key}' is fixed (${entry.doc}); ${legacy} is ignored.` });
            return null;
        }
        return { raw: legacyValue, source: 'environment' };
    }
    const file = loadFile();
    if (Object.prototype.hasOwnProperty.call(file.values, key)) {
        if (!entry.mutable) {
            warnOnce({
                id: `fixed:file:${key}`,
                message: `'${key}' is fixed (${entry.doc}); the config-file value is ignored.`
            });
            return null;
        }
        return { raw: file.values[key], source: 'file' };
    }
    return null;
}


/**
 * @param {{entry: LimitEntry, key: string}} arg0 -
 * @returns {{value: number, source: string}}
 */
function suspendedValue({ entry, key }) {
    if (entry.guard && !guardOffAllowed()) {
        // The switch suspends enforcement, it does not erase configuration: the
        // held guard keeps whatever value won. A raise is refused here too, or
        // the switch would launder the exact widening the guard path rejects.
        const picked = pickRaw({ entry, key });
        const parsed = picked ? parseRaw({ entry, key, raw: picked.raw, source: picked.source }) : undefined;
        const held = parsed !== undefined && parsed <= entry.default ? parsed : entry.default;
        warnOnce({
            id: 'guard',
            message: `safety guards (e.g. '${key}') stay at their configured value under the switch (holding '${key}' at ${held}). Set ${LIMITS_GUARD_ENV}=1 to disable them too.`
        });
        return { value: held, source: picked && parsed === held ? picked.source : 'guard' };
    }
    return { value: entry.unbounded, source: 'disabled' };
}


/**
 * @param {{entry: LimitEntry, key: string}} arg0 -
 * @returns {boolean}
 */
function isSuspended({ entry: _entry, key }) {
    if (disabled || envSwitchOff()) return true;
    if (disabledKeys.has(key)) return true;
    const listed = envDisabledKeys();
    for (const name of listed) {
        if (!REGISTRY[name]) warnOnce({ id: `env:unknown:${name}`, message: `ignoring unknown key '${name}' in ${LIMITS_DISABLED_ENV}.` });
    }
    if (listed.has(key)) return true;
    if (loadFile().disabled.includes(key)) return true;
    return false;
}


/**
 * @param {{entry: LimitEntry, key: string, raw: unknown, source: string, notify?: boolean}} arg0 -
 * @returns {number|undefined} The parsed value, or undefined when the raw value is unusable.
 */
function parseRaw({ entry, key, raw, source, notify = true }) {
    let value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(value)) {
        if (notify) {
            warnOnce({
                id: `invalid:${key}:${source}`,
                message: `'${key}' from ${source} is not a number; using the default ${entry.default}.`
            });
        }
        return undefined;
    }
    if (entry.integer) value = Math.trunc(value);
    if (entry.min !== undefined && value < entry.min) {
        if (notify) warnOnce({ id: `min:${key}:${source}`, message: `'${key}' from ${source} is below ${entry.min}; clamped.` });
        value = entry.min;
    }
    if (entry.max !== undefined && value > entry.max) {
        if (notify) warnOnce({ id: `max:${key}:${source}`, message: `'${key}' from ${source} is above ${entry.max}; clamped.` });
        value = entry.max;
    }
    return value;
}


/**
 * @param {{entry: LimitEntry, key: string}} arg0 -
 * @returns {{value: number, source: string}}
 */
function resolveWithSource({ entry, key }) {
    if (isSuspended({ entry, key })) return suspendedValue({ entry, key });
    const picked = pickRaw({ entry, key });
    if (!picked) return { value: entry.default, source: 'default' };
    if (isOff(picked.raw)) return suspendedValue({ entry, key });
    const parsed = parseRaw({ entry, key, raw: picked.raw, source: picked.source });
    if (parsed === undefined) return { value: entry.default, source: 'default' };
    // A guard defends against an untrusted input; letting a plain number widen it
    // is a silent hole. Lowering stays free.
    if (entry.guard && parsed > entry.default && !guardOffAllowed()) {
        warnOnce({
            id: `guard:raise:${key}`,
            message: `'${key}' from ${picked.source} would raise a safety guard above its default ${entry.default}; keeping ${entry.default}. Set ${LIMITS_GUARD_ENV}=1 to allow the raise.`
        });
        return { value: entry.default, source: 'default' };
    }
    return { value: parsed, source: picked.source };
}


/**
 * Resolves one limit for the current process state.
 * @param {{key?: string}} [arg0] -
 * @returns {number}
 */
export function resolveLimit({ key = '' } = {}) {
    const entry = REGISTRY[key];
    if (!entry) {
        throw new ConfigurationError({ message: `Unknown limit '${key}'. Use getLimits() to list the configured keys.` });
    }
    return resolveWithSource({ entry, key }).value;
}


/**
 * Every limit as a lazy property, so a read sees the current env, file and
 * programmatic state. `LIMITS.max_iterations` is the call-site form.
 * @type {Record<string, number>}
 */
export const LIMITS = {};
for (const key of KEYS) {
    Object.defineProperty(LIMITS, key, {
        enumerable: true,
        get: () => resolveLimit({ key })
    });
}
Object.freeze(LIMITS);


/**
 * @returns {Array<{key: string, value: number, source: string, default: number, env: string, doc: string, guard: boolean, mutable: boolean, disabled: boolean, heldByGuard: boolean, timer: boolean}>}
 */
export function getLimits() {
    return KEYS.map((key) => {
        const entry = REGISTRY[key];
        const resolved = resolveWithSource({ entry, key });
        return {
            key,
            value: resolved.value,
            source: resolved.source,
            default: entry.default,
            env: entry.env,
            doc: entry.doc,
            guard: entry.guard,
            mutable: entry.mutable,
            timer: entry.timer,
            disabled: resolved.source === 'disabled',
            // A held guard may report its configured source ('file'/'environment'),
            // so the flag follows the guard state, not the source label.
            heldByGuard: resolved.source === 'guard' || (entry.guard && !guardOffAllowed() && isSuspended({ entry, key }))
        };
    });
}


/**
 * Applies programmatic overrides. Every value is validated eagerly, so a bad
 * call fails here instead of at the first request.
 * @param {{values?: Record<string, number|string>, disabled?: boolean, disabledKeys?: Array<string>, allowGuardOff?: boolean}} [arg0] -
 * @returns {ReturnType<typeof getLimits>}
 */
export function setLimits({ values = {}, disabled: nextDisabled, disabledKeys: nextDisabledKeys, allowGuardOff: nextAllowGuardOff } = {}) {
    // Pass 1 validates the whole call; nothing is applied (and nothing warns) until every entry is known-good.
    if (Array.isArray(nextDisabledKeys)) {
        for (const key of nextDisabledKeys) {
            if (!REGISTRY[key]) {
                throw new ConfigurationError({ message: `setLimits: unknown limit '${key}' in disabledKeys. Nothing was applied.` });
            }
        }
    }
    /** @type {Array<{key: string, value: number|'off'}>} */
    const pending = [];
    for (const [key, raw] of Object.entries(values)) {
        const entry = REGISTRY[key];
        if (!entry) {
            throw new ConfigurationError({ message: `setLimits: unknown limit '${key}'. Nothing was applied.` });
        }
        if (!entry.mutable) {
            throw new ConfigurationError({ message: `setLimits: '${key}' is fixed (${entry.doc}) and cannot be overridden. Nothing was applied.` });
        }
        if (isOff(raw)) {
            pending.push({ key, value: 'off' });
            continue;
        }
        const parsed = parseRaw({ entry, key, raw, source: 'setLimits', notify: false });
        if (parsed === undefined) {
            throw new ConfigurationError({ message: `setLimits: '${key}' must be a finite number, got ${JSON.stringify(raw)}. Nothing was applied.` });
        }
        pending.push({ key, value: parsed });
    }
    // Pass 2 applies: the explicit disabled list replaces first, then values land on top.
    if (Array.isArray(nextDisabledKeys)) {
        disabledKeys.clear();
        for (const key of nextDisabledKeys) disabledKeys.add(String(key));
    }
    for (const item of pending) {
        if (item.value === 'off') {
            disabledKeys.add(item.key);
            // The disabled set short-circuits resolution; the stored value stays
            // so re-enabling restores it.
            continue;
        }
        overrides.set(item.key, item.value);
        disabledKeys.delete(item.key);
    }
    if (typeof nextDisabled === 'boolean') disabled = nextDisabled;
    if (typeof nextAllowGuardOff === 'boolean') allowGuardOff = nextAllowGuardOff;
    return getLimits();
}


/**
 * Drops every programmatic override and the programmatic switch. Config-file
 * and environment values still apply.
 * @returns {ReturnType<typeof getLimits>}
 */
export function resetLimits() {
    overrides.clear();
    disabledKeys.clear();
    disabled = false;
    allowGuardOff = false;
    const snapshot = getLimits();
    warned.clear();
    return snapshot;
}


/**
 * Re-reads `merci-limits.json` on the next resolution.
 * @returns {void}
 */
export function reloadLimits() {
    fileState = { loaded: false, path: '', values: {}, disabled: [] };
}
