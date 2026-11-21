// @ts-check
/**
 * @file G5: `unbounded` sits between the default and the max, never above it.
 * @version 0.12.0
 *
 * @description
 * The kill switch substitutes `unbounded`, so a value above `max` would hand
 * out something the registry itself calls out of range. Both classes obey
 * `default <= unbounded <= max`: caps whose lift would crash, stall or invert a
 * meaning keep the default, and the rest lift to the documented ceiling. A
 * lifted poll interval is a 24 h stall, and a lifted `0` sentinel turns "none"
 * into "some", so those hold their default too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import { defineLimit } from '../lib/core/constants/limits/define.mjs';
import {
    LIMITS,
    resetLimits,
    reloadLimits,
    setLimits,
    setLimitWarningHandler,
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV
} from '../lib/core/limit-config.mjs';

const KEYS = Object.keys(LIMIT_REGISTRY);

const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

test.beforeEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    reloadLimits();
    setLimitWarningHandler({ handler: () => {} });
});

test.afterEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    reloadLimits();
    setLimitWarningHandler({ handler: (message) => { console.warn(message); } });
});

test('G5 every unbounded value stays between the default and the max', () => {
    assert.equal(KEYS.length, 321, 'the registry count is fixed');
    for (const key of KEYS) {
        const entry = LIMIT_REGISTRY[key];
        assert.ok(entry.unbounded >= entry.default, `${key}: unbounded ${entry.unbounded} is below default ${entry.default}`);
        if (entry.max !== undefined) {
            assert.ok(
                entry.unbounded <= entry.max,
                `${key}: unbounded ${entry.unbounded} is above max ${entry.max}; the switch would exceed the ceiling`
            );
        }
    }
});

test('G5 every key is a crash cap (unbounded = default) or a resource cap (unbounded = max)', () => {
    for (const key of KEYS) {
        const entry = LIMIT_REGISTRY[key];
        const crashCap = entry.unbounded === entry.default;
        const resourceCap = entry.max !== undefined && entry.unbounded === entry.max;
        assert.ok(crashCap || resourceCap, `${key}: unbounded ${entry.unbounded} matches neither default ${entry.default} nor max ${entry.max}`);
    }
});

test('G5 the switch lifts a resource cap to its max and holds a crash cap at its default', () => {
    setLimits({ disabled: true });
    assert.equal(LIMITS.compaction_keep_recent, 10_000, 'a retention cap lifts only to its documented ceiling');
    assert.equal(LIMITS.max_iterations, 10_000, 'a turn cap lifts only to its documented ceiling');
    assert.equal(LIMITS.scheduler_max_concurrent, 1, 'a concurrency cap holds its default');
    assert.equal(LIMITS.default_delegation_depth, 1, 'a depth cap holds its default');
});

test('G5 the switch holds cadence, zero-sentinel and jitter keys at their defaults', () => {
    setLimits({ disabled: true });
    assert.equal(LIMITS.scheduler_poll_interval_ms, 30_000, 'a lifted poll interval is a 24 h stall, not a disabled limit');
    assert.equal(LIMITS.mcp_reconnect_base_delay_ms, 250, 'a lifted backoff base delays every reconnect by a day');
    assert.equal(LIMITS.memory_lock_retry_ms, 10, 'a lifted lock retry pause stalls every waiting writer');
    assert.equal(LIMITS.tool_timeout_ms, 0, 'the 0 sentinel means "no timeout"; the switch must not add one');
    assert.equal(LIMITS.mcp_reconnect_attempts, 0, 'the 0 sentinel means "disabled"; the switch must not enable retries');
    assert.equal(LIMITS.transient_backoff_jitter, 0.2, 'a jitter fraction of 1 is maximum jitter, not unbounded');
});

test('G5 the switch holds an expiry-skew key at its default (a wider window refreshes more often)', () => {
    setLimits({ disabled: true });
    assert.equal(
        LIMITS.jai_token_refresh_skew_ms,
        60_000,
        'a lifted skew refreshes a token with 23 h left, i.e. on every call; the default is the off-value'
    );
});

test('G5 the switch holds an escalating floor or threshold at its default (a bigger value buys more work)', () => {
    setLimits({ disabled: true });
    assert.equal(
        LIMITS.decision_gate_threshold,
        0.85,
        'a lifted escalation threshold sends every gate to the LLM; the ceiling is the most work, not the least'
    );
    assert.equal(
        LIMITS.decision_skip_certainty,
        0.9,
        'a lifted skip certainty means a verifier is never skipped; 1 runs the extra call on every decision'
    );
    assert.equal(
        LIMITS.anthropic_min_thinking_budget,
        1_024,
        'a lifted minimum clamps every thinking budget up to a million tokens; the minimum is the off-value'
    );
    assert.equal(
        LIMITS.scrape_timeout_min_ms,
        1_000,
        'a lifted floor forces a 24 h deadline on every scrape, not a disabled limit'
    );
});

test('G5 the switch holds a bound that breaks an internal hang and lifts a wait on something external', () => {
    setLimits({ disabled: true });
    assert.equal(LIMITS.scheduler_stop_drain_ms, 30_000, 'a lifted drain wait blocks stop() for a day');
    assert.equal(LIMITS.memory_lock_timeout_ms, 5_000, 'a lifted lock ceiling blocks a contended writer for a day');
    assert.equal(LIMITS.scheduler_stall_timeout_ms, 900_000, 'a lifted stall detector never interrupts the stalled run');
    assert.equal(LIMITS.workflow_stall_timeout_ms, 900_000, 'a lifted stall detector never interrupts the stalled run');
    assert.equal(LIMITS.dag_hitl_timeout_ms, 86_400_000, 'a wait on a human may lift to the ceiling');
    assert.equal(LIMITS.mcp_probe_timeout_ms, 86_400_000, 'a wait on an external probe may lift to the ceiling');
    assert.equal(LIMITS.browser_wait_timeout_ms, 86_400_000, 'a wait on an external page may lift to the ceiling');
});

test('G5 defineLimit rejects an unbounded value above max', () => {
    assert.throws(
        () => defineLimit({ env: 'PROBE_UNBOUNDED_ABOVE_MAX', default: 10, min: 1, max: 100, unbounded: 101, doc: 'probe' }),
        /unbounded 101 is above max 100/,
        'the factory must refuse a kill-switch value past the ceiling'
    );
    assert.doesNotThrow(
        () => defineLimit({ env: 'PROBE_UNBOUNDED_AT_MAX', default: 10, min: 1, max: 100, unbounded: 100, doc: 'probe' }),
        'an unbounded value equal to max is the resource-cap form'
    );
});
