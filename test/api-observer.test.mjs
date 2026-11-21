// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { EventEmitterApiObserver } from '../lib/support/api-observer.mjs';

// ==================================================================================
// Wiring with EventEmitter
// ==================================================================================

test('EventEmitterApiObserver: onRequest emits api_request on the underlying EventEmitter', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    let captured = null;
    emitter.on('api_request', (meta) => { captured = meta; });
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'https://x', method: 'POST', body: { foo: 1 }, headers: { a: 'b' } } }));
    assert.deepEqual(captured, { url: 'https://x', method: 'POST', body: { foo: 1 }, headers: { a: 'b' } });
});

test('EventEmitterApiObserver: onResponse emits api_response on the underlying EventEmitter', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    let captured = null;
    emitter.on('api_response', (meta) => { captured = meta; });
    observer.onResponse(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { status: 200, ok: true } }));
    assert.deepEqual(captured, { status: 200, ok: true });
});

test('EventEmitterApiObserver: onError emits the error on the underlying EventEmitter', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    /** @type {any} */
    let captured = null;
    emitter.on('error', (err) => { captured = err; });
    const err = new Error('boom');
    observer.onError({ meta: { error: err } });
    assert.equal(captured, err);
    assert.equal(captured.message, 'boom');
});

// ==================================================================================
// ==================================================================================

test('EventEmitterApiObserver: OAI-shape onRequest meta (model, messages, params) passes through intact', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    let captured = null;
    emitter.on('api_request', (meta) => { captured = meta; });
    const messages = [{ role: 'user', content: 'hi' }];
    const params = { model: 'gpt-4o', messages };
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { model: 'gpt-4o', messages, params } }));
    assert.deepEqual(captured, { model: 'gpt-4o', messages, params });
});

test('EventEmitterApiObserver: GAI-shape onRequest meta (model, contents, config) passes through intact', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    let captured = null;
    emitter.on('api_request', (meta) => { captured = meta; });
    const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
    const config = { systemInstruction: { parts: [{ text: 'sys' }] } };
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { model: 'gemini-1.5-flash', contents, config } }));
    assert.deepEqual(captured, { model: 'gemini-1.5-flash', contents, config });
});

test('EventEmitterApiObserver: AAI-shape onRequest meta (model, messages, params) passes through intact', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    let captured = null;
    emitter.on('api_request', (meta) => { captured = meta; });
    const messages = [{ role: 'user', content: 'hi' }];
    const params = { model: 'claude-3-5-sonnet-latest', max_tokens: 1024 };
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { model: 'claude-3-5-sonnet-latest', messages, params } }));
    assert.deepEqual(captured, { model: 'claude-3-5-sonnet-latest', messages, params });
});

test('EventEmitterApiObserver: JAI-shape onRequest meta (url, method, body, headers) passes through intact', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    let captured = null;
    emitter.on('api_request', (meta) => { captured = meta; });
    const body = JSON.stringify({ foo: 1 });
    const headers = { 'Grazie-Agent': 'x' };
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'https://api.x/v9', method: 'POST', body, headers } }));
    assert.deepEqual(captured, { url: 'https://api.x/v9', method: 'POST', body, headers });
});

test('EventEmitterApiObserver: JAI-shape onResponse meta (url, status, ok, headers) passes through intact', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    /** @type {any} */
    let captured = null;
    emitter.on('api_response', (meta) => { captured = meta; });
    const headers = new Map([['content-type', 'text/event-stream']]);
    observer.onResponse(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'https://api.x/v9', status: 200, ok: true, headers } }));
    assert.equal(captured.url, 'https://api.x/v9');
    assert.equal(captured.status, 200);
    assert.equal(captured.ok, true);
    assert.equal(captured.headers, headers);
});

// ==================================================================================
// Defensive: no emitter
// ==================================================================================

test('EventEmitterApiObserver: with null emitter, all calls are silent no-ops (no throw)', () => {
    const observer = new EventEmitterApiObserver({ emitter: null });
    assert.doesNotThrow(() => observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'x' } })));
    assert.doesNotThrow(() => observer.onResponse(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { status: 200, ok: true } })));
    assert.doesNotThrow(() => observer.onError({ meta: { error: new Error('x') } }));
});

test('EventEmitterApiObserver: with undefined emitter, all calls are silent no-ops', () => {
    const observer = new EventEmitterApiObserver({ emitter: /** @type {any} */ (undefined) });
    assert.doesNotThrow(() => observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'x' } })));
    assert.doesNotThrow(() => observer.onResponse(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { status: 200, ok: true } })));
    assert.doesNotThrow(() => observer.onError({ meta: { error: new Error('x') } }));
});

test('EventEmitterApiObserver: with an emitter that lacks emit() (defensive), calls do not throw', () => {
    const fakeEmitter = { emit: null };
    const observer = new EventEmitterApiObserver({ emitter: /** @type {any} */ (fakeEmitter) });
    assert.doesNotThrow(() => observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'x' } })));
    assert.doesNotThrow(() => observer.onResponse(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { status: 200, ok: true } })));
    assert.doesNotThrow(() => observer.onError({ meta: { error: new Error('x') } }));
});

// ==================================================================================
// Multiple observers / subscribers
// ==================================================================================

test('EventEmitterApiObserver: multiple subscribers on api_request all receive the meta', () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    /** @type {any[]} */
    const captured = [];
    emitter.on('api_request', (meta) => captured.push(['a', meta]));
    emitter.on('api_request', (meta) => captured.push(['b', meta]));
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { url: 'x' } }));
    assert.equal(captured.length, 2);
    assert.equal(captured[0][0], 'a');
    assert.equal(captured[1][0], 'b');
    assert.deepEqual(captured[0][1], { url: 'x' });
    assert.deepEqual(captured[1][1], { url: 'x' });
});
