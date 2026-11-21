// @ts-check
/**
 * @file Abort classification shared by the native OAI transport.
 * @version 0.21.0
 *
 * @description
 * A signal that is already aborted must not launder an unrelated failure into
 * a cancel or a timeout. Both the HTTP connector and the SSE reader ask this
 * predicate whether the thrown value is the abort surfacing, and only then
 * replace it with the SDK's own error.
 */

/**
 * Whether a failure is the caller's abort surfacing, not an unrelated error
 * that happened while the signal was already aborted.
 * @param {{error: unknown, signal?: AbortSignal}} arg0
 * @returns {boolean}
 */
export function isAbortFailure({ error, signal }) {
    if (!signal?.aborted) return false;
    const failure = /** @type {{name?: string, cause?: unknown}} */ (error);
    return failure?.name === 'AbortError' || error === signal.reason || failure?.cause === signal.reason;
}
