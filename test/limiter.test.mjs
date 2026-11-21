// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLimiter } from '../lib/support/limiter.mjs';

/** @param {{ms: number}} arg0 */
/** @param {{ms: *}} arg0 */
/** @param {{ms: *}} arg0 */
const sleep = ({ ms }) => new Promise((r) => setTimeout(r, ms));

/** Let timer callbacks' continuations run without advancing a mocked clock. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createLimiter', () => {
    it('never exceeds the configured in-flight cap', async () => {
        const limiter = createLimiter({ maxConcurrent: 2 });
        let active = 0;
        let peak = 0;
        const tasks = Array.from({ length: 10 }, () => limiter.run(async () => {
            active++;
            peak = Math.max(peak, active);
            await sleep({ ms: 20 });
            active--;
            return 'ok';
        }));
        const results = await Promise.all(tasks);
        assert.equal(peak, 2);
        assert.equal(results.length, 10);
        assert.ok(results.every((r) => r === 'ok'));
        assert.equal(active, 0);
    });

    it('returns results independent of completion order', async () => {
        const limiter = createLimiter({ maxConcurrent: 3 });
        const delays = [30, 10, 20, 5, 25];
        const results = await Promise.all(
            delays.map((d, i) => limiter.run(async () => { await sleep({ ms: d }); return i; })),
        );
        assert.deepEqual(results, [0, 1, 2, 3, 4]);
    });

    it('releases the slot when a task rejects', async () => {
        const limiter = createLimiter({ maxConcurrent: 1 });
        await assert.rejects(
            limiter.run(async () => { throw new Error('boom'); }),
            /boom/,
        );
        assert.equal(await limiter.run(async () => 'next'), 'next');
    });

    it('spaces task starts by minDelayMs', async (t) => {
        // libuv truncates timer expiry to whole milliseconds and Date.now()
        // truncates independently, so a wall-clock 15 ms delay can legitimately
        // read 14. Mock both and pin the exact boundary instead.
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
        const limiter = createLimiter({ maxConcurrent: 1, minDelayMs: 15 });
        /** @type {number[]} */
        const starts = [];
        const pending = [0, 1, 2].map(() => limiter.run(async () => { starts.push(Date.now()); }));
        await flush();
        assert.deepEqual(starts, [0], 'the first task starts immediately');
        t.mock.timers.tick(14);
        await flush();
        assert.deepEqual(starts, [0], 'no second start before minDelayMs elapses');
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(starts, [0, 15], 'the second start lands exactly at minDelayMs');
        t.mock.timers.tick(14);
        await flush();
        assert.deepEqual(starts, [0, 15], 'the third start waits the same delay, not less');
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(starts, [0, 15, 30], 'the third start lands exactly one delay later');
        t.mock.timers.tick(15);
        await flush();
        await Promise.all(pending);
    });

    it('acquire/release gates callers without run()', async () => {
        const limiter = createLimiter({ maxConcurrent: 1 });
        await limiter.acquire();
        let entered = false;
        const pending = limiter.run(async () => { entered = true; });
        await sleep({ ms: 10 });
        assert.equal(entered, false, 'second task must wait while the slot is held');
        limiter.release();
        await pending;
        assert.equal(entered, true);
    });
});
