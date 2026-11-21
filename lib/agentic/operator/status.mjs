// @ts-check


/**
 * @file Plain-text status renderer for a terminal or `curl`.
 * @version 0.12.0
 *
 * @description
 * `formatStatus` consumes the same scheduler snapshot as the JSON views and
 * only formats: a lifecycle header, one section per runtime list, and a totals
 * line. There is no fetching, no aggregation, and no per-row token field (the
 * snapshot does not carry one).
 *
 * Every tracker-controlled string goes through `safeText`: control characters
 * (including ANSI escapes and `\r`) become `?`, so a hostile work-item
 * identifier cannot repaint the terminal. The renderer adds no ANSI of its own,
 * and no output line ends in whitespace.
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { toIso } from './view.mjs';

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Tracker text for display: control characters become `?`, and a value that is
 * not a non-empty string becomes `-`.
 * @param {{ value: unknown }} arg0
 * @returns {string}
 */
function safeText({ value }) {
    if (typeof value !== 'string' || value === '') return '-';
    return value.replace(/[\x00-\x1f\x7f]/g, '?');
}

/**
 * `H:MM:SS`; a negative or missing duration is `0:00:00`.
 * @param {{ ms: number|null }} arg0
 * @returns {string}
 */
function formatDuration({ ms }) {
    const totalSeconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A poll interval in seconds; a non-multiple keeps its fraction (`1.5s`).
 * @param {{ ms: number }} arg0
 * @returns {string}
 */
function formatPoll({ ms }) {
    return String(ms / 1000);
}

/**
 * One section header, its rows (at most `maxRows`), and an overflow line.
 * @param {{
 *   title: string,
 *   rows: Array<unknown>,
 *   render: (row: unknown) => string,
 *   maxRows: number
 * }} arg0
 * @returns {Array<string>}
 */
function section({ title, rows, render, maxRows }) {
    const lines = [`${title} (${rows.length})`];
    if (rows.length === 0) {
        lines.push('  (none)');
        return lines;
    }
    for (const row of rows.slice(0, maxRows)) lines.push(render(row));
    if (rows.length > maxRows) lines.push(`  ... +${rows.length - maxRows} more`);
    return lines;
}

/**
 * The workflow policy's health, when the host wired one. Codes are printed as
 * they are; the effective config and the prompt are never printed.
 * @param {{policy: unknown, maxRows: number}} arg0
 * @returns {Array<string>}
 */
function policyLines({ policy, maxRows }) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return [];
    const source = /** @type {Record<string, unknown>} */ (policy);
    const lastError = source.lastError && typeof source.lastError === 'object'
        ? /** @type {Record<string, unknown>} */ (source.lastError)
        : {};
    const healthy = source.healthy === true;
    const watch = typeof source.watch === 'string' ? source.watch : 'unknown';
    const stamp = toIso(healthy ? source.loadedAt : lastError.at);

    /** @type {Array<string>} */
    const lines = [
        `Policy: ${healthy ? 'healthy' : 'failed'} | watch ${safeText({ value: watch })}`
        + (stamp === null ? '' : ` | ${healthy ? 'loaded' : 'last error'} ${stamp}`)
    ];
    for (const reason of Array.isArray(lastError.reasons) ? lastError.reasons : []) {
        if (typeof reason === 'string' && reason !== '') lines.push(`  reason: ${safeText({ value: reason })}`);
    }
    for (const warning of Array.isArray(source.warnings) ? source.warnings : []) {
        if (typeof warning === 'string' && warning !== '') lines.push(`  warning: ${safeText({ value: warning })}`);
    }
    const cap = Math.min(maxRows, LIMITS.operator_policy_lines);
    const extra = lines.length - 1 - cap;
    if (extra > 0) {
        lines.length = cap + 1;
        lines.push(`  ... +${extra} more`);
    }
    return lines;
}

/**
 * Render one snapshot as plain text (§3.7).
 * @param {{
 *   snapshot?: unknown,
 *   policy?: unknown,
 *   now?: number|(() => number),
 *   maxRows?: number
 * }} [arg0]
 * @returns {string}
 */
export function formatStatus({ snapshot, policy = null, now = Date.now, maxRows = LIMITS.operator_status_max_rows } = {}) {
    if (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1) {
        throw new ConfigurationError({
            message: 'formatStatus requires maxRows to be an integer >= 1',
            options: { option: 'invalid_max_rows' }
        });
    }

    const source = snapshot && typeof snapshot === 'object'
        ? /** @type {Record<string, unknown>} */ (snapshot)
        : {};
    const resolved = typeof now === 'function' ? now() : now;
    const at = toNumber(resolved) ?? Date.now();

    const running = Array.isArray(source.running) ? /** @type {Array<unknown>} */ (source.running) : [];
    const retrying = Array.isArray(source.retrying) ? /** @type {Array<unknown>} */ (source.retrying) : [];
    const parked = Array.isArray(source.parked) ? /** @type {Array<unknown>} */ (source.parked) : [];
    const totals = source.totals && typeof source.totals === 'object'
        ? /** @type {Record<string, unknown>} */ (source.totals)
        : {};

    const state = source.started === true && source.stopped !== true ? 'running' : 'stopped';
    const tickCount = toNumber(source.tickCount) ?? 0;
    const pollIntervalMs = toNumber(source.pollIntervalMs) ?? 0;
    const lastOutcome = typeof source.lastOutcome === 'string' ? safeText({ value: source.lastOutcome }) : null;

    /** @type {Array<string>} */
    const lines = [
        `MerciSDK operator | ${state} | tick ${tickCount} | poll ${formatPoll({ ms: pollIntervalMs })}s`
        + (lastOutcome === null ? '' : ` | last ${lastOutcome}`)
    ];

    lines.push(...policyLines({ policy, maxRows }));

    lines.push(...section({
        title: 'Running',
        rows: running,
        maxRows,
        render: (row) => {
            const entry = /** @type {Record<string, unknown>} */ (row && typeof row === 'object' ? row : {});
            const startedAt = toNumber(entry.startedAt);
            const attempt = toNumber(entry.attempt);
            const base = `  ${safeText({ value: entry.identifier })}  attempt ${attempt ?? '-'}`
                + `  ${safeText({ value: entry.state })}`
                + `  ${startedAt === null ? '-' : formatDuration({ ms: at - startedAt })}`;
            const workspacePath = typeof entry.workspacePath === 'string' && entry.workspacePath !== ''
                ? safeText({ value: entry.workspacePath })
                : null;
            return workspacePath === null ? base : `${base}  ${workspacePath}`;
        }
    }));

    lines.push(...section({
        title: 'Retrying',
        rows: retrying,
        maxRows,
        render: (row) => {
            const entry = /** @type {Record<string, unknown>} */ (row && typeof row === 'object' ? row : {});
            const dueAtMs = toNumber(entry.dueAtMs);
            const dueInSeconds = dueAtMs === null ? 0 : Math.max(0, Math.ceil((dueAtMs - at) / 1000));
            return `  ${safeText({ value: entry.identifier })}  due in ${dueInSeconds}s`
                + `  ${safeText({ value: entry.errorName })}`;
        }
    }));

    lines.push(...section({
        title: 'Parked',
        rows: parked,
        maxRows,
        render: (row) => {
            const entry = /** @type {Record<string, unknown>} */ (row && typeof row === 'object' ? row : {});
            const attempts = toNumber(entry.attempts);
            return `  ${safeText({ value: entry.identifier })}`
                + `  ${safeText({ value: entry.reason })}`
                + `  since ${toIso(entry.since) ?? '-'}`
                + `  attempts ${attempts ?? '-'}`;
        }
    }));

    const costUsd = toNumber(totals.costUsd);
    const secondsRunning = toNumber(totals.secondsRunning) ?? 0;
    lines.push(
        `Totals: ${toNumber(totals.totalTokens) ?? 0} tokens`
        + ` | $${costUsd === null ? 'unknown' : costUsd.toFixed(4)}`
        + ` | ${formatDuration({ ms: secondsRunning * 1000 })}`
        + ` | ${toNumber(totals.dispatches) ?? 0} dispatches`
        + ` | ${toNumber(totals.failures) ?? 0} failures`
        + ` | usage ${totals.usageComplete === true ? 'complete' : 'incomplete'}`
        + ` | cost ${totals.costComplete === true ? 'complete' : 'incomplete'}`
    );

    return lines.map((line) => line.replace(/[ \t]+$/, '')).join('\n');
}
