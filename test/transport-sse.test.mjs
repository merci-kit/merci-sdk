// @ts-check
/**
 * @file Strict SSE reader tests for the native OAI transport.
 * @version 0.22.0
 *
 * @description
 * Every dispatch rule the OpenAI SDK enforced: line terminators, multi-line
 * data, comments, trailing-event flush, the `[DONE]` sentinel, error chunks,
 * incremental UTF-8 decoding, abort and cancellation. Streams are built in
 * memory — no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';
import { iterateSseEvents, iterateSseJson } from '../lib/backends/transport/sse.mjs';

const encoder = new TextEncoder();

/**
 * Builds a response body from string and byte chunks.
 * @param {Array<string|Uint8Array>} chunks
 * @returns {ReadableStream<Uint8Array>}
 */
function streamOf(chunks) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            controller.close();
        },
    });
}

/**
 * Collects every JSON event a stream yields.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<Array<any>>}
 */
async function collectJson(stream) {
    /** @type {Array<any>} */
    const events = [];
    for await (const event of iterateSseJson({ stream })) events.push(event);
    return events;
}

/**
 * Collects every raw SSE dispatch a stream yields.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<Array<{event: string|null, data: string}>>}
 */
async function collectRaw(stream) {
    /** @type {Array<{event: string|null, data: string}>} */
    const events = [];
    for await (const event of iterateSseEvents({ stream })) events.push(event);
    return events;
}

test('sse: dispatches data with the event name, ignoring id and comments', async () => {
    const events = await collectRaw(streamOf(['event: message\nid: 7\n: keep-alive\ndata: {"a":1}\n\n']));
    assert.deepEqual(events, [{ event: 'message', data: '{"a":1}' }]);
});

test('sse: data without an event name has a null event', async () => {
    const events = await collectRaw(streamOf(['data:hello\n\n']));
    assert.deepEqual(events, [{ event: null, data: 'hello' }]);
});

test('sse: multiple data lines join with a newline', async () => {
    const events = await collectRaw(streamOf(['data: {"a":\ndata: 1}\n\n']));
    assert.deepEqual(events, [{ event: null, data: '{"a":\n1}' }]);
    assert.deepEqual(await collectJson(streamOf(['data: {"a":\ndata: 1}\n\n'])), [{ a: 1 }]);
});

test('sse: a blank line with no fields does not dispatch', async () => {
    assert.deepEqual(await collectRaw(streamOf(['\n\n\n'])), []);
    assert.deepEqual(await collectRaw(streamOf([': comment only\n\n'])), []);
});

test('sse: handles CRLF terminators', async () => {
    const events = await collectRaw(streamOf(['event: x\r\ndata: {"a":1}\r\n\r\n']));
    assert.deepEqual(events, [{ event: 'x', data: '{"a":1}' }]);
});

test('sse: handles bare CR terminators', async () => {
    const events = await collectJson(streamOf(['data: {"a":1}\r\rdata: {"a":2}\r\r']));
    assert.deepEqual(events, [{ a: 1 }, { a: 2 }]);
});

test('sse: a CRLF split across chunks is one terminator', async () => {
    const events = await collectRaw(streamOf(['data: {"a":1}\r', '\n\r\ndata: {"a":2}\r\n', '\r\n']));
    assert.deepEqual(events, [
        { event: null, data: '{"a":1}' },
        { event: null, data: '{"a":2}' },
    ]);
});

test('sse: flushes a trailing event that has no blank line', async () => {
    assert.deepEqual(await collectJson(streamOf(['data: {"a":1}'])), [{ a: 1 }]);
    assert.deepEqual(await collectJson(streamOf(['data: {"a":2}\n'])), [{ a: 2 }]);
    assert.deepEqual(await collectJson(streamOf(['data: {"a":3}\r'])), [{ a: 3 }]);
});

test('sse: decodes a multi-byte character split across chunks', async () => {
    const payload = JSON.stringify({ t: 'ěščř' });
    const bytes = encoder.encode(`data: ${payload}\n\n`);
    const splitAt = bytes.findIndex((byte) => byte >= 0xc0) + 1;
    assert.ok(splitAt > 0, 'the fixture must contain the multi-byte character');
    const events = await collectJson(streamOf([bytes.slice(0, splitAt), bytes.slice(splitAt)]));
    assert.deepEqual(events, [{ t: 'ěščř' }]);
});

test('sse: [DONE] stops iteration and ignores the bytes after it', async () => {
    assert.deepEqual(await collectJson(streamOf(['data: [DONE]\n\ndata: {"a":1}\n\n'])), []);
    assert.deepEqual(await collectJson(streamOf(['data: [DONE]\n\ndata: not json\n\n'])), []);
});

test('sse: [DONE] records sawDone on the caller state; a clean EOF does not', async () => {
    const done = { sawDone: false };
    for await (const event of iterateSseJson({ stream: streamOf(['data: {"a":1}\n\ndata: [DONE]\n\n']), state: done })) void event;
    assert.equal(done.sawDone, true);

    const eof = { sawDone: false };
    for await (const event of iterateSseJson({ stream: streamOf(['data: {"a":1}\n\n']), state: eof })) void event;
    assert.equal(eof.sawDone, false, 'a connection close is not the sentinel');
});

test('sse: doneSentinel: null consumes every frame and ends only at EOF', async () => {
    const state = { sawDone: false };
    /** @type {Array<any>} */
    const events = [];
    for await (const event of iterateSseJson({ stream: streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\n']), doneSentinel: null, state })) events.push(event);
    assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
    assert.equal(state.sawDone, false, 'with no sentinel the stream never "saw" one');
});

test('sse: doneSentinel: null parses a [DONE]-looking frame instead of stopping', async () => {
    const state = { sawDone: false };
    const iterator = iterateSseJson({ stream: streamOf(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n']), doneSentinel: null, state });
    assert.deepEqual((await iterator.next()).value, { a: 1 });
    await assert.rejects(iterator.next(), (/** @type {any} */ error) => {
        assert.ok(error instanceof SyntaxError, 'the sentinel text is parsed, not recognised');
        return true;
    });
    assert.equal(state.sawDone, false);
});

test('sse: a custom error predicate and factory receive the payload and headers', async () => {
    const headers = new Headers({ 'request-id': 'req_1' });
    /** @type {{payload?: unknown, headers?: Headers}|undefined} */
    let received;
    const iterator = iterateSseJson({
        stream: streamOf(['event: ping\ndata: {"weird":true,"n":1}\n\n']),
        headers,
        isErrorPayload: (parsed) => /** @type {{weird?: boolean}} */ (parsed).weird === true,
        toError: (payload, seenHeaders) => {
            received = { payload, headers: seenHeaders };
            return new Error('vendor error');
        },
    });
    await assert.rejects(iterator.next(), /vendor error/);
    assert.deepEqual(received?.payload, { weird: true, n: 1 });
    assert.equal(received?.headers, headers, 'the response headers reach the vendor factory');
});

test('sse: malformed event JSON throws the SDK message', async () => {
    await assert.rejects(collectJson(streamOf(['data: {oops\n\n'])), (/** @type {any} */ error) => {
        assert.ok(error instanceof SyntaxError);
        assert.equal(error.message, 'Error reading response: malformed server-sent event JSON.');
        return true;
    });
});

test('sse: an error payload chunk throws an API error', async () => {
    await assert.rejects(
        collectJson(streamOf(['data: {"error":{"message":"boom","type":"invalid_request_error","code":"bad"}}\n\n'])),
        (/** @type {any} */ error) => {
            assert.equal(error.message, 'boom');
            assert.equal(error.type, 'invalid_request_error');
            assert.equal(error.code, 'bad');
            assert.equal(error.name, 'Error');
            assert.equal(error.status, undefined);
            return true;
        },
    );
});

test('sse: an event named error throws an API error', async () => {
    await assert.rejects(collectJson(streamOf(['event: error\ndata: {"message":"boom"}\n\n'])), (/** @type {any} */ error) => {
        assert.equal(error.message, 'boom');
        assert.equal(error.name, 'Error');
        return true;
    });
});

test('sse: an error chunk carries the response headers', async () => {
    const headers = new Headers({ 'retry-after': '3', 'x-request-id': 'req_7' });
    await assert.rejects(async () => {
        for await (const event of iterateSseJson({ stream: streamOf(['data: {"error":{"message":"boom"}}\n\n']), headers })) void event;
    }, (/** @type {any} */ error) => {
        assert.equal(error.message, 'boom');
        assert.equal(error.status, undefined);
        assert.equal(error.headers.get('retry-after'), '3');
        assert.equal(error.requestID, 'req_7');
        return true;
    });
});

test('sse: an unrelated error after an abort is not swallowed', async () => {
    const aborter = new AbortController();
    /** @type {{current?: ReadableStreamDefaultController<Uint8Array>}} */
    const source = {};
    const stream = new ReadableStream({ start(c) { source.current = c; } });
    const iterator = iterateSseJson({ stream, signal: aborter.signal });
    const first = iterator.next();
    source.current?.enqueue(encoder.encode('data: {"a":1}\n\n'));
    assert.deepEqual((await first).value, { a: 1 });
    const second = iterator.next();
    aborter.abort();
    source.current?.error(new TypeError('body broke'));
    await assert.rejects(second, (/** @type {any} */ error) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, 'body broke');
        return true;
    });
});

test('sse: a mid-stream abort ends iteration cleanly', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(encoder.encode('data: {"a":1}\n\n'));
            c.enqueue(encoder.encode('data: {"a":2}\n\n'));
            c.close();
        },
    });
    const iterator = iterateSseJson({ stream, signal: controller.signal });
    assert.deepEqual((await iterator.next()).value, { a: 1 });
    controller.abort();
    const ended = await iterator.next();
    assert.equal(ended.done, true);
    assert.equal(ended.value, undefined);
});

test('sse: an early return cancels the response body', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(encoder.encode('data: {"a":1}\n\n'));
            c.enqueue(encoder.encode('data: {"a":2}\n\n'));
        },
        cancel() { cancelled = true; },
    });
    const iterator = iterateSseJson({ stream });
    const first = await iterator.next();
    assert.deepEqual(first.value, { a: 1 });
    await iterator.return(undefined);
    assert.equal(cancelled, true);
});

test('sse: a line above sse_max_line_bytes throws a non-retryable SSE_LINE_TOO_LONG', async () => {
    setLimits({ values: { sse_max_line_bytes: 1_024 } });
    try {
        await assert.rejects(collectRaw(streamOf([`data: ${'x'.repeat(4_096)}\n\n`])), (/** @type {any} */ error) => {
            assert.equal(error.code, 'SSE_LINE_TOO_LONG');
            assert.equal(error.nonRetryable, true);
            assert.match(error.message, /1024/);
            assert.match(error.message, /sse_max_line_bytes/);
            return true;
        });
    } finally {
        resetLimits();
    }
});

test('sse: a pending line split across chunks is still bounded', async () => {
    setLimits({ values: { sse_max_line_bytes: 1_024 } });
    try {
        const chunks = Array.from({ length: 8 }, () => 'z'.repeat(200));
        await assert.rejects(collectRaw(streamOf(chunks)), (/** @type {any} */ error) => {
            assert.equal(error.code, 'SSE_LINE_TOO_LONG');
            return true;
        });
    } finally {
        resetLimits();
    }
});

test('sse: a multi-line event above the cap throws the same error', async () => {
    setLimits({ values: { sse_max_line_bytes: 1_024 } });
    try {
        const frame = `data: ${'q'.repeat(600)}\n`.repeat(4) + '\n';
        await assert.rejects(collectRaw(streamOf([frame])), (/** @type {any} */ error) => {
            assert.equal(error.code, 'SSE_LINE_TOO_LONG');
            return true;
        });
    } finally {
        resetLimits();
    }
});

test('the SSE cap counts UTF-8 bytes', async () => {
    setLimits({ values: { sse_max_line_bytes: 1_024 } });
    try {
        // 1008 UTF-16 units, but 3024 bytes: the cap is a byte cap.
        const text = '漢'.repeat(1_008);
        assert.equal(text.length, 1_008);
        await assert.rejects(collectRaw(streamOf([`data: ${text}\n\n`])), (/** @type {any} */ error) => {
            assert.equal(error.code, 'SSE_LINE_TOO_LONG');
            return true;
        });
    } finally {
        resetLimits();
    }
});

test('sse: a long but legal line arrives intact', async () => {
    const payload = JSON.stringify({ t: 'y'.repeat(200_000) });
    const events = await collectJson(streamOf([`data: ${payload}\n\n`]));
    assert.deepEqual(events, [JSON.parse(payload)]);
});

test('sse: a 5 MB single line does not hang', { timeout: 10_000 }, async () => {
    await assert.rejects(collectRaw(streamOf([`data: ${'z'.repeat(5 * 1024 * 1024)}\n\n`])), (/** @type {any} */ error) => {
        assert.equal(error.code, 'SSE_LINE_TOO_LONG');
        return true;
    });
});

test('sse: the cleanup runs once the body is done', async () => {
    let cleanedUp = 0;
    const events = [];
    for await (const event of iterateSseJson({ stream: streamOf(['data: {"a":1}\n\n']), cleanup: () => { cleanedUp += 1; } })) events.push(event);
    assert.deepEqual(events, [{ a: 1 }]);
    assert.equal(cleanedUp, 1);
});
