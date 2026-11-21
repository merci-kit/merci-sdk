// @ts-check
/**
 * B-7 / B-8: the pre-call projection must see the whole prompt, and a step that
 * dies before its usage frame must still move the ledger.
 *
 * B-7: `stepPromptEst` counted only the conversation rows, so a 2000-token
 * system+tools prefix passed a tight cap check and the run failed AFTER the
 * call (one-call overshoot by a prefix that was never accounted for).
 * B-8: `drainStepWithHooks` attached an all-zero usage on a mid-stream failure
 * and the rejected branch charged `estTokens: 0`, so a retry loop could spend
 * the prompt and the streamed text of every attempt without moving the cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';

/**
 * What a fixture step yields and returns: the subset of the loop's stream
 * events and step result the accounting path reads.
 * @typedef {{type: string, data?: Record<string, number>, content?: string, calls?: Array<Record<string, unknown>>}} FixtureEvent
 * @typedef {{done?: boolean, content?: string, messages?: Array<Record<string, unknown>>}} FixtureStepResult
 * @typedef {(arg0: {messages: Array<Record<string, unknown>>, options?: Record<string, unknown>}) => AsyncGenerator<FixtureEvent, FixtureStepResult, unknown>} FixtureStep
 */

/**
 * The fixture's own surface: the fields `runAgenticLoop` reads from a session,
 * declared so a test can assign them. Narrower than a backend session.
 * @typedef {Object} FixtureSession
 * @property {string} provider
 * @property {string} model
 * @property {import('node:events').EventEmitter} eventEmitter
 * @property {Array<Record<string, unknown>>} _tools
 * @property {Array<Record<string, unknown>>} _lastStepMessages
 * @property {{maxTotalTokens?: number, maxBudgetUsd?: number}|null} [_budget]
 * @property {number} calls
 * @property {() => FixtureSession} withSystemMessage
 * @property {() => FixtureSession} withTools
 * @property {() => string|null} [getSystemMessage]
 * @property {() => Array<Record<string, unknown>>} [_requestTools]
 * @property {FixtureStep} [step]
 */

/** @param {{calls: number[]}} arg0 */
function baseSession({ calls }) {
    /** @type {FixtureSession} */
    const session = {
        provider: 'openai',
        model: 'm',
        eventEmitter: new EventEmitter(),
        _tools: [],
        _lastStepMessages: [],
        calls: 0,
        withSystemMessage() { return session; },
        withTools() { return session; },
    };
    void calls;
    return session;
}

/**
 * A session whose request carries a 2000-token prefix the row estimate cannot
 * see (system prompt + tool schemas) and whose vendor reports the real size.
 * @param {{calls: number[]}} arg0
 */
function hiddenPrefixSession({ calls }) {
    const session = baseSession({ calls });
    const tool = { name: 'noop', description: 'T'.repeat(4_000), parameters: { type: 'object', properties: {} } };
    session._tools = [tool];
    session.getSystemMessage = () => 'S'.repeat(4_000);
    session._requestTools = () => [tool];
    session.step = async function* step({ messages }) {
        session.calls += 1;
        calls.push(session.calls);
        yield { type: 'quota', data: { prompt_tokens: 2_000, completion_tokens: 5, total_tokens: 2_005 } };
        return { done: true, content: 'answer', messages: [...messages, { role: 'assistant', content: 'answer' }] };
    };
    return session;
}

/**
 * A session that streams text and then dies before any usage frame arrives.
 * @param {{calls: number[], streamedChars: number}} arg0
 */
function dyingSession({ calls, streamedChars }) {
    const session = baseSession({ calls });
    session.step = async function* step() {
        session.calls += 1;
        calls.push(session.calls);
        yield { type: 'text', content: 'x'.repeat(streamedChars) };
        throw new Error('socket hang up');
    };
    return session;
}

/**
 * A session whose i-th call reports `quotas[i]` and keeps the loop running with
 * a tool round until the last call answers.
 * @param {{calls: number[], quotas: Array<Record<string, number>>}} arg0
 */
function scheduledSession({ calls, quotas }) {
    const session = baseSession({ calls });
    const tool = { name: 'noop', description: 'no-op', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) };
    session._tools = [tool];
    let call = 0;
    session.step = async function* step({ messages }) {
        session.calls += 1;
        calls.push(session.calls);
        const index = call++;
        yield { type: 'quota', data: quotas[index] ?? {} };
        if (index + 1 < quotas.length) {
            const id = `c${index}`;
            yield { type: 'tool_request', calls: [{ id, name: 'noop', args: {} }] };
            const row = { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'noop', arguments: '{}' } }] };
            return { done: true, content: '', messages: [...messages, row, { role: 'tool', content: '{"ok":true}' }] };
        }
        return { done: true, content: 'answer', messages: [...messages, { role: 'assistant', content: 'answer' }] };
    };
    return session;
}

test('B-7 a hidden 2000-token prefix is refused before the call', async () => {
    /** @type {number[]} */
    const calls = [];
    const session = hiddenPrefixSession({ calls });
    session._budget = { maxTotalTokens: 500 };

    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1 } }),
        BudgetExceededError,
    );
    assert.equal(calls.length, 0, 'the system prompt and tool schemas are part of the projection, so no call is made');
});

test('B-8 a failed attempt is charged its estimate', async () => {
    /** @type {number[]} */
    const calls = [];
    const session = dyingSession({ calls, streamedChars: 2_000 });
    session._budget = { maxTotalTokens: 500 };
    // A retry policy that retries the transport failure (bounded, so a tree that
    // never charges cannot spin forever), never the budget stop.
    let retries = 0;
    /** @type {import('../lib/support/retry-policy.mjs').RetryPolicy} */
    const retryPolicy = { shouldRetry: ({ error }) => ({ retry: !(error instanceof BudgetExceededError) && (retries += 1) <= 2, delayMs: 0 }) };

    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1, retryPolicy } }),
        BudgetExceededError,
    );
    assert.equal(calls.length, 1, 'the failed attempt spent its prompt and streamed text, so the retry is refused at the cap');
});

test('B-7 a pre-call refusal reports the projection, not the spend', async () => {
    /** @type {number[]} */
    const calls = [];
    const session = hiddenPrefixSession({ calls });
    session._budget = { maxTotalTokens: 500 };

    const error = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1 } })
        .then(() => null, (e) => e);

    assert.ok(error instanceof BudgetExceededError);
    const usage = error.usage;
    assert.ok(usage, 'the refusal carries its usage payload');
    assert.equal(usage.spent_tokens, 0, 'nothing was spent yet');
    assert.equal(usage.total_tokens, usage.projected_tokens, 'the number that decided it is the projection');
    assert.ok(Number(usage.projected_tokens) > 500, `the projection includes the hidden prefix, got ${usage.projected_tokens}`);
    assert.match(error.message, /projected; spent 0/, 'the message does not read as spend > cap');
});

test('W2-5 a compaction drops the stale prompt floor', async () => {
    /** @type {number[]} */
    const calls = [];
    const session = scheduledSession({ calls, quotas: [
        { prompt_tokens: 900, completion_tokens: 1 },
        { prompt_tokens: 20, completion_tokens: 1 },
    ] });
    const history = [
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
        { role: 'user', content: 'e' }, { role: 'assistant', content: 'f' },
        { role: 'user', content: 'g' },
    ];

    const out = await runAgenticLoop({ session, messages: history, opts: {
        maxIterations: 3,
        budget: { maxTotalTokens: 1_500 },
        compaction: { thresholdTokens: 40, keepRecent: 2, summarize: async () => 'summary' },
    } });

    assert.equal(out, 'answer');
    assert.equal(calls.length, 2, 'the fold left 599 tokens of headroom, so the next call runs');
});

test('W2-6 the floor is the prompt the cap counts, not prompt + cache', async () => {
    /** @type {number[]} */
    const calls = [];
    const session = scheduledSession({ calls, quotas: [
        { prompt_tokens: 60_000, completion_tokens: 0 },
        // A cached prompt: 40k of the 50k are cache reads, already inside
        // `prompt_tokens` on the APIs that report them.
        { prompt_tokens: 50_000, cache_read_input_tokens: 40_000, completion_tokens: 0 },
        { prompt_tokens: 50_000, completion_tokens: 0 },
    ] });

    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: {
        maxIterations: 4,
        budget: { maxTotalTokens: 200_000 },
    } });

    assert.equal(out, 'answer');
    assert.equal(calls.length, 3, '110k spent + a 50k prompt fits a 200k cap; only the cache double-count refused it');
});

test('B-8 a frozen error cannot be annotated and is still charged', async () => {
    /** @type {number[]} */
    const calls = [];
    const session = baseSession({ calls });
    session._budget = { maxTotalTokens: 500 };
    session.step = async function* step() {
        session.calls += 1;
        calls.push(session.calls);
        yield { type: 'text', content: 'x'.repeat(2_000) };
        // A caller's frozen error: the drain must not annotate it, and the
        // estimate must still land.
        throw Object.freeze(Object.assign(new Error('frozen vendor error'), {
            usage: { prompt_tokens: 0, completion_tokens: 0 },
        }));
    };
    let retries = 0;
    /** @type {import('../lib/support/retry-policy.mjs').RetryPolicy} */
    const retryPolicy = { shouldRetry: ({ error }) => ({ retry: !(error instanceof BudgetExceededError) && (retries += 1) <= 2, delayMs: 0 }) };

    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1, retryPolicy } }),
        BudgetExceededError,
    );
    assert.equal(calls.length, 1, 'the streamed text is charged even though the error refused the annotation');
});
