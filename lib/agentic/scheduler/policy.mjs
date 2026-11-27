// @ts-check

/**
 * @file Pure scheduler policy: config patches, dispatch eligibility, slots, budgets.
 * @version 0.12.0
 */
import { isDeepStrictEqual } from 'node:util';

import { isRecordObject } from '../../support/validation.mjs';
import { isActiveState, isTerminalState } from './normalize.mjs';

/** The keys `applyConfig` may change. Bound collaborators are refused first. */
export const MANAGED_KEYS = Object.freeze([
    'activeStates',
    'terminalStates',
    'requiredLabels',
    'pollIntervalMs',
    'stallTimeoutMs',
    'concurrency',
    'retry',
    'continuation',
    'limits',
    'filter',
    'preflight'
]);

/**
 * @param {{current: Record<string, unknown>, patch: Record<string, unknown>}} arg0
 * @returns {Record<string, unknown>}
 */
export function mergeSchedulerConfig({ current, patch }) {
    const merged = { ...current };
    for (const key of MANAGED_KEYS) {
        if (Object.hasOwn(patch, key)) merged[key] = patch[key];
    }
    return merged;
}

/**
 * @param {{current: Record<string, unknown>, patch: Record<string, unknown>, merged: Record<string, unknown>}} arg0
 * @returns {string[]}
 */
export function changedSchedulerKeys({ current, patch, merged }) {
    /** @type {string[]} */
    const changed = [];
    for (const key of MANAGED_KEYS) {
        if (!Object.hasOwn(patch, key)) continue;
        if (!isDeepStrictEqual(current[key], merged[key])) changed.push(key);
    }
    return changed.sort();
}

/**
 * @param {{running: number, claiming: number, limit: number}} arg0
 * @returns {boolean}
 */
export function hasGlobalSlot({ running, claiming, limit }) {
    return running + claiming < limit;
}

/**
 * @param {{lane: string, running: Map<string, {lane: string}>, claiming: Map<string, string>, byLane: unknown}} arg0
 * @returns {boolean}
 */
export function hasLaneSlot({ lane, running, claiming, byLane }) {
    if (!isRecordObject(byLane)) return true;
    const lanes = /** @type {Record<string, unknown>} */ (byLane);
    if (!Object.hasOwn(lanes, lane)) return true;
    const limit = lanes[lane];
    if (!Number.isInteger(limit)) return true;
    let used = 0;
    for (const entry of running.values()) {
        if (entry.lane === lane) used += 1;
    }
    for (const claimingLane of claiming.values()) {
        if (claimingLane === lane) used += 1;
    }
    return used < /** @type {number} */ (limit);
}

/**
 * @param {{limits: {maxDispatches?: number|null, maxTotalTokens?: number|null, maxTotalUsd?: number|null}, totals: {dispatches: number, totalTokens: number, costUsd: number, costComplete: boolean}}} arg0
 * @returns {'maxDispatches'|'maxTotalTokens'|'maxTotalUsd'|null}
 */
export function schedulerBudgetLimit({ limits, totals }) {
    const dispatches = limits.maxDispatches;
    if (typeof dispatches === 'number' && totals.dispatches >= dispatches) return 'maxDispatches';
    const maxTotalTokens = limits.maxTotalTokens;
    if (typeof maxTotalTokens === 'number' && totals.totalTokens >= maxTotalTokens) return 'maxTotalTokens';
    const maxTotalUsd = limits.maxTotalUsd;
    if (typeof maxTotalUsd === 'number' && totals.costComplete && totals.costUsd >= maxTotalUsd) {
        return 'maxTotalUsd';
    }
    return null;
}

/**
 * @param {{totals: {inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number, dispatches: number, attempts: number, failures: number, usageComplete: boolean, costComplete: boolean}}} arg0
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number, dispatches: number, attempts: number, failures: number, usageComplete: boolean, costComplete: boolean}}
 */
export function schedulerBudgetTotals({ totals }) {
    return {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
        costUsd: totals.costUsd,
        dispatches: totals.dispatches,
        attempts: totals.attempts,
        failures: totals.failures,
        usageComplete: totals.usageComplete,
        costComplete: totals.costComplete
    };
}

/**
 * @param {{item: import('./normalize.mjs').WorkItem, requiredLabels: string[], filter: Function|null, filterReceiver: object}} arg0
 * @returns {boolean}
 */
export function isSchedulerItemRoutable({ item, requiredLabels, filter, filterReceiver }) {
    if (item.dispatchable !== true) return false;
    for (const label of requiredLabels) {
        if (typeof label !== 'string') return false;
        if (!item.labels.includes(label.trim().toLowerCase())) return false;
    }
    if (filter !== null) {
        try {
            if (!Reflect.apply(filter, filterReceiver, [{ item }])) return false;
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * @param {{item: import('./normalize.mjs').WorkItem, activeStates: string[], terminalStates: string[], requiredLabels: string[], filter: Function|null, filterReceiver: object, running: Map<string, {lane: string}>, claiming: Map<string, string>, claimed: Set<string>, parked: Map<string, unknown>, attempts: Map<string, number>, maxAttemptsPerItem: number, concurrency: {global: number, byLane?: Record<string, number>}}} arg0
 * @returns {boolean}
 */
export function shouldDispatchSchedulerItem({ item, activeStates, terminalStates, requiredLabels, filter, filterReceiver, running, claiming, claimed, parked, attempts, maxAttemptsPerItem, concurrency }) {
    if (!isActiveState({ state: item.state, states: activeStates })) return false;
    if (isTerminalState({ state: item.state, states: terminalStates })) return false;
    if (!isSchedulerItemRoutable({ item, requiredLabels, filter, filterReceiver })) return false;
    const identifier = item.identifier;
    if (running.has(identifier) || claiming.has(identifier)
        || claimed.has(identifier) || parked.has(identifier)) {
        return false;
    }
    if ((attempts.get(identifier) ?? 0) >= maxAttemptsPerItem) return false;
    return hasLaneSlot({ lane: item.lane, running, claiming, byLane: concurrency.byLane })
        && hasGlobalSlot({ running: running.size, claiming: claiming.size, limit: concurrency.global });
}
