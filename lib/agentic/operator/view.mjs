// @ts-check


/**
 * @file Pure projections from the scheduler snapshot to the operator API shapes.
 * @version 0.12.0
 *
 * @description
 * `toStateResponse` and `toItemResponse` build explicit row projections from
 * `WorkScheduler.snapshot()`, so a future snapshot field cannot leak into the
 * API and every timestamp is an ISO 8601 string or `null`. `toItemResponse`
 * addresses by `identifier`, falling back to `workItemId` (the provider id in
 * every event payload), and re-projects host-supplied event records through the ring
 * allowlist, so a provider cannot leak a prompt.
 *
 * `toStateResponse` also takes the workflow policy's `snapshot()`, because a
 * policy that blocks dispatch is otherwise indistinguishable from an idle
 * system. Its projection is health only: codes, timestamps, and the file path,
 * never the effective config or the prompt.
 *
 * Both functions are total: a malformed snapshot produces documented defaults
 * instead of a throw, and a missing item is `null` (the HTTP handler maps that
 * to 404). Nothing here reads the tracker, the clock, or the filesystem.
 */

/**
 * The snapshot's lifecycle and state lists, mirrored into the response.
 * @typedef {Object} SchedulerProjection
 * @property {boolean} started
 * @property {boolean} stopped
 * @property {number} tickCount
 * @property {string|null} lastTickAt
 * @property {string|null} lastOutcome
 * @property {number} pollIntervalMs
 * @property {Array<unknown>} activeStates
 * @property {Array<unknown>} terminalStates
 */

/**
 * The workflow policy's health as the operator shows it. Codes only: a reason
 * is a stable code (`invalid_config:agent.maxConcurrentAgents`), a warning is a
 * class (`unknown_key`), never prose from the file.
 * @typedef {Object} PolicyProjection
 * @property {boolean} started
 * @property {boolean} stopped
 * @property {boolean} healthy
 * @property {string|null} path
 * @property {string|null} source
 * @property {string|null} watch
 * @property {string|null} loadedAt
 * @property {string|null} lastCheckedAt
 * @property {Array<string>} warnings
 * @property {Array<string>} reasons
 * @property {string|null} lastErrorAt
 */

/**
 * One item's runtime detail.
 * @typedef {Object} ItemResponse
 * @property {string|null} generatedAt
 * @property {unknown} identifier
 * @property {unknown} workItemId
 * @property {unknown} url
 * @property {string} status
 * @property {{path: string}|null} workspace
 * @property {{current: number, continuations: number}} attempts
 * @property {Record<string, unknown>|null} running
 * @property {Record<string, unknown>|null} retry
 * @property {Record<string, unknown>|null} parked
 * @property {Array<Record<string, unknown>>} [recentEvents]
 */

import { LIMITS } from '../../core/limit-config.mjs';
import { projectEventRecord } from './ring.mjs';

/**
 * Parse an epoch-ms number, a `Date`, or a date string into an ISO 8601 string.
 * Anything that is not a real date is `null`, never a raw value.
 * @param {unknown} value
 * @returns {string|null}
 */
export function toIso(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
    return null;
}

/**
 * Treat a non-object (including `null`) as an empty record.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
    return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * A finite number, or `null`.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A finite number, or `0`.
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
    return toNumber(value) ?? 0;
}

/**
 * A finite number, or `null` (limits and row fields keep "not present").
 * @param {unknown} value
 * @returns {unknown}
 */
function orNull(value) {
    return value ?? null;
}

/**
 * Resolve a `now` option that may be a function or a number.
 * @param {number|(() => number)} now
 * @returns {number}
 */
function resolveNow(now) {
    const value = typeof now === 'function' ? now() : now;
    return toNumber(value) ?? Date.now();
}

/**
 * @param {{ row: unknown }} arg0
 * @returns {Record<string, unknown>}
 */
function projectRunningRow({ row }) {
    const source = asRecord(row);
    return {
        workItemId: orNull(source.workItemId),
        identifier: orNull(source.identifier),
        url: orNull(source.url),
        state: orNull(source.state),
        lane: orNull(source.lane),
        attempt: orNull(source.attempt),
        startedAt: toIso(source.startedAt),
        lastProgressAt: toIso(source.lastProgressAt),
        threadId: orNull(source.threadId),
        workspacePath: orNull(source.workspacePath)
    };
}

/**
 * @param {{ row: unknown }} arg0
 * @returns {Record<string, unknown>}
 */
function projectRetryingRow({ row }) {
    const source = asRecord(row);
    return {
        workItemId: orNull(source.workItemId),
        identifier: orNull(source.identifier),
        url: orNull(source.url),
        attempt: orNull(source.attempt),
        kind: orNull(source.kind),
        dueAt: toIso(source.dueAtMs),
        delayMs: orNull(source.delayMs),
        errorName: orNull(source.errorName),
        errorCode: orNull(source.errorCode)
    };
}

/**
 * @param {{ row: unknown }} arg0
 * @returns {Record<string, unknown>}
 */
function projectParkedRow({ row }) {
    const source = asRecord(row);
    return {
        workItemId: orNull(source.workItemId),
        identifier: orNull(source.identifier),
        url: orNull(source.url),
        reason: orNull(source.reason),
        since: toIso(source.since),
        nextCheckAt: toIso(source.nextCheckAt),
        attempts: orNull(source.attempts),
        continuations: orNull(source.continuations)
    };
}

/**
 * @param {{ totals: unknown }} arg0
 * @returns {Record<string, unknown>}
 */
function projectTotals({ totals }) {
    const source = asRecord(totals);
    return {
        inputTokens: toCount(source.inputTokens),
        outputTokens: toCount(source.outputTokens),
        totalTokens: toCount(source.totalTokens),
        costUsd: toNumber(source.costUsd),
        secondsRunning: toCount(source.secondsRunning),
        dispatches: toCount(source.dispatches),
        attempts: toCount(source.attempts),
        failures: toCount(source.failures),
        usageComplete: Boolean(source.usageComplete),
        costComplete: Boolean(source.costComplete)
    };
}

/**
 * Four documented limits only; a missing (or non-numeric) one is `null`.
 * @param {{ limits: unknown }} arg0
 * @returns {Record<string, unknown>}
 */
function projectLimits({ limits }) {
    const source = asRecord(limits);
    return {
        maxAttemptsPerItem: toNumber(source.maxAttemptsPerItem),
        maxDispatches: toNumber(source.maxDispatches),
        maxTotalTokens: toNumber(source.maxTotalTokens),
        maxTotalUsd: toNumber(source.maxTotalUsd)
    };
}

/**
 * @param {{ snapshot: Record<string, unknown> }} arg0
 * @returns {SchedulerProjection}
 */
function projectScheduler({ snapshot }) {
    return {
        started: snapshot.started === true,
        stopped: snapshot.stopped === true,
        tickCount: toCount(snapshot.tickCount),
        lastTickAt: toIso(snapshot.lastTickAt),
        lastOutcome: typeof snapshot.lastOutcome === 'string' ? snapshot.lastOutcome : null,
        pollIntervalMs: toCount(snapshot.pollIntervalMs),
        activeStates: Array.isArray(snapshot.activeStates)
            ? [.../** @type {Array<unknown>} */ (snapshot.activeStates)]
            : [],
        terminalStates: Array.isArray(snapshot.terminalStates)
            ? [.../** @type {Array<unknown>} */ (snapshot.terminalStates)]
            : []
    };
}

/**
 * The workflow policy's health, or `null` when the host did not wire one.
 * Every field explains a block; the effective config and the prompt stay out
 * (they are on `WorkflowPolicy.snapshot()`, and the prompt is never text here).
 * @param {{policy?: unknown}} arg0
 * @returns {{started: boolean, stopped: boolean, healthy: boolean, path: string|null,
 *   source: string|null, watch: string|null, loadedAt: string|null,
 *   lastCheckedAt: string|null, warnings: Array<string>, reasons: Array<string>,
 *   lastErrorAt: string|null}|null}
 */
function projectPolicy({ policy }) {
    const source = asRecord(policy);
    if (Object.keys(source).length === 0) return null;
    const lastError = asRecord(source.lastError);
    return {
        started: source.started === true,
        stopped: source.stopped === true,
        healthy: source.healthy === true,
        path: typeof source.path === 'string' ? source.path : null,
        source: typeof source.source === 'string' ? source.source : null,
        watch: typeof source.watch === 'string' ? source.watch : null,
        loadedAt: toIso(source.loadedAt),
        lastCheckedAt: toIso(source.lastCheckedAt),
        warnings: Array.isArray(source.warnings) ? source.warnings.filter((entry) => typeof entry === 'string') : [],
        reasons: Array.isArray(lastError.reasons) ? lastError.reasons.filter((entry) => typeof entry === 'string') : [],
        lastErrorAt: toIso(lastError.at)
    };
}

/**
 * Find one row by `identifier`, falling back to `workItemId` — the provider id
 * every event payload carries, so a UI built from the event stream can open
 * the row it just rendered. In running → retrying → parked order.
 * `claimed` and `completed` are not addressable: a claimed-only item is
 * transient, and a terminal item is the tracker's (A5/A12).
 * @param {{ snapshot: Record<string, unknown>, id: unknown }} arg0
 * @returns {{status: string, row: unknown}|null}
 */
function findRow({ snapshot, id }) {
    /** @type {Array<[string, unknown]>} */
    const lists = [
        ['running', snapshot.running],
        ['retrying', snapshot.retrying],
        ['parked', snapshot.parked]
    ];
    /** @type {{status: string, row: unknown}|null} */
    let byProviderId = null;
    for (const [status, list] of lists) {
        if (!Array.isArray(list)) continue;
        for (const candidate of /** @type {Array<unknown>} */ (list)) {
            const record = asRecord(candidate);
            if (record.identifier === id) return { status, row: candidate };
            if (byProviderId === null && record.workItemId === id) byProviderId = { status, row: candidate };
        }
    }
    return byProviderId;
}

/**
 * The state response (§3.4). Every key is explicit; nothing is spread.
 * `policy` is `null` when the host did not wire a policy snapshot; the key is
 * always present so a consumer reads one shape.
 * @param {{ snapshot?: unknown, policy?: unknown, now?: number|(() => number) }} [arg0]
 * @returns {{
 *   generatedAt: string|null,
 *   counts: {running: number, retrying: number, parked: number, claimed: number, completed: number},
 *   running: Array<Record<string, unknown>>,
 *   retrying: Array<Record<string, unknown>>,
 *   parked: Array<Record<string, unknown>>,
 *   totals: Record<string, unknown>,
 *   limits: Record<string, unknown>,
 *   scheduler: SchedulerProjection,
 *   policy: PolicyProjection|null,
 *   rateLimits: null
 * }}
 */
export function toStateResponse({ snapshot, policy = null, now = Date.now } = {}) {
    const source = asRecord(snapshot);
    const running = Array.isArray(source.running) ? /** @type {Array<unknown>} */ (source.running) : [];
    const retrying = Array.isArray(source.retrying) ? /** @type {Array<unknown>} */ (source.retrying) : [];
    const parked = Array.isArray(source.parked) ? /** @type {Array<unknown>} */ (source.parked) : [];

    return {
        generatedAt: toIso(resolveNow(now)),
        counts: {
            running: running.length,
            retrying: retrying.length,
            parked: parked.length,
            claimed: Array.isArray(source.claimed) ? source.claimed.length : 0,
            completed: Array.isArray(source.completed) ? source.completed.length : 0
        },
        running: running.map((row) => projectRunningRow({ row })),
        retrying: retrying.map((row) => projectRetryingRow({ row })),
        parked: parked.map((row) => projectParkedRow({ row })),
        totals: projectTotals({ totals: source.totals }),
        limits: projectLimits({ limits: source.limits }),
        scheduler: projectScheduler({ snapshot: source }),
        policy: projectPolicy({ policy }),
        rateLimits: null
    };
}

/**
 * One item's detail (§3.4). An unknown identifier returns `null`; the HTTP
 * handler maps it to 404. A throwing `recentEvents` provider omits the field
 * and the rest of the response still builds.
 * @param {{
 *   snapshot?: unknown,
 *   id?: unknown,
 *   now?: number|(() => number),
 *   events?: ((arg0: {identifier?: unknown, limit?: number}) => unknown)|null,
 *   eventsLimit?: number
 * }} [arg0]
 * @returns {ItemResponse|null}
 */
export function toItemResponse({ snapshot, id, now = Date.now, events = null, eventsLimit = LIMITS.operator_recent_events_limit } = {}) {
    const source = asRecord(snapshot);
    const match = findRow({ snapshot: source, id });
    if (match === null) return null;

    // One clock read for every timestamp this response carries.
    const at = resolveNow(now);
    const eventLimit = Number.isInteger(eventsLimit) && eventsLimit >= 1 ? eventsLimit : LIMITS.operator_recent_events_limit;
    const row = asRecord(match.row);
    const runningRow = match.status === 'running' ? projectRunningRow({ row: match.row }) : null;
    const retryRow = match.status === 'retrying' ? projectRetryingRow({ row: match.row }) : null;
    const parkedRow = match.status === 'parked' ? projectParkedRow({ row: match.row }) : null;
    const workspacePath = row.workspacePath;

    /** @type {ItemResponse} */
    const response = {
        generatedAt: toIso(at),
        identifier: row.identifier,
        workItemId: orNull(row.workItemId),
        url: orNull(row.url),
        status: match.status,
        workspace: match.status === 'running' && typeof workspacePath === 'string'
            ? { path: workspacePath }
            : null,
        attempts: {
            current: toNumber(runningRow?.attempt) ?? toNumber(retryRow?.attempt)
                ?? toNumber(parkedRow?.attempts) ?? 0,
            continuations: toNumber(parkedRow?.continuations) ?? 0
        },
        running: runningRow,
        retry: retryRow,
        parked: parkedRow
    };

    if (typeof events !== 'function') {
        response.recentEvents = [];
        return response;
    }
    try {
        // The event ring is keyed by `identifier`; the route may have matched
        // on `workItemId`, so pass the row's identifier, not the request id.
        const matchedIdentifier = typeof row.identifier === 'string' ? row.identifier : id;
        const records = events({ identifier: matchedIdentifier, limit: eventLimit });
        // The provider is synchronous by contract. A Promise is one of the
        // documented non-array results; swallow its rejection so a host that
        // returned one cannot raise an unhandled rejection.
        if (records && typeof (/** @type {{then?: unknown}} */ (records)).then === 'function') {
            Promise.resolve(records).catch(() => {});
        }
        response.recentEvents = Array.isArray(records)
            ? /** @type {Array<unknown>} */ (records)
                .filter((record) => matchedIdentifier !== undefined && asRecord(record).identifier === matchedIdentifier)
                .slice(0, eventLimit)
                .map((record) => projectEventRecord({ envelope: record, now: () => at }))
            : [];
    } catch {
        // A provider failure omits the field; the detail route still serves.
    }
    return response;
}
