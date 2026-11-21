// @ts-check
/**
 * `acceptEdits` auto-approves only a tool branded `editsFiles`. A skill
 * named `write_x` matches the edit name family but carries no brand, and a
 * skill that runs scripts was approved without asking under the old
 * name-based gate. A tool that runs code is never an edit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { stillRequiresApproval } from '../lib/agentic/permissions.mjs';
import { loadSkillsFromDirectory } from '../lib/tools/skills.mjs';

test('acceptEdits does not auto-approve a tool that runs code', () => {
    assert.equal(stillRequiresApproval({
        name: 'write_x',
        mode: 'acceptEdits',
        requiresApproval: true,
        tool: { runsCode: true },
    }), true, 'a code-running skill must still ask');
});

test('acceptEdits still auto-approves a branded edit tool', () => {
    assert.equal(stillRequiresApproval({
        name: 'write_file',
        mode: 'acceptEdits',
        requiresApproval: true,
        tool: { runsCode: false, editsFiles: true },
    }), false);
    // The name alone is not the brand (G2-3): without `editsFiles` it asks.
    assert.equal(stillRequiresApproval({ name: 'write_file', mode: 'acceptEdits', requiresApproval: true }), true, 'a tool bag is optional, and no bag means no brand');
});

test('a skill with scripts is marked runsCode and asks under acceptEdits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-skill-code-'));
    try {
        await mkdir(join(root, 'write_x'));
        await mkdir(join(root, 'write_x', 'scripts'));
        await writeFile(join(root, 'write_x', 'SKILL.md'), '---\nname: write_x\ndescription: writes things\n---\nBody.');
        await writeFile(join(root, 'write_x', 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
        const [tool] = await loadSkillsFromDirectory({ directory: root, requireScriptApproval: true });
        assert.equal(tool.name, 'write_x');
        assert.equal(/** @type {any} */ (tool).runsCode, true);
        const gate = /** @type {any} */ (tool).requiresApproval;
        assert.equal(typeof gate, 'function', 'the gate is per call, not a tool-wide boolean');
        assert.equal(gate({ args: {} }), false, 'reading the instructions runs nothing');
        assert.equal(gate({ args: { script: 'run.sh' } }), true, 'running a script is gated');
        assert.equal(stillRequiresApproval({
            name: /** @type {any} */ (tool).name,
            mode: 'acceptEdits',
            requiresApproval: gate({ args: { script: 'run.sh' } }),
            tool: /** @type {any} */ (tool),
        }), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
