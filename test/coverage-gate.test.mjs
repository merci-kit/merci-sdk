// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCoverage, coverageRunArgs, missingRuntimeFiles, parseCoverageFiles, parseCoverageReport } from '../scripts/check-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** The node 25 report shape: padded table, trailing "uncovered lines" column. */
const NODE_25_REPORT = [
    'ℹ start counting coverage',
    'ℹ attach coverage data',
    'ℹ file                        | line % | branch % | funcs % | uncovered lines',
    'ℹ ----------------------------------------------------------------------------',
    'ℹ   index.mjs                 |  91.30 |    80.00 |    75.00 | 12-14 20',
    'ℹ   session.mjs               | 100.00 |   100.00 |   100.00 | ',
    'ℹ all files                   |  94.89 |    82.78 |    86.91 | ',
    'ℹ end of coverage report',
    ''
].join('\n');

/** The node 22 report shape: different padding, "start of coverage report". */
const NODE_22_REPORT = [
    'ℹ start of coverage report',
    'ℹ file                         | line % | branch % | funcs % | uncovered lines',
    'ℹ -----------------------------------------------------------------------------',
    'ℹ   index.mjs                  |  91.30 |    80.00 |    75.00 | 12-14',
    'ℹ all files                    |  94.89 |    82.78 |    86.91 | ',
    'ℹ end of coverage report',
    ''
].join('\n');

/** The compact form: no padding, no trailing column. */
const COMPACT_REPORT = 'all files|94.89|82.78|86.91\n';

/** Percentages without decimals. */
const INTEGER_REPORT = 'ℹ all files | 100 | 100 | 100 | \n';

/** A report whose only "all files" mention is a file name, not the summary row. */
const NO_SUMMARY_ROW = [
    'ℹ file                        | line % | branch % | funcs % | uncovered lines',
    'ℹ   all files.mjs             |  91.30 |    80.00 |    75.00 | 12-14',
    ''
].join('\n');

// ─── the parser ───

test('coverage gate: the parser reads the node 25 report shape', () => {
    const parsed = parseCoverageReport({ text: NODE_25_REPORT });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.line, 94.89);
    assert.equal(parsed.ok && parsed.branch, 82.78);
    assert.equal(parsed.ok && parsed.function, 86.91);
});

test('coverage gate: the parser reads the node 22 report shape', () => {
    const parsed = parseCoverageReport({ text: NODE_22_REPORT });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.line, 94.89);
    assert.equal(parsed.ok && parsed.branch, 82.78);
    assert.equal(parsed.ok && parsed.function, 86.91);
});

test('coverage gate: the parser reads the compact report shape', () => {
    const parsed = parseCoverageReport({ text: COMPACT_REPORT });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.line, 94.89);
    assert.equal(parsed.ok && parsed.branch, 82.78);
    assert.equal(parsed.ok && parsed.function, 86.91);
});

test('coverage gate: the parser reads percentages without decimals', () => {
    const parsed = parseCoverageReport({ text: INTEGER_REPORT });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.line, 100);
    assert.equal(parsed.ok && parsed.branch, 100);
    assert.equal(parsed.ok && parsed.function, 100);
});

test('coverage gate: a report without an "all files" row is unparseable, never 0%', () => {
    const parsed = parseCoverageReport({ text: NO_SUMMARY_ROW });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /unparseable/);
});

test('coverage gate: an empty report is unparseable, never 0%', () => {
    const parsed = parseCoverageReport({ text: '' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /unparseable/);
});

// ─── the comparison ───

test('coverage gate: a metric below its floor fails the gate', () => {
    const comparison = compareCoverage({
        measured: { line: 94.89, branch: 72.1, function: 86.91 },
        floors: { line: 90, branch: 75, function: 80 }
    });
    assert.equal(comparison.verdict, 'fail');
    assert.equal(comparison.ok, false);
    assert.equal(comparison.failures.length, 1);
    assert.equal(comparison.failures[0].metric, 'branch');
    assert.equal(comparison.failures[0].measured, 72.1);
    assert.equal(comparison.failures[0].floor, 75);
    assert.match(comparison.failures[0].detail, /below the floor/);
});

test('coverage gate: coverage at or above every floor passes the gate', () => {
    const comparison = compareCoverage({
        measured: { line: 94.89, branch: 82.78, function: 86.91 },
        floors: { line: 90, branch: 75, function: 80 }
    });
    assert.equal(comparison.verdict, 'pass');
    assert.equal(comparison.ok, true);
    assert.deepEqual(comparison.failures, []);
});

test('coverage gate: a metric exactly on its floor passes', () => {
    const comparison = compareCoverage({
        measured: { line: 90, branch: 75, function: 80 },
        floors: { line: 90, branch: 75, function: 80 }
    });
    assert.equal(comparison.verdict, 'pass');
});

test('coverage gate: an unmeasured metric fails the gate instead of passing silently', () => {
    const comparison = compareCoverage({
        measured: { line: 94.89 },
        floors: { line: 90, branch: 75, function: 80 }
    });
    assert.equal(comparison.verdict, 'fail');
    assert.equal(comparison.failures.length, 2);
    assert.match(comparison.failures[0].detail, /not measured/);
});

// ─── the shipped configuration ───

test('coverage gate: the shipped config carries a floor and a note for every metric', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'scripts', 'coverage.config.json'), 'utf8'));
    for (const metric of ['line', 'branch', 'function']) {
        assert.equal(typeof config.floors[metric], 'number', `the ${metric} floor must be a number`);
    }
    assert.equal(typeof config.note, 'string');
    assert.match(config.note, /ratchet/i);
});

test('coverage gate: the report rows are parsed into file paths, nested directories included', () => {
    const report = [
        'ℹ start of coverage report',
        'ℹ file                | line % | branch % | funcs % | uncovered lines',
        'ℹ lib                 |        |          |         | ',
        'ℹ  agentic            |        |          |         | ',
        'ℹ   browser           |        |          |         | ',
        'ℹ    component.mjs    |  96.30 |    81.25 |  100.00 | ',
        'ℹ   agentic-core.mjs  |  95.16 |    83.87 |   83.78 | ',
        'ℹ all files           |  95.00 |    80.00 |   90.00 | ',
        'ℹ end of coverage report',
    ].join('\n');
    assert.deepEqual(parseCoverageFiles({ text: report }), ['lib/agentic/browser/component.mjs', 'lib/agentic/agentic-core.mjs']);
});

test('coverage gate: a runtime file the report does not mention fails the gate', () => {
    // The hole this closes: node reports only the files the suite LOADED, so
    // deleting the only test that imports a module removes it from the report
    // and the percentage goes UP. A fixed denominator makes that a failure.
    const missing = missingRuntimeFiles({
        measured: ['lib/a.mjs', 'lib/b.mjs'],
        files: ['lib/a.mjs', 'lib/b.mjs', 'lib/webscrape/index.mjs'],
    });
    assert.deepEqual(missing, ['lib/webscrape/index.mjs']);
    assert.deepEqual(missingRuntimeFiles({ measured: ['lib/a.mjs'], files: ['lib/a.mjs'] }), []);
});

test('coverage gate: an empty report is every file missing, never a pass', () => {
    const measured = parseCoverageFiles({ text: 'ℹ file | line % | branch % | funcs %\nℹ all files | 100.00 | 100.00 | 100.00\n' });
    assert.deepEqual(measured, []);
    assert.deepEqual(missingRuntimeFiles({ measured, files: ['lib/a.mjs'] }), ['lib/a.mjs']);
});

test('coverage gate: the suite command does not fake a denominator with an include filter', () => {
    // `--test-coverage-include` filters the files the suite loaded; a run that
    // loads no runtime file then prints `all files | 100.00`, which passes.
    const args = coverageRunArgs();
    assert.ok(args.includes('--experimental-test-coverage'), 'the gate runs the suite instrumented');
    assert.ok(args.includes('test/*.test.mjs'), 'the gate runs the whole suite');
    assert.equal(args.some((a) => a.startsWith('--test-coverage-include=')), false, 'an include filter turns an empty report into 100%');
});
