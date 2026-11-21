// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    FailureClass,
    failureFingerprint,
    RetryLedger,
    classifyFailure,
    stateFingerprint,
    compareProgress
} from '../lib/agentic/loops/index.mjs';

// ─── failureFingerprint ─────────────────────────────────────────────────────

test('failureFingerprint: stable for identical parts, distinct otherwise', () => {
    const a = failureFingerprint({ action: 'patch_parser', input: 'strip line before split', signature: 'ValueError:not enough values to unpack' });
    const b = failureFingerprint({ action: 'patch_parser', input: 'strip line before split', signature: 'ValueError:not enough values to unpack' });
    const c = failureFingerprint({ action: 'patch_parser', input: 'skip empty line before split', signature: 'ValueError:not enough values to unpack' });
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test('failureFingerprint: omits nothing, missing parts are empty strings', () => {
    const x = failureFingerprint();
    const y = failureFingerprint({ action: '', input: '', signature: '' });
    assert.equal(x, y);
});

// ─── RetryLedger ────────────────────────────────────────────────────────────

test('RetryLedger: budget is per fingerprint, not a global counter', () => {
    const ledger = new RetryLedger({ perFingerprintLimit: 2 });
    const fpA = failureFingerprint({ signature: 'A' });
    const fpB = failureFingerprint({ signature: 'B' });
    assert.equal(ledger.record({ fingerprint: fpA }), 1);
    assert.equal(ledger.canRetry({ fingerprint: fpA }), true);
    assert.equal(ledger.record({ fingerprint: fpA }), 2);
    assert.equal(ledger.canRetry({ fingerprint: fpA }), false);
    assert.equal(ledger.canRetry({ fingerprint: fpB }), true, 'unrelated fingerprint keeps a fresh budget');
    assert.equal(ledger.record({ fingerprint: fpB }), 1);
});

test('RetryLedger: counts getter returns a copy', () => {
    const ledger = new RetryLedger({ perFingerprintLimit: 2 });
    ledger.record({ fingerprint: 'x' });
    const counts = ledger.counts;
    counts.set('y', 9);
    assert.equal(ledger.counts.has('y'), false);
});

// ─── classifyFailure ────────────────────────────────────────────────────────

test('classifyFailure: timeout is transient infrastructure', () => {
    assert.equal(classifyFailure({ evidence: { source: 'process', timedOut: true } }), FailureClass.TRANSIENT_INFRASTRUCTURE);
    assert.equal(classifyFailure({ evidence: { source: 'process', errorCode: 'rate_limit' } }), FailureClass.TRANSIENT_INFRASTRUCTURE);
    assert.equal(classifyFailure({ evidence: { source: 'process', errorCode: 'service_unavailable' } }), FailureClass.TRANSIENT_INFRASTRUCTURE);
});

test('classifyFailure: invalid tool request', () => {
    assert.equal(classifyFailure({ evidence: { source: 'tool', errorCode: 'invalid_arguments' } }), FailureClass.INVALID_TOOL_REQUEST);
    assert.equal(classifyFailure({ evidence: { source: 'tool', errorCode: 'schema_validation' } }), FailureClass.INVALID_TOOL_REQUEST);
});

test('classifyFailure: same fingerprint = failed hypothesis, new fingerprint = verification failure', () => {
    assert.equal(
        classifyFailure({ evidence: { source: 'verification', verificationFailed: true, sameFingerprint: true } }),
        FailureClass.FAILED_HYPOTHESIS
    );
    assert.equal(
        classifyFailure({ evidence: { source: 'verification', verificationFailed: true, sameFingerprint: false } }),
        FailureClass.VERIFICATION_FAILURE
    );
});

test('classifyFailure: permission and environment take precedence over verification', () => {
    assert.equal(
        classifyFailure({ evidence: { source: 'verification', verificationFailed: true, permissionBlocked: true } }),
        FailureClass.PERMISSION_BLOCK
    );
    assert.equal(
        classifyFailure({ evidence: { source: 'policy', verificationFailed: true } }),
        FailureClass.PERMISSION_BLOCK
    );
    assert.equal(
        classifyFailure({ evidence: { source: 'verification', verificationFailed: true, environmentMissing: true } }),
        FailureClass.ENVIRONMENT_MISMATCH
    );
});

test('classifyFailure: no-progress from a zero delta', () => {
    assert.equal(classifyFailure({ evidence: { source: 'progress', progressDelta: 0 } }), FailureClass.NO_PROGRESS);
    assert.equal(classifyFailure({ evidence: { source: 'progress', progressDelta: -2 } }), FailureClass.NO_PROGRESS);
    assert.equal(classifyFailure({ evidence: { source: 'progress', progressDelta: 3 } }), FailureClass.UNKNOWN);
});

test('classifyFailure: unknown stays first-class', () => {
    assert.equal(classifyFailure({ evidence: { source: 'process' } }), FailureClass.UNKNOWN);
    assert.equal(classifyFailure({}), FailureClass.UNKNOWN);
});

// AC22: a workflow-policy/template failure is its own non-retryable class. The
// error code is the runtime path (scheduler `failureEvidence` sets
// `source: 'scheduler'`); the source string is the direct-classification path.
test('classifyFailure: workflow policy failure is invalid_workflow', () => {
    assert.equal(
        classifyFailure({ evidence: { source: 'scheduler', errorCode: 'MERCI-WORKFLOW-POLICY-ERR' } }),
        FailureClass.INVALID_WORKFLOW
    );
    assert.equal(
        classifyFailure({ evidence: { source: 'workflow_policy' } }),
        FailureClass.INVALID_WORKFLOW
    );
    assert.equal(FailureClass.INVALID_WORKFLOW, 'invalid_workflow');
});

test('classifyFailure: workflow-policy branch leaves existing outcomes unchanged', () => {
    assert.equal(classifyFailure({ evidence: { source: 'policy' } }), FailureClass.PERMISSION_BLOCK);
    assert.equal(classifyFailure({ evidence: { source: 'process', timedOut: true } }), FailureClass.TRANSIENT_INFRASTRUCTURE);
    assert.equal(classifyFailure({ evidence: { source: 'process', errorCode: 'rate_limit' } }), FailureClass.TRANSIENT_INFRASTRUCTURE);
});

// ─── stateFingerprint / compareProgress ─────────────────────────────────────

test('stateFingerprint: identical snapshots repeat, changed state differs', () => {
    const a = { failingTests: 1, completedSteps: 3, failureFingerprint: 'x', diff: 'patch-a' };
    const b = { failingTests: 1, completedSteps: 3, failureFingerprint: 'x', diff: 'patch-a' };
    const c = { failingTests: 1, completedSteps: 3, failureFingerprint: 'x', diff: 'patch-b' };
    assert.equal(stateFingerprint({ snapshot: a }), stateFingerprint({ snapshot: b }));
    assert.notEqual(stateFingerprint({ snapshot: a }), stateFingerprint({ snapshot: c }));
});

test('compareProgress: rewards fewer failures, more steps, changed evidence/diff', () => {
    const prev = { failingTests: 2, completedSteps: 1, failureFingerprint: 'x', diff: 'a' };
    const stall = { failingTests: 2, completedSteps: 1, failureFingerprint: 'x', diff: 'a' };
    const fixed = { failingTests: 0, completedSteps: 3, failureFingerprint: 'none', diff: 'c' };
    const churn = { failingTests: 2, completedSteps: 1, failureFingerprint: 'x', diff: 'b' };
    assert.equal(compareProgress({ previous: prev, current: stall }), 0);
    assert.ok(compareProgress({ previous: prev, current: fixed }) > 0);
    assert.equal(compareProgress({ previous: prev, current: churn }), 1, 'diff churn alone is weak progress');
});
