// @ts-check

/**
 * @file The shared support primitives the transports and media factories now
 * call: the bounded body reader, the record coercion, the base64 data URL and
 * the path-to-media-type lookup.
 * @version 0.12.0
 *
 * @description
 * Each one replaced copies that had already drifted — two cap boundaries, an
 * array-inclusive record test, six literal data-URL regexes and three templates,
 * and two extension maps with different fallbacks. The contracts are pinned
 * here so a later "cleanup" cannot quietly move a boundary, accept a list as a
 * record, or change which media type an extension gets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readBodyTextCapped } from '../lib/support/body.mjs';
import { asRecord } from '../lib/support/object.mjs';
import { parseBase64DataUrl, toBase64DataUrl } from '../lib/support/data-url.mjs';
import { mimeTypeForPath } from '../lib/support/mime.mjs';

const encoder = new TextEncoder();

/**
 * A response-shaped plain object whose body streams `chunks`, so the cap is
 * exercised without a network or a real `Response`.
 * @param {{chunks: Array<Uint8Array>, text?: string}} arg0
 * @returns {{response: Response, state: {cancelled: boolean, released: boolean, reads: number}}}
 */
function fakeResponse({ chunks, text = 'fallback text' }) {
    const state = { cancelled: false, released: false, reads: 0 };
    let index = 0;
    const response = /** @type {any} */ ({
        body: {
            /** @returns {any} */
            getReader() {
                return {
                    /** @returns {Promise<{done: boolean, value?: Uint8Array}>} */
                    async read() {
                        state.reads += 1;
                        if (index >= chunks.length) return { done: true, value: undefined };
                        const value = chunks[index];
                        index += 1;
                        return { done: false, value };
                    },
                    /** @returns {Promise<void>} */
                    async cancel() { state.cancelled = true; },
                    /** @returns {void} */
                    releaseLock() { state.released = true; },
                };
            },
        },
        /** @returns {Promise<string>} */
        async text() { return text; },
    });
    return { response, state };
}

test('readBodyTextCapped cuts at maxBytes, cancels the rest and releases the lock', async () => {
    const { response, state } = fakeResponse({
        chunks: [encoder.encode('aaaa'), encoder.encode('bbbb'), encoder.encode('cc')],
    });
    assert.equal(await readBodyTextCapped({ response, maxBytes: 6 }), 'aaaabb');
    assert.equal(state.cancelled, true, 'the rest of the body is cancelled');
    assert.equal(state.released, true, 'the reader lock is released');
});

test('readBodyTextCapped stops at a chunk that lands exactly on the cap', async () => {
    const { response, state } = fakeResponse({
        chunks: [encoder.encode('abcd'), encoder.encode('ef')],
    });
    assert.equal(await readBodyTextCapped({ response, maxBytes: 4 }), 'abcd');
    assert.equal(state.cancelled, true, 'the boundary is inclusive: no extra read is needed');
    assert.equal(state.reads, 1, 'one read reaches the cap');
});

test('readBodyTextCapped round-trips a body under the cap', async () => {
    const { response, state } = fakeResponse({ chunks: [encoder.encode('hel'), encoder.encode('lo')] });
    assert.equal(await readBodyTextCapped({ response, maxBytes: 1_024 }), 'hello');
    assert.equal(state.cancelled, false, 'a body under the cap is read to the end, never cancelled');
    assert.equal(state.released, true);
});

test('readBodyTextCapped falls back to response.text() without a reader', async () => {
    const response = /** @type {any} */ ({ text: async () => 'no stream here' });
    assert.equal(await readBodyTextCapped({ response, maxBytes: 16 }), 'no stream here');
});

test('asRecord keeps a record and refuses every non-record', () => {
    const record = { type: 'image', data: 'AA==' };
    assert.equal(asRecord({ value: record }), record, 'the same reference, not a copy');
    assert.equal(asRecord({ value: [] }), null, 'an array is not a keyed record');
    assert.equal(asRecord({ value: null }), null);
    assert.equal(asRecord({ value: undefined }), null);
    assert.equal(asRecord({ value: 'text' }), null);
    assert.equal(asRecord({ value: () => ({}) }), null);
});

test('parseBase64DataUrl reads the strict form and refuses the rest', () => {
    assert.deepEqual(parseBase64DataUrl({ url: 'data:image/png;base64,AA==' }), { mimeType: 'image/png', data: 'AA==' });
    assert.equal(parseBase64DataUrl({ url: 'data:image/png,AA==' }), null, 'no ;base64 marker');
    assert.equal(parseBase64DataUrl({ url: 'data:image/png;base64,' }), null, 'empty payload');
    assert.equal(parseBase64DataUrl({ url: 'data:;base64,AA==' }), null, 'empty media type');
    assert.equal(parseBase64DataUrl({ url: ' data:image/png;base64,AA==' }), null, 'leading whitespace');
    assert.equal(parseBase64DataUrl({ url: 'data:image/png;base64,AA==\n' }), null, 'trailing newline');
    assert.equal(parseBase64DataUrl({ url: 'https://example.test/a.png' }), null, 'a remote URL is not a data URL');
});

test('toBase64DataUrl round-trips through parseBase64DataUrl', () => {
    const url = toBase64DataUrl({ mimeType: 'application/pdf', data: 'JVBERi0=' });
    assert.equal(url, 'data:application/pdf;base64,JVBERi0=');
    assert.deepEqual(parseBase64DataUrl({ url }), { mimeType: 'application/pdf', data: 'JVBERi0=' });
});

test('mimeTypeForPath reads the shared map, the extra entries and the caller fallback', () => {
    assert.equal(mimeTypeForPath({ path: '/tmp/a.PNG' }), 'image/png', 'the extension is lowercased');
    assert.equal(mimeTypeForPath({ path: '/tmp/a.pdf' }), 'application/pdf');
    assert.equal(mimeTypeForPath({ path: '/tmp/a.svg', extra: { '.svg': 'image/svg+xml' } }), 'image/svg+xml');
    assert.equal(mimeTypeForPath({ path: '/tmp/a.svg' }), 'application/octet-stream', 'no extra entry: the default fallback');
    assert.equal(mimeTypeForPath({ path: '/tmp/a.svg', fallback: 'image/jpeg' }), 'image/jpeg');
    assert.equal(mimeTypeForPath({ path: '/tmp/no-extension' }), 'application/octet-stream');
    assert.equal(mimeTypeForPath({ path: '/tmp/no-extension', fallback: 'image/jpeg' }), 'image/jpeg');
    assert.equal(
        mimeTypeForPath({ path: '/tmp/a.bin', fallback: 'application/octet-stream', extra: { '.svg': 'image/svg+xml' } }),
        'application/octet-stream',
        'the JAI call shape keeps its fallback'
    );
});
