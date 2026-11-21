// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as GaiChatSession } from '../lib/backends/gai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { DEFAULT_SYSTEM_PROMPT } from '../lib/core/constants/index.mjs';

const stubClient = {};
const stubEmitter = new EventEmitter();

/** @type {Array<{ name: string, Ctor: new (...args: any[]) => any, args: any }>} */
const cases = [
    { name: 'OAI', Ctor: OaiChatSession, args: { client: stubClient, model: 'gpt-4o-mini', eventEmitter: stubEmitter } },
    { name: 'AAI', Ctor: AaiChatSession, args: { client: stubClient, model: 'claude-3-5-sonnet-20241022', eventEmitter: stubEmitter } },
    { name: 'GAI', Ctor: GaiChatSession, args: { client: stubClient, model: 'gemini-2.0-flash', eventEmitter: stubEmitter } },
    { name: 'JAI', Ctor: JaiChatSession, args: { httpClient: stubClient, profile: 'jai-gpt-4o', eventEmitter: stubEmitter, profileManager: stubClient } }
];

for (const { name, Ctor, args } of cases) {
    test(`${name}: getSystemMessage() is null by default (no SDK descriptor, no capabilities)`, () => {
        const session = new Ctor(args);
        assert.equal(session.getSystemMessage(), null);
    });

    test(`${name}: withSystemMessage() stores in _userSystemMessage`, () => {
        const session = new Ctor(args);
        session.withSystemMessage('You are a helpful assistant.');
        // ponytail: user system content goes to _userSystemMessage, not getSystemMessage
        assert.equal(session._userSystemMessage, 'You are a helpful assistant.');
        assert.equal(session.getSystemMessage(), null);
    });

    test(`${name}: withSystemMessage() returns the session for chaining`, () => {
        const session = new Ctor(args);
        const result = session.withSystemMessage('content');
        assert.equal(result, session);
    });

    test(`${name}: subsequent withSystemMessage() calls overwrite the previous content`, () => {
        const session = new Ctor(args);
        session.withSystemMessage('first');
        session.withSystemMessage('second');
        assert.equal(session._userSystemMessage, 'second');
    });

    test(`${name}: getSystemMessage() returns null after withSystemMessage(null)`, () => {
        const session = new Ctor(args);
        session.withSystemMessage('content');
        session.withSystemMessage(null);
        assert.equal(session._userSystemMessage, null);
    });
}

// ── withSDKDescriptorMessage semantics ───────────────────────────────────────
test('withSDKDescriptorMessage() (no argument) injects DEFAULT_SYSTEM_PROMPT once', () => {
    const session = new OaiChatSession({ client: stubClient, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    session.withSDKDescriptorMessage();
    assert.equal(session.getSystemMessage(), DEFAULT_SYSTEM_PROMPT);
    session.withSDKDescriptorMessage();
    assert.equal(session.getSystemMessage(), DEFAULT_SYSTEM_PROMPT);
});

test('withSDKDescriptorMessage(content) injects a user-provided descriptor', () => {
    const session = new OaiChatSession({ client: stubClient, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    session.withSDKDescriptorMessage({ args: ['CUSTOM DESCRIPTOR'] });
    assert.equal(session.getSystemMessage(), 'CUSTOM DESCRIPTOR');
});

test('withSDKDescriptorMessage(null|undefined|\'\') is a loud no-op (descriptor cleared)', () => {
    for (const empty of [null, undefined, '']) {
        const emitter = new EventEmitter();
        const warnings = /** @type {any[]} */ ([]);
        emitter.on('parameter_warning', (e) => warnings.push(e));
        const session = new OaiChatSession({ client: stubClient, model: 'gpt-4o-mini', eventEmitter: emitter });
        session.withSDKDescriptorMessage({ args: ['first'] });
        session.withSDKDescriptorMessage({ args: [empty] });
        assert.equal(session.getSystemMessage(), null, `empty value (${String(empty)}) clears the descriptor`);
        assert.equal(warnings.length, 1, `empty value (${String(empty)}) surfaces a parameter_warning`);
        assert.equal(warnings[0].parameter, 'withSDKDescriptorMessage');
        assert.equal(warnings[0].standard, 'oai');
    }
});

const nonMessagesBackends = ['OAI', 'AAI', 'GAI'];
for (const name of nonMessagesBackends) {
    const { Ctor, args } = (/** @type {any} */ (cases.find(c => c.name === name)));
    test(`${name}: withSystemMessage() does not push into this.messages`, () => {
        const session = new Ctor(args);
        session.withSystemMessage('You are a helpful assistant.');
        assert.equal(session.messages, undefined,
            `${name}: session.messages must be undefined post-Leftover 4 (no per-session history storage)`);
    });
}

test('OAI: user-provided SDK descriptor is prepended; system slot is descriptor-first, single row', async () => {
    const { Ctor, args } = (/** @type {any} */ (cases.find(c => c.name === 'OAI')));
    const session = new Ctor(args);
    session.withSDKDescriptorMessage({ args: ['SDK-BASE'] });
    session.withSystemMessage('USER-SYS');
    assert.equal(session.getSystemMessage(), 'SDK-BASE');
    const out = await session._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }] });
    const systems = out.filter(
        (/** @type {any} */ m) => m.type === 'system_message' || m.role === 'system' || m.role === 'developer');
    assert.equal(systems.length, 1);
    assert.ok(systems[0].content.includes('SDK-BASE'));
    assert.ok(systems[0].content.includes('USER-SYS'));
    assert.ok(systems[0].content.indexOf('SDK-BASE') < systems[0].content.indexOf('USER-SYS'));
});

test('OAI: capability announces survive withSDKDescriptorMessage in either call order', () => {
    for (const order of ['override-first', 'announce-first']) {
        const { Ctor, args } = (/** @type {any} */ (cases.find(c => c.name === 'OAI')));
        const session = new Ctor(args);
        if (order === 'override-first') {
            session.withSDKDescriptorMessage({ args: ['SDK-BASE'] });
            session._announceCapability({ capId: 'test-cap', announceOverride: 'ANNOUNCE-X' });
        } else {
            session._announceCapability({ capId: 'test-cap', announceOverride: 'ANNOUNCE-X' });
            session.withSDKDescriptorMessage({ args: ['SDK-BASE'] });
        }
        const sys = session.getSystemMessage();
        assert.ok(sys.includes('SDK-BASE'), `${order}: descriptor survives`);
        assert.ok(sys.includes('ANNOUNCE-X'), `${order}: announce survives`);
        assert.ok(sys.indexOf('SDK-BASE') < sys.indexOf('ANNOUNCE-X'), `${order}: SDK-first`);
    }
});
