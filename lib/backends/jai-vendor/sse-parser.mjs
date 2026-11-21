// @ts-check
/**
 * @file JAI SSE stream parsers.
 * @version 0.12.0
 *
 * @description
 * Shared SSE line-split loop plus two event parsers: SSEParser for the chat
 * V9 stream (parallel tool-call assembly, thought-signature capture) and
 * TaskSSEParserV5 for the Task V5 stream.
 */

import { ProtocolType } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { TRUNCATION_MARKER } from '../../core/constants/limits/transport.mjs';
import { SSEError } from './types.mjs';

/**
 * A tool call being assembled from streamed fragments (id, name and arguments
 * arrive piecemeal; the FinishMetadata event finalizes them).
 * @typedef {Object} PendingToolCall
 * @property {string} [id]
 * @property {string|null} [name]
 * @property {string} arguments
 * @property {number|null} [parallelToolIndex]
 * @property {number|null} [choiceIndex]
 * @property {string|null} [thoughtSignature]
 */

/**
 * One parsed SSE event as the parsers emit it: a type tag plus whatever the
 * event carries (text, a tool-call delta, a metadata payload).
 * @typedef {Object} SSEEvent
 * @property {string} [type]
 * @property {string} [content]
 * @property {string} [id]
 * @property {string|null} [name]
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [error_message]
 * @property {string} [error_type]
 * @property {string} [eventType] - The wire event_type, when the gateway sends one.
 * @property {string} [traceId] - The `Grazie-Trace-Id` of the request that produced it.
 * @property {string|null} [thoughtSignature]
 * @property {{type?: string, id?: string, role?: string, status?: string, encrypted_content?: string, content?: Array<Object>, summary?: Array<{type?: string, text?: string}>}} [item] - A replayed native reasoning item (responses protocol).
 * @property {number} [parallelToolIndex]
 * @property {number} [choiceIndex]
 * @property {{spent?: {amount?: number}, prompt_tokens?: number, completion_tokens?: number, cost_usd?: number, error_message?: string, message?: string, id?: string}} [data]
 * @property {Array<Record<string, unknown>>} [calls]
 */

/**
 * Anything that turns one SSE `data:` line into an event: both parsers below,
 * and a test stub.
 * @typedef {Object} SSELineParser
 * @property {(arg0: {line: string}) => SSEEvent|null} parseLine
 */

/**
 * Reads an event's OWN signature (snake or camel). Native V9 attaches the
 * signature to the event that produced it (Content/ToolCall), never as a
 * turn-level fallback — a later event must not inherit an earlier one's.
 * @param {{parsed: Record<string, any>}} arg0
 * @returns {string|null}
 */
function ownSignature({ parsed }) {
    if (!parsed || typeof parsed !== 'object') return null;
    const nested = parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
    const sig = parsed.thought_signature ?? parsed.thoughtSignature
        ?? (nested ? (nested.thought_signature ?? nested.thoughtSignature) : undefined);
    if (sig === undefined || sig === null) return null;
    const s = String(sig);
    return s ? s : null;
}

/**
 * @param {{parser: *, parsed: Record<string, any>}} arg0
 */
function captureSignature({ parser, parsed }) {
    const sig = ownSignature({ parsed });
    if (sig) parser.lastThoughtSignature = sig;
}

/**
 * A gateway-supplied diagnostic string, capped and marked when the cap cut it.
 * @param {{value: unknown}} arg0
 * @returns {string}
 */
function boundedDiagnostic({ value }) {
    const text = String(value ?? '');
    return text.length > LIMITS.max_error_message_chars
        ? `${text.slice(0, LIMITS.max_error_message_chars)}${TRUNCATION_MARKER}`
        : text;
}

/**
 * @param {{line: string}} arg0
 * @returns {string|null}
 */
function extractData({ line }) {    let payload = null;
    if (line.startsWith('data: ')) payload = line.substring(6);
    else if (line.startsWith('data:')) payload = line.substring(5);
    return payload ? payload : null;
}

/**
 * True when `text` is complete JSON (used to decide whether an accumulated
 * multi-line data payload is complete, or a frame was malformed).
 * @param {{text: string}} arg0
 * @returns {boolean}
 */
function parsesJson({ text }) {
    try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * Splits an SSE stream on newlines and yields parsed events. The trailing
 * buffer is only flushed on a clean end (never on abort/error). Consecutive
 * `data:` lines are concatenated (SSE spec) before parsing, malformed frames
 * are skipped, and `[DONE]`/`end` terminate cleanly.
 * @param {{stream: AsyncIterable<string>, parser: SSELineParser}} arg0
 * @returns {AsyncGenerator<SSEEvent>} Parsed stream events.
 */
export async function* readSSELines({ stream, parser }) {
    const maxLineBytes = LIMITS.sse_max_line_bytes;
    let buffer = '';
    let cleanEnd = false;
    let pendingData = '';
    const flushPending = function* () {
        if (!pendingData) return;
        const payload = pendingData;
        pendingData = '';
        const event = parser.parseLine({ line: `data: ${payload}` });
        if (event) yield event;
    };
    try {
        for await (const chunk of stream) {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            if (buffer.length > maxLineBytes) {
                throw new SSEError({ message: `SSE line exceeds ${maxLineBytes} bytes. Stream corrupted.` });
            }
            for (const line of lines) {
                if (line.length > maxLineBytes) {
                    throw new SSEError({ message: `SSE line exceeds ${maxLineBytes} bytes. Stream corrupted.` });
                }
                if (!line.trim()) {
                    yield* flushPending();
                    continue;
                }
                const dataContent = extractData({ line });
                if (dataContent === null) {
                    yield* flushPending();
                    continue;
                }
                const marker = dataContent.trim();
                if (marker === 'end' || marker === '[DONE]') {
                    yield* flushPending();
                    return;
                }
                if (pendingData.length + dataContent.length > maxLineBytes) {
                    throw new SSEError({ message: `SSE line exceeds ${maxLineBytes} bytes. Stream corrupted.` });
                }
                const candidate = pendingData ? `${pendingData}\n${dataContent}` : dataContent;
                if (parsesJson({ text: candidate })) {
                    pendingData = '';
                    const event = parser.parseLine({ line: `data: ${candidate}` });
                    if (event) yield event;
                } else if (pendingData && parsesJson({ text: dataContent })) {
                    const bad = parser.parseLine({ line: `data: ${pendingData}` });
                    if (bad) yield bad;
                    pendingData = '';
                    const event = parser.parseLine({ line: `data: ${dataContent}` });
                    if (event) yield event;
                } else {
                    pendingData = candidate;
                    if (pendingData.length > maxLineBytes) {
                        throw new SSEError({ message: `SSE line exceeds ${maxLineBytes} bytes. Stream corrupted.` });
                    }
                }
            }
        }
        cleanEnd = true;
    } finally {
        if (cleanEnd) {
            yield* flushPending();
            if (buffer.trim()) {
                const event = parser.parseLine({ line: buffer });
                if (event) yield event;
            }
        }
    }
}

/**
 * Parses chat V9 / responses V9 SSE lines into unified events, assembling
 * parallel tool calls and capturing thought signatures. The two protocols
 * share the Content/ToolCall/FinishMetadata/QuotaMetadata shapes (probed live);
 * only ReasoningData differs (responses-only, replayed as a native item).
 */
export class SSEParser {
    /**
 * @param {{protocol?: string}} arg0
 */
    constructor({ protocol = ProtocolType.CHAT } = {}) {
        /** @type {string} */
        this.protocol = protocol;
        /** @type {Array<PendingToolCall>} */
        this.finalizedToolCalls = [];
        /** @type {Map<string, PendingToolCall>} */
        this.toolCallsInProgress = new Map();
        /** @type {string|null} */
        this.lastTextSignature = null;
        /** @type {string|null} */
        this.turnSignature = null;
        /** True once the gateway sent the terminal FinishMetadata event. */
        this.sawFinishMetadata = false;
    }

    /**
 * Parses a single SSE data line into an event (or null).
 * @param {{line: string}} arg0
 * @returns {SSEEvent|null} The parsed event, or null for heartbeats/end markers.
 */
    parseLine({ line }) {
        const dataContent = extractData({ line });
        if (dataContent === null) return null;
        const marker = dataContent.trim();
        if (marker === 'end' || marker === '[DONE]') return null;
        let parsed;
        try {
            parsed = JSON.parse(dataContent);
        } catch (e) {
            return { type: 'parse_error', message: `Failed to parse SSE data chunk: ${/** @type {any} */ (e).message}` };
        }
        try {
            if (parsed === null || typeof parsed !== 'object') return null;

            const turnSig = ownSignature({ parsed });
            if (turnSig && !this.turnSignature) this.turnSignature = turnSig;

            switch (parsed.type) {
                case 'Content': {
                    const sig = ownSignature({ parsed });
                    if (sig) this.lastTextSignature = sig;
                    return {
                        type: 'text',
                        content: parsed.content,
                        ...(sig ? { thoughtSignature: sig } : {}),
                        ...(parsed.choiceIndex !== undefined ? { choiceIndex: parsed.choiceIndex } : {}),
                    };
                }
                case 'ToolCall': {
                    const choiceIdx = parsed.choiceIndex ?? 0;
                    let call = parsed.id
                        ? [...this.toolCallsInProgress.entries()]
                            .find(([k, c]) => c.id === parsed.id && (parsed.choiceIndex === undefined || k.startsWith(`${choiceIdx}:`)))?.[1] ?? null
                        : null;
                    /** @type {number|null} */
                    let slotIdx = parsed.parallelToolIndex ?? null;
                    if (call && slotIdx !== null && call.parallelToolIndex !== slotIdx) {
                        throw new SSEError({ message: `Tool call id "${parsed.id}" moved from index ${call.parallelToolIndex} to ${slotIdx}. Stream corrupted.` });
                    }
                    if (!call) {
                        if (slotIdx !== null) {
                            const slot = this.toolCallsInProgress.get(`${choiceIdx}:${slotIdx}`) ?? null;
                            if (slot && parsed.id && slot.id && slot.id !== parsed.id) {
                                throw new SSEError({ message: `Duplicate tool call index ${slotIdx}: existing id="${slot.id}", incoming id="${parsed.id}". Stream corrupted.` });
                            }
                            call = slot;
                        } else if (parsed.id) {
                            slotIdx = 0;
                            while (this.toolCallsInProgress.has(`${choiceIdx}:${slotIdx}`)) slotIdx++;
                        } else {
                            slotIdx = 0;
                            call = this.toolCallsInProgress.get(`${choiceIdx}:0`) ?? null;
                        }
                    }
                    if (!call) {
                        const key = `${choiceIdx}:${slotIdx}`;
                        const created = {
                            id: `call_${slotIdx}_${Date.now().toString(36)}`,
                            name: null,
                            arguments: '',
                            parallelToolIndex: slotIdx,
                            choiceIndex: choiceIdx,
                        };
                        this.toolCallsInProgress.set(key, created);
                        call = created;
                    }
                    if (parsed.id) call.id = parsed.id;
                    if (parsed.name) {
                        call.name = call.name && parsed.name.startsWith(call.name)
                            ? call.name + parsed.name.slice(call.name.length)
                            : (call.name ?? '') + parsed.name;
                    }
                    const fragment = parsed.content === undefined || parsed.content === null
                        ? ''
                        : (typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content));
                    if (fragment) call.arguments += fragment;
                    const callSig = ownSignature({ parsed });
                    if (callSig) call.thoughtSignature = callSig;
                    return {
                        type: 'tool_call_delta',
                        id: call.id,
                        name: call.name,
                        content: fragment,
                        parallelToolIndex: call.parallelToolIndex ?? 0,
                        choiceIndex: parsed.choiceIndex ?? 0,
                        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
                    };
                }
                case 'FinishMetadata': {
                    this.sawFinishMetadata = true;
                    const finishChoiceIdx = parsed.choiceIndex ?? 0;
                    const matchingEntries = Array.from(this.toolCallsInProgress.entries())
                        .filter(([, call]) => (call.choiceIndex ?? 0) === finishChoiceIdx);
                    for (const [k] of matchingEntries) {
                        this.toolCallsInProgress.delete(k);
                    }
                    if (['tool_call', 'tool_calls', 'function_call', 'FunctionCall', 'stop'].includes(parsed.reason)) {
                        const sortedCalls = matchingEntries
                            .sort(([, a], [, b]) => (a.parallelToolIndex ?? 0) - (b.parallelToolIndex ?? 0))
                            .map(([, call]) => call);
                        this.finalizedToolCalls.push(...sortedCalls);
                    }
                    return {
                        type: 'finish',
                        reason: parsed.reason ?? 'unknown',
                        choiceIndex: finishChoiceIdx,
                    };
                }
                case 'ReasoningData': {
                    if (this.protocol !== ProtocolType.RESPONSES) {
                        return { type: 'reasoning', data: parsed };
                    }
                    const summary = Array.isArray(parsed.summary) ? parsed.summary : undefined;
                    const item = {
                        type: 'reasoning_message',
                        id: parsed.id,
                        ...(summary && summary.length > 0 ? { summary } : {}),
                        ...(parsed.encryptedContent ? { encrypted_content: parsed.encryptedContent } : {}),
                        ...(parsed.status ? { status: parsed.status } : {}),
                        ...(parsed.summaryPart ? { summary_part: parsed.summaryPart } : {}),
                    };
                    const summaryText = summary
                        ? summary.map((/** @type {any} */ s) => s?.text).filter(Boolean).join('\n')
                        : '';
                    return { type: 'reasoning_item', item, ...(summaryText ? { content: summaryText } : {}) };
                }
                case 'QuotaMetadata': return { type: 'quota', data: parsed };
                case 'PrematureEnd':
                    return {
                        type: 'premature_end',
                        reason: parsed.reason ?? 'unknown',
                        choiceIndex: parsed.choiceIndex ?? 0,
                        ...(parsed.message ? { message: boundedDiagnostic({ value: parsed.message }) } : {}),
                        ...(parsed.event_type ? { eventType: boundedDiagnostic({ value: parsed.event_type }) } : {}),
                    };
                case 'Error':
                    return { type: 'error', error_message: parsed.error_message, error_type: parsed.event_type || 'error', data: parsed };
                default: return { type: 'unknown', data: parsed };
            }
        } catch (e) {
            if (e instanceof SSEError) throw e;
            throw new SSEError({ message: `Failed to parse SSE data chunk: ${/** @type {any} */ (e).message}` });
        }
    }

    /**
     * Discards in-progress (never-finalized) tool calls. A non-clean stream
     * end (timeout/abort/PrematureEnd) must not sweep half-serialized args
     * into executable calls — the same contract the `length` finish reason
     * already enforces. Finalized (complete-args) calls are kept.
     */
    discardInProgress() {
        this.toolCallsInProgress.clear();
    }

    /**
     * Returns finalized tool calls and the captured thought signature.
     * @returns {{toolCalls: Array<PendingToolCall>, thoughtSignature: string|null}}
     */
    getFinalResult() {
        const calls = this.finalizedToolCalls
            .slice()
            .sort((a, b) => ((a.choiceIndex ?? 0) - (b.choiceIndex ?? 0)) || ((a.parallelToolIndex ?? 0) - (b.parallelToolIndex ?? 0)));
        if (this.turnSignature) {
            for (const call of calls) {
                if (!call.thoughtSignature) call.thoughtSignature = this.turnSignature;
            }
        }
        return { toolCalls: calls, thoughtSignature: this.lastTextSignature };
    }
}

/**
 * Parses Task V5 SSE lines into task events, capturing thought signatures.
 */
export class TaskSSEParserV5 {
    constructor() {
        /** @type {string|null} */
        this.lastThoughtSignature = null;
    }

    /**
 * Parses a single SSE data line into a task event (or null).
 * @param {{line: string}} arg0
 * @returns {SSEEvent|null} The parsed event, or null for heartbeats/end markers.
 */
    parseLine({ line }) {
        const dataContent = extractData({ line });
        if (dataContent === null) return null;
        const marker = dataContent.trim();
        if (marker === 'end' || marker === '[DONE]') return null;
        let parsed;
        try {
            parsed = JSON.parse(dataContent);
        } catch (e) {
            return { type: 'parse_error', message: `Failed to parse Task V5 SSE data chunk: ${/** @type {any} */ (e).message}` };
        }
        if (parsed === null || typeof parsed !== 'object') return null;
        captureSignature({ parser: this, parsed });

        const type = parsed.type;
        if (!type) return null;
        switch (type) {
            case 'Content':
                return { type, content: parsed.content, thoughtSignature: ownSignature({ parsed }) };
            case 'ReasoningData':
            case 'QuotaMetadata':
            case 'ExecutionMetadata':
            case 'FinishMetadata':
            case 'FunctionCallMetadata':
            case 'UnknownMetadata':
                return { type, data: parsed, thoughtSignature: this.lastThoughtSignature };
            case 'PrematureEnd':
                return {
                    type: 'PrematureEnd',
                    reason: parsed.reason || 'unknown',
                    ...(parsed.message ? { message: boundedDiagnostic({ value: parsed.message }) } : {}),
                    ...(parsed.event_type ? { eventType: boundedDiagnostic({ value: parsed.event_type }) } : {}),
                };
            case 'Error':
                return { type: 'Error', data: parsed, thoughtSignature: this.lastThoughtSignature };
            default:
                return { type: 'UnknownMetadata', data: parsed, thoughtSignature: this.lastThoughtSignature };
        }
    }

    /**
     * Returns the captured thought signature.
     * @returns {{thoughtSignature: string|null}}
     */
    getFinalResult() {
        return { thoughtSignature: this.lastThoughtSignature };
    }
}
