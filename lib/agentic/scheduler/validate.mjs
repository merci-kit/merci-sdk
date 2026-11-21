// @ts-check


/**
 * @file Pure configuration validation for `WorkScheduler`.
 * @version 0.12.0
 *
 * @description
 * `validateSchedulerConfig` returns error strings instead of throwing so the
 * same function serves `start()` (which throws `ConfigurationError`) and every
 * tick (which emits `scheduler:validation_error` and skips dispatch). Checks
 * are structural only; a preflight hook is called by the scheduler, not here.
 *
 * Duplicate identifiers are a data check, not a config check: every fetch runs
 * `collectDuplicateIdentifiers` and the scheduler excludes each duplicated
 * identifier for that tick (AC19).
 */
import { isRecordObject } from '../../support/validation.mjs';

/**
 * Trim and lowercase, the same comparison `normalize.mjs` uses for states and
 * labels. Non-strings and blanks are null.
 * @param {{value: unknown}} arg0 -
 * @returns {string|null}
 */
function normalized({ value }) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed === '' ? null : trimmed;
}

/**
 * @param {unknown} value -
 * @returns {value is unknown[]}
 */
function isArray(value) {
    return Array.isArray(value);
}

/**
 * @param {{value: unknown}} arg0 -
 * @returns {boolean}
 */
function isFiniteNumber({ value }) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Collect every duplicated identifier in first-seen order, deduped. Comparison
 * is trim + lowercase; the returned value is the first-seen trimmed spelling.
 * @param {{items: ReadonlyArray<unknown>}} arg0 -
 * @returns {string[]}
 */
export function collectDuplicateIdentifiers({ items }) {
    if (!isArray(items)) return [];
    /** @type {Map<string, string>} */
    const firstSeen = new Map();
    /** @type {Set<string>} */
    const reported = new Set();
    /** @type {string[]} */
    const duplicates = [];
    for (const item of items) {
        if (!isRecordObject(item)) continue;
        const raw = item.identifier;
        const key = normalized({ value: raw });
        if (key === null) continue;
        if (!firstSeen.has(key)) {
            firstSeen.set(key, /** @type {string} */ (raw).trim());
            continue;
        }
        if (reported.has(key)) continue;
        reported.add(key);
        duplicates.push(/** @type {string} */ (firstSeen.get(key)));
    }
    return duplicates;
}

/**
 * Validate the merged scheduler configuration. Absent optional keys are valid;
 * the scheduler fills construction defaults before calling this.
 * @param {{options?: Record<string, unknown>}} [arg0] -
 * @returns {string[]} Human-readable errors; empty when valid.
 */
export function validateSchedulerConfig({ options = {} } = {}) {
    const config = isRecordObject(options) ? options : {};
    /** @type {string[]} */
    const errors = [];

    const workSource = config.workSource;
    if (!isRecordObject(workSource) || typeof workSource.fetchByStates !== 'function') {
        errors.push('workSource.fetchByStates must be a function');
    }
    if (!isRecordObject(workSource) || typeof workSource.fetchByIds !== 'function') {
        errors.push('workSource.fetchByIds must be a function');
    }
    const workflow = config.workflow;
    if (!isRecordObject(workflow) || typeof workflow.run !== 'function') {
        errors.push('workflow.run must be a function');
    }

    const activeStates = config.activeStates;
    if (!isArray(activeStates) || activeStates.length === 0) {
        errors.push('activeStates must be a non-empty array of strings');
    } else if (!activeStates.every((state) => normalized({ value: state }) !== null)) {
        errors.push('activeStates must contain only non-empty strings');
    }
    const terminalStates = config.terminalStates;
    if (!isArray(terminalStates)) {
        errors.push('terminalStates must be an array of strings');
    } else if (!terminalStates.every((state) => typeof state === 'string')) {
        errors.push('terminalStates must contain only strings');
    }
    if (isArray(activeStates) && isArray(terminalStates)) {
        /** @type {Set<string>} */
        const activeKeys = new Set();
        for (const state of activeStates) {
            const key = normalized({ value: state });
            if (key !== null) activeKeys.add(key);
        }
        for (const state of terminalStates) {
            const key = normalized({ value: state });
            if (key !== null && activeKeys.has(key)) {
                errors.push(`activeStates and terminalStates overlap at "${key}"`);
                break;
            }
        }
    }

    const concurrency = config.concurrency;
    if (!isRecordObject(concurrency)) {
        errors.push('concurrency must be an object');
    } else {
        const global = concurrency.global;
        if (!Number.isInteger(global) || /** @type {number} */ (global) < 1) {
            errors.push('concurrency.global must be an integer >= 1');
        }
        if (concurrency.byLane !== undefined) {
            if (!isRecordObject(concurrency.byLane)) {
                errors.push('concurrency.byLane must be an object');
            } else {
                for (const [lane, limit] of Object.entries(concurrency.byLane)) {
                    if (!Number.isInteger(limit) || /** @type {number} */ (limit) < 1) {
                        errors.push(`concurrency.byLane.${lane} must be an integer >= 1`);
                    }
                }
            }
        }
    }

    if (!Number.isInteger(config.pollIntervalMs) || /** @type {number} */ (config.pollIntervalMs) <= 0) {
        errors.push('pollIntervalMs must be an integer > 0');
    }
    if (!Number.isInteger(config.stallTimeoutMs) || /** @type {number} */ (config.stallTimeoutMs) < 0) {
        errors.push('stallTimeoutMs must be an integer >= 0');
    }

    const retry = config.retry;
    if (!isRecordObject(retry)) {
        errors.push('retry must be an object');
    } else {
        if (!isFiniteNumber({ value: retry.baseMs }) || /** @type {number} */ (retry.baseMs) < 0) {
            errors.push('retry.baseMs must be a finite number >= 0');
        }
        if (!isFiniteNumber({ value: retry.maxMs })) {
            errors.push('retry.maxMs must be a finite number');
        } else if (isFiniteNumber({ value: retry.baseMs }) && /** @type {number} */ (retry.maxMs) < /** @type {number} */ (retry.baseMs)) {
            errors.push('retry.maxMs must be >= retry.baseMs');
        }
    }

    const continuation = config.continuation;
    if (!isRecordObject(continuation)) {
        errors.push('continuation must be an object');
    } else {
        if (!isFiniteNumber({ value: continuation.delayMs }) || /** @type {number} */ (continuation.delayMs) < 0) {
            errors.push('continuation.delayMs must be a finite number >= 0');
        }
        if (!Number.isInteger(continuation.max) || /** @type {number} */ (continuation.max) < 0) {
            errors.push('continuation.max must be an integer >= 0');
        }
    }

    const limits = config.limits;
    if (!isRecordObject(limits)) {
        errors.push('limits must be an object');
    } else {
        if (!Number.isInteger(limits.maxAttemptsPerItem) || /** @type {number} */ (limits.maxAttemptsPerItem) < 1) {
            errors.push('limits.maxAttemptsPerItem must be an integer >= 1');
        }
        for (const key of ['maxDispatches', 'maxTotalTokens', 'maxTotalUsd']) {
            const value = limits[key];
            if (value !== undefined && value !== null && (!isFiniteNumber({ value }) || /** @type {number} */ (value) <= 0)) {
                errors.push(`limits.${key} must be a positive number or null`);
            }
        }
    }

    const requiredLabels = config.requiredLabels;
    if (!isArray(requiredLabels) || !requiredLabels.every((label) => typeof label === 'string')) {
        errors.push('requiredLabels must be an array of strings');
    }
    if (config.filter !== undefined && config.filter !== null && typeof config.filter !== 'function') {
        errors.push('filter must be a function when set');
    }

    if (config.workspace !== undefined && config.workspace !== null) {
        if (!isRecordObject(config.workspace)) {
            errors.push('workspace must be an object when set');
        } else {
            for (const method of ['ensure', 'beforeRun', 'afterRun', 'remove', 'handleFor']) {
                if (typeof config.workspace[method] !== 'function') {
                    errors.push(`workspace.${method} must be a function`);
                }
            }
        }
    }

    const claims = config.claims;
    if (claims !== 'memory') {
        if (!isRecordObject(claims)) {
            errors.push("claims must be a claim store object or 'memory'");
        } else {
            for (const method of ['acquire', 'release', 'isClaimed', 'list']) {
                if (typeof claims[method] !== 'function') {
                    errors.push(`claims.${method} must be a function`);
                }
            }
        }
    }

    const attemptStore = config.attemptStore;
    // Absent is the constructor default (the in-process store); a supplied
    // value must be a store or an explicit null.
    if (attemptStore !== null && attemptStore !== undefined) {
        if (!isRecordObject(attemptStore)) {
            errors.push('attemptStore must be an attempt store object or null');
        } else {
            for (const method of ['load', 'save', 'clear', 'list']) {
                if (typeof attemptStore[method] !== 'function') {
                    errors.push(`attemptStore.${method} must be a function`);
                }
            }
        }
    }

    if (isRecordObject(concurrency) && typeof concurrency.global === 'number' && concurrency.global > 1
        && (config.workspace === undefined || config.workspace === null)
        && config.allowSharedWorkspace !== true) {
        errors.push('concurrency.global > 1 requires a workspace manager or allowSharedWorkspace: true');
    }

    if (config.signal !== undefined && config.signal !== null && !(config.signal instanceof AbortSignal)) {
        errors.push('signal must be an AbortSignal');
    }
    if (config.clock !== undefined && config.clock !== null) {
        if (!isRecordObject(config.clock)) {
            errors.push('clock must be an object');
        } else {
            if (typeof config.clock.now !== 'function') errors.push('clock.now must be a function');
            if (typeof config.clock.setTimeout !== 'function') errors.push('clock.setTimeout must be a function');
            if (typeof config.clock.clearTimeout !== 'function') errors.push('clock.clearTimeout must be a function');
        }
    }
    if (config.preflight !== undefined && config.preflight !== null && typeof config.preflight !== 'function') {
        errors.push('preflight must be a function when set');
    }

    return errors;
}
