// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { runAgenticLoop, compactHistory } from '../lib/agentic/agentic-core.mjs';
import { estimateTokens } from '../lib/support/utils.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { normalizeToOAI, normalizeToAAI, normalizeToGAI } from '../lib/messaging/messages.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { CONVERSATION_SUMMARY_MARKER } from '../lib/core/prompts.mjs';

/** @typedef {import('../lib/messaging/messages.mjs').MessageRow} MessageRow */

/** @param {{id: string}} arg0 */
/** @param {{id: *}} arg0 */
const TOOL_CALL = ({ id }) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
});
/** @param {{id: string, text: string}} arg0 */
/** @param {{id: *, text: *}} arg0 */
const TOOL_RESULT = ({ id, text }) => ({ role: 'tool', tool_call_id: id, name: 'read', content: text });

/** @param {{history: any}} arg0 @returns {any} */
function makeLoopSession({ history }) {
    const stepCalls = /** @type {any[]} */ ([]);
    let calls = 0;
    const session = {
        provider: 'OAI',
        model: 'test-model',
        _tools: [],
        eventEmitter: { emit: () => {} },
        stepCalls,
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            stepCalls.push(messages.map(m => ({ ...m })));
            calls++;
            if (calls === 1) return { done: false, messages: history, thoughtSignature: null };
            if (calls === 2) {
                const extra = [TOOL_CALL({ id: 'call_2' }), TOOL_RESULT({ id: 'call_2', text: 'more contents' })];
                return { done: false, messages: [...messages, ...extra], thoughtSignature: null };
            }
            return { done: true, content: 'final answer', messages, thoughtSignature: null };
        },
    };
    return session;
}

function buildHistory() {
    return [
        createUserMessage({ provider: 'OAI', content: 'first question' }),
        TOOL_CALL({ id: 'call_1' }),
        TOOL_RESULT({ id: 'call_1', text: 'file contents' }),
        createUserMessage({ provider: 'OAI', content: 'second question' }),
    ];
}

describe('estimateTokens', () => {
    it('is a lightweight char-based estimator', () => {
        assert.equal(estimateTokens({ text: '' }), 0);
        assert.equal(estimateTokens({ text: 'abcd' }), 1);
        assert.equal(estimateTokens({ text: 'abcdefgh' }), 2);
        assert.equal(estimateTokens({ text: null }), 0);
    });
    it('sums message content for unified-message arrays', () => {
        assert.equal(estimateTokens({ text: [{ content: 'abcd' }, { content: 'efgh' }] }), 2);
        assert.equal(estimateTokens({ text: [{ content: 'abcd' }, { role: 'tool', content: '1234' }] }), 2);
    });
});

describe('runAgenticLoop compaction', () => {
    it('folds the summarized prefix into a system message at the last user turn', async () => {
        const summaries = /** @type {any[]} */ ([]);
        const session = makeLoopSession({ history: buildHistory() });
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 5,
            compaction: {
                thresholdTokens: 5,
                summarize: /** @type {(prefix: any) => Promise<string>} */ (async (prefix) => { summaries.push(prefix); return 'SUMMARY'; }),
            },
        } });

        const step2Input = session.stepCalls[1];
        assert.ok(step2Input, 'loop must run a second step');
        assert.equal(step2Input[0].role, 'system');
        assert.ok(step2Input[0].content.includes(CONVERSATION_SUMMARY_MARKER));
        assert.ok(step2Input[0].content.includes('SUMMARY'));
        assert.equal(step2Input[1].content, 'second question');
        assert.equal(step2Input.length, 2, 'the tool round belongs to the prefix, not the tail');

        assert.equal(summaries.length, 1);
        assert.deepEqual((/** @type {Array<Record<string, any>>} */ (summaries[0])).map(m => m.role || m.type), ['user', 'assistant', 'tool'],
            'the summarized prefix is exactly the old user turn and its tool round');
        assert.ok(!(/** @type {Array<Record<string, any>>} */ (step2Input)).some(m => m.tool_calls), 'a tool round must never be split by the cut');
    });

    it('is idempotent: a summary marker stops re-summarization', async () => {
        const session = makeLoopSession({ history: buildHistory() });
        /** @param {{prefix: *}} arg0 */
        const summarize = /** @type {(prefix: any) => Promise<string>} */ (async ({ prefix }) => 'SUMMARY');
        let summarizeCalls = 0;
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 5,
            compaction: {
                thresholdTokens: 0,
                summarize: /** @type {(prefix: any) => Promise<string>} */ (async (prefix) => { summarizeCalls++; return 'SUMMARY'; }),
            },
        } });
        assert.equal(summarizeCalls, 1, 'the compacted history must not be re-summarized');
        assert.ok(session.stepCalls[2][0].content.includes(CONVERSATION_SUMMARY_MARKER));
    });

    it('re-compacts after new turns arrive (sequential folds)', async () => {
        let summarizeCalls = 0;
        const compaction = {
            thresholdTokens: 5,
            summarize: /** @type {(prefix: any) => Promise<string>} */ (async (prefix) => {
                summarizeCalls++;
                return `SUMMARY-${summarizeCalls}`;
            }),
        };
        const first = [
            createUserMessage({ provider: 'OAI', content: 'q1 '.repeat(20) }),
            { role: 'assistant', content: 'a1 '.repeat(20) },
            createUserMessage({ provider: 'OAI', content: 'q2 '.repeat(20) }),
        ];
        const folded = await compactHistory(/** @type {{ messages: MessageRow[]; compaction: any; session: any; signal: any; onEvent: any; }} */ ({ messages: first, compaction }));
        assert.ok(String(folded[0].content).includes(CONVERSATION_SUMMARY_MARKER));
        assert.equal(summarizeCalls, 1);

        const noop = await compactHistory(/** @type {{ messages: MessageRow[]; compaction: any; session: any; signal: any; onEvent: any; }} */ ({ messages: folded, compaction }));
        assert.equal(noop, folded, 'nothing new arrived — same history reference');
        assert.equal(summarizeCalls, 1);

        const grown = [
            ...folded,
            { role: 'assistant', content: 'a2 '.repeat(20) },
            createUserMessage({ provider: 'OAI', content: 'q3 '.repeat(20) }),
        ];
        const refolded = await compactHistory(/** @type {{ messages: MessageRow[]; compaction: any; session: any; signal: any; onEvent: any; }} */ ({ messages: grown, compaction }));
        assert.equal(summarizeCalls, 2, 'a new user turn past the threshold re-compacts');
        assert.ok(String(refolded[0].content).includes(CONVERSATION_SUMMARY_MARKER));
        assert.ok(String(refolded[0].content).includes('SUMMARY-2'));
        assert.equal(refolded[refolded.length - 1].content, 'q3 '.repeat(20), 'the new tail survives');
    });

    it('compacts on the reported prompt tokens, not the row estimate', async () => {
        const messages = buildHistory();
        const compaction = { thresholdTokens: 10_000, keepRecent: 1, summarize: /** @type {(p: any) => Promise<string>} */ (async () => 'SUMMARY') };
        const unchanged = await compactHistory({ messages, compaction, session: /** @type {any} */ ({}), signal: null, onEvent: null });
        assert.equal(unchanged, messages, 'the row estimate is under the threshold');

        const folded = await compactHistory({ messages, compaction, session: /** @type {any} */ ({}), signal: null, onEvent: null, promptTokens: 50_000 });
        assert.notEqual(folded, messages, 'the reported prompt size crosses the threshold');
        assert.ok(String(folded[0].content).includes(CONVERSATION_SUMMARY_MARKER));
    });

    it('a small reported prompt size wins over a large row estimate', async () => {
        const messages = buildHistory();
        const compaction = { thresholdTokens: 5, keepRecent: 1, summarize: /** @type {(p: any) => Promise<string>} */ (async () => 'SUMMARY') };
        const unchanged = await compactHistory({ messages, compaction, session: /** @type {any} */ ({}), signal: null, onEvent: null, promptTokens: 3 });
        assert.equal(unchanged, messages, 'the backend-reported size is authoritative');
    });

    it('keeps a loss marker when the summarizer fails', async () => {
        const session = makeLoopSession({ history: buildHistory() });
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 5,
            compaction: {
                thresholdTokens: 5,
                summarize: /** @type {(prefix: any) => Promise<string>} */ (async () => { throw new Error('summarizer down'); }),
            },
        } });
        const step2Input = session.stepCalls[1];
        assert.equal(step2Input[0].role, 'system', 'a marker system message is prepended to the tail');
        assert.ok(step2Input[0].content.includes(CONVERSATION_SUMMARY_MARKER),
            'the marker tells the model context was dropped (never a silent delete)');
        assert.ok(step2Input[0].content.includes('summarizer down'), 'the failure reason is surfaced');
        assert.equal(step2Input[1].content, 'second question', 'the tail survives');
    });

    it('is a strict no-op when the option is absent', async () => {
        const session = makeLoopSession({ history: buildHistory() });
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 5 } });
        const step2Input = session.stepCalls[1];
        assert.equal(step2Input[0].role, 'user', 'history must pass through untouched without opts.compaction');
        assert.equal(step2Input.length, 4);
    });

    it('the compacted history stays wire-valid on every backend', () => {
        const compacted = [
            { role: 'system', content: `${CONVERSATION_SUMMARY_MARKER}\n\nSUMMARY` },
            createUserMessage({ provider: 'OAI', content: 'second question' }),
        ];
        const oai = normalizeToOAI({ model: 'gpt-4o', msgs: compacted });
        assert.equal(oai.length, 2);
        assert.equal(oai[0].role, 'system');
        assert.equal(oai[1].role, 'user');
        assert.doesNotThrow(() => normalizeToAAI({ msgs: compacted }));
        assert.doesNotThrow(() => normalizeToGAI({ msgs: compacted }));
    });

    it('the summary message survives the per-step system-slot rebuild (real session)', async () => {
        const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
        const session = new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
        session.withSystemMessage('BASE SYSTEM');
        let captured = /** @type {any} */ (null);
        const orig = session._adapter.buildVendorRequest;
        session._adapter.buildVendorRequest = /** @type {(args: any) => any} */ ((args) => {
            captured = args.preparedMessages;
            return orig(args);
        });
        const history = [
            { role: 'system', content: `${CONVERSATION_SUMMARY_MARKER}\n\nSUMMARY` },
            createUserMessage({ provider: 'OAI', content: 'second question' }),
        ];
        const gen = session.step({ messages: history });
        while (!(await gen.next()).done) { /* drain */ }
        assert.ok(captured, 'the vendor request must have been built');
        assert.ok(String(captured[0].content).includes(CONVERSATION_SUMMARY_MARKER),
            '_prepareStepMessages must fold the summary into the rebuilt system message, not drop it');
        assert.ok(String(captured[0].content).includes('SUMMARY'));
        assert.ok(String(captured[0].content).includes('BASE SYSTEM'));
    });
});

// ─── Blind A/B report (BLIND_REPORT=1) ────────────────────────────────────
if (process.env.BLIND_REPORT) {
    const transcript = /** @type {Array<Record<string, any>>} */ ([]);
    for (let i = 0; i < 40; i++) {
        transcript.push(createUserMessage({ provider: 'OAI', content: `user question number ${i} about topic alpha beta gamma` }));
        transcript.push({ role: 'assistant', content: `answer number ${i} with supporting details and reasoning` });
    }

    const cutIndex = transcript.reduce((last, m, i) => (m.role === 'user' ? i : last), -1);
    const prefix = transcript.slice(0, cutIndex);
    const tail = transcript.slice(cutIndex);

    /** @param {{prefix: *}} arg0 */
    const fakeSummarizer = /** @type {(arg0: {prefix: Array<Record<string, any>>}) => string} */ (({ prefix }) => `Earlier user goals:\n`
        + prefix.filter(m => m.role === 'user').map((m, i) => `${i + 1}. ${m.content}`).join('\n'));

    const summary = fakeSummarizer({ prefix });
    const summaryMsg = { role: 'system', content: `${CONVERSATION_SUMMARY_MARKER}\n\n${summary}` };

    const implA = {
        messages: [summaryMsg, ...tail],
        prefixSummarized: prefix.length,
        tailKept: tail.length,
        summaryTokens: estimateTokens({ text: summaryMsg }),
        tailTokens: estimateTokens({ text: tail }),
    };
    const implB = {
        messages: tail,
        prefixDropped: prefix.length,
        tailKept: tail.length,
        tailTokens: estimateTokens({ text: tail }),
    };

    const report = [{
        scenario: 'long-transcript compaction',
        input: { messages: transcript.length, turns: transcript.filter(m => m.role === 'user').length },
        implA_summarize_keepTail: implA,
        implB_naiveTruncate: implB,
    }];

    const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratchpad');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'blind-report-compaction.json'), JSON.stringify(report, null, 2));
    console.log(`[blind-report] wrote scratchpad/blind-report-compaction.json (${report.length} scenarios)`);
}

describe('context editing — clearToolResults', () => {
    it('replaces old tool payloads and keeps the last N', async () => {
        const messages = [
            createUserMessage({ provider: 'OAI', content: 'go' }),
            TOOL_CALL({ id: 'call_1' }), TOOL_RESULT({ id: 'call_1', text: 'payload one' }),
            TOOL_CALL({ id: 'call_2' }), TOOL_RESULT({ id: 'call_2', text: 'payload two' }),
            TOOL_CALL({ id: 'call_3' }), TOOL_RESULT({ id: 'call_3', text: 'payload three' }),
        ];
        const out = await compactHistory({
            messages,
            compaction: { thresholdTokens: 1_000_000, clearToolResults: { keepRecent: 1, placeholder: 'GONE' } },
            session: /** @type {any} */ ({}),
            signal: null,
            onEvent: null,
        });
        const results = out.filter((m) => m.role === 'tool');
        assert.deepEqual(results.map((m) => m.content), ['GONE', 'GONE', 'payload three']);
        assert.deepEqual(results.map((m) => m.tool_call_id), ['call_1', 'call_2', 'call_3'], 'the call/result pairing survives');
        assert.equal(messages[1].role, 'assistant', 'the input array is not mutated');
    });

    it('does nothing when every result is within keepRecent', async () => {
        const messages = [createUserMessage({ provider: 'OAI', content: 'go' }), TOOL_CALL({ id: 'c1' }), TOOL_RESULT({ id: 'c1', text: 'x' })];
        const out = await compactHistory({
            messages,
            compaction: { thresholdTokens: 1_000_000, clearToolResults: { keepRecent: 5 } },
            session: /** @type {any} */ ({}),
            signal: null,
            onEvent: null,
        });
        assert.equal(out, messages, 'the same array comes back when nothing is cleared');
    });

    it('clearing can bring the history under the threshold and skip the fold', async () => {
        let summaries = 0;
        const messages = [
            createUserMessage({ provider: 'OAI', content: 'go' }),
            TOOL_CALL({ id: 'c1' }), TOOL_RESULT({ id: 'c1', text: 'x'.repeat(2000) }),
            TOOL_CALL({ id: 'c2' }), TOOL_RESULT({ id: 'c2', text: 'short' }),
        ];
        const out = await compactHistory({
            messages,
            compaction: {
                thresholdTokens: 100,
                keepRecent: 1,
                clearToolResults: { keepRecent: 1 },
                summarize: async () => { summaries += 1; return 'SUMMARY'; },
            },
            session: /** @type {any} */ ({}),
            signal: null,
            onEvent: null,
        });
        assert.equal(summaries, 0, 'the cheap edit avoided the LLM fold');
        assert.equal(out.filter((m) => m.role === 'tool')[0].content, '[tool output cleared to save context]');
    });
});
