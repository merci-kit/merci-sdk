// @ts-check
/**
 * @file G1-7: a guard limit may only be RAISED with an explicit opt-in.
 * @version 0.12.0
 *
 * @description
 * A plain numeric value used to lift a `guard: true` cap up to its kill-switch
 * `unbounded` value with no acknowledgement. Lowering a guard stays free: a
 * host tightening its own denial-of-service cap is not the attack the guard
 * defends against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import {
    LIMITS,
    setLimits,
    resetLimits,
    setLimitWarningHandler,
    LIMITS_GUARD_ENV,
    LIMITS_SWITCH_ENV
} from '../lib/core/limit-config.mjs';

const GUARD_KEY = 'sse_max_line_bytes';
const GUARD_DEFAULT = LIMIT_REGISTRY[GUARD_KEY].default;

/** Every env key the resolver reads, so one test cannot leak into the next. */
const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_GUARD_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

/** @type {Array<string>} */
let warnings = [];

test.beforeEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    warnings = [];
    setLimitWarningHandler({ handler: (message) => { warnings.push(message); } });
});

test.afterEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    setLimitWarningHandler({ handler: (message) => { console.warn(message); } });
});

test('G1-7 `setLimits({sse_max_line_bytes: 5_000_000})` keeps the default without `MERCI_LIMITS_ALLOW_GUARD_OFF`', () => {
    assert.equal(LIMIT_REGISTRY[GUARD_KEY].guard, true, 'the probe key is a guard');
    assert.ok(GUARD_DEFAULT < 5_000_000, 'the probe value really is a raise');

    setLimits({ values: { [GUARD_KEY]: 5_000_000 } });

    assert.equal(LIMITS[GUARD_KEY], GUARD_DEFAULT, 'a guard is not raised by a bare number');
    assert.ok(
        warnings.some((line) => line.includes(GUARD_KEY) && line.includes(LIMITS_GUARD_ENV)),
        `the refusal names the opt-in; got ${JSON.stringify(warnings)}`
    );

    // Lowering a guard stays free: a config may tighten its own defence.
    setLimits({ values: { [GUARD_KEY]: 2_048 } });
    assert.equal(LIMITS[GUARD_KEY], 2_048, 'a tightened guard is honoured');
});

test('G1-7 the guard env admits the raise', () => {
    process.env[LIMITS_GUARD_ENV] = '1';
    setLimits({ values: { [GUARD_KEY]: 5_000_000 } });
    assert.equal(LIMITS[GUARD_KEY], 5_000_000);
});
