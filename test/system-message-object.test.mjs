// @ts-check
/**
 * `withSystemMessage({ content })` stored the object, so the system slot
 * rendered "[object Object]". The documented forms are a string or a split
 * array; an object wrapper is accepted for both, and any other shape is a
 * configuration error instead of silent garbage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const makeSession = () => /** @type {any} */ (new AbstractChatSession({
    provider: ProviderType.OPENAI,
    model: 'm',
    eventEmitter: new EventEmitter(),
    client: /** @type {any} */ ({}),
}));

test('an object wrapper around a string behaves like the string', () => {
    const session = makeSession();
    session.withSystemMessage({ content: 'be helpful' });
    assert.equal(session._userSystemMessage, 'be helpful');
    assert.equal(session._userSystemBlocks, null);
});

test('an object wrapper around a split array behaves like the array', () => {
    const session = makeSession();
    session.withSystemMessage({ content: [{ text: 'role', cache: true }, { text: 'adapt', cache: false }] });
    assert.deepEqual(session._userSystemBlocks, [{ text: 'role' }, { text: 'adapt', cache: false }]);
    assert.equal(session._userSystemMessage, null);
});

test('a null wrapper behaves like a bare null', () => {
    const session = makeSession();
    session.withSystemMessage({ content: null });
    assert.equal(session._userSystemMessage, null);
    assert.equal(session._userSystemBlocks, null);
});

test('a plain string and a plain array still work', () => {
    const session = makeSession();
    session.withSystemMessage('plain');
    assert.equal(session._userSystemMessage, 'plain');
    session.withSystemMessage([{ text: 'block' }]);
    assert.deepEqual(session._userSystemBlocks, [{ text: 'block' }]);
});

test('an object that is neither a string nor a block list is a ConfigurationError', () => {
    const session = makeSession();
    assert.throws(() => session.withSystemMessage({ content: 42 }), ConfigurationError);
    assert.throws(() => session.withSystemMessage({ content: [{ nope: true }] }), ConfigurationError);
    assert.throws(() => session.withSystemMessage({ foo: 'bar' }), ConfigurationError);
    assert.equal(session._userSystemMessage ?? null, null, 'nothing was stored');
});
