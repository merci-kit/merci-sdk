// @ts-check

/**
 * @file The shared validation primitives, the closed-options reader, and the
 * guarded process/abort checks keep the exact contracts their call sites rely on.
 * @version 0.12.0
 *
 * @description
 * These helpers replaced local copies in the scheduler, the workflow policy, the
 * backends and the memory providers. The three object predicates differ only in
 * the case that matters (arrays, prototypes), so each one is pinned here: a
 * later "cleanup" that merges them would change what a config section or a
 * record may be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigurationError, configurationError, isAbortErrorSafe } from '../lib/core/errors.mjs';
import { readClosedOptions } from '../lib/support/options.mjs';
import { isProcessAlive } from '../lib/support/utils.mjs';
import { assertNonEmptyString, isObjectLike, isPlainObject, isRecordObject } from '../lib/support/validation.mjs';

test('isObjectLike includes arrays; isRecordObject excludes them', () => {
    assert.equal(isObjectLike([]), true);
    assert.equal(isObjectLike({}), true);
    assert.equal(isObjectLike(Object.create(null)), true);
    assert.equal(isObjectLike(null), false);
    assert.equal(isObjectLike('text'), false);
    assert.equal(isObjectLike(undefined), false);

    assert.equal(isRecordObject([]), false);
    assert.equal(isRecordObject(null), false);
    assert.equal(isRecordObject({}), true);
    assert.equal(isRecordObject(Object.create(null)), true);
    assert.equal(isRecordObject('text'), false);
});

test('isPlainObject excludes a class instance and keeps a null-prototype record', () => {
    class Holder {
        constructor() {
            this.value = 1;
        }
    }
    assert.equal(isPlainObject(new Holder()), false);
    assert.equal(isPlainObject(Object.create(null)), true);
    assert.equal(isPlainObject({ value: 1 }), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
});

test('assertNonEmptyString names the empty value it refused', () => {
    assert.doesNotThrow(() => assertNonEmptyString({ value: 'owner-1', name: 'owner' }));
    for (const value of ['', '   ', null, undefined, 7]) {
        assert.throws(
            () => assertNonEmptyString({ value, name: 'owner' }),
            (/** @type {any} */ err) => err instanceof ConfigurationError
                && err.message === 'owner must be a non-empty string.'
                && err.option === 'owner'
        );
    }
});

test('readClosedOptions keeps the caller default on null and refuses a bad shape', () => {
    const allowed = ['a', 'b'];
    assert.equal(readClosedOptions({ value: null, allowed, name: 'thing' }), null);
    assert.equal(readClosedOptions({ value: undefined, allowed, name: 'thing' }), null);

    assert.throws(
        () => readClosedOptions({ value: [], allowed, name: 'thing', label: 'options.thing' }),
        (/** @type {any} */ err) => err instanceof ConfigurationError
            && err.message === 'options.thing must be an object.'
            && err.option === 'thing'
    );
    assert.throws(
        () => readClosedOptions({ value: 'text', allowed, name: 'thing' }),
        /^ConfigurationError: thing must be an object\.$/
    );
});

test('readClosedOptions lists the supported keys and returns the same reference', () => {
    const allowed = ['a', 'b'];
    assert.throws(
        () => readClosedOptions({ value: { a: 1, bogus: 2 }, allowed, name: 'thing' }),
        (/** @type {any} */ err) => err.message === "Unknown thing key 'bogus'. Supported: a, b."
            && err.option === 'thing'
    );
    const value = { a: 1, b: 2 };
    assert.equal(readClosedOptions({ value, allowed, name: 'thing' }), value);
});

test('configurationError carries the option and a ConfigurationError type', () => {
    const error = configurationError({ option: 'model', message: 'a model is required.' });
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.message, 'a model is required.');
    assert.equal(error.option, 'model');
});

test('isAbortErrorSafe reads an abort shape true and a hostile getter false', () => {
    assert.equal(isAbortErrorSafe({ error: Object.assign(new Error('stop'), { name: 'AbortError' }) }), true);
    assert.equal(isAbortErrorSafe({ error: new Error('boom') }), false);
    const hostile = /** @type {any} */ ({
        get name() { throw new Error('boom'); },
        get code() { throw new Error('boom'); }
    });
    assert.equal(isAbortErrorSafe({ error: hostile }), false);
});

test('isProcessAlive reads this process as alive and ESRCH as dead', () => {
    assert.equal(isProcessAlive({ pid: process.pid }), true);
    // A real dead pid is environment-dependent (pids get reused), so the two
    // branches of the contract are exercised through the syscall error instead.
    const realKill = process.kill;
    /** @param {number} pid @param {string|number} signal */
    const stub = (pid, signal) => {
        throw Object.assign(new Error('probe'), { code: 'ESRCH' });
    };
    try {
        process.kill = /** @type {any} */ (stub);
        assert.equal(isProcessAlive({ pid: 4_000_000 }), false);
        process.kill = /** @type {any} */ (/** @param {number} pid @param {string|number} signal */ (pid, signal) => {
            throw Object.assign(new Error('probe'), { code: 'EPERM' });
        });
        assert.equal(isProcessAlive({ pid: 1 }), true);
    } finally {
        process.kill = realKill;
    }
});
