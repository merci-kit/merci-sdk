// @ts-check

/**
 * @file Stage 1 contract tests for the operator projections (AC4, AC5, §5.1).
 * @version 0.12.0
 *
 * @description
 * `toIso` accepts epoch ms, a `Date`, or a parseable string and returns `null`
 * for everything else. `toStateResponse` pins the exact key set, the timestamp
 * mapping table, and explicit row projections, so a future snapshot field (or a
 * hostile `description`/`metadata`/`prompt`) cannot reach the API. `toItemResponse`
 * resolves by `identifier` only, in running → retrying → parked order, and
 * re-projects host-supplied event records through the ring allowlist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toIso, toItemResponse, toStateResponse } from '../lib/agentic/operator/view.mjs';

const NOW = Date.parse('2026-11-09T18:00:00.000Z');
const NOW_ISO = '2026-11-09T18:00:00.000Z';

/**
 * A full snapshot fixture with the real producer's fields, plus hostile extras
 * that must never reach the response.
 * @returns {Record<string, unknown>}
 */
function createSnapshot() {
    return {
        started: true,
        stopped: false,
        tickCount: 12,
        lastTickAt: NOW - 1000,
        pollIntervalMs: 30000,
        running: [{
            workItemId: 'wi-1',
            identifier: 'MT-649',
            url: 'https://tracker.example/MT-649',
            attempt: 2,
            lane: 'main',
            state: 'In Progress',
            priority: 1,
            startedAt: NOW - 252000,
            lastProgressAt: NOW - 500,
            threadId: 'work:MT-649',
            workspacePath: '/tmp/ws/MT-649',
            description: 'LEAK-description',
            metadata: { internal: true },
            prompt: 'LEAK-prompt'
        }],
        retrying: [{
            workItemId: 'wi-2',
            identifier: 'MT-650',
            url: null,
            attempt: 3,
            kind: 'failure',
            dueAtMs: NOW + 5000,
            delayMs: 10000,
            errorName: 'Error',
            errorCode: 'E1',
            description: 'LEAK-description'
        }],
        parked: [{
            workItemId: 'wi-3',
            identifier: 'MT-651',
            url: 'https://tracker.example/MT-651',
            reason: 'attempts_exhausted',
            since: NOW,
            nextCheckAt: NOW + 60000,
            attempts: 5,
            continuations: 2,
            prompt: 'LEAK-prompt'
        }],
        claimed: ['MT-1'],
        completed: ['MT-0'],
        totals: {
            inputTokens: 1000,
            outputTokens: 6400,
            totalTokens: 7400,
            costUsd: 0.42,
            secondsRunning: 1834,
            dispatches: 12,
            attempts: 14,
            failures: 2,
            usageComplete: true,
            costComplete: false
        },
        limits: {
            maxAttemptsPerItem: 5,
            maxDispatches: 10,
            maxTotalTokens: 100000,
            maxTotalUsd: 5,
            secretLimit: 99
        },
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done']
    };
}

test('toIso converts epoch ms, Date and parseable strings and rejects the rest', () => {
    assert.equal(toIso(NOW), NOW_ISO);
    assert.equal(toIso(new Date(NOW)), NOW_ISO);
    assert.equal(toIso(NOW_ISO), NOW_ISO);
    assert.equal(toIso('2026-11-09T18:00:00Z'), NOW_ISO);
    for (const value of [null, undefined, '', new Number(NOW), Number.NaN, Number.POSITIVE_INFINITY, {}, [], true, 'not-a-date']) {
        assert.equal(toIso(value), null, `expected null for ${String(value)}`);
    }
});

test('state response has exactly the documented top-level and nested key sets', () => {
    const state = toStateResponse({ snapshot: createSnapshot(), now: () => NOW });

    assert.deepEqual(Object.keys(state), [
        'generatedAt', 'counts', 'running', 'retrying', 'parked',
        'totals', 'limits', 'scheduler', 'policy', 'rateLimits'
    ]);
    assert.deepEqual(Object.keys(state.counts), ['running', 'retrying', 'parked', 'claimed', 'completed']);
    assert.deepEqual(Object.keys(state.totals), [
        'inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'secondsRunning',
        'dispatches', 'attempts', 'failures', 'usageComplete', 'costComplete'
    ]);
    assert.deepEqual(Object.keys(state.limits), [
        'maxAttemptsPerItem', 'maxDispatches', 'maxTotalTokens', 'maxTotalUsd'
    ]);
    assert.deepEqual(Object.keys(state.scheduler), [
        'started', 'stopped', 'tickCount', 'lastTickAt', 'lastOutcome', 'pollIntervalMs',
        'activeStates', 'terminalStates'
    ]);
    assert.equal(state.policy, null, 'a host without a policy snapshot reads one shape: null');
    assert.equal(state.generatedAt, NOW_ISO);
    assert.deepEqual(state.counts, { running: 1, retrying: 1, parked: 1, claimed: 1, completed: 1 });
    assert.equal(state.rateLimits, null);
});

test('state timestamps are ISO per the mapping table, with numeric and string inputs normalized', () => {
    const snapshot = createSnapshot();
    const state = toStateResponse({ snapshot, now: () => NOW });

    assert.equal(state.running[0].startedAt, '2026-11-09T17:55:48.000Z');
    assert.equal(state.running[0].lastProgressAt, '2026-11-09T17:59:59.500Z');
    assert.equal(state.retrying[0].dueAt, '2026-11-09T18:00:05.000Z');
    assert.equal(state.parked[0].since, NOW_ISO);
    assert.equal(state.parked[0].nextCheckAt, '2026-11-09T18:01:00.000Z');
    assert.equal(state.scheduler.lastTickAt, '2026-11-09T17:59:59.000Z');
    assert.equal(Object.hasOwn(state.retrying[0], 'dueAtMs'), false);

    // A string where epoch ms is the producer's type is normalized, not passed through.
    const mixed = toStateResponse({
        snapshot: { running: [{ identifier: 'MT-1', startedAt: NOW_ISO, lastProgressAt: NOW }] },
        now: () => NOW
    });
    assert.equal(mixed.running[0].startedAt, NOW_ISO);
    assert.equal(mixed.running[0].lastProgressAt, NOW_ISO);

    // Anything that is not a date becomes null, never a raw value.
    const bad = toStateResponse({
        snapshot: { running: [{ identifier: 'MT-1', startedAt: 'not-a-date' }], lastTickAt: NaN },
        now: () => NOW
    });
    assert.equal(bad.running[0].startedAt, null);
    assert.equal(bad.scheduler.lastTickAt, null);
});

test('row projections are explicit: extra snapshot fields never leak', () => {
    const state = toStateResponse({ snapshot: createSnapshot(), now: () => NOW });

    assert.deepEqual(Object.keys(state.running[0]), [
        'workItemId', 'identifier', 'url', 'state', 'lane', 'attempt',
        'startedAt', 'lastProgressAt', 'threadId', 'workspacePath'
    ]);
    assert.deepEqual(Object.keys(state.retrying[0]), [
        'workItemId', 'identifier', 'url', 'attempt', 'kind',
        'dueAt', 'delayMs', 'errorName', 'errorCode'
    ]);
    assert.deepEqual(Object.keys(state.parked[0]), [
        'workItemId', 'identifier', 'url', 'reason', 'since',
        'nextCheckAt', 'attempts', 'continuations'
    ]);

    const text = JSON.stringify(state);
    assert.equal(text.includes('LEAK'), false);
    assert.equal(Object.hasOwn(state.limits, 'secretLimit'), false);
});

test('a malformed snapshot yields documented defaults and never throws', () => {
    for (const snapshot of [{}, null, undefined, 'oops', 42]) {
        const state = toStateResponse({ snapshot, now: () => NOW });
        assert.deepEqual(state.counts, { running: 0, retrying: 0, parked: 0, claimed: 0, completed: 0 });
        assert.deepEqual(state.running, []);
        assert.deepEqual(state.retrying, []);
        assert.deepEqual(state.parked, []);
        assert.equal(state.generatedAt, NOW_ISO);
        assert.equal(state.rateLimits, null);
    }

    const defaults = toStateResponse({ snapshot: {}, now: () => NOW });
    assert.deepEqual(defaults.totals, {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: null,
        secondsRunning: 0,
        dispatches: 0,
        attempts: 0,
        failures: 0,
        usageComplete: false,
        costComplete: false
    });
    assert.deepEqual(defaults.limits, {
        maxAttemptsPerItem: null,
        maxDispatches: null,
        maxTotalTokens: null,
        maxTotalUsd: null
    });
    assert.deepEqual(defaults.scheduler, {
        started: false,
        stopped: false,
        tickCount: 0,
        lastTickAt: null,
        lastOutcome: null,
        pollIntervalMs: 0,
        activeStates: [],
        terminalStates: []
    });
});

test('totals defaults: non-finite cost is null and completeness flags are coerced', () => {
    const state = toStateResponse({
        snapshot: {
            totals: { costUsd: Number.POSITIVE_INFINITY, usageComplete: 1, costComplete: 0, totalTokens: 'x' }
        },
        now: () => NOW
    });
    assert.equal(state.totals.costUsd, null);
    assert.equal(state.totals.totalTokens, 0);
    assert.equal(state.totals.usageComplete, true);
    assert.equal(state.totals.costComplete, false);
});

test('url passes through on every row and is null when absent', () => {
    const state = toStateResponse({ snapshot: createSnapshot(), now: () => NOW });
    assert.equal(state.running[0].url, 'https://tracker.example/MT-649');
    assert.equal(state.retrying[0].url, null);
    assert.equal(state.parked[0].url, 'https://tracker.example/MT-651');

    const absent = toStateResponse({
        snapshot: {
            running: [{ identifier: 'MT-1' }],
            retrying: [{ identifier: 'MT-2' }],
            parked: [{ identifier: 'MT-3' }]
        },
        now: () => NOW
    });
    assert.equal(absent.running[0].url, null);
    assert.equal(absent.retrying[0].url, null);
    assert.equal(absent.parked[0].url, null);
});

test('detail resolves running, retrying and parked by identifier', () => {
    const snapshot = createSnapshot();
    const running = toItemResponse({ snapshot, id: 'MT-649', now: () => NOW });
    assert.ok(running);
    assert.deepEqual(Object.keys(running), [
        'generatedAt', 'identifier', 'workItemId', 'url', 'status',
        'workspace', 'attempts', 'running', 'retry', 'parked', 'recentEvents'
    ]);
    assert.equal(running.generatedAt, NOW_ISO);
    assert.equal(running.status, 'running');
    assert.equal(running.identifier, 'MT-649');
    assert.equal(running.workItemId, 'wi-1');
    assert.equal(running.url, 'https://tracker.example/MT-649');
    assert.deepEqual(running.workspace, { path: '/tmp/ws/MT-649' });
    assert.deepEqual(running.attempts, { current: 2, continuations: 0 });
    assert.deepEqual(running.running, toStateResponse({ snapshot, now: () => NOW }).running[0]);
    assert.equal(running.retry, null);
    assert.equal(running.parked, null);
    assert.deepEqual(running.recentEvents, []);

    const retrying = toItemResponse({ snapshot, id: 'MT-650', now: () => NOW });
    assert.ok(retrying);
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.workspace, null);
    assert.deepEqual(retrying.attempts, { current: 3, continuations: 0 });
    assert.equal(retrying.running, null);
    assert.ok(retrying.retry);
    assert.equal(retrying.parked, null);

    const parked = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW });
    assert.ok(parked);
    assert.equal(parked.status, 'parked');
    assert.deepEqual(parked.attempts, { current: 5, continuations: 2 });
    assert.ok(parked.parked);
    assert.equal(parked.running, null);
    assert.equal(parked.retry, null);
});

test('detail precedence is running > retrying > parked', () => {
    const snapshot = {
        running: [{ identifier: 'MT-1', attempt: 1, workspacePath: '/ws' }],
        retrying: [{ identifier: 'MT-1', attempt: 2 }, { identifier: 'MT-2', attempt: 3 }],
        parked: [{ identifier: 'MT-1', attempts: 9 }, { identifier: 'MT-2', attempts: 8 }]
    };
    const top = toItemResponse({ snapshot, id: 'MT-1', now: () => NOW });
    assert.ok(top);
    assert.equal(top.status, 'running');
    assert.equal(top.attempts.current, 1);

    const second = toItemResponse({ snapshot, id: 'MT-2', now: () => NOW });
    assert.ok(second);
    assert.equal(second.status, 'retrying');
    assert.equal(second.attempts.current, 3);
});

test('detail is null for unknown, claimed-only and completed-only identifiers', () => {
    const snapshot = createSnapshot();
    assert.equal(toItemResponse({ snapshot, id: 'MT-1', now: () => NOW }), null);
    assert.equal(toItemResponse({ snapshot, id: 'MT-0', now: () => NOW }), null);
    assert.equal(toItemResponse({ snapshot, id: 'MT-999', now: () => NOW }), null);
    assert.equal(toItemResponse({ snapshot: {}, id: 'MT-1', now: () => NOW }), null);
    assert.equal(toItemResponse({ snapshot: null, id: 'MT-1', now: () => NOW }), null);
});

test('detail recentEvents is filtered, capped and re-projected through the allowlist', () => {
    const snapshot = createSnapshot();
    /** @type {Array<Record<string, unknown>>} */
    const calls = [];
    /** @param {{ identifier?: unknown, limit?: number }} arg0 */
    const events = (arg0) => {
        calls.push({ ...arg0 });
        return [
            {
                event: 'work_item:parked',
                ts: NOW,
                identifier: 'MT-651',
                reason: 'attempts_exhausted',
                attempts: 5,
                prompt: 'LEAK-prompt',
                toolArgs: { LEAK: true },
                description: 'LEAK-description'
            },
            { at: NOW, event: 'work_item:failed', identifier: 'MT-651', errorName: 'Error' }
        ];
    };

    const detail = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW, events, eventsLimit: 3 });
    assert.ok(detail);
    assert.deepEqual(calls, [{ identifier: 'MT-651', limit: 3 }]);
    const records = detail.recentEvents ?? [];
    assert.deepEqual(Object.keys(records[0]), [
        'at', 'event', 'identifier', 'reason', 'attempts'
    ]);
    assert.equal(records.length, 2);
    assert.equal(JSON.stringify(records).includes('LEAK'), false);

    const nonArray = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW, events: () => 'nope' });
    assert.ok(nonArray);
    assert.deepEqual(nonArray.recentEvents, []);

    // A Promise is a non-array result. The view attaches a rejection handler,
    // so an async host provider cannot raise an unhandled rejection (the test
    // runner would fail this file if one escaped).
    const promised = toItemResponse({
        snapshot,
        id: 'MT-651',
        now: () => NOW,
        events: () => Promise.reject(new Error('async provider'))
    });
    assert.ok(promised);
    assert.deepEqual(promised.recentEvents, []);

    const defaultLimit = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW, events });
    assert.ok(defaultLimit);
    assert.deepEqual(calls.at(-1), { identifier: 'MT-651', limit: 20 });
});

test('detail recentEvents is capped at the resolved limit', () => {
    const snapshot = createSnapshot();
    /** @type {Array<number|undefined>} */
    const seenLimits = [];
    /** @param {{ identifier?: unknown, limit?: number }} arg0 */
    const many = (arg0) => {
        seenLimits.push(arg0.limit);
        return Array.from({ length: 100 }, (_, index) => ({
            event: 'work_item:parked', ts: NOW + index, identifier: 'MT-651', reason: 'a'
        }));
    };

    const capped = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW, events: many, eventsLimit: 5 });
    assert.ok(capped);
    assert.equal(capped.recentEvents?.length, 5);
    assert.equal(seenLimits.at(-1), 5);

    for (const badLimit of [0, -1, Number.NaN]) {
        const fallback = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW, events: many, eventsLimit: badLimit });
        assert.ok(fallback);
        assert.equal(fallback.recentEvents?.length, 20, `expected the default 20 for ${String(badLimit)}`);
        assert.equal(seenLimits.at(-1), 20);
    }
});

test('detail recentEvents keep only this identifier and drop unattributable records', () => {
    const snapshot = createSnapshot();
    const mixed = () => [
        { event: 'work_item:parked', ts: NOW, identifier: 'MT-651', reason: 'mine-1' },
        { event: 'work_item:parked', ts: NOW + 1, identifier: 'OTHER', reason: 'theirs' },
        { event: 'work_item:parked', ts: NOW + 2, reason: 'unattributable' },
        { event: 'work_item:parked', ts: NOW + 3, identifier: 'MT-651', reason: 'mine-2' }
    ];

    const detail = toItemResponse({ snapshot, id: 'MT-651', now: () => NOW, events: mixed });
    assert.ok(detail);
    assert.deepEqual(detail.recentEvents?.map((record) => record.reason), ['mine-1', 'mine-2']);
});

test('detail re-projection uses the injected clock and reads it once', () => {
    const snapshot = createSnapshot();
    let nowCalls = 0;
    const detail = toItemResponse({
        snapshot,
        id: 'MT-651',
        now: () => { nowCalls += 1; return NOW; },
        events: () => [
            { event: 'work_item:parked', identifier: 'MT-651', reason: 'a' },
            { at: undefined, event: 'work_item:failed', identifier: 'MT-651', errorName: 'E' }
        ]
    });

    assert.ok(detail);
    assert.equal(nowCalls, 1);
    assert.equal(detail.generatedAt, NOW_ISO);
    assert.deepEqual(detail.recentEvents?.map((record) => record.at), [NOW, NOW]);
});

test('detail resolves by identifier first, then by workItemId', () => {
    const snapshot = {
        running: [{ workItemId: 'wi-x', identifier: 'MT-1' }],
        retrying: [{ workItemId: 'wi-y', identifier: 'MT-2' }],
        parked: [{ workItemId: 'wi-z', identifier: 'MT-3' }]
    };

    for (const [id, identifier] of [['wi-x', 'MT-1'], ['wi-y', 'MT-2'], ['wi-z', 'MT-3']]) {
        assert.equal(toItemResponse({ snapshot, id, now: () => NOW })?.identifier, identifier);
    }
    assert.equal(toItemResponse({ snapshot, id: 'wi-1', now: () => NOW }), null);

    // `identifier` is the scheduler's key: it wins when a value spells both.
    const collision = {
        running: [{ workItemId: 'MT-2', identifier: 'MT-1' }],
        retrying: [],
        parked: [{ workItemId: 'wi-z', identifier: 'MT-2' }]
    };
    assert.equal(toItemResponse({ snapshot: collision, id: 'MT-2', now: () => NOW })?.status, 'parked');
});

test('scheduler state lists are copies, so a response mutation cannot change the snapshot', () => {
    const snapshot = createSnapshot();
    const state = toStateResponse({ snapshot, now: () => NOW });
    state.scheduler.activeStates.push('LEAK');
    state.scheduler.terminalStates.length = 0;

    assert.deepEqual(snapshot.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(snapshot.terminalStates, ['Done']);
    assert.deepEqual(state.scheduler.activeStates, ['Todo', 'In Progress', 'LEAK']);
});

test('detail recentEvents is omitted when the provider throws and the response still builds', () => {
    const snapshot = createSnapshot();
    const detail = toItemResponse({
        snapshot,
        id: 'MT-651',
        now: () => NOW,
        events: () => { throw new Error('LEAK-provider-message'); }
    });
    assert.ok(detail);
    assert.deepEqual(Object.keys(detail), [
        'generatedAt', 'identifier', 'workItemId', 'url', 'status',
        'workspace', 'attempts', 'running', 'retry', 'parked'
    ]);
    assert.equal(Object.hasOwn(detail, 'recentEvents'), false);
    assert.equal(detail.status, 'parked');
    assert.equal(detail.identifier, 'MT-651');
    assert.equal(JSON.stringify(detail).includes('LEAK'), false);
});

test('the policy projection is health and codes only, and projectable from any snapshot', () => {
    const state = toStateResponse({
        snapshot: { started: true },
        policy: {
            started: true,
            stopped: false,
            healthy: false,
            path: '/repo/WORKFLOW.md',
            source: 'reload',
            watch: 'active',
            loadedAt: NOW,
            lastCheckedAt: NOW + 1000,
            warnings: ['unknown_key'],
            lastError: { reasons: ['invalid_config:agent.max_concurrent_agents'], at: NOW + 2000 },
            prompt: { chars: 120, hash: 'LEAK-hash' },
            config: { LEAK: true }
        },
        now: () => NOW
    });

    assert.deepEqual(Object.keys(/** @type {Record<string, unknown>} */ (state.policy)).sort(), [
        'healthy', 'lastCheckedAt', 'lastErrorAt', 'loadedAt', 'path', 'reasons',
        'source', 'started', 'stopped', 'warnings', 'watch'
    ]);
    assert.equal(/** @type {Record<string, unknown>} */ (state.policy).healthy, false);
    assert.deepEqual(/** @type {Record<string, unknown>} */ (state.policy).reasons, ['invalid_config:agent.max_concurrent_agents']);
    assert.deepEqual(/** @type {Record<string, unknown>} */ (state.policy).warnings, ['unknown_key']);
    assert.equal(JSON.stringify(state).includes('LEAK'), false, 'config and prompt never reach the API');
    assert.equal(/** @type {Record<string, unknown>} */ (state.policy).loadedAt, NOW_ISO);
    assert.equal(/** @type {Record<string, unknown>} */ (state.policy).lastErrorAt, '2026-11-09T18:00:02.000Z');
});

test('the last tick outcome rides through the scheduler projection', () => {
    const state = toStateResponse({
        snapshot: { started: true, lastOutcome: 'validation_error' },
        now: () => NOW
    });
    assert.equal(state.scheduler.lastOutcome, 'validation_error');
    assert.equal(toStateResponse({ snapshot: {}, now: () => NOW }).scheduler.lastOutcome, null);
});
