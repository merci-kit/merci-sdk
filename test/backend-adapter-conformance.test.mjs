// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import {
    ProviderType,
    XML_TOOL_CALL_TAGS
} from '../lib/core/constants/index.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import {
    createUserMessage,
    createSystemMessage,
    createAssistantMessage,
    createToolCallMessage,
    createToolResultMessage,
    normalizeToOAI,
    normalizeToAAI,
    normalizeToGAI,
    normalizeHistory
} from '../lib/messaging/messages.mjs';
import { createUnifiedMediaMessages } from '../lib/backends/media.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as GaiChatSession } from '../lib/backends/gai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { ChatSession as JaiClientChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';
import {
    UnifiedParameterBuilder,
    buildParameterMapForOai,
    buildParameterMapForAai,
    buildParameterMapForGai,
    buildParameterMapForJai
} from '../lib/messaging/unified-parameter.mjs';

const BACKEND_ADAPTER_FILES = Object.freeze({
    [ProviderType.JAI]: './jai.mjs',
    [ProviderType.OPENAI]: './oai.mjs',
    [ProviderType.ANTHROPIC]: './aai.mjs',
    [ProviderType.GOOGLE_GENAI]: './gai.mjs'
});

const PARAMETER_BUILDER_ADAPTERS = {
    [ProviderType.OPENAI]: { provider: ProviderType.OPENAI, translate: buildParameterMapForOai },
    [ProviderType.ANTHROPIC]: { provider: ProviderType.ANTHROPIC, translate: buildParameterMapForAai },
    [ProviderType.GOOGLE_GENAI]: { provider: ProviderType.GOOGLE_GENAI, translate: buildParameterMapForGai },
    [ProviderType.JAI]: { provider: ProviderType.JAI, translate: buildParameterMapForJai }
};

const ALL_BACKENDS = [
    /** @param {{text: *}} arg0 */
    { name: 'OPENAI', type: ProviderType.OPENAI, file: BACKEND_ADAPTER_FILES[ProviderType.OPENAI], ChatSession: OaiChatSession, adapter: oaiAdapter, extractFn: /** @type {(arg0: {text: any}) => any} */ (({ text }) => (/** @type {any} */ (oaiAdapter)).extractXmlToolCalls({ text })) },
    /** @param {{text: *}} arg0 */
    { name: 'ANTHROPIC', type: ProviderType.ANTHROPIC, file: BACKEND_ADAPTER_FILES[ProviderType.ANTHROPIC], ChatSession: AaiChatSession, adapter: aaiAdapter, extractFn: /** @type {(arg0: {text: any}) => any} */ (({ text }) => (/** @type {any} */ (aaiAdapter)).extractXmlToolCalls({ text })) },
    /** @param {{text: *}} arg0 */
    { name: 'GOOGLE_GENAI', type: ProviderType.GOOGLE_GENAI, file: BACKEND_ADAPTER_FILES[ProviderType.GOOGLE_GENAI], ChatSession: GaiChatSession, adapter: gaiAdapter, extractFn: /** @type {(arg0: {text: any}) => any} */ (({ text }) => (/** @type {any} */ (gaiAdapter)).extractXmlToolCalls({ text })) },
    /** @param {{text: *}} arg0 */
    { name: 'JAI', type: ProviderType.JAI, file: BACKEND_ADAPTER_FILES[ProviderType.JAI], ChatSession: JaiChatSession, adapter: jaiAdapter, extractFn: /** @type {(arg0: {text: any}) => any} */ (({ text }) => (/** @type {any} */ (jaiAdapter)).extractXmlToolCalls({ text })) }
];

function makeStubClient() {
    return {
        chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } },
        messages: { stream: () => (async function* () {})() },
        models: { generateContentStream: async () => (async function* () {})() }
    };
}

function makeStubJaiHttpClient() {
    return {
        streamTimeout: 150_000,
        getEventEmitter: () => null,
        _fetchWithRetry: async () => ({ body: { pipeThrough: () => ({ getReader: () => ({ read: async () => ({ done: true }) }) }) } })
    };
}

/** @param {{provider: any, emitter?: any}} arg0 */
function makeSession({ provider, emitter = new EventEmitter() }) {
    switch (provider.name) {
        case 'JAI':
            return new provider.ChatSession({ httpClient: makeStubJaiHttpClient(), profile: 'test-model', eventEmitter: emitter, profileManager: null });
        default:
            return new provider.ChatSession({ client: makeStubClient(), model: 'test-model', eventEmitter: emitter });
    }
}

describe('BackendAdapter — registry', () => {
    it('BACKEND_ADAPTER_FILES covers exactly the four core backends (by ProviderType value)', () => {
        assert.deepEqual(
            Object.keys(BACKEND_ADAPTER_FILES).sort(),
            [ProviderType.ANTHROPIC, ProviderType.GOOGLE_GENAI, ProviderType.JAI, ProviderType.OPENAI].sort()
        );
    });

    it('BACKEND_ADAPTER_FILES entries point at real files (relative paths)', () => {
        for (const [provider, relPath] of Object.entries(BACKEND_ADAPTER_FILES)) {
            assert.equal(typeof relPath, 'string', `${provider} path is a string`);
            assert.ok(relPath.startsWith('./'), `${provider} path is relative ('./...')`);
            assert.ok(relPath.endsWith('.mjs'), `${provider} path ends in .mjs`);
        }
    });
});

describe('ChatSessionAdapter — inheritance & public surface', () => {
    for (const b of ALL_BACKENDS) {
        describe(`${b.name} ChatSession`, () => {
            it(`is a subclass of AbstractChatSession`, () => {
                assert.ok(b.ChatSession.prototype instanceof AbstractChatSession,
                    `${b.name}.ChatSession should extend AbstractChatSession`);
            });

            it(`exposes 'provider' as a public field with the expected value`, () => {
                const session = makeSession({ provider: b });
                assert.equal(session.provider, b.type);
            });

            it(`exposes 'model' as a public field`, () => {
                const session = makeSession({ provider: b });
                assert.equal(session.model, 'test-model');
            });

            it(`exposes 'eventEmitter' as a public field`, () => {
                const emitter = new EventEmitter();
                const session = makeSession({ provider: b, emitter });
                assert.strictEqual(session.eventEmitter, emitter);
            });

            it(`exposes 'client' as a public field`, () => {
                const session = makeSession({ provider: b });
                if (b.name === 'JAI') {
                    assert.ok(session.client, `${b.name}.client should be set`);
                } else {
                    assert.ok(session.client, `${b.name}.client should be set`);
                }
            });

            it(`'step' is an AsyncGenerator function (not a regular function)`, () => {
                assert.equal(typeof b.ChatSession.prototype.step, 'function');
                const gen = /** @type {any} */ (b.ChatSession.prototype.step.call(
                    { _systemMessage: null, _tools: [], _parameters: {}, _memoryManager: null, _memoryClient: null, provider: b.type, model: 'm', eventEmitter: new EventEmitter(), client: makeStubClient(), getSystemMessage: () => null },
                    /** @type {any} */ ([])
                ));
                assert.ok(typeof gen[Symbol.asyncIterator] === 'function', `${b.name}.step should be an async generator`);
                gen.return?.();
            });

            it(`'run' is an async function`, () => {
                assert.equal(typeof b.ChatSession.prototype.run, 'function');
            });

            it(`'withSystemMessage' returns the session (fluent)`, () => {
                const session = makeSession({ provider: b });
                assert.strictEqual(session.withSystemMessage('hi'), session);
                assert.equal(session._userSystemMessage, 'hi');
                // ponytail: getSystemMessage now returns only lib system, not user directive
            });

            it(`'withTools' returns the session (fluent)`, () => {
                const session = makeSession({ provider: b });
                assert.strictEqual(session.withTools({ tools: [{ name: 't' }] }), session);
                assert.deepEqual(session._tools.map((/** @type {any} */ t) => t.name), ['t']);
            });

            it(`'withParameters' is a function (function or object form)`, () => {
                const session = makeSession({ provider: b });
                assert.equal(typeof session.withParameters, 'function');
                assert.doesNotThrow(() => session.withParameters({ params: { temperature: 0.5 } }));
            });

            it(`'withMemory' is a function (inherited from base)`, () => {
                const session = makeSession({ provider: b });
                assert.equal(typeof session.withMemory, 'function');
            });

            it(`'withSkills' is a function (inherited from base)`, () => {
                const session = makeSession({ provider: b });
                assert.equal(typeof session.withSkills, 'function');
            });
        });
    }
});

describe('ChatSessionAdapter — vendor request surface', () => {
    // ponytail: the conformance matrix never exercised the vendor-request
    for (const b of ALL_BACKENDS) {
        it(`${b.name} adapter exposes buildVendorRequest and executeVendorRequest`, () => {
            assert.equal(typeof /** @type {any} */ (b.adapter)?.buildVendorRequest, 'function', `${b.name}.buildVendorRequest`);
            assert.equal(typeof /** @type {any} */ (b.adapter)?.executeVendorRequest, 'function', `${b.name}.executeVendorRequest`);
        });
    }

    it('OAI/AAI/GAI share the common buildVendorRequest contract (arity)', () => {
        const common = ALL_BACKENDS.filter((b) => b.name !== 'JAI');
        const arities = common.map((b) => /** @type {any} */ (b.adapter).buildVendorRequest.length);
        assert.ok(arities.every((a) => a === arities[0]), `common-contract adapters must keep the same arity, got ${arities}`);
    });

    it('JAI buildVendorRequest keeps its documented divergent contract (INTENTIONAL-DIVERGENCE)', () => {
        const fn = /** @type {any} */ (ALL_BACKENDS.find((b) => b.name === 'JAI')?.adapter)?.buildVendorRequest;
        assert.equal(typeof fn, 'function');
    });
});

describe('ChatSessionAdapter — vendor request wire execution', () => {
    /** @param {{events: any}} arg0 */
    /** @param {{events: *}} arg0 */
    const feed = ({ events }) => (async function* () { for (const e of events) yield e; })();

    function makeRecordingOaiClient() {
        /** @type {{ chat: any[], responses: any[] }} */
        const calls = { chat: [], responses: [] };
        return {
            calls,
            chat: {
                completions: {
                    create: async (/** @type {any} */ body, /** @type {any} */ opts) => {
                        calls.chat.push({ body, opts });
                        return feed({ events: [] });
                    }
                }
            },
            responses: {
                create: async (/** @type {any} */ body, /** @type {any} */ opts) => {
                    calls.responses.push({ body, opts });
                    return feed({ events: [] });
                }
            }
        };
    }

    it('OAI: chat-completions request (no protocol marker) routes to chat.completions with the stream_options default', async () => {
        const vc = makeRecordingOaiClient();
        const { request } = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
            model: 'gpt-4o', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'hi' }],
            session: { protocol: 'completions' }
        });
        assert.equal(request.__merciProtocol, undefined, 'the completions wire carries no protocol marker');
        await (/** @type {any} */ (oaiAdapter)).executeVendorRequest({ vendorClient: vc, request, signal: undefined, session: {} });
        assert.equal(vc.calls.chat.length, 1);
        assert.equal(vc.calls.responses.length, 0, 'a markerless request must NOT hit the Responses endpoint');
        const body = vc.calls.chat[0].body;
        assert.equal(body.model, 'gpt-4o');
        assert.equal(body.stream, true);
        assert.deepEqual(body.stream_options, { include_usage: true }, 'the usage-bearing stream_options default is injected at execution time');
        assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    });

    it('OAI: responses-protocol request (__merciProtocol) routes to responses.create and strips the marker', async () => {
        const vc = makeRecordingOaiClient();
        const { request } = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
            model: 'gpt-4o', parameters: {}, tools: [],
            preparedMessages: [{ role: 'user', content: 'hi' }],
            session: { protocol: 'responses' }
        });
        assert.equal(request.__merciProtocol, 'responses', 'the builder marks the request for the executor');
        assert.ok(Array.isArray(request.input), 'the Responses request carries an input array');
        await (/** @type {any} */ (oaiAdapter)).executeVendorRequest({ vendorClient: vc, request, signal: undefined, session: {} });
        assert.equal(vc.calls.responses.length, 1);
        assert.equal(vc.calls.chat.length, 0, 'a Responses request must NOT hit chat.completions');
        const body = vc.calls.responses[0].body;
        assert.equal(body.model, 'gpt-4o');
        assert.equal(body.stream, true);
        assert.ok(Array.isArray(body.input) && body.input.length === 1, 'the input array reaches the vendor');
        assert.equal('__merciProtocol' in body, false, 'the internal marker must never reach the wire');
    });

    it('AAI: wire body carries model, default max_tokens, normalized messages and input_schema tools', async () => {
        /** @type {any} */ const captured = {};
        const vc = {
            messages: {
                stream: async (/** @type {any} */ body, /** @type {any} */ opts) => {
                    captured.body = body; captured.opts = opts;
                    return feed({ events: [] });
                }
            }
        };
        const { request } = (/** @type {any} */ (aaiAdapter)).buildVendorRequest({
            model: 'claude-sonnet-4',
            parameters: {},
            tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
            preparedMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
        });
        await (/** @type {any} */ (aaiAdapter)).executeVendorRequest({ vendorClient: vc, request, signal: undefined, session: {} });
        const body = captured.body;
        assert.equal(body.model, 'claude-sonnet-4');
        assert.equal(body.max_tokens, LIMITS.anthropic_max_tokens, 'max_tokens defaults to the effective Anthropic limit when unset');
        assert.equal(body.stream, true);
        assert.equal(body.system, 'sys', 'the system row is hoisted to the top-level system field');
        assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
        assert.deepEqual(body.tools, [{
            name: 'get_weather',
            description: 'Get weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } }
        }], 'session tool declarations map parameters → input_schema on the wire');
    });

    it('GAI: config mapping (generation keys, functionDeclarations) reaches generateContentStream', async () => {
        /** @type {any} */ const captured = {};
        const vc = {
            models: {
                generateContentStream: async (/** @type {any} */ params) => {
                    captured.params = params;
                    return feed({ events: [] });
                }
            }
        };
        const { request } = (/** @type {any} */ (gaiAdapter)).buildVendorRequest({
            model: 'gemini-2.0-flash',
            parameters: { temperature: 0.5, maxOutputTokens: 256 },
            tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
            preparedMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
        });
        await (/** @type {any} */ (gaiAdapter)).executeVendorRequest({ vendorClient: vc, request, signal: undefined, session: {} });
        const params = captured.params;
        assert.equal(params.model, 'gemini-2.0-flash');
        assert.equal(params.config.temperature, 0.5, 'generation keys sit directly on config (no nested generationConfig)');
        assert.equal(params.config.maxOutputTokens, 256);
        assert.equal(params.config.systemInstruction, 'sys');
        assert.ok(params.contents.some((/** @type {any} */ c) => c.role === 'user' && c.parts.some((/** @type {any} */ p) => p.text === 'hi')));
        assert.deepEqual(params.config.tools, [{
            functionDeclarations: [{
                name: 'get_weather',
                description: 'Get weather',
                parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } }
            }]
        }]);
    });

    it('JAI: request envelope reaches the http client and the first SSE chunk is replayed', async () => {
        /** @type {any} */ const captured = {};
        /** @param {{lines: any}} arg0 */
        /** @param {{lines: *}} arg0 */
        const sseBody = ({ lines }) => new ReadableStream({
            start(controller) {
                for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
                controller.close();
            }
        });
        const httpClient = {
            streamTimeout: 150_000,
            getEventEmitter: () => null,
            /** @param {{path: any, options: any}} arg0 */
            _fetchWithRetry: async ({ path, options }) => {
                captured.path = path;
                captured.opts = options;
                return new Response(sseBody({ lines: [
                    'data: {"type":"Content","content":"hello"}\n\n',
                    'data: {"type":"Content","content":"world"}\n\n'
                ] }), { status: 200 });
            }
        };
        const session = new JaiClientChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'test-model', profileManager: null });
        const { request } = (/** @type {any} */ (jaiAdapter)).buildVendorRequest({
            model: 'test-model',
            preparedMessages: [{ type: 'user_message', content: 'hi' }],
            isLastIteration: true,
            session,
            runContext: null
        });
        assert.equal(request.isLastIteration, true, 'the last-iteration flag is part of the request envelope');
        assert.strictEqual(request.session, session);
        const raw = await (/** @type {any} */ (jaiAdapter)).executeVendorRequest({ vendorClient: httpClient, request, signal: undefined, session: {} });
        assert.equal(captured.path, '/llm/chat/stream/v9', 'the chat protocol routes to the chat stream endpoint');
        assert.equal(captured.opts.method, 'POST');
        const body = JSON.parse(captured.opts.body);
        assert.equal(body.profile, 'test-model');
        assert.ok(String(body.prompt).startsWith('js-sdk-prompt-'), 'the js-sdk prompt marker rides the envelope');
        assert.ok(Array.isArray(body.chat.messages) && JSON.stringify(body.chat.messages).includes('hi'), 'the user turn reaches the chat envelope');
        const events = [];
        for await (const e of raw) events.push(e);
        assert.equal(events[0].type, 'text');
        assert.equal(events[0].content, 'hello', 'the chunk buffered at the factory call is replayed first');
        assert.deepEqual(events.map((/** @type {any} */ e) => e.content), ['hello', 'world'], 'the SSE feed is fully consumed and terminates');
    });
});

describe('ChatSessionAdapter — JAI transport layer (jai.client.mjs)', () => {
    it(`is a subclass of AbstractChatSession`, () => {
        assert.ok(JaiClientChatSession.prototype instanceof AbstractChatSession);
    });

    it(`exposes provider === 'jai'`, () => {
        const session = new JaiClientChatSession({ httpClient: /** @type {any} */ (makeStubJaiHttpClient()), profile: 'profile', profileManager: null });
        assert.equal(session.provider, ProviderType.JAI);
    });

    it(`exposes 'stream' as an async generator function (not 'step')`, () => {
        assert.equal(typeof JaiClientChatSession.prototype.stream, 'function');
        assert.equal(typeof JaiClientChatSession.prototype.step, 'function',
            'JAI transport layer should inherit the abstract step() from base class');
    });
});

describe('ChatSessionAdapter — shared Phase 7 helpers', () => {
    for (const b of ALL_BACKENDS) {
        const isSystemShape = (/** @type {any} */ m) =>
            m.type === 'system_message' || m.role === 'system' || m.role === 'developer';

        it(`${b.name}: _prepareStepMessages anchors exactly one system message`, async () => {
            const session = b.name === 'JAI'
                ? new (/** @type {any} */ (b.ChatSession))({ httpClient: makeStubClient(), profile: 'm', eventEmitter: new EventEmitter() })
                : new (/** @type {any} */ (b.ChatSession))({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter() });
            session.withSDKDescriptorMessage({ args: ['You are a test assistant.'] });

            for (const history of [
                [{ role: 'user', content: 'hi' }],
                [{ type: 'system_message', content: 'X' }, { role: 'user', content: 'hi' }],
                [{ role: 'system', content: 'X' }, { role: 'user', content: 'hi' }],
                [{ role: 'developer', content: 'X' }, { role: 'user', content: 'hi' }]
            ]) {
                const out = await session._prepareStepMessages({ messages: history });
                const systems = out.filter(isSystemShape);
                assert.equal(systems.length, 1, `${b.name}: exactly one system message`);
                assert.ok(
                    String(systems[0].content).includes('You are a test assistant.'),
                    `${b.name}: session system content reaches the wire`
                );
            }
        });

        it(`${b.name}: _recoverToolCallsFromText is inherited and dispatches to the backend's extractor`, () => {
            const session = makeSession({ provider: b });

            const r1 = session._recoverToolCallsFromText({ text: 'plain text', extractFn: b.extractFn });
            assert.deepEqual(r1, []);

            const xmlPayload = JSON.stringify({ name: 'foo', arguments: { a: 1 } });
            const xmlText = `${XML_TOOL_CALL_TAGS.START}${xmlPayload}${XML_TOOL_CALL_TAGS.END}`;
            const r2 = session._recoverToolCallsFromText({ text: xmlText, extractFn: b.extractFn });
            assert.ok(Array.isArray(r2), `${b.name}: extractor should return an array`);
            assert.ok(r2.length >= 1, `${b.name}: XML extractor should return at least one tool call`);

            const r3 = session._recoverToolCallsFromText({ text: xmlText, extractFn: null });
            assert.deepEqual(r3, []);
        });

        it(`${b.name}: _formatFinalMessages is inherited and produces unified factory output`, () => {
            const session = makeSession({ provider: b });

            const r1 = session._formatFinalMessages({
                provider: b.type,
                history: [{ role: 'user', content: 'hi' }],
                text: 'hello',
                toolCalls: [],
                results: null,
                thoughtSignature: null,
                /** @param {{call: any}} arg0 */
                formatToolCall: ({ call: c }) => ({ id: c.id, name: c.name, args: '{}' })
            });
            assert.equal(r1.length, 2);
            const assistant1 = r1[1];
            assert.ok(assistant1.role || assistant1.type, `${b.name}: assistant message has a shape marker`);
        });
    }
});

describe('MessageFactoryAdapter — unified factory surface', () => {
    it('createUserMessage exists and is a function', () => {
        assert.equal(typeof createUserMessage, 'function');
    });

    it('createSystemMessage exists and is a function', () => {
        assert.equal(typeof createSystemMessage, 'function');
    });

    it('createAssistantMessage exists and is a function', () => {
        assert.equal(typeof createAssistantMessage, 'function');
    });

    it('createToolCallMessage exists and is a function', () => {
        assert.equal(typeof createToolCallMessage, 'function');
    });

    it('createToolResultMessage exists and is a function', () => {
        assert.equal(typeof createToolResultMessage, 'function');
    });

    it('createUnifiedMediaMessages exists and is a function', () => {
        assert.equal(typeof createUnifiedMediaMessages, 'function');
    });

    for (const b of ALL_BACKENDS) {
        it(`createUserMessage(${b.name}) returns the expected wire shape`, () => {
            const m = /** @type {any} */ (createUserMessage({ provider: b.type, content: 'hi' }));
            if (b.type === ProviderType.JAI) {
                assert.equal(m.type, 'user_message');
            } else {
                assert.equal(m.role, 'user');
            }
        });

        it(`createSystemMessage(${b.name}) returns the expected wire shape`, () => {
            const m = /** @type {any} */ (createSystemMessage({ provider: b.type, content: 'sys' }));
            if (b.type === ProviderType.JAI) {
                assert.equal(m.type, 'system_message');
            } else {
                assert.equal(m.role, 'system');
            }
        });
    }
});

describe('ParameterBuilderAdapter — unified fluent builder + per-backend translator', () => {
    const cases = [
        { name: 'OAI', type: ProviderType.OPENAI, translate: buildParameterMapForOai },
        { name: 'AAI', type: ProviderType.ANTHROPIC, translate: buildParameterMapForAai },
        { name: 'GAI', type: ProviderType.GOOGLE_GENAI, translate: buildParameterMapForGai },
        { name: 'JAI', type: ProviderType.JAI, translate: buildParameterMapForJai }
    ];

    for (const c of cases) {
        describe(`${c.name} parameter builder`, () => {
            it('UnifiedParameterBuilder exposes the common-core fluent surface', () => {
                const emitter = new EventEmitter();
                const b = new UnifiedParameterBuilder({ model: 'test-model', eventEmitter: emitter, provider: c.type });
                for (const m of ['temperature', 'topP', 'maxTokens', 'stop', 'asText', 'asJson', 'toolChoiceAuto', 'toolChoiceRequired', 'toolChoiceNone', 'toolChoiceNamed', '_build']) {
                    assert.equal(typeof (/** @type {any} */ (b))[m], 'function', `${c.name}.${m} should be a function`);
                }
            });

            it('every fluent setter returns the builder (chainable)', () => {
                const b = new UnifiedParameterBuilder({ model: 'test-model', eventEmitter: new EventEmitter(), provider: c.type });
                assert.strictEqual(b.temperature({ v: 0.5 }), b);
                assert.strictEqual(b.topP({ v: 0.9 }), b);
                assert.strictEqual(b.asText(), b);
                assert.strictEqual(b.toolChoiceAuto(), b);
            });

            it('UnifiedParameterBuilder._build() returns an object', () => {
                const b = new UnifiedParameterBuilder({ model: 'test-model', eventEmitter: new EventEmitter(), provider: c.type });
                const built = b._build();
                assert.equal(typeof built, 'object');
                assert.notEqual(built, null);
            });

            it('per-backend translator is a function and produces an object', () => {
                assert.equal(typeof c.translate, 'function', `${c.name} translator should be a function`);
                const b = new UnifiedParameterBuilder({ model: 'test-model', eventEmitter: new EventEmitter(), provider: c.type }).temperature({ v: 0.5 }).topP({ v: 0.9 }).asText();
                const translated = c.translate({ spec: b._build() });
                assert.equal(typeof translated, 'object');
                assert.notEqual(translated, null);
            });
        });
    }
});

describe('MessageNormalizer — per-backend normalizer surface', () => {
    it('normalizeToOAI is exported as a function', () => {
        assert.equal(typeof normalizeToOAI, 'function');
    });

    it('normalizeToAAI is exported as a function', () => {
        assert.equal(typeof normalizeToAAI, 'function');
    });

    it('normalizeToGAI is exported as a function', () => {
        assert.equal(typeof normalizeToGAI, 'function');
    });

    it('normalizeHistory is exported as a function', () => {
        assert.equal(typeof normalizeHistory, 'function');
    });

    it('normalizeToOAI handles a system message (chat model → role:system)', () => {
        const out = normalizeToOAI({ model: 'gpt-4o-mini', msgs: [{ type: 'system_message', content: 'sys' }, { role: 'user', content: 'hi' }] });
        const sys = out.find(m => m.role === 'system');
        assert.ok(sys, 'OAI chat model should have a role:system message on the wire');
    });

    it('normalizeToOAI promotes to role:developer for o-series models', () => {
        const out = normalizeToOAI({ model: 'o1-preview', msgs: [{ type: 'system_message', content: 'sys' }] });
        const dev = out.find(m => m.role === 'developer');
        assert.ok(dev, 'OAI o-series should have a role:developer message on the wire');
    });

    it('normalizeToAAI extracts the system message into the top-level system field', () => {
        const out = normalizeToAAI({ msgs: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
        assert.equal(out.system, 'sys');
    });

    it('normalizeToGAI extracts the system message into systemInstruction', () => {
        const out = normalizeToGAI({ msgs: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
        assert.equal(out.systemInstruction, 'sys');
    });

    it('drops a TRAILING EMPTY assistant turn on every normalizer (request-ends-with-model-turn 400)', () => {
        const trailing = [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '' }
        ];
        const oai = normalizeToOAI({ model: 'gpt-4o-mini', msgs: trailing });
        assert.equal(oai[oai.length - 1].role, 'user', 'OAI: the last wire message is the user turn');
        assert.ok(!oai.some(m => m.role === 'assistant' && !String(m.content ?? '').trim()),
            'OAI: no empty assistant turn survives');

        const aai = normalizeToAAI({ msgs: trailing });
        const aaiLast = aai.messages[aai.messages.length - 1];
        assert.equal(aaiLast.role, 'user', 'AAI: the last wire message is the user turn');
        assert.ok(!aai.messages.some(m => m.role === 'assistant'
            && /** @type {Array<Record<string, any>>} */ (m.content).length === 1
            && !String(/** @type {Array<Record<string, any>>} */ (m.content)[0]?.text ?? '').trim()),
            'AAI: no empty assistant block survives');

        const gai = normalizeToGAI({ msgs: trailing });
        assert.equal(gai.contents[gai.contents.length - 1].role, 'user', 'GAI: the last content is the user turn');
        assert.ok(!gai.contents.some(c => c.role === 'model' && c.parts.length === 1
            && !String(c.parts[0]?.text ?? '').trim()), 'GAI: no empty model part survives');

        const jaiShape = normalizeToOAI({ model: 'gpt-4o-mini', msgs: [
            { role: 'user', content: 'go' },
            { type: 'assistant_message_text', content: '   ' }
        ] });
        assert.equal(jaiShape[jaiShape.length - 1].role, 'user', 'the assistant_message_text spelling is dropped too');
    });

    it('KEEPS non-empty and tool-call assistant turns (never over-drops)', () => {
        const withTool = normalizeToOAI({ model: 'gpt-4o-mini', msgs: [
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }], content: '' },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' }
        ] });
        assert.ok(withTool.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
            'a tool-call row (empty content = args) is NOT an empty turn');

        const withText = normalizeToAAI({ msgs: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'answer' }
        ] });
        assert.equal(/** @type {Array<Record<string, any>>} */ (withText.messages[withText.messages.length - 1].content)[0].text, 'answer');

        const gaiFn = normalizeToGAI({ msgs: [
            { role: 'user', content: 'go' },
            { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'f', args: {} } }] }
        ] });
        assert.ok(gaiFn.contents.some(c => c.role === 'model' && c.parts.some(p => p.functionCall)),
            'a GAI functionCall model turn is kept');
    });
});

describe('ProviderType — registry values', () => {
    it('ProviderType has the four core backends', () => {
        for (const k of ['JAI', 'OPENAI', 'ANTHROPIC', 'GOOGLE_GENAI']) {
            assert.equal(typeof ProviderType[k], 'string', `ProviderType.${k} should be a string`);
        }
    });

    it('ProviderType values are unique', () => {
        const values = Object.values(ProviderType);
        assert.equal(new Set(values).size, values.length, 'ProviderType values should be unique');
    });
});

describe('OAI Responses reasoning parameters', () => {
    /** @param {{parameters: any, provider?: string, eventEmitter?: any}} arg0 */
    const build = ({ parameters, provider = ProviderType.OPENAI, eventEmitter = null }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-5',
        parameters,
        tools: [],
        preparedMessages: [{ role: 'user', content: 'go' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'responses', provider, eventEmitter }
    });

    it('maps reasoning_summary to reasoning.summary beside effort', () => {
        const req = build({ parameters: { reasoning_effort: 'high', reasoning_summary: 'auto' } });
        assert.deepEqual(req.request.reasoning, { effort: 'high', summary: 'auto' });
    });

    it('merges verbosity into text without dropping a json_schema format', () => {
        const req = build({ parameters: {
            verbosity: 'low',
            response_format: { type: 'json_schema', json_schema: { name: 'o', schema: { type: 'object', properties: {} } } },
        } });
        assert.equal(req.request.text.verbosity, 'low');
        assert.equal(req.request.text.format.type, 'json_schema');
    });

    it("sets text.verbosity on its own when there is no response format", () => {
        const req = build({ parameters: { verbosity: 'high' } });
        assert.deepEqual(req.request.text, { verbosity: 'high' });
    });

    it('asks for encrypted reasoning items when store is false', () => {
        const req = build({ parameters: { store: false } });
        assert.deepEqual(req.request.include, ['reasoning.encrypted_content']);
    });

    it('does not ask for encrypted reasoning when store is true', () => {
        const req = build({ parameters: { store: true } });
        assert.equal(req.request.include, undefined);
    });

    it('drops stop and seed on the OpenAI Responses wire with one warning each', () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
        const req = build({ parameters: { stop: 'END', seed: 7 }, provider: ProviderType.OPENAI, eventEmitter: emitter });
        assert.equal('stop' in req.request, false, 'CreateResponse has no stop');
        assert.equal('seed' in req.request, false, 'CreateResponse has no seed');
        assert.deepEqual(warnings.map((/** @type {any} */ w) => w.parameter).sort(), ['seed', 'stop']);
    });

    it('keeps stop and drops seed on the OpenRouter /responses wire', () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
        const req = build({ parameters: { stop: 'END', seed: 7 }, provider: ProviderType.OPENROUTER, eventEmitter: emitter });
        assert.equal(req.request.stop, 'END', 'OpenRouter /responses defines stop');
        assert.equal('seed' in req.request, false, 'OpenRouter /responses has no seed');
        assert.deepEqual(warnings.map((/** @type {any} */ w) => w.parameter), ['seed']);
    });
});

describe('OAI chat-completions reasoning fields', () => {
    /** @param {{parameters: any, provider?: string, eventEmitter?: any}} arg0 */
    const build = ({ parameters, provider = ProviderType.OPENAI, eventEmitter = null }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o',
        parameters,
        tools: [],
        preparedMessages: [{ role: 'user', content: 'go' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'chat', provider, eventEmitter },
    });

    it('drops reasoning_summary from the body and warns accurately', () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
        const req = build({ parameters: { reasoning_summary: 'auto' }, eventEmitter: emitter });
        assert.equal('reasoning_summary' in req.request, false, 'CreateChatCompletionRequest has no reasoning_summary');
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].parameter, 'reasoningSummary');
        assert.match(warnings[0].message, /reasoning_summary/);
        assert.match(warnings[0].message, /chat-completions/);
    });

    it('keeps verbosity on the OpenAI chat wire without a warning', () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
        const req = build({ parameters: { verbosity: 'low' }, provider: ProviderType.OPENAI, eventEmitter: emitter });
        assert.equal(req.request.verbosity, 'low', 'CreateChatCompletionRequest defines verbosity');
        assert.deepEqual(warnings, []);
    });

    it('drops verbosity on the OpenRouter chat wire with a warning', () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
        const req = build({ parameters: { verbosity: 'low' }, provider: ProviderType.OPENROUTER, eventEmitter: emitter });
        assert.equal('verbosity' in req.request, false, "OpenRouter's ChatRequest has no verbosity");
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].parameter, 'verbosity');
        assert.match(warnings[0].message, /verbosity/);
    });
});

describe('OAI Responses protocol input conversion', () => {
    /** @param {{preparedMessages: any}} arg0 */
    /** @param {{preparedMessages: *}} arg0 */
    const build = ({ preparedMessages }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o',
        parameters: {},
        tools: [],
        preparedMessages,
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'responses' }
    });

    it('maps multimodal user content to input_image parts (no stringified blobs)', () => {
        const req = build({ preparedMessages: [
            { role: 'user', content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ] }
        ] });
        const input = req.request.input;
        assert.equal(input[0].type, 'message');
        assert.equal(input[0].role, 'user');
        assert.deepEqual(input[0].content, [
            { type: 'input_text', text: 'what is this?' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }
        ]);
        assert.ok(!JSON.stringify(input).includes('image_url":['), 'image_url array must not be stringified');
    });

    it('normalizes a string image_url and a { url } image_url into input_image with detail auto', () => {
        const req = build({ preparedMessages: [
            { role: 'user', content: [
                { type: 'image_url', image_url: 'https://example.com/a.png' },
                { type: 'image_url', image_url: { url: 'https://example.com/b.png' } }
            ] }
        ] });
        assert.deepEqual(req.request.input[0].content, [
            { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' },
            { type: 'input_image', image_url: 'https://example.com/b.png', detail: 'auto' }
        ]);
    });

    it('maps a PDF file part to input_file (never stringified into text)', () => {
        const req = build({ preparedMessages: [
            { role: 'user', content: [
                { type: 'text', text: 'summarise' },
                { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } }
            ] }
        ] });
        const input = req.request.input;
        assert.deepEqual(input[0].content, [
            { type: 'input_text', text: 'summarise' },
            { type: 'input_file', filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }
        ]);
        assert.ok(
            !input.some((/** @type {any} */ i) => Array.isArray(i.content)
                && i.content.some((/** @type {any} */ p) => p.type === 'input_text' && String(p.text).includes('file_data'))),
            'file part must not be stringified into an input_text blob'
        );
    });

    it('maps a file_id file part to input_file too', () => {
        const req = build({ preparedMessages: [
            { role: 'user', content: [
                { type: 'text', text: 'summarise' },
                { type: 'file', file: { file_id: 'file-abc123' } }
            ] }
        ] });
        assert.deepEqual(req.request.input[0].content[1], { type: 'input_file', file_id: 'file-abc123' });
    });

    it('uses input_text for assistant text and keeps call→output adjacency', () => {
        const req = build({ preparedMessages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }], content: 'calling' },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' }
        ] });
        const input = req.request.input;
        const types = input.map((/** @type {any} */ i) => i.type);
        assert.deepEqual(types, ['message', 'message', 'function_call', 'function_call_output']);
        assert.equal(input[1].role, 'assistant');
        assert.equal(input[1].content[0].type, 'input_text',
            'EasyInputMessage.content defines input_text; output_text belongs to the output item');
        assert.equal(input[2].call_id, 'c1');
        assert.equal(input[3].call_id, 'c1');
    });

    it('skips empty content arrays instead of emitting content:[] items (API 400)', () => {
        const req = build({ preparedMessages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [], tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }
        ] });
        const input = req.request.input;
        assert.ok(!input.some((/** @type {any} */ i) => Array.isArray(i.content) && i.content.length === 0),
            'no empty content arrays may reach the wire');
        assert.deepEqual(input.map((/** @type {any} */ i) => i.type), ['message', 'function_call']);
        const req2 = build({ preparedMessages: [{ role: 'user', content: [] }] });
        assert.equal(req2.request.input.length, 0, 'user empty content must be dropped, not sent');
    });

    it('responsesAssistantPartType override still emits the other shape', () => {
        const req = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
            model: 'gpt-4o',
            parameters: {},
            tools: [],
            preparedMessages: [
                { role: 'user', content: 'go' },
                { role: 'assistant', content: 'previous answer' }
            ],
            forceTextResponse: false,
            toolChoiceRequired: false,
            session: { protocol: 'responses', responsesAssistantPartType: 'output_text' }
        });
        const assistant = req.request.input.find((/** @type {any} */ i) => i.role === 'assistant');
        assert.equal(assistant.content[0].type, 'output_text', 'override must emit the requested part type');
    });
});

describe('OAI provider-specific request conformance', () => {
    /** @param {{provider?: string, protocol: string, parameters?: Record<string, any>, tools?: Array<any>, preparedMessages?: Array<any>, eventEmitter?: any}} arg0 */
    const build = ({ provider = ProviderType.OPENAI, protocol, parameters = {}, tools = [], preparedMessages = [{ role: 'user', content: 'go' }], eventEmitter = null }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o',
        parameters,
        tools,
        preparedMessages,
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol, provider, eventEmitter }
    });

    it('sends no store on OpenRouter chat, and keeps it on OpenAI chat', () => {
        const openrouter = build({ provider: ProviderType.OPENROUTER, protocol: 'completions', parameters: { store: false } });
        assert.equal('store' in openrouter.request, false, "ChatRequest defines no 'store'");
        const openai = build({ provider: ProviderType.OPENAI, protocol: 'completions', parameters: { store: true } });
        assert.equal(openai.request.store, true, 'OpenAI chat defines store');
    });

    it('sends the OpenAI-only logprobs include on OpenAI Responses only', () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
        const openai = build({ protocol: 'responses', parameters: { logprobs: true, store: false } });
        assert.deepEqual(openai.request.include, ['reasoning.encrypted_content', 'message.output_text.logprobs']);
        const openrouter = build({ provider: ProviderType.OPENROUTER, protocol: 'responses', parameters: { logprobs: true, store: false }, eventEmitter: emitter });
        assert.deepEqual(openrouter.request.include, ['reasoning.encrypted_content'],
            "OpenRouter's include enum carries no logprobs value");
        assert.deepEqual(warnings.map((/** @type {any} */ w) => w.parameter), ['logprobs']);
    });

    it('emits strict: false on Responses function tools and lets a caller value win', () => {
        const tool = { name: 'lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } };
        const defaulted = build({ protocol: 'responses', tools: [tool] });
        assert.equal(defaulted.request.tools[0].strict, false, 'FunctionTool.required names strict');
        const caller = build({ protocol: 'responses', tools: [{ ...tool, strict: true }], parameters: { tools: [{ ...tool, name: 'other', strict: true }] } });
        assert.equal(caller.request.tools[0].strict, true, 'a caller-provided strict must survive');
        assert.equal(caller.request.tools[1].strict, true, 'a parameter-map tool must keep its strict too');
    });

    it('forwards a caller-provided strict on chat tools without inventing one', () => {
        const tool = { name: 'lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } };
        const plain = build({ protocol: 'completions', tools: [tool] });
        assert.equal('strict' in plain.request.tools[0].function, false, 'chat does not require strict');
        const caller = build({ protocol: 'completions', tools: [{ ...tool, strict: true }] });
        assert.equal(caller.request.tools[0].function.strict, true, 'the caller value must not be dropped');
    });
});

// =============================================================================
// JSON-pass tool-selection guards (retry-storm fix)
// =============================================================================

const TASK_TOOL = { name: 'task', description: 'delegate', parameters: { type: 'object', properties: {} } };

describe('OAI json_object guard (chat completions)', () => {
    const build = (/** @type {any} */ parameters, tools = [TASK_TOOL]) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o', parameters, tools, preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false,
        session: { protocol: 'completions' },
    });

    it('does not clobber a multimodal user turn when injecting the JSON nudge', () => {
        const req = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
            model: 'gpt-4o',
            parameters: { response_format: { type: 'json_object' } },
            tools: [TASK_TOOL],
            preparedMessages: [
                { role: 'user', content: [
                    { type: 'text', text: 'summarise' },
                    { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } }
                ] }
            ],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { protocol: 'completions' },
        });
        const user = req.request.messages.find((/** @type {any} */ m) => m.role === 'user');
        assert.ok(Array.isArray(user.content), 'multimodal content must stay an array');
        assert.ok(!JSON.stringify(user.content).includes('[object Object]'), 'array content must not be string-concatenated');
        assert.ok(user.content.some((/** @type {any} */ p) => p.type === 'file'), 'the file part must survive the nudge');
        assert.ok(user.content.some((/** @type {any} */ p) => p.type === 'text' && p.text.includes('Return your answer as JSON')), 'nudge appended as a text part');
    });

    it('pins tool_choice none when no caller tools/choice', () => {
        const req = build({ response_format: { type: 'json_object' } } );
        assert.equal(req.request.tool_choice, 'none');
    });
    it('leaves json_schema untouched (provider forces text)', () => {
        const req = build({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } } } );
        assert.equal(req.request.tool_choice, undefined);
    });
    it('respects caller-supplied tools', () => {
        const req = build({ response_format: { type: 'json_object' }, tools: [{ type: 'function', function: { name: 'probe', description: 'd', parameters: {} } }] } );
        assert.equal(req.request.tool_choice, undefined);
    });
    it('respects explicit caller tool_choice', () => {
        const req = build({ response_format: { type: 'json_object' }, tool_choice: 'auto' } );
        assert.equal(req.request.tool_choice, 'auto');
    });
    it('respects step-level forceTextResponse', () => {
        const req = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
            model: 'gpt-4o', parameters: { response_format: { type: 'json_object' } }, tools: [TASK_TOOL],
            preparedMessages: [], forceTextResponse: true, toolChoiceRequired: false,
            session: { protocol: 'completions' },
        });
        assert.equal(req.request.tool_choice, 'none');
    });
    it('respects step-level toolChoiceRequired', () => {
        const req = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
            model: 'gpt-4o', parameters: { response_format: { type: 'json_object' } }, tools: [TASK_TOOL],
            preparedMessages: [], forceTextResponse: false, toolChoiceRequired: true,
            session: { protocol: 'completions' },
        });
        assert.equal(req.request.tool_choice, 'required');
    });
});

describe('OAI json_object guard (Responses API)', () => {
    const build = (/** @type {any} */ parameters, tools = [TASK_TOOL]) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o', parameters, tools, preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false,
        session: { protocol: 'responses' },
    });

    it('pins body.tool_choice none when no caller tools/choice', () => {
        const req = build({ response_format: { type: 'json_object' } } );
        assert.equal(req.request.tool_choice, 'none');
    });
    it('leaves json_schema untouched', () => {
        const req = build({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } } } );
        assert.equal(req.request.tool_choice, undefined);
    });
    it('respects caller-supplied tools', () => {
        const req = build({ response_format: { type: 'json_object' }, tools: [{ type: 'function', function: { name: 'probe', description: 'd', parameters: {} } }] } );
        assert.equal(req.request.tool_choice, undefined);
    });
    it('respects explicit caller tool_choice', () => {
        const req = build({ response_format: { type: 'json_object' }, tool_choice: 'none' } );
        assert.equal(req.request.tool_choice, 'none');
    });
});

describe('AAI json-mode guard', () => {
    const build = (/** @type {any} */ parameters, tools = [TASK_TOOL]) => (/** @type {any} */ (aaiAdapter)).buildVendorRequest({
        model: 'claude', parameters, tools, preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false,
    });

    it('uses native structured output when a schema is present and there are no caller tools/choice', () => {
        const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
        const req = build({ _jsonMode: true, _jsonSchema: schema } );
        assert.deepEqual(req.request.output_config.format, { type: 'json_schema', schema });
        assert.equal(req.request.tool_choice, undefined, 'no tool is forced');
        assert.equal((req.request.tools ?? []).some((/** @type {any} */ t) => t.name === 'json_output'), false);
    });
    it('keeps a caller-supplied output_config (effort) beside the schema format', () => {
        const req = build({
            _jsonMode: true,
            _jsonSchema: { type: 'object', properties: {} },
            output_config: { effort: 'high' },
        } );
        assert.deepEqual(req.request.output_config.effort, 'high');
        assert.equal(req.request.output_config.format.type, 'json_schema');
    });
    it('pins tool_choice none for json_object without schema', () => {
        const req = build({ _jsonMode: true } );
        assert.deepEqual(req.request.tool_choice, { type: 'none' });
    });
    it('keeps caller-supplied tools (task-named fixture) and does not force tool_choice in json mode', () => {
        const req = build({ _jsonMode: true, _tools: [{ name: 'probe', description: 'd', input_schema: {} }] } );
        assert.equal(req.request.tool_choice, undefined);
        assert.ok(req.request.tools.some((/** @type {any} */ t) => t.name === 'task'));
    });
    it('leaves tool choice alone when caller chose a mode', () => {
        const req = build({ _jsonMode: true, _toolChoice: 'auto' } );
        assert.deepEqual(req.request.tool_choice, { type: 'auto' });
    });
    it('leaves non-json text passes alone', () => {
        const req = build({} );
        assert.equal(req.request.tool_choice, undefined);
    });
});

describe('AAI reasoning parameters', () => {
    const build = (/** @type {any} */ parameters) => (/** @type {any} */ (aaiAdapter)).buildVendorRequest({
        model: 'claude', parameters, tools: [TASK_TOOL], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false,
    });

    it('maps effort to output_config.effort and never to a top-level field', () => {
        const req = build({ output_config: { effort: 'high' } });
        assert.equal(req.request.output_config.effort, 'high');
        assert.equal(req.request.reasoning_effort, undefined);
    });

    it('does not imply adaptive thinking from an effort level', () => {
        const req = build({ output_config: { effort: 'high' } });
        assert.equal(req.request.thinking, undefined, 'effort alone must not enable thinking');
    });

    it("maps thinkingBudget 'adaptive' to thinking: { type: 'adaptive' }", () => {
        const req = build({ thinking: { type: 'adaptive' } });
        assert.deepEqual(req.request.thinking, { type: 'adaptive' });
    });

    it('still emits an explicit token budget as enabled', () => {
        const req = build({ thinking: { type: 'enabled', budget_tokens: 2048 } });
        assert.deepEqual(req.request.thinking, { type: 'enabled', budget_tokens: 2048 });
    });
});

describe('tool gating — profile-less sessions', () => {
    it('GAI: a session with no task profiles advertises no tools and sends none', () => {
        const gaiEntry = /** @type {any} */ (ALL_BACKENDS.find((/** @type {any} */ b) => b.name === 'GOOGLE_GENAI'));
        const session = makeSession({ provider: gaiEntry });
        assert.deepEqual(session._tools, [], 'no tools are advertised without a registered profile');
        const built = /** @type {any} */ (gaiAdapter).buildVendorRequest({
            model: session.model, parameters: session._parameters, tools: session._tools,
            preparedMessages: [], forceTextResponse: false, toolChoiceRequired: false, session,
        });
        assert.equal(built.request.config.tools, undefined, 'no tool definitions reach the wire');
    });
});

describe('GAI json-mode guard', () => {
    const build = (/** @type {any} */ parameters, tools = [TASK_TOOL]) => (/** @type {any} */ (gaiAdapter)).buildVendorRequest({
        model: 'gemini', parameters, tools, preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false,
    });

    it('pins toolConfig NONE for application/json with no caller intent', () => {
        const req = build({ responseMimeType: 'application/json' } );
        assert.deepEqual(req.request.config.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    });
    it('respects caller tool choice', () => {
        const req = build({ responseMimeType: 'application/json', _toolConfig: 'auto' } );
        assert.deepEqual(req.request.config.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
    });
    it('respects caller-supplied tools', () => {
        const req = build({ responseMimeType: 'application/json', _tools: [{ name: 'probe', description: 'd', parametersJsonSchema: {} }] } );
        assert.equal(req.request.config.toolConfig, undefined);
    });
    it('respects step-level toolChoiceRequired', () => {
        const req = (/** @type {any} */ (gaiAdapter)).buildVendorRequest({
            model: 'gemini', parameters: { responseMimeType: 'application/json' }, tools: [TASK_TOOL],
            preparedMessages: [], forceTextResponse: false, toolChoiceRequired: true,
        });
        assert.deepEqual(req.request.config.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
    });
    it('skips text passes', () => {
        const req = build({ responseMimeType: 'text/plain' } );
        assert.equal(req.request.config.toolConfig, undefined);
    });
});

describe('GAI thinkingLevel wire enum', () => {
    for (const provider of [ProviderType.GOOGLE_GENAI, ProviderType.VERTEX]) {
        it(`${provider}: the wire carries the uppercase Gemini enum`, () => {
            const req = (/** @type {any} */ (gaiAdapter)).buildVendorRequest({
                model: 'gemini-x',
                parameters: { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } },
                tools: [], preparedMessages: [],
                forceTextResponse: false, toolChoiceRequired: false,
                session: { provider, protocol: 'responses', eventEmitter: null },
            });
            assert.deepEqual(req.request.config.thinkingConfig, { thinkingLevel: 'MEDIUM', includeThoughts: true });
        });
    }

    it('keeps the unified builder input lowercase and uppercases only the wire', () => {
        const parameters = /** @type {any} */ (buildParameterMapForGai({ spec: /** @type {any} */ ({ thinkingLevel: 'low' }) }));
        assert.equal(parameters.thinkingConfig.thinkingLevel, 'low', 'the public builder input stays lowercase');
        const req = (/** @type {any} */ (gaiAdapter)).buildVendorRequest({
            model: 'gemini-x', parameters, tools: [], preparedMessages: [],
            forceTextResponse: false, toolChoiceRequired: false,
            session: { provider: ProviderType.GOOGLE_GENAI, protocol: 'responses', eventEmitter: null },
        });
        assert.equal(req.request.config.thinkingConfig.thinkingLevel, 'LOW');
    });
});

describe('OAI adapter — unrecognized tool_choice passthrough warns', () => {
    it('warns (and passes through verbatim) when tool_choice is an object OpenAI cannot parse', async () => {
        const { oaiAdapter } = await import('../lib/backends/adapters/oai-adapter.mjs');
        const { EVENTS } = await import('../lib/core/events.mjs');
        const { EventEmitter } = await import('node:events');
        const ee = new EventEmitter();
        /** @type {any[]} */
        const warnings = [];
        ee.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => warnings.push(e));
        const vendor = {
            chat: { completions: { create: async () => (async function* () { /* empty stream */ })() } },
            responses: { create: async () => { throw new Error('must not route here'); } }
        };
        const body = /** @type {any} */ (oaiAdapter).buildVendorRequest({
            model: 'gpt-4o',
            parameters: { tool_choice: { type: 'named', name: 'x' } },
            tools: [], preparedMessages: [], forceTextResponse: false,
            toolChoiceRequired: false, thoughtSignature: null,
            session: { provider: 'openai', protocol: null, eventEmitter: ee }
        }).request;
        assert.deepEqual(body.tool_choice, { type: 'named', name: 'x' }, 'passthrough behavior is preserved');
        assert.equal(warnings.length, 1, 'exactly one parameter_warning');
        assert.equal(warnings[0].parameter, 'tool_choice');
        assert.match(warnings[0].message, /Unrecognized tool_choice/);
    });
});
