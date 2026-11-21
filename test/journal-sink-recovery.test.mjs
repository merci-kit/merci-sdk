// @ts-check
/**
 * NEW-1: a transient sink failure must not poison the journal's write chain.
 * The failed call still fails closed, but the next call retries the store
 * instead of rethrowing the stale error forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeTools } from '../lib/tools/tool-execution.mjs';
import { ExecutionJournal, attachJournalSink } from '../lib/agentic/journal.mjs';

/** @param {string} name @param {Record<string, unknown>} args */
const call = (name, args) => ({ id: `c-${name}`, name, args });

test('a transient sink failure is retried by the next call instead of poisoning the chain', async () => {
    const journal = new ExecutionJournal({ runId: 'r-recover' });
    let saveCalls = 0;
    const store = {
        async save() {
            saveCalls += 1;
            if (saveCalls === 1) throw new Error('disk full');
        },
        async load() { return null; },
    };
    attachJournalSink({ journal, store, threadId: 'recover' });

    let ran = false;
    const tool = { name: 'transfer', execute: async () => { ran = true; return { ok: true }; } };

    const first = /** @type {any[]} */ (await executeTools({
        toolCalls: [call('transfer', { amount: 1 })], toolLibrary: [tool], journal, boundary: 'b',
    }));
    assert.equal(first[0].success, false, 'the call whose intent could not be persisted is refused');
    assert.equal(ran, false, 'the effect never runs without a durable intent');

    const second = /** @type {any[]} */ (await executeTools({
        toolCalls: [call('transfer', { amount: 2 })], toolLibrary: [tool], journal, boundary: 'b',
    }));
    assert.ok(saveCalls >= 2, `the recovered store is written again, saveCalls=${saveCalls}`);
    assert.equal(second[0].success, true, 'the later call persists its intent');
    assert.equal(ran, true, 'and its effect runs');
});
