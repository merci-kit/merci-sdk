// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractTypedefs } from '../scripts/build-structure.mjs';

/**
 * `STRUCTURE.md` is generated from the JSDoc. A typedef that spans lines is
 * valid JSDoc; the generator must join it until the braces balance, or the
 * table shows `{{` as the type and the name is lost.
 */

test('build-structure reads a single-line typedef', () => {
    const src = '/** @typedef {import(\'x\').Client} McpSdkClient */';
    assert.deepEqual(extractTypedefs({ src }), [{ name: 'McpSdkClient', type: "{import('x').Client}" }]);
});

test('build-structure reads a multi-line structural typedef', () => {
    const src = [
        '/**',
        ' * Does a thing.',
        ' * @typedef {{',
        ' *   a: string,',
        ' *   b: number',
        ' * }} Shape',
        ' */',
    ].join('\n');
    const [shape] = extractTypedefs({ src });
    assert.equal(shape.name, 'Shape');
    assert.match(shape.type, /^\{/);
    assert.match(shape.type, /a: string/);
    assert.match(shape.type, /b: number/);
});

test('the committed structure table lists the structural typedef by name', () => {
    const doc = readFileSync(new URL('../STRUCTURE.md', import.meta.url), 'utf8');
    const line = doc.split('\n').find((l) => l.includes('| `McpSdkClient` |'));
    assert.ok(line, 'the structural typedef is missing from STRUCTURE.md');
    assert.match(line, /setRequestHandler/, 'the parsed type is the structural shape, not a broken fragment');
    assert.equal(doc.includes('[object Object]'), false, 'an entry-point row stringified its conditions object');
});
