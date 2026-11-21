// @ts-check


/**
 * @file Supervisory loop policy primitives (pure, no LLM, no IO).
 * @version 0.12.0
 *
 * @description
 * The tutorial-grade reliability bits shared by every orchestrator: a failure
 * taxonomy, the evidence builder the taxonomy reads, a fingerprint-keyed
 * failure/replan ledger, and no-progress detection. They are deliberately pure
 * so they can be unit-tested without a client or a backend. The DAG executor
 * uses `RetryLedger` for its replan budget and `classifyFailure` for labels;
 * per-node verify retries use the orchestrators' own global attempt counters
 * (see StateMachine).
 */
import { createHash } from 'node:crypto';
import { LIMITS } from '../../core/limit-config.mjs';

import { ERROR_CODES, TIMEOUT_CODES } from '../../core/constants/index.mjs';


/**
 * The failure taxonomy: the classification labels returned by classifyFailure().
 */
export const FailureClass = Object.freeze({
    TRANSIENT_INFRASTRUCTURE: 'transient_infrastructure',
    INVALID_TOOL_REQUEST: 'invalid_tool_request',
    FAILED_HYPOTHESIS: 'failed_hypothesis',
    VERIFICATION_FAILURE: 'verification_failure',
    PERMISSION_BLOCK: 'permission_block',
    ENVIRONMENT_MISMATCH: 'environment_mismatch',
    INVALID_WORKFLOW: 'invalid_workflow',
    NO_PROGRESS: 'no_progress',
    UNKNOWN: 'unknown'
});

/**
 * A progress snapshot: the counters that say whether a run moved forward.
 * @typedef {Object} ProgressSnapshot
 * @property {number} [failingTests]
 * @property {number} [completedSteps]
 * @property {string} [failureFingerprint]
 * @property {string} [diff]
 */

/** @param {{payload: string}} arg0 */
const hash12 = ({ payload }) => createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, LIMITS.loop_fingerprint_chars);


/**
 * Stable key for "is this the same failed attempt as before?". Action + the
 * exact input we handed the verifier + the failure signature. A reworded
 * prompt is NOT a new attempt; a changed hypothesis or output is.
 * @param {{action?: string, input?: string, signature?: string}} [parts]
 * @returns {string} 12-char hex fingerprint
 */
export function failureFingerprint({ action = '', input = '', signature = '' } = {}) {
    return hash12({ payload: [action, input, signature].join('|') });
}


/**
 * Retry budget keyed by failure fingerprint, NOT by a global counter. Used by
 * the DAG executor for its replan/failure ledger (fairness across steps): a
 * fingerprint with `limit` recorded failures has no budget left. `canRetry` is
 * checked AFTER `record`.
 *
 * NOTE: per-node verify retries do NOT use this — StateMachine and the DAG
 * executor use a global per-node attempt cap (`maxRetries` retries, i.e.
 * `maxRetries + 1` attempts). Fingerprints there are diagnostics only.
 */
export class RetryLedger {
    #limit;
    #counts = new Map();

    
    /**
      * @param {{perFingerprintLimit: number}} arg0
     */
        constructor({ perFingerprintLimit }) {
        this.#limit = perFingerprintLimit;
    }

    
    /**
     * @param {{fingerprint: string}} arg0 -
     * @returns {number}
     */
        record({ fingerprint }) {
        const next = (this.#counts.get(fingerprint) ?? 0) + 1;
        this.#counts.set(fingerprint, next);
        return next;
    }

    
    /**
     * @param {{fingerprint: string}} arg0 -
     * @returns {boolean}
     */
        canRetry({ fingerprint }) {
        return (this.#counts.get(fingerprint) ?? 0) < this.#limit;
    }

    
    /**
     * A copy of fingerprint → attempt count.
     * @returns {Map<string, number>}
     */
        get counts() { return new Map(this.#counts); }

    
    /**
     * Serializes the ledger for durable checkpoints.
     * @returns {{limit: number, counts: Array<[string, number]>}}
     */
        save() {
        return { limit: this.#limit, counts: [...this.#counts] };
    }

    
    /**
     * Restores a ledger from save() output.
     * @param {{ limit?: number, counts?: Array<[string, number]> }} [state] - { limit, counts }.
     * @returns {RetryLedger}
     */
        static load(state) {
        const ledger = new RetryLedger({ perFingerprintLimit: state?.limit ?? 2 });
        if (state?.counts) ledger.#counts = new Map(state.counts);
        return ledger;
    }
}


/**
 * budget is spent, else `onClaim(next, label)` with the incremented count
 * and `[replan next/max]` label.
 * @template T
 * @param {{used: number, max: number, onExhausted: () => T, onClaim: (arg0: {next: number, label: string}) => T}} arg0 - Replans already claimed.
 * @returns {T} Whatever the invoked handler returns.
 */
export function claimReplan({ used, max, onExhausted, onClaim }) {
    if (used >= max) return onExhausted();
    const next = used + 1;
    return onClaim({ next, label: `[replan ${next}/${max}]` });
}


/**
 * permission/environment boundaries are checked before verification outcomes
 * (a failed command may be a blocked path, not a bad patch).
 * @param {{evidence?: {source?: string, permissionBlocked?: boolean, timedOut?: boolean, errorCode?: string|null, environmentMissing?: boolean, verificationFailed?: boolean, sameFingerprint?: boolean, progressDelta?: number}}} arg0 -
 * @returns {string} a FailureClass
 */
export function classifyFailure({ evidence = {} } = {}) {
    const {
        permissionBlocked, source, timedOut, errorCode,
        environmentMissing, verificationFailed, sameFingerprint, progressDelta
    } = evidence;

    if (permissionBlocked || source === 'policy') return FailureClass.PERMISSION_BLOCK;
    // A policy/template failure is a code compare so the scheduler needs no
    // import of the workflow-policy module; `source` is the fallback for a
    // caller that classifies directly. Non-retryable at the scheduler layer.
    if (errorCode === ERROR_CODES.WORKFLOW_POLICY || source === 'workflow_policy') return FailureClass.INVALID_WORKFLOW;
    if (timedOut || errorCode === 'rate_limit' || errorCode === 'service_unavailable') return FailureClass.TRANSIENT_INFRASTRUCTURE;
    if (errorCode === 'invalid_arguments' || errorCode === 'schema_validation') return FailureClass.INVALID_TOOL_REQUEST;
    if (environmentMissing) return FailureClass.ENVIRONMENT_MISMATCH;
    if (source === 'verification' && verificationFailed) {
        return sameFingerprint ? FailureClass.FAILED_HYPOTHESIS : FailureClass.VERIFICATION_FAILURE;
    }
    if (source === 'progress' && (progressDelta ?? 0) <= 0) return FailureClass.NO_PROGRESS;
    return FailureClass.UNKNOWN;
}


/**
 * Build the evidence `classifyFailure` consumes from a normalized run result.
 * Only `errorCode`, `errorName` and `timedOut` are read, so no message or
 * provider payload can reach the taxonomy. The `TimeoutError` name counts, so a
 * thrown error and a normalized result agree; `source: 'scheduler'` names the
 * producer and keeps the taxonomy branch visible.
 * @param {{result: {errorCode?: string|null, timedOut?: boolean, errorName?: string|null}}} arg0 -
 * @returns {{
 *   errorCode: string|null,
 *   timedOut: boolean,
 *   permissionBlocked: boolean,
 *   environmentMissing: boolean,
 *   source: 'scheduler'
 * }}
 */
export function failureEvidence({ result }) {
    const errorCode = typeof result?.errorCode === 'string' ? result.errorCode : null;
    const errorName = typeof result?.errorName === 'string' ? result.errorName : null;
    const timedOut = result?.timedOut === true
        || errorName === 'TimeoutError'
        || (errorCode !== null && TIMEOUT_CODES.has(errorCode));
    return {
        errorCode,
        timedOut,
        // `PERMISSION_DENIED` is a tool-result code, not an `ERROR_CODES` member.
        permissionBlocked: errorCode === 'PERMISSION_DENIED' || errorCode === ERROR_CODES.GUARDRAIL,
        environmentMissing: errorCode === 'ENOENT' || errorCode === 'ENOTDIR',
        source: 'scheduler'
    };
}


/**
 * same fingerprint — used to catch oscillation, not just consecutive stalls.
 * @param {{snapshot?: ProgressSnapshot}} arg0 -
 * @returns {string} 12-char hex fingerprint
 */
export function stateFingerprint({ snapshot = {} } = {}) {
    const { failingTests = 0, completedSteps = 0, failureFingerprint = '', diff = '' } = snapshot;
    return hash12({ payload: [failingTests, completedSteps, failureFingerprint, diff].join('|') });
}


/**
 * Compares two progress snapshots — a positive score means the run moved forward.
 * @param {{previous?: ProgressSnapshot, current?: ProgressSnapshot}} arg0
 */
export function compareProgress({ previous = {}, current = {} } = {}) {
    let score = 0;
    score += (previous.failingTests ?? 0) - (current.failingTests ?? 0);
    score += (current.completedSteps ?? 0) - (previous.completedSteps ?? 0);
    if ((current.failureFingerprint ?? '') !== (previous.failureFingerprint ?? '')) score += 1;
    if ((current.diff ?? '') !== (previous.diff ?? '')) score += 1;
    return score;
}
