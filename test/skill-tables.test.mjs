// @ts-check

/**
 * The tier lists in the shipped skills are generated from the shell constants
 * (`scripts/build-skill-tables.mjs`). These tests pin the renderer, so the
 * generator can be trusted without touching the real constants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    renderTierBlock,
    replaceTierBlock,
    checkTierFile,
    TIER_BEGIN,
    TIER_END,
    SKILL_TIER_TARGETS,
} from '../scripts/build-skill-tables.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the block is sorted, de-duplicated, and wrapped', () => {
    const block = renderTierBlock({
        safeCommands: ['wc', 'rg', 'cat', 'rg'],
        blockedCommands: ['rm', 'bash', 'rm'],
        width: 20,
    });
    assert.match(block, /cat rg wc/, 'sorted and de-duplicated');
    assert.match(block, /bash rm/);
    const fenced = [...block.matchAll(/```text\n([\s\S]*?)```/g)].flatMap((m) => m[1].trim().split('\n'));
    assert.ok(fenced.length > 0, 'the lists are fenced');
    for (const line of fenced) {
        assert.ok(line.length <= 20, `wrapped to the width: ${JSON.stringify(line)}`);
    }
    assert.match(block, /Everything else asks the human once\./);
});

test('the block is deterministic', () => {
    const args = { safeCommands: ['b', 'a'], blockedCommands: ['d', 'c'] };
    assert.equal(renderTierBlock(args), renderTierBlock(args));
});

test('replacing keeps the text outside the markers', () => {
    const text = ['before', TIER_BEGIN, 'old', TIER_END, 'after'].join('\n');
    const next = replaceTierBlock({ text, block: 'new' });
    assert.equal(next, ['before', TIER_BEGIN, 'new', TIER_END, 'after'].join('\n'));
});

test('a missing marker pair is reported, never silently skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-tiers-'));
    const abs = join(dir, 'SKILL.md');
    writeFileSync(abs, 'no markers here\n');
    assert.match(String(checkTierFile({ abs, block: 'x' })), /expected exactly one pair/);
    assert.match(String(checkTierFile({ abs: join(dir, 'nope.md'), block: 'x' })), /missing/);
});

test('a quoted or duplicated marker pair is refused, never rewritten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-tiers-'));
    const abs = join(dir, 'SKILL.md');
    const text = ['```md', TIER_BEGIN, '```', 'prose that must survive', TIER_BEGIN, 'old', TIER_END, 'after'].join('\n');
    writeFileSync(abs, text);
    assert.equal(replaceTierBlock({ text, block: 'new' }), null, 'two BEGIN markers must not be replaced');
    assert.match(String(checkTierFile({ abs, block: 'new' })), /expected exactly one pair/);
});

test('a stale block is reported with the regeneration command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-tiers-'));
    const abs = join(dir, 'SKILL.md');
    writeFileSync(abs, [TIER_BEGIN, 'old', TIER_END].join('\n'));
    const problem = checkTierFile({ abs, block: 'new' });
    assert.match(String(problem), /stale/);
    assert.match(String(problem), /build:skill-tables/);
});

test('every shipped skill block is current', () => {
    const block = renderTierBlock({});
    for (const rel of SKILL_TIER_TARGETS) {
        assert.equal(checkTierFile({ abs: join(ROOT, rel), block, label: rel }), null, rel);
        assert.ok(readFileSync(join(ROOT, rel), 'utf8').includes(TIER_BEGIN));
    }
});
