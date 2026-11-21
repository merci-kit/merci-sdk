// @ts-check
/**
 * @file G1-9: the kill switch must not turn a concurrency or depth cap into a
 * six-figure number.
 * @version 0.12.0
 *
 * @description
 * These knobs bound how much work is in flight at once and how deep the work
 * tree may recurse. "Unbounded" is meaningless for them: the honest value under
 * the switch is the default, because dispatching a million concurrent attempts
 * is not a disabled limit, it is a crash. Their registry entry therefore
 * declares `unbounded` equal to `default`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import {
    LIMITS,
    resetLimits,
    reloadLimits,
    setLimitWarningHandler,
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV
} from '../lib/core/limit-config.mjs';

const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

/**
 * Caps where lifting under the switch is genuinely safe, with the reason they
 * are exempt. Empty: every cap the scan derives has no meaningful "disabled"
 * value — 0 already means unbounded where a cap has a zero default, and a
 * bigger number elsewhere is a crash, not a suspended limit.
 * @type {Set<string>}
 */
const LIFT_IS_SAFE = new Set();

/** A cap whose name reads like a bound on work in flight, recursion or hops. */
const CAP_NAME_RE = /(concurren|depth|redirect|^max_spawns$)/i;

/**
 * The same class of cap, found by what its doc promises rather than its name —
 * `max_parallel_tools` is a fan-out cap whose name carries none of the words
 * above, so a name-only scan is a hole.
 */
const CAP_DOC_RE = /(concurren|in flight|at once|parallel|depth|nesting|fan-out|redirect)/i;

/** Derived from the WHOLE registry, so a cap in any domain file is covered. */
const CAP_KEYS = Object.keys(LIMIT_REGISTRY)
    .filter((key) => CAP_NAME_RE.test(key) || CAP_DOC_RE.test(LIMIT_REGISTRY[key].doc))
    .filter((key) => !LIFT_IS_SAFE.has(key));

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

test('G1-9 the switch keeps `scheduler_max_concurrent` at 1', () => {
    assert.equal(LIMIT_REGISTRY.scheduler_max_concurrent.default, 1);
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    assert.equal(LIMITS.scheduler_max_concurrent, 1, 'a suspended concurrency cap stays at its default');
});

test('G1-9 every concurrency, depth and redirect cap holds its default under the switch', () => {
    // Derived from the whole registry by name AND doc text, not a hand-kept
    // list: a new cap must declare `unbounded` equal to its default or this
    // fails, wherever it is declared and however it is spelled.
    assert.ok(CAP_KEYS.length >= 18, `the name/doc scan must reach the catalog; matched ${CAP_KEYS.length}`);
    assert.ok(CAP_KEYS.includes('scheduler_max_concurrent'), 'the name scan sees the known probe key');
    assert.ok(CAP_KEYS.includes('max_context_chain_depth'), 'the name scan sees a depth cap');
    assert.ok(CAP_KEYS.includes('max_parallel_tools'), 'the doc scan sees a fan-out cap with no cap word in its name');
    assert.ok(CAP_KEYS.includes('cap_max_depth'), 'the scan sees the tools-file depth cap');
    assert.ok(CAP_KEYS.includes('selector_ancestor_depth'), 'the scan sees the presentation-file depth cap');
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    for (const key of CAP_KEYS) {
        const entry = LIMIT_REGISTRY[key];
        assert.equal(entry.unbounded, entry.default, `${key}: unbounded ${entry.unbounded} must equal the default ${entry.default}`);
        assert.equal(LIMITS[key], entry.default, `${key}: the switch keeps the default`);
    }
});
