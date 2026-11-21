// @ts-check

import { describe, it, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { isAbsolute, basename } from 'node:path';

import {
    ProviderType,
    ProtocolType,
    protocolsFor,
    sessionProtocolsFor,
    defaultProtocolFor,
} from '../lib/core/constants/index.mjs';
import { resolveProtocol, protocolFromEnv, loadCredentials, ensureEnvLoaded } from '../lib/support/utils.mjs';
import { resolveProvider } from '../lib/index.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { ChatSession as JaiSession } from '../lib/backends/jai.mjs';
import { ChatSession as JaiVendorSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { ChatSession as AaiSession } from '../lib/backends/aai.mjs';
import { ChatSession as OaiSession } from '../lib/backends/oai.mjs';

// ─── Registry ───────────────────────────────────────────────────────────────

describe('ProtocolType registry', () => {
    it('names every wire protocol', () => {
        assert.equal(ProtocolType.CHAT, 'chat');
        assert.equal(ProtocolType.RESPONSES, 'responses');
        assert.equal(ProtocolType.TASK, 'task');
        assert.equal(ProtocolType.COMPLETIONS, 'completions');
        assert.equal(ProtocolType.MESSAGES, 'messages');
        assert.equal(ProtocolType.GENERATE_CONTENT, 'generateContent');
    });

    it('lists session protocols per backend with the right defaults', () => {
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.JAI }), ['chat', 'responses']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.OPENAI }), ['completions', 'responses']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.OPENROUTER }), ['completions', 'responses']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.OPENCODE }), ['completions', 'responses']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.LOCAL }), ['completions']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.ANTHROPIC }), ['messages']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.GOOGLE_GENAI }), ['generateContent']);
        assert.deepEqual(sessionProtocolsFor({ provider: ProviderType.VERTEX }), ['generateContent']);

        assert.equal(defaultProtocolFor({ provider: ProviderType.JAI }), 'chat');
        assert.equal(defaultProtocolFor({ provider: ProviderType.OPENAI }), 'completions');
        assert.equal(defaultProtocolFor({ provider: ProviderType.ANTHROPIC }), 'messages');
        assert.equal(defaultProtocolFor({ provider: ProviderType.GOOGLE_GENAI }), 'generateContent');
    });

    it('keeps task in the JAI registry but out of the session set (transport surface)', () => {
        assert.ok(protocolsFor({ provider: ProviderType.JAI }).includes(ProtocolType.TASK));
        assert.ok(!sessionProtocolsFor({ provider: ProviderType.JAI }).includes(ProtocolType.TASK));
    });

    it('has no protocols for an unknown backend', () => {
        assert.deepEqual(protocolsFor({ provider: 'nope' }), []);
    });
});

// ─── resolveProtocol ────────────────────────────────────────────────────────

describe('resolveProtocol', () => {
    it('defaults to the backend session protocol', () => {
        assert.equal(resolveProtocol({ provider: ProviderType.JAI }), 'chat');
        assert.equal(resolveProtocol({ provider: ProviderType.OPENAI }), 'completions');
        assert.equal(resolveProtocol({ provider: ProviderType.ANTHROPIC }), 'messages');
    });

    it('accepts supported protocols', () => {
        assert.equal(resolveProtocol({ provider: ProviderType.JAI, protocol: 'responses', session: true }), 'responses');
        assert.equal(resolveProtocol({ provider: ProviderType.OPENAI, protocol: 'responses' }), 'responses');
        assert.equal(resolveProtocol({ provider: ProviderType.JAI, protocol: 'task' }), 'task');
    });

    it('rejects a protocol the backend does not speak (ConfigurationError)', () => {
        assert.throws(() => resolveProtocol({ provider: ProviderType.ANTHROPIC, protocol: 'responses' }), (err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, /Unsupported protocol 'responses' for provider 'anthropic'/);
            assert.match(err.message, /'messages'/);
            return true;
        });
        assert.throws(() => resolveProtocol({ provider: ProviderType.GOOGLE_GENAI, protocol: 'chat' }), ConfigurationError);
    });

    it('rejects transport protocols for sessions with a client.tasks hint', () => {
        assert.throws(() => resolveProtocol({ provider: ProviderType.JAI, protocol: 'task', session: true }), (err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, /transport protocol/);
            assert.match(err.message, /client\.tasks/);
            return true;
        });
    });

    it('rejects an unknown backend loudly', () => {
        assert.throws(() => resolveProtocol({ provider: 'nope', protocol: 'chat' }), (err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, /Unknown provider/);
            return true;
        });
    });
});

// ─── withProtocol on real sessions ──────────────────────────────────────────

const jaiHttpClient = () => ({
    streamTimeout: 1000,
    getEventEmitter: () => new EventEmitter(),
    _fetchWithRetry: async () => ({ body: new ReadableStream({ start(c) { c.close(); } }) }),
});

describe('withProtocol()', () => {
    it('sets a supported protocol on a JAI session and returns this', () => {
        const session = new JaiSession({ httpClient: /** @type {any} */ (jaiHttpClient()), profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        assert.equal(session.protocol, 'chat', 'default protocol is chat');
        assert.equal(session.withProtocol({ protocol: 'responses' }), session, 'chainable');
        assert.equal(session.protocol, 'responses');
    });

    it('rejects the transport protocol on a JAI session', () => {
        const session = new JaiSession({ httpClient: /** @type {any} */ (jaiHttpClient()), profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        assert.throws(() => session.withProtocol({ protocol: 'task' }), /client\.tasks/);
    });

    it('rejects a foreign protocol on an Anthropic session', () => {
        const session = new AaiSession({ client: /** @type {any} */ ({}), model: 'claude', eventEmitter: new EventEmitter() });
        assert.equal(session.protocol, 'messages');
        assert.throws(() => session.withProtocol({ protocol: 'responses' }), ConfigurationError);
    });

    it('switches an OAI session to responses', () => {
        const session = new OaiSession({ client: /** @type {any} */ ({}), model: 'gpt-5', eventEmitter: new EventEmitter(), provider: ProviderType.OPENAI });
        assert.equal(session.protocol, 'completions');
        session.withProtocol({ protocol: 'responses' });
        assert.equal(session.protocol, 'responses');
    });
});

// ─── secret.env threading ───────────────────────────────────────────────────

describe('protocolFromEnv / loadCredentials', () => {
    /** @param {() => void} fn */
    /** @param {{fn: *}} arg0 */
    /** @param {{fn: *}} arg0 */
    const withEnv = ({ fn }) => {
        const saved = { PROTOCOL: process.env.PROTOCOL, OPENAI_PROTOCOL: process.env.OPENAI_PROTOCOL, PROVIDER: process.env.PROVIDER };
        try { fn(); } finally {
            if (saved.PROTOCOL === undefined) delete process.env.PROTOCOL; else process.env.PROTOCOL = saved.PROTOCOL;
            if (saved.OPENAI_PROTOCOL === undefined) delete process.env.OPENAI_PROTOCOL; else process.env.OPENAI_PROTOCOL = saved.OPENAI_PROTOCOL;
            if (saved.PROVIDER === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = saved.PROVIDER;
        }
    };

    it('reads PROTOCOL for every backend', () => withEnv({ fn: () => {
        process.env.PROTOCOL = 'responses';
        delete process.env.OPENAI_PROTOCOL;
        assert.equal(protocolFromEnv({ provider: ProviderType.JAI }), 'responses');
        assert.equal(protocolFromEnv({ provider: ProviderType.OPENCODE }), 'responses');
        assert.equal(protocolFromEnv({ provider: ProviderType.OPENAI }), 'responses');
    } }));

    it('keeps OPENAI_PROTOCOL as the OPENAI-scoped override', () => withEnv({ fn: () => {
        process.env.PROTOCOL = 'responses';
        process.env.OPENAI_PROTOCOL = 'completions';
        assert.equal(protocolFromEnv({ provider: ProviderType.OPENAI }), 'completions', 'OPENAI_PROTOCOL wins for OPENAI');
        assert.equal(protocolFromEnv({ provider: ProviderType.OPENROUTER }), 'responses', 'other backends take the generic key');
    } }));

    it('returns undefined when neither key is set', () => withEnv({ fn: () => {
        delete process.env.PROTOCOL;
        delete process.env.OPENAI_PROTOCOL;
        assert.equal(protocolFromEnv({ provider: ProviderType.JAI }), undefined);
    } }));

    it('threads the protocol into credentials', () => withEnv({ fn: () => {
        process.env.PROTOCOL = 'responses';
        const jai = /** @type {any} */ (loadCredentials({ provider: ProviderType.JAI }));
        const aai = /** @type {any} */ (loadCredentials({ provider: ProviderType.ANTHROPIC }));
        const gai = /** @type {any} */ (loadCredentials({ provider: ProviderType.GOOGLE_GENAI }));
        assert.equal(jai.protocol, 'responses');
        assert.equal(aai.protocol, 'responses');
        assert.equal(gai.protocol, 'responses');
    } }));

    it('JAI credentials carry the refresh-persistence target (secret.env / JAI_TOKEN)', () => withEnv({ fn: () => {
        const jai = /** @type {any} */ (loadCredentials({ provider: ProviderType.JAI }));
        assert.equal(jai.tokenPersistKey, 'JAI_TOKEN');
        assert.ok(isAbsolute(jai.tokenPersistFile), 'the persist file must be absolute, not cwd-relative');
        assert.equal(basename(jai.tokenPersistFile), 'secret.env');
    } }));

    it('resolveProvider returns an explicit argument as-is', () => {
        assert.equal(resolveProvider({ provider: 'anthropic' }), 'anthropic');
    });

    it('resolveProvider reads PROVIDER and normalizes it', () => withEnv({ fn: () => {
        process.env.PROVIDER = 'GOOGLE_GENAI';
        assert.equal(resolveProvider(), 'google_genai');
    } }));

    it('resolveProvider throws when PROVIDER is unset', () => withEnv({ fn: () => {
        ensureEnvLoaded();
        delete process.env.PROVIDER;
        assert.throws(() => resolveProvider(), (err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, /PROVIDER/);
            return true;
        });
    } }));

    it('resolveProvider rejects an unknown PROVIDER and lists the valid ones', () => withEnv({ fn: () => {
        process.env.PROVIDER = 'nope';
        assert.throws(() => resolveProvider(), (err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, /Unknown provider/);
            assert.match(err.message, /jai, openrouter, openai, local, google_genai, vertex, anthropic, opencode/);
            return true;
        });
    } }));
});

// ─── JAI endpoint selection ─────────────────────────────────────────────────

describe('JAI endpoint follows the session protocol', () => {
    /**
 * @param {{configure?: (session: any) => void}} arg0
 * @returns {Promise<string|null>}
 */
    async function capturePath({ configure = () => {} } = {}) {
        let capturedPath = null;
        const httpClient = {
            streamTimeout: 1000,
            getEventEmitter: () => new EventEmitter(),
            /** @param {{path: *}} arg0 */
            _fetchWithRetry: async ({ path }) => {
                capturedPath = path;
                return { body: new ReadableStream({ start(c) { c.close(); } }) };
            },
        };
        const session = new JaiVendorSession({ httpClient: /** @type {any} */ (httpClient), profile: 'm', profileManager: null });
        configure(session);
        for await (const _event of session.stream({ initialInput: [{ type: 'user_message', content: 'hi' }] })) { /* drain */ }
        return capturedPath;
    }

    it('posts chat to /llm/chat/stream/v9 by default', async () => {
        assert.equal(await capturePath(), '/llm/chat/stream/v9');
    });

    it('posts responses to /llm/responses/stream/v9 after withProtocol', async () => {
        assert.equal(await capturePath({ configure: /** @type {(...args: any[]) => any} */ ((s) => s.withProtocol({ protocol: 'responses' })) }), '/llm/responses/stream/v9');
    });
});

test('registry protocols match every ProviderType', () => {
    for (const provider of Object.values(ProviderType)) {
        assert.ok(protocolsFor({ provider }).length > 0, `${provider} must declare at least one protocol`);
    }
});