// @ts-check
/**
 * @file Provider registry.
 * @version 0.12.0
 *
 * @description
 * One descriptor per concrete provider: its wire standard, the protocols it
 * recognizes (preference order), its default base URL and the env key that
 * overrides it, the credential env keys, the model-tier env keys, and the
 * capability flags. Data only — `sdk.mjs` derives `SUPPORTED_PROTOCOLS`
 * from it. Env-key names are literal strings on purpose
 * (importing ./sdk.mjs would create a cycle); test/provider-registry.test.mjs
 * locks each one to the same-named `EnvKey` entry.
 *
 * @remarks
 * Key order is `ProviderType` order, and `resolveProvider`'s error message
 * lists providers in that order — keep it.
 */

import { StandardType } from './standards.mjs';
import { DEFAULT_OPENCODE_MODEL, LOCAL_API_KEY_PLACEHOLDER } from './models.mjs';


/**
 * Every concrete provider the SDK can target.
 * @type {Object<string, string>}
 */
export const ProviderType = Object.freeze({
    JAI: 'jai',
    OPENROUTER: 'openrouter',
    OPENAI: 'openai',
    LOCAL: 'local',
    GOOGLE_GENAI: 'google_genai',
    VERTEX: 'vertex',
    ANTHROPIC: 'anthropic',
    OPENCODE: 'opencode',
});


/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} embeddings - The backend implements `embed()`.
 * @property {boolean} pdfMedia - The wire can carry an inline PDF document.
 * @property {boolean} nativeWebSearch - Search has a native (vendor) leg.
 * @property {boolean} nativeWebScrape - Scrape has a native (vendor) leg.
 * @property {boolean} promptCache - The wire has a per-block cache marker.
 */


/**
 * @typedef {Object} ProviderDescriptor
 * @property {string} id - The ProviderType value.
 * @property {string} standard - The StandardType value the provider speaks.
 * @property {Array<string>} protocols - Protocols recognized, preference order.
 * @property {string|null} baseURL - Fixed default base URL, when there is one.
 * @property {string|null} baseURLKey - Env key that overrides `baseURL`.
 * @property {string|null} apiKeyKey - API-key env key.
 * @property {string} [apiKeyPlaceholder] - Placeholder key for a backend that requires none (local).
 * @property {string|null} tokenKey - Bearer-token env key (JAI).
 * @property {string|null} credentialsKey - Service-account file env key (Vertex).
 * @property {string|null} locationKey - Region env key (Vertex).
 * @property {Object<string, string>|null} tiers - Named base-URL tiers.
 * @property {{default: string|null, tool: string|null, embedding: string|null, decision: string|null}} models
 *   Env-key names, not model ids. `decision` is null for a provider with no
 *   discriminative (System One) wire.
 * @property {{default: string|null, tool: string|null}} [modelDefaults] - Model
 *   ids used when the env key is unset (opencode pins one; every other
 *   provider resolves to '').
 * @property {string|null} embeddingFallbackKey - Generic embedding env key.
 * @property {ProviderCapabilities} capabilities
 */


/**
 * Descriptors keyed by ProviderType value.
 * @type {Object<string, ProviderDescriptor>}
 */
export const PROVIDERS = Object.freeze({
    [ProviderType.JAI]: {
        id: ProviderType.JAI,
        standard: StandardType.JAI,
        protocols: ['chat', 'responses', 'task'],
        baseURL: null,
        baseURLKey: null,
        apiKeyKey: null,
        tokenKey: 'JAI_TOKEN',
        credentialsKey: null,
        locationKey: null,
        tiers: null,
        models: { default: 'DEFAULT_JAI_MODEL', tool: 'DEFAULT_JAI_TOOL_MODEL', embedding: null, decision: null },
        embeddingFallbackKey: null,
        capabilities: {
            embeddings: true,
            pdfMedia: true,
            nativeWebSearch: false,
            nativeWebScrape: true,
            promptCache: false,
        },
    },
    [ProviderType.OPENROUTER]: {
        id: ProviderType.OPENROUTER,
        standard: StandardType.OAI,
        protocols: ['completions', 'responses'],
        baseURL: 'https://openrouter.ai/api/v1',
        baseURLKey: 'OPENROUTER_URL',
        apiKeyKey: 'OPENROUTER_API_KEY',
        tokenKey: null,
        credentialsKey: null,
        locationKey: null,
        tiers: null,
        models: { default: 'DEFAULT_OPENROUTER_MODEL', tool: 'DEFAULT_OPENROUTER_TOOL_MODEL', embedding: 'DEFAULT_OPENROUTER_EMBEDDING_MODEL', decision: 'DEFAULT_OPENROUTER_DECISION_MODEL' },
        embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
        capabilities: {
            embeddings: true,
            pdfMedia: true,
            nativeWebSearch: true,
            nativeWebScrape: true,
            promptCache: false,
        },
    },
    [ProviderType.OPENAI]: {
        id: ProviderType.OPENAI,
        standard: StandardType.OAI,
        protocols: ['completions', 'responses'],
        baseURL: 'https://api.openai.com/v1',
        baseURLKey: 'OPENAI_BASE_URL',
        apiKeyKey: 'OPENAI_API_KEY',
        tokenKey: null,
        credentialsKey: null,
        locationKey: null,
        tiers: null,
        models: { default: 'DEFAULT_OPENAI_MODEL', tool: 'DEFAULT_OPENAI_TOOL_MODEL', embedding: 'DEFAULT_OPENAI_EMBEDDING_MODEL', decision: 'DEFAULT_OPENAI_DECISION_MODEL' },
        embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
        capabilities: {
            embeddings: true,
            pdfMedia: true,
            nativeWebSearch: true,
            nativeWebScrape: false,
            promptCache: false,
        },
    },
    [ProviderType.LOCAL]: {
        id: ProviderType.LOCAL,
        standard: StandardType.OAI,
        protocols: ['completions'],
        baseURL: 'http://localhost:1234/v1',
        baseURLKey: 'LM_STUDIO_URL',
        apiKeyKey: null,
        apiKeyPlaceholder: LOCAL_API_KEY_PLACEHOLDER,
        tokenKey: null,
        credentialsKey: null,
        locationKey: null,
        tiers: null,
        models: { default: 'DEFAULT_LOCAL_MODEL', tool: 'DEFAULT_LOCAL_TOOL_MODEL', embedding: 'DEFAULT_LOCAL_EMBEDDING_MODEL', decision: null },
        embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
        capabilities: {
            embeddings: true,
            pdfMedia: false,
            nativeWebSearch: false,
            nativeWebScrape: false,
            promptCache: false,
        },
    },
    [ProviderType.GOOGLE_GENAI]: {
        id: ProviderType.GOOGLE_GENAI,
        standard: StandardType.GAI,
        protocols: ['generateContent'],
        baseURL: null,
        baseURLKey: null,
        apiKeyKey: 'GEMINI_API_KEY',
        tokenKey: null,
        credentialsKey: null,
        locationKey: null,
        tiers: null,
        models: { default: 'DEFAULT_GOOGLE_GENAI_MODEL', tool: 'DEFAULT_GOOGLE_GENAI_TOOL_MODEL', embedding: 'DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL', decision: 'DEFAULT_GOOGLE_GENAI_DECISION_MODEL' },
        embeddingFallbackKey: 'DEFAULT_GEMINI_EMBEDDING_MODEL',
        capabilities: {
            embeddings: true,
            pdfMedia: true,
            nativeWebSearch: true,
            nativeWebScrape: true,
            promptCache: false,
        },
    },
    [ProviderType.VERTEX]: {
        id: ProviderType.VERTEX,
        standard: StandardType.GAI,
        protocols: ['generateContent'],
        baseURL: null,
        baseURLKey: null,
        apiKeyKey: null,
        tokenKey: null,
        credentialsKey: 'VERTEX_CREDENTIALS',
        locationKey: 'VERTEX_LOCATION',
        tiers: null,
        models: { default: 'DEFAULT_VERTEX_MODEL', tool: 'DEFAULT_VERTEX_TOOL_MODEL', embedding: 'DEFAULT_VERTEX_EMBEDDING_MODEL', decision: null },
        embeddingFallbackKey: 'DEFAULT_GEMINI_EMBEDDING_MODEL',
        capabilities: {
            embeddings: true,
            pdfMedia: true,
            nativeWebSearch: true,
            nativeWebScrape: true,
            promptCache: false,
        },
    },
    [ProviderType.ANTHROPIC]: {
        id: ProviderType.ANTHROPIC,
        standard: StandardType.AAI,
        protocols: ['messages'],
        baseURL: null,
        baseURLKey: 'ANTHROPIC_BASE_URL',
        apiKeyKey: 'ANTHROPIC_API_KEY',
        tokenKey: null,
        credentialsKey: null,
        locationKey: null,
        tiers: null,
        models: { default: 'DEFAULT_ANTHROPIC_MODEL', tool: 'DEFAULT_ANTHROPIC_TOOL_MODEL', embedding: null, decision: null },
        embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
        capabilities: {
            embeddings: false,
            pdfMedia: true,
            nativeWebSearch: true,
            nativeWebScrape: true,
            promptCache: true,
        },
    },
    [ProviderType.OPENCODE]: {
        id: ProviderType.OPENCODE,
        standard: StandardType.OAI,
        protocols: ['completions', 'responses'],
        baseURL: 'https://opencode.ai/zen/go/v1',
        baseURLKey: 'OPENCODE_URL',
        apiKeyKey: 'OPENCODE_API_KEY',
        tokenKey: null,
        credentialsKey: null,
        locationKey: null,
        tiers: { zen: 'https://opencode.ai/zen/v1' },
        models: { default: 'DEFAULT_OPENCODE_MODEL', tool: 'DEFAULT_OPENCODE_TOOL_MODEL', embedding: 'DEFAULT_OPENCODE_EMBEDDING_MODEL', decision: 'DEFAULT_OPENCODE_DECISION_MODEL' },
        modelDefaults: { default: DEFAULT_OPENCODE_MODEL, tool: DEFAULT_OPENCODE_MODEL },
        embeddingFallbackKey: 'DEFAULT_EMBEDDING_MODEL',
        capabilities: {
            embeddings: true,
            pdfMedia: false,
            nativeWebSearch: false,
            nativeWebScrape: false,
            promptCache: false,
        },
    },
});


/**
 * @param {{provider?: string}} [arg0] - ProviderType value.
 * @returns {ProviderDescriptor|null} The descriptor, or null for an unknown provider.
 */
export function providerDescriptorFor({ provider } = {}) {
    return typeof provider === 'string' ? PROVIDERS[provider] ?? null : null;
}


/**
 * @param {{provider?: string}} [arg0] - ProviderType value.
 * @returns {string|null} The provider's StandardType value, or null when unknown.
 */
export function standardFor({ provider } = {}) {
    return providerDescriptorFor({ provider })?.standard ?? null;
}


/**
 * @param {{standard?: string}} [arg0] - StandardType value.
 * @returns {Array<string>} Provider ids in ProviderType order.
 */
export function providersForStandard({ standard } = {}) {
    return Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].standard === standard);
}
