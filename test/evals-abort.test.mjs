// @ts-check
/**
 * `runEvals` checked the signal inside a case but still queued every case: an
 * aborted evaluation started sessions it would only throw away. Each limiter
 * task checks the signal before it builds a session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runEvals } from '../lib/agentic/evals.mjs';
import { AbortedError } from '../lib/core/errors.mjs';

const isAborted = (/** @type {any} */ err) => err instanceof AbortedError || err?.name === 'AbortedError';

test('an already-aborted signal never builds a session', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    let made = 0;
    await assert.rejects(
        runEvals({
            cases: [{ name: 'one', input: 'go' }, { name: 'two', input: 'go' }],
            makeSession: () => { made += 1; return { run: async () => 'x' }; },
            signal: ac.signal,
        }),
        isAborted,
    );
    assert.equal(made, 0, 'no session was built for an aborted run');
});

test('an abort mid-run stops the cases that have not started', async () => {
    const ac = new AbortController();
    let made = 0;
    const result = runEvals({
        cases: [{ name: 'one', input: 'go' }, { name: 'two', input: 'go' }, { name: 'three', input: 'go' }],
        makeSession: () => {
            made += 1;
            return { run: async () => { ac.abort(new Error('stop')); return 'x'; } };
        },
        signal: ac.signal,
        concurrency: 1,
    });
    await assert.rejects(result, isAborted);
    assert.ok(made >= 1 && made < 3, `only the started cases ran (built ${made})`);
});

test('an unaborted run still evaluates every case', async () => {
    /** @type {any} */
    const scorer = Object.defineProperty(() => ({ name: 'ok', passed: true }), 'name', { value: 'ok' });
    const out = await runEvals({
        cases: [{ name: 'one', input: 'go' }, { name: 'two', input: 'go' }],
        makeSession: () => ({ run: async () => 'x' }),
        scorers: [scorer],
    });
    assert.equal(out.results.length, 2);
    assert.equal(out.passRate, 1);
});
