// @ts-check

/**
 * @file Contract tests for the limit registry, resolver, config file and kill switch.
 * @version 0.12.0
 *
 * @description
 * Pins the resolution contract: defaults, `merci-limits.json`, `MERCI_LIMIT_*`
 * env, `setLimits()`, and the kill switch above all four. The switch must
 * suspend without mutating, so switching back restores the exact value that won
 * before. Also pins the registry itself: unique env names, usable bounds, and
 * timer-safe `unbounded` values.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    LIMIT_REGISTRY,
    LIMIT_DEFAULTS,
    NODE_TIMER_MAX
} from '../lib/core/constants/limits.mjs';
import {
    LIMITS,
    getLimits,
    resolveLimit,
    setLimits,
    resetLimits,
    reloadLimits,
    setLimitWarningHandler,
    LIMITS_CONFIG_FILE,
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

/** @type {Array<string>} */
let warnings = [];
/** @type {Array<{dir: string, file: string}>} */
const dirs = [];
/** @type {string} */
let previousCwd = process.cwd();

/** @param {string} content - */
function useConfigFile(content) {
    const dir = mkdtempSync(join(tmpdir(), 'merci-limits-'));
    const file = join(dir, LIMITS_CONFIG_FILE);
    writeFileSync(file, content, 'utf8');
    dirs.push({ dir, file });
    process.env[LIMITS_FILE_ENV] = file;
    reloadLimits();
    return file;
}

/** @param {string} key - */
function clearKey(key) {
    delete process.env[key];
}

test.beforeEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) clearKey(key);
    reloadLimits();
    warnings = [];
    setLimitWarningHandler({ handler: (message) => { warnings.push(message); } });
    previousCwd = process.cwd();
});

test.afterEach(() => {
    process.chdir(previousCwd);
    resetLimits();
    for (const key of ENV_KEYS) clearKey(key);
    reloadLimits();
    setLimitWarningHandler({ handler: (message) => { console.warn(message); } });
    for (const { dir } of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});


// ─── Registry integrity ───────────────────────────────────────────────────────

test('registry: every key carries the full descriptor and a unique env name', () => {
    const keys = Object.keys(LIMIT_REGISTRY);
    assert.ok(keys.length >= 240, `expected the full catalog, got ${keys.length}`);
    const envs = new Set();
    for (const [key, entry] of Object.entries(LIMIT_REGISTRY)) {
        assert.equal(entry.env, entry.env.trim(), `${key}: env has no padding`);
        assert.ok(entry.env.startsWith('MERCI_LIMIT_'), `${key}: env carries the prefix`);
        assert.equal(typeof entry.default, 'number');
        assert.ok(Number.isFinite(entry.default), `${key}: finite default`);
        assert.ok(Number.isFinite(entry.unbounded), `${key}: finite unbounded`);
        assert.equal(typeof entry.doc, 'string');
        assert.ok(entry.doc.length > 0, `${key}: doc`);
        assert.equal(typeof entry.mutable, 'boolean');
        assert.equal(typeof entry.guard, 'boolean');
        assert.equal(typeof entry.timer, 'boolean');
        if (entry.min !== undefined) assert.ok(entry.default >= entry.min, `${key}: default >= min`);
        if (entry.max !== undefined) assert.ok(entry.default <= entry.max, `${key}: default <= max`);
        assert.ok(!envs.has(entry.env), `${key}: duplicate env ${entry.env}`);
        envs.add(entry.env);
        assert.ok(entry.unbounded >= entry.default, `${key}: the switch must never tighten the limit`);
    }
});

test('registry: a timer limit never gets an unbounded value past the Node timer ceiling', () => {
    for (const [key, entry] of Object.entries(LIMIT_REGISTRY)) {
        if (!entry.timer) continue;
        assert.ok(entry.unbounded <= NODE_TIMER_MAX, `${key}: unbounded ${entry.unbounded} > ${NODE_TIMER_MAX}`);
    }
});

test('registry: fixed limits keep identity, so the switch cannot change them', () => {
    const fixed = Object.entries(LIMIT_REGISTRY).filter(([, entry]) => !entry.mutable);
    assert.ok(fixed.length > 0, 'expected at least one fixed limit');
    for (const [key, entry] of fixed) {
        assert.equal(entry.unbounded, entry.default, `${key}: fixed limit must not move under the switch`);
    }
});

test('registry: LIMIT_DEFAULTS mirrors the descriptor defaults', () => {
    assert.deepEqual(LIMIT_DEFAULTS, Object.fromEntries(
        Object.entries(LIMIT_REGISTRY).map(([key, entry]) => [key, entry.default])
    ));
});

test('registry: legacy DEFAULT_* exports still carry the documented defaults', async () => {
    const constants = await import('../lib/core/constants/limits.mjs');
    assert.equal(constants.DEFAULT_MAX_ITERATIONS, 5);
    assert.equal(constants.DEFAULT_MAX_FOLLOW_UPS, 4);
    assert.equal(constants.DEFAULT_STREAM_TIMEOUT_MS, 150_000);
    assert.equal(constants.SHELL_TOOL_MAX_OUTPUT_LENGTH, 4_000);
    assert.equal(constants.MAX_INTAKE_OUTPUT_CHARS, 8_000);
    assert.equal(constants.DEFAULT_COMPACTION_THRESHOLD_TOKENS, 6_000);
    assert.equal(constants.DEFAULT_MAX_REPLAN_COUNT, 3);
    assert.equal(constants.STREAMING_MAX_RETRIES, 2);
    assert.equal(constants.SHELL_TOOL_DEFAULT_TIMEOUT_MS, LIMIT_REGISTRY.shell_tool_timeout_ms.default);
});


// ─── Defaults and precedence ──────────────────────────────────────────────────

test('resolve: no configuration yields the registry default', () => {
    for (const key of ['max_iterations', 'stream_timeout_ms', 'read_max_bytes', 'operator_max_body_bytes']) {
        assert.equal(resolveLimit({ key }), LIMIT_DEFAULTS[key], key);
    }
});

test('resolve: MERCI_LIMIT_<KEY> overrides the default', () => {
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '9';
    assert.equal(LIMITS.max_iterations, 9);
    assert.equal(getLimits().find((entry) => entry.key === 'max_iterations')?.source, 'environment');
});

test('resolve: an invalid env value falls back to the default and warns once', () => {
    process.env.MERCI_LIMIT_MAX_ITERATIONS = 'many';
    assert.equal(LIMITS.max_iterations, 5);
    assert.equal(LIMITS.max_iterations, 5);
    assert.equal(warnings.filter((line) => line.includes("'max_iterations'")).length, 1);
});

test('resolve: bounds clamp instead of accepting a hostile value', () => {
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '999999999';
    assert.equal(LIMITS.max_iterations, 10_000);
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '0';
    assert.equal(LIMITS.max_iterations, 1);
    assert.ok(warnings.some((line) => line.includes('above 10000')));
});

test('resolve: integer limits truncate, ratio limits keep the fraction', () => {
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '4.9';
    assert.equal(LIMITS.max_iterations, 4);
    process.env.MERCI_LIMIT_READ_BINARY_RATIO = '0.25';
    assert.equal(LIMITS.read_binary_ratio, 0.25);
});

test('resolve: the config file overrides the default', () => {
    useConfigFile(JSON.stringify({ values: { max_iterations: 12 } }));
    assert.equal(LIMITS.max_iterations, 12);
    assert.equal(getLimits().find((entry) => entry.key === 'max_iterations')?.source, 'file');
});

test('resolve: env beats the file; setLimits beats env; reset returns to env', () => {
    useConfigFile(JSON.stringify({ values: { max_iterations: 12 } }));
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '7';
    assert.equal(LIMITS.max_iterations, 7);
    setLimits({ values: { max_iterations: 15 } });
    assert.equal(LIMITS.max_iterations, 15);
    resetLimits();
    assert.equal(LIMITS.max_iterations, 7);
});

test('resolve: a malformed config file warns and behaves as absent', () => {
    useConfigFile('{ not json');
    assert.equal(LIMITS.max_iterations, 5);
    assert.ok(warnings.some((line) => line.includes('ignoring')));
});

test('resolve: a missing config file is silent', () => {
    process.env[LIMITS_FILE_ENV] = join(tmpdir(), 'merci-limits-does-not-exist.json');
    reloadLimits();
    assert.equal(LIMITS.max_iterations, 5);
    assert.equal(warnings.length, 0);
});

test('resolve: reloadLimits picks up a rewritten file', () => {
    const file = useConfigFile(JSON.stringify({ values: { max_iterations: 6 } }));
    assert.equal(LIMITS.max_iterations, 6);
    writeFileSync(file, JSON.stringify({ values: { max_iterations: 8 } }), 'utf8');
    reloadLimits();
    assert.equal(LIMITS.max_iterations, 8);
});

test('resolve: the project file is read from cwd when no path is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-limits-cwd-'));
    dirs.push({ dir, file: join(dir, LIMITS_CONFIG_FILE) });
    writeFileSync(join(dir, LIMITS_CONFIG_FILE), JSON.stringify({ values: { max_iterations: 3 } }), 'utf8');
    delete process.env[LIMITS_FILE_ENV];
    process.chdir(dir);
    reloadLimits();
    assert.equal(LIMITS.max_iterations, 3);
});


// ─── Kill switch ──────────────────────────────────────────────────────────────

test('switch: MERCI_LIMITS=limits_off suspends every tunable', () => {
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded);
    assert.equal(LIMITS.stream_timeout_ms, LIMIT_REGISTRY.stream_timeout_ms.unbounded);
    assert.equal(getLimits().find((entry) => entry.key === 'max_iterations')?.disabled, true);
});

test('switch: switching back restores the value that won before', () => {
    useConfigFile(JSON.stringify({ values: { max_iterations: 12 } }));
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '9';
    assert.equal(LIMITS.max_iterations, 9);
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded);
    process.env[LIMITS_SWITCH_ENV] = 'limits_on';
    assert.equal(LIMITS.max_iterations, 9, 'env value must resurface');
    clearKey('MERCI_LIMIT_MAX_ITERATIONS');
    assert.equal(LIMITS.max_iterations, 12, 'file value must resurface');
    setLimits({ values: { max_iterations: 20 } });
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    setLimits({ disabled: false });
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded, 'env switch still owns the off state');
});

test('switch: setLimits({disabled}) suspends and restores programmatic values', () => {
    setLimits({ values: { max_iterations: 11 } });
    setLimits({ disabled: true });
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded);
    setLimits({ disabled: false });
    assert.equal(LIMITS.max_iterations, 11);
});

test('switch: a per-key env off suspends only that key', () => {
    process.env.MERCI_LIMIT_MAX_ITERATIONS = 'off';
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded);
    assert.equal(LIMITS.stream_timeout_ms, 150_000);
});

test('switch: MERCI_LIMITS_DISABLED lists keys to suspend', () => {
    process.env[LIMITS_DISABLED_ENV] = 'max_iterations,read_max_bytes';
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded);
    assert.equal(LIMITS.read_max_bytes, LIMIT_REGISTRY.read_max_bytes.unbounded);
    assert.equal(LIMITS.stream_timeout_ms, 150_000);
});

test('switch: the file disabled list suspends keys', () => {
    useConfigFile(JSON.stringify({ disabled: ['max_iterations'] }));
    assert.equal(LIMITS.max_iterations, LIMIT_REGISTRY.max_iterations.unbounded);
});

test('switch: a guard keeps its default unless guard-off is explicit', () => {
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    assert.equal(LIMITS.sse_max_line_bytes, LIMIT_REGISTRY.sse_max_line_bytes.default);
    assert.ok(warnings.some((line) => line.includes('safety guard')));
    process.env[LIMITS_GUARD_ENV] = '1';
    assert.equal(LIMITS.sse_max_line_bytes, LIMIT_REGISTRY.sse_max_line_bytes.unbounded);
});

test('switch: setLimits({allowGuardOff:true}) suspends guards programmatically', () => {
    setLimits({ disabled: true, allowGuardOff: true });
    assert.equal(LIMITS.operator_max_body_bytes, LIMIT_REGISTRY.operator_max_body_bytes.unbounded);
});


// ─── Programmatic API ─────────────────────────────────────────────────────────

test('setLimits: validates eagerly and rejects an unknown key', () => {
    assert.throws(() => setLimits({ values: { nope: 1 } }), /unknown limit 'nope'/);
    assert.throws(() => setLimits({ values: { max_iterations: 'lots' } }), /finite number/);
});

test('setLimits: a fixed limit rejects an override', () => {
    const key = Object.keys(LIMIT_REGISTRY).find((name) => LIMIT_REGISTRY[name].mutable === false);
    assert.ok(key, 'expected a fixed key');
    assert.throws(() => setLimits({ values: { [key]: 1 } }), /is fixed/);
});

test('setLimits: env override of a fixed limit is ignored with a warning', () => {
    const key = Object.keys(LIMIT_REGISTRY).find((name) => LIMIT_REGISTRY[name].mutable === false);
    assert.ok(key);
    const entry = LIMIT_REGISTRY[key];
    process.env[entry.env] = '1';
    assert.equal(LIMITS[key], entry.default);
});

test('getLimits: reports value, source, default and flags for every key', () => {
    const all = getLimits();
    assert.equal(all.length, Object.keys(LIMIT_REGISTRY).length);
    const entry = all.find((item) => item.key === 'max_iterations');
    assert.ok(entry);
    assert.equal(entry?.value, 5);
    assert.equal(entry?.source, 'default');
    assert.equal(entry?.default, 5);
    assert.equal(entry?.env, 'MERCI_LIMIT_MAX_ITERATIONS');
    assert.equal(entry?.guard, false);
    assert.equal(entry?.mutable, true);
});

test('resolve: an unknown key is a configuration error, not a silent zero', () => {
    assert.throws(() => resolveLimit({ key: 'not_a_limit' }), /Unknown limit/);
});

test('LIMITS: reads are deferred, so a value set after import is honoured', () => {
    assert.equal(LIMITS.max_iterations, 5);
    process.env.MERCI_LIMIT_MAX_ITERATIONS = '17';
    assert.equal(LIMITS.max_iterations, 17);
});

test('LIMITS: is frozen and enumerates every registry key', () => {
    assert.ok(Object.isFrozen(LIMITS));
    assert.deepEqual(Object.keys(LIMITS).sort(), Object.keys(LIMIT_REGISTRY).sort());
});

// ─── Reconciliation: atomicity, aliases and diagnostics ──────────────────────

test('setLimits: a rejected call applies nothing', () => {
    assert.throws(() => setLimits({ values: { max_iterations: 7, nope: 1 } }), /unknown limit 'nope'/);
    assert.equal(LIMITS.max_iterations, 5, 'the valid half must not have been applied');
    assert.throws(() => setLimits({ disabledKeys: ['nope'] }), /unknown limit 'nope'/);
    assert.equal(LIMITS.max_iterations, 5);
});

test('setLimits: a fixed key rejects the whole call', () => {
    assert.throws(
        () => setLimits({ values: { max_iterations: 7, policy_hash_chars: 3 } }),
        /is fixed/
    );
    assert.equal(LIMITS.max_iterations, 5);
});

test('resolve: a legacy env name is honoured, and the new name wins over it', () => {
    process.env.JAI_HEADER_TIMEOUT_MS = '900000';
    assert.equal(LIMITS.jai_header_timeout_ms, 900_000);
    process.env.MERCI_LIMIT_JAI_HEADER_TIMEOUT_MS = '123456';
    assert.equal(LIMITS.jai_header_timeout_ms, 123_456);
});

test('resolve: an unknown config-file key warns instead of failing open', () => {
    useConfigFile(JSON.stringify({ values: { max_iterations: 6, typo_key: 2 }, disabled: ['also_typo'] }));
    assert.equal(LIMITS.max_iterations, 6);
    assert.ok(warnings.some((line) => line.includes("unknown key 'typo_key'")));
    assert.ok(warnings.some((line) => line.includes("unknown key 'also_typo'")));
});

test('switch: a held guard reports source "guard", not "disabled"', () => {
    process.env[LIMITS_SWITCH_ENV] = 'limits_off';
    const held = getLimits().find((entry) => entry.key === 'sse_max_line_bytes');
    assert.equal(held?.source, 'guard');
    assert.equal(held?.disabled, false);
    assert.equal(held?.heldByGuard, true);
    assert.equal(held?.value, held?.default);
});

test('switch: MERCI_LIMITS_DISABLED warns about an unknown key', () => {
    process.env[LIMITS_DISABLED_ENV] = 'not_a_limit';
    assert.equal(LIMITS.max_iterations, 5);
    assert.ok(warnings.some((line) => line.includes("unknown key 'not_a_limit'")));
});
