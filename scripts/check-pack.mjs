#!/usr/bin/env node


/**
 * @file npm tarball contents gate.
 * @version 0.7.2
 *
 * @description
 * Verifies what `npm pack` would actually publish. Publishing the repository
 * root is the classic way an SDK ships its tests, apps and scratch files, and
 * the classic way a package ships without types. This gate asserts the tarball
 * contains exactly the published surface:
 *
 *   - `lib/` (runtime), `dist/types/` (generated declarations),
 *     `skills/` (agent skill), `README.md`, `LICENSE`, `TRADEMARK.md`, `package.json`
 *   - no test/, examples/, apps/, docs/, scripts/, .dev-team/ or secret files
 *   - a `types` entry that exists on disk
 *   - no `bin` entry (a demo binary must not land in a consumer's PATH)
 *
 * Run: `node scripts/check-pack.mjs` (or `pnpm run pack:check`).
 * Exit 1 when the tarball does not match the published surface.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Top-level paths the tarball is allowed to contain. */
const ALLOWED_TOPLEVEL = new Set(['lib', 'dist', 'skills', 'README.md', 'LICENSE', 'TRADEMARK.md', 'secret.env.example', 'package.json']);

/** @type {string[]} */
const violations = [];

/** @param {string} message */
function fail(message) {
    violations.push(message);
}

/** @type {{name?: string, version?: string, files?: Array<{path?: string}>}} */
let pack;
try {
    const raw = execFileSync(NPM, ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(raw);
    // npm <= 11 prints an array; npm >= 12 prints an object keyed by package name.
    pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
} catch (err) {
    process.stderr.write(`pack-check gate — npm pack failed: ${/** @type {any} */ (err)?.message ?? err}\n`);
    process.exit(1);
}

const entries = (pack?.files ?? []).map((f) => String(f.path ?? ''));

if (entries.length === 0) fail('the tarball is empty');

for (const path of entries) {
    const top = path.split('/')[0];
    if (!ALLOWED_TOPLEVEL.has(top)) fail(`unexpected tarball entry: ${path}`);
}

/** @type {string[]} */
const required = ['package.json', 'README.md', 'LICENSE', 'lib/index.mjs'];
for (const path of required) {
    if (!entries.includes(path)) fail(`the tarball is missing ${path}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * Every published subpath must declare a `types` condition that exists on
 * disk AND inside the tarball. A subpath whose declaration is missing or
 * dangling breaks exactly the consumers the package exists for.
 */
for (const [sub, value] of Object.entries(pkg.exports ?? {})) {
    const label = sub === '.' ? 'the package root' : `the "${sub}" subpath`;
    if (typeof value === 'string') {
        // A bare string is fine for a data export ("./package.json"); a module
        // export must declare its types.
        if (/\.(mjs|cjs|js|ts)$/.test(value)) fail(`${label} exports a bare string; it must declare a "types" condition`);
        continue;
    }
    const runtime = value?.import ?? value?.default;
    if (!runtime || !/\.(mjs|cjs|js|ts)$/.test(String(runtime))) continue;
    const types = value?.types;
    if (!types) {
        fail(`${label} has no "types" condition — TypeScript consumers get no declarations for it`);
        continue;
    }
    const rel = String(types).replace(/^\.\//, '');
    if (!existsSync(join(ROOT, String(types)))) {
        fail(`${label} points "types" at ${types}, which does not exist (run: pnpm run build:types)`);
        continue;
    }
    if (!entries.includes(rel)) {
        fail(`${label} declares ${types} but that file is not inside the tarball (check the "files" allowlist)`);
    }
}

if (!pkg.types) {
    fail('package.json has no "types" entry — TypeScript consumers get no declarations');
} else {
    const typesPath = join(ROOT, pkg.types);
    if (!existsSync(typesPath)) {
        fail(`package.json "types" points at ${pkg.types}, which does not exist (run: pnpm run build:types)`);
    } else if (!entries.includes(pkg.types.replace(/^\.\//, ''))) {
        fail(`the declaration entry ${pkg.types} is not inside the tarball (check the "files" allowlist)`);
    }
}

if (pkg.bin) {
    fail(`package.json declares a "bin" entry (${JSON.stringify(pkg.bin)}) — every consumer would install it`);
}

if (!pkg.repository) fail('package.json has no "repository" entry');
if (!pkg.license) fail('package.json has no "license" entry');
if (!pkg.engines?.node) fail('package.json has no "engines.node" entry');

if (violations.length > 0) {
    process.stderr.write(`pack-check gate — ${violations.length} problem(s):\n`);
    for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
    process.exit(1);
}

process.stdout.write(`pack-check gate — ${entries.length} files, ${pack?.unpackedSize ?? 0} bytes unpacked, published surface matches\n`);
