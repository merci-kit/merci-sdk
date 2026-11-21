// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
    extractAndParseJson,
    findWireHostileKeywords,
    guardedParse,
    isZodSchema,
    zodSchemaToJsonSchema,
} from '../lib/support/json.mjs';

const RESULT_KEYS = ['success', 'data', 'error', 'details', 'healed', 'originalValid'];

const STRICT = z.strictObject({ a: z.number(), b: z.string().optional() });

// ─── detection ───────────────────────────────────────────────────────────────

test('isZodSchema recognises zod v4 schemas and rejects JSON Schema', () => {
    assert.equal(isZodSchema({ schema: STRICT }), true);
    assert.equal(isZodSchema({ schema: z.string() }), true);
    assert.equal(isZodSchema({ schema: { type: 'object' } }), false);
    assert.equal(isZodSchema({ schema: null }), false);
    assert.equal(isZodSchema({ schema: undefined }), false);
    assert.equal(isZodSchema({ schema: '{}' }), false);
    assert.equal(isZodSchema({ schema: { safeParse: () => ({ success: true }) } }), false);
});

test('isZodSchema recognises a v3-shaped schema (structural, not instanceof)', () => {
    const v3Shaped = { _def: {}, '~standard': {}, safeParse: () => ({ success: true }) };
    assert.equal(isZodSchema({ schema: v3Shaped }), true);
});

// ─── validation through the one handler ──────────────────────────────────────

test('a Zod schema validates and keeps the exact six-field result contract', () => {
    const ok = guardedParse({ input: '{"a":1,"b":"x"}', schema: STRICT });
    assert.deepEqual(Object.keys(ok).sort(), [...RESULT_KEYS].sort());
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data, { a: 1, b: 'x' });
    assert.equal(ok.error, null);
    assert.equal(ok.details, null);
    assert.equal(ok.healed, false);
    assert.equal(ok.originalValid, true);
});

test('a Zod failure reuses the exact schema-failure error string and returns data', () => {
    const r = guardedParse({ input: '{"a":"nope"}', schema: STRICT });
    assert.equal(r.success, false);
    assert.equal(r.error, 'Schema Validation Failed');
    assert.deepEqual(r.data, { a: 'nope' }, 'failures stay inspectable');
    assert.equal(r.originalValid, true);
});

test('Zod failure details are an inspectable array of {instancePath, message, code}', () => {
    const r = guardedParse({ input: '{"b":"x"}', schema: STRICT });
    assert.ok(Array.isArray(r.details));
    const [issue] = /** @type {Array<Record<string, any>>} */ (r.details);
    assert.equal(issue.instancePath, '/a');
    assert.equal(issue.code, 'invalid_type');
    assert.equal(typeof issue.message, 'string');
});

test('a root-level Zod failure reports an empty instancePath', () => {
    const r = guardedParse({ input: '"just a string"', schema: z.number() });
    assert.equal(r.success, false);
    assert.equal(/** @type {Array<Record<string, any>>} */ (r.details)[0].instancePath, '');
});

test('Zod defaults are applied to the returned data (unlike Ajv, without mutation)', () => {
    const input = {};
    const r = guardedParse({ input, schema: z.object({ a: z.number().default(5) }) });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { a: 5 });
    assert.deepEqual(input, {}, 'the caller input must not be mutated');
});

test('Zod does not silently coerce by default', () => {
    const r = guardedParse({ input: '{"a":"1"}', schema: STRICT });
    assert.equal(r.success, false, 'a string must not satisfy z.number()');
});

test('Zod is used by extractAndParseJson too, for prose/fenced output', () => {
    const prose = /** @type {any} */ (extractAndParseJson({ input: 'Here: {"a":3} thanks', schema: STRICT }));
    assert.equal(prose.success, true);
    assert.deepEqual(prose.data, { a: 3 });

    const fenced = /** @type {any} */ (extractAndParseJson({ input: '```json\n{"a":4}\n```', schema: STRICT }));
    assert.equal(fenced.success, true);
    assert.deepEqual(fenced.data, { a: 4 });
});

test('healing runs before Zod validation', () => {
    const r = guardedParse({ input: '```json\n{"a":2}\n```', schema: STRICT });
    assert.equal(r.success, true);
    assert.equal(r.healed, true);
    assert.equal(r.originalValid, false);
    assert.deepEqual(r.data, { a: 2 });
});

test('a Zod schema and an equivalent JSON Schema agree on the same payloads', () => {
    const jsonSchema = {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'number' }, b: { type: 'string' } },
        required: ['a'],
    };
    for (const payload of ['{"a":1,"b":"x"}', '{"a":"nope"}', '{"b":"x"}', '{"a":1,"zzz":9}']) {
        assert.equal(
            guardedParse({ input: payload, schema: STRICT }).success,
            guardedParse({ input: payload, schema: jsonSchema }).success,
            `disagreement on ${payload}`,
        );
    }
});

// ─── conversion for the wire ─────────────────────────────────────────────────

test('zodSchemaToJsonSchema produces plain draft-07 JSON Schema without $schema', () => {
    const converted = zodSchemaToJsonSchema({ zodSchema: z.strictObject({ a: z.number(), b: z.string().describe('bee') }) });
    assert.deepEqual(converted, {
        type: 'object',
        properties: { a: { type: 'number' }, b: { description: 'bee', type: 'string' } },
        required: ['a', 'b'],
        additionalProperties: false,
    });
    assert.ok(!('$schema' in converted), '$schema is vendor noise and must be stripped');
});

test('zodSchemaToJsonSchema strips the safe-integer envelope z.number().int() emits', () => {
    const converted = /** @type {any} */ (zodSchemaToJsonSchema({ zodSchema: z.object({ n: z.number().int() }) }));
    assert.deepEqual(converted.properties.n, { type: 'integer' });
});

test('zodSchemaToJsonSchema preserves descriptions, enums, minItems and strictness', () => {
    const converted = /** @type {any} */ (zodSchemaToJsonSchema({ zodSchema: z.strictObject({
        kind: z.enum(['low', 'high']).describe('how big'),
        steps: z.array(z.string()).min(2),
    }) }));
    assert.deepEqual(converted.properties.kind, {
        description: 'how big', type: 'string', enum: ['low', 'high'],
    });
    assert.equal(converted.properties.steps.minItems, 2);
    assert.equal(converted.additionalProperties, false);
});

test('zodSchemaToJsonSchema is memoized by schema identity', () => {
    assert.equal(zodSchemaToJsonSchema({ zodSchema: STRICT }), zodSchemaToJsonSchema({ zodSchema: STRICT }));
});

test('zodSchemaToJsonSchema returns null for non-Zod and for v3-shaped schemas', () => {
    assert.equal(zodSchemaToJsonSchema({ zodSchema: { type: 'object' } }), null);
    assert.equal(zodSchemaToJsonSchema({ zodSchema: /** @type {any} */ (null) }), null);
    const v3Shaped = { _def: {}, '~standard': {}, safeParse: () => ({ success: true }) };
    assert.equal(zodSchemaToJsonSchema({ zodSchema: v3Shaped }), null, 'v3 cannot be converted, must not throw');
});

// ─── wire-hostile guard ──────────────────────────────────────────────────────

test('findWireHostileKeywords: clean internal-style schemas report nothing', () => {
    const clean = zodSchemaToJsonSchema({ zodSchema: z.strictObject({
        summary: z.string().describe('s'),
        complexity: z.enum(['low', 'medium', 'high']),
        steps: z.array(z.strictObject({ id: z.string(), turns: z.number().int().optional() })).min(2),
    }) });
    assert.deepEqual([...findWireHostileKeywords({ node: clean })], []);
});

test('findWireHostileKeywords catches every wire-hostile construct zod can emit', () => {
    assert.deepEqual([...findWireHostileKeywords({ node: zodSchemaToJsonSchema({ zodSchema: z.object({ x: z.string().nullable() }) }) })], ['type[]']);
    assert.deepEqual([...findWireHostileKeywords({ node: zodSchemaToJsonSchema({ zodSchema: z.object({ x: z.union([z.string(), z.number()]) }) }) })], ['type[]']);
    assert.deepEqual(
        [...findWireHostileKeywords({ node: zodSchemaToJsonSchema({ zodSchema: z.object({ x: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) }) }) })],
        ['anyOf'],
    );
});

test('findWireHostileKeywords ignores a property literally named anyOf', () => {
    const schema = { type: 'object', properties: { anyOf: { type: 'string' } } };
    assert.deepEqual([...findWireHostileKeywords({ node: schema })], []);
});

test('findWireHostileKeywords finds offenders nested inside arrays and objects', () => {
    const schema = { type: 'object', properties: { list: { type: 'array', items: { oneOf: [{ type: 'string' }] } } } };
    assert.deepEqual([...findWireHostileKeywords({ node: schema })], ['oneOf']);
});
