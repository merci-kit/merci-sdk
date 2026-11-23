#!/usr/bin/env node
// @ts-check

/**
 * @file Builds the curated public branch (`public`) for
 * github.com/merci-kit/merci-sdk from a local revision. The public repo carries
 * the library, the examples and the docs; the tests and internal material stay
 * on disk.
 *
 *   - only the top-level entries in PUBLIC_PATHS are exported (fail-closed:
 *     a new internal directory is excluded until it is listed here)
 *   - inside `docs/`, markdown is published only when it is named in
 *     PUBLIC_DOCS, and EXCLUDED_PATHS is withheld
 *   - package.json loses the scripts that need private directories or the
 *     test suite; a leftover reference fails the export instead of shipping a
 *     broken script
 *
 * Run: `node scripts/export-public.mjs [--from <rev>] [--push]`
 * Without `--push` the commit only moves local `public`; `--push`
 * fast-forwards origin/main and is rejected if the remote moved.
 * @version 0.23.0
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const BRANCH = 'public';
const REMOTE = 'origin';
const REMOTE_PATTERN = /(^|[/:])merci-kit\/merci-sdk(\.git)?$/;

/** Top-level entries that are published. Everything else stays local. */
const PUBLIC_PATHS = new Set([
    '.github', '.gitignore', 'CHANGELOG.md', 'GUIDELINES.md', 'LICENSE', 'README.md',
    'STRUCTURE.md', 'TRADEMARK.md', 'docs', 'examples', 'lib', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts', 'secret.env.example',
    'skills', 'tsconfig.build.json', 'tsconfig.json', 'types',
]);

/** Markdown under `docs/` that is published. A new .md stays local until it is listed. */
const PUBLIC_DOCS = new Set([
    'AGENT_FILES.md', 'CONTRIBUTING.md', 'LIMITS.md', 'MIGRATION.md', 'OPERATOR_API.md',
    'ORCHESTRATION.md', 'PROVIDERS.md', 'README.md', 'SCHEDULER.md', 'SPAWNING.md',
    'WORKFLOW_POLICY.md', 'WORKSPACES.md',
]);

/** Internal paths inside a published entry. */
const EXCLUDED_PATHS = ['.github/workflows/release.yml', 'docs/back'];

/**
 * Scripts that need a private directory or the local test suite, so the public
 * package.json drops them (and any `&& pnpm ... <name>` chain that calls them).
 */
const PRIVATE_SCRIPTS = ['greet', 'quant', 'visual', 'check:specs', 'pretest', 'test', 'test:examples', 'check:coverage'];

/** Entries whose absence means `--from` pointed at the wrong tree. */
const REQUIRED_PATHS = ['lib', 'examples', 'package.json'];

/**
 * @param {{ text?: string }} [options]
 * @returns {string}
 */
const escapeRegExp = ({ text = '' } = {}) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ args?: string[], index?: string, input?: string }} [options]
 * @returns {string}
 */
const git = ({ args = [], index, input } = {}) =>
    execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
        input,
    });

/**
 * @param {{ args?: string[] }} [options]
 * @returns {string | null}
 */
const gitOrNull = ({ args = [] } = {}) => {
    try {
        return git({ args }).trim();
    } catch {
        return null;
    }
};

/**
 * @param {{ path?: string }} [options]
 * @returns {boolean}
 */
const isPublicDoc = ({ path = '' } = {}) => {
    const name = path.slice('docs/'.length);
    if (name === '.nojekyll') return true;
    if (name.endsWith('.md')) return PUBLIC_DOCS.has(name);
    return !name.split('/').pop()?.startsWith('.');
};

/**
 * @param {{ path?: string }} [options]
 * @returns {boolean}
 */
const isPublic = ({ path = '' } = {}) =>
    PUBLIC_PATHS.has(path.split('/')[0]) &&
    !EXCLUDED_PATHS.some((excluded) => path === excluded || path.startsWith(`${excluded}/`)) &&
    (path === 'docs' || !path.startsWith('docs/') || isPublicDoc({ path }));

/**
 * @param {{ source?: string }} [options]
 * @returns {string}
 */
const stripPrivateScripts = ({ source = '' } = {}) => {
    const pkg = JSON.parse(source);
    for (const name of PRIVATE_SCRIPTS) delete pkg.scripts[name];
    for (const name of PRIVATE_SCRIPTS) {
        const escaped = escapeRegExp({ text: name });
        for (const key of Object.keys(pkg.scripts)) {
            pkg.scripts[key] = pkg.scripts[key]
                .split(` && pnpm run ${name}`).join('')
                .replace(new RegExp(`\\s*&&\\s*pnpm ${escaped}\\b`, 'g'), '');
        }
    }
    const leaks = Object.entries(pkg.scripts)
        .filter(([, command]) =>
            /(^|[\s"'=])(apps|specs|visual_examples|test)\//.test(command) ||
            PRIVATE_SCRIPTS.some((name) => new RegExp(`\\bpnpm (?:run )?${escapeRegExp({ text: name })}\\b`).test(command)));
    if (leaks.length) {
        throw new Error(`public package.json still calls a private script or path: ${leaks.map(([key]) => key).join(', ')}`);
    }
    return `${JSON.stringify(pkg, null, 2)}\n`;
};

/**
 * @param {{ argv?: string[] }} [options]
 * @returns {void}
 */
const main = ({ argv = process.argv.slice(2) } = {}) => {
    if (argv.includes('--help')) {
        console.log('node scripts/export-public.mjs [--from <rev>] [--push]');
        return;
    }
    const fromIndex = argv.indexOf('--from');
    const source = fromIndex === -1 ? 'HEAD' : argv[fromIndex + 1];
    if (!source || source.startsWith('--')) throw new Error('--from needs a revision');
    const push = argv.includes('--push');
    if (push) {
        const url = git({ args: ['remote', 'get-url', REMOTE] }).trim();
        if (!REMOTE_PATTERN.test(url)) throw new Error(`${REMOTE} is ${url}, not merci-kit/merci-sdk; refusing to push`);
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'merci-public-'));
    const index = join(tempDir, 'index');
    try {
        git({ args: ['read-tree', source], index });
        const tracked = git({ args: ['ls-files', '-z'], index }).split('\0').filter(Boolean);
        const tops = new Set(tracked.map((path) => path.split('/')[0]));
        const missing = REQUIRED_PATHS.filter((path) => !tops.has(path));
        if (missing.length) throw new Error(`${source} does not look like the workspace root (missing ${missing.join(', ')})`);

        const withheld = tracked.filter((path) => !isPublic({ path }));
        if (!withheld.length) throw new Error('every tracked path is public; refusing to export the public repo onto itself');
        const removals = withheld.map((path) => `0 ${'0'.repeat(40)}\t${path}\n`).join('');
        git({ args: ['update-index', '--index-info'], index, input: removals });

        const transformed = stripPrivateScripts({ source: git({ args: ['show', ':package.json'], index }) });
        const blob = git({ args: ['hash-object', '-w', '--stdin'], input: transformed }).trim();
        git({ args: ['update-index', '--cacheinfo', `100644,${blob},package.json`], index });

        const tree = git({ args: ['write-tree'], index }).trim();
        const parent = gitOrNull({ args: ['rev-parse', '--verify', '--quiet', `${REMOTE}/main`] });
        const parentTree = parent === null ? null : git({ args: ['rev-parse', `${parent}^{tree}`] }).trim();
        const unchanged = parentTree === tree;
        if (parent !== null && !unchanged) {
            console.log(git({ args: ['diff', '--stat', parent, tree] }).trimEnd());
        }

        let commit = parent;
        if (!unchanged) {
            const sha = git({ args: ['rev-parse', '--short', source] }).trim();
            const subject = git({ args: ['log', '-1', '--format=%s', source] }).trim();
            const parentArgs = parent === null ? [] : ['-p', parent];
            commit = git({
                args: ['commit-tree', tree, ...parentArgs, '-m', `chore(public): export ${sha} ${subject}`],
            }).trim();
        }
        if (commit === null) throw new Error('export produced no commit');
        git({ args: ['update-ref', `refs/heads/${BRANCH}`, commit] });
        console.log(`${BRANCH} = ${commit.slice(0, 8)}: ${unchanged ? 'already in sync' : 'content changed'}, ${tracked.length - withheld.length} files exported, ${withheld.length} internal paths withheld`);

        if (push) execFileSync('git', ['push', REMOTE, `${BRANCH}:main`], { cwd: ROOT, stdio: 'inherit' });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
};

try {
    main();
} catch (error) {
    console.error(`export-public: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
