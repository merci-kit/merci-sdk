// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDueSteps } from '../lib/agentic/agentic-core.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('runDueSteps: outcomes pair positionally in input order', async () => {
    const steps = [
        { key: 'a', run: async () => { await tick(); await tick(); return 'A'; } },
        { key: 'b', run: async () => 'B' },
        { key: 'c', run: async () => { await tick(); return 'C'; } },
    ];
    const out = await runDueSteps({ steps });
    assert.deepEqual(out.map((/** @type {any} */ o) => (/** @type {any} */ (o)).step.key), ['a', 'b', 'c']);
    assert.deepEqual(out.map((/** @type {any} */ o) => o.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    assert.deepEqual(out.map((/** @type {any} */ o) => o.value), ['A', 'B', 'C']);
});

test('runDueSteps: a failing sibling neither abandons nor reorders the rest', async () => {
    let slowFinished = false;
    const steps = [
        { key: 'fast-fail', run: async () => { throw new Error('boom'); } },
        { key: 'slow', run: async () => { await tick(); await tick(); slowFinished = true; return 'S'; } },
    ];
    const out = await runDueSteps({ steps });
    assert.equal(out[0].status, 'rejected');
    assert.equal(/** @type {any} */ (out[0].reason).message, 'boom');
    assert.equal(out[1].status, 'fulfilled');
    assert.equal(out[1].value, 'S');
    assert.equal(slowFinished, true, 'in-flight sibling ran to completion');
});

test('runDueSteps: empty due set resolves empty, abort rejections pair like any reason', async () => {
    assert.deepEqual(await runDueSteps({ steps: [] }), []);
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const out = await runDueSteps({ steps: [{ key: 'x', run: async () => { throw abortErr; } }] });
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'rejected');
    assert.equal(out[0].reason, abortErr, 'core reports; abort policy stays engine-side');
});
