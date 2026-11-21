// @ts-check
import { LIMITS } from '../../core/limit-config.mjs';
import { AbortedError, ConfigurationError } from '../../core/errors.mjs';

/**
 * @file ApprovalCoordinator — HITL approval gate.
 * @version 0.12.0
 *
 * @description
 * One pending approval, resolvable before or after wait() (early-resolve
 * buffering), with an auto-decline timeout and abort-awareness. Backs both
 * the plan_exit tool and the workflow executor's per-step HITL gates.
 */

/**
 * A settled approval decision: the verdict plus whatever details the decider
 * attached (a reason, the tool call, an extension round…).
 * @typedef {{approved: boolean, reason?: string} & Record<string, unknown>} ApprovalDecision
 */

/**
 * A single HITL approval gate. `wait()` blocks until resolve() (any time), the
 * timeout auto-declines, or the signal aborts. Consumed once per gate; a
 * timed-out or aborted coordinator never serves a late decision.
 */
export class ApprovalCoordinator {
    #settledByTimeout = false;
    /** One decision per gate: the first resolve wins, a duplicate returns false. */
    #decided = false;
    /**
 * @param {{timeoutMs?: number}} arg0
 */
    constructor({ timeoutMs = LIMITS.dag_hitl_timeout_ms } = {}) {
        this.timeoutMs = timeoutMs;
        /** @type {ApprovalDecision|null} */
        this._pending = null;
        /** @type {((value: ApprovalDecision) => void)|null} */
        this._resolve = null;
        this._timer = null;
        this._signal = null;
        this._abortHandler = null;
        /** @type {Promise<ApprovalDecision>|null} */
        this._waitPromise = null;
        this._aborted = false;
        this._timedOut = false;
        this.#settledByTimeout = false;
        this._onTimeoutCb = null;
    }

    /**
     * True when the last settled gate was auto-declined by the timeout rather
     * than an explicit resolve(false).
     * @returns {boolean}
     */
    get timedOut() {
        return this.#settledByTimeout;
    }

    /**
     * Registers a callback fired when the auto-decline timeout elapses.
     * @param {{cb: Function}} arg0
     * @returns {ApprovalCoordinator}
     */
    onTimeout({ cb }) {
        this._onTimeoutCb = typeof cb === 'function' ? cb : null;
        return this;
    }

    /**
     * Blocks until the gate settles. Resolves the buffered early decision when
     * one exists (consumed once); otherwise rejects on abort or settles on the
     * timeout / a later resolve(). A pre-aborted wait rejects immediately.
     * @param {{signal?: AbortSignal|null}} [arg0]
     * @returns {Promise<ApprovalDecision>}
     */
    wait({ signal } = {}) {
        if (!this._waitPromise) {
            this._timedOut = false;
            this.#settledByTimeout = false;
            // A buffered decision is still this gate's; only a gate that starts
            // with nothing pending opens a fresh decision latch.
            if (!this._pending) this.#decided = false;
        }
        if (signal?.aborted) {
            this._aborted = true;
            this._pending = null;
            return Promise.reject(new AbortedError({ message: 'Workflow aborted while waiting for approval.', options: { cause: signal.reason } }));
        }
        if (this._pending && !this._aborted) {
            const approval = this._pending;
            this._pending = null;
            return Promise.resolve(approval);
        }
        if (this._waitPromise) return this._waitPromise;
        this._waitPromise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._signal = signal || null;
            const onAbort = () => {
                clearTimeout(/** @type {NodeJS.Timeout} */ (this._timer));
                this._timer = null;
                this._resolve = null;
                this._abortHandler = null;
                this._waitPromise = null;
                this._pending = null;
                this._aborted = true;
                if (signal) signal.removeEventListener('abort', onAbort);
                reject(new AbortedError({ message: 'Workflow aborted while waiting for approval.', options: { cause: signal?.reason } }));
            };
            this._abortHandler = onAbort;
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            this._timer = setTimeout(() => this._onTimeout(), this.timeoutMs);
        });
        return this._waitPromise;
    }

    _onTimeout() {
        this.#settledByTimeout = true;
        this._timedOut = true;
        this.#decided = true;
        if (this._onTimeoutCb) this._onTimeoutCb();
        this._settle({ approved: false, details: { reason: 'HITL Timeout Expired. Auto-aborting step execution.' } });
    }

    /**
     * Settles the gate with the given decision (+ details). The first decision
     * for a gate wins: a duplicate returns false and never overwrites it (a
     * retried click cannot undo an operator's decline). A no-op after the gate
     * timed out or aborted. A non-boolean `approved` is a `ConfigurationError`,
     * never a truthy pass.
     * @param {{approved?: boolean, details?: Record<string, unknown>}} [arg0]
     * @returns {boolean} true when this call decided the gate, false otherwise.
     */
    resolve({ approved = false, details = {} } = {}) {
        if (typeof approved !== 'boolean') {
            throw new ConfigurationError({ message: 'ApprovalCoordinator.resolve: approved must be a boolean.', options: { option: 'approved' } });
        }
        if (this._aborted || this._timedOut) return false;
        // A resolve that finds neither a waiter nor a buffered decision starts
        // the next gate: its decision latch is fresh.
        if (!this._waitPromise && !this._pending) this.#decided = false;
        if (this.#decided) return false;
        this.#decided = true;
        this._settle({ approved, details });
        return true;
    }

    /**
     * @param {{approved: boolean, details?: Record<string, unknown>}} arg0
     */
    _settle({ approved, details = {} }) {
        clearTimeout(/** @type {NodeJS.Timeout} */ (this._timer));
        this._timer = null;
        if (this._abortHandler && this._signal) {
            this._signal.removeEventListener('abort', this._abortHandler);
        }
        this._abortHandler = null;
        this._signal = null;
        const approval = { approved, ...details };
        if (this._resolve) {
            const done = this._resolve;
            this._resolve = null;
            this._waitPromise = null;
            done(approval);
        } else {
            this._pending = approval;
        }
    }
}
