// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as GaiChatSession } from '../lib/backends/gai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { ChatSession as JaiBaseChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const stubEmitter = new EventEmitter();
/** @type {any} */
const stubSdk = { session() {} };
const opencodeStub = () => ({ session() {}, embed() {}, provider: ProviderType.OPENCODE });
/** @type {any} */
const stubProfileManager = {
    getProfile() { return null; },
    isSupported() { return true; }
};

// =============================================================================
// SECTION 1: DIRECT INSTANTIATION VIA SUBCLASS
// =============================================================================

class MinimalSession extends AbstractChatSession {
    constructor(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ eventEmitter, /** @type {any} */ client) {
        super({ provider, model, eventEmitter, client });
    }
}

test('AbstractChatSession: subclass inherits constructor and sets public fields', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    assert.equal(session.provider, ProviderType.OPENAI);
    assert.equal(session.model, 'gpt-4o-mini');
    assert.equal(session.eventEmitter, stubEmitter);
    assert.equal(session.client, stubSdk);
});

test('AbstractChatSession: retry backoff honors an abort during the delay', async () => {
    // ponytail: the shared _runWithRetry slept via setTimeout — an abort during
    const { ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    // jitterMs:0 keeps the first backoff deterministic: with full jitter the
    // random draw can be ~0 ms, letting the retry start before the 20 ms abort
    // and making `calls` race (observed 2 under full-suite load).
    const policy = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 5000, maxDelayMs: 5000, jitterMs: 0 });
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk)
        .withRetryPolicy({ policy });
    const controller = new AbortController();
    let calls = 0;
    const operation = async () => { calls++; throw Object.assign(new Error('boom'), { status: 500 }); };
    const start = Date.now();
    setTimeout(() => controller.abort(new Error('user cancel')), 20);
    await assert.rejects(
        () => (/** @type {any} */ (session))._runWithRetry({ operation, ctx: { signal: controller.signal } }),
        (/** @type {any} */ e) => e.name === 'AbortError' || e.name === 'AbortedError'
    );
    assert.ok(Date.now() - start < 2000, 'abort must interrupt the backoff sleep');
    assert.equal(calls, 1, 'no retry after an abort');
});

test('AbstractChatSession: _userSystemMessage starts at null', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    assert.equal(session._userSystemMessage, null);
});

test('AbstractChatSession: _parameters starts at {}', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    assert.deepEqual(session._parameters, {});
});

test('AbstractChatSession: a session with no registered task profiles advertises no tools', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    assert.deepEqual(session._tools.map(/** @type {(...args: any[]) => any} */ ((t) => t.name)), []);
});

test('AbstractChatSession: a tool round returns the model text as content (never silently empty)', async () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    session._streamTimeoutPolicy = /** @type {any} */ ({});
    session._adapter = /** @type {any} */ ({
        vendorName: 'FAKE',
        buildVendorRequest: () => ({ request: {}, observability: {} }),
        executeVendorRequest: async () => (async function* () {
            yield { type: 'text', content: 'Working on it. ' };
            yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'task', args: { prompt: 'x' } }] };
        })(),
        consumeStream: (/** @type {{rawStream: any}} */ { rawStream }) => rawStream,
        formatToolCall: (/** @type {{call: any}} */ { call }) => ({ id: call.id, name: call.name, args: call.args }),
    });
    const gen = session.step({ messages: [{ role: 'user', content: 'hi' }] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const finalState = /** @type {any} */ (r.value ?? {});
    assert.equal(finalState.done, false, 'a tool round is not a completed answer');
    assert.equal(finalState.unhandledToolCalls, true, 'the abandoned round is flagged');
    assert.equal(finalState.content, 'Working on it. ', 'text emitted alongside the tool call must survive');
});

test('AbstractChatSession: withSystemMessage persists as _userSystemMessage', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    const result = session.withSystemMessage('You are a helpful assistant.');
    assert.equal(result, session, 'withSystemMessage must return the session for chaining');
    assert.equal(session._userSystemMessage, 'You are a helpful assistant.');
    // ponytail: getSystemMessage returns only SDK-level system parts (descriptor
    assert.equal(session.getSystemMessage(), null);
});

test('AbstractChatSession: withTools persists tools and the _tools getter exposes them', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    const tools = [{ name: 'foo', description: 'd', parameters: {} }];
    const result = session.withTools({ tools });
    assert.equal(result, session, 'withTools must return the session for chaining');
    assert.deepEqual(session._tools.map(/** @type {(...args: any[]) => any} */ ((t) => t.name)), ['foo']);
    assert.equal(session._tools[0], tools[0]);
});

test('AbstractChatSession: withTools coerces non-array input to []', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    session.withTools({ tools: /** @type {any} */ ('not an array') });
    assert.deepEqual(session._tools.map(/** @type {(...args: any[]) => any} */ ((t) => t.name)), []);
});

test('AbstractChatSession: withTools drops null/undefined entries at ingestion', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    const tool = { name: 'foo', description: 'd', parameters: {} };
    session.withTools({ tools: [tool, null, undefined] });
    assert.deepEqual(session._tools.map(/** @type {(...args: any[]) => any} */ ((t) => t.name)), ['foo']);
    assert.equal(session._toolsStore.length, 1);
    assert.equal(session._toolsStore[0], tool);
});

test('executeTools tolerates null/undefined entries in a hand-built library', async () => {
    const { executeTools } = await import('../lib/tools/tool-execution.mjs');
    const results = /** @type {any} */ (await executeTools({ toolCalls: [{ name: 'echo', arguments: '{}' }], toolLibrary: [null, undefined, { name: 'echo', execute: () => 'ok' }] }));
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(results[0].result, 'ok');
});

test('AbstractChatSession: withParameters (function form) throws AbstractMethodError on bare subclass (F31)', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    assert.throws(
        () => session.withParameters({ params: /** @type {(...args: any[]) => any} */ ((prev) => ({ ...prev, temperature: 0.7 })) }),
        (/** @type {any} */ err) => {
            assert.equal(err.code, 'MERCI-ABSTRACT-METHOD');
            assert.equal(err.name, 'AbstractMethodError');
            return true;
        }
    );
});

test('AbstractChatSession: withParameters (object form) shallow-merges into current params', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    session.withParameters({ params: { temperature: 0.7 } });
    session.withParameters({ params: { top_p: 0.9 } });
    assert.deepEqual(session._parameters, { temperature: 0.7, top_p: 0.9 });
});

test('AbstractChatSession: withParameters ignores null/undefined input', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    session.withParameters({ params: { temperature: 0.5 } });
    session.withParameters({ params: /** @type {any} */ (null) });
    session.withParameters({ params: /** @type {any} */ (undefined) });
    assert.deepEqual(session._parameters, { temperature: 0.5 });
});

test('AbstractChatSession: withSkills registers skills as tools and adds load_skills (Part 3)', () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    const skills = [{ name: 'skill1' }];
    session.withSkills({ skills });
    assert.ok(session._tools.includes(skills[0]), 'withSkills must register the skill into the tool library');
    assert.ok(session._tools.some((/** @type {any} */ t) => t && t.name === 'load_skills'),
        'withSkills must also register the load_skills capability tool');
});

test('AbstractChatSession: withMemory attaches a MemoryManager and sets _memoryClient', async () => {
    const { MemoryProvider, LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    const provider = new LocalFileMemoryProvider();
    session.withMemory({ provider, options: { syncInterval: 1000 } });
    assert.ok(session._memoryManager, 'withMemory must populate _memoryManager');
    assert.equal(session._memoryClient, stubSdk,
        'withMemory must default _memoryClient to this.client when no options.client is given');
});

test('AbstractChatSession: withMemory(options.client) takes precedence over this.client', async () => {
    const { LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    const customClient = { session() {} };
    session.withMemory({ provider: new LocalFileMemoryProvider(), options: { client: customClient } });
    assert.equal(session._memoryClient, customClient);
});

test('AbstractChatSession: withMemory does not auto-wire client.embed on OPENCODE (no /embeddings route)', async () => {
    const { LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
    const opencodeClient = { session() {}, embed() {}, provider: ProviderType.OPENCODE };
    const session = new MinimalSession(ProviderType.OPENCODE, 'deepseek-v4-flash', stubEmitter, opencodeClient);
    session.withMemory({ provider: new LocalFileMemoryProvider(), options: { syncInterval: 1000 } });
    assert.equal((/** @type {any} */ (session._memoryManager)).embedder, null,
        'OPENCODE must not auto-wire client.embed — the gateway 404s with its SPA HTML');
});

test('AbstractChatSession: withMemory keeps the embedder for embedding-capable backends; explicit embedder wins', async () => {
    const { LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
    const openaiClient = { session() {}, embed() {}, provider: ProviderType.OPENAI };
    const s1 = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, openaiClient);
    s1.withMemory({ provider: new LocalFileMemoryProvider(), options: { syncInterval: 1000 } });
    assert.equal(typeof (/** @type {any} */ (s1._memoryManager)).embedder, 'function', 'OPENAI must keep the auto-wired embedder');

    const s2 = new MinimalSession(ProviderType.OPENCODE, 'deepseek-v4-flash', stubEmitter, opencodeStub());
    const explicit = () => [1, 2, 3];
    s2.withMemory({ provider: new LocalFileMemoryProvider(), options: { syncInterval: 1000, embedder: explicit } });
    assert.equal((/** @type {any} */ (s2._memoryManager)).embedder, explicit, 'an explicit options.embedder must override the backend gate');
});

test('AbstractChatSession: withMemory(options.embedder: null) explicitly opts OUT of the auto-wired embedder', async () => {
    const { LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
    const openaiClient = { session() {}, embed() {}, provider: ProviderType.OPENAI };
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, openaiClient);
    session.withMemory({ provider: new LocalFileMemoryProvider(), options: { syncInterval: 1000, embedder: null } });
    assert.equal((/** @type {any} */ (session._memoryManager)).embedder, null,
        'an explicit embedder:null must opt the manager out of the auto-wired embedder');
    assert.equal((/** @type {any} */ (session._memoryComponent)).engine.embedder, null,
        'an explicit embedder:null must opt the load/save engine out too — it is the lazy `load_memory` path');
});

test('AbstractChatSession: step() throws when _adapter is not set', async () => {
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    await assert.rejects(
        () => session.step({ messages: [] }).next(),
        /AbstractChatSession\.step: no _adapter set/,
        'AbstractChatSession.step must throw when the subclass has no _adapter'
    );
});

// =============================================================================
// SECTION 2: INHERITANCE — ALL FOUR BACKENDS
// =============================================================================

/** @type {Array<{ name: string, Ctor: any, args: any }>} */
const cases = [
    { name: 'OAI', Ctor: OaiChatSession, args: { client: stubSdk, model: 'gpt-4o-mini', eventEmitter: stubEmitter } },
    { name: 'AAI', Ctor: AaiChatSession, args: { client: stubSdk, model: 'claude-3-5-sonnet-20241022', eventEmitter: stubEmitter } },
    { name: 'GAI', Ctor: GaiChatSession, args: { client: stubSdk, model: 'gemini-2.0-flash', eventEmitter: stubEmitter } },
    { name: 'JAI', Ctor: JaiChatSession, args: { httpClient: stubSdk, profile: 'jai-gpt-4o', eventEmitter: stubEmitter, profileManager: stubProfileManager } }
];

for (const { name, Ctor, args } of cases) {
    test(`${name}: ChatSession extends AbstractChatSession (prototype chain)`, () => {
        const session = new Ctor(args);
        assert.ok(session instanceof AbstractChatSession,
            `${name} ChatSession must be an instance of AbstractChatSession`);
    });

    test(`${name}: ChatSession.provider is set via super(...)`, () => {
        const session = new Ctor(args);
        const expected = name === 'OAI' ? ProviderType.OPENAI
            : name === 'AAI' ? ProviderType.ANTHROPIC
            : name === 'GAI' ? ProviderType.GOOGLE_GENAI
            : ProviderType.JAI;
        assert.equal(session.provider, expected);
    });

    test(`${name}: withMemory from the base class is available on the subclass`, async () => {
        const { LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
        const session = new Ctor(args);
        const result = session.withMemory({ provider: new LocalFileMemoryProvider() });
        assert.equal(result, session, 'withMemory must return the session for chaining');
        assert.ok(session._memoryManager, `${name} must inherit withMemory and populate _memoryManager`);
    });

    test(`${name}: withSkills registers skills as tools and adds load_skills`, () => {
        const session = new Ctor(args);
        const skills = [{ name: 'skill1' }];
        session.withSkills({ skills });
        assert.ok(session._tools.includes(skills[0]),
            `${name}: withSkills must register the skill into the tool library`);
        assert.ok(session._tools.some((/** @type {any} */ t) => t && t.name === 'load_skills'),
            `${name}: withSkills must also register the load_skills capability tool`);
    });
}

test('JAI client: BaseChatSession extends AbstractChatSession (transitive chain)', () => {
    const baseJai = new JaiBaseChatSession({ httpClient: /** @type {any} */ ({ getEventEmitter() {} }), profile: 'jai-gpt-4o', profileManager: /** @type {any} */ ({ isSupported() { return true; } }) });
    assert.ok(baseJai instanceof AbstractChatSession);
    assert.equal(baseJai.provider, ProviderType.JAI);
});

test('JAI: ChatSession in jai.mjs is a subclass of JaiBaseChatSession AND AbstractChatSession', () => {
    const jai = new JaiChatSession({ httpClient: stubSdk, profile: 'jai-gpt-4o', eventEmitter: stubEmitter, profileManager: stubSdk });
    assert.ok(jai instanceof JaiBaseChatSession, 'JAI ChatSession must extend the JAI client BaseChatSession');
    assert.ok(jai instanceof AbstractChatSession, 'JAI ChatSession must transitively extend AbstractChatSession');
});

// =============================================================================
// =============================================================================

test('OAI: withParameters (function form) threads the ParameterBuilder and persists the built object', () => {
    const session = new OaiChatSession({ client: stubSdk, model: 'gpt-4o-mini', eventEmitter: stubEmitter });
    const result = session.withParameters({ params: (/** @type {any} */ b) => b.temperature({ v: 0.3 }).maxTokens({ v: 64 }) });
    assert.equal(result, session);
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.3);
    assert.equal((/** @type {any} */ (session._parameters)).max_tokens, 64);
});

test('AAI: withParameters (function form) threads the ParameterBuilder and persists the built object', () => {
    const session = new AaiChatSession({ client: stubSdk, model: 'claude-3-5-sonnet-20241022', eventEmitter: stubEmitter });
    session.withParameters({ params: (/** @type {any} */ b) => b.temperature({ v: 0.2 }).maxTokens({ v: 32 }) });
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.2);
    assert.equal((/** @type {any} */ (session._parameters)).max_tokens, 32);
});

test('GAI: withParameters (function form) threads the ParameterBuilder and persists the built object', () => {
    const session = new GaiChatSession({ client: stubSdk, model: 'gemini-2.0-flash', eventEmitter: stubEmitter });
    session.withParameters({ params: (/** @type {any} */ b) => b.temperature({ v: 0.1 }).maxTokens({ v: 16 }) });
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.1);
    assert.equal((/** @type {any} */ (session._parameters)).maxOutputTokens, 16);
});

test('JAI: withParameters (builder function) persists both the raw and the built param objects', () => {
    const session = new JaiChatSession({ httpClient: stubSdk, profile: 'jai-gpt-4o', eventEmitter: stubEmitter, profileManager: stubProfileManager });
    session.withParameters({ params: (/** @type {any} */ b) => b.temperature({ v: 0.4 }).topP({ v: 0.95 }) });
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.4, 'JAI built parameters must use wire-format keys');
    assert.equal((/** @type {any} */ (session._parameters)).topP, 0.95);
});

// =============================================================================
// =============================================================================

test('Leftover 1: every backend stores the parent MerciClient as this.client, not the vendor SDK', () => {
    const stubMerciClient = new EventEmitter();
    const vendorSdk = { chat: { completions: { create: async () => {} } } };
    for (const { name, Ctor, args } of cases) {
        const session = name === 'JAI'
            ? new Ctor({ httpClient: vendorSdk, profile: 'jai-gpt-4o', eventEmitter: stubMerciClient, profileManager: args.profileManager })
            : new Ctor({ client: vendorSdk, model: 'gpt-4o-mini', eventEmitter: stubMerciClient });
        assert.strictEqual(session.client, stubMerciClient,
            `${name}: session.client must be the parent MerciClient, not the vendor SDK`);
    }
});

test('Leftover 1: withMemory resolves _memoryClient to the parent MerciClient for all four backends', async () => {
    const { LocalFileMemoryProvider } = await import('../lib/agentic/memory/index.mjs');
    const stubMerciClient = new EventEmitter();
    const vendorSdk = { chat: { completions: { create: async () => {} } } };
    const provider = new LocalFileMemoryProvider();
    for (const { name, Ctor, args } of cases) {
        const session = name === 'JAI'
            ? new Ctor({ httpClient: vendorSdk, profile: 'jai-gpt-4o', eventEmitter: stubMerciClient, profileManager: args.profileManager })
            : new Ctor({ client: vendorSdk, model: 'gpt-4o-mini', eventEmitter: stubMerciClient });
        session.withMemory({ provider });
        assert.strictEqual(session._memoryClient, stubMerciClient,
            `${name}: _memoryClient must be the parent MerciClient (so distill can call .session()), got the vendor SDK`);
    }
});

test('Leftover 1: getVendorClient returns the vendor SDK for OAI/AAI/GAI, null for JAI', () => {
    const stubMerciClient = new EventEmitter();
    const vendorSdk = { chat: { completions: { create: async () => {} } } };
    for (const { name, Ctor, args } of cases) {
        const session = name === 'JAI'
            ? new Ctor({ httpClient: vendorSdk, profile: 'jai-gpt-4o', eventEmitter: stubMerciClient, profileManager: args.profileManager })
            : new Ctor({ client: vendorSdk, model: 'gpt-4o-mini', eventEmitter: stubMerciClient });
        if (name === 'JAI') {
            assert.equal(session.getVendorClient(), null,
                `${name}: getVendorClient must be null (JAI transport has no separate vendor SDK)`);
        } else {
            assert.strictEqual(session.getVendorClient(), vendorSdk,
                `${name}: getVendorClient must be the vendor SDK`);
        }
    }
});

test('AbstractChatSession: every backend exposes session._tools (used by agentic-core)', () => {
    for (const { name, Ctor, args } of cases) {
        const session = new Ctor(args);
        assert.ok(Array.isArray(session._tools), `${name}: session._tools must be an array`);
        assert.equal(typeof session.provider, 'string', `${name}: session.provider must be a string`);
        assert.equal(typeof session.model, 'string', `${name}: session.model must be a string`);
    }
});

test('AbstractChatSession: withTools returns the session for fluent chaining', () => {
    for (const { name, Ctor, args } of cases) {
        const session = new Ctor(args);
        const result = session.withTools({ tools: [{ name: 'foo' }] });
        assert.equal(result, session, `${name}: withTools must return the session`);
    }
});

test('AbstractChatSession: withSystemMessage returns the session for fluent chaining', () => {
    for (const { name, Ctor, args } of cases) {
        const session = new Ctor(args);
        const result = session.withSystemMessage('content');
        assert.equal(result, session, `${name}: withSystemMessage must return the session`);
    }
});

// =============================================================================
// =============================================================================

test('Leftover 2: AbstractChatSession defaults to the streaming retry policy, InactivityTimeoutPolicy, and EventEmitterApiObserver', async () => {
    const { ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const { InactivityTimeoutPolicy } = await import('../lib/support/stream-timeout.mjs');
    const { EventEmitterApiObserver } = await import('../lib/support/api-observer.mjs');
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);
    assert.ok(session._retryPolicy instanceof ExponentialBackoffPolicy,
        'AbstractChatSession must default _retryPolicy to the streaming retry preset (retries ON)');
    assert.equal(session._retryPolicy.maxRetries, 2);
    assert.ok(session._streamTimeoutPolicy instanceof InactivityTimeoutPolicy,
        'AbstractChatSession must default _streamTimeoutPolicy to InactivityTimeoutPolicy');
    assert.ok(session._apiObserver instanceof EventEmitterApiObserver,
        'AbstractChatSession must default _apiObserver to EventEmitterApiObserver');
});

test('Leftover 2: withRetryPolicy / withStreamTimeout / withApiObserver setters swap and return the session', async () => {
    const { NoRetryPolicy, ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const { InactivityTimeoutPolicy } = await import('../lib/support/stream-timeout.mjs');
    const { EventEmitterApiObserver } = await import('../lib/support/api-observer.mjs');
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', stubEmitter, stubSdk);

    const newRetry = new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 50, maxDelayMs: 1000 });
    const newTimeout = new InactivityTimeoutPolicy({ timeoutMs: 5000 });
    const newObserver = new EventEmitterApiObserver({ emitter: stubEmitter });

    assert.equal(session.withRetryPolicy({ policy: newRetry }), session, 'withRetryPolicy must return the session');
    assert.equal(session.withStreamTimeout({ policy: newTimeout }), session, 'withStreamTimeout must return the session');
    assert.equal(session.withApiObserver({ observer: newObserver }), session, 'withApiObserver must return the session');

    assert.strictEqual(session._retryPolicy, newRetry);
    assert.strictEqual(session._streamTimeoutPolicy, newTimeout);
    assert.strictEqual(session._apiObserver, newObserver);
    assert.ok(!(session._retryPolicy instanceof NoRetryPolicy));
});

test('Leftover 2: default EventEmitterApiObserver forwards onRequest to the session emitter', () => {
    /** @type {any[]} */
    const events = [];
    const localEmitter = new EventEmitter();
    localEmitter.on('api_request', m => events.push(m));
    const session = new MinimalSession(ProviderType.OPENAI, 'gpt-4o-mini', localEmitter, stubSdk);
    session._apiObserver.onRequest({ meta: { model: 'gpt-4o-mini', messages: [] } });
    assert.equal(events.length, 1);
    assert.equal(events[0].model, 'gpt-4o-mini');
});

test('Leftover 2: default EventEmitterApiObserver with null emitter is a no-op (defensive)', async () => {
    const { EventEmitterApiObserver } = await import('../lib/support/api-observer.mjs');
    const observer = new EventEmitterApiObserver({ emitter: null });
    observer.onRequest(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { model: 'x' } }));
    observer.onResponse(/** @type {{ meta: any; runContext: any; }} */ ({ meta: { status: 200, ok: true } }));
    observer.onError({ meta: { error: new Error('boom') } });
});

test('Leftover 2: OAI.embed default retry policy is ExponentialBackoffPolicy(embedMaxRetries, embedInitialDelay)', async () => {
    const { ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const { EMBED_MAX_RETRIES, EMBED_INITIAL_DELAY_MS } = await import('../lib/core/constants/limits.mjs');
    const client = new (await import('../lib/backends/oai.mjs')).MerciClient({ options: { apiKey: 'sk-test' } });
    assert.ok(client.embedRetryPolicy instanceof ExponentialBackoffPolicy,
        'OAI client.embedRetryPolicy must default to ExponentialBackoffPolicy');
    assert.equal(client.embedRetryPolicy.maxRetries, EMBED_MAX_RETRIES);
    assert.equal(client.embedRetryPolicy.initialDelayMs, EMBED_INITIAL_DELAY_MS);
});

test('Leftover 2: the transport field is non-enumerable so inspect cannot leak the apiKey', async () => {
    const { MerciClient: Oai } = await import('../lib/backends/oai.mjs');
    const { MerciClient: Aai } = await import('../lib/backends/aai.mjs');
    const { MerciClient: Gai } = await import('../lib/backends/gai.mjs');
    for (const [name, Ctor, field] of /** @type {Array<[string, any, string]>} */ ([['OAI', Oai, 'transport'], ['AAI', Aai, 'transport'], ['GAI', Gai, 'transport']])) {
        const client = new Ctor({ options: { apiKey: 'sk-test' } });
        assert.ok(client[field], `${name}: direct access must still work`);
        assert.ok(!Object.keys(client).includes(field),
            `${name}: the vendor client must not be an own enumerable property (console.log/inspect leak)`);
        assert.ok(!JSON.stringify(client).includes('sk-test'),
            `${name}: serializing the client must not expose the apiKey`);
    }
});

test('Leftover 2: OAI.embed accepts a custom retry policy via options.embedRetryPolicy and withEmbedRetryPolicy setter', async () => {
    const { ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const custom = new ExponentialBackoffPolicy({ maxRetries: 7, initialDelayMs: 10, maxDelayMs: 100 });
    const client = new (await import('../lib/backends/oai.mjs')).MerciClient({ options: { apiKey: 'sk-test', embedRetryPolicy: custom } });
    assert.strictEqual(client.embedRetryPolicy, custom);

    const replaced = new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 });
    const result = client.withEmbedRetryPolicy({ policy: replaced });
    assert.equal(result, client, 'withEmbedRetryPolicy must return the client for fluent chaining');
    assert.strictEqual(client.embedRetryPolicy, replaced);
});

test('Leftover 2: JAI agentic ChatSession forwards only api_retry (transport owns request/response/error)', () => {
    const stubMerciClient = new EventEmitter();
    const vendorSdk = { getEventEmitter() { return stubMerciClient; } };
    const session = new JaiChatSession({ httpClient: /** @type {any} */ (vendorSdk), profile: 'jai-gpt-4o', eventEmitter: stubMerciClient, profileManager: stubProfileManager });
    /** @type {any[]} */
    const events = [];
    stubMerciClient.on('api_request', () => events.push('request'));
    stubMerciClient.on('api_response', () => events.push('response'));
    stubMerciClient.on('api_retry', () => events.push('retry'));
    (/** @type {any} */ (session._apiObserver)).onRequest({ meta: { model: 'jai-gpt-4o' } });
    (/** @type {any} */ (session._apiObserver)).onResponse({ meta: { status: 200, ok: true } });
    (/** @type {any} */ (session._apiObserver)).onError({ meta: { error: new Error('x') } });
    (/** @type {any} */ (session._apiObserver)).onRetry({ meta: { vendor: 'JAI', attempt: 1, nextDelayMs: 5, error: new Error('y') } });
    assert.deepEqual(events, ['retry'], 'JAI observer must forward only api_retry — the transport owns the rest');
});

test('Leftover 2: JAI base ChatSession overrides _streamTimeoutPolicy with httpClient.streamTimeout', async () => {
    const { InactivityTimeoutPolicy } = await import('../lib/support/stream-timeout.mjs');
    const customTimeout = 17_000;
    const httpClient = {
        streamTimeout: customTimeout,
        getEventEmitter() { return null; }
    };
    const baseSession = new JaiBaseChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'jai-gpt-4o', profileManager: stubProfileManager });
    assert.ok(baseSession._streamTimeoutPolicy instanceof InactivityTimeoutPolicy);
    assert.equal(baseSession._streamTimeoutPolicy.timeoutMs, customTimeout,
        'JAI base ChatSession must override the default stream timeout policy with httpClient.streamTimeout');
});

test('Leftover 2: every backend ChatSession exposes a working _apiObserver that forwards to its event emitter', () => {
    const stubMerciClient = new EventEmitter();
    const vendorSdk = { chat: { completions: { create: async () => {} } } };
    /** @type {any[]} */
    const events = [];
    stubMerciClient.on('api_request', m => events.push(m));
    stubMerciClient.on('api_response', m => events.push(m));
    stubMerciClient.on('error', m => events.push(m));
    for (const { name, Ctor, args } of cases) {
        const session = name === 'JAI'
            ? new Ctor({ httpClient: vendorSdk, profile: 'jai-gpt-4o', eventEmitter: stubMerciClient, profileManager: args.profileManager })
            : new Ctor({ client: vendorSdk, model: 'gpt-4o-mini', eventEmitter: stubMerciClient });
        assert.ok(session._apiObserver, `${name}: session must expose _apiObserver`);
        session._apiObserver.onRequest({ meta: { model: 'x' } });
        session._apiObserver.onResponse({ meta: { status: 200, ok: true } });
        session._apiObserver.onError({ meta: { error: new Error('e2e') } });
    }
    assert.equal(events.length, 9,
        'non-JAI backends forward request/response/error; JAI transport owns its own');
});
