// @ts-check
/**
 * @file OAI wire-parity case matrix.
 * @version 0.21.0
 *
 * @description
 * Every case is plain data: one request shape and the literal response-body
 * pieces a loopback server writes. `chunks` are UTF-8 strings in write order;
 * `byteSplits[i]` splits `chunks[i]` at those UTF-8 byte offsets so a
 * multi-byte character can cross a write boundary. `hang` keeps the socket
 * open after the last write (abort/break cases); `destroy` closes it before
 * answering (a refused socket). `responses` gives one spec per sequential
 * request, for retry cases.
 *
 * `kind` picks the call surface:
 *   chat / responses -> transport.chat.completions.create / transport.responses.create
 *   embeddings       -> MerciClient.embed() over that transport
 *   models           -> MerciClient.getProfiles() over that transport
 *   client           -> MerciClient.embed() or .getProfiles() by client.action
 *   transport-embeddings -> transport.embeddings.create (raw connector surface)
 *   transport-models     -> transport.models.list, compared on `.data` only
 * `mode` picks the observation: stream (chunks + adapter events), json (raw
 * transport value), adapter-json (a non-streaming response through
 * `oaiAdapter.executeVendorRequest` + `consumeStream`, so `consumeFullResponse`
 * is compared), value (raw transport value of a transport-* kind), call (client
 * value). Each exported `request` is `{ body, headers? }`; `headers` are the
 * per-call headers (a body-less `transport-models` case carries only `headers`).
 * A `client` kind case names `client.action` (`embed` or `getProfiles`); a
 * `client` block's `defaultHeaders` are applied to the transport on every path.
 * `compare.requestId` records the parsed value's `_request_id` and whether it is
 * enumerable.
 */

/** @typedef {{status: number, headers: Record<string,string>, chunks: Array<string>, byteSplits?: Array<Array<number>>, hang?: boolean, destroy?: boolean}} ResponseSpec */

/** @param {any} value */
const sseData = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
/** @param {string} event @param {any} value */
const sseEvent = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const DONE = 'data: [DONE]\n\n';
/** @param {string} text */
const crlf = (text) => text.replaceAll('\n', '\r\n');
/** @param {Array<number>} values */
const base64Floats = (values) => Buffer.from(new Float32Array(values).buffer).toString('base64');

const CHAT_STREAM_HEADERS = { 'content-type': 'text/event-stream' };
const RESPONSES_STREAM_HEADERS = { 'content-type': 'text/event-stream' };
const JSON_HEADERS = { 'content-type': 'application/json' };

/** @param {string} id @param {any} choices @param {any} [extra] */
const chatChunk = (id, choices, extra) => sseData({ id, object: 'chat.completion.chunk', created: 1, model: 'gpt-test', choices, ...extra });

const UTF8_CHUNK = chatChunk('chatcmpl-utf8', [{ index: 0, delta: { content: 'café' } }]);
const UTF8_CHAR_AT = UTF8_CHUNK.indexOf('café') + 3;

/** @type {Array<any>} */
const CASE_DEFINITIONS = [
    // ── chat stream ─────────────────────────────────────────────────────────
    {
        id: 'chat-stream-text-usage-stop',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-1', [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }]),
                chatChunk('chatcmpl-1', [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }], { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-parallel-tool-calls',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'two tools' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-tools', [{ index: 0, delta: { tool_calls: [
                    { index: 0, id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{"x":' } },
                    { index: 1, id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"y":' } },
                ] } }]),
                chatChunk('chatcmpl-tools', [{ index: 0, delta: { tool_calls: [
                    { index: 0, function: { arguments: '1}' } },
                    { index: 1, function: { arguments: '2}' } },
                ] }, finish_reason: 'tool_calls' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-reasoning-content',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'think' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-reason', [{ index: 0, delta: { reasoning_content: 'first thought ' } }]),
                chatChunk('chatcmpl-reason', [{ index: 0, delta: { reasoning_content: 'second thought', content: 'answer' } }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-reasoning-array',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'think in parts' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-reason-array', [{ index: 0, delta: { reasoning: ['step one ', { text: 'step two' }] } }]),
                chatChunk('chatcmpl-reason-array', [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-finish-length',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'long' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-length', [{ index: 0, delta: { content: 'truncated' } }]),
                chatChunk('chatcmpl-length', [{ index: 0, delta: {}, finish_reason: 'length' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-content-filter',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'blocked' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-filter', [{ index: 0, delta: {}, finish_reason: 'content_filter' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-refusal-delta',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'refuse' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-refusal', [{ index: 0, delta: { refusal: 'I cannot answer that.' } }]),
                chatChunk('chatcmpl-refusal', [{ index: 0, delta: {}, finish_reason: 'stop' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-usage-only',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'usage' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-usage', [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]),
                chatChunk('chatcmpl-usage', [], { usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-no-choices',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'no choices' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-no-choices', [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]),
                sseData({ id: 'chatcmpl-no-choices', object: 'chat.completion.chunk', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-crlf',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'crlf' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                crlf(chatChunk('chatcmpl-crlf', [{ index: 0, delta: { content: 'windows' } }])),
                crlf(chatChunk('chatcmpl-crlf', [{ index: 0, delta: {}, finish_reason: 'stop' }])),
                crlf(DONE),
            ],
        },
    },
    {
        id: 'chat-stream-comments',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'keep alive' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                ': keep-alive\n\n',
                chatChunk('chatcmpl-comments', [{ index: 0, delta: { content: 'alive' } }]),
                ': still here\n\n',
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-utf8-split',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'accent' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [UTF8_CHUNK, DONE],
            byteSplits: [[Buffer.byteLength(UTF8_CHUNK.slice(0, UTF8_CHAR_AT), 'utf8') + 1]],
        },
    },
    {
        id: 'chat-stream-trailing-no-blank',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'eof' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [chatChunk('chatcmpl-eof', [{ index: 0, delta: { content: 'tail' }, finish_reason: 'stop' }]).replace(/\n\n$/, '')],
        },
    },
    {
        id: 'chat-stream-done-extra-bytes',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'done' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-done', [{ index: 0, delta: { content: 'finished' }, finish_reason: 'stop' }]),
                DONE,
                'data: {"ignored":true}\n\n',
            ],
        },
    },
    {
        id: 'chat-stream-malformed',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'malformed' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: ['data: {not json}\n\n'],
        },
    },
    {
        id: 'chat-stream-error-chunk',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'error chunk' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [sseData({ error: { message: 'upstream explosion', type: 'server_error', code: 'upstream_error' } })],
        },
    },
    {
        id: 'chat-stream-event-error',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'event error' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [sseEvent('error', { message: 'event explosion', type: 'server_error', code: 'event_error' })],
        },
    },
    {
        id: 'chat-stream-abort',
        kind: 'chat',
        mode: 'stream',
        variant: 'abort',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'abort' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [chatChunk('chatcmpl-abort', [{ index: 0, delta: { content: 'partial' } }])],
            hang: true,
        },
    },
    {
        id: 'chat-stream-break',
        kind: 'chat',
        mode: 'stream',
        variant: 'break',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'break' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [chatChunk('chatcmpl-break', [{ index: 0, delta: { content: 'partial' } }])],
            hang: true,
        },
    },
    {
        id: 'chat-stream-abort-after-headers',
        kind: 'chat',
        mode: 'stream',
        variant: 'abort-before-chunk',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'abort early' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [],
            hang: true,
        },
    },
    {
        id: 'chat-stream-error-chunk-retry-after',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'error headers' }], stream: true },
        response: {
            status: 200,
            headers: { ...CHAT_STREAM_HEADERS, 'retry-after': '7', 'x-request-id': 'req_stream_error' },
            chunks: [sseData({ error: { message: 'upstream explosion', type: 'server_error', code: 'upstream_error' } })],
        },
    },
    {
        id: 'chat-stream-reasoning-string',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'think plainly' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-reason-string', [{ index: 0, delta: { reasoning: 'step one ' } }]),
                chatChunk('chatcmpl-reason-string', [{ index: 0, delta: { reasoning: 'step two', content: 'answer' }, finish_reason: 'stop' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-type-error-no-error-key',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'bare error chunk' }], stream: true },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                sseData({ type: 'error' }),
                chatChunk('chatcmpl-bare-error', [{ index: 0, delta: { content: 'still here' }, finish_reason: 'stop' }]),
                DONE,
            ],
        },
    },
    {
        id: 'chat-stream-caller-stream-options',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'keep my stream options' }], stream: true, stream_options: { include_usage: false } },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [
                chatChunk('chatcmpl-stream-options', [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]),
                DONE,
            ],
        },
    },

    // ── chat non-stream ─────────────────────────────────────────────────────
    {
        id: 'chat-json-full',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'tools' }] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'chatcmpl-json', object: 'chat.completion', created: 1, model: 'gpt-test',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'Calling a tool.',
                        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
                    },
                    finish_reason: 'tool_calls',
                }],
                usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            })],
        },
    },
    {
        id: 'chat-json-content-parts',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'parts' }] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'chatcmpl-parts', object: 'chat.completion', choices: [{
                    index: 0,
                    message: { role: 'assistant', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' part two' }] },
                    finish_reason: 'stop',
                }],
            })],
        },
    },
    {
        id: 'chat-json-refusal',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'refuse' }] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'chatcmpl-refuse', object: 'chat.completion', choices: [{
                    index: 0,
                    message: { role: 'assistant', content: null, refusal: 'I cannot do that.' },
                    finish_reason: 'stop',
                }],
            })],
        },
    },
    {
        id: 'chat-json-finish-length',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'long' }] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'chatcmpl-length', object: 'chat.completion', choices: [{
                    index: 0, message: { role: 'assistant', content: 'partial answer' }, finish_reason: 'length',
                }],
            })],
        },
    },
    {
        id: 'chat-json-html-200',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'html' }] },
        response: { status: 200, headers: { 'content-type': 'text/html' }, chunks: ['<html><body>gateway</body></html>'] },
    },
    {
        id: 'chat-json-204',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'empty' }] },
        response: { status: 204, headers: {}, chunks: [] },
    },
    {
        id: 'chat-json-empty-body',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'empty body' }] },
        response: { status: 200, headers: JSON_HEADERS, chunks: [] },
    },
    {
        id: 'chat-json-html-200-empty',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'empty html' }] },
        response: { status: 200, headers: { 'content-type': 'text/html' }, chunks: [] },
    },
    {
        id: 'chat-json-request-id',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'request id' }] },
        compare: { requestId: true },
        response: {
            status: 200,
            headers: { ...JSON_HEADERS, 'x-request-id': 'req_abc' },
            chunks: [JSON.stringify({ id: 'chatcmpl-req', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })],
        },
    },
    {
        id: 'chat-json-error-no-message',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'error without message' }] },
        response: {
            status: 400,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ error: { code: 'c1', type: 't1' } })],
        },
    },
    {
        id: 'chat-json-429-retry-after-ms',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'millisecond retry' }] },
        response: {
            status: 429,
            headers: { ...JSON_HEADERS, 'retry-after-ms': '1500' },
            chunks: [JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } })],
        },
    },

    // ── responses stream ────────────────────────────────────────────────────
    {
        id: 'responses-stream-output-text',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'hi', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello ' }),
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'world' }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-reasoning-summary',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'think', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'think ' }),
                sseEvent('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'hard' }),
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'answer' }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-function-call',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'tool', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } }),
                sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"q":' }),
                sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"x"}' }),
                sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-annotation',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'cite', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'See ' }),
                sseEvent('response.output_text.annotation.added', { type: 'response.output_text.annotation.added', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: 'https://a.test', title: 'A' } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-refusal',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'refuse', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.refusal.delta', { type: 'response.refusal.delta', delta: 'I cannot. ' }),
                sseEvent('response.refusal.done', { type: 'response.refusal.done', refusal: 'I cannot. Do that.' }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-completed-usage',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'usage', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'answer' }),
                sseEvent('response.completed', { type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } } } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-failed',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'fail', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.failed', { type: 'response.failed', response: { id: 'resp_f', object: 'response', status: 'failed', error: { message: 'model failed', type: 'server_error', code: 'server_error' } } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-incomplete',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'truncate', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'partial' }),
                sseEvent('response.incomplete', { type: 'response.incomplete', response: { id: 'resp_i', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-error',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'error', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.error', { type: 'response.error', error: { message: 'stream exploded', type: 'server_error', code: 'server_error' } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-unknown-event',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'unknown', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.matcha.delta', { type: 'response.matcha.delta', delta: 'ignored' }),
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'still here' }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-reasoning-item-done',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'reasoning item', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'thought about it' }),
                sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }] } }),
                DONE,
            ],
        },
    },
    {
        id: 'responses-stream-web-search-sources',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'search', stream: true },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [
                sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ title: 'A', url: 'https://a.test' }] } } }),
                sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'found it' }),
                DONE,
            ],
        },
    },

    // ── responses non-stream ────────────────────────────────────────────────
    {
        id: 'responses-json-full-no-output-text',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'everything' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'resp_json', object: 'response', created_at: 1, status: 'completed', model: 'gpt-test',
                output: [
                    { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello ', annotations: [] }, { type: 'output_text', text: 'world', annotations: [] }] },
                    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', status: 'completed' },
                    { type: 'reasoning', id: 'rs_1', summary: [], status: 'completed' },
                ],
                usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
            })],
        },
    },
    {
        id: 'responses-json-incomplete',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'truncate' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'resp_inc', object: 'response', status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'partial' }] }],
                usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            })],
        },
    },
    {
        id: 'responses-json-failed',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'fail' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'resp_fail', object: 'response', status: 'failed',
                error: { message: 'model failed', type: 'server_error', code: 'server_error' },
                output: [],
                usage: null,
            })],
        },
    },
    {
        id: 'responses-json-no-output',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'no output' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ id: 'resp_no_output', object: 'response', status: 'completed' })],
        },
    },
    {
        id: 'responses-json-preset-output-text',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'preset output text' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'resp_preset', object: 'response', status: 'completed',
                output_text: 'stale text',
                output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'fresh text' }] }],
            })],
        },
    },
    {
        id: 'responses-adapter-json-full',
        kind: 'responses',
        mode: 'adapter-json',
        request: { model: 'gpt-test', input: 'everything', stream: false },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: 'resp_adapter', object: 'response', created_at: 1, status: 'completed', model: 'gpt-test',
                output: [
                    { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello ', annotations: [] }, { type: 'output_text', text: 'world', annotations: [] }] },
                    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', status: 'completed' },
                    { type: 'reasoning', id: 'rs_1', summary: [], status: 'completed' },
                ],
                usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
            })],
        },
    },

    // ── embeddings (MerciClient.embed over the transport) ───────────────────
    {
        id: 'embeddings-base64-decode',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: base64Floats([0.5, -1.25, 3]) }],
                usage: { prompt_tokens: 1, total_tokens: 1 },
            })],
        },
    },
    {
        id: 'embeddings-float-array',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
            })],
        },
    },
    {
        id: 'embeddings-missing-data',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ object: 'list', model: 'embed-test' })],
        },
    },
    {
        id: 'embeddings-all-zero',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: base64Floats([0, 0, 0, 0]) }],
            })],
        },
    },
    {
        id: 'embeddings-404-html',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: { status: 404, headers: { 'content-type': 'text/html' }, chunks: ['<html><body>not found</body></html>'] },
    },
    {
        id: 'embeddings-400-no-models',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: {
            status: 400,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ error: { message: 'no models loaded', type: 'invalid_request_error' } })],
        },
    },
    {
        id: 'embeddings-429-retry-after',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: 'hello' },
        response: {
            status: 429,
            headers: { ...JSON_HEADERS, 'retry-after': '2' },
            chunks: [JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } })],
        },
    },
    {
        id: 'embeddings-batch-ordering',
        kind: 'embeddings',
        mode: 'call',
        request: { model: 'embed-test', input: ['a', 'b', 'c'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [
                    { object: 'embedding', index: 2, embedding: base64Floats([3]) },
                    { object: 'embedding', index: 0, embedding: base64Floats([1]) },
                    { object: 'embedding', index: 1, embedding: base64Floats([2]) },
                ],
            })],
        },
    },

    // ── embeddings on the raw transport surface ─────────────────────────────
    {
        id: 'embeddings-transport-base64-explicit',
        kind: 'transport-embeddings',
        mode: 'value',
        request: { model: 'embed-test', input: 'hello', encoding_format: 'base64' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: base64Floats([0.5, -1.25, 3]) }],
                usage: { prompt_tokens: 1, total_tokens: 1 },
            })],
        },
    },
    {
        id: 'embeddings-transport-empty-encoding',
        kind: 'transport-embeddings',
        mode: 'value',
        request: { model: 'embed-test', input: 'hello', encoding_format: '' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: base64Floats([0.5, -1.25, 3]) }],
            })],
        },
    },
    {
        id: 'embeddings-transport-null-encoding',
        kind: 'transport-embeddings',
        mode: 'value',
        request: { model: 'embed-test', input: 'hello', encoding_format: null },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: base64Floats([0.5, -1.25, 3]) }],
            })],
        },
    },
    {
        id: 'embeddings-transport-float-explicit',
        kind: 'transport-embeddings',
        mode: 'value',
        request: { model: 'embed-test', input: 'hello', encoding_format: 'float' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
            })],
        },
    },
    {
        id: 'embeddings-transport-per-call-header',
        kind: 'transport-embeddings',
        mode: 'value',
        request: { model: 'embed-test', input: 'headers' },
        callOptions: { headers: { 'x-case': '1' } },
        compare: { requestHeaders: ['x-case'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list', model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: base64Floats([7]) }],
            })],
        },
    },

    // ── models (MerciClient.getProfiles over the transport) ─────────────────
    {
        id: 'models-list',
        kind: 'models',
        mode: 'call',
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                object: 'list',
                data: [
                    { id: 'm1', object: 'model', created: 1, owned_by: 'x' },
                    { id: 'm2', object: 'model', created: 2, owned_by: 'y' },
                ],
            })],
        },
    },
    {
        id: 'models-no-data',
        kind: 'models',
        mode: 'call',
        response: { status: 200, headers: JSON_HEADERS, chunks: [JSON.stringify({ object: 'list' })] },
    },
    {
        id: 'models-401-json',
        kind: 'models',
        mode: 'call',
        response: {
            status: 401,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key', param: null } })],
        },
    },
    {
        id: 'models-401-html',
        kind: 'models',
        mode: 'call',
        response: { status: 401, headers: { 'content-type': 'text/html' }, chunks: ['<html><body>unauthorized</body></html>'] },
    },
    {
        id: 'models-connection-closed',
        kind: 'models',
        mode: 'call',
        response: { status: 200, headers: {}, chunks: [], destroy: true },
    },
    {
        id: 'models-json-null',
        kind: 'transport-models',
        mode: 'value',
        response: { status: 200, headers: JSON_HEADERS, chunks: ['null'] },
    },
    {
        id: 'models-per-call-header',
        kind: 'transport-models',
        mode: 'value',
        callOptions: { headers: { 'x-case': '1' } },
        compare: { requestHeaders: ['x-case'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] })],
        },
    },

    // ── client plumbing ────────────────────────────────────────────────────
    {
        id: 'client-default-headers-chat',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'headers' }] },
        client: { apiKey: 'test-key', defaultHeaders: { 'x-opencode-session': 'ses_test' } },
        compare: { requestHeaders: ['x-opencode-session'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ id: 'chatcmpl-h1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })],
        },
    },
    {
        id: 'client-default-headers-chat-stream',
        kind: 'chat',
        mode: 'stream',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'headers stream' }], stream: true },
        client: { apiKey: 'test-key', defaultHeaders: { 'x-opencode-session': 'ses_test' } },
        compare: { requestHeaders: ['x-opencode-session'] },
        response: {
            status: 200,
            headers: CHAT_STREAM_HEADERS,
            chunks: [chatChunk('chatcmpl-h2', [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]), DONE],
        },
    },
    {
        id: 'client-default-headers-responses',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'headers' },
        client: { apiKey: 'test-key', defaultHeaders: { 'x-opencode-session': 'ses_test' } },
        compare: { requestHeaders: ['x-opencode-session'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ id: 'resp_h1', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })],
        },
    },
    {
        id: 'client-default-headers-responses-stream',
        kind: 'responses',
        mode: 'stream',
        request: { model: 'gpt-test', input: 'headers stream', stream: true },
        client: { apiKey: 'test-key', defaultHeaders: { 'x-opencode-session': 'ses_test' } },
        compare: { requestHeaders: ['x-opencode-session'] },
        response: {
            status: 200,
            headers: RESPONSES_STREAM_HEADERS,
            chunks: [sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'ok' }), DONE],
        },
    },
    {
        id: 'client-default-headers-embeddings',
        kind: 'client',
        mode: 'call',
        client: { apiKey: 'test-key', action: 'embed', defaultHeaders: { 'x-opencode-session': 'ses_test' } },
        compare: { requestHeaders: ['x-opencode-session'] },
        request: { model: 'embed-test', input: 'headers' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: base64Floats([7]) }] })],
        },
    },
    {
        id: 'client-default-headers-models',
        kind: 'client',
        mode: 'call',
        client: { apiKey: 'test-key', action: 'getProfiles', defaultHeaders: { 'x-opencode-session': 'ses_test' } },
        compare: { requestHeaders: ['x-opencode-session'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] })],
        },
    },
    {
        id: 'client-per-call-header-override',
        kind: 'chat',
        mode: 'json',
        request: { model: 'gpt-test', messages: [{ role: 'user', content: 'override' }] },
        client: { apiKey: 'test-key', defaultHeaders: { 'x-opencode-session': 'ses_default', 'x-opencode-extra': 'keep' } },
        callOptions: { headers: { 'x-opencode-session': 'ses_call' } },
        compare: { requestHeaders: ['x-opencode-session', 'x-opencode-extra'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ id: 'chatcmpl-h3', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })],
        },
    },
    {
        id: 'responses-per-call-header',
        kind: 'responses',
        mode: 'json',
        request: { model: 'gpt-test', input: 'headers' },
        callOptions: { headers: { 'x-case': '1' } },
        compare: { requestHeaders: ['x-case'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ id: 'resp_h2', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })],
        },
    },
];

/**
 * The exported matrix: the readable definitions above, with each request body
 * lifted into the `{ body, headers? }` case shape. A body-less case (a raw
 * `transport-models` call) keeps only its per-call `headers`.
 * @type {Array<any>}
 */
export const CASES = CASE_DEFINITIONS.map(({ callOptions, ...caseDef }) => {
    const headers = callOptions?.headers ? { headers: callOptions.headers } : {};
    if (caseDef.request) return { ...caseDef, request: { body: caseDef.request, ...headers } };
    return callOptions?.headers ? { ...caseDef, request: headers } : caseDef;
});
