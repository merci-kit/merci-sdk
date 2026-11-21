// @ts-check
/**
 * `LIMITS.<key>` is the single source for a tunable's effective value. The
 * constants in `lib/core/constants/` that only mirrored a registry default are
 * gone; the four that remain are documented *code* defaults, so a reader can
 * tell the compiled-in number from the one a host configured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import { LIMITS, resetLimits, setLimits } from '../lib/core/limit-config.mjs';

const BARREL = await import('../lib/core/constants/index.mjs');

/** @type {Array<{name: string, module: string, key: string}>} */
const DELETED = [
    { name: 'TOOL_SEARCH_MAX_RESULTS', module: '../lib/core/constants/capability.mjs', key: 'tool_search_max_results' },
    { name: 'DEFAULT_MEMORY_SYNC_INTERVAL', module: '../lib/core/constants/memory.mjs', key: 'memory_sync_interval' },
    { name: 'MEMORY_QUERY_MIN_TOKEN_LENGTH', module: '../lib/core/constants/memory.mjs', key: 'memory_query_min_token_length' },
    { name: 'MEMORY_MAX_FACTS_PER_BANK', module: '../lib/core/constants/memory.mjs', key: 'memory_max_facts_per_bank' },
    { name: 'DEFAULT_ANTHROPIC_MAX_TOKENS', module: '../lib/core/constants/models.mjs', key: 'anthropic_max_tokens' },
    { name: 'A2A_DEFAULT_TIMEOUT_MS', module: '../lib/core/constants/multi-protocol.mjs', key: 'a2a_timeout_ms' },
];

/**
 * `literal` is the reviewed value, independent of the module: comparing the
 * constant to `LIMIT_REGISTRY[key].default` would compare an expression to
 * itself and could never fail.
 * @type {Array<{name: string, module: string, key: string, literal: number}>}
 */
const KEEPERS = [
    { name: 'MEMORY_MAX_HISTORY_ROWS', module: '../lib/core/constants/memory.mjs', key: 'memory_max_history_rows', literal: 200 },
    { name: 'MCP_DEFAULT_TIMEOUT_MS', module: '../lib/core/constants/multi-protocol.mjs', key: 'mcp_default_timeout_ms', literal: 60_000 },
    { name: 'MCP_PROBE_TIMEOUT_MS', module: '../lib/core/constants/multi-protocol.mjs', key: 'mcp_probe_timeout_ms', literal: 10_000 },
    { name: 'A2A_REQUEST_MAX_BODY_BYTES', module: '../lib/core/constants/multi-protocol.mjs', key: 'a2a_request_max_body_bytes', literal: 10_000_000 },
];

test('a mirrored default is not exported by its module or the constants barrel', async () => {
    for (const { name, module, key } of DELETED) {
        assert.ok(LIMIT_REGISTRY[key], `${key} stays a registry limit`);
        const mod = await import(module);
        assert.equal(name in mod, false, `${module} must not export ${name}`);
        assert.equal(name in BARREL, false, `the barrel must not export ${name}`);
    }
});

test('a kept constant is the code default while LIMITS reports the effective value', async () => {
    try {
        for (const { name, module, key, literal } of KEEPERS) {
            const mod = await import(module);
            const codeDefault = /** @type {any} */ (mod)[name];
            assert.equal(codeDefault, literal, `${name} is the reviewed code default`);

            const lower = Math.floor(codeDefault / 2);
            setLimits({ values: { [key]: lower } });
            assert.equal(LIMITS[key], lower, `LIMITS.${key} follows setLimits`);
            assert.equal(/** @type {any} */ (mod)[name], literal,
                `${name} still reports the code default, not the override`);
        }
    } finally {
        resetLimits();
    }
});

test('only the kept constants read LIMIT_REGISTRY', () => {
    /** @type {Array<{file: string, keys: Array<string>}>} */
    const expected = [
        { file: 'capability.mjs', keys: [] },
        { file: 'memory.mjs', keys: ['memory_max_history_rows'] },
        { file: 'models.mjs', keys: [] },
        { file: 'multi-protocol.mjs', keys: ['mcp_default_timeout_ms', 'mcp_probe_timeout_ms', 'a2a_request_max_body_bytes'] },
    ];
    for (const { file, keys } of expected) {
        const text = readFileSync(new URL(`../lib/core/constants/${file}`, import.meta.url), 'utf8');
        const used = [...text.matchAll(/LIMIT_REGISTRY\.([A-Za-z0-9_]+)\.default/g)].map(([, key]) => key);
        assert.deepEqual(used, keys, `${file} reads LIMIT_REGISTRY only for its kept defaults`);
        if (keys.length === 0) {
            assert.ok(!text.includes('LIMIT_REGISTRY'), `${file} must not import LIMIT_REGISTRY`);
        }
    }
});
