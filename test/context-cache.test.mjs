// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverInstructions, buildEnvironmentBlock } from '../lib/agentic/context.mjs';

describe('discoverInstructions cache', () => {
    it('reuses the cached render for an unchanged workspace', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-ctx-'));
        writeFileSync(join(dir, 'AGENTS.md'), 'rule one', 'utf8');
        const first = await discoverInstructions({ root: dir, stopAt: dir });
        assert.match( (/** @type {string} */ (first)), /rule one/);
        const second = await discoverInstructions({ root: dir, stopAt: dir });
        assert.equal(second, first);
        rmSync(dir, { recursive: true, force: true });
    });

    it('an mtime change invalidates the cache', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-ctx-'));
        writeFileSync(join(dir, 'AGENTS.md'), 'rule one', 'utf8');
        const first = await discoverInstructions({ root: dir, stopAt: dir });
        const past = new Date(Date.now() - 5000);
        writeFileSync(join(dir, 'AGENTS.md'), 'rule two', 'utf8');
        const { utimes } = await import('node:fs/promises');
        await utimes(join(dir, 'AGENTS.md'), past, new Date());
        const third = await discoverInstructions({ root: dir, stopAt: dir });
        assert.match( (/** @type {string} */ (third)), /rule two/);
        assert.notEqual(third, first);
        rmSync(dir, { recursive: true, force: true });
    });

    it('a deleted AGENTS.md drops the block from the cache', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-ctx-'));
        writeFileSync(join(dir, 'AGENTS.md'), 'rule one', 'utf8');
        await discoverInstructions({ root: dir, stopAt: dir });
        rmSync(join(dir, 'AGENTS.md'));
        const after = await discoverInstructions({ root: dir, stopAt: dir });
        assert.equal(after, null);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('buildEnvironmentBlock cache', () => {
    it('returns the same block for repeated calls on the same day', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-ctx-'));
        const a = await buildEnvironmentBlock({ root: dir });
        const b = await buildEnvironmentBlock({ root: dir });
        assert.equal(a, b);
        rmSync(dir, { recursive: true, force: true });
    });
});
