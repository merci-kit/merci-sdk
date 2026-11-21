// @ts-check

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ProviderType, FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

/** Invokes a recorded `.withParameters({ params })` against a stub builder. @param {any} paramCall */
function reasoningValue(paramCall) {
    /** @type {string|null} */
    let value = null;
    /** @type {any} */
    const stub = {};
    /** @param {{v: string}} a */
    function reasoningEffort({ v }) { value = v; return stub; }
    stub.reasoningEffort = reasoningEffort;
    paramCall.params(stub);
    return value;
}

/**
 * A scripted session: each entry is either a tool round, a text answer, an
 * empty response, or a truncated (PrematureEnd) response.
 * @param {{provider?: string, script: Array<{ tool?: boolean, content?: string, truncated?: boolean, truncatedBy?: 'length'|'premature_end', contentFiltered?: boolean }>}} arg0
 */
function loopSession({ provider = ProviderType.JAI, script }) {
    /** @type {any[]} */
    const paramCalls = [];
    /** @type {any[]} */
    const seen = [];
    let calls = 0;
    const s = {
        provider,
        _tools: [],
        /** @param {any} arg */
        withParameters(arg) { paramCalls.push(arg); return s; },
        /** @param {{messages: any}} arg0 */
        async *step({ messages }) {
            const entry = script[Math.min(calls, script.length - 1)];
            seen.push(messages);
            calls += 1;
            if (entry.tool) {
                return { done: false, messages: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'load_memory', arguments: '{}' } }] }] };
            }
            return { done: true, content: entry.content, ...(entry.truncated ? { truncated: true } : {}), ...(entry.truncatedBy ? { truncatedBy: entry.truncatedBy } : {}), ...(entry.contentFiltered ? { contentFiltered: true } : {}), messages: [...messages, { role: 'assistant', content: entry.content ?? '' }] };
        },
    };
    return { s, paramCalls, seen };
}

describe('memory distillation skips a run that produced no answer', () => {
    test('W2B-10: an empty deliverable is not distilled', async () => {
        let distilled = 0;
        const { s } = loopSession({ script: [{ content: '' }] });
        (/** @type {any} */ (s))._memoryManager = {
            shouldSync: () => true,
            distill: async () => { distilled += 1; },
        };
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 2, maxConsecutiveEmpty: 1 } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(out, FALLBACK_MESSAGE.EMPTY_RESPONSE);
        assert.equal(distilled, 0, 'a sentinel is not a deliverable worth remembering');
    });

    test('W2B-10: a real answer is still distilled', async () => {
        let distilled = 0;
        const { s } = loopSession({ script: [{ content: 'blue-orbit' }] });
        (/** @type {any} */ (s))._memoryManager = {
            shouldSync: () => true,
            distill: async () => { distilled += 1; },
        };
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 2 } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(out, 'blue-orbit');
        assert.equal(distilled, 1);
    });
});

describe('agentic loop lowers JAI reasoning once on an empty post-tool synthesis', () => {
    test('JAI: empty after a tool round → lowers once, then the nudge step answers', async () => {
        const { s, paramCalls } = loopSession({ script: [{ tool: true }, { content: '' }, { content: 'blue-orbit' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(out, 'blue-orbit');
        assert.equal(paramCalls.length, 1, 'reasoning lowered exactly once');
        assert.equal(reasoningValue(paramCalls[0]), 'low');
    });

    test('JAI: repeated empties still lower reasoning at most once', async () => {
        const { s, paramCalls } = loopSession({ script: [{ tool: true }, { content: '' }, { content: '' }, { content: 'blue-orbit' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 5 } });
        assert.equal(out, 'blue-orbit');
        assert.equal(paramCalls.length, 1);
    });

    test('non-JAI: an empty post-tool synthesis does not touch reasoning', async () => {
        const { s, paramCalls } = loopSession({ provider: ProviderType.OPENAI, script: [{ tool: true }, { content: '' }, { content: 'blue-orbit' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(out, 'blue-orbit');
        assert.equal(paramCalls.length, 0);
    });

    test('an empty response with no prior tool round is not a synthesis stall', async () => {
        const { s, paramCalls } = loopSession({ script: [{ content: '' }, { content: 'answer' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(out, 'answer');
        assert.equal(paramCalls.length, 0, 'nothing to synthesize from');
    });
});

describe('agentic loop recovers a JAI truncated synthesis after a tool round', () => {
    test('JAI: truncated (PrematureEnd) after a tool round → lowers once and retries', async () => {
        const { s, paramCalls } = loopSession({ script: [{ tool: true }, { content: '', truncated: true }, { content: 'blue-orbit' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(out, 'blue-orbit', 'the truncation no longer returns the fallback');
        assert.equal(paramCalls.length, 1);
        assert.equal(reasoningValue(paramCalls[0]), 'low');
    });

    test('JAI: the truncation recovery is bounded by maxConsecutiveEmpty', async () => {
        const { s, paramCalls } = loopSession({ script: [{ tool: true }, { content: '', truncated: true }, { content: '', truncated: true }, { content: 'late' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 6 } });
        assert.equal(paramCalls.length, 1, 'reasoning is lowered once across recoveries');
        assert.equal(out, 'late');
    });

    test('JAI: when every synthesis truncates the loop still returns the fallback (no infinite retry)', async () => {
        const { s } = loopSession({ script: [{ tool: true }, { content: '', truncated: true }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 8, maxConsecutiveEmpty: 2 } });
        assert.notEqual(out, 'late');
        assert.ok(String(out).length > 0);
    });

    test('JAI: exhausting the recovery budget returns the fallback, never MaxTurns', async () => {
        const { s } = loopSession({ script: [{ tool: true }, { content: '', truncated: true }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 3, maxConsecutiveEmpty: 4 } });
        assert.ok(String(out).length > 0, 'a graceful fallback, not a thrown MaxTurnsExceededError');
    });

    test('non-JAI: a truncated response with partial text is still salvaged (no recovery)', async () => {
        const { s, paramCalls } = loopSession({ provider: ProviderType.OPENAI, script: [{ tool: true }, { content: 'partial answer', truncated: true }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.ok(String(out).startsWith('partial answer'));
        assert.equal(paramCalls.length, 0, 'non-JAI partial text needs no reasoning change');
    });

    test('non-JAI: a truncated synthesis after a tool round is not recovered', async () => {
        const { s, paramCalls } = loopSession({ provider: ProviderType.OPENAI, script: [{ tool: true }, { content: '', truncated: true }, { content: 'should not run' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(paramCalls.length, 0);
        assert.notEqual(out, 'should not run');
    });
});

describe('agentic loop distinguishes a provider early stop from a token-limit cut', () => {
    test('a premature-end partial carries the provider note, not the token-limit note', async () => {
        const { s } = loopSession({ script: [{ content: 'half a sentence', truncated: true, truncatedBy: 'premature_end' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 2 } });
        assert.ok(out.startsWith('half a sentence'));
        assert.ok(out.endsWith(FALLBACK_MESSAGE.TRUNCATED_BY_PROVIDER));
        assert.ok(!out.includes('output token limit'));
    });

    test('a genuine length cut keeps the token-limit note', async () => {
        const { s } = loopSession({ script: [{ content: 'half a sentence', truncated: true, truncatedBy: 'length' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 2 } });
        assert.ok(out.endsWith(FALLBACK_MESSAGE.TRUNCATED));
    });
});

describe('agentic loop surfaces a JAI content-moderation block distinctly', () => {
    test('an exhausted content-filtered truncation returns the moderation fallback and emits the event', async () => {
        /** @type {string[]} */
        const events = [];
        const { s } = loopSession({ script: [{ tool: true }, { content: '', truncated: true, contentFiltered: true }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: {
            maxIterations: 3,
            maxConsecutiveEmpty: 1,
            onEvent: (/** @type {any} */ e) => events.push(e.type),
        } });
        assert.equal(out, FALLBACK_MESSAGE.CONTENT_FILTERED);
        assert.ok(events.includes('content_filtered'), 'a content_filtered step event is emitted');
    });

    test('a recovered content-filtered truncation still returns the answer (retries help)', async () => {
        const { s } = loopSession({ script: [{ tool: true }, { content: '', truncated: true, contentFiltered: true }, { content: 'blue-orbit' }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(out, 'blue-orbit');
    });

    test('a moderation stop is NOT reported as a token-limit truncation (no truncated event; finishReason content_filtered)', async () => {
        const { EventEmitter } = await import('node:events');
        const { EVENTS } = await import('../lib/core/events.mjs');
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
        /** @type {string[]} */
        const events = [];
        const { s } = loopSession({ script: [{ tool: true }, { content: '', truncated: true, contentFiltered: true }] });
        (/** @type {any} */ (s)).eventEmitter = emitter;
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: {
            maxIterations: 3,
            maxConsecutiveEmpty: 1,
            onEvent: (/** @type {any} */ e) => events.push(e.type),
        } });
        assert.equal(out, FALLBACK_MESSAGE.CONTENT_FILTERED);
        assert.ok(events.includes('content_filtered'), 'content_filtered is emitted');
        assert.ok(!events.includes('truncated'), 'a moderation stop must not emit the token-limit truncation event');
        assert.equal(ends[0]?.finishReason, 'content_filtered', 'run:end reflects moderation, not length');
        assert.equal(ends[0]?.truncated, false, 'moderation is not a token-limit truncation');
    });

    test('a content-filtered partial is removed, not delivered as the answer', async () => {
        const { s } = loopSession({ script: [{ content: 'the fragment the provider refused to finish', truncated: true, truncatedBy: 'premature_end', contentFiltered: true }] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 2 } });
        assert.equal(out, FALLBACK_MESSAGE.CONTENT_FILTERED);
        assert.ok(!out.includes('the fragment'), 'the moderation-blocked fragment must not reach the consumer');
        assert.ok(!JSON.stringify((/** @type {any} */ (s))._lastStepMessages ?? []).includes('the fragment'), 'the blocked row is stripped from the transcript');
    });

    test('a content-filtered synthesis does not re-send the blocked fragment on recovery', async () => {
        const { s, seen } = loopSession({ script: [
            { tool: true },
            { content: 'BLOCKED-FRAGMENT', truncated: true, truncatedBy: 'premature_end', contentFiltered: true },
            { content: 'clean answer' },
        ] });
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 4 } });
        assert.equal(out, 'clean answer');
        assert.ok(!JSON.stringify(seen.at(-1)).includes('BLOCKED-FRAGMENT'), 'the retry request must not carry the moderation-blocked text');
        assert.ok(!JSON.stringify((/** @type {any} */ (s))._lastStepMessages ?? []).includes('BLOCKED-FRAGMENT'), 'the transcript must not carry the blocked row');
    });

    test('a premature end reports finishReason premature_end, not length', async () => {
        const { EventEmitter } = await import('node:events');
        const { EVENTS } = await import('../lib/core/events.mjs');
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
        const { s } = loopSession({ script: [{ content: 'partial answer', truncated: true, truncatedBy: 'premature_end' }] });
        (/** @type {any} */ (s)).eventEmitter = emitter;
        const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'q' }], opts: { maxIterations: 2 } });
        assert.equal(ends[0]?.finishReason, 'premature_end');
        assert.equal(ends[0]?.truncatedBy, 'premature_end');
        assert.ok(out.endsWith(FALLBACK_MESSAGE.TRUNCATED_BY_PROVIDER));
    });
});
