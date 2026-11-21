// @ts-check
/**
 * @file GAI wire-parity case matrix.
 * @version 0.21.1
 *
 * @description
 * Freezes the reference behaviour of `@google/genai` 2.32.0 as plain data: one
 * call shape and the literal response-body pieces a loopback server writes.
 * `chunks` are UTF-8 strings in write order; `byteSplits[i]` splits `chunks[i]`
 * at those byte offsets so a multi-byte character can cross a write boundary.
 * `hang` keeps the socket open after the last write (the abort case);
 * `destroy` closes it before answering (a refused socket). `responses` gives
 * one spec per sequential request (the paginated list case).
 *
 * `kind` picks the call surface:
 *   stream -> models.generateContentStream
 *   models -> models.list
 *   embed  -> models.embedContent
 * `mode` picks the observation:
 *   stream -> collect chunks
 *   abort  -> collect chunks, then abort the caller's signal after `abortAfter`
 *   value  -> the returned value (models/embed)
 *   error  -> the thrown error, nothing else
 * `request` is the literal SDK call argument (`{ model, contents, config? }`).
 * `client` holds the API-key-only client options; `vertexai` selects the Vertex
 * transport. No case passes `googleAuthOptions`, so the SDK never contacts an
 * auth endpoint. `quiet` names the console methods the case provokes, so the
 * recorder can scope a silence to that case only.
 *
 * Every frame is `data: <json>` followed by a blank line: LF by default, and
 * `stream-crlf` is the case that pins the CRLF delimiter. The SDK also accepts
 * a bare CR delimiter; nothing in this matrix relies on it.
 */

/** @typedef {{status: number, headers: Record<string,string>, chunks: Array<string>, byteSplits?: Array<Array<number>>, hang?: boolean, destroy?: boolean}} ResponseSpec */

/** @param {any} value */
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
/** @param {any} value */
const crlfFrame = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;

const SSE_HEADERS = { 'content-type': 'text/event-stream' };
const JSON_HEADERS = { 'content-type': 'application/json' };

/** @param {Array<any>} parts @param {string} [finishReason] @param {Record<string, any>} [candidateExtra] */
const candidateChunk = (parts, finishReason, candidateExtra = {}) => ({
    candidates: [{
        content: { parts, role: 'model' },
        ...(finishReason ? { finishReason } : {}),
        ...candidateExtra,
    }],
});

/** @param {string} text @param {string} [finishReason] */
const textChunk = (text, finishReason) => candidateChunk([{ text }], finishReason);

const UTF8_FRAME = frame(textChunk('café — 日本語', 'STOP'));
/** The split lands inside the two-byte `é`, so one character crosses the boundary. */
const UTF8_CHAR_AT = UTF8_FRAME.indexOf('café') + 3;

/** @type {Array<any>} */
const CASE_DEFINITIONS = [
    // ── stream: content ────────────────────────────────────────────────────
    {
        id: 'stream-text-single',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Say hello' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('Hello', 'STOP'))] },
    },
    {
        id: 'stream-text-multiple',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Count to three' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [
                frame(textChunk('Hello')),
                frame(textChunk(' wor')),
                frame(textChunk('ld', 'STOP')),
            ],
        },
    },
    {
        id: 'stream-usage-metadata',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Account for yourself' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [
                frame(textChunk('done')),
                frame({
                    candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }],
                    usageMetadata: {
                        promptTokenCount: 12,
                        candidatesTokenCount: 7,
                        totalTokenCount: 19,
                        cachedContentTokenCount: 3,
                        thoughtsTokenCount: 2,
                    },
                }),
            ],
        },
    },
    {
        id: 'stream-thought-and-signature',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Think first' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [
                frame(candidateChunk([
                    { text: 'Let me think about that. ', thought: true },
                    { text: 'The answer is 42.', thoughtSignature: 'c2lnbmF0dXJlLTE=' },
                ], 'STOP')),
            ],
        },
    },
    {
        id: 'stream-function-call',
        kind: 'stream',
        mode: 'stream',
        quiet: ['warn'],
        request: {
            model: 'gemini-2.5-flash',
            contents: 'Look it up twice',
            config: { tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Find a record', parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } }, required: ['q'] } }] }] },
        },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [
                frame(candidateChunk([{ functionCall: { id: 'fc_1', name: 'lookup', args: { q: 'alpha' } } }])),
                frame(candidateChunk([{ functionCall: { id: 'fc_1', name: 'lookup', args: { q: 'beta' } } }], 'STOP')),
            ],
        },
    },
    {
        id: 'stream-function-call-without-id',
        kind: 'stream',
        mode: 'stream',
        quiet: ['warn'],
        request: { model: 'gemini-2.5-flash', contents: 'Call an anonymous tool' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [frame(candidateChunk([{ functionCall: { name: 'read_file', args: { path: '/tmp/x' } } }], 'STOP'))],
        },
    },

    // ── stream: finish reasons and feedback ────────────────────────────────
    {
        id: 'stream-finish-stop',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Finish normally' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('complete', 'STOP'))] },
    },
    {
        id: 'stream-finish-max-tokens',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Run out of room' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('truncated out', 'MAX_TOKENS'))] },
    },
    {
        id: 'stream-finish-safety',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Trip the filter' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(candidateChunk([], 'SAFETY'))] },
    },
    {
        id: 'stream-finish-image-recitation',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Recite an image' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(candidateChunk([], 'IMAGE_RECITATION'))] },
    },
    {
        id: 'stream-prompt-block-safety',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Block the prompt' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [frame({ promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'prompt blocked by safety policy' } })],
        },
    },

    // ── stream: grounding ──────────────────────────────────────────────────
    {
        id: 'stream-grounding-web',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Search the web' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [frame(candidateChunk([{ text: 'Two sources agree.' }], 'STOP', {
                groundingMetadata: {
                    webSearchQueries: ['merci sdk'],
                    groundingChunks: [
                        { web: { uri: 'https://a.test/article', title: 'Article A' } },
                        { web: { uri: 'https://b.test/article', title: 'Article B' } },
                    ],
                },
            }))],
        },
    },
    {
        id: 'stream-grounding-retrieved-context',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Look in the corpus' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [frame(candidateChunk([{ text: 'The corpus says so.' }], 'STOP', {
                groundingMetadata: {
                    groundingChunks: [{
                        retrievedContext: {
                            uri: 'gs://merci-corpus/doc.txt',
                            title: 'Doc',
                            text: 'the retrieved excerpt',
                        },
                    }],
                },
            }))],
        },
    },

    // ── stream: transport framing ──────────────────────────────────────────
    {
        id: 'stream-crlf',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Carriage returns' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [
                crlfFrame(textChunk('windows ')),
                crlfFrame(textChunk('line endings', 'STOP')),
            ],
        },
    },
    {
        id: 'stream-utf8-split',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Split a character' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [UTF8_FRAME],
            byteSplits: [[Buffer.byteLength(UTF8_FRAME.slice(0, UTF8_CHAR_AT), 'utf8') + 1]],
        },
    },
    {
        id: 'stream-no-trailing-blank-line',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'End mid-frame' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [frame(textChunk('tail', 'STOP')).replace(/\n\n$/, '')],
        },
    },
    {
        id: 'stream-empty',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Say nothing' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [] },
    },
    {
        id: 'stream-json-200',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Answer as plain JSON' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify(textChunk('plain json', 'STOP'))],
        },
    },
    {
        id: 'stream-malformed-json',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Break the frame' },
        response: { status: 200, headers: SSE_HEADERS, chunks: ['data: {not json\n\n'] },
    },
    {
        id: 'stream-error-frame',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'Fail mid-stream' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [
                frame(textChunk('starting')),
                frame({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }),
            ],
        },
    },
    {
        id: 'stream-abort',
        kind: 'stream',
        mode: 'abort',
        abortAfter: 1,
        request: { model: 'gemini-2.5-flash', contents: 'Stop me early' },
        response: {
            status: 200,
            headers: SSE_HEADERS,
            chunks: [frame(textChunk('partial'))],
            hang: true,
        },
    },
    {
        id: 'stream-connection-destroyed',
        kind: 'stream',
        mode: 'error',
        request: { model: 'gemini-2.5-flash', contents: 'Lose the socket' },
        response: { status: 200, headers: {}, chunks: [], destroy: true },
    },

    // ── HTTP failures ──────────────────────────────────────────────────────
    {
        id: 'http-400-error',
        kind: 'stream',
        mode: 'error',
        request: { model: 'gemini-2.5-flash', contents: 'Send a bad request' },
        response: {
            status: 400,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ error: { code: 400, message: 'bad request', status: 'INVALID_ARGUMENT' } })],
        },
    },
    {
        id: 'http-429-error',
        kind: 'stream',
        mode: 'error',
        request: { model: 'gemini-2.5-flash', contents: 'Exceed the quota' },
        response: {
            status: 429,
            headers: { ...JSON_HEADERS, 'retry-after': '5' },
            chunks: [JSON.stringify({ error: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } })],
        },
    },
    {
        id: 'http-500-error',
        kind: 'stream',
        mode: 'error',
        request: { model: 'gemini-2.5-flash', contents: 'Break the server' },
        response: {
            status: 500,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ error: { code: 500, message: 'internal failure', status: 'INTERNAL' } })],
        },
    },

    // ── models.list ────────────────────────────────────────────────────────
    {
        id: 'models-list-single-page',
        kind: 'models',
        mode: 'value',
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                models: [
                    { name: 'models/gemini-a', displayName: 'A', description: 'first model' },
                    { name: 'models/gemini-b', displayName: 'B', description: 'second model' },
                ],
            })],
        },
    },
    {
        id: 'models-list-two-pages',
        kind: 'models',
        mode: 'value',
        responses: [
            {
                status: 200,
                headers: JSON_HEADERS,
                chunks: [JSON.stringify({
                    models: [{ name: 'models/gemini-a', displayName: 'A', description: 'first model' }],
                    nextPageToken: 'tok-page-2',
                })],
            },
            {
                status: 200,
                headers: JSON_HEADERS,
                chunks: [JSON.stringify({
                    models: [{ name: 'models/gemini-b', displayName: 'B', description: 'second model' }],
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
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } })],
        },
    },

    // ── models.embedContent ────────────────────────────────────────────────
    {
        id: 'embed-single-string',
        kind: 'embed',
        mode: 'value',
        request: { model: 'text-embedding-004', contents: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ embeddings: [{ values: [0.5, -1.25, 3] }] })],
        },
    },
    {
        id: 'embed-batch',
        kind: 'embed',
        mode: 'value',
        request: { model: 'text-embedding-004', contents: [{ parts: [{ text: 'alpha' }] }, { parts: [{ text: 'beta' }] }] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] })],
        },
    },
    {
        // A string list is ONE content with every string as a part for the model
        // the SDK groups (`gemini-embedding-2`), so one request and one vector.
        id: 'embed-mldev-strings-array',
        kind: 'embed',
        mode: 'value',
        request: { model: 'gemini-embedding-2', contents: ['a', 'b'] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ embeddings: [{ values: [0.75, -0.25] }] })],
        },
    },
    {
        id: 'embed-mldev-config',
        kind: 'embed',
        mode: 'value',
        request: {
            model: 'gemini-embedding-2',
            contents: 'hello',
            config: { taskType: 'RETRIEVAL_DOCUMENT', title: 'merci doc', outputDimensionality: 4 },
        },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ embeddings: [{ values: [0.1, 0.2, 0.3, 0.4] }] })],
        },
    },

    // ── request construction ───────────────────────────────────────────────
    {
        id: 'request-config-hoisting',
        kind: 'stream',
        mode: 'stream',
        request: {
            model: 'gemini-2.5-pro',
            contents: 'Hoist every config key',
            config: {
                systemInstruction: 'You are a careful archivist.',
                tools: [{
                    functionDeclarations: [{
                        name: 'lookup',
                        description: 'Find a record',
                        parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } }, required: ['q'] },
                    }],
                }],
                toolConfig: { functionCallingConfig: { mode: 'ANY' } },
                thinkingConfig: { thinkingBudget: 512, thinkingLevel: 'high' },
                responseMimeType: 'application/json',
                responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
                cachedContent: 'cachedContents/x',
                safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' }],
                labels: { team: 'merci' },
                seed: 42,
                stopSequences: ['END'],
                topP: 0.9,
                topK: 5,
                presencePenalty: 0.1,
                frequencyPenalty: 0.2,
                responseLogprobs: true,
                logprobs: 2,
                temperature: 0.3,
                maxOutputTokens: 128,
            },
        },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('hoisted', 'STOP'))] },
    },
    {
        id: 'request-session-header',
        kind: 'stream',
        mode: 'stream',
        compare: { requestHeaders: ['x-merci-session-id'] },
        request: {
            model: 'gemini-2.5-flash',
            contents: 'Keep my session header',
            config: { httpOptions: { headers: { 'X-Merci-Session-Id': 'run-1' } } },
        },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('kept', 'STOP'))] },
    },
    {
        id: 'request-empty-config',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash', contents: 'An empty config still travels', config: {} },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('empty', 'STOP'))] },
    },
    {
        // `responseSchema` is normalised on the wire (uppercased `type`s, a
        // nullable `anyOf` collapsed, `additionalProperties` dropped); the
        // `responseJsonSchema` beside it is passed through untouched.
        id: 'request-response-schema',
        kind: 'stream',
        mode: 'stream',
        request: {
            model: 'gemini-2.5-flash',
            contents: 'Answer as JSON',
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    description: 'one answer',
                    properties: {
                        answer: { type: 'string', nullable: true },
                        tags: { type: 'array', items: { type: 'string' } },
                        score: { type: 'number', format: 'float' },
                        kind: { type: 'string', enum: ['a', 'b'] },
                        maybe: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
                        pick: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                        raw: { allOf: [{ type: 'string' }] },
                    },
                    required: ['answer'],
                    additionalProperties: false,
                },
                responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
            },
        },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('{}', 'STOP'))] },
    },
    {
        // A JSON-Schema `type` array is flattened: one non-null member becomes
        // that `type` (a `null` member merges into `nullable`), several become
        // an `anyOf` of single-type members.
        id: 'request-schema-type-array',
        kind: 'stream',
        mode: 'stream',
        request: {
            model: 'gemini-2.5-flash',
            contents: 'Answer as JSON',
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        maybe: { type: ['string', 'null'] },
                        both: { type: ['string', 'number'] },
                        one: { type: ['integer'] },
                    },
                    required: ['maybe'],
                },
            },
        },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('{}', 'STOP'))] },
    },
    {
        // A `responseSchema` that carries `$schema` is a JSON Schema, so the SDK
        // sends it as `responseJsonSchema` verbatim and drops `responseSchema`.
        id: 'request-schema-dollar-schema',
        kind: 'stream',
        mode: 'stream',
        request: {
            model: 'gemini-2.5-flash',
            contents: 'Answer as JSON',
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: { answer: { type: 'string' } },
                    required: ['answer'],
                    additionalProperties: false,
                },
            },
        },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('{}', 'STOP'))] },
    },
    {
        // `type` and `anyOf` on one schema is refused before any request.
        id: 'request-schema-type-anyof',
        kind: 'stream',
        mode: 'error',
        request: {
            model: 'gemini-2.5-flash',
            contents: 'Refuse this schema',
            config: { responseSchema: { type: 'string', anyOf: [{ type: 'number' }] } },
        },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('unused', 'STOP'))] },
    },
    {
        // No `contents` at all: the SDK maps only a non-null one, so the body
        // carries no `contents` key.
        id: 'request-contents-absent',
        kind: 'stream',
        mode: 'stream',
        request: { model: 'gemini-2.5-flash' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('no input', 'STOP'))] },
    },

    // ── Vertex AI ──────────────────────────────────────────────────────────
    {
        id: 'vertex-stream-request',
        kind: 'stream',
        mode: 'stream',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: { model: 'gemini-2.5-flash', contents: 'Reach Vertex' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('vertex', 'STOP'))] },
    },
    {
        id: 'vertex-api-version-v1',
        kind: 'stream',
        mode: 'stream',
        client: { vertexai: true, project: 'merci-project', location: 'global', apiVersion: 'v1' },
        request: { model: 'gemini-2.5-flash', contents: 'Pin the API version' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('v1', 'STOP'))] },
    },
    {
        id: 'vertex-models-list',
        kind: 'models',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                publisherModels: [
                    { name: 'publishers/google/models/gemini-a', displayName: 'A', description: 'first publisher model' },
                ],
            })],
        },
    },
    {
        id: 'vertex-embed-predict',
        kind: 'embed',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: { model: 'gemini-embedding-001', contents: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ predictions: [{ embeddings: { values: [0.25, -0.5, 1.75] } }] })],
        },
    },
    {
        id: 'vertex-embed-embedcontent',
        kind: 'embed',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: { model: 'gemini-embedding-2', contents: 'hello' },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                embedding: { values: [0.125, 0.5, -2] },
                usageMetadata: { promptTokenCount: 3 },
                truncated: false,
            })],
        },
    },
    {
        id: 'vertex-embed-config',
        kind: 'embed',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: {
            model: 'gemini-embedding-2',
            contents: 'hello',
            config: { taskType: 'RETRIEVAL_QUERY', title: 'merci query', outputDimensionality: 4 },
        },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ embedding: { values: [0.5, 0.25, -0.125, 1] } })],
        },
    },
    {
        id: 'vertex-predict-config',
        kind: 'embed',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: {
            model: 'gemini-embedding-001',
            contents: 'hello',
            config: { taskType: 'RETRIEVAL_DOCUMENT', title: 'merci doc', outputDimensionality: 4 },
        },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ predictions: [{ embeddings: { values: [0.5, 0.25, -0.125, 1] } }] })],
        },
    },
    {
        // `:predict` reduces every input to its first text and drops the ones
        // without one, so two inputs with three texts make two instances.
        id: 'vertex-predict-nontext',
        kind: 'embed',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: {
            model: 'gemini-embedding-001',
            contents: [
                { parts: [{ text: 'first' }] },
                { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }] },
                { parts: [{ text: 'third' }, { text: 'ignored' }] },
            ],
        },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ predictions: [{ embeddings: { values: [1, 2] } }, { embeddings: { values: [3, 4] } }] })],
        },
    },
    {
        // `:embedContent` takes one content; a second one is refused before any
        // request is made.
        id: 'vertex-embed-two-contents',
        kind: 'embed',
        mode: 'value',
        client: { vertexai: true, project: 'merci-project', location: 'global' },
        request: { model: 'gemini-embedding-2', contents: [{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }] },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({ embedding: { values: [0] } })],
        },
    },
    {
        // Vertex Express: no project, so the SDK addresses the publisher
        // resource directly instead of a location-scoped one.
        id: 'vertex-express-stream',
        kind: 'stream',
        mode: 'stream',
        client: { vertexai: true },
        request: { model: 'gemini-2.5-flash', contents: 'Express, no project' },
        response: { status: 200, headers: SSE_HEADERS, chunks: [frame(textChunk('express', 'STOP'))] },
    },
    {
        id: 'vertex-express-list',
        kind: 'models',
        mode: 'value',
        client: { vertexai: true },
        response: {
            status: 200,
            headers: JSON_HEADERS,
            chunks: [JSON.stringify({
                publisherModels: [
                    { name: 'publishers/google/models/gemini-express', displayName: 'E', description: 'express model' },
                ],
            })],
        },
    },
];

export const CASES = CASE_DEFINITIONS;
