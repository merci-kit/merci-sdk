// @ts-check

/**
 * @file One timeout vocabulary across the retry policy, the scheduler and the
 * operator, plus the evidence a failed result may carry.
 * @version 0.12.0
 *
 * @description
 * A timeout is infrastructure, not a user cancel. Before this file, four
 * modules spelled it differently: `HEADER_TIMEOUT`/`BODY_TIMEOUT` in the retry
 * policy, `STEP_TIMEOUT` in the step loop, `STREAM_TIMEOUT` in the stream
 * policy, and `{ETIMEDOUT, timeout, TIMEOUT}` in the scheduler. A stream stall
 * was therefore normalized as `canceled` and never counted as a failure, and a
 * returned `{status:'failed'}` could not carry an `errorCode`, so the scheduler
 * retried it to `maxAttemptsPerItem`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasTimeoutCode, isTransientError } from '../lib/support/retry-policy.mjs';
import { normalizeRunResult, failureEvidence } from '../lib/agentic/scheduler/retry.mjs';
import { toItemResponse } from '../lib/agentic/operator/view.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { ingestDocument } from '../lib/agentic/ingest.mjs';
import { TIMEOUT_CODES } from '../lib/core/constants/index.mjs';

/** @param {string} code */
function errorWithCode(code) {
    return Object.assign(new Error('boom'), { code });
}

test('every SDK timeout code is recognised, alone and through the cause chain', () => {
    for (const code of ['HEADER_TIMEOUT', 'BODY_TIMEOUT', 'STEP_TIMEOUT', 'STREAM_TIMEOUT', 'ETIMEDOUT']) {
        assert.equal(hasTimeoutCode({ error: errorWithCode(code) }), true, code);
    }
    const wrapped = new Error('fetch failed', { cause: errorWithCode('STREAM_TIMEOUT') });
    assert.equal(hasTimeoutCode({ error: wrapped }), true);
    assert.equal(hasTimeoutCode({ error: errorWithCode('ENOENT') }), false);
});

test('a stream timeout is transient; a step timeout owns its attempt budget', () => {
    assert.equal(isTransientError({ error: errorWithCode('STREAM_TIMEOUT') }), true);
    // STEP_TIMEOUT is raised with `nonRetryable: true` by the step loop.
    const stepTimeout = Object.assign(errorWithCode('STEP_TIMEOUT'), { nonRetryable: true });
    assert.equal(isTransientError({ error: stepTimeout }), false);
});

test('a stream timeout normalizes as failed, not canceled', () => {
    const streamTimeout = Object.assign(new Error('Stream inactivity timeout'), {
        name: 'AbortError',
        code: 'STREAM_TIMEOUT'
    });
    const result = normalizeRunResult({ error: streamTimeout });
    assert.equal(result.status, 'failed');
    assert.equal(result.timedOut, true);
    assert.equal(result.errorCode, 'STREAM_TIMEOUT');

    // A real caller abort still wins.
    const controller = new AbortController();
    controller.abort();
    const canceled = normalizeRunResult({ error: streamTimeout, signal: controller.signal });
    assert.equal(canceled.status, 'canceled');

    // A plain AbortError with no timeout code stays a cancel.
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    assert.equal(normalizeRunResult({ error: aborted }).status, 'canceled');
});

test('a failed result carries its error evidence and its non-retryable flag', () => {
    const carried = normalizeRunResult({
        result: { status: 'failed', error: { name: 'ValidationError', code: 'invalid_arguments' } }
    });
    assert.equal(carried.errorName, 'ValidationError');
    assert.equal(carried.errorCode, 'invalid_arguments');
    assert.equal(carried.nonRetryable, false);

    const flagged = normalizeRunResult({
        result: {
            status: 'failed',
            errorCode: 'MY-APP-ERR',
            errorName: 'AppError',
            nonRetryable: true
        }
    });
    assert.equal(flagged.errorCode, 'MY-APP-ERR');
    assert.equal(flagged.errorName, 'AppError');
    assert.equal(flagged.nonRetryable, true);

    const timeout = normalizeRunResult({ result: { status: 'failed', errorCode: 'STEP_TIMEOUT' } });
    assert.equal(timeout.timedOut, true);

    // The completed path keeps its documented null evidence.
    const completed = normalizeRunResult({ result: { status: 'completed' } });
    assert.equal(completed.errorCode, null);
    assert.equal(completed.errorName, null);
    assert.equal(completed.nonRetryable, false);
});

test('failureEvidence sees a stream timeout as a timeout', () => {
    const evidence = failureEvidence({ result: normalizeRunResult({ error: errorWithCode('STREAM_TIMEOUT') }) });
    assert.equal(evidence.timedOut, true);
    assert.equal(evidence.source, 'scheduler');
});

test('the operator resolves a row by workItemId and keys its events by identifier', () => {
    const snapshot = {
        running: [{ identifier: 'MER-1', workItemId: 'id-1', attempt: 2 }],
        retrying: [],
        parked: []
    };
    const response = toItemResponse({ snapshot, id: 'id-1', now: 1_000 });
    assert.ok(response);
    assert.equal(response.identifier, 'MER-1');
    assert.equal(response.workItemId, 'id-1');

    /** @type {Array<unknown>} */
    const seen = [];
    const withEvents = toItemResponse({
        snapshot,
        id: 'id-1',
        now: 1_000,
        events: ({ identifier }) => { seen.push(identifier); return []; }
    });
    assert.deepEqual(seen, ['MER-1']);
    assert.deepEqual(withEvents?.recentEvents, []);
});

test('ingestDocument tags its refusals with a stable option', async () => {
    const client = { provider: 'oai', session: () => ({}) };
    await assert.rejects(
        () => ingestDocument({ client, model: 'm', path: '/tmp/Document.xyz' }),
        (error) => {
            assert.ok(error instanceof ConfigurationError);
            assert.equal(error.option, 'unsupported_document_type');
            return true;
        }
    );
    await assert.rejects(
        () => ingestDocument({ client, model: 'm', path: '/tmp/Document.pdf' }),
        (error) => {
            assert.ok(error instanceof ConfigurationError);
            assert.equal(error.option, 'pdf_provider_unsupported');
            return true;
        }
    );
});

test('ConfigurationError keeps its context', () => {
    const error = new ConfigurationError({ message: 'x', options: { context: { option: 'y' } } });
    assert.deepEqual(error.context, { option: 'y' });
});

test('the timeout set stays the single source of truth', () => {
    assert.equal(TIMEOUT_CODES.has('STREAM_TIMEOUT'), true);
    assert.equal(TIMEOUT_CODES.has('STEP_TIMEOUT'), true);
});
