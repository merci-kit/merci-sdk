// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { isAbortError } from '../lib/core/errors.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @param {{id: any}} arg0 */
/** @param {{id: *}} arg0 */
const TOOL_CALL = ({ id }) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
});
/** @param {{id: any}} arg0 */
/** @param {{id: *}} arg0 */
const TOOL_RESULT = ({ id }) => ({ role: 'tool', tool_call_id: id, name: 'read', content: 'contents' });

/** @param {{script: any[]}} arg0 */
function makeSession({ script }) {
    /** @type {any[]} */
    const stepCalls = [];
    let calls = 0;
    /** @type {any} */
    const session = {
        provider: 'OAI',
        model: 'test-model',
        _tools: [],
        _retryPolicy: undefined,
        eventEmitter: { emit: () => {} },
        stepCalls,
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            stepCalls.push(messages.map((/** @type {any} */ m) => ({ ...m })));
            const outcome = script[calls++];
            if (outcome instanceof Function) return outcome(messages);
            throw outcome;
        },
    };
    return session;
}

const transientFail = () => Object.assign(new Error('vendor exploded mid-run'), { status: 500 });
/** @param {{maxRetries: any}} arg0 */
/** @param {{maxRetries: *}} arg0 */
const fastRetry = ({ maxRetries }) => new ExponentialBackoffPolicy({
    maxRetries,
    initialDelayMs: 1,
    maxDelayMs: 2,
    jitterMs: 0,
});

describe('runAgenticLoop mid-run retry', () => {
    it('re-runs from the last completed step after a transient mid-run failure', async () => {
        const session = makeSession({ script: [
            (/** @type {any} */ m) => {
                const history = [...m, TOOL_CALL({ id: 'c1' }), TOOL_RESULT({ id: 'c1' })];
                session._lastStepMessages = history;
                return { done: false, messages: history, thoughtSignature: null };
            },
            transientFail(),
            (/** @type {any} */ m) => ({ done: true, content: 'final answer', messages: m, thoughtSignature: null }),
        ] });
        const input = [createUserMessage({ provider: 'OAI', content: 'hi' })];

        const answer = await runAgenticLoop({ session, messages: input, opts: { retryPolicy: fastRetry({ maxRetries: 1 }) } });

        assert.equal(answer, 'final answer');
        assert.equal(session.stepCalls.length, 3, 'failed step + resumed step');
        assert.deepEqual(session.stepCalls[2], session.stepCalls[1],
            'attempt 2 starts from the last completed step, not the run start');
        assert.ok(session.stepCalls[2].some((/** @type {any} */ m) => m.tool_calls),
            'attempt 2 history still contains the completed tool round');
    });

    it('ignores a stale _lastStepMessages from an earlier run', async () => {
        const session = makeSession({ script: [transientFail(), transientFail(), transientFail()] });
        session._lastStepMessages = [createUserMessage({ provider: 'OAI', content: 'stale residue' })];
        const input = [createUserMessage({ provider: 'OAI', content: 'hi' })];

        await assert.rejects(
            runAgenticLoop({ session, messages: input, opts: { retryPolicy: fastRetry({ maxRetries: 2 }) } }),
            ((/** @type {any} */ err) => err.status === 500)
        );
        assert.equal(session.stepCalls.length, 3, 'budget exhausted: 1 + maxRetries');
        for (const call of session.stepCalls) {
            assert.deepEqual(call, input,
                'every attempt replays the run input — the stale residue is never used');
        }
    });

    it('never retries a non-transient error', async () => {
        const badRequest = Object.assign(new Error('bad request'), { status: 400 });
        const session = makeSession({ script: [badRequest] });

        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { retryPolicy: fastRetry({ maxRetries: 3 }) } }),
            ((/** @type {any} */ err) => err.status === 400)
        );
        assert.equal(session.stepCalls.length, 1, 'single attempt only');
    });

    it('never retries once the signal is aborted mid-run', async () => {
        const controller = new AbortController();
        const session = makeSession({ script: [
            () => {
                controller.abort();
                return transientFail();
            },
        ] });

        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
                retryPolicy: fastRetry({ maxRetries: 3 }),
                signal: controller.signal,
            } }),
            ((/** @type {any} */ err) => isAbortError({ err }))
        );
        assert.equal(session.stepCalls.length, 1, 'abort short-circuits the retry loop');
    });

    it('propagates the error once the retry budget is exhausted', async () => {
        const session = makeSession({ script: [transientFail(), transientFail(), transientFail()] });

        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { retryPolicy: fastRetry({ maxRetries: 1 }) } }),
            ((/** @type {any} */ err) => err.status === 500)
        );
        assert.equal(session.stepCalls.length, 2, '1 attempt + 1 retry');
    });

    it('activates from the session policy when no options.retryPolicy is given', async () => {
        const session = makeSession({ script: [transientFail(), (/** @type {any} */ m) => ({ done: true, content: 'recovered', messages: m, thoughtSignature: null })] });
        session._retryPolicy = fastRetry({ maxRetries: 1 });

        const answer = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {} });

        assert.equal(answer, 'recovered');
        assert.equal(session.stepCalls.length, 2, 'session policy drives the run-level retry');
    });

    it('keeps the no-retry behavior when no policy is configured', async () => {
        const session = makeSession({ script: [transientFail()] });

        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {} }),
            ((/** @type {any} */ err) => err.status === 500)
        );
        assert.equal(session.stepCalls.length, 1, 'default: single attempt, error propagates');
    });
});