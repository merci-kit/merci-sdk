#!/usr/bin/env node
/**
 * @file Type-surface ratchet for the published declarations (`dist/types/**`).
 * @version 0.7.2
 *
 * The `any` surface is measured debt: 1941 occurrences across 103 of 122
 * declarations at the closeout baseline, and it grew in every wave that did not
 * watch it. Fixing it all at once is a multi-week programme; letting it keep
 * growing is how it got here. This gate makes the number monotone: every file
 * has a ceiling in `type-surface-budget.json`, a ceiling may only go down, and a
 * new file that introduces `any` fails.
 *
 * Why the declarations, not `lib/`: the declarations are what a consumer sees.
 * Why suppressions too: a ratchet that ignores `@ts-ignore` can be gamed by
 * hiding the count instead of typing the code (R7).
 *
 * Run: `node scripts/check-type-surface.mjs [--json] [--update]`
 * `--update` rewrites the budget from the current tree (manual, reviewed).
 *
 * Exit 1 when any file exceeds its ceiling, a new file carries `any`, the total
 * exceeds the recorded total, or a suppression directive appears.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DECL_ROOT = join(ROOT, 'dist', 'types');
const LIB_ROOT = join(ROOT, 'lib');
const BUDGET_FILE = join(HERE, 'type-surface-budget.json');
const SUPPRESSION_RE = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable/g;
const ANY_RE = /\bany\b/g;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const update = argv.includes('--update');

/** Recursively list files under `dir` whose name ends with `suffix`. @param {string} dir @param {string} suffix */
function listFiles({ dir, suffix }) {
    if (!existsSync(dir)) return [];
    /** @type {string[]} */
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listFiles({ dir: full, suffix }));
        else if (name.endsWith(suffix)) out.push(full);
    }
    return out;
}

/** Comments are prose, not types: counting them let a `// … any …` line offset a
 * real `any` (and inflated the baseline). Strip them before measuring.
 * @param {string} text */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** String literals are values, not types, for the same reason: `'any'` is a policy
 * value (`agents?: 'any' | Array<…>`) and a prompt may contain the word "any".
 * Stripping them keeps the ratchet measuring the type surface itself. Run after
 * comments (a comment's apostrophe would otherwise open a string).
 * @param {string} text */
const stripStringLiterals = (text) => text
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
/** @param {string} file */
const countAny = ({ file }) => (stripStringLiterals(stripComments(readFileSync(file, 'utf8'))).match(ANY_RE) ?? []).length;
/** @param {string} file */
const countSuppressions = ({ file }) => (readFileSync(file, 'utf8').match(SUPPRESSION_RE) ?? []).length;

if (!existsSync(DECL_ROOT)) {
    console.error('type-surface: dist/types is missing — run `pnpm run build:types` first.');
    process.exit(1);
}

/** @type {Record<string, number>} */
const measured = {};
/** @type {string[]} */
const declarationFiles = listFiles({ dir: DECL_ROOT, suffix: '.d.mts' }).sort();
for (const file of declarationFiles) {
    const key = relative(DECL_ROOT, file).split(sep).join('/');
    const n = countAny({ file });
    if (n > 0) measured[key] = n;
}
const total = Object.values(measured).reduce((a, b) => a + b, 0);
const suppressions = listFiles({ dir: LIB_ROOT, suffix: '.mjs' })
    .reduce((sum, file) => sum + countSuppressions({ file }), 0);

if (update) {
    const previous = existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) : { files: {} };
    // A ceiling may only go down: `--update` takes the lower of the two, so a
    // regeneration can never launder growth into the budget.
    /** @type {Record<string, number>} */
    const files = {};
    for (const key of new Set([...Object.keys(previous.files ?? {}), ...Object.keys(measured)])) {
        const before = previous.files?.[key] ?? 0;
        const now = measured[key] ?? 0;
        if (now === 0) continue;
        files[key] = before > 0 ? Math.min(before, now) : now;
    }
    const newTotal = Object.values(files).reduce((a, b) => a + b, 0);
    // A rename moves a file key; without this the total would absorb the growth
    // (the per-file min() only protects keys that still exist).
    if (typeof previous.total === 'number' && newTotal > previous.total) {
        console.error(`type-surface: refusing to raise the total (${previous.total} -> ${newTotal}). Fix the types; a rename is not a reduction.`);
        process.exit(1);
    }
    const budget = {
        generated: new Date().toISOString().slice(0, 10),
        note: 'A ceiling may only go down. Measured by scripts/check-type-surface.mjs on dist/types.',
        total: newTotal,
        suppressions: 0,
        files,
    };
    writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
    console.log(`type-surface: budget written — ${budget.total} any across ${Object.keys(files).length} file(s)`);
    process.exit(0);
}

if (!existsSync(BUDGET_FILE)) {
    console.error('type-surface: scripts/type-surface-budget.json is missing — run with --update and review the diff.');
    process.exit(1);
}
const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));

/** @type {Array<{file: string, kind: string, ceiling: number, actual: number}>} */
const violations = [];
for (const [key, actual] of Object.entries(measured)) {
    const ceiling = budget.files?.[key] ?? 0;
    if (actual > ceiling) violations.push({ file: key, kind: ceiling === 0 ? 'new file' : 'over ceiling', ceiling, actual });
}
for (const key of Object.keys(budget.files ?? {})) {
    if (measured[key] === undefined) violations.push({ file: key, kind: 'file gone (budget can be pruned with --update)', ceiling: budget.files[key], actual: 0 });
}
if (total > (budget.total ?? 0)) violations.push({ file: '(total)', kind: 'over total', ceiling: budget.total ?? 0, actual: total });
if (suppressions > (budget.suppressions ?? 0)) {
    violations.push({ file: '(suppressions in lib)', kind: 'type suppression added', ceiling: budget.suppressions ?? 0, actual: suppressions });
}

if (asJson) {
    console.log(JSON.stringify({ total, declarations: declarationFiles.length, files: measured, suppressions, violations }, null, 2));
    process.exit(violations.length === 0 ? 0 : 1);
}

if (violations.length > 0) {
    console.error(`type-surface gate — ${violations.length} violation(s): the \`any\` surface may only shrink.`);
    for (const v of violations) console.error(`  ${v.kind}: ${v.file} (ceiling ${v.ceiling}, actual ${v.actual})`);
    console.error('  fix the types, or narrow the claim; do not raise a ceiling.');
    process.exit(1);
}
console.log(`type-surface gate — ${total} any across ${Object.keys(measured).length} of ${declarationFiles.length} declarations (ceiling ${budget.total}); ${suppressions} suppression(s)`);
