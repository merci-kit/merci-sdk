// @ts-check


/**
 * @file Scheduler state shapes, defaults, usage accumulation, and the snapshot.
 * @version 0.12.0
 *
 * @description
 * Pure, IO-free helpers the scheduler calls at settle and on `snapshot()`. The
 * totals are accumulated once per settled attempt; the snapshot adds the live
 * seconds of every still-running entry at call time (Symphony §13.5) without
 * mutating the accumulator. A hostile usage object can only cost a flag — no
 * read here throws.
 *
 * The claim vocabulary is deliberately separate from tracker states: an item's
 * `state` is provider-spelled, a claim state is scheduler-owned.
 */

import { LIMITS } from '../../core/limit-config.mjs';
import { threadIdFor } from '../thread-ids.mjs';

/**
 * @typedef {'unclaimed'|'claimed'|'running'|'retry_queued'|'parked'|'released'} ClaimState
 */

/**
 * @typedef {Object} Totals
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 * @property {number} costUsd
 * @property {number} secondsRunning
 * @property {number} dispatches
 * @property {number} attempts
 * @property {number} failures
 * @property {boolean} usageComplete
 * @property {boolean} costComplete
 */

/** @typedef {import('./normalize.mjs').WorkItem} WorkItem */

/**
 * One in-flight attempt. The scheduler keys its running map by `identifier`;
 * `item` carries the provider id used in event payloads and snapshot rows.
 * `threadId` is the deterministic checkpoint thread this attempt runs under,
 * and `workspace`/`prepared` are set only while a workspace manager is in use.
 * @typedef {Object} RunningEntry
 * @property {string} id
 * @property {string} identifier
 * @property {Pick<WorkItem, 'id'|'identifier'|'state'|'priority'|'url'>} item
 * @property {number} attempt
 * @property {string} lane
 * @property {number} startedAt
 * @property {number} lastProgressAt
 * @property {string} [threadId]
 * @property {Record<string, unknown>|null} [workspace]
 * @property {boolean} [prepared]
 */

/**
 * The checkpoint thread for one work item (§3.10). Deterministic and pure so
 * the scheduler, the snapshot, and the engine runner agree without IO.
 * @param {{identifier: string}} arg0 -
 * @returns {string}
 */
export function workThreadId({ identifier }) {
    return threadIdFor({ kind: 'work', id: identifier });
}

/**
 * The scheduler's claim-state vocabulary (§3.3). Frozen; the values are the
 * serialized names.
 * @type {Readonly<Record<string, ClaimState>>}
 */
export const CLAIM_STATES = Object.freeze({
    UNCLAIMED: 'unclaimed',
    CLAIMED: 'claimed',
    RUNNING: 'running',
    RETRY_QUEUED: 'retry_queued',
    PARKED: 'parked',
    RELEASED: 'released'
});

/**
 * The §3.14 construction defaults. Frozen at both depths; the scheduler copies
 * them so a caller can never mutate the shared object. Each property reads the
 * registry on access, so a host's limits apply to the next construction.
 * @type {Readonly<{
 *   pollIntervalMs: number,
 *   stallTimeoutMs: number,
 *   retry: Readonly<{baseMs: number, maxMs: number}>,
 *   continuation: Readonly<{delayMs: number, max: number}>,
 *   concurrency: Readonly<{global: number}>,
 *   limits: Readonly<{maxAttemptsPerItem: number}>
 * }>}
 */
export const SCHEDULER_DEFAULTS = Object.freeze({
    get pollIntervalMs() { return LIMITS.scheduler_poll_interval_ms; },
    get stallTimeoutMs() { return LIMITS.scheduler_stall_timeout_ms; },
    get retry() {
        return Object.freeze({ baseMs: LIMITS.scheduler_retry_base_ms, maxMs: LIMITS.scheduler_retry_max_ms });
    },
    get continuation() {
        return Object.freeze({ delayMs: LIMITS.scheduler_continuation_delay_ms, max: LIMITS.scheduler_continuation_max });
    },
    get concurrency() { return Object.freeze({ global: LIMITS.scheduler_max_concurrent }); },
    get limits() { return Object.freeze({ maxAttemptsPerItem: LIMITS.scheduler_max_attempts_per_item }); }
});

/**
 * A zeroed accumulator. Callers mutate the returned object; the default is
 * never shared.
 * @returns {Totals}
 */
export function createTotals() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        secondsRunning: 0,
        dispatches: 0,
        attempts: 0,
        failures: 0,
        usageComplete: true,
        costComplete: true
    };
}

/**
 * Read one numeric field without letting a hostile getter escape.
 * @param {{record: Record<string, unknown>, key: string}} arg0 -
 * @returns {number|null}
 */
function finiteField({ record, key }) {
    try {
        const value = record[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * One stream of usage in two spellings: the engine reports `prompt_tokens` /
 * `completion_tokens`, a settled attempt reports `input_tokens` /
 * `output_tokens`, and a cost may arrive as `cost_usd` or `costUsd`. Both
 * spellings of one field are read once, never summed, and a reported
 * `total_tokens` wins so input plus output cannot double count it. Negative
 * parts are floored at zero, and `tokensReported` says whether any token field
 * was recognized at all.
 * @param {{usage: unknown}} arg0 -
 * @returns {{
 *   inputTokens: number|null,
 *   outputTokens: number|null,
 *   totalTokens: number,
 *   costUsd: number|null,
 *   estimatedTokens: number,
 *   tokensReported: boolean
 * }|null}
 */
export function projectUsage({ usage }) {
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
    const record = /** @type {Record<string, unknown>} */ (usage);
    const rawInput = finiteField({ record, key: 'input_tokens' }) ?? finiteField({ record, key: 'prompt_tokens' });
    const rawOutput = finiteField({ record, key: 'output_tokens' }) ?? finiteField({ record, key: 'completion_tokens' });
    const rawTotal = finiteField({ record, key: 'total_tokens' });
    const rawEstimated = finiteField({ record, key: 'estimated_tokens' });
    const cost = finiteField({ record, key: 'cost_usd' }) ?? finiteField({ record, key: 'costUsd' });
    const input = rawInput === null ? null : Math.max(0, rawInput);
    const output = rawOutput === null ? null : Math.max(0, rawOutput);
    const estimated = Math.max(0, rawEstimated ?? 0);
    // A reported total can be hostile or stale; it may never shrink below the
    // parts it is supposed to sum.
    const derived = (input ?? 0) + (output ?? 0);
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: rawTotal === null ? derived + estimated : Math.max(0, rawTotal, derived),
        costUsd: cost,
        estimatedTokens: estimated,
        tokensReported: rawInput !== null || rawOutput !== null || rawTotal !== null || rawEstimated !== null
    };
}

/**
 * Fold one settled attempt's usage into `totals`. A missing usage object means
 * the runner reported nothing, so both completeness flags turn false. A usage
 * object without a recognized token field is not complete either, though a
 * finite cost still folds. A usage object without a finite cost still counts as
 * reported usage but not as reported cost. Never throws.
 * @param {{totals: Totals, usage: unknown}} arg0 -
 * @returns {void}
 */
export function accumulateUsage({ totals, usage }) {
    if (!totals || typeof totals !== 'object') return;
    // Only a plain object is "reported usage": an array, string, or function
    // carries no usage fields, so both completeness flags turn false.
    const projected = projectUsage({ usage });
    if (projected === null) {
        totals.usageComplete = false;
        totals.costComplete = false;
        return;
    }
    if (!projected.tokensReported) totals.usageComplete = false;
    if (projected.inputTokens !== null) totals.inputTokens += projected.inputTokens;
    if (projected.outputTokens !== null) totals.outputTokens += projected.outputTokens;
    totals.totalTokens += projected.totalTokens;
    if (projected.costUsd !== null) {
        totals.costUsd += projected.costUsd;
    } else {
        totals.costComplete = false;
    }
}

/**
 * Build the §3.13 snapshot. `secondsRunning` is the accumulated settled time
 * plus the live duration of each running entry, computed against `now`. The
 * input totals object is not mutated.
 * @param {{
 *   started?: boolean,
 *   stopped?: boolean,
 *   tickCount?: number,
 *   lastTickAt?: number|null,
 *   lastOutcome?: string|null,
 *   pollIntervalMs?: number,
 *   running?: Map<string, RunningEntry>,
 *   retrying?: ReadonlyArray<Record<string, unknown>>,
 *   parked?: ReadonlyArray<Record<string, unknown>>,
 *   claimed?: ReadonlyArray<string>,
 *   completed?: ReadonlyArray<string>,
 *   totals?: Totals,
 *   limits?: Record<string, unknown>,
 *   activeStates?: ReadonlyArray<string>,
 *   terminalStates?: ReadonlyArray<string>,
 *   now?: number
 * }} [arg0] -
 * @returns {{
 *   started: boolean,
 *   stopped: boolean,
 *   tickCount: number,
 *   lastTickAt: number|null,
 *   lastOutcome: string|null,
 *   pollIntervalMs: number,
 *   running: Array<Record<string, unknown>>,
 *   retrying: ReadonlyArray<Record<string, unknown>>,
 *   parked: ReadonlyArray<Record<string, unknown>>,
 *   claimed: string[],
 *   completed: string[],
 *   totals: Totals,
 *   limits: Record<string, unknown>,
 *   activeStates: ReadonlyArray<string>,
 *   terminalStates: ReadonlyArray<string>
 * }}
 */
export function buildSnapshot({
    started = false,
    stopped = false,
    tickCount = 0,
    lastTickAt = null,
    lastOutcome = null,
    pollIntervalMs = 0,
    running = new Map(),
    retrying = [],
    parked = [],
    claimed = [],
    completed = [],
    totals = createTotals(),
    limits = {},
    activeStates = [],
    terminalStates = [],
    now = Date.now()
} = {}) {
    const rows = [];
    let liveSeconds = 0;
    for (const entry of running.values()) {
        const elapsed = Number.isFinite(entry.startedAt) ? Math.max(0, (now - entry.startedAt) / 1000) : 0;
        liveSeconds += elapsed;
        rows.push({
            workItemId: entry.item?.id ?? entry.id,
            identifier: entry.identifier,
            url: entry.item?.url ?? null,
            attempt: entry.attempt,
            lane: entry.lane,
            state: entry.item?.state ?? null,
            priority: entry.item?.priority ?? null,
            startedAt: entry.startedAt,
            lastProgressAt: entry.lastProgressAt,
            threadId: typeof entry.threadId === 'string' ? entry.threadId : null,
            workspacePath: entry.workspace && typeof entry.workspace.path === 'string' ? entry.workspace.path : null
        });
    }
    return {
        started,
        stopped,
        tickCount,
        lastTickAt,
        lastOutcome,
        pollIntervalMs,
        running: rows,
        retrying: [...retrying],
        parked: [...parked],
        claimed: [...claimed],
        completed: [...completed],
        totals: { ...createTotals(), ...totals, secondsRunning: (totals.secondsRunning ?? 0) + liveSeconds },
        limits: { ...limits },
        activeStates: [...activeStates],
        terminalStates: [...terminalStates]
    };
}
