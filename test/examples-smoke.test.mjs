// @ts-check
// `Fishing // @ts-check` (a stray word before the directive) and crashed at

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * @param {{dir: string}} arg0
 * @returns {string[]}
 */
function walk({ dir }) {
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk({ dir: p }));
        else if (entry.name.endsWith('.mjs')) out.push(p);
    }
    return out;
}

const files = walk({ dir: join(ROOT, 'examples') });

test('examples: every module parses (node --check)', () => {
    assert.ok(files.length >= 2, `expected at least 2 example modules, found ${files.length}`);
    for (const f of files) {
        execFileSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
    }
});

test('examples: the first line is a comment (module-load corruption guard)', () => {
    for (const f of files) {
        const first = readFileSync(f, 'utf8').split('\n', 1)[0];
        assert.match(first, /^\s*\/\//, `${relative(ROOT, f)} first line must start with a comment, got: ${first}`);
    }
});

test('examples: the quickstart, durability and shared-audit modules exist', () => {
    for (const rel of ['examples/01_quickstart.mjs', 'examples/20_durability.mjs', 'examples/_shared/example-audit.mjs']) {
        assert.ok(files.includes(join(ROOT, rel)), `${rel} must exist`);
    }
});
