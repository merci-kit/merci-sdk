// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractAndParseJson, guardedParse } from '../lib/support/json.mjs';

const RESULT_KEYS = ['success', 'data', 'error', 'details', 'healed', 'originalValid'];

const STRICT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'number' }, b: { type: 'string' } },
    required: ['a'],
};

const DEFAULT_SCHEMA = {
    type: 'object',
    properties: { a: { type: 'number', default: 5 }, b: { type: 'boolean', default: true } },
};

// ─── result contract shape ───────────────────────────────────────────────────

test('result always exposes exactly the six contract fields', () => {
    for (const r of [
        guardedParse({ input: '{"a":1}' }),
        guardedParse({ input: 'nope' }),
        guardedParse({ input: '{"a":"x"}', schema: STRICT_SCHEMA }),
        extractAndParseJson({ input: 'noise {"a":1} tail' }),
    ]) {
        assert.deepEqual(Object.keys(r).sort(), [...RESULT_KEYS].sort());
    }
});

test('details is null on success, null on parse failure, array on schema failure', () => {
    assert.equal(guardedParse({ input: '{"a":1}' }).details, null);
    assert.equal(guardedParse({ input: '{"a":1}', schema: STRICT_SCHEMA }).details, null);
    assert.equal(guardedParse({ input: 'not json at all' }).details, null);
    assert.ok(Array.isArray(guardedParse({ input: '{"a":"x"}', schema: STRICT_SCHEMA }).details));
});

// ─── extraction + healing table (the "no worse than before" lock) ────────────

const EXTRACT_TABLE = /** @type {[string, string, { success: boolean; data: any; healed: boolean; originalValid: boolean; error?: string }][]} */ ([
    ['plain object', '{"a":1}', { success: true, data: { a: 1 }, healed: false, originalValid: true }],
    ['markdown fence', '```json\n{"a":1}\n```', { success: true, data: { a: 1 }, healed: false, originalValid: true }],
    ['leading prose', 'Here you go: {"a":1} thanks', { success: true, data: { a: 1 }, healed: false, originalValid: true }],
    ['trailing stray brace', '{"a":1} and {stray', { success: true, data: { a: 1 }, healed: false, originalValid: true }],
    ['braces inside strings never miscount', '{"url":"https://x.com/{id}","n":3} done',
        { success: true, data: { url: 'https://x.com/{id}', n: 3 }, healed: false, originalValid: true }],
    ['nested structures', 'noise {"a":[1,2],"b":{"c":true}} tail',
        { success: true, data: { a: [1, 2], b: { c: true } }, healed: false, originalValid: true }],
    ['array root', '[1,2,3]', { success: true, data: [1, 2, 3], healed: false, originalValid: true }],
    ['array of objects', '[{"a":1}]', { success: true, data: [{ a: 1 }], healed: false, originalValid: true }],
    ['truncated json', '{"a":1,"b":', { success: false, data: null, healed: false, originalValid: false,
        error: 'Failed to parse or heal JSON structure' }],
    ['empty string', '', { success: false, data: null, healed: false, originalValid: false,
        error: 'Failed to parse or heal JSON structure' }],
    ['no json at all', 'hello world', { success: false, data: null, healed: false, originalValid: false,
        error: 'Failed to parse or heal JSON structure' }],
]);

for (const [label, input, expected] of EXTRACT_TABLE) {
    test(`extractAndParseJson: ${label}`, () => {
        const r = /** @type {any} */ (extractAndParseJson({ input }));
        assert.equal(r.success, expected.success);
        assert.deepEqual(r.data, expected.data);
        assert.equal(r.healed, expected.healed);
        assert.equal(r.originalValid, expected.originalValid);
        assert.equal(r.error, expected.error ?? null);
    });
}

// ─── guardedParse input handling ─────────────────────────────────────────────

test('guardedParse: object input is stringified, not rejected', () => {
    const r = guardedParse({ input: { a: 1 } });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.originalValid, true);
});

test('guardedParse: non-string, non-object input is rejected with the exact message', () => {
    for (const bad of [42, null, undefined, true]) {
        const r = guardedParse({ input: /** @type {any} */ (bad) });
        assert.equal(r.success, false);
        assert.equal(r.error, 'Input is not a string');
        assert.equal(r.data, null);
    }
});

test('guardedParse: an object that cannot be stringified (circular) is reported, not thrown', () => {
    const circular = {};
    circular.self = circular;
    const r = guardedParse({ input: circular });
    assert.equal(r.success, false);
    assert.equal(r.error, 'Input object cannot be stringified');
});

test('guardedParse: healer path flips originalValid=false and healed=true', () => {
    const r = guardedParse({ input: '```json\n{"a":1}\n```' });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.originalValid, false);
    assert.equal(r.healed, true);
});

// ─── JSON Schema validation ──────────────────────────────────────────────────

test('schema: valid payload passes with details=null', () => {
    const r = guardedParse({ input: '{"a":1,"b":"x"}', schema: STRICT_SCHEMA });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { a: 1, b: 'x' });
    assert.equal(r.error, null);
    assert.equal(r.details, null);
});

test('schema: failures set the exact error string and still return data for inspection', () => {
    for (const input of ['{"a":"nope"}', '{"b":"x"}', '{"a":1,"zzz":9}']) {
        const r = guardedParse({ input, schema: STRICT_SCHEMA });
        assert.equal(r.success, false);
        assert.equal(r.error, 'Schema Validation Failed');
        assert.notEqual(r.data, null, `${input} should still expose parsed data`);
        assert.ok(Array.isArray(r.details));
    }
});

test('schema: details entries carry the Ajv error shape', () => {
    const r = guardedParse({ input: '{"a":"nope"}', schema: STRICT_SCHEMA });
    const [first] = /** @type {Array<Record<string, any>>} */ (r.details);
    assert.equal(first.keyword, 'type');
    assert.equal(first.instancePath, '/a');
    assert.equal(first.message, 'must be number');
    assert.ok('schemaPath' in first && 'params' in first);
});

test('schema: Ajv useDefaults injects defaults into data', () => {
    const r = guardedParse({ input: '{}', schema: DEFAULT_SCHEMA });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { a: 5, b: true });
});

test('schema: extraction failure short-circuits before validation', () => {
    const r = guardedParse({ input: 'no json here', schema: STRICT_SCHEMA });
    assert.equal(r.success, false);
    assert.equal(r.error, 'Failed to parse or heal JSON structure');
    assert.equal(r.details, null);
});

test('schema: extractAndParseJson validates the extracted span', () => {
    const r = /** @type {any} */ (extractAndParseJson({ input: 'prose {"a":"bad"} tail', schema: STRICT_SCHEMA }));
    assert.equal(r.success, false);
    assert.equal(r.error, 'Schema Validation Failed');
    assert.ok(Array.isArray(r.details));
    assert.equal(r.originalValid, true);
});

test('schema: a failed heuristic extraction falls through to the healer', () => {
    const r = /** @type {any} */ (extractAndParseJson({ input: '{"a":1', schema: STRICT_SCHEMA }));
    assert.equal(typeof r.success, 'boolean');
    assert.ok(RESULT_KEYS.every((k) => k in r));
});

// ─── validator cache is not observable, but repeated calls must stay stable ──

test('repeated validation with the same schema object is stable', () => {
    for (let i = 0; i < 5; i += 1) {
        assert.equal(guardedParse({ input: '{"a":1}', schema: STRICT_SCHEMA }).success, true);
        assert.equal(guardedParse({ input: '{"a":"x"}', schema: STRICT_SCHEMA }).success, false);
    }
});
