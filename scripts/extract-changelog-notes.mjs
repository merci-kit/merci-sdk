#!/usr/bin/env node
// @ts-check

/**
 * @file Extract the CHANGELOG section of a version for the release notes.
 * @version 0.7.2
 *
 * @description
 * The release workflow publishes the CHANGELOG section of the released
 * version. The CHANGELOG follows **Keep a Changelog**, so a version heading
 * looks like `## [0.7.2] - 2026-01-01` or `## [0.7.2] - Unreleased` — a plain
 * `## 0.7.2` heading is accepted too.
 *
 * A missing file or a missing section is **not** an error: the release goes
 * out without notes and says so. A release must never die because the
 * changelog moved.
 *
 * Run: `node scripts/extract-changelog-notes.mjs <version> [out-file]`
 * With no out-file the notes are printed to stdout. Exit 0 always (except on
 * a usage error).
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

/**
 * Normalizes a heading title to the version it names.
 *
 * `[0.7.2] - Unreleased` → `0.7.2`; `0.7.2 - 2026-01-01` → `0.7.2`;
 * `v0.7.2` → `0.7.2`.
 *
 * @param {{ title: string }} arg0
 * @returns {string}
 */
export function normalizeVersionHeading({ title }) {
    return String(title ?? '')
        .replace(/^\[([^\]]*)\]/, '$1')
        .replace(/^\s*v(?=\d)/, '')
        .replace(/\s*[-–—]\s*[^]*$/, '')
        .trim();
}

/**
 * Extracts the section of the CHANGELOG that belongs to a version.
 *
 * @param {{ version: string, text?: string|null, path?: string }} arg0 -
 *   `version` is the version to find; `text` is the changelog source (read
 *   from `path` when omitted).
 * @returns {{ found: boolean, notes: string, reason: string }}
 */
export function extractChangelogSection({ version, text = null, path = CHANGELOG }) {
    const source = text ?? (existsSync(path) ? readFileSync(path, 'utf8') : null);
    if (source === null) {
        return { found: false, notes: 'CHANGELOG.md not found - this release carries no changelog notes.\n', reason: 'missing-file' };
    }
    const heading = /^(#{1,6})\s+(.*\S)\s*$/;
    const lines = source.split(/\r?\n/);
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const match = heading.exec(lines[i]);
        if (!match) continue;
        const title = normalizeVersionHeading({ title: match[2] });
        if (title === version || title === `v${version}`) {
            start = i;
            level = match[1].length;
            break;
        }
    }
    if (start === -1) {
        return { found: false, notes: `No CHANGELOG.md section found for v${version} - releasing without changelog notes.\n`, reason: 'missing-section' };
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const match = heading.exec(lines[i]);
        if (match && match[1].length <= level) {
            end = i;
            break;
        }
    }
    const body = lines.slice(start + 1, end).join('\n').trim();
    return { found: true, notes: body ? `${body}\n` : `The CHANGELOG.md section for v${version} is empty.\n`, reason: 'ok' };
}

function main() {
    const [version, out] = process.argv.slice(2);
    if (!version) {
        process.stderr.write('usage: extract-changelog-notes.mjs <version> [out-file]\n');
        process.exit(2);
    }
    const result = extractChangelogSection({ version });
    if (out) writeFileSync(out, result.notes);
    else process.stdout.write(result.notes);
    process.exit(0);
}

const entry = process.argv[1];
if (entry) {
    try {
        // Real paths on both sides: `import.meta.url` is canonical, `argv[1]` need not be.
        if (realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))) main();
    } catch {
        /* not the entry point — imported by a test */
    }
}
