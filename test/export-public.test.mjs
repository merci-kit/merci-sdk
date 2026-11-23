// @ts-check
/**
 * @file The public export is the data boundary between this workspace and
 * github.com/merci-kit/merci-sdk: one private path in the exported tree leaks
 * internal material. Builds throwaway repos and asserts the filter.
 * @version 0.23.0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'export-public.mjs');

const FILES = {
    'package.json': `${JSON.stringify({
        name: 'fixture',
        scripts: {
            greet: 'node apps/greet.mjs',
            'check:specs': 'node specs/verify.mjs',
            check: 'tsc --noEmit && pnpm run check:specs && pnpm test',
            test: 'node --test',
        },
    }, null, 2)}\n`,
    'lib/index.mjs': 'export const answer = 42;\n',
    'examples/01.mjs': 'console.log(1);\n',
    'docs/index.html': '<html></html>\n',
    'docs/back/index.html': '<html></html>\n',
    'docs/COMMERCIALIZATION.md': '# internal\n',
    'docs/.htaccess': 'deny\n',
    '.github/workflows/ci.yml': 'name: CI\n',
    '.github/workflows/release.yml': 'name: Release\n',
    '.dev-team/plan.md': '# internal\n',
    'apps/greet.mjs': 'export {};\n',
    'specs/verify.mjs': 'export {};\n',
    'AGENTS.md': '# internal\n',
    'visual_examples/serve.mjs': 'export {};\n',
};

const git = ({ cwd, args } = {}) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const makeRepo = ({ files = FILES } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-export-test-'));
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    git({ cwd: dir, args: ['init', '-q'] });
    git({ cwd: dir, args: ['config', 'user.email', 'test@example.com'] });
    git({ cwd: dir, args: ['config', 'user.name', 'test'] });
    git({ cwd: dir, args: ['add', '-A'] });
    git({ cwd: dir, args: ['commit', '-q', '-m', 'fixture'] });
    return dir;
};

test('export-public publishes only the curated paths and strips private scripts', () => {
    const dir = makeRepo();
    try {
        execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });

        const exported = git({ cwd: dir, args: ['ls-tree', '-r', '--name-only', 'public'] }).split('\n').filter(Boolean).sort();
        assert.deepEqual(exported, [
            '.github/workflows/ci.yml',
            'docs/index.html',
            'examples/01.mjs',
            'lib/index.mjs',
            'package.json',
        ]);

        const pkg = JSON.parse(git({ cwd: dir, args: ['show', 'public:package.json'] }));
        assert.deepEqual(Object.keys(pkg.scripts).sort(), ['check', 'test']);
        assert.equal(pkg.scripts.check, 'tsc --noEmit && pnpm test');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('export-public refuses when there is nothing private to filter', () => {
    const files = Object.fromEntries(Object.entries(FILES).filter(([path]) =>
        ['package.json', 'lib/index.mjs', 'examples/01.mjs'].includes(path)));
    const dir = makeRepo({ files });
    try {
        assert.throws(() => execFileSync(process.execPath, [SCRIPT], { cwd: dir, stdio: 'pipe' }));
        assert.equal(git({ cwd: dir, args: ['branch', '--list', 'public'] }), '');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
