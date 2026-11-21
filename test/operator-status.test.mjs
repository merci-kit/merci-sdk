// @ts-check

/**
 * @file Stage 2 contract tests for the plain-text status renderer (AC9, §5.2).
 * @version 0.12.0
 *
 * @description
 * The renderer consumes the same snapshot as the JSON views and only formats:
 * a fixed header, one section per runtime list, an overflow line per section,
 * and a totals line. Tracker-controlled strings pass through `safeText`, so an
 * ANSI escape or a carriage return cannot reach the terminal. Every assertion
 * compares the whole string where the layout is pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigurationError } from '../lib/core/errors.mjs';
import { formatStatus } from '../lib/agentic/operator/status.mjs';

const NOW = Date.parse('2026-11-09T18:00:00.000Z');
const NOW_ISO = '2026-11-09T18:00:00.000Z';
const NOW_ISO_LOADED = '2026-11-09T17:59:59.000Z';

/**
 * @param {Record<string, unknown>} [arg0]
 * @returns {Record<string, unknown>}
 */
function createSnapshot(arg0 = {}) {
    const snapshot = {
        started: true,
        stopped: false,
        tickCount: 12,
        pollIntervalMs: 30000,
        running: [{
            identifier: 'MT-649',
            attempt: 2,
            state: 'In Progress',
            startedAt: NOW - 252000,
            workspacePath: '/tmp/ws/MT-649'
        }],
        retrying: [{
            identifier: 'MT-650',
            dueAtMs: NOW + 5000,
            errorName: 'Error'
        }],
        parked: [{
            identifier: 'MT-651',
            reason: 'attempts_exhausted',
            since: NOW,
            attempts: 5
        }],
        totals: {
            totalTokens: 7400,
            costUsd: 0.42,
            secondsRunning: 1834,
            dispatches: 12,
            failures: 2,
            usageComplete: true,
            costComplete: true
        }
    };
    return { ...snapshot, ...arg0 };
}

test('golden output with one row per section and a fixed now', () => {
    const expected = [
        'MerciSDK operator | running | tick 12 | poll 30s',
        'Running (1)',
        '  MT-649  attempt 2  In Progress  0:04:12  /tmp/ws/MT-649',
        'Retrying (1)',
        '  MT-650  due in 5s  Error',
        'Parked (1)',
        `  MT-651  attempts_exhausted  since ${NOW_ISO}  attempts 5`,
        'Totals: 7400 tokens | $0.4200 | 0:30:34 | 12 dispatches | 2 failures | usage complete | cost complete'
    ].join('\n');
    assert.equal(formatStatus({ snapshot: createSnapshot(), now: NOW }), expected);
});

test('empty and non-object snapshots render every section as (none) and a stopped header', () => {
    const expected = [
        'MerciSDK operator | stopped | tick 0 | poll 0s',
        'Running (0)',
        '  (none)',
        'Retrying (0)',
        '  (none)',
        'Parked (0)',
        '  (none)',
        'Totals: 0 tokens | $unknown | 0:00:00 | 0 dispatches | 0 failures | usage incomplete | cost incomplete'
    ].join('\n');
    assert.equal(formatStatus({ snapshot: {}, now: NOW }), expected);
    assert.equal(formatStatus({ snapshot: null, now: NOW }), expected);
    assert.equal(formatStatus({ snapshot: 'nope', now: NOW }), expected);
});

test('a stopped scheduler reports stopped even when started is also set', () => {
    const text = formatStatus({ snapshot: { started: true, stopped: true }, now: NOW });
    assert.equal(text.split('\n')[0], 'MerciSDK operator | stopped | tick 0 | poll 0s');
});

test('more than maxRows rows print the first maxRows and an overflow line', () => {
    const text = formatStatus({
        snapshot: createSnapshot({
            running: [
                { identifier: 'MT-1', attempt: 1, state: 'Todo', startedAt: NOW, workspacePath: '/ws/1' },
                { identifier: 'MT-2', attempt: 1, state: 'Todo', startedAt: NOW, workspacePath: '/ws/2' }
            ]
        }),
        now: NOW,
        maxRows: 1
    });
    assert.equal(text.includes('  MT-1  attempt 1  Todo  0:00:00  /ws/1'), true);
    assert.equal(text.includes('MT-2'), false);
    assert.equal(text.includes('  ... +1 more'), true);
});

test('a missing startedAt prints a dash and a missing attempt prints a dash', () => {
    const text = formatStatus({
        snapshot: { running: [{ identifier: 'MT-1', state: 'Todo', workspacePath: '/ws' }] },
        now: NOW
    });
    assert.equal(text.includes('  MT-1  attempt -  Todo  -  /ws'), true);
});

test('a missing workspace path drops the trailing field without trailing whitespace', () => {
    const text = formatStatus({
        snapshot: { running: [{ identifier: 'MT-1', attempt: 1, state: 'Todo', startedAt: NOW }] },
        now: NOW
    });
    assert.equal(text.includes('  MT-1  attempt 1  Todo  0:00:00'), true);
    for (const line of text.split('\n')) assert.equal(line, line.trimEnd());
});

test('a negative due time clamps to 0s', () => {
    const text = formatStatus({
        snapshot: { retrying: [{ identifier: 'MT-1', dueAtMs: NOW - 5000, errorName: 'Error' }] },
        now: NOW
    });
    assert.equal(text.includes('  MT-1  due in 0s  Error'), true);
});

test('an unknown cost prints unknown and a known cost prints four decimals', () => {
    const unknown = formatStatus({ snapshot: { totals: {} }, now: NOW });
    assert.equal(unknown.includes('Totals: 0 tokens | $unknown |'), true);

    const quarter = formatStatus({ snapshot: { totals: { costUsd: 0.5 } }, now: NOW });
    assert.equal(quarter.includes('| $0.5000 |'), true);
});

test('now works as a number and as a function, and the default path has no NaN', () => {
    const snapshot = createSnapshot();
    const asNumber = formatStatus({ snapshot, now: NOW });
    const asFunction = formatStatus({ snapshot, now: () => NOW });
    assert.equal(asNumber, asFunction);

    const byDefault = formatStatus({ snapshot });
    assert.equal(byDefault.includes('NaN'), false);
});

test('hostile tracker strings are sanitized and no escape survives', () => {
    const text = formatStatus({
        snapshot: {
            running: [{
                identifier: 'MT\x1b[31m1',
                attempt: 1,
                state: 'In\rProgress',
                startedAt: NOW,
                workspacePath: '/tmp/\x1b[1mws'
            }]
        },
        now: NOW
    });
    assert.equal(text.includes('\x1b'), false);
    assert.equal(text.includes('\r'), false);
    assert.equal(text.includes('MT?[31m1'), true);
    assert.equal(text.includes('In?Progress'), true);
});

test('no per-row token field is printed', () => {
    const text = formatStatus({
        snapshot: {
            running: [{
                identifier: 'MT-1',
                attempt: 1,
                state: 'Todo',
                startedAt: NOW,
                workspacePath: '/ws',
                tokens: 987654
            }],
            totals: { totalTokens: 7400 }
        },
        now: NOW
    });
    assert.equal(text.includes('987654'), false);
    const runningLine = text.split('\n')[2];
    assert.equal(runningLine.includes('tokens'), false);
});

test('maxRows must be an integer of at least 1', () => {
    assert.throws(() => formatStatus({ snapshot: {}, maxRows: 0 }), ConfigurationError);
    assert.throws(() => formatStatus({ snapshot: {}, maxRows: 1.5 }), ConfigurationError);
});

test('no line has trailing whitespace', () => {
    const text = formatStatus({ snapshot: createSnapshot(), now: NOW });
    for (const line of text.split('\n')) assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`);
});

test('the last tick outcome is in the header, so blocked is not idle', () => {
    const text = formatStatus({
        snapshot: { started: true, lastOutcome: 'validation_error' },
        now: NOW
    });
    assert.equal(text.split('\n')[0], 'MerciSDK operator | running | tick 0 | poll 0s | last validation_error');
});

test('an unhealthy policy is a failed line, its reason codes, and nothing from its config', () => {
    const text = formatStatus({
        snapshot: createSnapshot(),
        now: NOW,
        policy: {
            started: true,
            stopped: false,
            healthy: false,
            path: '/repo/WORKFLOW.md',
            source: 'reload',
            watch: 'active',
            loadedAt: NOW - 60_000,
            lastCheckedAt: NOW,
            warnings: ['unknown_key'],
            lastError: { reasons: ['invalid_config:agent.max_concurrent_agents'], at: NOW },
            prompt: { chars: 120, hash: 'LEAK-prompt-hash' },
            config: { LEAK: true }
        }
    });
    const lines = text.split('\n');
    assert.equal(lines[0], 'MerciSDK operator | running | tick 12 | poll 30s');
    assert.equal(lines[1], `Policy: failed | watch active | last error ${NOW_ISO}`);
    assert.equal(lines[2], '  reason: invalid_config:agent.max_concurrent_agents');
    assert.equal(lines[3], '  warning: unknown_key');
    assert.equal(text.includes('LEAK'), false, 'the config and the prompt are never printed');
    assert.equal(lines.some((line) => /[ \t]$/.test(line)), false);
});

test('a healthy policy says loaded, and no policy adds no line', () => {
    const healthy = formatStatus({
        snapshot: { started: true },
        now: NOW,
        policy: { started: true, healthy: true, watch: 'active', loadedAt: NOW - 1000, warnings: [] }
    });
    assert.equal(healthy.split('\n')[1], `Policy: healthy | watch active | loaded ${NOW_ISO_LOADED}`);

    const withoutPolicy = formatStatus({ snapshot: createSnapshot(), now: NOW });
    assert.equal(withoutPolicy.includes('Policy:'), false);
});

test('the policy reason list is capped with an overflow line', () => {
    const reasons = Array.from({ length: 14 }, (_, index) => `invalid_config:field_${index}`);
    const text = formatStatus({
        snapshot: { started: true },
        now: NOW,
        maxRows: 3,
        policy: { healthy: false, watch: 'disabled', lastError: { reasons, at: NOW } }
    });
    const lines = text.split('\n');
    assert.equal(lines.filter((line) => line.startsWith('  reason:')).length, 3);
    assert.equal(text.includes('  ... +11 more'), true, 'the overflow is capped with a count');
});
