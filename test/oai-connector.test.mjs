// @ts-check
/**
 * @file Native OAI transport client tests.
 * @version 0.21.0
 *
 * @description
 * The call surface the OAI adapter consumes: stream/non-stream dispatch,
 * chunk normalisation, output_text aggregation, base64 embeddings, the model
 * list, and the properties a host or test replaces wholesale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';

import { createOaiTransport } from '../lib/backends/transport/oai-client.mjs';

const encoder = new TextEncoder();

/**
 * Runs `run` against a loopback server and always tears it down.
 * @param {import('node:http').RequestListener} handler
 * @param {(arg0: {baseURL: string}) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    try {
        await run({ baseURL: `http://127.0.0.1:${address.port}` });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => { server.close(() => resolve(undefined)); });
    }
}

/**
 * Reads a request body to its end.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
    return new Promise((resolve) => {
        let text = '';
        req.on('data', (chunk) => { text += chunk; });
        req.on('end', () => resolve(text));
    });
}

/**
 * Encodes numbers as the base64 little-endian Float32 payload the API sends.
 * @param {Array<number>} values
 * @returns {string}
 */
function base64Floats(values) {
    return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

/**
 * The transport's answer is `unknown` by design; the assertions here read fixed
 * fixture fields out of it.
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function record(value) {
    return /** @type {Record<string, any>} */ (value);
}

/**
 * Narrows a transport stream to something `for await` can consume.
 * @param {unknown} value
 * @returns {AsyncIterable<any>}
 */
function stream(value) {
    return /** @type {AsyncIterable<any>} */ (value);
}

test('client: streaming chat calls /chat/completions and normalises finish_reason', async () => {
    /** @type {{path?: string, body?: any, authorization?: string}} */
    const seen = {};
    await withServer(async (req, res) => {
        seen.path = req.url;
        seen.authorization = String(req.headers.authorization ?? '');
        seen.body = JSON.parse(await readBody(req));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}',
            '',
            'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}',
            '',
            'data: [DONE]',
            '',
            '',
        ].join('\n'));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(await transport.chat.completions.create({ model: 'm', stream: true }))) chunks.push(chunk);
        assert.equal(seen.path, '/chat/completions');
        assert.equal(seen.authorization, 'Bearer k');
        assert.equal(seen.body.stream, true);
        assert.equal(chunks.length, 2);
        assert.deepEqual(chunks[0], {
            id: 'c1',
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });
        assert.deepEqual(chunks[1], {
            id: 'c1',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { total_tokens: 7 },
        });
    });
});

test('client: chat and responses streams expose streamState.sawDone while keeping single use', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(req.url === '/responses'
            ? 'data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: [DONE]\n\n'
            : 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });

        const chat = await transport.chat.completions.create({ model: 'm', stream: true });
        assert.equal(record(chat).streamState.sawDone, false, 'not done before the body is consumed');
        assert.equal(Object.getOwnPropertyDescriptor(record(chat), 'streamState')?.enumerable, false, 'streamState is non-enumerable');
        for await (const chunk of stream(chat)) void chunk;
        assert.equal(record(chat).streamState.sawDone, true, 'the chat [DONE] sentinel is recorded');

        const responses = await transport.responses.create({ model: 'm', stream: true });
        assert.equal(record(responses).streamState.sawDone, false);
        for await (const chunk of stream(responses)) void chunk;
        assert.equal(record(responses).streamState.sawDone, true, 'the responses [DONE] sentinel is recorded');

        await assert.rejects(async () => {
            for await (const chunk of stream(chat)) void chunk;
        }, /Cannot iterate over a consumed stream\./);
    });
});

test('client: a stream that closes without [DONE] leaves sawDone false', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const streamed = await transport.chat.completions.create({ model: 'm', stream: true });
        for await (const chunk of stream(streamed)) void chunk;
        assert.equal(record(streamed).streamState.sawDone, false, 'a clean close is not the sentinel');
    });
});

test('client: a text/html 200 on a stream call throws NON_JSON_STREAM before streaming', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>Sign in to continue</body></html>');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        for (const call of [
            () => transport.chat.completions.create({ model: 'm', stream: true }),
            () => transport.responses.create({ model: 'm', stream: true }),
        ]) {
            await assert.rejects(call, (error) => {
                const e = /** @type {any} */ (error);
                assert.equal(e.code, 'NON_JSON_STREAM');
                assert.equal(e.nonRetryable, true);
                assert.equal(e.status, undefined, 'status stays unset');
                assert.match(e.message, /text\/html/);
                assert.match(e.message, /Sign in to continue/);
                assert.ok(e instanceof Error);
                return true;
            });
        }
    });
});

test('client: a stream without a content-type is still read as SSE', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200);
        res.end('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(await transport.chat.completions.create({ model: 'm', stream: true }))) chunks.push(chunk);
        assert.deepEqual(chunks, [{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }]);
    });
});

test('client: SSE served as text/plain (a FastAPI/Flask proxy) is read as a stream', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(await transport.chat.completions.create({ model: 'm', stream: true }))) chunks.push(chunk);
        assert.deepEqual(chunks, [{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }]);
    });
});

test('client: a */* content-type is read as SSE', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': '*/*' });
        res.end('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(await transport.chat.completions.create({ model: 'm', stream: true }))) chunks.push(chunk);
        assert.deepEqual(chunks, [{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }]);
    });
});

test('client: a gateway that ignores stream:true and answers application/json yields the full response once', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"id":"c1","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const answer = await transport.chat.completions.create({ model: 'm', stream: true });
        assert.equal(record(answer).streamState.sawDone, true, 'a full JSON answer is already terminal');
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(answer)) chunks.push(chunk);
        assert.deepEqual(chunks.map((chunk) => chunk.id), ['c1']);
        await assert.rejects(async () => {
            for await (const chunk of stream(answer)) void chunk;
        }, /Cannot iterate over a consumed stream\./);
    });
});

test('client: a +json gateway answer yields the full Responses object once', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/vnd.api+json' });
        res.end('{"object":"response","id":"r1","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const answer = await transport.responses.create({ model: 'm', stream: true });
        assert.equal(record(answer).streamState.sawDone, true);
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(answer)) chunks.push(chunk);
        assert.equal(chunks.length, 1);
        assert.equal(record(chunks[0]).id, 'r1');
    });
});

test('client: an application/xhtml+xml 200 on a stream call still throws NON_JSON_STREAM', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/xhtml+xml; charset=utf-8' });
        res.end('<html><body>Sign in to continue</body></html>');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        await assert.rejects(transport.chat.completions.create({ model: 'm', stream: true }), (/** @type {any} */ error) => {
            assert.equal(error.code, 'NON_JSON_STREAM');
            assert.match(error.message, /application\/xhtml\+xml/);
            return true;
        });
    });
});

test('client: non-streaming chat returns the parsed body', async () => {
    await withServer(async (req, res) => {
        assert.equal(req.url, '/chat/completions');
        const body = JSON.parse(await readBody(req));
        assert.equal(body.stream, undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"c1","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const body = record(await transport.chat.completions.create({ model: 'm' }));
        assert.equal(body.choices[0].message.content, 'hi');
    });
});

test('client: a streaming responses call is not normalised', async () => {
    await withServer(async (req, res) => {
        assert.equal(req.url, '/responses');
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(await transport.responses.create({ model: 'm', stream: true }))) chunks.push(chunk);
        assert.deepEqual(chunks, [{ type: 'response.output_text.delta', delta: 'hi' }]);
    });
});

test('client: a stream error chunk carries the response headers', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '3' });
        res.end('data: {"error":{"message":"upstream explosion","type":"server_error"}}\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        await assert.rejects(async () => {
            for await (const chunk of stream(await transport.chat.completions.create({ model: 'm', stream: true }))) void chunk;
        }, (/** @type {any} */ error) => {
            assert.equal(error.message, 'upstream explosion');
            assert.equal(error.status, undefined);
            assert.equal(error.headers.get('retry-after'), '3');
            return true;
        });
    });
});

test('client: a non-streaming response gains the aggregated output_text', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            object: 'response',
            id: 'r1',
            output: [
                {
                    type: 'message',
                    content: [
                        { type: 'output_text', text: 'he' },
                        { type: 'refusal', refusal: 'no' },
                        { type: 'output_text', text: 'llo' },
                    ],
                },
                { type: 'function_call', name: 'lookup', arguments: '{}' },
                { type: 'message', content: [{ type: 'output_text', text: '!' }] },
            ],
        }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const body = record(await transport.responses.create({ model: 'm' }));
        assert.equal(body.output_text, 'hello!');
        assert.equal(body.id, 'r1');
        assert.equal(body.output[0].content.length, 3);
    });
});

test('client: a pre-set output_text is overwritten', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            object: 'response',
            output_text: 'stale',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'fresh' }] }],
        }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const body = record(await transport.responses.create({ model: 'm' }));
        assert.equal(body.output_text, 'fresh');
    });
});

test('client: a response without output is a TypeError', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"object":"response","id":"r1"}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        await assert.rejects(transport.responses.create({ model: 'm' }), (/** @type {any} */ error) => {
            assert.ok(error instanceof TypeError);
            return true;
        });
    });
});

test('client: embeddings ask for base64 and decode it without mutating the body', async () => {
    /** @type {any} */
    let wireBody;
    await withServer(async (req, res) => {
        wireBody = JSON.parse(await readBody(req));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ index: 0, object: 'embedding', embedding: base64Floats([1, 2.5]) }] }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const callerBody = { model: 'e', input: 'x' };
        const body = record(await transport.embeddings.create(callerBody));
        assert.equal(wireBody.encoding_format, 'base64');
        assert.equal(/** @type {any} */ (callerBody).encoding_format, undefined);
        assert.deepEqual(body.data[0].embedding, [1, 2.5]);
        assert.equal(body.data[0].index, 0);
    });
});

test('client: an explicit base64 encoding_format returns the wire string undecoded', async () => {
    /** @type {any} */
    let wireBody;
    const wire = base64Floats([0.5]);
    await withServer(async (req, res) => {
        wireBody = JSON.parse(await readBody(req));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: wire }] }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const body = record(await transport.embeddings.create({ model: 'e', input: 'x', encoding_format: 'base64' }));
        assert.equal(wireBody.encoding_format, 'base64');
        assert.equal(body.data[0].embedding, wire);
    });
});

test('client: an empty or null encoding_format still forces base64 and decodes', async () => {
    /** @type {Array<any>} */
    const wireBodies = [];
    await withServer(async (req, res) => {
        wireBodies.push(JSON.parse(await readBody(req)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: base64Floats([1]) }] }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        for (const encodingFormat of ['', null]) {
            const body = record(await transport.embeddings.create({ model: 'e', input: 'x', encoding_format: encodingFormat }));
            assert.deepEqual(body.data[0].embedding, [1]);
        }
        assert.deepEqual(wireBodies.map((body) => body.encoding_format), ['base64', 'base64']);
    });
});

test('client: an explicit float encoding_format is sent as given and is not decoded', async () => {
    /** @type {any} */
    let wireBody;
    await withServer(async (req, res) => {
        wireBody = JSON.parse(await readBody(req));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[{"embedding":[0.5]}]}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const body = record(await transport.embeddings.create({ model: 'e', input: 'x', encoding_format: 'float' }));
        assert.equal(wireBody.encoding_format, 'float');
        assert.deepEqual(body.data[0].embedding, [0.5]);
    });
});

test('client: an embedding that is already an array is skipped', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [0.25] }, { embedding: base64Floats([2]) }] }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const body = record(await transport.embeddings.create({ model: 'e', input: 'x' }));
        assert.deepEqual(body.data[0].embedding, [0.25]);
        assert.deepEqual(body.data[1].embedding, [2]);
    });
});

test('client: a non-array embedding payload is a TypeError', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":{"embedding":[]}}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        await assert.rejects(transport.embeddings.create({ model: 'e', input: 'x' }), (/** @type {any} */ error) => {
            assert.ok(error instanceof TypeError);
            assert.equal(error.message, 'Expected embeddings response data to be an array');
            return true;
        });
    });
});

test('client: an unaligned base64 payload is a RangeError', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Buffer.from([1, 2, 3]).toString('base64') }] }));
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        await assert.rejects(transport.embeddings.create({ model: 'e', input: 'x' }), (/** @type {any} */ error) => {
            assert.ok(error instanceof RangeError);
            assert.equal(error.message, 'Invalid base64-encoded float32 array: byte length must be a multiple of 4');
            return true;
        });
    });
});

test('client: models.list defaults the data array', async () => {
    let reply = '{"object":"list","data":[{"id":"m1"}]}';
    await withServer((req, res) => {
        assert.equal(req.url, '/models');
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(reply);
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const listed = record(await transport.models.list());
        assert.deepEqual(listed.data, [{ id: 'm1' }]);
        assert.equal(listed.object, 'list');
        reply = '{"object":"list"}';
        const empty = record(await transport.models.list());
        assert.deepEqual(empty.data, []);
    });
});

test('client: models.list names a non-object body instead of returning an empty list', async () => {
    /** @type {string} */
    let reply = '<html><body>Sign in to continue</body></html>';
    /** @type {string} */
    let contentType = 'text/html';
    await withServer((req, res) => {
        assert.equal(req.url, '/models');
        req.resume();
        res.writeHead(200, { 'content-type': contentType });
        res.end(reply);
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });

        await assert.rejects(transport.models.list(), (error) => {
            const e = /** @type {any} */ (error);
            assert.equal(e.code, 'NON_OBJECT_MODELS_BODY');
            assert.equal(e.nonRetryable, true);
            assert.match(e.message, /\/models/);
            assert.match(e.message, /string/);
            assert.match(e.message, /Sign in to continue/);
            assert.ok(e instanceof TypeError);
            return true;
        });

        contentType = 'application/json';
        reply = '42';
        await assert.rejects(transport.models.list(), /number/);
        reply = '[{"id":"m1"}]';
        await assert.rejects(transport.models.list(), /array/);
    });
});

test('client: models.list with a JSON null body throws', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('null');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        await assert.rejects(transport.models.list(), (/** @type {any} */ error) => {
            assert.ok(error instanceof TypeError);
            return true;
        });
    });
});

test('client: namespaces are writable own properties', async () => {
    const transport = createOaiTransport({ apiKey: 'k', baseURL: 'http://127.0.0.1:1/v1' });
    for (const name of ['chat', 'responses', 'embeddings', 'models']) {
        const descriptor = Object.getOwnPropertyDescriptor(transport, name);
        assert.ok(descriptor, `${name} must be an own property`);
        assert.equal(descriptor.writable, true);
        assert.equal(typeof descriptor.get, 'undefined');
    }
    const replaced = { completions: { create: async () => ({ replaced: true }) } };
    transport.chat = replaced;
    assert.deepEqual(await transport.chat.completions.create({}), { replaced: true });
    transport.models = { list: async () => ({ data: [] }) };
    assert.deepEqual(await transport.models.list(), { data: [] });
});

test('client: identity options are kept verbatim and maxRetries defaults to 0', () => {
    const transport = createOaiTransport({ apiKey: 'secret', baseURL: 'https://example.test/v1' });
    assert.equal(transport.apiKey, 'secret');
    assert.equal(transport.baseURL, 'https://example.test/v1');
    assert.equal(transport.maxRetries, 0);
    const retrying = createOaiTransport({ apiKey: 'k', baseURL: 'https://example.test/v1', maxRetries: 3 });
    assert.equal(retrying.maxRetries, 3);
});

test('client: a missing signal is tolerated', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        assert.deepEqual(await transport.chat.completions.create({ model: 'm' }, { signal: undefined }), { ok: true });
        assert.deepEqual(await transport.chat.completions.create({ model: 'm' }, {}), { ok: true });
    });
});

test('client: a chat stream is consumed once and a second iteration throws', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"a":1}\n\ndata: [DONE]\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const streamed = await transport.chat.completions.create({ model: 'm', stream: true });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(streamed)) chunks.push(chunk);
        assert.deepEqual(chunks, [{ a: 1 }]);
        await assert.rejects(async () => {
            for await (const chunk of stream(streamed)) void chunk;
        }, /Cannot iterate over a consumed stream\./);
    });
});

test('client: a responses stream is consumed once and a second iteration throws', async () => {
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        const streamed = await transport.responses.create({ model: 'm', stream: true });
        /** @type {Array<any>} */
        const chunks = [];
        for await (const chunk of stream(streamed)) chunks.push(chunk);
        assert.deepEqual(chunks, [{ type: 'response.output_text.delta', delta: 'hi' }]);
        await assert.rejects(async () => {
            for await (const chunk of stream(streamed)) void chunk;
        }, /Cannot iterate over a consumed stream\./);
    });
});

test('client: breaking out of a stream cancels the body and releases the signal', async () => {
    let cancelled = false;
    const body = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('data: {"a":1}\n\n')); },
        cancel() { cancelled = true; },
    });
    /** @type {typeof fetch} */
    const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const transport = createOaiTransport({ apiKey: 'k', baseURL: 'http://127.0.0.1:1/v1', fetch: fetchImpl });
    const controller = new AbortController();
    const streamed = await transport.chat.completions.create({ model: 'm', stream: true }, { signal: controller.signal });
    for await (const chunk of stream(streamed)) {
        assert.deepEqual(chunk, { a: 1 });
        break;
    }
    assert.equal(cancelled, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('client: _request_id survives the responses, embeddings and models transforms', async () => {
    /** @type {string} */
    let reply = '';
    await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_transform' });
        res.end(reply);
    }, async ({ baseURL }) => {
        const transport = createOaiTransport({ apiKey: 'k', baseURL });
        reply = JSON.stringify({ object: 'response', id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] });
        const responses = record(await transport.responses.create({ model: 'm' }));
        reply = JSON.stringify({ object: 'list', data: [{ index: 0, embedding: base64Floats([1]) }] });
        const embeddings = record(await transport.embeddings.create({ model: 'e', input: 'x' }));
        reply = JSON.stringify({ object: 'list', data: [{ id: 'm1' }] });
        const models = record(await transport.models.list());
        for (const [name, value] of Object.entries({ responses, embeddings, models })) {
            assert.equal(value._request_id, 'req_transform', `${name} keeps _request_id`);
            assert.equal(Object.getOwnPropertyDescriptor(value, '_request_id')?.enumerable, false, `${name} keeps it non-enumerable`);
        }
        assert.equal(responses.output_text, 'hi');
        assert.deepEqual(embeddings.data[0].embedding, [1]);
        assert.deepEqual(models.data, [{ id: 'm1' }]);
    });
});
