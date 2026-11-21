// @ts-check
/**
 * @file G1-8: a guard held under the kill switch keeps its configured value.
 * @version 0.12.0
 *
 * @description
 * The switch suspends enforcement without erasing configuration. A guard that
 * is held back because guard-off was not granted must therefore resolve to the
 * value that won before the switch — the file-tightened one — not to the code
 * default, which would quietly widen the cap the host had set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import {
    LIMITS,
    getLimits,
    setLimits,
    resetLimits,
    reloadLimits,
    setLimitWarningHandler,
    LIMITS_CONFIG_FILE,
    LIMITS_SWITCH_ENV,
    LIMITS_GUARD_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV
} from '../lib/core/limit-config.mjs';

const GUARD_KEY = 'sse_max_line_bytes';
const GUARD_DEFAULT = LIMIT_REGISTRY[GUARD_KEY].default;

const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_GUARD_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

/** @type {Array<string>} */
let warnings = [];
/** @type {Array<string>} */
const dirs = [];

/** @param {string} content - */
function useConfigFile(content) {
    const dir = mkdtempSync(join(tmpdir(), 'merci-limits-held-'));
    const file = join(dir, LIMITS_CONFIG_FILE);
    writeFileSync(file, content, 'utf8');
    dirs.push(dir);
    process.env[LIMITS_FILE_ENV] = file;
    reloadLimits();
    return file;
}

test.beforeEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    reloadLimits();
    warnings = [];
    setLimitWarningHandler({ handler: (message) => { warnings.push(message); } });
});

test.afterEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    reloadLimits();
    setLimitWarningHandler({ handler: (message) => { console.warn(message); } });
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('G1-8 a file-tightened guard keeps 2048 under `MERCI_LIMITS=limits_off`', () => {
    assert.equal(LIMIT_REGISTRY[GUARD_KEY].guard, true, 'the probe key is a guard');
    useConfigFile(JSON.stringify({ values: { [GUARD_KEY]: 2_048 } }));
    assert.equal(LIMITS[GUARD_KEY], 2_048, 'the file value wins before the switch');

    process.env[LIMITS_SWITCH_ENV] = 'limits_off';

    assert.equal(LIMITS[GUARD_KEY], 2_048, 'the held guard keeps the configured value, not the wider code default');
    const held = getLimits().find((entry) => entry.key === GUARD_KEY);
    assert.equal(held?.source, 'file', 'the reported source names where the held value came from');
    assert.equal(held?.disabled, false, 'a guard held at its value is not suspended');
    assert.ok(
        warnings.some((line) => line.includes(GUARD_KEY) && line.includes('2048')),
        `the warning names the kept value; got ${JSON.stringify(warnings)}`
    );
});

// ─── W1-1: the switch must not launder a refused guard raise ─────────────────

test('W1-1 an env value above the guard default is refused under the switch', () => {
    process.env[LIMIT_REGISTRY[GUARD_KEY].env] = '5000000';
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';

    assert.equal(LIMITS[GUARD_KEY], GUARD_DEFAULT, 'the switch does not apply a raise the plain path refuses');
    const held = getLimits().find((entry) => entry.key === GUARD_KEY);
    assert.equal(held?.source, 'guard', 'a refused raise is held by the guard, not reported as configured');
});

test('W1-1 an env value below the guard default is kept under the switch', () => {
    process.env[LIMIT_REGISTRY[GUARD_KEY].env] = '2048';
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';

    assert.equal(LIMITS[GUARD_KEY], 2_048, 'a tightened guard keeps its configured value');
    const held = getLimits().find((entry) => entry.key === GUARD_KEY);
    assert.equal(held?.source, 'environment');
});

test('W1-1 a stored override above the guard default is refused under the switch', () => {
    setLimits({ values: { [GUARD_KEY]: 5_000_000 } });
    setLimits({ disabledKeys: [GUARD_KEY] });

    assert.equal(LIMITS[GUARD_KEY], GUARD_DEFAULT, 'the override does not carry a raise past the guard');
    const held = getLimits().find((entry) => entry.key === GUARD_KEY);
    assert.equal(held?.source, 'guard');
    assert.equal(held?.heldByGuard, true);
});

test('W1-1 a stored override below the guard default is kept under the switch', () => {
    setLimits({ values: { [GUARD_KEY]: 2_048 } });
    setLimits({ disabledKeys: [GUARD_KEY] });

    assert.equal(LIMITS[GUARD_KEY], 2_048, 'a tightened override keeps its value');
    assert.equal(getLimits().find((entry) => entry.key === GUARD_KEY)?.source, 'programmatic');
});
