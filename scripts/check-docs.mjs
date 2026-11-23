#!/usr/bin/env node


/**
 * @file Docs consistency gate.
 * @version 0.7.2
 *
 * Network-free, deterministic checks over `docs/**` (the unlinked `docs/back/`
 * archive is skipped):
 *   D1 example references — every `examples/<file>.mjs` cited in docs exists.
 *   D2 example inventory — every `examples/*.mjs` is listed in examples/README.md.
 *   D3 version parity — no doc cites a version other than package.json's.
 *   D4 lesson-count parity — a "N lessons/tutorials" claim matches docs/lessons/.
 *   D5 no hardcoded test count — a stale "N passing tests" outside the badge is drift.
 *   D6 (with --with-tests) the docs/README badge count equals the suite total.
 *   D7 event-count parity — an "N-event(s)" / "N typed events" / "N events" claim,
 *      in the root README or any doc, equals the leaf count of the EVENTS registry
 *      (HTML comments are masked: a lesson label is not a claim).
 *   D8 limit-count parity — an "N bounded numbers" claim equals the limit registry
 *      size reported by `lib/core/constants/limits.mjs`.
 *   D9 model-agnostic quickstart — the root README's quickstart (the block every
 *      npm visitor reads) resolves the model with `getDefaultModel()` and never
 *      passes a model literal to `client.session()`, so it cannot drift stale.
 *
 * Run: `node scripts/check-docs.mjs [--with-tests] [--json]`
 * Exit 1 when any violation remains.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EVENTS } from '../lib/core/events.mjs';
import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOCS = join(ROOT, 'docs');
const EXAMPLES = join(ROOT, 'examples');
const SKIP_DIRS = new Set(['back']);
const DOC_EXT = new Set(['.md', '.html']);

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const withTests = argv.includes('--with-tests');

const toPosix = (p) => p.split(sep).join('/');
const relRoot = (abs) => toPosix(relative(ROOT, abs));

/** @param {{ dir: string, out?: string[] }} [arg0] */
function walkDocs({ dir, out = [] } = {}) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
            if (!SKIP_DIRS.has(name)) walkDocs({ dir: abs, out });
        } else if (DOC_EXT.has(extname(name))) out.push(abs);
    }
    return out;
}

/** @param {{ text: string, index: number }} arg0 */
function lineAt({ text, index } = {}) {
    let line = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
}

/** @param {{ violations: Array<{rule: string, file: string, line: number, detail: string}>, rule: string, file: string, text: string, index: number, detail: string }} arg0 */
function push({ violations, rule, file, text, index, detail } = {}) {
    violations.push({ rule, file: relRoot(file), line: lineAt({ text, index }), detail });
}

/**
 * Collects every distinct string leaf of a nested object/array registry.
 * @param {{ value: unknown, out: Set<string> }} arg0
 */
function collectStrings({ value, out } = {}) {
    if (typeof value === 'string') { out.add(value); return; }
    if (value && typeof value === 'object') for (const child of Object.values(value)) collectStrings({ value: child, out });
}

function main() {
    /** @type {Array<{rule: string, file: string, line: number, detail: string}>} */
    const violations = [];
    const files = walkDocs({ dir: DOCS });
    const texts = files.map((abs) => ({ abs, text: readFileSync(abs, 'utf8') }));

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const version = String(pkg.version);

    // D1 — example references resolve. A `test/examples/…` path is an audit,
    // not a showcase: it is checked by the test runner, not by this inventory.
    const EXAMPLE_REF = /(?<!test\/)examples\/[0-9A-Za-z_./-]+\.mjs/g;
    for (const { abs, text } of texts) {
        for (const m of text.matchAll(EXAMPLE_REF)) {
            if (!existsSync(join(ROOT, m[0]))) push({ violations, rule: 'D1', file: abs, text, index: m.index ?? 0, detail: `missing example: ${m[0]}` });
        }
    }

    // D2 — example inventory parity with examples/README.md.
    const readme = readFileSync(join(EXAMPLES, 'README.md'), 'utf8');
    for (const name of readdirSync(EXAMPLES)) {
        if (!name.endsWith('.mjs')) continue;
        if (!readme.includes(name)) push({ violations, rule: 'D2', file: join(EXAMPLES, 'README.md'), text: readme, index: 0, detail: `examples/${name} is not listed` });
    }

    // D3 — version parity (skip dotted numbers like 127.0.0.1). A migration
    // guide cites the historical versions by definition, so it is exempt: the
    // rule exists to catch a doc that claims to describe the CURRENT release.
    const VERSION = /(?<![\d.])0\.\d+\.\d+(?![\d.])/g;
    const VERSION_EXEMPT = new Set(['docs/MIGRATION.md']);
    for (const { abs, text } of texts) {
        if (VERSION_EXEMPT.has(relRoot(abs))) {
            // The exemption covers the HISTORICAL versions a migration guide
            // cites; the guide must still name the CURRENT one, or it drifts
            // out of the release it documents.
            if (!text.includes(version)) {
                push({ violations, rule: 'D3', file: abs, text, index: 0, detail: `the migration guide does not mention the current version ${version}` });
            }
            continue;
        }
        for (const m of text.matchAll(VERSION)) {
            if (m[0] !== version) push({ violations, rule: 'D3', file: abs, text, index: m.index ?? 0, detail: `version ${m[0]} != package.json ${version}` });
        }
    }

    // D4 — lesson-count parity.
    const lessonCount = existsSync(join(DOCS, 'lessons'))
        ? readdirSync(join(DOCS, 'lessons')).filter((f) => /^lesson_\d+\.html$/.test(f)).length
        : 0;
    const COUNT_CLAIM = /(\d+)\s+(?:Tutorials|tutorials|lessons|Lessons)/g;
    // ...and the nav/cta form, which reads "Tutorials (42)".
    const PAREN_CLAIM = /(?:Tutorials|tutorials|Lessons|lessons)\s*\((\d+)\)/g;
    // The root README makes the same claim, so it is scanned here too.
    const lessonClaimTexts = existsSync(join(ROOT, 'README.md'))
        ? [{ abs: join(ROOT, 'README.md'), text: readFileSync(join(ROOT, 'README.md'), 'utf8') }, ...texts]
        : texts;
    for (const { abs, text } of lessonClaimTexts) {
        for (const m of text.matchAll(COUNT_CLAIM)) {
            if (Number(m[1]) !== lessonCount) push({ violations, rule: 'D4', file: abs, text, index: m.index ?? 0, detail: `${m[1]} lessons claimed, ${lessonCount} exist` });
        }
        for (const m of text.matchAll(PAREN_CLAIM)) {
            if (Number(m[1]) !== lessonCount) push({ violations, rule: 'D4', file: abs, text, index: m.index ?? 0, detail: `nav claims Tutorials (${m[1]}), ${lessonCount} exist` });
        }
    }

    // D9 — example-count and range parity. "N examples" and an
    // `examples/ (01–NN)` range describe the numbered examples, not the file
    // count: two numbers ship a client/server pair.
    const exampleNumbers = existsSync(EXAMPLES)
        ? readdirSync(EXAMPLES).filter((f) => /^\d{2}_.+\.mjs$/.test(f)).map((f) => Number(f.slice(0, 2)))
        : [];
    const exampleCount = new Set(exampleNumbers).size;
    const exampleMax = exampleNumbers.length ? Math.max(...exampleNumbers) : 0;
    const exampleClaimTexts = existsSync(join(ROOT, 'README.md'))
        ? [{ abs: join(ROOT, 'README.md'), text: readFileSync(join(ROOT, 'README.md'), 'utf8') }, ...texts]
        : texts;
    const EXAMPLE_COUNT_CLAIM = /(\d+)\s+examples\b/gi;
    const EXAMPLE_RANGE_CLAIM = /examples\/?\s*\(0\d\s*[–-]\s*(\d{2})\)/g;
    for (const { abs, text } of exampleClaimTexts) {
        for (const m of text.matchAll(EXAMPLE_COUNT_CLAIM)) {
            if (Number(m[1]) !== exampleCount) push({ violations, rule: 'D9', file: abs, text, index: m.index ?? 0, detail: `${m[1]} examples claimed, ${exampleCount} numbered examples exist` });
        }
        for (const m of text.matchAll(EXAMPLE_RANGE_CLAIM)) {
            if (Number(m[1]) !== exampleMax) push({ violations, rule: 'D9', file: abs, text, index: m.index ?? 0, detail: `the examples range ends at ${m[1]}, the last is ${exampleMax}` });
        }
    }
    // ...and the tutorials page is the only index a reader has, so every
    // example file must appear on it (34 files behind 32 numbers).
    const tutorialsAbs = join(DOCS, 'tutorials.html');
    if (existsSync(tutorialsAbs) && existsSync(EXAMPLES)) {
        const tutorialsText = readFileSync(tutorialsAbs, 'utf8');
        const exampleFiles = readdirSync(EXAMPLES).filter((f) => /^\d{2}_.+\.mjs$/.test(f)).sort();
        for (const name of exampleFiles) {
            if (!tutorialsText.includes(name)) push({ violations, rule: 'D9', file: tutorialsAbs, text: tutorialsText, index: 0, detail: `examples/${name} is not indexed on the tutorials page` });
        }
    }

    // D5 — no hardcoded stale test count (the README badge is checked by D6).
    const HARD_COUNT = /(\d[\d,]*)\s+passing tests/g;
    for (const { abs, text } of texts) {
        for (const m of text.matchAll(HARD_COUNT)) push({ violations, rule: 'D5', file: abs, text, index: m.index ?? 0, detail: `hardcoded test count "${m[0]}"` });
    }

    // D6 — the test-count badge (opt-in; runs the suite).
    let testSummary = null;
    if (withTests) {
        const run = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
        const m = String(run.stdout).match(/tests\s+(\d+)/);
        const actual = m ? Number(m[1]) : null;
        const docsReadmeAbs = join(DOCS, 'README.md');
        const docsReadmeText = readFileSync(docsReadmeAbs, 'utf8');
        const badge = docsReadmeText.match(/badge\/tests-(\d+)/);
        const claimed = badge ? Number(badge[1]) : null;
        testSummary = { actual, claimed, exitCode: run.status };
        if (actual === null) push({ violations, rule: 'D6', file: docsReadmeAbs, text: docsReadmeText, index: 0, detail: 'could not read the test count from the suite' });
        else if (claimed === null) push({ violations, rule: 'D6', file: docsReadmeAbs, text: docsReadmeText, index: 0, detail: 'docs/README.md has no numeric test badge' });
        else if (claimed !== actual) push({ violations, rule: 'D6', file: docsReadmeAbs, text: docsReadmeText, index: 0, detail: `badge says ${claimed} tests, suite ran ${actual}` });
        // The badge matching the count is not enough: a suite that ran the right
        // number of tests but failed some of them must fail this gate too.
        if (run.status !== 0) {
            const failed = String(run.stdout).match(/fail\s+(\d+)/);
            push({ violations, rule: 'D6', file: docsReadmeAbs, text: docsReadmeText, index: 0, detail: `the suite exited ${run.status}${failed ? ` (${failed[1]} failing)` : ''} — a docs gate is not a substitute for a green suite` });
        }
    }

    // D7 — the prose event-count claim equals the EVENTS registry. The root
    // README is prose too, so it is scanned here even though the rules above
    // only walk docs/.
    const eventNames = new Set();
    collectStrings({ value: EVENTS, out: eventNames });
    const eventCount = eventNames.size;
    const readmeAbs = join(ROOT, 'README.md');
    const claimTexts = existsSync(readmeAbs)
        ? [{ abs: readmeAbs, text: readFileSync(readmeAbs, 'utf8') }, ...texts]
        : texts;
    const EVENT_CLAIM = /(\d[\d,]*)(?:-|\s+(?:typed\s+)?)events?\b/gi;
    for (const { abs, text } of claimTexts) {
        // A number inside an HTML comment is a label, not a prose claim (the
        // lesson pages carry `<!-- 28 Events -->`). Mask the comments with
        // spaces so a reported line index still points at the right line.
        const prose = text.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
        for (const m of prose.matchAll(EVENT_CLAIM)) {
            if (Number(m[1].replace(/,/g, '')) !== eventCount) {
                push({ violations, rule: 'D7', file: abs, text, index: m.index ?? 0, detail: `claims ${m[1]} events; the registry has ${eventCount}` });
            }
        }
    }

    // D8 — the "ships N bounded numbers" claim equals the registry, so adding a
    // limit without updating the doc cannot slip through.
    const limitCount = Object.keys(LIMIT_REGISTRY).length;
    const LIMIT_CLAIM = /(\d[\d,]*)\s+bounded numbers/g;
    for (const { abs, text } of texts) {
        for (const m of text.matchAll(LIMIT_CLAIM)) {
            if (Number(m[1].replace(/,/g, '')) !== limitCount) {
                push({ violations, rule: 'D8', file: abs, text, index: m.index ?? 0, detail: `claims ${m[1]} bounded numbers; the registry has ${limitCount}` });
            }
        }
    }

    // D9 — the root README quickstart derives the model from the provider. A
    // literal there is the one snippet every npm visitor reads: it drifts (a
    // stale model id) and it contradicts the provider-agnostic API.
    const rootReadme = join(ROOT, 'README.md');
    if (existsSync(rootReadme)) {
        const readmeText = readFileSync(rootReadme, 'utf8');
        const quickstartAt = Math.max(0, readmeText.indexOf('## Quickstart'));
        const section = readmeText.slice(quickstartAt + '## Quickstart'.length).split(/^## /m)[0];
        const code = [...section.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
        if (!code.includes('getDefaultModel(')) {
            push({ violations, rule: 'D9', file: rootReadme, text: readmeText, index: quickstartAt, detail: 'the quickstart does not resolve the model with getDefaultModel()' });
        }
        for (const m of code.matchAll(/\.session\(\s*['"][^'"]+['"]\s*\)/g)) {
            push({ violations, rule: 'D9', file: rootReadme, text: readmeText, index: quickstartAt, detail: `the quickstart hardcodes a model: ${m[0].replace(/\s+/g, ' ')}` });
        }
    }

    const counts = violations.reduce((acc, v) => { acc[v.rule] = (acc[v.rule] || 0) + 1; return acc; }, {});
    if (asJson) {
        process.stdout.write(JSON.stringify({ files: files.length, lessonCount, version, testSummary, counts, total: violations.length, violations }, null, 2) + '\n');
    } else {
        process.stdout.write(`docs gate — ${files.length} file(s), ${violations.length} violation(s)${Object.keys(counts).length ? ' ' + JSON.stringify(counts) : ''}${testSummary ? ` [tests claimed=${testSummary.claimed} actual=${testSummary.actual}]` : ''}\n`);
        for (const v of violations.slice(0, 200)) process.stdout.write(`  [${v.rule}] ${v.file}:${v.line} — ${v.detail}\n`);
        if (violations.length > 200) process.stdout.write(`  … ${violations.length - 200} more\n`);
    }
    process.exit(violations.length ? 1 : 0);
}

main();
