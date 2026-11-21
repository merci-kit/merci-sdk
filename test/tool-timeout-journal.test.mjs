// @ts-check
/**
 * A tool that gives up with its own timeout signal's reason rejects with a
 * DOMException named `TimeoutError`, which is not an abort error. The journal
 * recorded it as a clean failure, so the retry re-ran a call whose side effect
 * may already have happened. The signal itself is the evidence: if the
 * per-tool timeout signal is aborted, the entry is INTERRUPTED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ExecutionJournal, JOURNAL_STATUS } from '../lib/agentic/journal.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';

const CALL = { id: 'c1', name: 'slow', arguments: '{}' };

/** A tool that rejects with `signal.reason` once its per-tool timeout fires. */
function signalReasonTool(/** @type {{calls: number}} */ counter) {
    return {
        name: 'slow',
        parameters: { type: 'object', properties: {} },
        timeoutMs: 20,
        /** @param {{signal: AbortSignal}} arg0 */
        execute: async ({ signal }) => {
            counter.calls += 1;
            await new Promise((_resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('the tool never timed out')), 5000);
                signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
            });
            return 'never';
        },
    };
}

test('a tool rejecting with its timeout signal reason is journaled as interrupted', async () => {
    const journal = new ExecutionJournal();
    const counter = { calls: 0 };
    const [res] = /** @type {any[]} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [signalReasonTool(counter)], journal, boundary: 'b1' }));
    assert.equal(res.success, false);
    const [entry] = journal.entries();
    assert.equal(entry.status, JOURNAL_STATUS.INTERRUPTED, `got ${entry.status}: ${JSON.stringify(entry)}`);
});

test('an interrupted timeout is not re-executed on the next round', async () => {
    const journal = new ExecutionJournal();
    const counter = { calls: 0 };
    const toolLibrary = [signalReasonTool(counter)];
    await executeTools({ toolCalls: [CALL], toolLibrary, journal, boundary: 'b1' });
    const [again] = /** @type {any[]} */ (await executeTools({ toolCalls: [CALL], toolLibrary, journal, boundary: 'b1' }));
    assert.equal(counter.calls, 1, 'the unknown-state call must not run twice');
    assert.equal(again.success, false);
    assert.match(again.error, /state is unknown/);
});

test('a plain tool error is still a failed entry, not an interrupted one', async () => {
    const journal = new ExecutionJournal();
    const tool = {
        name: 'slow',
        parameters: { type: 'object', properties: {} },
        execute: async () => { throw new Error('boom'); },
    };
    const [res] = /** @type {any[]} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [tool], journal, boundary: 'b1' }));
    assert.equal(res.success, false);
    const [entry] = journal.entries();
    assert.equal(entry.status, JOURNAL_STATUS.FAILED);
});
