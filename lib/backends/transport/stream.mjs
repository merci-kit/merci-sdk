// @ts-check
/**
 * @file Streaming helpers shared by the transport clients.
 * @version 0.22.0
 *
 * @description
 * The single-use iterable wrapper, the stream-shape predicates and the
 * non-event-stream error builders the OAI, Anthropic and Google clients share.
 * Moved here unchanged from `oai-client.mjs`.
 */

/**
 * Wraps a stream so it can be consumed once: a second `for await` throws instead
 * of silently yielding nothing. Breaking out still cancels the body. The
 * per-stream `state` rides along as the non-enumerable `streamState` so a
 * consumer can tell a `[DONE]` sentinel from a clean connection close.
 * @param {{source: AsyncIterable<unknown>, state?: {sawDone: boolean}}} arg0
 * @returns {AsyncIterable<unknown>}
 */
export function singleUse({ source, state }) {
    let consumed = false;
    const iterable = {
        [Symbol.asyncIterator]() {
            if (consumed) throw new Error('Cannot iterate over a consumed stream.');
            consumed = true;
            return source[Symbol.asyncIterator]();
        },
    };
    if (state) Object.defineProperty(iterable, 'streamState', { value: state, enumerable: false });
    return iterable;
}

/**
 * Whether a transport answer is the single-use iterable a JSON gateway reply is
 * wrapped into, rather than the streaming `Response`.
 * @param {{value: unknown}} arg0
 * @returns {boolean}
 */
export function isStreamIterable({ value }) {
    return !!value && typeof (/** @type {{[Symbol.asyncIterator]?: unknown}} */ (value))[Symbol.asyncIterator] === 'function';
}

/**
 * Reads at most `width` characters of a response body so a non-SSE page can be
 * named in an error without buffering or yielding the whole page.
 * @param {{response: Response, width?: number}} arg0
 * @returns {Promise<string>}
 */
export async function readBodyPrefix({ response, width = 120 }) {
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        return (await response.text()).slice(0, width);
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
        while (text.length < width) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) text += decoder.decode(value, { stream: true });
        }
        if (text.length > width) return text.slice(0, width);
        text += decoder.decode();
    } finally {
        try { await reader.cancel(); } catch { /* the body is already gone */ }
        try { reader.releaseLock(); } catch { /* a pending read still owns the lock */ }
    }
    return text.slice(0, width);
}

/**
 * A 2xx stream request answered with something that is not an event stream (a
 * login page, a WAF block, a JSON gateway error). Non-retryable: replaying the
 * same request would return the same page.
 * @param {{mediaType: string, prefix?: string}} arg0
 * @returns {Error & {code: string, nonRetryable: boolean}}
 */
export function nonJsonStreamError({ mediaType, prefix = '' }) {
    const error = /** @type {Error & {code: string, nonRetryable: boolean}} */ (
        new Error(`OAI stream request answered with '${mediaType || 'no content-type'}' instead of an event stream${prefix ? ` (body starts with: ${JSON.stringify(prefix)})` : ''}.`)
    );
    error.code = 'NON_JSON_STREAM';
    error.nonRetryable = true;
    return error;
}

/**
 * Fails a stream that ended after zero frames with no protocol terminal marker
 * and no abort: a 2xx answered with a proxy page, a bodiless gateway reply, or
 * a JSON envelope with no `error`. A `[DONE]` sentinel or an abort is a valid
 * empty end (the session's empty-response retry owns that case).
 * @param {{source: AsyncIterable<unknown>, mediaType: string, state?: {sawDone?: boolean, sawAbort?: boolean, sawBytes?: boolean}}} arg0
 * @returns {AsyncIterable<unknown>}
 */
export async function* requireStreamFrames({ source, mediaType, state = {} }) {
    let frames = 0;
    for await (const frame of source) {
        frames += 1;
        yield frame;
    }
    // A valid `text/event-stream` that carried zero bytes is a clean empty
    // answer (the session's empty-response retry owns that case). A body that
    // carried bytes but produced no frame is not a usable stream: a text/plain
    // or JSON proxy page, an HTML login page, or HTML mislabelled as SSE (A-11).
    const emptySse = mediaType === 'text/event-stream' && state.sawBytes !== true;
    if (frames === 0 && !emptySse && !state.sawDone && !state.sawAbort) throw nonJsonStreamError({ mediaType });
}
