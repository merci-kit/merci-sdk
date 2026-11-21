// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {{onRun: (history: any) => any}} arg0 */
function makeCaptureSession({ onRun }) {
    const stubSession = {
        withSystemMessage() { return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        /** @param {{initialInput: any}} arg0 */
        async run({ initialInput: history }) { return onRun(history); },
    };
    const session = new DiscussionSession({ client: { session: () => stubSession }, options: {} });
    session.addAgent({ name: 'alpha', model: 'm', provider: ProviderType.OPENAI });
    return session;
}

/** @param {any} session */
/** @param {{session: *, count?: *}} arg0 */
const seedLedger = ({ session, count = 3 }) => {
    for (let i = 0; i < count; i++) {
        session.appendLedger({ entries: [{ author: `a${i}`, content: `entry${i}`, type: 'discussion', thoughtSignature: null }] });
    }
};

describe('discussion tail summarization', () => {
    it('is a strict no-op when the ledger fits the tail window', async () => {
        let summarizeCalls = 0;
        const session = makeCaptureSession({ onRun: () => 'ok' });
        seedLedger({ session, count: 2 });
        await session.discuss({ instruction: 'final', tail: 2, summarize: async () => { summarizeCalls++; return 'S'; } });
        assert.equal(summarizeCalls, 0, 'nothing dropped → nothing summarized');
    });

    it('folds the dropped prefix into one summary message, summarized once per window', async () => {
        /** @type {any} */ let captured = null;
        /** @type {any[]} */
        const received = [];
        const session = makeCaptureSession({ onRun: (history) => { captured = history; return 'ok'; } });
        seedLedger({ session, count: 3 });
        await session.discuss({ instruction: 'final', tail: 2, summarize: async (/** @type {any} */ text) => { received.push(text); return 'SUMMARY TEXT'; } });
        assert.equal(received.length, 1, 'the dropped prefix must be summarized exactly once');
        assert.ok(received[0].includes('entry0'), 'the dropped prefix text feeds the summarizer');
        assert.equal(captured[0].role, 'user');
        assert.ok(captured[0].content.includes('Earlier discussion summary'));
        assert.ok(captured[0].content.includes('SUMMARY TEXT'));
        assert.ok(captured[1].content.includes('entry1'), 'the tail window follows the summary');
        assert.ok(captured[2].content.includes('entry2'));
    });

    it('marks the dropped prefix when the summarizer fails (never a silent drop)', async () => {
        /** @type {any} */ let captured = null;
        const session = makeCaptureSession({ onRun: (history) => { captured = history; return 'ok'; } });
        seedLedger({ session, count: 3 });
        await session.discuss({ instruction: 'final', tail: 2, summarize: async () => { throw new Error('down'); } });
        assert.equal(captured[0].role, 'user');
        assert.ok(!captured[0].content.includes('Earlier discussion summary'),
            'a failed summarizer must not fabricate a summary message');
        assert.ok(captured[0].content.includes('[Earlier discussion entries omitted]'),
            'the drop is marked, never silent (foldContext contract)');
        assert.ok(captured[0].content.includes('summariz'),
            'the failure is named (the discussion never-throw contract swallows the raw error)');
        assert.equal(captured[1].content, '[a1]: entry1', 'the tail window follows the marker');
    });

    it('re-summarizes when the dropped prefix grows (per-window memo)', async () => {
        const calls = [];
        const session = makeCaptureSession({ onRun: () => 'ok' });
        seedLedger({ session, count: 2 });
        await session.discuss({ instruction: 't1', tail: 1, summarize: async () => { calls.push(1); return 'S'; } });
        await session.discuss({ instruction: 't2', tail: 1, summarize: async () => { calls.push(1); return 'S'; } });
        assert.equal(calls.length, 2, 'each distinct dropped-count summarizes once, not per turn');
    });

    it('`summarize: true` uses the default LLM path without throwing on a stub-less setup', async () => {
        const session = makeCaptureSession({ onRun: () => 'ok' });
        seedLedger({ session, count: 3 });
        await session.discuss({ instruction: 'final', tail: 2, summarize: /** @type {any} */ (true) });
        assert.equal(session.getLedger().length, 4, 'the agent turn itself appends its entry');
    });
});
