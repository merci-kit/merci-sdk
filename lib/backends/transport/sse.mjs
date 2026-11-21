// @ts-check
/**
 * @file Strict server-sent-event reader for the shared fetch/SSE layer the OAI, Anthropic and Google connectors use.
 * @version 0.22.0
 *
 * @description
 * Decodes a WHATWG `ReadableStream<Uint8Array>` into dispatches and parses
 * their JSON payloads with the OpenAI SDK's exact rules: blank line dispatch,
 * `[DONE]` sentinel, error chunks raised as API errors carrying the response
 * headers, and a clean end when the caller's abort surfaced. Deliberately not
 * the lenient JAI reader.
 */

import { LIMITS } from '../../core/limit-config.mjs';
import { isAbortFailure } from './abort.mjs';
import { createStreamApiError } from './errors.mjs';

/** The end-of-stream sentinel the OAI wire puts in the last `data:` line. */
const DONE_SENTINEL = '[DONE]';

/**
 * One dispatched server-sent event: the `event:` name (or null) and the joined
 * `data:` payload.
 * @typedef {Object} SseEvent
 * @property {string|null} event
 * @property {string} data
 */

/**
 * The fields accumulated for the event currently being read.
 * @typedef {Object} SseState
 * @property {string|null} event
 * @property {Array<string>} data
 * @property {number} dataLength - UTF-8 bytes across `data`, bounded by the caller.
 */

/**
 * The incremental line splitter: the text decoded but not yet dispatched and
 * the index the scan resumes at. Each byte is scanned once, never from 0 again.
 * @typedef {Object} LineScanner
 * @property {string} buffer
 * @property {number} scanned
 */

/**
 * The non-retryable failure for a frame above the `sse_max_line_bytes` cap: the
 * stream is unusable, so a retry would replay the same bytes.
 * @param {{maxBytes: number}} arg0
 * @returns {Error & {code: string, nonRetryable: boolean}}
 */
export function sseLineTooLong({ maxBytes }) {
    const error = /** @type {Error & {code: string, nonRetryable: boolean}} */ (
        new Error(`SSE line exceeds the ${maxBytes}-byte limit (sse_max_line_bytes).`)
    );
    error.code = 'SSE_LINE_TOO_LONG';
    error.nonRetryable = true;
    return error;
}

/**
 * Appends the newly decoded text and splits it into complete lines, keeping the
 * unterminated tail as the pending line. A trailing `\r` is held back because it
 * may be the first half of a `\r\n` split across chunks. Handles `\n`, `\r\n`
 * and bare `\r` terminators.
 * @param {{text: string, scanner: LineScanner}} arg0
 * @returns {Array<string>}
 */
function takeLines({ text, scanner }) {
    scanner.buffer += text;
    const buffer = scanner.buffer;
    /** @type {Array<string>} */
    const lines = [];
    let start = 0;
    let i = scanner.scanned;
    for (; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n') {
            lines.push(buffer.slice(start, i));
            start = i + 1;
            continue;
        }
        if (ch === '\r') {
            if (i + 1 >= buffer.length) break;
            lines.push(buffer.slice(start, i));
            start = buffer[i + 1] === '\n' ? i + 2 : i + 1;
            i = start - 1;
        }
    }
    scanner.buffer = buffer.slice(start);
    scanner.scanned = i - start;
    return lines;
}

/**
 * Feeds one line into the event state. Returns the event to dispatch on a
 * blank line, or null while the event is still being accumulated.
 * @param {{line: string, state: SseState}} arg0
 * @returns {SseEvent|null}
 */
function consumeLine({ line, state }) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!text) {
        if (!state.event && state.data.length === 0) return null;
        const dispatched = { event: state.event, data: state.data.join('\n') };
        state.event = null;
        state.data = [];
        state.dataLength = 0;
        return dispatched;
    }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') state.event = value;
    else if (field === 'data') {
        state.data.push(value);
        state.dataLength += Buffer.byteLength(value, 'utf8');
    }
    return null;
}

/**
 * Reads server-sent events from a response body. The trailing event is flushed
 * once at EOF; cancelling the iterator cancels the body. A line or event payload
 * above `sse_max_line_bytes` stops the read with a non-retryable
 * `SSE_LINE_TOO_LONG` error. `cleanup` (the transport's signal release) runs
 * once the body is done, cancelled or failed.
 * @param {{stream: ReadableStream<Uint8Array>, cleanup?: () => void, trace?: {sawBytes?: boolean}|null}} arg0
 * @returns {AsyncGenerator<SseEvent, void, unknown>}
 */
export async function* iterateSseEvents({ stream, cleanup, trace = null }) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const maxBytes = LIMITS.sse_max_line_bytes;
    /** @type {SseState} */
    const state = { event: null, data: [], dataLength: 0 };
    /** @type {LineScanner} */
    const scanner = { buffer: '', scanned: 0 };
    let finished = false;
    try {
        while (!finished) {
            const { value, done } = await reader.read();
            if (done) finished = true;
            const text = done ? decoder.decode() : (value ? decoder.decode(value, { stream: true }) : '');
            if (trace && text.length > 0) trace.sawBytes = true;
            const lines = takeLines({ text, scanner });
            if (Buffer.byteLength(scanner.buffer, 'utf8') > maxBytes) throw sseLineTooLong({ maxBytes });
            for (const line of lines) {
                const event = consumeLine({ line, state });
                if (Buffer.byteLength(line, 'utf8') > maxBytes || state.dataLength > maxBytes) throw sseLineTooLong({ maxBytes });
                if (event) yield event;
            }
        }
        if (scanner.buffer.endsWith('\r')) {
            const event = consumeLine({ line: scanner.buffer.slice(0, -1), state });
            scanner.buffer = '';
            if (event) yield event;
        } else if (scanner.buffer) {
            const event = consumeLine({ line: scanner.buffer, state });
            scanner.buffer = '';
            if (event) yield event;
        }
        const pending = consumeLine({ line: '', state });
        if (pending) yield pending;
    } finally {
        if (!finished) {
            try { await reader.cancel(); } catch { /* the body is already gone */ }
        }
        try { reader.releaseLock(); } catch { /* a pending read still owns the lock */ }
        cleanup?.();
    }
}

/**
 * The terminal facts a consumer cannot infer from the events: the stream ended
 * with the `[DONE]` sentinel instead of a clean EOF (a proxy closing the body),
 * and whether the caller's abort ended it.
 * @typedef {{sawDone: boolean, sawAbort?: boolean, sawBytes?: boolean}} SseJsonState
 */

/**
 * Reads server-sent events and yields their parsed JSON payloads. Stops at
 * `doneSentinel` (`[DONE]` by default; `null` disables it, so every frame is
 * parsed and a clean EOF ends the stream), raises error chunks as API errors
 * carrying the response `headers`, and ends cleanly (without throwing) once the
 * caller's abort surfaced. `isErrorPayload` replaces the default
 * `event: error`/parsed-`.error` test; `toError` builds the thrown error from the
 * payload and headers (default {@link createStreamApiError}). The optional
 * `state` records that the sentinel was actually consumed (`sawDone` stays
 * false when the sentinel is disabled).
 * @param {{stream: ReadableStream<Uint8Array>, signal?: AbortSignal, headers?: Headers, cleanup?: () => void, state?: SseJsonState, doneSentinel?: string|null, isErrorPayload?: (parsed: object) => boolean, toError?: (payload: unknown, headers?: Headers) => Error}} arg0
 * @returns {AsyncGenerator<object, void, unknown>}
 */
export async function* iterateSseJson({ stream, signal, headers, cleanup, state, doneSentinel = DONE_SENTINEL, isErrorPayload, toError }) {
    try {
        for await (const sse of iterateSseEvents({ stream, trace: state })) {
            if (signal?.aborted) {
                if (state) state.sawAbort = true;
                return;
            }
            if (doneSentinel !== null && sse.data === doneSentinel) {
                if (state) state.sawDone = true;
                return;
            }
            /** @type {any} */
            let parsed;
            try {
                parsed = JSON.parse(sse.data);
            } catch {
                throw new SyntaxError('Error reading response: malformed server-sent event JSON.');
            }
            const isError = isErrorPayload
                ? isErrorPayload(parsed)
                : sse.event === 'error' || (parsed && typeof parsed === 'object' && parsed.error);
            if (isError) {
                const payload = parsed && typeof parsed === 'object' ? (parsed.error ?? parsed) : parsed;
                throw toError ? toError(payload, headers) : createStreamApiError({ error: payload, headers });
            }
            yield parsed;
        }
    } catch (error) {
        if (isAbortFailure({ error, signal })) {
            if (state) state.sawAbort = true;
            return;
        }
        throw error;
    } finally {
        cleanup?.();
    }
}
