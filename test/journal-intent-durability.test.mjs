// @ts-check
/**
 * G1-1 / G1-2: the journal's INTENT row reaches disk before the effect, and
 * `complete()` is recorded the moment the effect returns.
 *
 * Before the fix the journal was written only by whole-run checkpoint saves, so
 * a process crash mid-tool re-ran the side effect on restart; a post-`execute()`
 * hook that threw marked the row `failed`, and `failed` was always re-run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeTools, markToolErrorRetryable } from '../lib/tools/tool-execution.mjs';
import { ExecutionJournal, attachJournalSink, toolJournalKey } from '../lib/agentic/journal.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { JOURNAL_STATUS } from '../lib/agentic/journal.mjs';
import { HOOKS } from '../lib/core/hooks.mjs';

/** @param {string} name @param {Record<string, unknown>} args */
const call = (name, args) => ({ id: `c-${name}`, name, args });

/** @param {string} threadId */
function storeFor(threadId) {
    const dir = mkdtempSync(join(tmpdir(), 'merci-g11-'));
    return { store: new LocalFileSessionStore({ dir }), threadId };
}

test('the INTENT row is on disk when tool.execute() starts, and a restart refuses', async () => {
    const { store, threadId } = storeFor('t');
    const journal = new ExecutionJournal({ runId: 'r1' });
    attachJournalSink({ journal, store, threadId });

    /** @type {number|null} */
    let rowsAtExecute = null;
    /** @type {string|null} */
    let statusAtExecute = null;
    const first = {
        name: 'transfer',
        execute: async () => {
            const saved = /** @type {any} */ (await store.load(`${threadId}.journal`));
            rowsAtExecute = saved?.journal?.entries?.length ?? 0;
            statusAtExecute = saved?.journal?.entries?.[0]?.status ?? null;
            return { ok: true };
        },
    };
    await executeTools({ toolCalls: [call('transfer', { amount: 1 })], toolLibrary: [first], journal, boundary: 'step:0' });
    assert.equal(rowsAtExecute, 1, 'one intent row is durable before the effect');
    assert.equal(statusAtExecute, JOURNAL_STATUS.INTENT);

    // The process "crashes": the checkpoint is gone, only the sibling remains.
    const sibling = /** @type {any} */ (await store.load(`${threadId}.journal`))?.journal;
    // A restart has a fresh run id; the merge must adopt the persisted one or the
    // key hashes differently (A-1).
    const restored = new ExecutionJournal({ runId: 'restart-process' });
    restored.merge({ other: ExecutionJournal.fromJSON(sibling) });
    assert.equal(restored.runId, 'r1', 'the restored journal keeps the crashed run id');
    assert.equal(restored.entries()[0].status, JOURNAL_STATUS.INTENT);

    let ranAgain = false;
    const second = { name: 'transfer', execute: async () => { ranAgain = true; return { ok: true }; } };
    const results = /** @type {any[]} */ (await executeTools({ toolCalls: [call('transfer', { amount: 1 })], toolLibrary: [second], journal: restored, boundary: 'step:0' }));
    assert.equal(ranAgain, false, 'an in-flight side effect is never re-executed');
    assert.equal(results[0].success, false);
    assert.match(String(results[0].error), /unknown/i);
});

test('parallel tool calls persist both INTENT rows (A-2)', async () => {
    const { store, threadId } = storeFor('parallel');
    const journal = new ExecutionJournal({ runId: 'rp' });
    attachJournalSink({ journal, store, threadId });

    const slow = { name: 'slow', execute: async () => { await new Promise((r) => setTimeout(r, 40)); return 'a'; } };
    const fast = { name: 'fast', execute: async () => 'b' };
    await Promise.all([
        executeTools({ toolCalls: [call('slow', {})], toolLibrary: [slow], journal, boundary: 'p' }),
        executeTools({ toolCalls: [call('fast', {})], toolLibrary: [fast], journal, boundary: 'p' }),
    ]);

    const saved = /** @type {any} */ (await store.load(`${threadId}.journal`));
    const names = (saved?.journal?.entries ?? []).map((/** @type {any} */ e) => e.name).sort();
    assert.deepEqual(names, ['fast', 'slow'], 'one sink write must not clobber the other intent');
});

test('a post-execute hook failure keeps the row DONE, and a replay does not re-run', async () => {
    const journal = new ExecutionJournal({ runId: 'r2' });
    let runs = 0;
    const tool = { name: 'send_email', execute: async () => { runs += 1; return { sent: true }; } };
    const hooks = {
        runWaterfall: async (/** @type {{name: string}} */ { name }) => {
            if (name === HOOKS.TOOL_AFTER) throw new Error('audit sink down');
            return undefined;
        },
    };
    const first = /** @type {any[]} */ (await executeTools({ toolCalls: [call('send_email', {})], toolLibrary: [tool], journal, boundary: 'b', hooks: /** @type {any} */ (hooks) }));
    assert.equal(first[0].success, false, 'the observer error is reported to the caller');
    assert.equal(runs, 1);
    const row = journal.entries()[0];
    assert.equal(row.status, JOURNAL_STATUS.DONE, 'the effect completed before the observer failed');

    const replay = /** @type {any[]} */ (await executeTools({ toolCalls: [call('send_email', {})], toolLibrary: [tool], journal, boundary: 'b' }));
    assert.equal(runs, 1, 'the DONE row replays instead of re-sending');
    assert.equal(replay[0].success, true);
    assert.equal(replay[0].replayed, true);
});

test('a FAILED row is unknown state unless the tool is idempotent or the error is pre-effect', async () => {
    // Unknown-state failure: the tool ran and threw.
    const journal = new ExecutionJournal({ runId: 'r3' });
    let attempts = 0;
    const failing = {
        name: 'charge',
        execute: async () => { attempts += 1; throw new Error('connection dropped'); },
    };
    const first = /** @type {any[]} */ (await executeTools({ toolCalls: [call('charge', { a: 1 })], toolLibrary: [failing], journal, boundary: 'b' }));
    assert.equal(first[0].success, false);
    assert.equal(journal.entries()[0].status, JOURNAL_STATUS.FAILED);

    let ran = false;
    const blocked = /** @type {any[]} */ (await executeTools({
        toolCalls: [call('charge', { a: 1 })],
        toolLibrary: [{ name: 'charge', execute: async () => { ran = true; return {}; } }],
        journal, boundary: 'b',
    }));
    assert.equal(ran, false, 'a non-idempotent FAILED row is not re-executed');
    assert.equal(blocked[0].success, false);

    // A tool that marks its error as pre-effect may retry, and its effect runs
    // once: the first attempt threw before the effect started.
    const journal2 = new ExecutionJournal({ runId: 'r4' });
    let preEffectAttempts = 0;
    const preEffect = {
        name: 'charge',
        execute: async () => {
            preEffectAttempts += 1;
            throw markToolErrorRetryable(new Error('invalid args'));
        },
    };
    await executeTools({ toolCalls: [call('charge', { a: 2 })], toolLibrary: [preEffect], journal: journal2, boundary: 'b' });
    assert.equal(preEffectAttempts, 1, 'the pre-effect attempt is journaled failed');
    assert.equal(journal2.entries()[0].retryable, true, 'the row records that the effect did not start');
    let retried = false;
    await executeTools({
        toolCalls: [call('charge', { a: 2 })],
        toolLibrary: [{ name: 'charge', execute: async () => { retried = true; return {}; } }],
        journal: journal2, boundary: 'b',
    });
    assert.equal(retried, true, 'a pre-effect failure is safe to retry');
    assert.equal(preEffectAttempts, 1, 'the pre-effect failure ran no effect');

    // An idempotent tool always retries.
    const journal3 = new ExecutionJournal({ runId: 'r5' });
    const idem = { name: 'charge', idempotent: true, execute: async () => { throw new Error('boom'); } };
    await executeTools({ toolCalls: [call('charge', { a: 3 })], toolLibrary: [idem], journal: journal3, boundary: 'b' });
    let idemRan = false;
    await executeTools({
        toolCalls: [call('charge', { a: 3 })],
        toolLibrary: [{ name: 'charge', idempotent: true, execute: async () => { idemRan = true; return {}; } }],
        journal: journal3, boundary: 'b',
    });
    assert.equal(idemRan, true);
    assert.equal(attempts, 1);
});

// ─── the scheduler DAG runner wires the sink (G1-1, end to end) ──────────────

test('a scheduler DAG attempt writes the INTENT row before the tool runs', async () => {
    const { createEngineRunner } = await import('../lib/agentic/scheduler/runner.mjs');
    const { runAgenticLoop } = await import('../lib/agentic/agentic-core.mjs');
    const { RunContext } = await import('../lib/core/events.mjs');

    /** @type {Map<string, any>} */
    const files = new Map();
    const store = {
        async save(/** @type {{threadId: string, data: any}} */ { threadId, data }) { files.set(threadId, data); return threadId; },
        async load(/** @type {string} */ threadId) { return files.get(threadId) ?? null; },
    };

    /** @type {string|null} */
    let intentAtExecute = null;
    let runs = 0;
    const tool = {
        name: 'transfer',
        description: 'move money',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            intentAtExecute = files.get('MER-1-dag.journal')?.journal?.entries?.[0]?.status ?? null;
            return 'sent';
        },
    };

    let journalBound = false;
    const client = /** @type {any} */ ({
        provider: 'openai',
        emit() { return false; },
        session() {
            const session = /** @type {any} */ ({
                provider: 'openai',
                model: 'm',
                _tools: [tool],
                _lastRunUsage: null,
                _lastStepMessages: null,
                withSystemMessage() { return session; },
                withTools() { return session; },
                withTodos() { return session; },
                withParameters() { return session; },
                withMemory() { return session; },
                withPromptCache() { return session; },
                withCircuitBreaker() { return session; },
                withRetryPolicy() { return session; },
                withStreamTimeout() { return session; },
                withApproval() { return session; },
                withBudget() { return session; },
                /** @param {{messages: any[]}} arg0 */
                async *step({ messages }) {
                    // The objective-restatement pass opens its own session; only the
                    // journaled step session drives the tool round.
                    if (!session._journal) {
                        return { done: true, content: 'OBJ', messages: [...messages, { role: 'assistant', content: 'OBJ' }] };
                    }
                    runs += 1;
                    yield { type: 'quota', data: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
                    if (runs === 1) {
                        yield { type: 'tool_request', calls: [{ id: 'c1', name: 'transfer', args: { amount: 1 } }] };
                        const row = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'transfer', arguments: '{"amount":1}' } }] };
                        return { done: true, content: '', messages: [...messages, row] };
                    }
                    return { done: true, content: 'FINAL', messages: [...messages, { role: 'assistant', content: 'FINAL' }] };
                },
                async run(/** @type {any} */ args) {
                    journalBound = Boolean(args.options?.journal);
                    return runAgenticLoop({ session, messages: args.initialInput, opts: args.options ?? {} });
                },
            });
            return session;
        },
    });

    const runner = createEngineRunner({
        engine: 'dag',
        client,
        model: 'm',
        store,
        threadId: 'MER-1-dag',
        planFor: async () => ({ objective: 'ship', context: {}, steps: [{ id: 's1', title: 'S1', systemPrompt: 'S', userPromptTemplate: 'GO' }] }),
        tools: () => [tool],
    });
    const result = await runner.run(/** @type {any} */ ({
        item: { id: 'MER-1', identifier: 'MER-1', title: 'T', state: 'Todo' },
        attempt: null,
        workspace: null,
        signal: new AbortController().signal,
        runContext: new RunContext({ runId: 'run-dag-1' }),
        reportProgress() {},
    }));

    assert.equal(result.status, 'completed');
    assert.equal(intentAtExecute, JOURNAL_STATUS.INTENT, 'the sibling journal exists before the tool executes');
    const sibling = files.get('MER-1-dag.journal');
    assert.equal(sibling?.journal?.entries?.[0]?.status, JOURNAL_STATUS.INTENT, 'the sibling holds the durable intent');
    const checkpoint = /** @type {any} */ (files.get('MER-1-dag'));
    const saved = JSON.parse(checkpoint.checkpoint.payload);
    const rows = saved.journal?.entries ?? [];
    assert.ok(rows.some((/** @type {any} */ row) => row.status === JOURNAL_STATUS.DONE), 'and the resolved effect reaches the checkpoint');
});

test('parallel tool calls keep both INTENT rows durable (A-2)', async () => {
    const journal = new ExecutionJournal({ runId: 'parallel' });
    /** @type {any[]} */
    const writes = [];
    const store = {
        async save(/** @type {{threadId: string, data: any}} */ { data }) {
            // A slow write must not let an older snapshot land last.
            await new Promise((resolve) => setTimeout(resolve, 25));
            writes.push(data.journal);
        },
        async load() { return null; },
    };
    attachJournalSink({ journal, store, threadId: 'par' });
    const tool = (/** @type {string} */ name) => ({
        name,
        execute: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return 'ok'; },
    });
    await Promise.all([
        executeTools({ toolCalls: [call('alpha', {})], toolLibrary: [tool('alpha')], journal, boundary: 'b' }),
        executeTools({ toolCalls: [call('beta', {})], toolLibrary: [tool('beta')], journal, boundary: 'b' }),
    ]);
    const last = writes.at(-1);
    assert.ok(last, 'the sink wrote');
    assert.equal(last.entries.length, 2, `both intents survive in the last snapshot, got ${last.entries.length}`);
});

test('a read-only built-in retries after its failure cause is fixed (A-6)', async () => {
    const { createContextTools } = await import('../lib/tools/context-tools.mjs');
    const { mkdtempSync: mkdtemp, writeFileSync } = await import('node:fs');
    const { tmpdir: osTmp } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const root = mkdtemp(joinPath(osTmp(), 'merci-read-'));
    const tools = createContextTools({ options: { root } });
    const read = tools.find((/** @type {any} */ t) => t.name === 'read');
    assert.ok(read);
    assert.equal(read.idempotent, true);

    const journal = new ExecutionJournal({ runId: 'read-run' });
    const missing = { id: 'r1', name: 'read', args: { filePath: joinPath(root, 'later.txt') } };
    const first = /** @type {any[]} */ (await executeTools({ toolCalls: [missing], toolLibrary: tools, journal, boundary: 'read:0' }));
    assert.equal(first[0].success, false);
    writeFileSync(joinPath(root, 'later.txt'), 'now it exists\n');
    const second = /** @type {any[]} */ (await executeTools({ toolCalls: [missing], toolLibrary: tools, journal, boundary: 'read:0' }));
    assert.equal(second[0].success, true, 'the failed read is retried, not refused as unknown state');
});

test('a stale sibling from another run cannot hide a DONE row (J-1)', async () => {
    // A checkpoint journal already holds a completed effect under RUN-A.
    const checkpoint = new ExecutionJournal({ runId: 'RUN-A' });
    const key = toolJournalKey({ runId: 'RUN-A', boundary: 'b', name: 'transfer', args: {} });
    checkpoint.begin({ key, meta: { kind: 'tool', name: 'transfer', boundary: 'b', args: {} } });
    checkpoint.complete({ key, outcome: { success: true, result: 'sent-once' } });

    // A stale sibling from a different run on the same thread.
    const stale = new ExecutionJournal({ runId: 'RUN-B' });
    stale.begin({ key: 'other', meta: { kind: 'tool', name: 'transfer' } });

    checkpoint.merge({ other: stale });
    assert.equal(checkpoint.runId, 'RUN-A', 'the journal that already holds rows keeps its identity');
    assert.equal(checkpoint.get({ key })?.status, JOURNAL_STATUS.DONE);

    // The same call replays instead of re-running.
    let ran = false;
    const tool = { name: 'transfer', execute: async () => { ran = true; return 'again'; } };
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c', name: 'transfer', args: {} }],
        toolLibrary: [tool], journal: checkpoint, boundary: 'b',
    }));
    assert.equal(ran, false, 'the DONE effect is replayed, not repeated');
    assert.equal(results[0].success, true);
});
