// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { walkPath, interpolateTemplate } from '../lib/agentic/planning/graph-utils.mjs';

const OUTPUTS = {
    research: { output: 'raw text', data: { summary: 'the summary', nested: { deep: 'deep value' } } },
    plan: { output: 'plan only' }
};

/**
 * @param {{template: string, context?: Record<string, any>, outputs?: Record<string, any>}} arg0
 */
function interpolate({ template, context = {}, outputs = OUTPUTS }) {
    const emitter = new EventEmitter();
    const warnings = /** @type {any[]} */ ([]);
    emitter.on('workflow:template_warning', (w) => warnings.push(w));
    const out = interpolateTemplate({ template, outputs, stepId: 'step1', emitter, context });
    return { out, warnings };
}

test('walkPath: resolves dotted paths, rejects misses and prototype keys', () => {
    assert.equal(walkPath({ value: { a: { b: 1 } }, parts: ['a', 'b'] }).value, 1);
    assert.equal(walkPath({ value: { a: { b: 1 } }, parts: ['a', 'x'] }).ok, false);
    assert.deepEqual(walkPath({ value: { a: { b: 1 } }, parts: ['a'] }).value, { b: 1 });
    assert.equal(walkPath({ value: { a: 1 }, parts: ['constructor'] }).ok, false);
    assert.equal(walkPath({ value: Object.create({ a: 1 }), parts: ['a'] }).ok, false);
});

test('{{step}} and {{step.output}} resolve the output string', () => {
    assert.equal(interpolate({ template: 'A: {{research}}' }).out, 'A: raw text');
    assert.equal(interpolate({ template: 'A: {{research.output}}' }).out, 'A: raw text');
    assert.equal(interpolate({ template: 'A: {{research.output.x}}' }).out.includes('[UNRESOLVED'), true);
});

test('{{step.foo}} resolves data.foo — not the whole data object', () => {
    const { out, warnings } = interpolate({ template: 'S: {{research.summary}}' });
    assert.equal(out, 'S: the summary');
    assert.equal(warnings.length, 0);
});

test('an object-valued step output renders as JSON, not "[object Object]"', () => {
    const outputs = { gen: { output: { itinerary: 'prague', days: 3 } } };
    const { out, warnings } = interpolate({ template: 'O: {{gen}}', context: {}, outputs });
    assert.equal(out, 'O: {"itinerary":"prague","days":3}');
    assert.equal(warnings.length, 0);
    const dotted = interpolate({ template: 'D: {{gen.output.itinerary}}', context: {}, outputs });
    assert.equal(dotted.out, 'D: prague');
});

test('an object-valued context var renders as JSON too', () => {
    const { out } = interpolate({ template: 'C: {{context.plan}}', context: { plan: { a: 1 } } });
    assert.equal(out, 'C: {"a":1}');
});

test('stringifier edges: null output renders empty; circular/Map/Set/BigInt never throw or leak "[object Object]"', () => {
    const { out: nullOut } = interpolate({ template: 'N: {{gen}}', context: {}, outputs: { gen: { output: null } } });
    assert.equal(nullOut, 'N: ');
    const { out: undefOut } = interpolate({ template: 'U: {{gen}}', context: {}, outputs: { gen: { output: undefined } } });
    assert.equal(undefOut, 'U: ', 'an undefined output renders empty, not the wrapper');

    /** @type {any} */ const circular = { name: 'loop' };
    circular.self = circular;
    const { out: circ } = interpolate({ template: 'C: {{gen}}', context: {}, outputs: { gen: { output: circular } } });
    assert.match(circ, /\[circular\]/, 'cycles are broken, not thrown');
    assert.ok(!circ.includes('[object Object]'));

    const { out: mapOut } = interpolate({ template: 'M: {{gen}}', context: {}, outputs: { gen: { output: new Map([['k', 'v']]) } } });
    assert.equal(mapOut, 'M: {"k":"v"}');
    const { out: setOut } = interpolate({ template: 'S: {{gen}}', context: {}, outputs: { gen: { output: new Set([1, 2]) } } });
    assert.equal(setOut, 'S: [1,2]');
    const { out: bigOut } = interpolate({ template: 'B: {{gen}}', context: {}, outputs: { gen: { output: { n: 10n } } } });
    assert.equal(bigOut, 'B: {"n":"10"}', 'BigInt must not throw out of template rendering');
});

test('{{step.foo.deep}} walks through data.foo.deep', () => {
    const { out } = interpolate({ template: 'D: {{research.nested.deep}}' });
    assert.equal(out, 'D: deep value');
});

test('{{step.data.x}} direct data access still works', () => {
    const { out } = interpolate({ template: 'X: {{research.data.summary}}' });
    assert.equal(out, 'X: the summary');
});

test('{{context.a.b}} resolves dotted context paths', () => {
    const { out, warnings } = interpolate({ template: 'C: {{context.k1.k2}}', context: { k1: { k2: 'ctx val' } } });
    assert.equal(out, 'C: ctx val');
    assert.equal(warnings.length, 0);
});

test('prototype keys do not leak: {{context.constructor}} is UNRESOLVED', () => {
    const { out, warnings } = interpolate({ template: 'P: {{context.constructor}}' });
    assert.equal(out, 'P: [UNRESOLVED: {{context.constructor}}]');
    assert.equal(warnings.length, 1);
});

test('misses surface as [UNRESOLVED] with a template_warning', () => {
    const { out, warnings } = interpolate({ template: 'M: {{research.missing}}' });
    assert.equal(out, 'M: [UNRESOLVED: {{research.missing}}]');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].path, 'research.missing');
});

test('step output without data key: {{step.foo}} warns instead of silent empty', () => {
    const { out, warnings } = interpolate({ template: 'N: {{plan.foo}}' });
    assert.equal(out.includes('[UNRESOLVED'), true);
    assert.equal(warnings.length, 1);
});
