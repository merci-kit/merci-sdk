// @ts-check
/**
 * @file SDK identity, backend/auth types, endpoints, and env keys.
 * @version 0.12.0
 *
 * @description
 * The SDK version string, backend and auth enum maps, gateway/backend base
 * URLs, and the canonical env-key names for every supported backend —
 * including the *_TOOL_MODEL tier keys that pin the tool-loop model.
 */




import { createRequire } from 'node:module';

import { PROVIDERS, standardFor } from './providers.mjs';
import { STANDARDS } from './standards.mjs';

/** The SDK version string, derived from package.json (three levels up). */
export const SDK_VERSION = (() => {
    try {
        return String(createRequire(import.meta.url)('../../../package.json').version ?? '');
    } catch {
        return '';
    }
})();


/**
 * Authentication modes used by the config layer.
 * @type {Object<string, string>}
 */
export const AuthType = {
    USER: 'user',
    SERVICE: 'service',
    APPLICATION: 'application',
};


/**
 * LLM wire protocols — the request/response contract a session speaks.
 * NOT the provider tier: Google GenAI vs Vertex and OpenCode zen/go are tiers
 * selected by the backend (`BACKEND`) or tier env keys, never by `withProtocol()`.
 * @type {Object<string, string>}
 */
export const ProtocolType = {
    CHAT: 'chat',
    RESPONSES: 'responses',
    TASK: 'task',
    COMPLETIONS: 'completions',
    MESSAGES: 'messages',
    GENERATE_CONTENT: 'generateContent',
};


/**
 * Protocols each backend recognizes, in default-preference order.
 * @type {Object<string, Array<string>>}
 */
export const SUPPORTED_PROTOCOLS = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, descriptor]) => [id, descriptor.protocols])
));


/**
 * Protocols that are transport surfaces, not session protocols: the JAI Task
 * API takes a roster task id + opaque parameters (no history/system/tools),
 * so it cannot back a chat session — use `client.tasks` for those calls.
 * @type {Set<string>}
 */
export const TRANSPORT_PROTOCOLS = new Set(
    Object.values(STANDARDS).flatMap((standard) => standard.transportProtocols)
);


/**
 * @param {{provider: string}} arg0 -
 * @returns {Array<string>}
 */
export function protocolsFor({ provider }) {
    return SUPPORTED_PROTOCOLS[provider] ?? [];
}


/**
 * @param {{provider: string}} arg0 -
 * @returns {Array<string>}
 */
export function sessionProtocolsFor({ provider }) {
    return protocolsFor({ provider }).filter((p) => !TRANSPORT_PROTOCOLS.has(p));
}


/**
 * @param {{provider: string}} arg0 -
 * @returns {string|null}
 */
export function defaultProtocolFor({ provider }) {
    return sessionProtocolsFor({ provider })[0] ?? null;
}


/**
 * Whether a provider speaks a given wire standard.
 * @param {{provider?: string, standard?: string}} arg0
 * @returns {boolean}
 */
export function isStandard({ provider, standard } = {}) {
    return standardFor({ provider }) === standard;
}


/**
 * Gateway base URLs.
 * The JAI endpoint ships no default: it is configuration (`JAI_BASE_URL`), so
 * no vendor address is baked into the package.
 * @type {Object<string, string>}
 */
export const GatewayEndpoint = {
    PRODUCTION: '',
};


/** Default OpenRouter-compatible base URL. */
export const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';

/** Default OpenAI base URL. */
export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';

/** Default local (LM Studio) base URL. */
export const DEFAULT_LOCAL_URL = 'http://localhost:1234/v1';

/** Default Anthropic base URL (the Messages API lives at `/v1/messages` under it). */
export const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';

/** Default opencode backend base URL. */
export const DEFAULT_OPENCODE_URL = 'https://opencode.ai/zen/go/v1';


/** Path of the secret env file, relative to the config loader. */
export const ENV_FILE_RELATIVE_PATH = '../../secret.env';


/**
 * Canonical environment-variable names for every backend and its default
 * model and tool-tier model.
 * @type {Object<string, string>}
 */
export const EnvKey = {
    JAI_TOKEN: 'JAI_TOKEN',
    OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
    OPENAI_API_KEY: 'OPENAI_API_KEY',
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
    VERTEX_CREDENTIALS: 'VERTEX_CREDENTIALS',
    VERTEX_LOCATION: 'VERTEX_LOCATION',
    OPENROUTER_URL: 'OPENROUTER_URL',
    LM_STUDIO_URL: 'LM_STUDIO_URL',
    ANTHROPIC_BASE_URL: 'ANTHROPIC_BASE_URL',
    OPENAI_BASE_URL: 'OPENAI_BASE_URL',
    
    /** Active provider selector (renamed from BACKEND in 0.20). */
        PROVIDER: 'PROVIDER',

    /** Generic wire-protocol selector (applies to the active backend). */
        PROTOCOL: 'PROTOCOL',
    
    /** OPENAI-scoped protocol override (historical key; wins over PROTOCOL). */
        OPENAI_PROTOCOL: 'OPENAI_PROTOCOL',
    OPENCODE_API_KEY: 'OPENCODE_API_KEY',
    OPENCODE_URL: 'OPENCODE_URL',
    OPENCODE_TIER: 'OPENCODE_TIER',
    TAVILY_API_KEY: 'TAVILY_API_KEY',
    DEFAULT_JAI_MODEL: 'DEFAULT_JAI_MODEL',
    DEFAULT_OPENROUTER_MODEL: 'DEFAULT_OPENROUTER_MODEL',
    DEFAULT_LOCAL_MODEL: 'DEFAULT_LOCAL_MODEL',
    DEFAULT_GOOGLE_GENAI_MODEL: 'DEFAULT_GOOGLE_GENAI_MODEL',
    DEFAULT_VERTEX_MODEL: 'DEFAULT_VERTEX_MODEL',
    DEFAULT_OPENAI_MODEL: 'DEFAULT_OPENAI_MODEL',
    DEFAULT_ANTHROPIC_MODEL: 'DEFAULT_ANTHROPIC_MODEL',
    DEFAULT_OPENCODE_MODEL: 'DEFAULT_OPENCODE_MODEL',
    DEFAULT_JAI_TOOL_MODEL: 'DEFAULT_JAI_TOOL_MODEL',
    DEFAULT_OPENROUTER_TOOL_MODEL: 'DEFAULT_OPENROUTER_TOOL_MODEL',
    DEFAULT_LOCAL_TOOL_MODEL: 'DEFAULT_LOCAL_TOOL_MODEL',
    DEFAULT_GOOGLE_GENAI_TOOL_MODEL: 'DEFAULT_GOOGLE_GENAI_TOOL_MODEL',
    DEFAULT_VERTEX_TOOL_MODEL: 'DEFAULT_VERTEX_TOOL_MODEL',
    DEFAULT_OPENAI_TOOL_MODEL: 'DEFAULT_OPENAI_TOOL_MODEL',
    DEFAULT_ANTHROPIC_TOOL_MODEL: 'DEFAULT_ANTHROPIC_TOOL_MODEL',
    DEFAULT_OPENCODE_TOOL_MODEL: 'DEFAULT_OPENCODE_TOOL_MODEL',
    DEFAULT_OPENAI_DECISION_MODEL: 'DEFAULT_OPENAI_DECISION_MODEL',
    DEFAULT_OPENROUTER_DECISION_MODEL: 'DEFAULT_OPENROUTER_DECISION_MODEL',
    DEFAULT_OPENCODE_DECISION_MODEL: 'DEFAULT_OPENCODE_DECISION_MODEL',
    DEFAULT_GOOGLE_GENAI_DECISION_MODEL: 'DEFAULT_GOOGLE_GENAI_DECISION_MODEL',
    DEFAULT_EMBEDDING_MODEL: 'DEFAULT_EMBEDDING_MODEL',
    DEFAULT_GEMINI_EMBEDDING_MODEL: 'DEFAULT_GEMINI_EMBEDDING_MODEL',
    DEFAULT_JAI_EMBEDDING_DIMENSIONS: 'DEFAULT_JAI_EMBEDDING_DIMENSIONS',
    DEFAULT_OPENROUTER_EMBEDDING_MODEL: 'DEFAULT_OPENROUTER_EMBEDDING_MODEL',
    DEFAULT_OPENAI_EMBEDDING_MODEL: 'DEFAULT_OPENAI_EMBEDDING_MODEL',
    DEFAULT_LOCAL_EMBEDDING_MODEL: 'DEFAULT_LOCAL_EMBEDDING_MODEL',
    DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL: 'DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL',
    DEFAULT_VERTEX_EMBEDDING_MODEL: 'DEFAULT_VERTEX_EMBEDDING_MODEL',
    DEFAULT_OPENCODE_EMBEDDING_MODEL: 'DEFAULT_OPENCODE_EMBEDDING_MODEL',
    GENERATIVE_PROVIDER: 'GENERATIVE_PROVIDER',
    GENERATIVE_MODEL: 'GENERATIVE_MODEL',
    EMBEDDING_PROVIDER: 'EMBEDDING_PROVIDER',
    EMBEDDING_MODEL: 'EMBEDDING_MODEL',
    DECISION_PROVIDER: 'DECISION_PROVIDER',
    DECISION_MODEL: 'DECISION_MODEL',
    JAI_HEADER_TIMEOUT_MS: 'JAI_HEADER_TIMEOUT_MS',
    JAI_CONNECT_TIMEOUT_MS: 'JAI_CONNECT_TIMEOUT_MS',
};
