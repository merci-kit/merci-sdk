// @ts-check

/**
 * Wave 9 / B6 — journal rows say what they are: step, arguments, order and cost.
 *
 * The row used to carry `kind` and `name` only — the boundary and the arguments were
 * hashed into the key and then thrown away, order was Map insertion order with a
 * millisecond timestamp that collides inside a parallel wave, and a row had no place
 * for usage. None of that can answer "what did this step's tool call actually do".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ExecutionJournal, toolJournalKey } from '../lib/agentic/journal.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { RunContext } from '../lib/core/events.mjs';

/** @param {string} name @param {{idempotent?: boolean}} [extra] */
const tool = (name, extra = {}) => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...extra,
});

test('B6/seq: rows carry a monotonic ordering id that survives a checkpoint', () => {
    const journal = new ExecutionJournal({ runId: 'run-1' });
    journal.begin({ key: 'a', meta: { kind: 'tool', name: 'one' } });
    journal.begin({ key: 'b', meta: { kind: 'tool', name: 'two' } });
    assert.deepEqual(journal.entries().map((e) => e.seq), [1, 2]);

    const restored = ExecutionJournal.fromJSON(JSON.parse(JSON.stringify(journal.toJSON())));
    assert.deepEqual(restored.entries().map((e) => e.seq), [1, 2], 'the order is durable');
    restored.begin({ key: 'c', meta: { kind: 'tool', name: 'three' } });
    assert.equal(restored.entries().at(-1)?.seq, 3, 'the sequence continues after the restored high-water mark');
});

test('B6/row: a tool row names its step, arguments and run lineage', async () => {
    const journal = new ExecutionJournal({ runId: 'run-2' });
    const runContext = new RunContext({ runId: 'child-run', parentRunId: 'parent-run', sessionId: 'conv-9' });
    await executeTools({
        toolCalls: [{ id: 'call-1', name: 'write_file', args: { path: 'a.txt' } }],
        toolLibrary: [tool('write_file')],
        journal,
        boundary: 'step:build',
        runContext,
    });
    const row = journal.entries().find((e) => e.kind === 'tool');
    assert.ok(row, 'the call is journaled');
    assert.equal(row.boundary, 'step:build', 'the step/branch is on the row');
    assert.deepEqual(row.args, { path: 'a.txt' }, 'so are the arguments');
    assert.equal(row.sessionId, 'conv-9');
    assert.equal(row.parentRunId, 'parent-run');
    assert.equal(row.status, 'done');
});

test('B6/usage: a completed row can carry what it cost', () => {
    const journal = new ExecutionJournal({ runId: 'run-3' });
    journal.begin({ key: 'step-row', meta: { kind: 'step', name: 'build' } });
    journal.complete({ key: 'step-row', outcome: { success: true }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    assert.deepEqual(journal.get({ key: 'step-row' })?.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.equal(journal.get({ key: 'step-row' })?.seq, 1);
});

test('B6/key: the row is still keyed by boundary + args, so two steps cannot replay each other', () => {
    const one = toolJournalKey({ runId: 'r', boundary: 'step:a', name: 'write_file', args: { path: 'x' } });
    const two = toolJournalKey({ runId: 'r', boundary: 'step:b', name: 'write_file', args: { path: 'x' } });
    assert.notEqual(one, two);
});
