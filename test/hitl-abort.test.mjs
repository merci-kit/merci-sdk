// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ApprovalCoordinator } from '../lib/agentic/planning/approval.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { AbortedError, isAbortError } from '../lib/core/errors.mjs';

describe('ApprovalCoordinator.wait(signal)', () => {
    it('waits without a signal exactly as before (backwards compatible)', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        const p = c.wait();
        c.resolve({ approved: true, details: { note: 'ok' } });
        assert.deepEqual(await p, { approved: true, note: 'ok' });
    });

    it('rejects fast with AbortedError when the signal is already aborted', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 5_000 });
        const ac = new AbortController();
        ac.abort(new Error('user cancelled'));
        const start = Date.now();
        await assert.rejects(c.wait({ signal: ac.signal }), (err) =>
            err instanceof AbortedError && isAbortError({ err, signal: ac.signal }));
        assert.ok(Date.now() - start < 2_000, 'an aborted signal must not wait for the timeout');
    });

    it('rejects fast with AbortedError when the signal aborts mid-wait', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 5_000 });
        const ac = new AbortController();
        const p = c.wait({ signal: ac.signal });
        const start = Date.now();
        ac.abort(new Error('cancel now'));
        await assert.rejects(p, (err) =>
            err instanceof AbortedError && isAbortError({ err, signal: ac.signal }));
        assert.ok(Date.now() - start < 2_000, 'a mid-wait abort must not wait for the timeout');
    });

    it('an abort after a normal resolve does not disturb the resolved outcome', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        const ac = new AbortController();
        const p = c.wait({ signal: ac.signal });
        c.resolve({ approved: false, details: { reason: 'operator declined' } });
        assert.deepEqual(await p, { approved: false, reason: 'operator declined' });
        ac.abort(new Error('late cancel'));
        await new Promise(r => setTimeout(r, 10));
    });

    it('the consume-once pending branch still serves a pre-resolved decision', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        c.resolve({ approved: true });
        const ac = new AbortController();
        assert.deepEqual(await c.wait({ signal: ac.signal }), { approved: true });
    });

    it('a pre-aborted signal rejects even when an approval is pending (no stale gate)', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        c.resolve({ approved: true });
        const ac = new AbortController();
        ac.abort(new Error('cancel'));
        await assert.rejects(c.wait({ signal: ac.signal }), (err) => err instanceof AbortedError);
    });

    it('a late approval after an abort is NOT served to the next wait (fresh gate)', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        const ac = new AbortController();
        const p1 = c.wait({ signal: ac.signal });
        ac.abort(new Error('cancel mid-wait'));
        await assert.rejects(p1, (err) => err instanceof AbortedError);
        c.resolve({ approved: true });
        const p2 = c.wait();
        const raced = await Promise.race([
            p2.then(v => ({ served: v })),
            new Promise(r => setTimeout(() => r('fresh-gate'), 60)),
        ]);
        assert.equal(raced, 'fresh-gate', 'the aborted coordinator must not serve the stale approval');
        c.resolve({ approved: false });
    });

    it('a late approval cannot settle an IN-FLIGHT wait of the next run', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        const ac = new AbortController();
        const p1 = c.wait({ signal: ac.signal });
        ac.abort(new Error('cancel mid-wait'));
        await assert.rejects(p1, (err) => err instanceof AbortedError);
        const p2 = c.wait();
        c.resolve({ approved: true });
        const raced = await Promise.race([
            p2.then(v => ({ served: v })),
            new Promise(r => setTimeout(() => r('fresh-gate'), 60)),
        ]);
        assert.equal(raced, 'fresh-gate', 'the stale click must not settle the in-flight wait');
        c.resolve({ approved: false });
    });

    it('a pre-aborted wait clears a pre-buffered approval for later runs', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        c.resolve({ approved: true });
        const ac = new AbortController();
        ac.abort(new Error('cancel'));
        await assert.rejects(c.wait({ signal: ac.signal }), (err) => err instanceof AbortedError);
        const p2 = c.wait();
        const raced = await Promise.race([
            p2.then(v => ({ served: v })),
            new Promise(r => setTimeout(() => r('fresh-gate'), 60)),
        ]);
        assert.equal(raced, 'fresh-gate', 'the buffered approval must be cleared by the abort');
        c.resolve({ approved: false });
    });

    it('a concurrent second wait() returns the in-flight promise (no orphan)', async () => {
        const c = new ApprovalCoordinator({ timeoutMs: 50_000 });
        const p1 = c.wait();
        const p2 = c.wait();
        assert.equal(p1, p2, 'the second wait must not orphan the first');
        c.resolve({ approved: true });
        assert.deepEqual(await p1, { approved: true });
    });
});

describe('WorkflowExecutor HITL abort-awareness', () => {
    /** @param {{signal: AbortSignal}} arg0 */
    function makeExecutor({ signal }) {
        const executor = new WorkflowExecutor({ options: {
            client: { session: () => ({ provider: 'OAI' }) },
            defaultModel: 'test-model',
            hitlTimeoutMs: 5_000,
            signal,
        } });
        executor.setSteps({ stepsList: [{
            id: 's1',
            title: 'gated step',
            systemPrompt: '',
            userPromptTemplate: 'do the thing',
            dependencies: [],
            hitl: true,
        }] });
        return executor;
    }

    it('an abort during the HITL wait cancels execute() fast instead of idling', async () => {
        const ac = new AbortController();
        const executor = makeExecutor({ signal: ac.signal });
        const hitlSeen = new Promise((resolve) => executor.once('workflow:hitl_pending', resolve));
        const start = Date.now();
        const run = executor.execute({ userGoal: 'goal' });
        await hitlSeen;
        ac.abort(new Error('user cancelled'));
        await assert.rejects(run, (err) =>
            err instanceof AbortedError && isAbortError({ err, signal: ac.signal }));
        assert.ok(Date.now() - start < 4_000, 'execute() must cancel fast, not idle the 5s HITL timeout');
    });
});
