// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ExecutionJournal, JOURNAL_STATUS, toolJournalKey, journalKey } from '../lib/agentic/journal.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

const CALL = { id: 'c1', name: 'count', arguments: '{"n":1}' };

/** @param {{ counter: { n: number } }} arg0 */
function countingTool({ counter }) {
    return {
        name: 'count',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        execute: async () => { counter.n++; return `count=${counter.n}`; },
    };
}

describe('ExecutionJournal', () => {
    it('replays a completed call instead of re-executing it', async () => {
        const journal = new ExecutionJournal();
        const counter = { n: 0 };
        const tool = countingTool({ counter });
        const opts = { journal, boundary: 'b1' };
        const [first] = /** @type {Array<any>} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [tool], signal: undefined, ...opts }));
        const [second] = /** @type {Array<any>} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [tool], signal: undefined, ...opts }));
        assert.equal(counter.n, 1, 'the side effect must run exactly once');
        assert.equal(first.result, 'count=1');
        assert.equal(second.result, 'count=1', 'the replayed result is the recorded one');
        assert.equal(second.replayed, true);
    });

    it('fails closed for an interrupted non-idempotent call', async () => {
        const journal = new ExecutionJournal();
        const counter = { n: 0 };
        journal.begin({ key: toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'count', args: { n: 1 } }), meta: { name: 'count' } });
        const [res] = /** @type {Array<any>} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [countingTool({ counter })], signal: undefined, journal, boundary: 'b1' }));
        assert.equal(counter.n, 0, 'unknown side-effect state must not be re-run');
        assert.equal(res.success, false);
        assert.match(res.error, /state is unknown/);
    });

    it('re-runs an interrupted idempotent call', async () => {
        const journal = new ExecutionJournal();
        const counter = { n: 0 };
        const tool = { ...countingTool({ counter }), idempotent: true };
        journal.begin({ key: toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'count', args: { n: 1 } }), meta: { name: 'count' } });
        const [res] = /** @type {Array<any>} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [tool], signal: undefined, journal, boundary: 'b1' }));
        assert.equal(counter.n, 1);
        assert.equal(res.success, true);
    });

    it('re-runs a failed call only when the tool is idempotent (G1-2)', async () => {
        const journal = new ExecutionJournal();
        let calls = 0;
        const tool = {
            name: 'count',
            // G1-2: a FAILED row is unknown state; only an idempotent tool (or an
            // error marked `retryable`) may run again.
            idempotent: true,
            parameters: { type: 'object', properties: { n: { type: 'number' } } },
            execute: async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; },
        };
        const opts = { journal, boundary: 'b1' };
        await executeTools({ toolCalls: [CALL], toolLibrary: [tool], signal: undefined, ...opts });
        const [res] = /** @type {Array<any>} */ (await executeTools({ toolCalls: [CALL], toolLibrary: [tool], signal: undefined, ...opts }));
        assert.equal(calls, 2, 'a failed entry is retryable');
        assert.equal(res.success, true);
    });

    it('journals status transitions (intent → done / interrupted)', async () => {
        const journal = new ExecutionJournal();
        const key = toolJournalKey({ runId: journal.runId, boundary: 'b9', name: 'x', args: {} });
        journal.begin({ key, meta: { name: 'x' } });
        assert.equal(journal.get({ key })?.status, JOURNAL_STATUS.INTENT);
        journal.complete({ key, outcome: { success: true, result: 'r' } });
        assert.equal(journal.get({ key })?.status, JOURNAL_STATUS.DONE);
        const restored = ExecutionJournal.fromJSON(JSON.parse(JSON.stringify(journal.toJSON())));
        assert.equal(restored.get({ key })?.status, JOURNAL_STATUS.DONE);
    });

    it('fromJSON returns a live journal instance instead of throwing on its shape (W2C-10)', () => {
        const journal = new ExecutionJournal();
        const key = toolJournalKey({ runId: journal.runId, boundary: 'b10', name: 'x', args: {} });
        journal.begin({ key, meta: { name: 'x' } });

        assert.equal(ExecutionJournal.fromJSON(journal), journal, 'a live instance is already restored');
        assert.throws(() => ExecutionJournal.fromJSON({ version: 1, entries: 'nope' }), /entries must be an array/, 'a plain object keeps the version check');
    });

    it('two Date arguments are not the same key', () => {
        // `JSON.stringify` turned both into the ISO string, so two different
        // timestamps shared one idempotency key (G1-10).
        const a = journalKey({ parts: [{ at: new Date(0) }] });
        const b = journalKey({ parts: [{ at: new Date(1_000) }] });
        assert.notEqual(a, b);
    });

    it('a Map argument is refused', () => {
        assert.throws(() => journalKey({ parts: [{ m: new Map([['a', 1]]) }] }), ConfigurationError);
    });

    it('a BigInt argument fails with ConfigurationError', () => {
        assert.throws(
            () => journalKey({ parts: [{ n: 10n }] }),
            (error) => error instanceof ConfigurationError && error.nonRetryable === true
        );
    });
});

describe('whole-run retry journal integration', () => {
    it("the in-flight step's tool round is not duplicated", async () => {
        const counter = { n: 0 };
        const tool = countingTool({ counter });
        const transient = () => Object.assign(new Error('vendor exploded mid-run'), { status: 500 });
        let calls = 0;
        /** @type {any} */
        const session = {
            provider: 'OAI',
            model: 'test-model',
            _tools: [tool],
            _retryPolicy: undefined,
            eventEmitter: { emit: () => {} },
            /**
             * @param {{messages: *}} arg0
             * @returns {AsyncGenerator<any, any, any>}
             */
            async *step({ messages }) {
                const n = calls++;
                if (n === 0) {
                    yield { type: 'tool_request', calls: [CALL] };
                    throw transient();
                }
                if (n === 1) {
                    const results = yield { type: 'tool_request', calls: [CALL] };
                    return {
                        done: false,
                        messages: [...messages,
                            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: '{"n":1}' } }] },
                            ...(results ?? []).map((/** @type {any} */ r) => ({ role: 'tool', tool_call_id: r.tool_call_id, name: 'count', content: String(r.result) })),
                        ],
                        thoughtSignature: null,
                    };
                }
                return { done: true, content: 'final answer', messages, thoughtSignature: null };
            },
        };

        const answer = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }),
        } });

        assert.equal(answer, 'final answer');
        assert.equal(counter.n, 1, 'the retried attempt must replay the tool result, not re-run the side effect');
    });
});
