// @ts-check

/**
 * @file The old agentic loop labels a failed run with the shared taxonomy.
 * @version 0.12.0
 *
 * @description
 * The scheduler classifies an attempt from the error code; the loop now emits
 * the same `FailureClass` on `run:end` and on the thrown error. It is diagnostic
 * — `runWithRetry` decisions are unchanged — so the tests pin the class the
 * loop's own evidence supports, and that an abort makes no classification claim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { FailureClass, classifyFailure } from '../lib/agentic/loops/policy.mjs';
import { failureEvidence, normalizeRunResult } from '../lib/agentic/scheduler/retry.mjs';
import { ProviderType, ERROR_CODES } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { ExponentialBackoffPolicy, isNonRetryable } from '../lib/support/retry-policy.mjs';

/**
 * A session whose first step throws. `NoRetryPolicy` is the default here, so
 * `runWithRetry` rethrows the same error and the loop's catch sees it.
 * @param {{thrown: unknown}} arg0
 */
function throwingSession({ thrown }) {
    /** @type {any} */
    const session = {
        provider: ProviderType.OPENAI,
        model: 'test-model',
        _tools: [],
        eventEmitter: new EventEmitter(),
        /** @param {{messages: any[]}} _arg0 */
        async *step(_arg0) {
            throw thrown;
        }
    };
    return session;
}

/**
 * @param {{thrown: unknown}} arg0
 * @returns {Promise<{ ends: any[], error: any }>}
 */
async function runAndCollect({ thrown }) {
    const session = throwingSession({ thrown });
    /** @type {any[]} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    /** @type {any} */
    let error = null;
    try {
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'go' })] });
    } catch (e) {
        error = e;
    }
    return { ends, error };
}

describe('runAgenticLoop failure classification', () => {
    it('labels a guardrail violation PERMISSION_BLOCK on run:end and on the thrown error', async () => {
        const thrown = Object.assign(new Error('blocked by guardrail'), { code: ERROR_CODES.GUARDRAIL });
        const { ends, error } = await runAndCollect({ thrown });

        assert.equal(ends.length, 1);
        assert.equal(ends[0].finishReason, 'error');
        assert.equal(ends[0].failureClass, FailureClass.PERMISSION_BLOCK);
        assert.equal(error.failureClass, FailureClass.PERMISSION_BLOCK);
    });

    it('labels a timeout-shaped failure TRANSIENT_INFRASTRUCTURE', async () => {
        /** @type {Array<Error & {code?: string}>} */
        const timeouts = [
            Object.assign(new Error('step timed out'), { code: 'STEP_TIMEOUT' }),
            Object.assign(new Error('timed out'), { name: 'TimeoutError' })
        ];
        for (const thrown of timeouts) {
            const { ends, error } = await runAndCollect({ thrown });
            assert.equal(ends[0].failureClass, FailureClass.TRANSIENT_INFRASTRUCTURE, `code/name ${thrown.code ?? thrown.name}`);
            assert.equal(error.failureClass, FailureClass.TRANSIENT_INFRASTRUCTURE);
        }
    });

    it('labels a plain error UNKNOWN rather than inventing evidence', async () => {
        const { ends, error } = await runAndCollect({ thrown: new Error('vendor exploded') });

        assert.equal(ends[0].failureClass, FailureClass.UNKNOWN);
        assert.equal(error.failureClass, FailureClass.UNKNOWN);
    });

    it('an abort emits aborted and makes no failureClass claim', async () => {
        const thrown = Object.assign(new Error('stopped'), { name: 'AbortError' });
        const { ends, error } = await runAndCollect({ thrown });

        assert.equal(ends[0].finishReason, 'aborted');
        assert.equal('failureClass' in ends[0], false, 'an abort is not a failure class');
        assert.equal('failureClass' in error, false, 'the abort error keeps its shape');
    });

    it('a frozen error does not crash the catch', async () => {
        // A truthy `usage` keeps the step-drain's own usage annotation off the
        // error, so the frozen value reaches the run catch untouched.
        const thrown = Object.freeze(Object.assign(new Error('frozen vendor error'), { usage: { prompt_tokens: 0, completion_tokens: 0 } }));
        const { ends, error } = await runAndCollect({ thrown });

        assert.equal(ends[0].failureClass, FailureClass.UNKNOWN, 'the diagnostic still reaches run:end');
        assert.equal(error, thrown, 'the same error is rethrown, never replaced');
        assert.equal(Object.isFrozen(error), true);
        assert.equal('failureClass' in error, false, 'the frozen error refused the property');
    });

    it('the loop and the scheduler agree on the class for the same error', async () => {
        /** @type {Array<Error & {code?: string}>} */
        const errors = [
            new Error('plain'),
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
            Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }),
            Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
            Object.assign(new Error('blocked'), { code: ERROR_CODES.GUARDRAIL }),
            Object.assign(new Error('slow down'), { code: 'rate_limit' })
        ];
        for (const thrown of errors) {
            const { ends } = await runAndCollect({ thrown });
            const schedulerClass = classifyFailure({ evidence: failureEvidence({ result: normalizeRunResult({ error: thrown }) }) });
            assert.equal(ends[0].failureClass, schedulerClass, `${thrown.code ?? thrown.name} class`);
        }
    });

    it('a retried-then-successful run stops normally and makes no failureClass claim', async () => {
        let calls = 0;
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
        /** @type {any} */
        const session = {
            provider: ProviderType.OPENAI,
            model: 'test-model',
            _tools: [],
            eventEmitter: emitter,
            async *step() {
                if (calls++ < 2) throw Object.assign(new Error('vendor 500'), { status: 500 });
                return { done: true, content: 'final answer', messages: [{ role: 'assistant', content: 'final answer' }] };
            }
        };
        const retryPolicy = new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 });

        const answer = await runAgenticLoop({
            session,
            messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'go' })],
            opts: { retryPolicy }
        });

        assert.equal(answer, 'final answer');
        assert.equal(calls, 3, 'two retries happened');
        assert.equal(ends[0].finishReason, 'stop');
        assert.equal('failureClass' in ends[0], false, 'a successful run is not classified');
    });

    it('a failureClass property never makes an error non-retryable', () => {
        const error = Object.assign(new Error('vendor exploded'), { failureClass: FailureClass.PERMISSION_BLOCK });
        assert.equal(isNonRetryable({ error }), false);
    });
});
