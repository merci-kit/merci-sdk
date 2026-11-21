// @ts-check
/**
 * @file W5-4: the L8 fatal path is exercised end to end. `inspectModule` unit
 * tests cannot prove the gate exits non-zero, so this spawns the real script
 * against a throwaway copy and also checks that `--update` refuses.
 * @version 0.12.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join('scripts', 'check-limits.mjs');
const PROBE = join('lib', 'zz-gate-exit-probe.mjs');

/**
 * Builds a throwaway tree that mirrors the layout the gate derives from its
 * own location, with a one-file registry so the real `lib/` is untouched.
 * @param {string} root - temp directory
 * @returns {void}
 */
function seedTree(root) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'lib', 'core', 'constants'), { recursive: true });
    copyFileSync(join(ROOT, SCRIPT), join(root, SCRIPT));
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'lib', 'core', 'constants', 'limits.mjs'), 'export const LIMIT_REGISTRY = { max_iterations: { default: 8, min: 1 } };\n', 'utf8');
    writeFileSync(join(root, PROBE), 'export default LIMITS.foo;\n', 'utf8');
}

/**
 * @param {string} root - temp directory
 * @param {string[]} args - script arguments
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runGate(root, args = []) {
    const canonical = realpathSync(join(root, SCRIPT));
    return spawnSync(process.execPath, [canonical, ...args], { cwd: root, encoding: 'utf8' });
}

/**
 * Runs the gate through a path Node will not canonicalize: the guard must
 * compare real paths on both sides, or the gate silently exits 0.
 * @param {string} scriptPath - entry path to hand to Node
 * @param {string} cwd - working directory
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runGateAt(scriptPath, cwd) {
    return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' });
}

test('W5-4 the gate exits 1 on a module-scope LIMITS freeze', () => {
    const root = mkdtempSync(join(tmpdir(), 'limits-gate-exit-'));
    try {
        seedTree(root);
        const result = runGate(root);
        assert.equal(result.status, 1, `expected exit 1; stderr: ${result.stderr}`);
        assert.match(result.stderr, /\[L8\] .*zz-gate-exit-probe\.mjs/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('W5-4 the gate still runs when invoked through a symlinked path', () => {
    const root = mkdtempSync(join(tmpdir(), 'limits-gate-exit-'));
    const linkParent = mkdtempSync(join(tmpdir(), 'limits-gate-link-'));
    const link = join(linkParent, 'tree');
    try {
        seedTree(root);
        symlinkSync(root, link, 'dir');
        // Node realpaths `import.meta.url` but not `process.argv[1]`, so a
        // resolve()-only guard sees two different strings and skips `main()`.
        const result = runGateAt(join(link, SCRIPT), link);
        assert.equal(result.status, 1, `expected exit 1 through the symlink; stdout: ${result.stdout}`);
        assert.match(result.stderr, /\[L8\] .*zz-gate-exit-probe\.mjs/);
    } finally {
        rmSync(linkParent, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});

test('W5-4 the direct script path still exits 1', () => {
    const root = mkdtempSync(join(tmpdir(), 'limits-gate-exit-'));
    try {
        seedTree(root);
        const result = runGateAt(join(root, SCRIPT), root);
        assert.equal(result.status, 1, `expected exit 1; stdout: ${result.stdout}`);
        assert.match(result.stderr, /\[L8\] .*zz-gate-exit-probe\.mjs/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('W5-4 `--update` refuses to baseline the freeze', () => {
    const root = mkdtempSync(join(tmpdir(), 'limits-gate-exit-'));
    try {
        seedTree(root);
        const result = runGate(root, ['--update']);
        assert.equal(result.status, 1, `expected exit 1; stderr: ${result.stderr}`);
        assert.match(result.stderr, /--update refuses to baseline a frozen limit read/);
        assert.match(result.stderr, /\[L8\] .*zz-gate-exit-probe\.mjs/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
