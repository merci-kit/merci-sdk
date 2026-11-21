// @ts-check
/**
 * @file AAI (Anthropic) wire-parity case matrix.
 * @version 0.21.1
 *
 * @description
 * Every case is plain data: one request body and the literal response-body
 * pieces a loopback server writes. `chunks` are UTF-8 strings in write order;
 * `byteSplits[i]` splits `chunks[i]` at those UTF-8 byte offsets so a
 * multi-byte character can cross a write boundary. `hang` keeps the socket
 * open after the last write (abort cases); `destroy` closes it before
 * answering (a refused socket). `responses` gives one spec per sequential
 * request, for pagination.
 *
 * `kind` picks the call surface:
 *   messages -> client.messages.stream(body, { signal, headers })
 *   models   -> client.models.list(), iterated page by page
 * `mode` picks the observation:
 *   stream  -> the events the message stream yields, plus how it ended
 *   models  -> the models the list yields, plus the page count
 *   error   -> the projected error only (HTTP status / connection failures)
 *   abort   -> the caller aborts after the first content_block_delta
 *
 * Bodies are the shape `lib/backends/adapters/aai-adapter.mjs` builds:
 * `{ model, max_tokens, messages, stream: true }`, plus the passthrough
 * parameters for the header/body case. Each exported `request` is
 * `{ body, headers? }`; `headers` are the per-call headers.
 */

/** @typedef {{status: number, headers: Record<string,string>, chunks: Array<string>, byteSplits?: Array<Array<number>>, hang?: boolean, destroy?: boolean}} ResponseSpec */

/** @param {string} event @param {any} value */
const sseEvent = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
/** @param {string} event @param {string} data */
const sseRaw = (event, data) => `event: ${event}\ndata: ${data}\n\n`;
/** @param {string} text */
const crlf = (text) => text.replaceAll('\n', '\r\n');

const STREAM_HEADERS = { 'content-type': 'text/event-stream' };
const JSON_HEADERS = { 'content-type': 'application/json' };

// A current model: the SDK console.warns on a deprecated id, and the model
// string is echoed back, so a warning here would drown the recorder.
const MODEL = 'claude-sonnet-5-5';
const MESSAGE_ID = 'msg_oracle_1';

/**
 * The request body every messages case shares; a case overrides only what it
 * varies.
 * @param {Record<string, any>} body
 */
const messagesBody = (body) => ({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], stream: true, ...body });

/**
 * The streaming preamble every case shares: one empty assistant message and the
 * input-token usage the vendor reports up front.
 */
const messageStart = () => sseEvent('message_start', {
    type: 'message_start',
    message: {
        id: MESSAGE_ID,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    },
});

/** @param {number} index @param {Record<string, any>} block */
const blockStart = (index, block) => sseEvent('content_block_start', { type: 'content_block_start', index, content_block: block });
/** @param {number} index */
const textStart = (index) => blockStart(index, { type: 'text', text: '' });
/** @param {number} index */
const blockStop = (index) => sseEvent('content_block_stop', { type: 'content_block_stop', index });
/** @param {number} index @param {Record<string, any>} delta */
const blockDelta = (index, delta) => sseEvent('content_block_delta', { type: 'content_block_delta', index, delta });
/** @param {string} text */
const textDelta = (text) => blockDelta(0, { type: 'text_delta', text });

/** @param {string|null} stopReason @param {Record<string, any>} [usage] */
const messageDelta = (stopReason, usage) => sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usage ?? { output_tokens: 7 },
});

const MESSAGE_STOP = sseEvent('message_stop', { type: 'message_stop' });

const TEXT_STREAM = [messageStart(), textStart(0), textDelta('Hello'), textDelta(', world'), blockStop(0), messageDelta('end_turn'), MESSAGE_STOP];

const UTF8_CHUNK = blockDelta(0, { type: 'text_delta', text: 'café' });
const UTF8_CHAR_AT = UTF8_CHUNK.indexOf('café') + 3;

/** @type {Array<any>} */
const CASE_DEFINITIONS = [
    // ── message stream ──────────────────────────────────────────────────────
    {
        id: 'messages-stream-text-usage',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: { status: 200, headers: STREAM_HEADERS, chunks: TEXT_STREAM },
    },
    {
        id: 'messages-stream-tool-use',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ messages: [{ role: 'user', content: 'weather in Paris?' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                blockStart(0, { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} }),
                blockDelta(0, { type: 'input_json_delta', partial_json: '{"city":' }),
                blockDelta(0, { type: 'input_json_delta', partial_json: '"Paris"}' }),
                blockStop(0),
                messageDelta('tool_use', { output_tokens: 24 }),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-thinking-signature',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'what is 2+2?' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
                blockDelta(0, { type: 'thinking_delta', thinking: 'Let me think. ' }),
                blockDelta(0, { type: 'thinking_delta', thinking: 'Two plus two is four.' }),
                blockDelta(0, { type: 'signature_delta', signature: 'EqQBCkgIBxgCKkAORACLEsignature==' }),
                blockStop(0),
                textStart(1),
                blockDelta(1, { type: 'text_delta', text: '4' }),
                blockStop(1),
                messageDelta('end_turn', { output_tokens: 19 }),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-redacted-thinking',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'restricted question' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                blockStart(0, { type: 'redacted_thinking', data: 'EmwKAhgBEgy3ORACLEredacted' }),
                blockStop(0),
                messageDelta('end_turn', { output_tokens: 3 }),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-citations',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ tools: [{ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] }], messages: [{ role: 'user', content: 'look it up' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                blockStart(0, {
                    type: 'web_search_tool_result',
                    tool_use_id: 'srvtoolu_01',
                    content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com', encrypted_content: 'ORACLEencrypted' }],
                }),
                blockStop(0),
                textStart(1),
                blockDelta(1, { type: 'text_delta', text: 'According to the page' }),
                blockDelta(1, {
                    type: 'citations_delta',
                    citation: { type: 'web_search_result_location', url: 'https://example.com', title: 'Example', cited_text: 'quoted passage' },
                }),
                blockStop(1),
                messageDelta('end_turn', { output_tokens: 11, server_tool_use: { web_search_requests: 1 } }),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-refusal',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ messages: [{ role: 'user', content: 'do the forbidden thing' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('I cannot help with that.'),
                blockStop(0),
                messageDelta('refusal'),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-pause-turn',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ tools: [{ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] }], messages: [{ role: 'user', content: 'long search' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('Still searching'),
                blockStop(0),
                messageDelta('pause_turn', { output_tokens: 5 }),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-max-tokens',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ max_tokens: 16, messages: [{ role: 'user', content: 'write a long essay' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('This essay begins and then'),
                blockStop(0),
                messageDelta('max_tokens', { output_tokens: 16 }),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-ping',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('Hello'),
                sseEvent('ping', { type: 'ping' }),
                textDelta(', world'),
                blockStop(0),
                messageDelta('end_turn'),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-unknown-event',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('Hello'),
                sseEvent('future_thing', { type: 'future_thing', novel: true }),
                textDelta(', world'),
                blockStop(0),
                messageDelta('end_turn'),
                MESSAGE_STOP,
            ],
        },
    },
    {
        id: 'messages-stream-utf8-split',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ messages: [{ role: 'user', content: 'accent' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [messageStart(), textStart(0), UTF8_CHUNK, blockStop(0), messageDelta('end_turn'), MESSAGE_STOP],
            byteSplits: [[], [], [Buffer.byteLength(UTF8_CHUNK.slice(0, UTF8_CHAR_AT), 'utf8') + 1]],
        },
    },
    {
        id: 'messages-stream-crlf',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({ messages: [{ role: 'user', content: 'windows' }] }),
        response: { status: 200, headers: STREAM_HEADERS, chunks: TEXT_STREAM.map(crlf) },
    },
    {
        id: 'messages-stream-error-event',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('partial'),
                sseEvent('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
            ],
        },
    },
    {
        id: 'messages-stream-malformed-json',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                textStart(0),
                textDelta('partial'),
                sseRaw('content_block_delta', '{not json}'),
            ],
        },
    },
    {
        id: 'messages-stream-eof-without-stop',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [messageStart(), textStart(0), textDelta('cut off'), blockStop(0)],
        },
    },
    {
        id: 'messages-stream-html-200',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: { 'content-type': 'text/html' },
            chunks: ['<html>\n<body>\n<h1>Sign in</h1>\n<form method="post" action="/login"><input name="user"></form>\n</body>\n</html>\n'],
        },
    },
    {
        id: 'messages-http-401',
        kind: 'messages',
        mode: 'error',
        request: messagesBody({}),
        response: {
            status: 401,
            headers: { ...JSON_HEADERS, 'request-id': 'req_oracle_401' },
            chunks: [JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })],
        },
    },
    {
        id: 'messages-http-429',
        kind: 'messages',
        mode: 'error',
        request: messagesBody({}),
        response: {
            status: 429,
            headers: { ...JSON_HEADERS, 'retry-after': '1' },
            chunks: [JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' } })],
        },
    },
    {
        id: 'messages-http-529',
        kind: 'messages',
        mode: 'error',
        request: messagesBody({}),
        response: {
            status: 529,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })],
        },
    },
    {
        id: 'messages-stream-abort',
        kind: 'messages',
        mode: 'abort',
        request: messagesBody({ messages: [{ role: 'user', content: 'abort' }] }),
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [messageStart(), textStart(0), textDelta('first')],
            hang: true,
        },
    },
    {
        id: 'messages-connection-destroyed',
        kind: 'messages',
        mode: 'error',
        request: messagesBody({}),
        response: { status: 200, headers: {}, chunks: [], destroy: true },
    },
    {
        id: 'messages-stream-json-200',
        kind: 'messages',
        mode: 'stream',
        request: messagesBody({}),
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                id: MESSAGE_ID,
                type: 'message',
                role: 'assistant',
                model: MODEL,
                content: [{ type: 'text', text: 'not a stream' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 12, output_tokens: 3 },
            })],
        },
    },

    // ── models ──────────────────────────────────────────────────────────────
    {
        id: 'models-list-single-page',
        kind: 'models',
        mode: 'models',
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                data: [
                    { type: 'model', id: MODEL, display_name: 'Claude Sonnet 5.5', created_at: '2026-06-01T00:00:00Z' },
                    { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z' },
                ],
                has_more: false,
                first_id: MODEL,
                last_id: 'claude-haiku-4-5',
            })],
        },
    },
    {
        id: 'models-list-two-pages',
        kind: 'models',
        mode: 'models',
        responses: [
            {
                status: 200,
                headers: JSON_HEADERS,
                chunks: [JSON.stringify({
                    data: [{ type: 'model', id: 'model_a', display_name: 'Model A', created_at: '2025-01-01T00:00:00Z' }],
                    has_more: true,
                    first_id: 'model_a',
                    last_id: 'model_a',
                })],
            },
            {
                status: 200,
                headers: JSON_HEADERS,
                chunks: [JSON.stringify({
                    data: [{ type: 'model', id: 'model_b', display_name: 'Model B', created_at: '2025-02-02T00:00:00Z' }],
                    has_more: false,
                    first_id: 'model_b',
                    last_id: 'model_b',
                })],
            },
        ],
    },
    {
        id: 'models-list-http-401',
        kind: 'models',
        mode: 'error',
        response: {
            status: 401,
            headers: { ...JSON_HEADERS, 'request-id': 'req_oracle_models_401' },
            chunks: [JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })],
        },
    },

    // ── header + body passthrough ───────────────────────────────────────────
    {
        id: 'messages-request-headers',
        kind: 'messages',
        mode: 'stream',
        request: {
            model: MODEL,
            max_tokens: 2048,
            system: [{ type: 'text', text: 'You are a careful assistant.', cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: [{ type: 'text', text: 'look it up' }] }],
            stream: true,
            thinking: { type: 'enabled', budget_tokens: 1024 },
            metadata: { user_id: 'user_1' },
            service_tier: 'standard_only',
            output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } },
            tools: [
                { name: 'lookup', description: 'Look something up.', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } },
                // The GA server tools: recorded here so the wire evidence that
                // they need no `anthropic-beta` header stays in a fixture after
                // the vendor package leaves the dependency tree (S-13).
                { type: 'web_search_20260209', name: 'web_search' },
                { type: 'web_fetch_20260209', name: 'web_fetch' },
            ],
            tool_choice: { type: 'tool', name: 'lookup' },
        },
        callOptions: { headers: { 'x-merci-session-id': 'run-1' } },
        response: {
            status: 200,
            headers: STREAM_HEADERS,
            chunks: [
                messageStart(),
                blockStart(0, { type: 'tool_use', id: 'toolu_02', name: 'lookup', input: {} }),
                blockDelta(0, { type: 'input_json_delta', partial_json: '{"q":"x"}' }),
                blockStop(0),
                messageDelta('tool_use', { output_tokens: 9 }),
                MESSAGE_STOP,
            ],
        },
    },
];

/**
 * The exported matrix: the readable definitions above, with each request body
 * lifted into the `{ body, headers? }` case shape. A models case sends no body,
 * so it carries only its per-call `headers` when it declares any.
 * @type {Array<any>}
 */
export const CASES = CASE_DEFINITIONS.map(({ callOptions, ...caseDef }) => {
    const headers = callOptions?.headers ? { headers: callOptions.headers } : {};
    if (caseDef.request) return { ...caseDef, request: { body: caseDef.request, ...headers } };
    return callOptions?.headers ? { ...caseDef, request: headers } : caseDef;
});
