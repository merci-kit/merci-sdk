// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} client */
    constructor(provider, model, eventEmitter, client) {
        super({ provider, model, eventEmitter, client });
    }
}

/** @returns {MinimalSession} */
function makeSession() {
    return new MinimalSession('openai', 'm', new EventEmitter(), {});
}

/** @param {any[]} out */
const flat = (out) => out.map((m) => String(m?.content ?? '')).join('\n');

test('no processors leaves the default assembly unchanged', async () => {
    const out = await makeSession()._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    assert.equal(out.length, 1);
    assert.equal(String(out[0].content), 'hi');
});

test('context processors run in order and inject blocks', async () => {
    const s = makeSession();
    const seen = /** @type {string[]} */ ([]);
    s.withContextProcessor({ name: 'a', order: 2, process: async (/** @type {any} */ { contextParts }) => { seen.push('a'); return { contextParts: [...contextParts, 'BLOCK-A'] }; } });
    s.withContextProcessor({ name: 'b', order: 1, process: async (/** @type {any} */ { contextParts }) => { seen.push('b'); return { contextParts: [...contextParts, 'BLOCK-B'] }; } });
    const text = flat(await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} }));
    assert.deepEqual(seen, ['b', 'a'], 'ascending order');
    assert.ok(text.indexOf('BLOCK-B') < text.indexOf('BLOCK-A'), 'later order renders later');
});

test('a context processor can add messages', async () => {
    const s = makeSession();
    s.withContextProcessor({ process: async (/** @type {any} */ { messages }) => ({ messages: [...messages, { role: 'user', content: 'INJECTED-ROW' }] }) });
    const out = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    assert.ok(out.some((m) => String(m.content).includes('INJECTED-ROW')));
});

test('withContextProcessor rejects a non-function processor', () => {
    assert.throws(() => makeSession().withContextProcessor({ process: /** @type {any} */ (null) }), /process must be a function/);
});

test('a processor exception propagates (fail-loud)', async () => {
    const s = makeSession();
    s.withContextProcessor({ process: async () => { throw new Error('processor-boom'); } });
    await assert.rejects(() => s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} }), /processor-boom/);
});
