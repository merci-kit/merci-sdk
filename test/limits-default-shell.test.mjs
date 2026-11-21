// @ts-check

/**
 * @file The shell positional caps live only in `LIMIT_REGISTRY`, and the dead
 * `maxPositionals` arm of the safe-tier check is gone.
 * @version 0.12.0
 *
 * @description
 * `safeTierNeedsApproval` resolves every positional cap through
 * `POSITIONAL_LIMIT_KEYS` + `LIMITS`. The option table used to carry a
 * `maxPositionals` copy that a ternary fallback read, but that arm could never
 * contribute a number: every capped base has a registered key, and every other
 * entry resolves the `{}` default. An unreachable branch has no behavioural
 * red, so the deletion is pinned two ways — the old field and its reader are
 * gone, and the map names exactly the registered caps — and then the registered
 * cap is re-proven to gate the safe tier on its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LIMIT_REGISTRY } from '../lib/core/constants/index.mjs';
import { SHELL_TOOL_SAFE_OPTIONS } from '../lib/core/constants/shell-tool-lists.mjs';
import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import * as utils from '../lib/support/utils.mjs';

const shellSource = readFileSync(new URL('../lib/tools/shell-tools.mjs', import.meta.url), 'utf8');

test('no safe-option entry carries a positional cap', () => {
    const carriers = Object.entries(SHELL_TOOL_SAFE_OPTIONS)
        .filter(([, policy]) => Object.prototype.hasOwnProperty.call(policy, 'maxPositionals'))
        .map(([base]) => base);
    assert.deepEqual(carriers, [], 'the registered LIMITS key is the only positional cap');
    assert.doesNotMatch(shellSource, /maxPositionals/, 'the deleted field has no reader left');
});

test('the positional-cap map names exactly the registered keys', () => {
    const block = shellSource.match(/const POSITIONAL_LIMIT_KEYS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
    assert.ok(block, 'POSITIONAL_LIMIT_KEYS is declared as a frozen literal');
    const mapped = [...block[1].matchAll(/([a-z_]+):\s*'(shell_policy_max_positionals_[a-z_]+)'/g)]
        .map((match) => ({ base: match[1], key: match[2] }));
    assert.ok(mapped.length > 0, 'the map parses');

    const registered = Object.keys(LIMIT_REGISTRY)
        .filter((key) => key.startsWith('shell_policy_max_positionals_'))
        .sort();
    assert.deepEqual(mapped.map((entry) => entry.key).sort(), registered);
    assert.equal(new Set(mapped.map((entry) => entry.base)).size, mapped.length, 'one entry per base');

    for (const { base, key } of mapped) {
        assert.equal(key, `shell_policy_max_positionals_${base}`, 'the key is derived from the base');
        assert.ok(
            Object.prototype.hasOwnProperty.call(SHELL_TOOL_SAFE_OPTIONS, base),
            `'${base}' is a safe-tier command`
        );
    }
});

test('a normal uniq on the default runs without a gate call', async () => {
    /** @type {string[]} */
    const asked = [];
    const shell = createShellTool({ options: {
        approvalCallback: async (/** @type {string} */ command) => { asked.push(command); return false; },
        roots: [process.cwd()],
    } });
    const result = await shell.execute({ args: { command: 'uniq', args: ['package.json'] } });
    assert.deepEqual(asked, [], 'one operand is within the registered default of 1');
    assert.equal(result.success, true);
    assert.ok(String(result.stdout).length > 0, 'the command actually ran');
});

test('the registered positional cap still gates the safe tier when lowered', async () => {
    /** @type {string[]} */
    const asked = [];
    const shell = createShellTool({ options: {
        approvalCallback: async (/** @type {string} */ command) => { asked.push(command); return false; },
        roots: [process.cwd()],
    } });
    try {
        setLimits({ values: { shell_policy_max_positionals_uniq: 0 } });

        const lowered = await shell.execute({ args: { command: 'uniq', args: ['package.json'] } });
        assert.equal(asked.length, 1, 'the lowered registered cap must reach the gate');
        assert.equal(lowered.success, false);
        assert.match(String(lowered.error), /denied/i);
    } finally {
        resetLimits();
    }
});

test('the dead embedding-dimension constant is not exported', () => {
    assert.equal('DEFAULT_JAI_EMBEDDING_DIMENSIONS_VALUE' in utils, false);
});

test('the deleted fields left no registry read behind', () => {
    for (const rel of ['../lib/core/constants/shell-tool-lists.mjs', '../lib/support/utils.mjs']) {
        const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /LIMIT_REGISTRY/, `${rel} must not read the registry for a dead constant`);
    }
});
