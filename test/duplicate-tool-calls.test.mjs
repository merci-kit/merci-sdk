// @ts-check
/**
 * Two identical calls in one model round share a journal key unless the key
 * counts occurrences. The second call then sees the first one's INTENT row and
 * is refused as "side-effect state unknown", so a legitimate duplicate never
 * runs. n = 0 keeps the old key, so stored journals stay valid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';

function countingTool(/** @type {{n: number}} */ counter) {
    return {
        name: 'count',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        execute: async () => { counter.n += 1; return `count=${counter.n}`; },
    };
}

const CALL = { id: 'c1', name: 'count', arguments: '{"n":1}' };

test('two identical calls in one round both execute', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const calls = [CALL, { ...CALL, id: 'c2' }];
    const results = /** @type {any[]} */ (await executeTools({ toolCalls: calls, toolLibrary: [countingTool(counter)], journal, boundary: 'b1' }));
    assert.equal(counter.n, 2, 'both calls ran');
    assert.deepEqual(results.map((r) => r.result), ['count=1', 'count=2']);
    assert.ok(results.every((r) => r.success !== false));
});

test('replaying the round replays both duplicate calls', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const calls = [CALL, { ...CALL, id: 'c2' }];
    const toolLibrary = [countingTool(counter)];
    await executeTools({ toolCalls: calls, toolLibrary, journal, boundary: 'b1' });
    const replayed = /** @type {any[]} */ (await executeTools({ toolCalls: calls, toolLibrary, journal, boundary: 'b1' }));
    assert.equal(counter.n, 2, 'the replay ran nothing');
    assert.deepEqual(replayed.map((r) => r.result), ['count=1', 'count=2']);
    assert.ok(replayed.every((r) => r.replayed === true));
});

test('the first occurrence keeps the pre-0.9 key, so an existing journal still replays', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const toolLibrary = [countingTool(counter)];
    await executeTools({ toolCalls: [CALL], toolLibrary, journal, boundary: 'b1' });
    const [first] = journal.entries();
    // The single-call key is unchanged from the previous release.
    const { toolJournalKey } = await import('../lib/agentic/journal.mjs');
    assert.equal(first.key, toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'count', args: { n: 1 } }));
});

test('calls that differ only in whitespace are still the same call, twice', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const calls = [CALL, { ...CALL, id: 'c2', arguments: '{ "n": 1 }' }];
    const results = /** @type {any[]} */ (await executeTools({ toolCalls: calls, toolLibrary: [countingTool(counter)], journal, boundary: 'b1' }));
    assert.equal(counter.n, 2, 'both calls ran');
    assert.deepEqual(results.map((r) => r.result), ['count=1', 'count=2']);
});

test('an object args and the same JSON string are one call, twice', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const calls = [CALL, { ...CALL, id: 'c2', arguments: { n: 1 } }];
    await executeTools({ toolCalls: calls, toolLibrary: [countingTool(counter)], journal, boundary: 'b1' });
    assert.equal(counter.n, 2);
});

test('different arguments still get different keys', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const calls = [CALL, { ...CALL, id: 'c2', arguments: '{"n":2}' }];
    await executeTools({ toolCalls: calls, toolLibrary: [countingTool(counter)], journal, boundary: 'b1' });
    assert.equal(counter.n, 2);
    assert.equal(journal.entries().length, 2);
});
