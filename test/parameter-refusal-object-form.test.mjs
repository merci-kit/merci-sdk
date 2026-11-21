// @ts-check
/**
 * @file Object-form `withParameters` keeps the refusal list, and the web
 * capability's forced tool choice reaches the wire.
 * @version 0.22.0
 *
 * @description
 * The fluent builder refuses an unsupported method with a `parameter_warning`
 * and keeps it off the wire. The object form of `withParameters` must behave
 * the same way (it used to drop the key silently), and
 * `withWebSearch({ force: true })` in tool mode must put a real `tool_choice`
 * on the wire instead of a key the translator ignores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as GaiChatSession } from '../lib/backends/gai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { InternalHttpClient } from '../lib/backends/jai-vendor/http-client.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @type {any} */
const stubProfileManager = { getProfile() { return null; }, isSupported() { return true; } };

class MinimalSession extends AbstractChatSession {
    /**
     * @param {string} provider
     * @param {string} model
     * @param {import('node:events').EventEmitter} emitter
     */
    constructor(provider, model, emitter) {
        super({ provider, model, eventEmitter: emitter, client: {} });
    }
}

/**
 * Builds a bare session (no vendor call is made) for one standard.
 * @param {{provider: string, model: string}} arg0
 * @returns {{session: any, warnings: Array<any>}}
 */
function sessionFor({ provider, model }) {
    const emitter = new EventEmitter();
    /** @type {Array<any>} */
    const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warnings.push(e));
    const Session = provider === ProviderType.ANTHROPIC
        ? AaiChatSession
        : (provider === ProviderType.GOOGLE_GENAI ? GaiChatSession : OaiChatSession);
    const session = new Session({ client: {}, model, eventEmitter: emitter, provider });
    return { session, warnings };
}

test('object-form refused parameter warns once and stays off the wire', () => {
    const cases = /** @type {Array<{provider: string, model: string, key: string, value: unknown, wireKeys: Array<string>}>} */ ([
        { provider: ProviderType.OPENAI, model: 'gpt-4o-mini', key: 'topK', value: 40, wireKeys: ['top_k', 'topK'] },
        { provider: ProviderType.ANTHROPIC, model: 'claude-sonnet-4', key: 'seed', value: 7, wireKeys: ['seed'] },
        { provider: ProviderType.GOOGLE_GENAI, model: 'gemini-2.5-flash', key: 'serviceTier', value: 'priority', wireKeys: ['serviceTier', 'service_tier'] },
    ]);
    for (const { provider, model, key, value, wireKeys } of cases) {
        const { session, warnings } = sessionFor({ provider, model });
        session.withParameters({ params: { [key]: value, temperature: 0.5 } });

        assert.equal(warnings.filter((w) => w.parameter === key).length, 1, `${provider}: exactly one warning for ${key}`);
        assert.match(warnings.find((w) => w.parameter === key).message, new RegExp(key));
        assert.equal(session._parameters.temperature, 0.5, `${provider}: a supported key still lands`);
        for (const wireKey of wireKeys) {
            assert.equal(session._parameters[wireKey], undefined, `${provider}: ${key} never reaches the wire`);
        }
    }
});

test('a refused key warns in the JAI object form too', () => {
    const emitter = new EventEmitter();
    /** @type {Array<any>} */
    const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warnings.push(e));
    const session = new JaiChatSession({
        httpClient: new InternalHttpClient({ options: { token: 'test-token' }, eventEmitter: emitter }),
        profile: 'jai-gpt-4o',
        eventEmitter: emitter,
        profileManager: stubProfileManager,
    });
    session.withParameters({ params: { serviceTier: 'priority', temperature: 0.5 } });

    assert.equal(warnings.filter((w) => w.parameter === 'serviceTier').length, 1, 'the JAI override warns like the builder does');
    assert.equal((session._parameters ?? {}).temperature, 0.5);
});

test('a refused key warns in the abstract builder object form too', () => {
    const emitter = new EventEmitter();
    /** @type {Array<any>} */
    const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warnings.push(e));
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', emitter);
    session.withParameters({ params: { topK: 40, temperature: 0.5 } });

    assert.equal(warnings.filter((w) => w.parameter === 'topK').length, 1);
    assert.equal((session._parameters ?? {}).topK, 40, 'the abstract builder has no translator; it stores what it is given');
    assert.equal((session._parameters ?? {}).temperature, 0.5);
});

test('an undefined value does not warn as a refused key', () => {
    const source = /** @type {{topK?: number}} */ ({ topK: undefined });
    assert.equal('topK' in source, true, 'the fixture must carry the key');
    const { session, warnings } = sessionFor({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini' });
    session.withParameters({ params: { ...source, temperature: 0.5 } });

    assert.equal(warnings.length, 0, 'a spread that leaves the key undefined is not a refusal');
});

test('withWebSearch({force}) reaches the GAI and Anthropic wires', () => {
    const gaiEmitter = new EventEmitter();
    const gai = new GaiChatSession({ client: {}, model: 'gemini-2.5-flash', eventEmitter: gaiEmitter, provider: ProviderType.GOOGLE_GENAI });
    gai.withWebSearch({ options: { mode: 'tavily', force: true, tavily: { apiKey: 'k' } } });
    const gaiWire = /** @type {any} */ (gaiAdapter).buildVendorRequest({
        model: 'gemini-2.5-flash',
        parameters: gai._parameters,
        tools: gai._tools,
        preparedMessages: [{ role: 'user', parts: [{ text: 'hi' }] }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: gai,
    });
    assert.deepEqual(gaiWire.request.config.toolConfig, {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['web_search'] },
    }, 'Gemini forces the named function');

    const aaiEmitter = new EventEmitter();
    const aai = new AaiChatSession({ client: {}, model: 'claude-sonnet-4', eventEmitter: aaiEmitter });
    aai.withWebSearch({ options: { mode: 'tavily', force: true, tavily: { apiKey: 'k' } } });
    const aaiWire = /** @type {any} */ (aaiAdapter).buildVendorRequest({
        model: 'claude-sonnet-4',
        parameters: aai._parameters,
        tools: [],
        preparedMessages: [{ type: 'user_message', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: aai,
    });
    assert.deepEqual(aaiWire.request.tool_choice, { type: 'tool', name: 'web_search' }, 'Anthropic names the tool');
});

test('withWebSearch({force}) puts tool_choice on the wire in tool mode', async () => {
    /** @type {Array<any>} */
    const bodies = [];
    const client = {
        chat: {
            completions: {
                /** @param {any} body */
                create: async (body) => {
                    bodies.push(body);
                    return (async function* () {
                        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
                    })();
                },
            },
        },
    };
    const emitter = new EventEmitter();
    const session = new OaiChatSession({ client, model: 'gpt-4o-mini', eventEmitter: emitter, provider: ProviderType.OPENAI });
    session.withWebSearch({ options: { force: true } });

    assert.deepEqual((session._parameters ?? {}).tool_choice, { type: 'function', function: { name: 'web_search' } },
        'the session parameter is the OpenAI tool_choice shape');

    const gen = session.step({ messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'latest news?' })] });
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    const wire = bodies[0]?.tool_choice;
    assert.ok(wire, 'tool_choice reaches the request body');
    assert.equal(wire.name ?? wire.function?.name, 'web_search');
});
