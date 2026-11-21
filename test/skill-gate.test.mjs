// @ts-check

/**
 * The skill gate runs on every `pnpm test`, not only when someone remembers
 * `pnpm check:skill`. A skill that ships inside the tarball is a public
 * artifact: its name must match its directory, its references must resolve,
 * and its version must match the package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every skill in skills/ passes the gate, and every one is checked', () => {
    const stdout = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-skill.mjs'), '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.violations, []);
    for (const name of ['cli-search', 'merci-sdk', 'shell-scripting']) {
        assert.ok(result.skills.includes(name), `the gate must check ${name} (saw ${result.skills.join(', ')})`);
    }
});
