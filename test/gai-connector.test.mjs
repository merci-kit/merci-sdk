// @ts-check
/**
 * @file The native GAI connector's own contract.
 * @version 0.22.0
 *
 * @description
 * What the fixtures cannot show directly: the URL builder for every Vertex host
 * shape and version (Vertex Express included), the body whitelist and
 * `generationConfig` rule, the contents and schema normalisation, the SSE
 * framing rules (CRLF, no space, no trailing blank line, foreign frames,
 * multi-line data), the derived chunk getters, the caller's abort, a stream
 * error frame, the Vertex embed endpoints and their config mapping, and the
 * models pager.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGaiTransport } from '../lib/backends/transport/gai-client.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';

/** One SSE frame, LF-delimited. */
const frame = (/** @type {any} */ value) => `data: ${JSON.stringify(value)}\n\n`;

/**
 * A fetch answering a fixed queue of responses and recording every call.
 * @param {Array<Response>} responses
 * @returns {{fetch: typeof fetch, calls: Array<{url: string, init: any}>}}
 */
function queuedFetch(responses) {
    /** @type {Array<{url: string, init: any}>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        return responses[Math.min(calls.length - 1, responses.length - 1)];
    };
    return { fetch: fetchImpl, calls };
}

/** @param {unknown} body @param {{status?: number}} [options] */
function jsonResponse(body, { status = 200 } = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** @param {Array<string>} chunks */
function sseResponse(chunks) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** @param {Array<any>} stream @returns {Promise<Array<any>>} */
async function collect(stream) {
    /** @type {Array<any>} */
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
}

/** @param {any} init @returns {any} */
function sentBody(init) {
    return init.body ? JSON.parse(init.body) : undefined;
}

/**
 * Builds a transport whose one response is `responses` in order.
 * @param {{options?: Record<string, any>, responses: Array<Response>}} arg0
 * @returns {{transport: Record<string, any>, calls: Array<{url: string, init: any}>}}
 */
function transportWith({ options = {}, responses }) {
    const { fetch, calls } = queuedFetch(responses);
    return { transport: createGaiTransport({ apiKey: 'test-key', fetch, ...options }), calls };
}

// ── URL builder ─────────────────────────────────────────────────────────────

test('connector: Gemini stream URL', async () => {
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
    assert.equal(
        calls[0].url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
});

for (const [location, host] of [
    ['global', 'https://aiplatform.googleapis.com'],
    ['us', 'https://aiplatform.us.rep.googleapis.com'],
    ['eu', 'https://aiplatform.eu.rep.googleapis.com'],
    ['europe-west4', 'https://europe-west4-aiplatform.googleapis.com'],
]) {
    test(`connector: Vertex base for location ${location}`, async () => {
        const { transport, calls } = transportWith({
            options: { vertexai: true, project: 'merci-project', location },
            responses: [sseResponse([frame({ candidates: [] })])],
        });
        await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
        assert.equal(
            calls[0].url,
            `${host}/v1beta1/projects/merci-project/locations/${location}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
        );
    });
}

test('connector: apiVersion overrides the Vertex default', async () => {
    const { transport, calls } = transportWith({
        options: { vertexai: true, project: 'merci-project', location: 'global', apiVersion: 'v1' },
        responses: [sseResponse([frame({ candidates: [] })])],
    });
    await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
    assert.match(calls[0].url, /\/v1\/projects\/merci-project\/locations\/global\//);
});

test('connector: Vertex list drops the project/location prefix', async () => {
    const { transport, calls } = transportWith({
        options: { vertexai: true, project: 'merci-project', location: 'global' },
        responses: [jsonResponse({ publisherModels: [] })],
    });
    await transport.models.list();
    assert.equal(calls[0].url, 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models');
});

test('connector: Vertex Express addresses the publisher resource without a project', async () => {
    const stream = transportWith({
        options: { vertexai: true },
        responses: [sseResponse([frame({ candidates: [] })])],
    });
    await stream.transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
    assert.equal(
        stream.calls[0].url,
        'https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );

    const list = transportWith({ options: { vertexai: true }, responses: [jsonResponse({ publisherModels: [] })] });
    await list.transport.models.list();
    assert.equal(list.calls[0].url, 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models');

    const embed = transportWith({
        options: { vertexai: true },
        responses: [jsonResponse({ embedding: { values: [1] } })],
    });
    await embed.transport.models.embedContent({ model: 'gemini-embedding-2', contents: 'hi' });
    assert.equal(
        embed.calls[0].url,
        'https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-embedding-2:embedContent',
    );
});

test('connector: model path rules', async () => {
    const responses = () => [sseResponse([frame({ candidates: [] })])];

    const passthrough = transportWith({
        options: { vertexai: true, project: 'p1', location: 'global' },
        responses: responses(),
    });
    await passthrough.transport.models.generateContentStream({
        model: 'projects/other/locations/eu/publishers/google/models/gemini-x',
        contents: 'hi',
    });
    assert.match(passthrough.calls[0].url, /\/v1beta1\/projects\/other\/locations\/eu\/publishers\/google\/models\/gemini-x:/);

    const publisher = transportWith({
        options: { vertexai: true, project: 'p1', location: 'global' },
        responses: responses(),
    });
    await publisher.transport.models.generateContentStream({ model: 'acme/widget', contents: 'hi' });
    assert.match(publisher.calls[0].url, /\/projects\/p1\/locations\/global\/publishers\/acme\/models\/widget:/);

    const models = transportWith({
        options: { vertexai: true, project: 'p1', location: 'global' },
        responses: responses(),
    });
    await models.transport.models.generateContentStream({ model: 'models/gemini-x', contents: 'hi' });
    assert.match(models.calls[0].url, /\/projects\/p1\/locations\/global\/models\/gemini-x:/);

    await assert.rejects(
        createGaiTransport({ apiKey: 'test-key', fetch: queuedFetch(responses()).fetch }).models
            .generateContentStream({ model: '../etc/passwd', contents: 'hi' }),
        (/** @type {any} */ error) => {
            assert.equal(error.option, 'model');
            return true;
        },
    );
});

// ── body mapper ─────────────────────────────────────────────────────────────

test('connector: config hoisting, whitelist and unknown-key dropping', async () => {
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await transport.models.generateContentStream({
        model: 'gemini-2.5-pro',
        contents: 'hi',
        config: {
            systemInstruction: 'Be brief.',
            tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
            labels: { team: 'merci' },
            temperature: 0.3,
            maxOutputTokens: 128,
            thinkingConfig: { thinkingBudget: 512 },
            httpOptions: { headers: { 'X-Merci-Session-Id': 'run-1' } },
            unknownKey: 'dropped',
        },
    });
    const body = sentBody(calls[0].init);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
    assert.deepEqual(body.systemInstruction, { role: 'user', parts: [{ text: 'Be brief.' }] });
    assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'lookup' }] }]);
    assert.deepEqual(body.labels, { team: 'merci' });
    assert.deepEqual(body.generationConfig, {
        temperature: 0.3,
        maxOutputTokens: 128,
        thinkingConfig: { thinkingBudget: 512 },
    });
    assert.equal('unknownKey' in body, false, 'unknown config keys never reach the wire');
    assert.equal('httpOptions' in body, false, 'httpOptions is transport-only');
    assert.equal('abortSignal' in body, false, 'abortSignal is transport-only');
    assert.equal(new Headers(calls[0].init.headers).get('x-merci-session-id'), 'run-1');
});

test('connector: generationConfig is emitted for any config object, omitted for none', async () => {
    const headersOnly = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await headersOnly.transport.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: 'hi',
        config: { httpOptions: { headers: { 'X-Test': '1' } } },
    });
    assert.deepEqual(sentBody(headersOnly.calls[0].init).generationConfig, {});

    const absent = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await absent.transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
    assert.equal('generationConfig' in sentBody(absent.calls[0].init), false);

    // The SDK emits an empty `generationConfig` for `config: {}`, not no
    // generationConfig at all.
    const empty = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await empty.transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi', config: {} });
    assert.deepEqual(sentBody(empty.calls[0].init).generationConfig, {});
});

test('connector: contents shapes', async () => {
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: ['one', 'two'] });
    assert.deepEqual(sentBody(calls[0].init).contents, [
        { role: 'user', parts: [{ text: 'one' }, { text: 'two' }] },
    ], 'a list of parts is ONE content carrying all of them');

    const objects = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await objects.transport.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: [{ parts: [{ text: 'kept' }, { text: 'both' }] }, { role: 'model', parts: [{ text: 'reply' }] }],
    });
    assert.deepEqual(sentBody(objects.calls[0].init).contents, [
        { parts: [{ text: 'kept' }, { text: 'both' }] },
        { parts: [{ text: 'reply' }], role: 'model' },
    ], 'Content objects pass through as they are');

    const bare = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await bare.transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: { text: 'single' } });
    assert.deepEqual(sentBody(bare.calls[0].init).contents, [{ role: 'user', parts: [{ text: 'single' }] }]);
});

test('connector: mixing Content and Parts, or a bare function part, is refused before the request', async () => {
    const mixed = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await assert.rejects(
        mixed.transport.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ text: 'a' }] }, { text: 'b' }],
        }),
        /Mixing Content and Parts is not supported/,
    );
    assert.equal(mixed.calls.length, 0, 'the refusal happens before any request');

    const bareCall = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await assert.rejects(
        bareCall.transport.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: { functionCall: { name: 'lookup', args: {} } },
        }),
        /please wrap them in a Content object/,
    );
    assert.equal(bareCall.calls.length, 0);
});

test('connector: responseSchema is normalised and responseJsonSchema is passed through', async () => {
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await transport.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: 'hi',
        config: {
            responseSchema: {
                type: 'object',
                properties: {
                    answer: { type: 'string', nullable: true },
                    tags: { type: 'array', items: { type: 'string' } },
                    maybe: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
                    pick: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                    unknown: { type: 'money' },
                    raw: { allOf: [{ type: 'string' }] },
                },
                required: ['answer'],
                additionalProperties: false,
            },
            responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
    });
    const { generationConfig } = sentBody(calls[0].init);
    assert.deepEqual(generationConfig.responseSchema, {
        type: 'OBJECT',
        properties: {
            answer: { type: 'STRING', nullable: true },
            tags: { type: 'ARRAY', items: { type: 'STRING' } },
            maybe: { nullable: true, type: 'BOOLEAN' },
            pick: { anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }] },
            unknown: { type: 'TYPE_UNSPECIFIED' },
            raw: { allOf: [{ type: 'string' }] },
        },
        required: ['answer'],
    });
    assert.deepEqual(
        generationConfig.responseJsonSchema,
        { type: 'object', properties: { answer: { type: 'string' } } },
        'responseJsonSchema is not touched',
    );
});

test('connector: responseSchema type arrays are flattened the SDK way', async () => {
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await transport.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: 'hi',
        config: {
            responseSchema: {
                type: 'object',
                properties: {
                    maybe: { type: ['string', 'null'] },
                    merged: { nullable: true, type: ['boolean', 'null'] },
                    both: { type: ['string', 'number'] },
                    one: { type: ['integer'] },
                    nested: { type: 'array', items: { type: ['string', 'null'] } },
                },
            },
        },
    });
    assert.deepEqual(sentBody(calls[0].init).generationConfig.responseSchema, {
        type: 'OBJECT',
        properties: {
            maybe: { nullable: true, type: 'STRING' },
            merged: { nullable: true, type: 'BOOLEAN' },
            both: { anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }] },
            one: { type: 'INTEGER' },
            nested: { type: 'ARRAY', items: { nullable: true, type: 'STRING' } },
        },
    }, 'a type array becomes a type (with nullable) or an anyOf, and its key is dropped');
});

test('connector: a schema with both type and anyOf is refused before any request', async () => {
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await assert.rejects(
        transport.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: 'hi',
            config: { responseSchema: { type: 'string', anyOf: [{ type: 'number' }] } },
        }),
        /type and anyOf cannot be both populated\./,
    );
    assert.equal(calls.length, 0, 'the refusal happens before any request');

    // A `type` array beside an `anyOf` is the same refusal, not a flatten.
    const array = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await assert.rejects(
        array.transport.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: 'hi',
            config: { responseSchema: { type: ['string', 'number'], anyOf: [{ type: 'boolean' }] } },
        }),
        /type and anyOf cannot be both populated\./,
    );
    assert.equal(array.calls.length, 0);
});

test('connector: responseSchema with $schema is sent as responseJsonSchema', async () => {
    const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
    };
    const { transport, calls } = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await transport.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: 'hi',
        config: { responseSchema: schema },
    });
    const { generationConfig } = sentBody(calls[0].init);
    assert.equal('responseSchema' in generationConfig, false, 'the JSON Schema is not sent as responseSchema');
    assert.deepEqual(generationConfig.responseJsonSchema, schema, 'it travels verbatim, untouched');

    // A caller-supplied responseJsonSchema wins, and the responseSchema beside
    // it stays on the normalised path, as the SDK left it.
    const supplied = { type: 'object', properties: { answer: { type: 'string' } } };
    const both = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await both.transport.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: 'hi',
        config: { responseSchema: schema, responseJsonSchema: supplied },
    });
    const bothConfig = sentBody(both.calls[0].init).generationConfig;
    assert.deepEqual(bothConfig.responseJsonSchema, supplied, 'the caller value is untouched');
    assert.deepEqual(bothConfig.responseSchema, {
        $schema: schema.$schema,
        type: 'OBJECT',
        properties: { answer: { type: 'STRING' } },
        required: ['answer'],
    }, 'the un-moved responseSchema is still normalised');
});

test('connector: absent or null contents send no contents key; an empty list is refused', async () => {
    const absent = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await absent.transport.models.generateContentStream({ model: 'gemini-2.5-flash' });
    assert.deepEqual(sentBody(absent.calls[0].init), {}, 'no contents key, no generationConfig');

    const nullContents = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await nullContents.transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: null });
    assert.equal('contents' in sentBody(nullContents.calls[0].init), false);

    const empty = transportWith({ responses: [sseResponse([frame({ candidates: [] })])] });
    await assert.rejects(
        empty.transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: [] }),
        /contents are required/,
    );
    assert.equal(empty.calls.length, 0, 'the refusal happens before any request');
});

test('connector: mode-only config keys are refused', async () => {
    const gemini = createGaiTransport({ apiKey: 'test-key', fetch: queuedFetch([sseResponse([])]).fetch });
    await assert.rejects(
        gemini.models.generateContentStream({ model: 'm', contents: 'hi', config: { routingConfig: { autoMode: {} } } }),
        /Enterprise Agent Platform mode/,
    );
    await assert.rejects(
        gemini.models.generateContentStream({ model: 'm', contents: 'hi', config: { modelSelectionConfig: {} } }),
        /Enterprise Agent Platform mode/,
    );

    const vertex = createGaiTransport({
        vertexai: true, project: 'p', location: 'global', apiKey: 'test-key', fetch: queuedFetch([sseResponse([])]).fetch,
    });
    await assert.rejects(
        vertex.models.generateContentStream({ model: 'm', contents: 'hi', config: { store: true } }),
        /Gemini Developer API mode/,
    );
    await assert.rejects(
        vertex.models.generateContentStream({ model: 'm', contents: 'hi', config: { enableEnhancedCivicAnswers: true } }),
        /Gemini Developer API mode/,
    );
});

// ── SSE framing ─────────────────────────────────────────────────────────────

test('connector: SSE framing accepts CRLF and a missing space', async () => {
    const { transport } = transportWith({
        responses: [sseResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\r\n\r\n',
            'data:{"candidates":[{"content":{"parts":[{"text":"b"}]}}]}\n\n',
        ])],
    });
    const chunks = await collect(await transport.models.generateContentStream({ model: 'm', contents: 'hi' }));
    assert.deepEqual(chunks.map((chunk) => chunk.text), ['a', 'b']);
});

test('connector: SSE ignores frames that do not start with data:', async () => {
    const { transport } = transportWith({
        responses: [sseResponse([
            'event: message_start\ndata: {"type":"message_start"}\n\n',
            'event: ping\n\n',
            ': a comment\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"kept"}]}}]}\n\n',
        ])],
    });
    const chunks = await collect(await transport.models.generateContentStream({ model: 'm', contents: 'hi' }));
    assert.deepEqual(chunks.map((chunk) => chunk.text), ['kept']);
});

test('connector: a 200 stream answer with no frames is NON_JSON_STREAM', async () => {
    /** @type {Array<[string, Response]>} */
    const cases = [
        ['text/plain', new Response('not an event stream', { status: 200, headers: { 'content-type': 'text/plain' } })],
        ['missing content-type', new Response('<html><body>Sign in</body></html>', { status: 200 })],
        ['HTML mislabelled text/event-stream', new Response('<html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/event-stream' } })],
    ];
    for (const [label, response] of cases) {
        const { transport } = transportWith({ responses: [response] });
        const stream = await transport.models.generateContentStream({ model: 'm', contents: 'hi' });
        await assert.rejects(collect(stream), (/** @type {any} */ error) => {
            assert.equal(error.code, 'NON_JSON_STREAM', label);
            assert.equal(error.nonRetryable, true, `${label}: non-retryable`);
            return true;
        });
    }
});

test('connector: a missing final blank line is an incomplete segment', async () => {
    const { transport } = transportWith({ responses: [sseResponse(['data: {"candidates":[]}'])] });
    const stream = await transport.models.generateContentStream({ model: 'm', contents: 'hi' });
    await assert.rejects(collect(stream), /Incomplete JSON segment at the end/);
});

test('connector: multiple data lines are not joined', async () => {
    const { transport } = transportWith({ responses: [sseResponse(['data: {"a":1}\ndata: {"b":2}\n\n'])] });
    const stream = await transport.models.generateContentStream({ model: 'm', contents: 'hi' });
    await assert.rejects(collect(stream), (/** @type {any} */ error) => {
        assert.equal(error.name, 'SyntaxError');
        return true;
    });
});

test('connector: chunk getters expose text and functionCalls, invisibly to JSON', async () => {
    const { transport } = transportWith({
        responses: [sseResponse([frame({
            candidates: [{
                content: {
                    parts: [
                        { text: 'thinking…', thought: true },
                        { text: 'answer' },
                        { functionCall: { id: 'fc_1', name: 'lookup', args: { q: 'x' } } },
                    ],
                },
            }],
        })])],
    });
    const chunks = await collect(await transport.models.generateContentStream({ model: 'm', contents: 'hi' }));
    assert.equal(chunks[0].text, 'answer', 'thought parts are excluded');
    assert.deepEqual(chunks[0].functionCalls, [{ id: 'fc_1', name: 'lookup', args: { q: 'x' } }]);
    const projected = JSON.parse(JSON.stringify(chunks[0]));
    assert.equal('text' in projected, false, 'the getter is non-enumerable');
    assert.equal('functionCalls' in projected, false, 'the getter is non-enumerable');

    const plain = transportWith({
        responses: [sseResponse([frame({ candidates: [{ content: { parts: [] } }] })])],
    });
    const [empty] = await collect(await plain.transport.models.generateContentStream({ model: 'm', contents: 'hi' }));
    assert.equal(empty.text, undefined, 'no text parts means no text getter value');
    assert.equal(empty.functionCalls, undefined, 'no function calls means no functionCalls getter value');
});

test('connector: a caller abort mid-stream throws instead of ending cleanly', async () => {
    const encoder = new TextEncoder();
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(frame({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })));
                init?.signal?.addEventListener('abort', () => {
                    controller.error(new DOMException('This operation was aborted', 'AbortError'));
                });
            },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const transport = createGaiTransport({ apiKey: 'test-key', fetch: fetchImpl });
    const controller = new AbortController();
    const stream = await transport.models.generateContentStream({
        model: 'm',
        contents: 'hi',
        config: { abortSignal: controller.signal },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(/** @type {{text: string}} */ (first.value).text, 'partial');
    controller.abort();
    await assert.rejects(iterator.next(), (/** @type {any} */ error) => {
        assert.equal(error.name, 'AbortError');
        return true;
    });
});

test('connector: a 2xx JSON body carrying an error raises the typed ApiError (A2-3)', async () => {
    // A proxy or the vendor's JSON mode answers 200 with `{error}`; the SSE
    // reader must surface the vendor's status and message, not its own
    // `Incomplete JSON segment at the end`.
    const { transport } = transportWith({
        responses: [jsonResponse({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } })],
    });
    const stream = await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
    await assert.rejects(collect(stream), (/** @type {any} */ error) => {
        assert.equal(error.name, 'ApiError');
        assert.equal(error.status, 429, 'the vendor code is the status');
        assert.match(error.message, /quota/, 'the vendor message is kept');
        assert.equal(error.headers?.get('content-type'), 'application/json', 'the headers reach the error');
        assert.equal(Object.keys(error).includes('headers'), false, 'headers stay non-enumerable');
        return true;
    });
});

test('connector: a 2xx JSON body that is not an error keeps the old leftover-tail refusal', async () => {
    const { transport } = transportWith({
        responses: [jsonResponse({ candidates: [{ content: { parts: [{ text: 'whole' }] } }] })],
    });
    const stream = await transport.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
    await assert.rejects(collect(stream), /Incomplete JSON segment at the end/);
});

test('connector: an SSE error frame raises the SDK status error', async () => {
    const { transport } = transportWith({
        responses: [sseResponse([frame({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } })])],
    });
    const stream = await transport.models.generateContentStream({ model: 'm', contents: 'hi' });
    await assert.rejects(collect(stream), (/** @type {any} */ error) => {
        assert.equal(error.name, 'ApiError');
        assert.equal(error.status, 429);
        assert.equal(error.message, 'got status: RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}');
        return true;
    });
});

test('connector: an SSE error frame without a numeric code is still an ApiError', async () => {
    const { transport } = transportWith({
        responses: [sseResponse([frame({ error: { message: 'quota exceeded', status: 'resource_exhausted' } })])],
    });
    const stream = await transport.models.generateContentStream({ model: 'm', contents: 'hi' });
    await assert.rejects(collect(stream), (/** @type {any} */ error) => {
        assert.equal(error.name, 'ApiError');
        assert.equal(error.status, 500, 'no numeric status is a server error, never silence');
        return true;
    });
});

test('connector: a non-2xx open raises the SDK status error', async () => {
    const { transport } = transportWith({
        responses: [jsonResponse({ error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } }, { status: 400 })],
    });
    await assert.rejects(
        transport.models.generateContentStream({ model: 'm', contents: 'hi' }),
        (/** @type {any} */ error) => {
            assert.equal(error.name, 'ApiError');
            assert.equal(error.status, 400);
            assert.equal(error.message, '{"error":{"code":400,"message":"bad","status":"INVALID_ARGUMENT"}}');
            return true;
        },
    );
});

test("connector: a non-JSON error body uses the server's status text", async () => {
    const { transport } = transportWith({
        responses: [new Response('gateway says no', {
            status: 418,
            statusText: 'Custom Gateway Text',
            headers: { 'content-type': 'text/plain' },
        })],
    });
    await assert.rejects(
        transport.models.generateContentStream({ model: 'm', contents: 'hi' }),
        (/** @type {any} */ error) => {
            assert.equal(error.name, 'ApiError');
            assert.equal(error.status, 418);
            assert.equal(
                error.message,
                JSON.stringify({ error: { message: 'gateway says no', code: 418, status: 'Custom Gateway Text' } }),
                "the synthesized body carries the response's own reason phrase",
            );
            return true;
        },
    );
});

test('connector: a non-JSON error body becomes the synthesized ApiError and is capped', async () => {
    setLimits({ values: { max_error_body_bytes: 1_024 } });
    try {
        const { transport } = transportWith({
            responses: [new Response('x'.repeat(4_096), { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain' } })],
        });
        await assert.rejects(
            transport.models.generateContentStream({ model: 'm', contents: 'hi' }),
            (/** @type {any} */ error) => {
                assert.equal(error.name, 'ApiError');
                assert.equal(error.status, 502);
                assert.equal(
                    error.message,
                    JSON.stringify({ error: { message: 'x'.repeat(1_024), code: 502, status: 'Bad Gateway' } }),
                    'the SDK synthesizes {error: {message, code, status}} from the capped text',
                );
                return true;
            },
        );
    } finally {
        resetLimits();
    }
});

// ── embed ───────────────────────────────────────────────────────────────────

test('connector: Gemini embed always batches', async () => {
    const { transport, calls } = transportWith({
        responses: [jsonResponse({ embeddings: [{ values: [0.1] }] })],
    });
    const result = await transport.models.embedContent({ model: 'text-embedding-004', contents: 'hello' });
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents');
    assert.deepEqual(sentBody(calls[0].init), {
        requests: [{ model: 'models/text-embedding-004', content: { role: 'user', parts: [{ text: 'hello' }] } }],
    });
    assert.deepEqual(result, { embeddings: [{ values: [0.1] }] });
});

test('connector: Gemini embed keeps object contents without a role', async () => {
    const { transport, calls } = transportWith({ responses: [jsonResponse({ embeddings: [] })] });
    await transport.models.embedContent({ model: 'text-embedding-004', contents: [{ parts: [{ text: 'alpha' }] }] });
    assert.deepEqual(sentBody(calls[0].init).requests, [
        { model: 'models/text-embedding-004', content: { parts: [{ text: 'alpha' }] } },
    ]);
});

test('connector: Gemini embed drops a lone embedding key', async () => {
    const { transport } = transportWith({ responses: [jsonResponse({ embedding: { values: [1] } })] });
    const result = await transport.models.embedContent({ model: 'text-embedding-004', contents: 'hello' });
    assert.equal(result.embeddings, undefined, 'only the batch key is read');
});

test('connector: Vertex embed routes by the SDK predicate', async () => {
    const predict = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ predictions: [{ embeddings: { values: [1] } }] })],
    });
    const predicted = await predict.transport.models.embedContent({ model: 'gemini-embedding-001', contents: 'hello' });
    assert.match(predict.calls[0].url, /\/gemini-embedding-001:predict$/);
    assert.deepEqual(sentBody(predict.calls[0].init), { instances: [{ content: 'hello' }] });
    assert.deepEqual(predicted, { embeddings: [{ values: [1] }] });

    const maas = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ embedding: { values: [1] } })],
    });
    await maas.transport.models.embedContent({ model: 'text-maas-embed', contents: 'hello' });
    assert.match(maas.calls[0].url, /:embedContent$/);
});

test('connector: Vertex :embedContent reads the single embedding and its statistics', async () => {
    const { transport, calls } = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({
            embedding: { values: [0.5, -1] },
            usageMetadata: { promptTokenCount: 4, promptTokensDetails: [{ tokenCount: 4 }] },
            truncated: true,
        })],
    });
    const result = await transport.models.embedContent({ model: 'gemini-embedding-2', contents: 'hello' });
    assert.match(calls[0].url, /\/gemini-embedding-2:embedContent$/);
    assert.deepEqual(sentBody(calls[0].init), { content: { role: 'user', parts: [{ text: 'hello' }] } });
    assert.deepEqual(result, {
        embeddings: [{
            values: [0.5, -1],
            statistics: { tokenCount: 4, tokensDetails: [{ tokenCount: 4 }], truncated: true },
        }],
    });

    // `truncated: false` and no usage metadata still yield an empty statistics,
    // and the `predictions` key of the other endpoint means nothing here.
    const empty = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ embedding: { values: [1] }, predictions: [{ embeddings: { values: [9] } }] })],
    });
    const statistics = await empty.transport.models.embedContent({ model: 'gemini-embedding-2', contents: 'hello' });
    assert.deepEqual(statistics, { embeddings: [{ values: [1], statistics: {} }] });
});

test('connector: Vertex :embedContent refuses a second content without a request', async () => {
    const { transport, calls } = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ embedding: { values: [1] } })],
    });
    await assert.rejects(
        transport.models.embedContent({
            model: 'gemini-embedding-2',
            contents: [{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }],
        }),
        /The embedContent API for this model only supports one content at a time\./,
    );
    assert.equal(calls.length, 0, 'the refusal happens before any request');
});

test('connector: Vertex :predict keeps only each content first text', async () => {
    const { transport, calls } = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ predictions: [{ embeddings: { values: [1] } }] })],
    });
    await transport.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [
            { parts: [{ text: 'first' }, { text: 'ignored' }] },
            { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }] },
            'third',
        ],
    });
    assert.deepEqual(sentBody(calls[0].init), {
        instances: [{ content: 'first' }, { content: 'third' }],
    });
});

test('connector: Gemini embed groups strings for gemini-embedding-2 only', async () => {
    const grouped = transportWith({ responses: [jsonResponse({ embeddings: [{ values: [1] }] })] });
    await grouped.transport.models.embedContent({ model: 'gemini-embedding-2', contents: ['a', 'b'] });
    assert.deepEqual(sentBody(grouped.calls[0].init).requests, [{
        model: 'models/gemini-embedding-2',
        content: { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
    }], 'one request, one content, both strings as parts');

    const split = transportWith({ responses: [jsonResponse({ embeddings: [{ values: [1] }, { values: [2] }] })] });
    await split.transport.models.embedContent({ model: 'text-embedding-004', contents: ['a', 'b'] });
    assert.deepEqual(sentBody(split.calls[0].init).requests.map((/** @type {any} */ request) => request.content), [
        { role: 'user', parts: [{ text: 'a' }] },
        { role: 'user', parts: [{ text: 'b' }] },
    ], 'any other Gemini embed model gets one request per string');
});

test('connector: embed config lands on the endpoint the call uses', async () => {
    const config = { taskType: 'RETRIEVAL_DOCUMENT', title: 'merci doc', outputDimensionality: 4 };

    const mldev = transportWith({ responses: [jsonResponse({ embeddings: [{ values: [1] }] })] });
    await mldev.transport.models.embedContent({ model: 'gemini-embedding-2', contents: 'hello', config });
    assert.deepEqual(sentBody(mldev.calls[0].init).requests, [{
        model: 'models/gemini-embedding-2',
        content: { role: 'user', parts: [{ text: 'hello' }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        title: 'merci doc',
        outputDimensionality: 4,
    }]);

    const embedContent = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ embedding: { values: [1] } })],
    });
    await embedContent.transport.models.embedContent({ model: 'gemini-embedding-2', contents: 'hello', config });
    assert.deepEqual(sentBody(embedContent.calls[0].init).embedContentConfig, {
        taskType: 'RETRIEVAL_DOCUMENT',
        title: 'merci doc',
        outputDimensionality: 4,
    });

    const predict = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ predictions: [{ embeddings: { values: [1] } }] })],
    });
    await predict.transport.models.embedContent({ model: 'gemini-embedding-001', contents: 'hello', config });
    assert.deepEqual(sentBody(predict.calls[0].init), {
        instances: [{ content: 'hello', task_type: 'RETRIEVAL_DOCUMENT', title: 'merci doc' }],
        parameters: { outputDimensionality: 4 },
    });

    const refused = transportWith({ responses: [jsonResponse({ embeddings: [] })] });
    await assert.rejects(
        refused.transport.models.embedContent({ model: 'text-embedding-004', contents: 'hello', config: { mimeType: 'application/pdf' } }),
        /mimeType parameter is only supported in Gemini Enterprise Agent Platform mode/,
    );
});

// ── models pager ────────────────────────────────────────────────────────────

test('connector: models pager pages, pageSize and the async iterator', async () => {
    const responses = [
        jsonResponse({ models: [{ name: 'models/a' }], nextPageToken: 't1' }),
        jsonResponse({ models: [{ name: 'models/b' }] }),
        jsonResponse({ models: [{ name: 'models/a' }], nextPageToken: 't1' }),
        jsonResponse({ models: [{ name: 'models/b' }] }),
        jsonResponse({ models: [] }),
    ];
    const { transport, calls } = transportWith({ responses });

    const pager = await transport.models.list();
    assert.deepEqual(pager.page, [{ name: 'models/a', tunedModelInfo: {} }]);
    assert.equal(pager.pageSize, 1);
    assert.equal(pager.hasNextPage(), true);
    assert.deepEqual(await pager.nextPage(), [{ name: 'models/b', tunedModelInfo: {} }]);
    assert.equal(pager.hasNextPage(), false);
    await assert.rejects(pager.nextPage(), /No more pages to fetch/);
    assert.deepEqual(
        calls.slice(0, 2).map((call) => call.url),
        [
            'https://generativelanguage.googleapis.com/v1beta/models',
            'https://generativelanguage.googleapis.com/v1beta/models?pageToken=t1',
        ],
    );

    /** @type {Array<string>} */
    const names = [];
    const iterated = await transport.models.list();
    for await (const model of iterated) names.push(model.name);
    assert.deepEqual(names, ['models/a', 'models/b']);

    await transport.models.list({ config: { pageSize: 5 } });
    assert.equal(calls[calls.length - 1].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=5');
});

test('connector: Vertex model items rename versionId and keep the tuned-model default', async () => {
    const { transport } = transportWith({
        options: { vertexai: true, project: 'p', location: 'global' },
        responses: [jsonResponse({ publisherModels: [{ name: 'publishers/google/models/a', versionId: 'v9' }] })],
    });
    const pager = await transport.models.list();
    assert.deepEqual(pager.page, [{ name: 'publishers/google/models/a', version: 'v9', tunedModelInfo: {} }]);
});
