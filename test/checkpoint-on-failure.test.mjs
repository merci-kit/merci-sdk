// @ts-check
/**
 * A failed run must still persist what it committed. `_runOnce` saved the
 * checkpoint only after `runAgenticLoop` resolved, so any throw — a blocked
 * output, a tool error, an abort — discarded the journal rows of every tool
 * round that had already run, and a resume replayed their side effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { InMemorySessionStore } from '../lib/agentic/sessions.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/**
 * A session whose model calls `write_file` once, then answers with text the
 * output guard refuses.
 * @param {{rules?: any[], toolThrows?: boolean}} [options]
 */
function failingSession(options = {}) {
    const { rules = [{ name: 'no-secret', phase: 'output', pattern: 'SECRET-ANSWER' }], toolThrows = false } = options;
    let call = 0;
    const session = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    session._streamTimeoutPolicy = {};
    session._adapter = {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
        executeVendorRequest: async () => {
            call += 1;
            const round = call;
            return (async function* () {
                if (round === 1) yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'write_file', args: { path: '/tmp/x', text: 'SIDE-EFFECT' } }] };
                else yield { type: 'text', content: 'SECRET-ANSWER' };
            })();
        },
        consumeStream: (/** @type {any} */ { rawStream }) => rawStream,
        formatToolCall: (/** @type {any} */ { call: c }) => c,
    };
    session.withTools({ tools: [{
        name: 'write_file',
        description: 'w',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            if (toolThrows) throw new Error('tool exploded');
            return 'wrote SIDE-EFFECT';
        },
    }] });
    session.withGuardrails({ rules });
    return session;
}

test('a run that throws after a tool round leaves the DONE journal rows in the store', async () => {
    const store = new InMemorySessionStore();
    const session = failingSession();
    session.withSessionStore({ store, threadId: 'failed-run' });
    session.withExecutionJournal({ journal: new ExecutionJournal({ runId: 'jrn_failed' }) });

    await assert.rejects(session.run({ initialInput: 'go' }), /Guardrail/);

    const saved = /** @type {any} */ (await store.load('failed-run'));
    assert.ok(saved, 'the failed run wrote a checkpoint');
    const entries = /** @type {any[]} */ (saved.journal?.entries ?? []);
    const done = entries.filter((/** @type {any} */ entry) => entry.status === 'done');
    assert.ok(done.length >= 1, `expected a DONE journal row, got ${JSON.stringify(entries.map((/** @type {any} */ e) => e.status))}`);
    assert.ok(done.some((/** @type {any} */ entry) => JSON.stringify(entry).includes('SIDE-EFFECT')));
    assert.ok(Array.isArray(saved.messages) && saved.messages.length > 0, 'the transcript is saved too');
});

test('a tool error is contained as a row, so the run itself still succeeds', async () => {
    const store = new InMemorySessionStore();
    const session = failingSession({ rules: [], toolThrows: true });
    session.withSessionStore({ store, threadId: 'tool-failed' });

    await session.run({ initialInput: 'go' });

    const saved = /** @type {any} */ (await store.load('tool-failed'));
    assert.ok(saved, 'the successful run wrote a checkpoint');
    assert.match(JSON.stringify(saved.messages), /tool exploded/, 'the model saw the failure');
});

test('a successful run still saves exactly one conversation checkpoint', async () => {
    const store = new InMemorySessionStore();
    /** @type {string[]} */
    const saves = [];
    const counting = /** @type {any} */ ({
        async save(/** @type {any} */ args) { saves.push(String(args.threadId)); return store.save(args); },
        async load(/** @type {string} */ threadId) { return store.load(threadId); },
    });
    const session = failingSession({ rules: [] });
    session.withSessionStore({ store: counting, threadId: 'ok-run' });
    await session.run({ initialInput: 'go' });
    // G1-1 adds one sibling write per tool call (`<thread>.journal`) so the
    // INTENT row survives a crash; the conversation checkpoint is still one.
    assert.equal(saves.filter((id) => id === 'ok-run').length, 1);
    assert.deepEqual(saves.filter((id) => id !== 'ok-run'), ['ok-run.journal']);
});
