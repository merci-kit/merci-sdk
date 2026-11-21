// @ts-check

/**
 * The standards/providers registry must describe what 0.12.0 already does —
 * these tests pin the derived helpers to the pre-refactor tables, so a drifted
 * descriptor (a protocol, an env key, a base URL, a capability flag) fails
 * here instead of at runtime.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ProtocolType,
    SUPPORTED_PROTOCOLS,
    TRANSPORT_PROTOCOLS,
    protocolsFor,
    sessionProtocolsFor,
    defaultProtocolFor,
    isStandard,
    EnvKey,
    DEFAULT_OPENAI_URL,
    DEFAULT_OPENROUTER_URL,
    DEFAULT_LOCAL_URL,
    DEFAULT_OPENCODE_URL,
    DEFAULT_OPENCODE_MODEL,
    ENV_FILE_RELATIVE_PATH,
    ProviderType,
    StandardType,
    PROVIDERS,
    STANDARDS,
    providerDescriptorFor,
    standardDescriptorFor,
    standardFor,
    providersForStandard,
} from '../lib/core/constants/index.mjs';
import { getDecisionModel, getDefaultModel, getToolModel, initializeClient } from '../lib/index.mjs';
import { ensureEnvLoaded, getEmbeddingModel, loadCredentials } from '../lib/support/utils.mjs';
import { UnifiedParameterBuilder } from '../lib/messaging/unified-parameter.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { NATIVE_PROVIDERS as NATIVE_SEARCH_PROVIDERS } from '../lib/agentic/websearch/engines.mjs';
import { NATIVE_PROVIDERS as NATIVE_SCRAPE_PROVIDERS } from '../lib/agentic/webscrape/engines.mjs';
import { PDF_MEDIA_PROVIDERS } from '../lib/messaging/messages.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';

/** The 0.12.0 protocol table, written out rather than derived. */
const EXPECTED_PROTOCOLS = Object.freeze({
    jai: ['chat', 'responses', 'task'],
    openrouter: ['completions', 'responses'],
    openai: ['completions', 'responses'],
    local: ['completions'],
    google_genai: ['generateContent'],
    vertex: ['generateContent'],
    anthropic: ['messages'],
    opencode: ['completions', 'responses'],
});

/** The 0.12.0 capability table, written out rather than derived from the registry. */
const EXPECTED_CAPABILITIES = Object.freeze({
    nativeWebSearch: ['anthropic', 'google_genai', 'openai', 'openrouter', 'vertex'],
    nativeWebScrape: ['anthropic', 'google_genai', 'jai', 'openrouter', 'vertex'],
    pdfMedia: ['anthropic', 'google_genai', 'jai', 'openai', 'openrouter', 'vertex'],
    embeddings: ['google_genai', 'jai', 'local', 'openai', 'opencode', 'openrouter', 'vertex'],
    promptCache: ['anthropic'],
});

/** Directory of lib/support, so the JAI persist path can be asserted exactly. */
const SUPPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/support');

/**
 * Runs `fn` with `assign` merged into process.env, restoring every touched key
 * afterwards. A value of `undefined` unsets the key.
 * @param {{assign: Record<string, string|undefined>, fn: () => (void|Promise<void>)}} arg0
 */
async function withEnv({ assign, fn }) {
    /** @type {Record<string, string|undefined>} */
    const saved = {};
    for (const key of Object.keys(assign)) {
        saved[key] = process.env[key];
        if (assign[key] === undefined) delete process.env[key];
        else process.env[key] = assign[key];
    }
    try {
        await fn();
    } finally {
        for (const key of Object.keys(assign)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}


describe('ProviderType / StandardType registry', () => {
    it('ProviderType names exactly the eight providers, in registry order', () => {
        assert.deepEqual(Object.keys(ProviderType), [
            'JAI', 'OPENROUTER', 'OPENAI', 'LOCAL', 'GOOGLE_GENAI', 'VERTEX', 'ANTHROPIC', 'OPENCODE',
        ]);
        assert.deepEqual(Object.values(ProviderType), Object.keys(PROVIDERS));
        assert.equal(Object.keys(PROVIDERS).length, 8);
    });

    it('has four standards and every provider names one of them', () => {
        assert.equal(Object.keys(STANDARDS).length, 4);
        assert.deepEqual(Object.values(StandardType).sort(), ['aai', 'gai', 'jai', 'oai']);
        const standards = new Set(Object.values(StandardType));
        for (const [id, descriptor] of Object.entries(PROVIDERS)) {
            assert.equal(descriptor.id, id, `${id}: descriptor id must match its key`);
            assert.ok(standards.has(descriptor.standard), `${id}: ${descriptor.standard} is not a StandardType value`);
            assert.equal(standardFor({ provider: id }), descriptor.standard, `${id}: standardFor must agree`);
        }
        assert.equal(standardDescriptorFor({ standard: StandardType.JAI })?.id, 'jai');
        assert.equal(standardDescriptorFor({ standard: 'nope' }), null);
        assert.equal(providerDescriptorFor({ provider: 'nope' }), null);
        assert.equal(standardFor({ provider: 'nope' }), null);
    });

    it('locks every standard protocol to a ProtocolType value', () => {
        const protocols = new Set(Object.values(ProtocolType));
        for (const standard of Object.values(STANDARDS)) {
            for (const protocol of standard.protocols) {
                assert.ok(protocols.has(protocol), `${standard.id}: ${protocol} is not a ProtocolType value`);
            }
            assert.deepEqual(standard.transportProtocols, standard.transportProtocols.filter((p) => standard.protocols.includes(p)));
        }
    });
});


describe('UnifiedParameterBuilder standard identity', () => {
    it('derives standardFor(provider) and warns with both ids', () => {
        /** @type {Record<string, (b: any) => any>} */
        const UNSUPPORTED = {
            [StandardType.OAI]: (b) => b.topK({ v: 40 }),
            [StandardType.AAI]: (b) => b.stream(true),
            [StandardType.GAI]: (b) => b.stream(true),
            [StandardType.JAI]: (b) => b.stream(true),
        };
        for (const provider of Object.values(ProviderType)) {
            const standard = /** @type {string} */ (standardFor({ provider }));
            const emitter = new EventEmitter();
            /** @type {any[]} */
            const warnings = [];
            emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (e) => warnings.push(e));
            const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider });
            assert.equal(b.standard, standard, `${provider}: builder.standard`);
            UNSUPPORTED[standard](b);
            assert.equal(warnings.length, 1, `${provider}: exactly one warning`);
            assert.equal(warnings[0].provider, provider, `${provider}: warning.provider`);
            assert.equal(warnings[0].standard, standard, `${provider}: warning.standard`);
        }
    });
});


describe('protocol helpers kept identical', () => {
    it('SUPPORTED_PROTOCOLS deep-equals the 0.12.0 table', () => {
        assert.deepEqual(SUPPORTED_PROTOCOLS, EXPECTED_PROTOCOLS);
    });

    it('protocolsFor / sessionProtocolsFor / defaultProtocolFor return the 0.12.0 values', () => {
        assert.equal(Object.keys(EXPECTED_PROTOCOLS).length, 8);
        for (const [provider, expected] of Object.entries(EXPECTED_PROTOCOLS)) {
            assert.deepEqual(protocolsFor({ provider: provider }), expected, `${provider}: protocolsFor`);
            const sessions = expected.filter((p) => p !== 'task');
            assert.deepEqual(sessionProtocolsFor({ provider: provider }), sessions, `${provider}: sessionProtocolsFor`);
            assert.equal(defaultProtocolFor({ provider: provider }), sessions[0], `${provider}: defaultProtocolFor`);
        }
        assert.deepEqual(protocolsFor({ provider: 'nope' }), []);
    });

    it('TRANSPORT_PROTOCOLS is exactly task', () => {
        assert.ok(TRANSPORT_PROTOCOLS instanceof Set);
        assert.deepEqual([...TRANSPORT_PROTOCOLS], ['task']);
    });

    it('isStandard GAI is true only for google_genai and vertex', () => {
        for (const provider of Object.values(ProviderType)) {
            const expected = provider === ProviderType.GOOGLE_GENAI || provider === ProviderType.VERTEX;
            assert.equal(isStandard({ provider: provider, standard: StandardType.GAI }), expected, provider);
        }
        assert.equal(isStandard({ provider: 'nope', standard: StandardType.GAI }), false);
    });
});


describe('descriptor values match the current code', () => {
    it('every env-var name in a descriptor is an EnvKey with the same value', () => {
        /** The 0.12.0 credential/model key table, written out rather than derived. */
        const EXPECTED_ENV = {
            jai: {
                apiKeyKey: null, tokenKey: 'JAI_TOKEN', credentialsKey: null, locationKey: null, baseURLKey: null,
                models: { default: 'DEFAULT_JAI_MODEL', tool: 'DEFAULT_JAI_TOOL_MODEL', embedding: null, decision: null },
                embeddingFallbackKey: null,
            },
            openrouter: {
                apiKeyKey: 'OPENROUTER_API_KEY', tokenKey: null, credentialsKey: null, locationKey: null, baseURLKey: 'OPENROUTER_URL',
                models: { default: 'DEFAULT_OPENROUTER_MODEL', tool: 'DEFAULT_OPENROUTER_TOOL_MODEL', embedding: 'DEFAULT_OPENROUTER_EMBEDDING_MODEL', decision: 'DEFAULT_OPENROUTER_DECISION_MODEL' },
                embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
            },
            openai: {
                apiKeyKey: 'OPENAI_API_KEY', tokenKey: null, credentialsKey: null, locationKey: null, baseURLKey: 'OPENAI_BASE_URL',
                models: { default: 'DEFAULT_OPENAI_MODEL', tool: 'DEFAULT_OPENAI_TOOL_MODEL', embedding: 'DEFAULT_OPENAI_EMBEDDING_MODEL', decision: 'DEFAULT_OPENAI_DECISION_MODEL' },
                embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
            },
            local: {
                apiKeyKey: null, tokenKey: null, credentialsKey: null, locationKey: null, baseURLKey: 'LM_STUDIO_URL',
                models: { default: 'DEFAULT_LOCAL_MODEL', tool: 'DEFAULT_LOCAL_TOOL_MODEL', embedding: 'DEFAULT_LOCAL_EMBEDDING_MODEL', decision: null },
                embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
            },
            google_genai: {
                apiKeyKey: 'GEMINI_API_KEY', tokenKey: null, credentialsKey: null, locationKey: null, baseURLKey: null,
                models: { default: 'DEFAULT_GOOGLE_GENAI_MODEL', tool: 'DEFAULT_GOOGLE_GENAI_TOOL_MODEL', embedding: 'DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL', decision: 'DEFAULT_GOOGLE_GENAI_DECISION_MODEL' },
                embeddingFallbackKey: 'DEFAULT_GEMINI_EMBEDDING_MODEL',
            },
            vertex: {
                apiKeyKey: null, tokenKey: null, credentialsKey: 'VERTEX_CREDENTIALS', locationKey: 'VERTEX_LOCATION', baseURLKey: null,
                models: { default: 'DEFAULT_VERTEX_MODEL', tool: 'DEFAULT_VERTEX_TOOL_MODEL', embedding: 'DEFAULT_VERTEX_EMBEDDING_MODEL', decision: null },
                embeddingFallbackKey: 'DEFAULT_GEMINI_EMBEDDING_MODEL',
            },
            anthropic: {
                apiKeyKey: 'ANTHROPIC_API_KEY', tokenKey: null, credentialsKey: null, locationKey: null, baseURLKey: 'ANTHROPIC_BASE_URL',
                models: { default: 'DEFAULT_ANTHROPIC_MODEL', tool: 'DEFAULT_ANTHROPIC_TOOL_MODEL', embedding: null, decision: null },
                // Exact 0.12.0 parity: getEmbeddingModel falls back to the generic key even
                // though the Anthropic client's embed() always throws.
                embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
            },
            opencode: {
                apiKeyKey: 'OPENCODE_API_KEY', tokenKey: null, credentialsKey: null, locationKey: null, baseURLKey: 'OPENCODE_URL',
                models: { default: 'DEFAULT_OPENCODE_MODEL', tool: 'DEFAULT_OPENCODE_TOOL_MODEL', embedding: 'DEFAULT_OPENCODE_EMBEDDING_MODEL', decision: 'DEFAULT_OPENCODE_DECISION_MODEL' },
                embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
            },
        };
        for (const [id, descriptor] of Object.entries(PROVIDERS)) {
            const expected = EXPECTED_ENV[/** @type {keyof typeof EXPECTED_ENV} */ (id)];
            assert.ok(expected, `${id}: expected table entry`);
            for (const key of ['apiKeyKey', 'tokenKey', 'credentialsKey', 'locationKey', 'baseURLKey', 'embeddingFallbackKey']) {
                assert.equal(/** @type {Record<string, unknown>} */ (descriptor)[key], /** @type {Record<string, unknown>} */ (expected)[key], `${id}: ${key}`);
            }
            assert.deepEqual(descriptor.models, expected.models, `${id}: models`);
            for (const name of [
                descriptor.apiKeyKey, descriptor.tokenKey, descriptor.credentialsKey, descriptor.locationKey,
                descriptor.baseURLKey, descriptor.embeddingFallbackKey,
                descriptor.models.default, descriptor.models.tool, descriptor.models.embedding,
                descriptor.models.decision,
            ].filter((name) => name !== null)) {
                assert.equal(EnvKey[name], name, `${id}: ${name} must be an EnvKey of the same name`);
            }
        }
    });

    it('opencode carries the only hardcoded model fallback', () => {
        assert.deepEqual(PROVIDERS[ProviderType.OPENCODE].modelDefaults, {
            default: DEFAULT_OPENCODE_MODEL,
            tool: DEFAULT_OPENCODE_MODEL,
        });
        for (const [id, descriptor] of Object.entries(PROVIDERS)) {
            if (id === ProviderType.OPENCODE) continue;
            assert.equal(descriptor.modelDefaults, undefined, `${id}: no model fallback`);
        }
    });

    it('base URLs match the endpoint constants', () => {
        assert.equal(PROVIDERS[ProviderType.OPENAI].baseURL, DEFAULT_OPENAI_URL);
        assert.equal(PROVIDERS[ProviderType.OPENROUTER].baseURL, DEFAULT_OPENROUTER_URL);
        assert.equal(PROVIDERS[ProviderType.LOCAL].baseURL, DEFAULT_LOCAL_URL);
        assert.equal(PROVIDERS[ProviderType.OPENCODE].baseURL, DEFAULT_OPENCODE_URL);
        assert.equal(PROVIDERS[ProviderType.GOOGLE_GENAI].baseURL, null);
        assert.equal(PROVIDERS[ProviderType.VERTEX].baseURL, null);
        assert.equal(PROVIDERS[ProviderType.OPENCODE].tiers?.zen, 'https://opencode.ai/zen/v1');
    });

    it('model-tier env keys drive getDefaultModel / getToolModel', () => {
        /** @type {Map<string, string|undefined>} */
        const saved = new Map();
        /** @param {{name: string|null, value: string}} arg0 */
        const setEnv = ({ name, value }) => {
            if (name === null) return;
            if (!saved.has(name)) saved.set(name, process.env[name]);
            process.env[name] = value;
        };
        try {
            for (const [id, descriptor] of Object.entries(PROVIDERS)) {
                setEnv({ name: descriptor.models.default, value: `sentinel-${id}-default` });
                setEnv({ name: descriptor.models.tool, value: `sentinel-${id}-tool` });
                assert.equal(getDefaultModel({ provider: id }), `sentinel-${id}-default`, `${id}: getDefaultModel`);
                assert.equal(getToolModel({ provider: id }), `sentinel-${id}-tool`, `${id}: getToolModel`);
                setEnv({ name: descriptor.models.decision, value: `sentinel-${id}-decision` });
                assert.equal(getDecisionModel({ provider: id }), descriptor.models.decision ? `sentinel-${id}-decision` : '', `${id}: getDecisionModel`);
            }
            // No configurable embedding model: JAI embeds through a model-less service, Anthropic has no endpoint.
            assert.equal(PROVIDERS[ProviderType.JAI].models.embedding, null);
            assert.equal(PROVIDERS[ProviderType.ANTHROPIC].models.embedding, null);
            for (const provider of [ProviderType.OPENROUTER, ProviderType.OPENAI, ProviderType.LOCAL,
                ProviderType.GOOGLE_GENAI, ProviderType.VERTEX, ProviderType.OPENCODE]) {
                assert.equal(typeof PROVIDERS[provider].models.embedding, 'string', `${provider}: embedding env key`);
            }
            assert.equal(PROVIDERS[ProviderType.GOOGLE_GENAI].embeddingFallbackKey, 'DEFAULT_GEMINI_EMBEDDING_MODEL');
            assert.equal(PROVIDERS[ProviderType.VERTEX].embeddingFallbackKey, 'DEFAULT_GEMINI_EMBEDDING_MODEL');
            assert.equal(PROVIDERS[ProviderType.OPENAI].embeddingFallbackKey, 'DEFAULT_EMBEDDING_MODEL');
        } finally {
            for (const [name, value] of saved) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    it('capability sets equal the 0.12.0 literal table', () => {
        /** @param {string} capability @returns {Array<string>} */
        const withCapability = (capability) => Object.entries(PROVIDERS)
            .filter(([, descriptor]) => /** @type {Record<string, boolean>} */ (descriptor.capabilities)[capability])
            .map(([id]) => id)
            .sort();
        for (const [capability, expected] of Object.entries(EXPECTED_CAPABILITIES)) {
            assert.deepEqual(withCapability(capability), expected, `${capability}: registry`);
        }
        assert.deepEqual([...NATIVE_SEARCH_PROVIDERS].sort(), EXPECTED_CAPABILITIES.nativeWebSearch, 'nativeWebSearch set');
        assert.deepEqual([...NATIVE_SCRAPE_PROVIDERS].sort(), EXPECTED_CAPABILITIES.nativeWebScrape, 'nativeWebScrape set');
        assert.deepEqual([...PDF_MEDIA_PROVIDERS].sort(), EXPECTED_CAPABILITIES.pdfMedia, 'pdfMedia set');
        assert.ok(NATIVE_SEARCH_PROVIDERS instanceof Set, 'runtime sets keep their Set type');
        // The standard flags agree with the provider that speaks it.
        for (const [id, descriptor] of Object.entries(PROVIDERS)) {
            assert.equal(descriptor.capabilities.promptCache, descriptor.standard === StandardType.AAI, id);
        }
    });

    it('loadCredentials returns the exact per-provider option object', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-registry-'));
        const credsPath = join(dir, 'vertex.json');
        writeFileSync(credsPath, JSON.stringify({ project_id: 'sentinel-project' }));
        try {
            await withEnv({ assign: {
                [EnvKey.JAI_TOKEN]: 'sentinel-jai-token',
                [EnvKey.OPENROUTER_API_KEY]: 'sentinel-openrouter-key',
                [EnvKey.OPENROUTER_URL]: 'https://sentinel-openrouter.example/v1',
                [EnvKey.LM_STUDIO_URL]: 'https://sentinel-local.example/v1',
                [EnvKey.GEMINI_API_KEY]: 'sentinel-gemini-key',
                [EnvKey.VERTEX_CREDENTIALS]: credsPath,
                [EnvKey.VERTEX_LOCATION]: 'sentinel-region',
                [EnvKey.OPENAI_API_KEY]: 'sentinel-openai-key',
                [EnvKey.OPENAI_BASE_URL]: 'https://sentinel-openai.example/v1',
                [EnvKey.ANTHROPIC_API_KEY]: 'sentinel-anthropic-key',
                [EnvKey.ANTHROPIC_BASE_URL]: 'https://sentinel-anthropic.example/v1',
                [EnvKey.OPENCODE_API_KEY]: 'sentinel-opencode-key',
                [EnvKey.OPENCODE_URL]: 'https://sentinel-opencode.example/v1',
                [EnvKey.OPENCODE_TIER]: 'go',
                [EnvKey.PROTOCOL]: 'responses',
                [EnvKey.OPENAI_PROTOCOL]: undefined,
            }, fn: () => {
                /** @type {Record<string, Record<string, unknown>>} */
                const expected = {
                    [ProviderType.JAI]: {
                        token: 'sentinel-jai-token',
                        protocol: 'responses',
                        tokenPersistFile: resolve(SUPPORT_DIR, ENV_FILE_RELATIVE_PATH),
                        tokenPersistKey: EnvKey.JAI_TOKEN,
                    },
                    [ProviderType.OPENROUTER]: {
                        apiKey: 'sentinel-openrouter-key',
                        baseURL: 'https://sentinel-openrouter.example/v1',
                        protocol: 'responses',
                    },
                    // 0.21.1: both providers carry a baseURLKey, so loadCredentials
                    // returns a baseURL for them too (absent env → undefined).
                    [ProviderType.OPENAI]: {
                        apiKey: 'sentinel-openai-key',
                        baseURL: 'https://sentinel-openai.example/v1',
                        protocol: 'responses',
                    },
                    [ProviderType.LOCAL]: { baseURL: 'https://sentinel-local.example/v1', protocol: 'responses' },
                    [ProviderType.GOOGLE_GENAI]: { apiKey: 'sentinel-gemini-key', protocol: 'responses' },
                    [ProviderType.VERTEX]: {
                        protocol: 'responses',
                        genaiOptions: {
                            vertexai: true,
                            project: 'sentinel-project',
                            location: 'sentinel-region',
                            googleAuthOptions: { credentials: { project_id: 'sentinel-project' } },
                        },
                    },
                    [ProviderType.ANTHROPIC]: {
                        apiKey: 'sentinel-anthropic-key',
                        baseURL: 'https://sentinel-anthropic.example/v1',
                        protocol: 'responses',
                    },
                    [ProviderType.OPENCODE]: {
                        apiKey: 'sentinel-opencode-key',
                        baseURL: 'https://sentinel-opencode.example/v1',
                        protocol: 'responses',
                    },
                };
                for (const [provider, options] of Object.entries(expected)) {
                    // A provider with a baseURLKey returns the baseURL key whether or not
                    // the env var is set (0.21.1: openai and anthropic gained one).
                    assert.deepEqual(loadCredentials({ provider: provider }), options, `${provider}: loadCredentials shape`);
                }
                assert.deepEqual(loadCredentials({ provider: 'nope' }), {}, 'unknown backend');
            } });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('getEmbeddingModel resolves per descriptor, then the Gemini/generic fallback', async () => {
        await withEnv({ assign: {
            [EnvKey.DEFAULT_EMBEDDING_MODEL]: 'sentinel-generic',
            [EnvKey.DEFAULT_GEMINI_EMBEDDING_MODEL]: 'sentinel-gemini',
            [EnvKey.DEFAULT_OPENROUTER_EMBEDDING_MODEL]: 'sentinel-openrouter-embedding',
            [EnvKey.DEFAULT_OPENAI_EMBEDDING_MODEL]: 'sentinel-openai-embedding',
            [EnvKey.DEFAULT_LOCAL_EMBEDDING_MODEL]: 'sentinel-local-embedding',
            [EnvKey.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL]: 'sentinel-google-genai-embedding',
            [EnvKey.DEFAULT_VERTEX_EMBEDDING_MODEL]: 'sentinel-vertex-embedding',
            [EnvKey.DEFAULT_OPENCODE_EMBEDDING_MODEL]: 'sentinel-opencode-embedding',
        }, fn: () => {
            /** @type {Record<string, string>} */
            const expected = {
                [ProviderType.JAI]: '',
                [ProviderType.OPENROUTER]: 'sentinel-openrouter-embedding',
                [ProviderType.OPENAI]: 'sentinel-openai-embedding',
                [ProviderType.LOCAL]: 'sentinel-local-embedding',
                [ProviderType.GOOGLE_GENAI]: 'sentinel-google-genai-embedding',
                [ProviderType.VERTEX]: 'sentinel-vertex-embedding',
                // Anthropic has no embedding endpoint but still falls through to the generic key.
                [ProviderType.ANTHROPIC]: 'sentinel-generic',
                [ProviderType.OPENCODE]: 'sentinel-opencode-embedding',
            };
            for (const [provider, model] of Object.entries(expected)) {
                assert.equal(getEmbeddingModel({ provider: provider }), model, provider);
            }
            assert.equal(getEmbeddingModel({ provider: 'nope' }), 'sentinel-generic', 'unknown backend uses the generic key');

            // A JAI embedding model cannot be configured: the service is model-less.
            assert.equal(getEmbeddingModel({ provider: ProviderType.JAI }), '');

            // With the per-provider keys unset, the GAI family follows the Gemini fallback.
            delete process.env[EnvKey.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL];
            delete process.env[EnvKey.DEFAULT_VERTEX_EMBEDDING_MODEL];
            assert.equal(getEmbeddingModel({ provider: ProviderType.GOOGLE_GENAI }), 'sentinel-gemini');
            assert.equal(getEmbeddingModel({ provider: ProviderType.VERTEX }), 'sentinel-gemini');
        } });
    });

    it('model resolution falls back to the descriptor default when the env key is unset', async () => {
        // Load secret.env once, before unsetting, so lazy loading cannot repopulate the keys.
        ensureEnvLoaded();
        /** @type {Record<string, string|undefined>} */
        const unset = {};
        for (const descriptor of Object.values(PROVIDERS)) {
            for (const key of [descriptor.models.default, descriptor.models.tool, descriptor.models.decision]) {
                if (key) unset[key] = undefined;
            }
        }
        await withEnv({ assign: unset, fn: () => {
            for (const provider of Object.values(ProviderType)) {
                if (provider === ProviderType.OPENCODE) {
                    assert.equal(getDefaultModel({ provider: provider }), DEFAULT_OPENCODE_MODEL, 'opencode default');
                    assert.equal(getToolModel({ provider: provider }), DEFAULT_OPENCODE_MODEL, 'opencode tool');
                } else {
                    assert.equal(getDefaultModel({ provider: provider }), '', `${provider} default`);
                    assert.equal(getToolModel({ provider: provider }), '', `${provider} tool`);
                }
                assert.equal(getDecisionModel({ provider: provider }), '', `${provider} decision`);
            }
        } });
    });

    it('initializeClient builds every provider from its descriptor', async () => {
        /** @type {Record<string, Record<string, unknown>>} */
        const stubs = {
            [ProviderType.JAI]: { token: 'sentinel-token', endpoint: 'https://jai.example' },
            [ProviderType.OPENROUTER]: { apiKey: 'sentinel-key' },
            [ProviderType.OPENAI]: { apiKey: 'sentinel-key' },
            [ProviderType.LOCAL]: {},
            [ProviderType.GOOGLE_GENAI]: { apiKey: 'sentinel-key' },
            [ProviderType.VERTEX]: {
                genaiOptions: {
                    vertexai: true,
                    project: 'sentinel-project',
                    location: 'global',
                    googleAuthOptions: { credentials: {} },
                },
            },
            [ProviderType.ANTHROPIC]: { apiKey: 'sentinel-key' },
            [ProviderType.OPENCODE]: { apiKey: 'sentinel-key', sessionId: 'sentinel-session' },
        };
        // Every provider now reports its own id; the OAI client used to label
        // openrouter/local as 'openai'. JAI stores the protocol it is handed
        // (undefined → its sessions default to 'chat').
        /** @type {Record<string, {provider: string, protocol: string|undefined}>} */
        const expected = {
            [ProviderType.JAI]: { provider: 'jai', protocol: undefined },
            [ProviderType.OPENROUTER]: { provider: 'openrouter', protocol: 'completions' },
            [ProviderType.OPENAI]: { provider: 'openai', protocol: 'completions' },
            [ProviderType.LOCAL]: { provider: 'local', protocol: 'completions' },
            [ProviderType.GOOGLE_GENAI]: { provider: 'google_genai', protocol: 'generateContent' },
            [ProviderType.VERTEX]: { provider: 'vertex', protocol: 'generateContent' },
            [ProviderType.ANTHROPIC]: { provider: 'anthropic', protocol: 'messages' },
            [ProviderType.OPENCODE]: { provider: 'opencode', protocol: 'completions' },
        };
        for (const provider of Object.values(ProviderType)) {
            const { client, provider: builtProvider } = await initializeClient({ provider, options: stubs[provider] });
            assert.equal(builtProvider, provider);
            const c = /** @type {any} */ (client);
            assert.equal(c.provider, expected[provider].provider, `${provider}: client.provider`);
            assert.equal(c.protocol, expected[provider].protocol, `${provider}: client.protocol`);
        }
    });

    it('providersForStandard returns ProviderType order', () => {
        assert.deepEqual(providersForStandard({ standard: StandardType.OAI }), ['openrouter', 'openai', 'local', 'opencode']);
        assert.deepEqual(providersForStandard({ standard: StandardType.GAI }), ['google_genai', 'vertex']);
        assert.deepEqual(providersForStandard({ standard: StandardType.AAI }), ['anthropic']);
        assert.deepEqual(providersForStandard({ standard: StandardType.JAI }), ['jai']);
        assert.deepEqual(providersForStandard({ standard: 'nope' }), []);
    });
});


describe('provider identity on the real client path', () => {
    /** Minimal construction options per provider. @type {Record<string, Record<string, unknown>>} */
    const STUBS = {
        [ProviderType.JAI]: { token: 'sentinel-token', endpoint: 'https://jai.example' },
        [ProviderType.OPENROUTER]: { apiKey: 'sentinel-key' },
        [ProviderType.OPENAI]: { apiKey: 'sentinel-key' },
        [ProviderType.LOCAL]: {},
        [ProviderType.GOOGLE_GENAI]: { apiKey: 'sentinel-key' },
        [ProviderType.VERTEX]: {
            genaiOptions: {
                vertexai: true,
                project: 'sentinel-project',
                location: 'global',
                googleAuthOptions: { credentials: {} },
            },
        },
        [ProviderType.ANTHROPIC]: { apiKey: 'sentinel-key' },
        [ProviderType.OPENCODE]: { apiKey: 'sentinel-key' },
    };

    it('client.session() reports the provider that built it', async () => {
        for (const provider of Object.values(ProviderType)) {
            const { client } = await initializeClient({ provider: provider, options: STUBS[provider] });
            const session = client.session(provider === ProviderType.JAI ? 'sentinel-profile' : 'sentinel-model');
            assert.equal(session.provider, provider, `${provider}: session.provider`);
        }
    });

    it('client.standard and session.standard name the provider wire standard', async () => {
        for (const provider of Object.values(ProviderType)) {
            const { client } = await initializeClient({ provider: provider, options: STUBS[provider] });
            assert.equal(client.standard, standardFor({ provider }), `${provider}: client.standard`);
            const session = client.session(provider === ProviderType.JAI ? 'sentinel-profile' : 'sentinel-model');
            assert.equal(session.standard, standardFor({ provider }), `${provider}: session.standard`);
        }
    });

    it('a local session refuses a protocol local does not speak', async () => {
        const { client } = await initializeClient({ provider: ProviderType.LOCAL, options: {} });
        assert.equal(client.provider, ProviderType.LOCAL);
        assert.throws(
            () => client.session('sentinel-model').withProtocol({ protocol: 'responses' }),
            /Unsupported protocol 'responses' for provider 'local'/,
        );
    });

    it('an OpenRouter session reaches the OpenRouter native web_search branch', async () => {
        const { client } = await initializeClient({ provider: ProviderType.OPENROUTER, options: { apiKey: 'sentinel-key' } });
        const session = client.session('openai/gpt-4o').withWebSearch({ options: { mode: 'native', maxResults: 7 } });
        const { request } = oaiAdapter.buildVendorRequest({
            session,
            model: 'openai/gpt-4o',
            parameters: {},
            tools: [],
            preparedMessages: [{ role: 'user', content: 'hi' }],
            forceTextResponse: false,
            toolChoiceRequired: false,
        });
        assert.deepEqual(
            /** @type {any} */ (request).tools.find((/** @type {any} */ t) => t.type === 'openrouter:web_search'),
            { type: 'openrouter:web_search', parameters: { max_results: 7 } },
        );
    });
});

describe('vertex tier guard', () => {
    it('vertex without genaiOptions is refused, not silently built as Gemini', async () => {
        await assert.rejects(
            () => initializeClient({ provider: ProviderType.VERTEX, options: {} }),
            /Vertex requires genaiOptions/,
        );
    });

    it('the enterprise alias is accepted as Vertex', async () => {
        // `enterprise` is the historical spelling of `genaiOptions.vertexai`
        // (lib/backends/gai.mjs), so the gate in initializeClient must take it too.
        const { client, provider } = await initializeClient({
            provider: ProviderType.VERTEX,
            options: {
                genaiOptions: {
                    enterprise: true,
                    project: 'sentinel-project',
                    location: 'global',
                    googleAuthOptions: { credentials: {} },
                },
            },
        });
        assert.equal(provider, ProviderType.VERTEX);
        assert.equal(client.provider, ProviderType.VERTEX, 'the alias builds a Vertex client');
        assert.equal(/** @type {any} */ (client).vertexai, true, 'the transport selects the Vertex wire shape');
        assert.equal(client.session('sentinel-model').provider, ProviderType.VERTEX);
    });
});
