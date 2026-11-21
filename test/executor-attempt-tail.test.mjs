// @ts-check
/**
 * @file The attempt tail the four planning engines share.
 * @description
 * `executeStepNodeNaive`, `executeStepNodeSM`, `executeStepNodeDiscussion`
 * and `executeStepNodeDag` each ended an attempt with the same schema retry,
 * verify verdict and whole-method catch. The extraction must keep every
 * payload, return value and error identity exactly as each engine had it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retrySchemaViolation, retryVerification, recordOrRethrow } from '../lib/agentic/planning/executor-helpers.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { BudgetExceededError, VerificationError } from '../lib/core/errors.mjs';

/** A host that records what the catch would have done, plus a recording RunContext. */
/** @returns {{host: any, stepCtx: any, errors: Array<{node: any, err: any, stepCtx: any}>}} */
function fakeHost() {
    /** @type {Array<{node: any, err: any, stepCtx: any}>} */
    const errors = [];
    const host = /** @type {any} */ ({
        signal: /** @type {AbortSignal|undefined} */ (undefined),
        /** @param {{node: any, err: any, stepCtx: any}} arg0 */
        _recordStepError({ node, err, stepCtx }) { errors.push({ node, err, stepCtx }); },
    });
    const stepCtx = /** @type {any} */ ({
        /** @type {Array<{emitter: any, name: string, payload: any}>} */
        events: [],
        /** @param {{emitter: any, name: string, payload: any}} arg0 */
        emit({ emitter, name, payload }) { this.events.push({ emitter, name, payload }); },
    });
    return { host, stepCtx, errors };
}

test('retrySchemaViolation emits the retry notice and returns the correction', () => {
    const { host, stepCtx } = fakeHost();
    const error = new Error('missing "answer"');
    const correction = retrySchemaViolation({ host, node: { id: 'a' }, attempt: 1, maxRetries: 2, error, stepCtx });
    assert.equal(correction, 'Your previous output did not match the required stateSchema: missing "answer". Return output matching the schema.');
    assert.deepEqual(stepCtx.events, [{
        emitter: host,
        name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL,
        payload: {
            stepId: 'a',
            attempt: 1,
            evidence: 'stateSchema: missing "answer" — retrying (attempt 2/3)',
        },
    }]);
});

test('retrySchemaViolation rethrows the same error once retries are spent', () => {
    const { host, stepCtx } = fakeHost();
    const error = new Error('bad');
    let thrown = null;
    try {
        retrySchemaViolation({ host, node: { id: 'a' }, attempt: 2, maxRetries: 2, error, stepCtx });
    } catch (err) {
        thrown = err;
    }
    assert.equal(thrown, error);
    assert.equal(stepCtx.events.length, 0);
});

test('retryVerification emits PASS and returns null on a pass', () => {
    const { host, stepCtx } = fakeHost();
    const evidence = retryVerification({ host, node: { id: 'a' }, attempt: 0, maxRetries: 2, verdict: { passed: true, evidence: 'criteria_passed' }, stepCtx });
    assert.equal(evidence, null);
    assert.deepEqual(stepCtx.events, [{
        emitter: host,
        name: EVENTS.WORKFLOW.STEP_VERIFY_PASS,
        payload: { stepId: 'a', attempt: 0, evidence: 'criteria_passed' },
    }]);
});

test('retryVerification emits FAIL and returns the evidence on a failure', () => {
    const { host, stepCtx } = fakeHost();
    const evidence = retryVerification({ host, node: { id: 'a' }, attempt: 0, maxRetries: 2, verdict: { passed: false, evidence: 'criteria_failed: fast' }, stepCtx });
    assert.equal(evidence, 'criteria_failed: fast');
    assert.deepEqual(stepCtx.events, [{
        emitter: host,
        name: EVENTS.WORKFLOW.STEP_VERIFY_FAIL,
        payload: { stepId: 'a', attempt: 0, evidence: 'criteria_failed: fast' },
    }]);
});

test('retryVerification keeps empty evidence and passes a missing one through raw', () => {
    const empty = fakeHost();
    assert.equal(retryVerification({ host: empty.host, node: { id: 'a' }, attempt: 0, maxRetries: 2, verdict: { passed: false, evidence: '' }, stepCtx: empty.stepCtx }), '');
    assert.deepEqual(empty.stepCtx.events[0].payload, { stepId: 'a', attempt: 0, evidence: '' });

    const missing = fakeHost();
    assert.equal(retryVerification({ host: missing.host, node: { id: 'a' }, attempt: 0, maxRetries: 2, verdict: { passed: false }, stepCtx: missing.stepCtx }), undefined);
    assert.deepEqual(missing.stepCtx.events[0].payload, { stepId: 'a', attempt: 0, evidence: '' });
});

test('retryVerification throws VerificationError with the attempt count once retries are spent', () => {
    const { host, stepCtx } = fakeHost();
    assert.throws(
        () => retryVerification({ host, node: { id: 'a' }, attempt: 2, maxRetries: 2, verdict: { passed: false, evidence: 'boom' }, stepCtx }),
        (/** @type {any} */ err) => {
            assert.ok(err instanceof VerificationError);
            assert.equal(err.message, 'Step [a] failed verification after 3 attempt(s): boom');
            assert.equal(err.stepId, 'a');
            assert.equal(err.evidence, 'boom');
            assert.equal(err.attempts, 3);
            return true;
        },
    );
    assert.equal(stepCtx.events.length, 0);

    const missing = fakeHost();
    assert.throws(
        () => retryVerification({ host: missing.host, node: { id: 'a' }, attempt: 2, maxRetries: 2, verdict: { passed: false }, stepCtx: missing.stepCtx }),
        (/** @type {any} */ err) => {
            assert.equal(err.message, 'Step [a] failed verification after 3 attempt(s): no evidence');
            assert.equal(err.evidence, 'no evidence');
            return true;
        },
    );
});

test('recordOrRethrow always rethrows a budget stop', () => {
    const { host, stepCtx, errors } = fakeHost();
    const budget = new BudgetExceededError({ message: 'Token budget exceeded.' });
    assert.throws(() => recordOrRethrow({ host, node: { id: 'a' }, err: budget, stepCtx }), (/** @type {any} */ err) => {
        assert.equal(err, budget);
        return true;
    });
    assert.equal(errors.length, 0);
});

test('recordOrRethrow rethrows an abort the step did not cause', () => {
    const { host, stepCtx, errors } = fakeHost();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    assert.throws(() => recordOrRethrow({ host, node: { id: 'a' }, err: abort, stepCtx }), (/** @type {any} */ err) => {
        assert.equal(err, abort);
        return true;
    });
    assert.equal(errors.length, 0);

    const timedOut = fakeHost();
    timedOut.host.signal = AbortSignal.abort();
    recordOrRethrow({ host: timedOut.host, node: { id: 'a', _timedOut: true }, err: abort, stepCtx: timedOut.stepCtx });
    assert.equal(timedOut.errors.length, 1);
    assert.equal(timedOut.errors[0].err, abort);
});

test('recordOrRethrow records every other error against the step', () => {
    const { host, stepCtx, errors } = fakeHost();
    const node = { id: 'a' };
    const err = new Error('model exploded');
    recordOrRethrow({ host, node, err, stepCtx });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].node, node);
    assert.equal(errors[0].err, err);
    assert.equal(errors[0].stepCtx, stepCtx);
});
