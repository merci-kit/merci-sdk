// @ts-check
/** Focused proofs for the HookRegistry intervene layer. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHooks, STOP } from '../lib/core/hooks.mjs';

test('runSerial runs in priority order and returns results', async () => {
    const hooks = /** @type {any} */ (createHooks());
    /** @type {string[]} */
    const order = [];
    hooks.add({ name: 'h', fn: () => { order.push('lo'); return 1; }, priority: 1 });
    hooks.add({ name: 'h', fn: () => { order.push('hi'); return 2; }, priority: 10 });
    const results = await hooks.runSerial({ name: 'h', ctx: {} });
    assert.deepEqual(order, ['hi', 'lo']);
    assert.deepEqual(results, [2, 1]);
});

test('runWaterfall transforms and STOP short-circuits', async () => {
    const hooks = /** @type {any} */ (createHooks());
    hooks.add({ name: 'w', fn: (/** @type {any} */ v) => v + 1 });
    hooks.add({ name: 'w', fn: () => STOP });
    hooks.add({ name: 'w', fn: (/** @type {any} */ v) => v + 100 });
    const out = await hooks.runWaterfall({ name: 'w', value: 0 });
    assert.equal(out, STOP);
});

test('runWaterfall treats undefined as unchanged', async () => {
    const hooks = /** @type {any} */ (createHooks());
    hooks.add({ name: 'w', fn: () => undefined });
    hooks.add({ name: 'w', fn: (/** @type {any} */ v) => v + 2 });
    const out = await hooks.runWaterfall({ name: 'w', value: 1 });
    assert.equal(out, 3);
});

test('add returns an unsubscribe fn; has/count/clear', async () => {
    const hooks = /** @type {any} */ (createHooks());
    const off = hooks.add({ name: 'k', fn: () => {} });
    assert.equal(hooks.has({ name: 'k' }), true);
    assert.equal(hooks.count({ name: 'k' }), 1);
    off();
    assert.equal(hooks.has({ name: 'k' }), false);
    hooks.add({ name: 'k', fn: () => {} });
    hooks.clear({ name: 'k' });
    assert.equal(hooks.count({ name: 'k' }), 0);
});
