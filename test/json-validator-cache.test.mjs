// @ts-check
/**
 * Two Ajv caches keyed only by object identity: the same schema text in a new
 * object recompiled, and a second distinct schema with the same `$id` threw
 * "already exists" on the shared instance. One cache per strictness, with an
 * identity fast path, a text key, and a fresh instance for a duplicate `$id`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';

import { validateValue, extractAndParseJson } from '../lib/support/json.mjs';

/** @param {() => any} fn */
function counting(fn) {
    const original = Ajv.prototype.compile;
    /** @type {{compiles: number}} */
    const seen = { compiles: 0 };
    // @ts-expect-error — the prototype is patched for the count.
    Ajv.prototype.compile = function patched(schema, ...rest) {
        seen.compiles += 1;
        return original.call(this, schema, ...rest);
    };
    try { return { seen, result: fn() }; } finally { Ajv.prototype.compile = original; }
}

test('the same schema object compiles once', () => {
    const schema = { type: 'object', properties: { uniqueCacheKeyA: { type: 'string' } }, required: ['uniqueCacheKeyA'] };
    const { seen, result } = counting(() => {
        validateValue({ value: { uniqueCacheKeyA: 'x' }, schema });
        validateValue({ value: { uniqueCacheKeyA: 'x' }, schema });
        return true;
    });
    assert.equal(result, true);
    assert.equal(seen.compiles, 1);
});

test('the same schema text in a new object compiles once', () => {
    const schema = { type: 'object', properties: { uniqueCacheKeyB: { type: 'number' } }, required: ['uniqueCacheKeyB'] };
    const copy = JSON.parse(JSON.stringify(schema));
    const { seen } = counting(() => {
        validateValue({ value: { uniqueCacheKeyB: 1 }, schema });
        validateValue({ value: { uniqueCacheKeyB: 2 }, schema: copy });
    });
    assert.equal(seen.compiles, 1, 'the text cache reused the validator');
});

test('two distinct schemas that share an $id both validate', () => {
    const a = { $id: 'urn:merci:test:duplicate-id', type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const b = { $id: 'urn:merci:test:duplicate-id', type: 'object', properties: { b: { type: 'number' } }, required: ['b'] };
    assert.equal(validateValue({ value: { a: 'x' }, schema: a }).ok, true);
    assert.equal(validateValue({ value: { b: 1 }, schema: b }).ok, true);
    assert.equal(validateValue({ value: { a: 1 }, schema: a }).ok, false, 'each validator keeps its own keywords');
});

test('the strict and non-strict caches stay independent: only the parsing path fills defaults', () => {
    const schema = { type: 'object', properties: { withDefault: { type: 'number', default: 7 } } };
    // `validateValue` is the non-mutating check: it must not invent the default.
    assert.equal(validateValue({ value: {}, schema }).ok, true);
    // The parsing path may fill it.
    const parsed = extractAndParseJson({ input: '{}', schema });
    assert.equal(parsed.success, true);
    assert.equal(/** @type {any} */ (parsed.data).withDefault, 7);
    // And the non-mutating check still refuses a wrong type after the other cache ran.
    assert.equal(validateValue({ value: { withDefault: 'seven' }, schema }).ok, false);
});
