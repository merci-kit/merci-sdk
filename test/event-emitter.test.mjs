// @ts-check
/** Focused proofs for MerciEventEmitter: glob, priority, isolation, serial. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { EVENTS, emitEvent } from '../lib/core/events.mjs';

test('MerciEventEmitter is a drop-in EventEmitter', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    assert.ok(e instanceof EventEmitter);
});

test('glob: * stays within a segment, ** spans segments', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    /** @type {any[]} */
    const seen = [];
    e.on('run:*', (/** @type {any} */ p) => seen.push(['one', p.event]));
    e.on('run:**', (/** @type {any} */ p) => seen.push(['deep', p.event]));
    e.emit('run:start', { event: 'run:start' });
    e.emit('run:iteration:start', { event: 'run:iteration:start' });
    assert.deepEqual(seen, [
        ['one', 'run:start'], ['deep', 'run:start'], ['deep', 'run:iteration:start'],
    ]);
});

test('onAny sees every event and unsubscribes', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    /** @type {string[]} */
    const seen = [];
    const off = e.onAny((/** @type {any} */ p) => seen.push(p.event));
    e.emit('a', { event: 'a' });
    e.emit('b:c', { event: 'b:c' });
    off();
    e.emit('a', { event: 'a' });
    assert.deepEqual(seen, ['a', 'b:c']);
});

test('priority desc then insertion order; prepend first', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    /** @type {string[]} */
    const order = [];
    e.on('x', () => order.push('a'));
    e.on('x', () => order.push('b'), { priority: 5 });
    e.on('x', () => order.push('c'), { prepend: true });
    e.on('x', () => order.push('d'), { priority: -1 });
    e.emit('x', {});
    assert.deepEqual(order, ['c', 'b', 'a', 'd']);
});

test('emitSafe isolates a throwing listener and reports listener_error', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    /** @type {string[]} */
    const seen = [];
    /** @type {any[]} */
    const errors = [];
    e.on('x', () => { throw new Error('boom'); });
    e.on('x', () => seen.push('second'));
    e.on(EVENTS.ERRORS.LISTENER_ERROR, (/** @type {any} */ p) => errors.push(p));
    e.emitSafe('x', {});
    assert.deepEqual(seen, ['second']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].sourceEvent, 'x');
    assert.match(errors[0].error, /boom/);
});

test('emitSafe catches an async listener rejection', async () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    /** @type {any[]} */
    const errors = [];
    e.on(EVENTS.ERRORS.LISTENER_ERROR, (/** @type {any} */ p) => errors.push(p));
    e.on('x', async () => { throw new Error('async-boom'); });
    e.emitSafe('x', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /async-boom/);
});

test('once fires exactly once', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    let n = 0;
    e.once('x', () => { n += 1; });
    e.emit('x', {});
    e.emit('x', {});
    assert.equal(n, 1);
    assert.equal(e.listenerCount('x'), 0);
});

test('subscribe returns an unsubscribe fn', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    let n = 0;
    const off = e.subscribe('run:*', () => { n += 1; });
    e.emit('run:start', {});
    off();
    e.emit('run:start', {});
    assert.equal(n, 1);
});

test('emitSerial awaits listeners in order', async () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    /** @type {string[]} */
    const order = [];
    e.on('x', async () => { await new Promise((r) => setTimeout(r, 10)); order.push('a'); });
    e.on('x', async () => { order.push('b'); });
    await e.emitSerial('x', {});
    assert.deepEqual(order, ['a', 'b']);
});

test('error event throws without a listener, dispatches with one', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    assert.throws(() => e.emit('error', new Error('nope')), /nope/);
    let got = /** @type {any} */ (null);
    e.on('error', (/** @type {any} */ err) => { got = err; });
    assert.equal(e.emit('error', new Error('ok')), true);
    assert.equal(got && got.message, 'ok');
});

test('listenerCount counts glob matches; dispose clears everything', () => {
    const e = /** @type {any} */ (new MerciEventEmitter());
    e.on('run:*', () => {});
    e.onAny(() => {});
    assert.equal(e.listenerCount('run:start'), 2);
    e[Symbol.dispose]();
    assert.equal(e.listenerCount('run:start'), 0);
    assert.equal(e.listenerCount(), 0);
});

test('emitEvent routes through emitSafe: glob dispatch + isolation', () => {
    const e = new MerciEventEmitter();
    /** @type {string[]} */
    const seen = [];
    /** @type {any[]} */
    const errors = [];
    e.on('run:*', () => { throw new Error('boom'); });
    e.on('run:*', (/** @type {any} */ p) => seen.push(p.event));
    e.on(EVENTS.ERRORS.LISTENER_ERROR, (/** @type {any} */ p) => errors.push(p));
    emitEvent({ emitter: e, name: 'run:start', payload: {} });
    assert.deepEqual(seen, ['run:start']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].sourceEvent, 'run:start');
});
