#!/usr/bin/env node
// @ts-check


/**
 * @file Coverage ratchet gate.
 * @version 0.7.2
 *
 * @description
 * Runs the instrumented test suite and fails the build when coverage drops
 * below the floors recorded in `scripts/coverage.config.json`.
 *
 * The floors are a ratchet: coverage may never fall below them. Two guards:
 *
 *   - a FIXED DENOMINATOR — the gate refuses to pass when the report does not
 *     mention every `lib/**\/*.mjs` file. Node reports only the files the suite
 *     loaded, so deleting the only test that imports a module used to remove it
 *     from the report and RAISE the percentage. (`--test-coverage-include` does
 *     not fix that: it filters the loaded files, so a run with no runtime file
 *     loaded prints an empty table as `all files | 100.00` — a vacuous pass.)
 *   - the percentage floors, about four points under the measured baseline
 *     (line 94.71 / branch 83.97 / function 87.98 on node 25) so the node 22 /
 *     24 / 25 CI matrix stays stable.
 *
 * The gate never masks a broken build:
 *   - a red suite fails the gate ("the suite failed"),
 *   - a coverage report it cannot parse fails the gate ("unparseable") —
 *     it never reports "0% coverage, still fine".
 *
 * Run: `node scripts/check-coverage.mjs [--json]`
 * Exit 1 when a metric is below its floor, when the suite fails or when the
 * coverage report cannot be parsed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONFIG_FILE = join(HERE, 'coverage.config.json');

/** The published runtime the gate measures. */
export const RUNTIME_DIR = 'lib';

/**
 * The exact argv the gate runs. Exported so a test can assert the suite
 * command survives a future edit.
 *
 * Note: `--test-coverage-include` is NOT used. Node reports it as a filter over
 * the files the suite loaded, so a run that loads no runtime file prints an
 * empty table as `all files | 100.00` — a vacuous pass. The fixed denominator
 * is enforced after the run instead (`missingRuntimeFiles`).
 * @returns {string[]}
 */
export function coverageRunArgs() {
    return ['--test', '--experimental-test-coverage', 'test/*.test.mjs'];
}

/**
 * Every runtime file the report measured. Node prints a hierarchical table
 * (directory headers, then basenames indented under them), so a row's path is
 * the headers above it joined with the basename.
 * @param {{ text?: string }} [arg0]
 * @returns {string[]}
 */
export function parseCoverageFiles({ text = '' } = {}) {
    const lines = String(text).split('\n');
    const start = lines.findIndex((l) => /start of coverage report/i.test(l));
    if (start === -1) return [];
    /** @type {Array<{ indent: number, name: string }>} */
    const stack = [];
    /** @type {string[]} */
    const files = [];
    for (const raw of lines.slice(start + 1)) {
        if (/end of coverage report/i.test(raw)) break;
        // A row is `ℹ` + spaces + name + `|` + metrics. The spaces encode the
        // directory depth; a directory row has empty metrics.
        const m = /^\u2139(\s*)(.*?)\s*\|/.exec(raw);
        if (!m) continue;
        const name = m[2].trim();
        if (!name || name === 'file' || name === 'all files') continue;
        while (stack.length > 0 && stack[stack.length - 1].indent >= m[1].length) stack.pop();
        stack.push({ indent: m[1].length, name });
        if (name.endsWith('.mjs')) files.push(stack.map((s) => s.name).join('/'));
    }
    return files;
}

/**
 * Runtime files the report does not mention. Node reports only the files the
 * suite *loaded*: without this check, deleting the only test that imports a
 * module silently removes it from the denominator and the percentage RISES.
 * @param {{ measured: string[], files: string[] }} arg0
 * @returns {string[]}
 */
export function missingRuntimeFiles({ measured, files }) {
    const seen = new Set(measured);
    return files.filter((f) => !seen.has(f));
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/** @type {Array<'line' | 'branch' | 'function'>} */
const METRICS = ['line', 'branch', 'function'];

/**
 * The "all files" row of a node coverage report.
 *
 * Tolerates the padded table form (node 22 / 24 / 25), the compact form, a
 * missing symbol prefix and an optional trailing "uncovered lines" column.
 * The prefix may not contain a pipe, so a file called "all files.mjs" can
 * never be mistaken for the summary row.
 */
const ALL_FILES_ROW = /^[^\n|]*?\ball files\b[^\S\r\n]*\|[^\S\r\n]*(\d+(?:\.\d+)?)[^\S\r\n]*\|[^\S\r\n]*(\d+(?:\.\d+)?)[^\S\r\n]*\|[^\S\r\n]*(\d+(?:\.\d+)?)[^\S\r\n]*(?:\|[^\n]*)?$/gim;

/**
 * @typedef {{ ok: true, line: number, branch: number, function: number }} ParsedCoverage
 * @typedef {{ ok: false, reason: string }} UnparsedCoverage
 * @typedef {ParsedCoverage | UnparsedCoverage} CoverageParseResult
 * @typedef {{ metric: string, measured: number | null, floor: number | null, detail: string }} CoverageFailure
 * @typedef {{ exitCode: number | null, tests: number | null, pass: number | null, fail: number | null }} SuiteSummary
 * @typedef {{ verdict: 'pass' | 'fail', error?: string, measured?: Record<string, number>, floors?: Record<string, number>, failures: CoverageFailure[], suite: SuiteSummary, note: string }} GateResult
 */

/**
 * Extracts the "all files" percentages from a node coverage report.
 *
 * @param {{ text?: string }} [arg0]
 * @returns {CoverageParseResult}
 */
export function parseCoverageReport({ text = '' } = {}) {
    // The summary row is the footer of the coverage table, so the LAST match
    // is the real one - a stray "all files |" line printed by a test cannot
    // win over it.
    const matches = [...String(text).matchAll(ALL_FILES_ROW)];
    const match = matches[matches.length - 1];
    if (!match) {
        return {
            ok: false,
            reason: 'unparseable coverage report — no "all files" row found (the report format changed or --experimental-test-coverage was not applied)'
        };
    }
    return { ok: true, line: Number(match[1]), branch: Number(match[2]), function: Number(match[3]) };
}

/**
 * Compares the measured coverage against the floors.
 *
 * @param {{ measured?: Record<string, number | undefined>, floors?: Record<string, number | undefined> }} [arg0]
 * @returns {{ ok: boolean, verdict: 'pass' | 'fail', failures: CoverageFailure[] }}
 */
export function compareCoverage({ measured = {}, floors = {} } = {}) {
    /** @type {CoverageFailure[]} */
    const failures = [];
    for (const metric of METRICS) {
        const value = measured[metric];
        const floor = floors[metric];
        if (typeof value !== 'number' || Number.isNaN(value)) {
            failures.push({ metric, measured: null, floor: typeof floor === 'number' ? floor : null, detail: 'not measured' });
            continue;
        }
        if (typeof floor !== 'number' || Number.isNaN(floor)) {
            failures.push({ metric, measured: value, floor: null, detail: 'no floor configured' });
            continue;
        }
        if (value < floor) {
            failures.push({ metric, measured: value, floor, detail: 'below the floor' });
        }
    }
    return { ok: failures.length === 0, verdict: failures.length === 0 ? 'pass' : 'fail', failures };
}

/**
 * Reads the floors from `scripts/coverage.config.json`.
 *
 * @returns {{ floors: Record<string, number>, note: string } | { error: string }}
 */
function loadConfig() {
    const label = relative(ROOT, CONFIG_FILE);
    if (!existsSync(CONFIG_FILE)) return { error: `missing ${label}` };
    /** @type {any} */
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (error) {
        return { error: `cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const floors = parsed?.floors;
    if (!floors || typeof floors !== 'object') return { error: `${label} has no "floors" object` };
    /** @type {Record<string, number>} */
    const numbers = {};
    for (const metric of METRICS) {
        const value = floors[metric];
        if (typeof value !== 'number' || Number.isNaN(value)) return { error: `${label} has no numeric floor for "${metric}"` };
        numbers[metric] = value;
    }
    return { floors: numbers, note: typeof parsed?.note === 'string' ? parsed.note : '' };
}

/**
 * @param {{ text: string, pattern: RegExp }} arg0
 * @returns {number | null}
 */
function firstCount({ text, pattern }) {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : null;
}

/**
 * @param {string} text
 * @returns {SuiteSummary}
 */
function summarizeSuite(text) {
    return {
        exitCode: null,
        tests: firstCount({ text, pattern: /^[^A-Za-z]*tests\s+(\d+)\s*$/m }),
        pass: firstCount({ text, pattern: /^[^A-Za-z]*pass\s+(\d+)\s*$/m }),
        fail: firstCount({ text, pattern: /^[^A-Za-z]*fail\s+(\d+)\s*$/m })
    };
}

/**
 * Prints the gate report and returns the process exit code.
 *
 * @param {GateResult} result
 * @returns {number}
 */
function emit(result) {
    if (asJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (result.error) {
        process.stdout.write(`coverage gate — ${result.error}\n`);
    } else {
        const measured = result.measured ?? {};
        const floors = result.floors ?? {};
        const cells = METRICS.map((m) => `${m} ${String(measured[m])}% (floor ${String(floors[m])})`).join(', ');
        process.stdout.write(`coverage gate — ${cells} — ${result.verdict.toUpperCase()}\n`);
        for (const failure of result.failures) {
            process.stdout.write(`  [${failure.metric}] measured ${String(failure.measured)}% — ${failure.detail}${failure.floor === null ? '' : ` (floor ${failure.floor}%)`}\n`);
        }
    }
    return result.verdict === 'pass' ? 0 : 1;
}

function main() {
    const config = loadConfig();
    if ('error' in config) {
        process.exit(emit({ verdict: 'fail', error: config.error, failures: [], suite: { exitCode: null, tests: null, pass: null, fail: null }, note: '' }));
    }

    const run = spawnSync(process.execPath, coverageRunArgs(), {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 28
    });

    const stdout = String(run.stdout ?? '');
    const stderr = String(run.stderr ?? '');
    const suite = summarizeSuite(stdout);
    suite.exitCode = run.status ?? null;

    if (run.error) {
        process.exit(emit({
            verdict: 'fail',
            error: `the suite could not be run — ${run.error.message}`,
            failures: [],
            suite,
            note: config.note
        }));
    }

    if (run.status !== 0) {
        const failing = suite.fail === null ? '' : `, ${suite.fail} failing test(s)`;
        process.stderr.write(stdout.split('\n').slice(-40).join('\n') + '\n');
        process.exit(emit({
            verdict: 'fail',
            error: `the suite failed (exit ${run.status}${failing}) — coverage is not measured, and a coverage gate must never mask a red suite`,
            failures: [],
            suite,
            note: config.note
        }));
    }

    let parsed = parseCoverageReport({ text: stdout });
    if (!parsed.ok) parsed = parseCoverageReport({ text: stderr });
    if (!parsed.ok) {
        process.exit(emit({
            verdict: 'fail',
            error: parsed.reason,
            failures: [],
            suite,
            note: config.note
        }));
    }

    // Fixed denominator: node reports only the files the suite loaded, so a
    // module whose last test was deleted would vanish from the report and the
    // percentage would go UP. Every runtime file must be measured.
    const reported = parseCoverageFiles({ text: stdout });
    const measuredFiles = reported.length > 0 ? reported : parseCoverageFiles({ text: stderr });
    const missing = missingRuntimeFiles({ measured: measuredFiles, files: listRuntimeFiles() });
    if (missing.length > 0) {
        process.exit(emit({
            verdict: 'fail',
            error: `the suite did not load ${missing.length} runtime file(s) — a module with no test would raise the percentage by disappearing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
            failures: [],
            suite,
            note: config.note,
        }));
    }

    const measured = { line: parsed.line, branch: parsed.branch, function: parsed.function };
    const comparison = compareCoverage({ measured, floors: config.floors });
    process.exit(emit({
        verdict: comparison.verdict,
        measured,
        floors: config.floors,
        failures: comparison.failures,
        suite,
        note: config.note
    }));
}

/**
 * Every runtime file on disk, relative to the project root.
 * @returns {string[]}
 */
export function listRuntimeFiles() {
    return readdirSync(join(ROOT, RUNTIME_DIR), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
        // `readdirSync` with `recursive` reports paths relative to the root, so
        // rebuild them from the parentPath the dirent carries.
        .map((e) => `${String(e.parentPath).split(sep).join('/')}/${e.name}`)
        .map((p) => p.slice(p.indexOf(`${RUNTIME_DIR}/`)))
        .sort();
}

/** True when this module is the process entry point (not imported by a test). */
function isEntryPoint() {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntryPoint()) main();
