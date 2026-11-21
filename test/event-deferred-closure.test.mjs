// @ts-check
/** Closure proofs for the previously-deferred events: embed_error, api_stream_*, event:unhandled. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MerciClient as OaiClient } from '../lib/backends/oai.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

test('embed_error fires on a hard embed failure, not on the soft-fail path', async () => {
    const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1', embedMaxRetries: 0 } }));
    /** @type {any[]} */
    const embedErrors = [];
    client.on(EVENTS.CLIENT.EMBED_ERROR, (/** @type {any} */ e) => embedErrors.push(e));
    client.transport.embeddings = { create: async () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); } };
    await assert.rejects(client.embed({ input: 'hello' }), /quota exhausted/);
    assert.equal(embedErrors.length, 1);
    assert.equal(embedErrors[0].event, 'embed_error');
    assert.equal(embedErrors[0].error, 'quota exhausted');
    assert.equal(typeof embedErrors[0].durationMs, 'number');

    const soft = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1' } }));
    /** @type {any[]} */
    const softErrors = [];
    soft.on(EVENTS.CLIENT.EMBED_ERROR, (/** @type {any} */ e) => softErrors.push(e));
    soft.transport.embeddings = { create: async () => { throw Object.assign(new Error('<html>404 page</html>'), { status: 404 }); } };
    assert.equal(await soft.embed({ input: 'hello' }), null);
    assert.equal(softErrors.length, 0);
});

test('api_stream_start and api_stream_end bracket the step stream', async () => {
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: {}, observability: {} }),
        executeVendorRequest: async () => ({}),
        consumeStream: async function* () { yield { type: 'text', content: 'hi' }; },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} }),
    };
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.CLIENT.API_STREAM_START, (/** @type {any} */ e) => seen.push(['start', e.event]));
    emitter.on(EVENTS.CLIENT.API_STREAM_END, (/** @type {any} */ e) => seen.push(['end', e.status, typeof e.durationMs]));
    const session = new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: emitter,
        provider: ProviderType.OPENAI,
        adapter,
        buildParameters: (/** @type {any} */ { s }) => s,
    });
    session._onStepShouldPrepare = () => false;
    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    assert.deepEqual(seen, [['start', 'api_stream_start'], ['end', 'success', 'number']]);
});

test('strict mode surfaces event:unhandled; the default never does', () => {
    const strict = new MerciEventEmitter({ strict: true });
    /** @type {string[]} */
    const unhandled = [];
    strict.on(EVENTS.ERRORS.UNHANDLED, (/** @type {any} */ e) => unhandled.push(e.event));
    strict.emit('nobody:listens', {});
    strict.on('someone:listens', () => {});
    strict.emit('someone:listens', {});
    assert.deepEqual(unhandled, ['nobody:listens']);

    const relaxed = new MerciEventEmitter();
    let n = 0;
    relaxed.on(EVENTS.ERRORS.UNHANDLED, () => { n += 1; });
    relaxed.emit('nobody:listens', {});
    assert.equal(n, 0);
});

test('strict mode reports unhandled through emitSafe too (the emitEvent path)', () => {
    const strict = new MerciEventEmitter({ strict: true });
    /** @type {string[]} */
    const unhandled = [];
    strict.on(EVENTS.ERRORS.UNHANDLED, (/** @type {any} */ e) => unhandled.push(e.event));
    strict.emitSafe('nobody:listens', {});
    assert.deepEqual(unhandled, ['nobody:listens']);
});
