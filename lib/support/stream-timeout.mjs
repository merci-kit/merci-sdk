// @ts-check


/**
 * @file Pluggable stream timeout policies.
 * @version 0.12.0
 *
 * @description
 * A `StreamTimeoutPolicy` wraps an async iterable (a vendor SDK stream or
 * fetch-body ReadableStream) with a timeout guard. The default
 * `InactivityTimeoutPolicy` implements the sliding-window inactivity timeout
 * that JAI's `stream()` uses today: the timer is
 * reset on every chunk; if no chunk arrives within `timeoutMs`, the
 * AbortController is signaled and the wrapped stream aborts.
 *
 * @example
 * const { InactivityTimeoutPolicy } = await import('./stream-timeout.mjs');
 * const policy = new InactivityTimeoutPolicy({ timeoutMs: 150_000 });
 * const wrapped = policy.wrapStream(originalStream, externalSignal);
 * for await (const chunk of wrapped) { ... }
 */
import { LIMITS } from '../core/limit-config.mjs';
/**
 * @typedef {Object} StreamTimeoutPolicy
 * @property {number} timeoutMs - The inactivity timeout in milliseconds.
 * @property {(arg0: {stream: AsyncIterable<string>, signal?: AbortSignal|null, onTimeoutAbort?: ((arg0: {err: unknown}) => void)|null}) => AsyncIterable<string>} wrapStream
 *   Wrap a stream with the policy's timeout guard. The returned iterable
 *   must abort (with an `AbortError` or `Error('...timeout...')`) if no chunk
 *   arrives within `timeoutMs`. If the caller provides an external
 *   `AbortSignal`, aborts on that signal must also propagate to the wrapped
 *   stream.
 */





/**
 * Sliding-window inactivity timeout. Mirrors the JAI `stream()` behavior:
 *   - on each chunk, reset the timer
 *   - on timeout, abort the AbortController with an Error whose message
 *     includes "timeout"
 *   - respect an external `AbortSignal` (link via `addEventListener('abort')`)
 *
 * The default `timeoutMs` is `DEFAULT_STREAM_TIMEOUT_MS` (150_000 ms = 150 s,
 * the JAI current default).
 */
export class InactivityTimeoutPolicy {
    
    /**
 * @param {{timeoutMs?: number, firstChunkMs?: number, onTimeout?: ((error: Error) => void)|null}} arg0
 *   chunk arrives (time-to-first-token). 0 (default) reuses `timeoutMs` for both windows.
 */
        constructor({ timeoutMs = LIMITS.stream_timeout_ms, firstChunkMs = 0, onTimeout = null } = {}) {
        this.timeoutMs = timeoutMs;
        this.firstChunkMs = firstChunkMs;
        this._onTimeout = onTimeout;
    }

    
    /**
     *   timeout error right before the local abort fires. Abort the underlying
     *   vendor request here — the local AbortController alone would leave the
     *   HTTP connection running after the timeout (the pre-fix leak).
     * @returns {AsyncIterable<string>} A wrapped stream that aborts on inactivity.
     * @param {{stream: AsyncIterable<string>, signal?: AbortSignal|null, onTimeoutAbort?: ((arg0: {err: unknown}) => void)|null}} arg0
     */
        wrapStream({ stream, signal = null, onTimeoutAbort = null }) {
        const wrapped = this._wrapStream({ stream, signal, onTimeoutAbort });
        // The transport records terminal facts on the source iterable
        // (e.g. `streamState.sawDone`). The wrapper is a new generator, so the
        // property must ride along by the same identity or the adapter loses it.
        const state = /** @type {{streamState?: object}|null} */ (/** @type {unknown} */ (stream))?.streamState;
        if (state) Object.defineProperty(wrapped, 'streamState', { value: state, enumerable: false });
        return wrapped;
    }

    
    /**
     * The timeout guard behind {@link InactivityTimeoutPolicy#wrapStream}.
     * @param {{stream: AsyncIterable<string>, signal?: AbortSignal|null, onTimeoutAbort?: ((arg0: {err: unknown}) => void)|null}} arg0
     * @returns {AsyncGenerator<string, void, unknown>}
     */
        async *_wrapStream({ stream, signal = null, onTimeoutAbort = null }) {
        const controller = new AbortController();
        
        /** @type {{ name?: string, message?: string, code?: string }|null} */
                let abortReason = null;
        /** @param {{reason: *}} arg0 */
        /** @param {{reason: *}} arg0 */
        const triggerAbort = ({ reason }) => {
            if (controller.signal.aborted) return;
            abortReason = reason;
            controller.abort(reason);
        };
        const abortFromExternal = () => triggerAbort({ reason: signal?.reason });
        if (signal) {
            if (signal.aborted) abortFromExternal();
            else signal.addEventListener('abort', abortFromExternal, { once: true });
        }

        
        /** @type {((reason?: unknown) => void)|null} */
                let rejectAbort = null;
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        const onAbort = () => {
            const reason = abortReason ?? new Error('Stream aborted');
            if (reason.name === 'AbortError') {
                rejectAbort?.(reason);
            } else {
                const err = /** @type {Error & {code?: string}} */ (new Error(reason.message || 'Stream aborted'));
                err.name = 'AbortError';
                err.cause = reason;
                // A deadline keeps its own code through the wrapper, so one
                // timeout has one error shape wherever it surfaces.
                const code = /** @type {{code?: string}} */ (reason).code;
                if (code !== undefined) err.code = code;
                rejectAbort?.(err);
            }
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });

        
        /** @type {ReturnType<typeof setTimeout>|null} */
                let timeoutId = null;
        /** @param {{windowMs: *, phase: *}} arg0 */
        /** @param {{windowMs: *, phase: *}} arg0 */
        const armTimeout = ({ windowMs, phase }) => {
            if (timeoutId !== null) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                const suffix = phase ? ` ${phase}` : '';
                const err =  (new Error(`Stream inactivity timeout (no data for ${windowMs}ms${suffix})`));
                err.name = 'AbortError';
                /** @type {any} */ (err).code = 'STREAM_TIMEOUT';
                Object.defineProperty(err, 'err', { value: err, configurable: true });
                triggerAbort({ reason: err });
                if (onTimeoutAbort) {
                    // The Error carries its own `err` property (set above), which is
                    // what the adapters destructure to abort the vendor request.
                    try { onTimeoutAbort(/** @type {any} */ (err)); } catch {   }
                }
                if (this._onTimeout) {
                    try { this._onTimeout(err); } catch {   }
                }
            }, windowMs);
        };
        const disarmTimeout = () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const firstWindow = this.firstChunkMs > 0 ? this.firstChunkMs : this.timeoutMs;
        const firstPhase = this.firstChunkMs > 0 ? '(before first chunk)' : '';

        let finished = false;
        
        /** @type {any} */
                let iterator = null;
        try {
            iterator = stream[Symbol.asyncIterator]();
            armTimeout({ windowMs: firstWindow, phase: firstPhase });
            for (;;) {
                const { value, done } = await Promise.race([Promise.resolve(iterator.next()), aborted]);
                if (done) { finished = true; break; }
                disarmTimeout();
                yield value;
                armTimeout({ windowMs: this.timeoutMs, phase: '' });
            }
        } finally {
            disarmTimeout();
            controller.signal.removeEventListener('abort', onAbort);
            if (signal) signal.removeEventListener('abort', abortFromExternal);
            if (!finished) {
                Promise.resolve(iterator?.return?.()).catch(() => {   });
            }
        }
    }
}
