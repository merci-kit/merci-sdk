// @ts-check

/**
 * Wave 3 — the release notes extraction.
 *
 * The release workflow publishes the CHANGELOG section of the released
 * version. The CHANGELOG follows **Keep a Changelog**, so the heading is
 * `## [0.7.2] - Unreleased` — a matcher that only knows `## 0.7.2` would ship
 * the placeholder instead of the notes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractChangelogSection, normalizeVersionHeading } from '../scripts/extract-changelog-notes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the heading of a Keep a Changelog section names the version', () => {
    assert.equal(normalizeVersionHeading({ title: '[0.7.2] - Unreleased' }), '0.7.2');
    assert.equal(normalizeVersionHeading({ title: '[0.7.2] - 2026-01-01' }), '0.7.2');
    assert.equal(normalizeVersionHeading({ title: '0.7.2 - 2026-01-01' }), '0.7.2');
    assert.equal(normalizeVersionHeading({ title: '0.7.2' }), '0.7.2');
    assert.equal(normalizeVersionHeading({ title: 'v0.7.2' }), '0.7.2');
    assert.equal(normalizeVersionHeading({ title: '[Unreleased]' }), 'Unreleased');
});

test('the repository CHANGELOG yields the notes of the current version', () => {
    const changelog = join(ROOT, 'CHANGELOG.md');
    assert.ok(existsSync(changelog), 'the changelog exists');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const result = extractChangelogSection({ version: pkg.version });
    assert.equal(result.found, true, `the ${pkg.version} section must be found (reason: ${result.reason})`);
    assert.ok(result.notes.length > 500, `the notes must not be a placeholder (${result.notes.length} chars)`);
    assert.equal(/releasing without changelog notes/.test(result.notes), false);
});

test('a plain heading is matched too', () => {
    const result = extractChangelogSection({
        version: '1.2.3',
        text: ['# Changelog', '', '## 1.2.3 - 2026-01-01', '', 'The notes.', '', '## 1.2.2', '', 'Older.', ''].join('\n')
    });
    assert.equal(result.found, true);
    assert.match(result.notes, /The notes\./);
    assert.equal(/Older\./.test(result.notes), false, 'the section ends at the next heading');
});

test('a Keep a Changelog heading is matched', () => {
    const result = extractChangelogSection({
        version: '1.2.3',
        text: ['# Changelog', '', '## [1.2.3] - 2026-01-01', '', 'The notes.', '', '## [1.2.2] - 2026-01-01', '', 'Older.', ''].join('\n')
    });
    assert.equal(result.found, true);
    assert.match(result.notes, /The notes\./);
});

test('a missing section is tolerated with a clear note', () => {
    const result = extractChangelogSection({ version: '9.9.9', text: '# Changelog\n\n## [1.2.3]\n\nNotes.\n' });
    assert.equal(result.found, false);
    assert.equal(result.reason, 'missing-section');
    assert.match(result.notes, /No CHANGELOG\.md section found for v9\.9\.9/);
});

test('a missing changelog file is tolerated with a clear note', () => {
    const result = extractChangelogSection({ version: '1.2.3', path: join(ROOT, 'does-not-exist.md') });
    assert.equal(result.found, false);
    assert.equal(result.reason, 'missing-file');
    assert.match(result.notes, /CHANGELOG\.md not found/);
});
