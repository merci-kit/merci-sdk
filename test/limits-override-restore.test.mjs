// @ts-check
/**
 * @file G1-11: suspending one key keeps the programmatic value, so re-enabling
 * restores it.
 * @version 0.12.0
 *
 * @description
 * `setLimits({ values: { k: 'off' } })` adds the key to the disabled set. That
 * set already short-circuits resolution, so deleting the stored override only
 * loses the value: the switch could not restore it afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import {
    LIMITS,
    getLimits,
    setLimits,
    resetLimits,
    reloadLimits,
    setLimitWarningHandler,
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV
} from '../lib/core/limit-config.mjs';

const KEY = 'max_iterations';

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

test('G1-11 re-enabling restores the override', () => {
    setLimits({ values: { [KEY]: 8 } });
    assert.equal(LIMITS[KEY], 8);

    setLimits({ values: { [KEY]: 'off' } });
    assert.equal(LIMITS[KEY], LIMIT_REGISTRY[KEY].unbounded, 'off suspends the key');
    assert.equal(getLimits().find((entry) => entry.key === KEY)?.source, 'disabled');

    // Re-enable through the disabled list: the programmatic value must resurface.
    setLimits({ disabledKeys: [] });
    assert.equal(LIMITS[KEY], 8, 'the override was kept while the key was off');
});
