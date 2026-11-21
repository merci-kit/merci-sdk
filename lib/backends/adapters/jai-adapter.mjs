// @ts-check
/**
 * @file JAI backend adapter.
 * @version 0.12.0
 *
 * @description
 * Wraps the JAI vendor transport for the agentic loop: builds the vendor
 * stream request (threading isLastIteration / runContext), eagerly starts the
 * vendor generator so retries fire, and normalizes reasoning / tool-call /
 * metadata events into unified stream events.
 */

import { extractXmlToolCalls as _extractXmlToolCalls } from '../../tools/tool-execution.mjs';
import { createFirstTokenEmitter, sessionIdOf, toolCallIdentity } from './adapter-common.mjs';
/**
 * @typedef {{ sessionId?: string, _sessionRunCtx?: { runId?: string }, _headerTimeoutMs?: number, stream: (messages: Array<import('../../messaging/unified-message.mjs').MessageRow>, opts: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>> }} JaiSession
 * @typedef {{ isLastIteration: boolean, runContext: unknown | null }} JaiRequest
 * @typedef {{ id?: string, name?: string, arguments?: string|Object, thoughtSignature?: string|null }} JaiToolCall
 */




/**
 * JAI backend adapter — implements the shared adapter contract for the
 * agentic loop: request building, vendor stream execution, stream
 * consumption, and tool-call extraction / formatting.
 * @type {import('./adapter-common.mjs').AdapterContract}
 */
export const jaiAdapter = {
    vendorName: 'JAI',

    /**
 * Builds the vendor stream request for the JAI transport.
 * @param {{model: string, preparedMessages: Array<Record<string, any>>, isLastIteration: boolean, session: Record<string, any>, runContext?: Record<string, any>}} arg0
 * @returns {{request: { session: Record<string, any>, messages: Array<Record<string, any>>, isLastIteration: boolean, runContext: any }, observability: { model: string, messages: Array<Record<string, any>> }}}
 */
    buildVendorRequest({ model, preparedMessages, isLastIteration, session, runContext }) {
        return {
            request: { session, messages: preparedMessages, isLastIteration, runContext: runContext ?? null },
            observability: { model, messages: preparedMessages }
        };
    },

    /**
 * Starts the JAI vendor stream, awaiting its first chunk so connect/header
 * failures throw from the factory call and get retried.
 * @param {{vendorClient: Record<string, any>, request: *, signal?: AbortSignal, session?: JaiSession}} arg0
 *     `request.session.stream()`; the http client appears only at the
 *     envelope boundary.
 *     `request.session.stream()`; the http client appears only at the
 *     envelope boundary.
 * @returns {Promise<Record<string, any>>} An async-iterable replaying the first chunk.
 */
    async executeVendorRequest({ vendorClient, request, signal, session }) {
        const sid = sessionIdOf({ session });
        const streamOpts = {
            signal,
            isLastIteration: request.isLastIteration,
            runContext: request.runContext
        };
        const headerTimeoutMs = session?._headerTimeoutMs;
        if (typeof headerTimeoutMs === 'number' && Number.isFinite(headerTimeoutMs) && headerTimeoutMs > 0) {
            /** @type {any} */
            const opts = streamOpts;
            opts.headerTimeoutMs = headerTimeoutMs;
        }
        if (sid) { /** @type {any} */ (streamOpts).headers = { 'X-Merci-Session-Id': sid }; }
        const gen = request.session.stream({ initialInput: request.messages, options: streamOpts });
        let first;
        try {
            first = await gen.next();
        } catch (err) {
            if (gen.return) gen.return(undefined).catch(() => {});
            throw err;
        }
        let firstYielded = false;
        /** @type {AsyncIterable<any>} */
        return {
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        if (!firstYielded) { firstYielded = true; return first; }
                        return gen.next();
                    },
                    /** @param {*} [value] */
                    return(value) { return gen.return(value); }
                };
            }
        };
    },

    /**
 * Consumes JAI transport events into unified stream events (reasoning →
 * thought, metadata → thought_signature).
 * @param {{rawStream: *, signal: *}} arg0
 * @returns {AsyncGenerator<Record<string, any>>} Unified stream events (first_token/text/thought/tool_calls/thought_signature/...).
 */
    async *consumeStream({ rawStream, signal }) {
        const { maybeFirstToken } = createFirstTokenEmitter();

        for await (const event of rawStream) {
            switch (event.type) {
                case 'text':
                    yield* maybeFirstToken();
                    yield event;
                    break;
                case 'quota':
                case 'tool_call_delta':
                case 'finish':
                case 'premature_end':
                case 'restart':
                case 'unknown':
                    yield event;
                    break;
                case 'reasoning_item':
                    if (typeof event.content === 'string' && event.content) {
                        yield { type: 'thought', content: event.content };
                    }
                    yield event;
                    break;
                case 'reasoning': {
                    const d = event.data || {};
                    const text = typeof d.content === 'string' ? d.content
                        : typeof d.text === 'string' ? d.text
                        : typeof d.reasoning === 'string' ? d.reasoning : '';
                    if (text) yield { type: 'thought', content: text };
                    break;
                }
                case 'tool_calls':
                    yield* maybeFirstToken();
                    yield { type: 'tool_calls', calls: event.calls };
                    break;
                case 'metadata':
                    if (event.thoughtSignature) {
                        yield { type: 'thought_signature', signature: event.thoughtSignature };
                    }
                    break;
                case 'error':
                    yield { type: 'error', error_message: event.error_message, error_type: event.error_type, data: event.data };
                    break;
            }
        }
    },

    /**
 * Extracts `<tool_call>` rows from raw assistant text.
 * @param {{text: string}} arg0
 * @returns {Array<Record<string, any>>} Normalized assistant_message_tool rows.
 */
    extractXmlToolCalls({ text }) {
        return _extractXmlToolCalls({ text }).map(tc => ({
            id: tc.id,
            type: 'assistant_message_tool',
            name: tc.name,
            arguments: tc.arguments
        }));
    },

    /**
 * Formats a tool call into a display row.
 * @param {{call: JaiToolCall, result: *, index?: number}} arg0
 * @returns {Record<string, any>} Display row (id/name/args/thoughtSignature).
 */
    formatToolCall({ call, result, index }) {
        const identity = toolCallIdentity({ call, result, fallbackId: `call_${index}` });
        return {
            id: identity.id,
            // JAI's own word for an unnamed call (the other adapters keep '').
            name: identity.name || result?.name || 'unknown',
            args: call.arguments,
            thoughtSignature: call.thoughtSignature ?? null
        };
    }
};
