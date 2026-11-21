// @ts-check
/**
 * @file G1-13: the hardcoded-limit gate sees cap-shaped literals outside
 * declarations, and the documented catalog size is checked, not trusted.
 * @version 0.12.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parse } from 'acorn';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import { inspectModule, LIMIT_DEFAULT_ALLOWLIST } from '../scripts/check-limits.mjs';

/**
 * @param {string} source -
 * @returns {Array<{rule: string, name: string, line: number}>}
 */
function hitsFor(source) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    return inspectModule({ ast, rel: 'test/fixture.mjs', source });
}

test('G1-13 the gate baselines a `.slice(0, 90)` cap', () => {
    const hits = hitsFor('export const head = (text) => text.slice(0, 90);\n');
    const slice = hits.find((hit) => hit.rule === 'L6' && hit.name.includes('.slice(0, 90)'));
    assert.ok(slice, `expected an L6 hit for the slice cap; got ${JSON.stringify(hits)}`);
});

test('G1-13 the gate sees a numeric comparison against `.length`', () => {
    const hits = hitsFor('export const tooBig = (rows) => rows.length > 800;\n');
    const compare = hits.find((hit) => hit.rule === 'L5' && hit.name.includes('length > 800'));
    assert.ok(compare, `expected an L5 hit for the length comparison; got ${JSON.stringify(hits)}`);
});

/**
 * @param {string} rel - the module path the hit is reported against
 * @param {string} source - module source
 * @returns {Array<{rule: string, name: string, line: number}>}
 */
function hitsIn(rel, source) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    return inspectModule({ ast, rel, source });
}

test('L7 a top-level registry-default constant is reported once', () => {
    const hits = hitsFor('export const A = LIMIT_REGISTRY.mcp_task_page_size.default;\n');
    const frozen = hits.filter((hit) => hit.rule === 'L7');
    assert.equal(frozen.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(frozen[0].name.includes('LIMIT_REGISTRY.mcp_task_page_size.default'), frozen[0].name);
});

test('L7 a computed registry read is reported as `LIMIT_REGISTRY[`', () => {
    const hits = hitsFor('const b = LIMIT_REGISTRY[k].default;\n');
    const frozen = hits.filter((hit) => hit.rule === 'L7');
    assert.equal(frozen.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(frozen[0].name.includes('LIMIT_REGISTRY['), frozen[0].name);
});

test('L7 a static `LIMIT_DEFAULTS` read is reported once', () => {
    const hits = hitsFor('export const A = LIMIT_DEFAULTS.journal_max_attempts;\n');
    const frozen = hits.filter((hit) => hit.rule === 'L7');
    assert.equal(frozen.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(frozen[0].name.includes('LIMIT_DEFAULTS.journal_max_attempts'), frozen[0].name);
});

test('L7 a computed `LIMIT_DEFAULTS` read is reported as `LIMIT_DEFAULTS[`', () => {
    const hits = hitsFor('const c = LIMIT_DEFAULTS[k];\n');
    const frozen = hits.filter((hit) => hit.rule === 'L7');
    assert.equal(frozen.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(frozen[0].name.includes('LIMIT_DEFAULTS['), frozen[0].name);
});

test('L7 the allowlisted `DEFAULT_*` constant is sanctioned at top level', () => {
    const hits = hitsIn('lib/tools/mcp-client.mjs', 'export const MCP_MAX_OUTPUT_LENGTH = LIMIT_REGISTRY.mcp_output_max_chars.default;\n');
    assert.deepEqual(hits.filter((hit) => hit.rule === 'L7'), []);
});

test('L7 a body read in an allowlisted file still fails', () => {
    const hits = hitsIn('lib/tools/mcp-client.mjs', 'function f(){ return LIMIT_REGISTRY.mcp_output_max_chars.default; }\n');
    assert.equal(hits.filter((hit) => hit.rule === 'L7').length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
});

test('L7 the allowlisted `MAX_BROWSER_URLS` constant is sanctioned at top level', () => {
    const hits = hitsIn('lib/agentic/browser/engines.mjs', 'export const MAX_BROWSER_URLS = LIMIT_DEFAULTS.browser_max_urls;\n');
    assert.deepEqual(hits.filter((hit) => hit.rule === 'L7'), []);
});

test('L7 the allowlist is frozen and carries the eight reviewed sanctions', () => {
    assert.equal(Object.isFrozen(LIMIT_DEFAULT_ALLOWLIST), true);
    assert.equal(LIMIT_DEFAULT_ALLOWLIST.length, 8);
    for (const entry of LIMIT_DEFAULT_ALLOWLIST) {
        assert.deepEqual(Object.keys(entry).sort(), ['file', 'key', 'name']);
        assert.ok(entry.file.startsWith('lib/') && !entry.file.includes('*'), entry.file);
    }
});

/**
 * @param {string} source - module source
 * @returns {Array<{rule: string, name: string, line: number}>}
 */
function l8Hits(source) {
    return hitsFor(source).filter((hit) => hit.rule === 'L8');
}

test('L8 an exported module-scope `LIMITS.<key>` read is reported once', () => {
    assert.equal(l8Hits('export const X = LIMITS.foo;\n').length, 1);
});

test('L8 a computed module-scope `LIMITS[` read is reported once', () => {
    assert.equal(l8Hits("const X = LIMITS['foo'];\n").length, 1);
});

test('L8 a module-scope destructuring of `LIMITS` is reported once', () => {
    const hits = l8Hits('const { foo } = LIMITS;\n');
    assert.equal(hits.length, 1);
    assert.ok(hits[0].name.includes('const { … } = LIMITS'), hits[0].name);
});

test('L8 a `LIMITS` read inside a function is the correct pattern', () => {
    assert.deepEqual(l8Hits('function f(){ return LIMITS.foo; }\n'), []);
});

test('L8 a read from another object is not a module-scope freeze', () => {
    assert.deepEqual(l8Hits('const X = OTHER.foo;\n'), []);
});

test('L7 a module-scope destructuring of `LIMIT_DEFAULTS` is reported once', () => {
    const hits = hitsFor('const { journal_max_attempts } = LIMIT_DEFAULTS;\n');
    const frozen = hits.filter((hit) => hit.rule === 'L7');
    assert.equal(frozen.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(frozen[0].name.includes('const { … } = LIMIT_DEFAULTS'), frozen[0].name);
});

test('L8 a `LIMITS` read nested in a module-scope object initialiser is reported', () => {
    const hits = l8Hits('export const D = { cap: LIMITS.max_iterations };\n');
    assert.equal(hits.length, 1, `expected one L8 hit; got ${JSON.stringify(hits)}`);
    assert.ok(hits[0].name.includes('LIMITS.max_iterations'), hits[0].name);
});

test('L8 every `LIMITS` read in a module-scope array initialiser is reported', () => {
    assert.equal(l8Hits('const pair = [LIMITS.a, LIMITS.b];\n').length, 2);
});

test('L8 a `LIMITS` read nested in a module-scope logical initialiser is reported', () => {
    assert.equal(l8Hits('const x = LIMITS.foo ?? 0;\n').length, 1);
});

test('L7 a nested `LIMIT_DEFAULTS` read in the allowlisted file is not sanctioned', () => {
    const hits = hitsIn('lib/agentic/browser/engines.mjs', 'export const D = { cap: LIMIT_DEFAULTS.browser_max_urls };\n');
    const frozen = hits.filter((hit) => hit.rule === 'L7');
    assert.equal(frozen.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
});

test('L8 a `LIMITS` read inside an arrow body is not a module-scope freeze', () => {
    assert.deepEqual(l8Hits('const read = () => LIMITS.foo;\n'), []);
});

test('L8 an `export default LIMITS.<key>` read is reported once', () => {
    assert.equal(l8Hits('export default LIMITS.foo;\n').length, 1);
});

test('L8 a top-level class static field is a module-scope read', () => {
    assert.equal(l8Hits('class C { static x = LIMITS.foo }\n').length, 1);
});

test('L8 a top-level class static block is a module-scope read', () => {
    assert.equal(l8Hits('class C { static { C.x = LIMITS.foo } }\n').length, 1);
});

test('L8 a class expression bound at module scope fires like the declaration form', () => {
    assert.equal(l8Hits('export const C = class { static x = LIMITS.foo };\n').length, 1);
});

test('L8 a read inside a module-scope `if` block runs at import', () => {
    assert.equal(l8Hits('if (true) { const x = LIMITS.foo }\n').length, 1);
});

test('L8 a read inside a module-scope loop body runs at import', () => {
    assert.equal(l8Hits('for (const a of rows) { const x = LIMITS.foo }\n').length, 1);
});

test('L8 a top-level class instance field defers to construction', () => {
    assert.deepEqual(l8Hits('class C { x = LIMITS.foo }\n'), []);
});

test('L8 a top-level class getter defers to the call', () => {
    assert.deepEqual(l8Hits('class C { get x() { return LIMITS.foo } }\n'), []);
});

test('L8 a top-level class method defers to the call', () => {
    assert.deepEqual(l8Hits('class C { m() { return LIMITS.foo } }\n'), []);
});

test('L8 `Object.keys(LIMITS)` reads no values and is not a freeze', () => {
    assert.deepEqual(l8Hits('const o = Object.keys(LIMITS);\n'), []);
});

/**
 * A bare-map copy evaluates every lazy getter. The rule depends on the
 * identifier: `LIMIT_DEFAULTS` is L7 (code defaults, banned at any scope),
 * `LIMITS` is L8 (module-scope freeze only). `Object.keys` above stays clean
 * because it reads no values.
 * @type {Array<[string, string, 'L7'|'L8']>}
 */
const BARE_MAP_READS = [
    ['const o = { ...LIMITS };', '...LIMITS', 'L8'],
    ['const o = { ...LIMIT_DEFAULTS };', '...LIMIT_DEFAULTS', 'L7'],
    ['const o = Object.values(LIMITS);', 'Object.values(LIMITS)', 'L8'],
    ['const o = Object.values(LIMIT_DEFAULTS);', 'Object.values(LIMIT_DEFAULTS)', 'L7'],
    ['const o = Object.entries(LIMITS);', 'Object.entries(LIMITS)', 'L8'],
    ['const o = Object.assign({}, LIMITS);', 'Object.assign(', 'L8'],
    ["const o = Reflect.get(LIMITS, 'x');", 'Reflect.get(LIMITS,', 'L8']
];
for (const [source, label, rule] of BARE_MAP_READS) {
    test(`${rule} a bare-map copy \`${label}\` is one freeze`, () => {
        const hits = ruleHits(`${source}\n`, rule);
        assert.equal(hits.length, 1, `expected one ${rule} hit; got ${JSON.stringify(hits)}`);
        assert.ok(hits[0].name.includes(label), hits[0].name);
    });
}

/**
 * @param {string} source - module source
 * @param {'L7'|'L8'} rule - the rule to keep
 * @returns {Array<{rule: string, name: string, line: number}>}
 */
function ruleHits(source, rule) {
    return hitsFor(source).filter((hit) => hit.rule === rule);
}

test('L7 a destructuring read of `LIMIT_DEFAULTS` inside a function is still fatal', () => {
    const hits = ruleHits('export function f(){ const { max_iterations } = LIMIT_DEFAULTS; }\n', 'L7');
    assert.equal(hits.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(hits[0].name.includes('const { … } = LIMIT_DEFAULTS'), hits[0].name);
});

test('L7 `Object.entries(LIMIT_DEFAULTS)` reads every code default', () => {
    const hits = ruleHits('const o = Object.entries(LIMIT_DEFAULTS);\n', 'L7');
    assert.equal(hits.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(hits[0].name.includes('Object.entries(LIMIT_DEFAULTS)'), hits[0].name);
});

test('L8 `JSON.stringify(LIMITS)` reads every limit value', () => {
    const hits = l8Hits('const o = JSON.stringify(LIMITS);\n');
    assert.equal(hits.length, 1, `expected one L8 hit; got ${JSON.stringify(hits)}`);
    assert.ok(hits[0].name.includes('JSON.stringify(LIMITS)'), hits[0].name);
});

test('L7 `structuredClone(LIMIT_DEFAULTS)` reads every code default', () => {
    const hits = ruleHits('const o = structuredClone(LIMIT_DEFAULTS);\n', 'L7');
    assert.equal(hits.length, 1, `expected one L7 hit; got ${JSON.stringify(hits)}`);
    assert.ok(hits[0].name.includes('structuredClone(LIMIT_DEFAULTS)'), hits[0].name);
});

test('L8 neither `Object.keys(LIMITS)` nor an in-function destructure is a freeze', () => {
    assert.deepEqual(l8Hits('const o = Object.keys(LIMITS);\n'), []);
    assert.deepEqual(l8Hits('function g(){ const { max_iterations } = LIMITS; }\n'), []);
});

test('G1-13 the `LIMITS.md` count equals the registry', () => {
    const doc = readFileSync(new URL('../docs/LIMITS.md', import.meta.url), 'utf8');
    const claim = doc.match(/([\d,]+)\s+bounded numbers/);
    assert.ok(claim, 'docs/LIMITS.md states how many bounded numbers the SDK ships');
    assert.equal(Number(String(claim[1]).replace(/,/g, '')), Object.keys(LIMIT_REGISTRY).length);
});
