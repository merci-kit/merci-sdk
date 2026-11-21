// @ts-check


/**
 * @file The one approval-input normalizer shared by the runner, the facade, and
 * the workspace binder.
 * @version 0.12.0
 *
 * @description
 * `withApproval({ fn, options })` is the documented builder shape, but three
 * modules accept an approval at their own boundary. They must agree, or the
 * same host callback silently fails to reach one of the gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeApproval } from '../lib/agentic/approval.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

test('a bare function is the callback', () => {
    /** @type {() => boolean} */
    const callback = () => true;
    assert.deepEqual(normalizeApproval({ value: callback }), { callback });
});

test('{ callback } keeps the callback', () => {
    /** @type {() => boolean} */
    const callback = () => true;
    assert.deepEqual(normalizeApproval({ value: { callback } }), { callback });
});

test('{ fn } keeps the callback', () => {
    /** @type {() => boolean} */
    const fn = () => true;
    assert.deepEqual(normalizeApproval({ value: { fn } }), { callback: fn });
});

test('{ callback, timeoutMs } keeps the flat timeout', () => {
    /** @type {() => boolean} */
    const callback = () => true;
    assert.deepEqual(
        normalizeApproval({ value: { callback, timeoutMs: 99 } }),
        { callback, timeoutMs: 99 }
    );
});

test('{ fn, options: { timeoutMs } } unwraps the documented builder shape', () => {
    /** @type {() => boolean} */
    const fn = () => true;
    assert.deepEqual(
        normalizeApproval({ value: { fn, options: { timeoutMs: 250 } } }),
        { callback: fn, timeoutMs: 250 }
    );
});

test('a flat timeout is accepted on the { fn } shape too', () => {
    /** @type {() => boolean} */
    const fn = () => true;
    assert.deepEqual(
        normalizeApproval({ value: { fn, timeoutMs: 42 } }),
        { callback: fn, timeoutMs: 42 }
    );
});

test('null and undefined disable the gate', () => {
    assert.equal(normalizeApproval({ value: null }), null);
    assert.equal(normalizeApproval({ value: undefined }), null);
});

test('anything without a usable callback is refused', () => {
    for (const value of [{}, { callback: 'x' }, 42]) {
        assert.throws(
            () => normalizeApproval({ value }),
            (error) => error instanceof ConfigurationError && error.option === 'invalid_approval',
            `expected invalid_approval for ${JSON.stringify(value)}`
        );
    }
});

test('a hostile getter is refused instead of escaping as a raw throw', () => {
    const value = {
        get callback() {
            throw new Error('boom');
        }
    };
    assert.throws(
        () => normalizeApproval({ value }),
        (error) => error instanceof ConfigurationError && error.option === 'invalid_approval'
    );
});

test('a custom origin keeps the caller wording', () => {
    assert.throws(
        () => normalizeApproval({ value: 42, origin: 'createOrchestration' }),
        (error) => error instanceof ConfigurationError && /^createOrchestration: /.test(error.message)
    );
});

test('a custom option label is kept for published error compatibility', () => {
    assert.throws(
        () => normalizeApproval({ value: {}, origin: 'createOrchestration', option: 'approval' }),
        (error) => error instanceof ConfigurationError && error.option === 'approval'
    );
});
