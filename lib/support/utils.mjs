// @ts-check


/**
 * @file Shared SDK support helpers.
 * @version 0.12.0
 *
 * @description
 * Env loading and credential resolution (secret.env), the shared logger
 * singleton (`log`) plus its SDK-internal gates, token-estimation and
 * similarity primitives, and the error-shape helpers (status extraction,
 * embedding soft-fail gates, profile-list error mapping) used across
 * backends.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { ProviderType, ENV_FILE_RELATIVE_PATH, EnvKey, protocolsFor, sessionProtocolsFor, defaultProtocolFor, providerDescriptorFor, PROVIDERS, ROLE_REGISTRY } from '../core/constants/index.mjs';
import { BackendError, ConfigurationError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { log } from './logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let _loaded = false;
/** @type {string|null} */
let _envFilePath = null;
/** @type {string|null} */
let _persistFilePath = null;

/**
 * The `secret.env` this process reads. Resolved once, on the first call: the
 * file that is loaded is the file the credential paths follow, so a later
 * `chdir` cannot split them. Order: `MERCI_ENV_FILE`, then `$CWD/secret.env` —
 * the consumer's project, which is where a published package must look — then
 * the package-relative file, the repo's own dev run.
 * @returns {string}
 */
export function envFilePath() {
    if (_envFilePath !== null) return _envFilePath;
    const override = process.env.MERCI_ENV_FILE;
    if (typeof override === 'string' && override.trim() !== '') {
        _envFilePath = resolve(process.cwd(), override.trim());
    } else {
        const projectFile = resolve(process.cwd(), 'secret.env');
        _envFilePath = existsSync(projectFile) ? projectFile : resolve(__dirname, ENV_FILE_RELATIVE_PATH);
    }
    return _envFilePath;
}

/**
 * The file the SDK may *write* a refreshed token into. Narrower than
 * {@link envFilePath} on purpose, and resolved once for the same reason:
 * discovering `<cwd>/secret.env` (a committed template, a shared checkout) is
 * not permission to write a live bearer token into it. Only `MERCI_ENV_FILE`
 * or the package-relative file ever receives one; the existing file's other
 * keys are preserved.
 * @returns {string}
 */
export function persistEnvFilePath() {
    if (_persistFilePath !== null) return _persistFilePath;
    const override = process.env.MERCI_ENV_FILE;
    _persistFilePath = typeof override === 'string' && override.trim() !== ''
        ? resolve(process.cwd(), override.trim())
        : resolve(__dirname, ENV_FILE_RELATIVE_PATH);
    return _persistFilePath;
}

function _ensureEnvLoaded() {
    if (!_loaded) {
        // `quiet` keeps dotenv >= 17 from printing its "injected env" banner —
        // an SDK must never write to a consumer's stdout on import.
        config({ path: envFilePath(), quiet: true });
        _loaded = true;
    }
}


/**
 * Ensures secret.env has been merged into process.env. Safe to call from any
 * env-reading function (idempotent) — resolveProvider / getDefaultModel / etc.
 * call it before touching EnvKey values, since callers may reach them without
 * going through loadCredentials() first.
 */
export function ensureEnvLoaded() {
    _ensureEnvLoaded();
}


/**
 * @param {{provider?: string, protocol?: string, session?: boolean}} arg0 - ProviderType value.
 * @returns {string} The validated protocol.
 */
export function resolveProtocol({ provider, protocol, session = false }) {
    const allowed = session ? sessionProtocolsFor({ provider: /** @type {string} */ (provider) }) : protocolsFor({ provider: /** @type {string} */ (provider) });
    if (allowed.length === 0) {
        throw new ConfigurationError({ message: `Unknown provider for protocol selection: "${provider}".`, options: { option: 'protocol' } });
    }
    if (protocol === undefined || protocol === null) {
        return  (defaultProtocolFor({ provider: /** @type {string} */ (provider) }) ?? allowed[0]);
    }
    if (!allowed.includes(protocol)) {
        const transportHint = session && protocolsFor({ provider: /** @type {string} */ (provider) }).includes(protocol)
            ? ` '${protocol}' is a transport protocol (${provider} tasks) — call client.tasks instead of opening a session with it.`
            : '';
        throw new ConfigurationError({ message: `Unsupported protocol '${protocol}' for provider '${provider}'. Supported: ${allowed.map((p) => `'${p}'`).join(', ')}.${transportHint}`, options: { option: 'protocol' } });
    }
    return protocol;
}


/**
 * Resolves a provider endpoint for every entry point (`initializeClient`,
 * `loadCredentials`, direct client construction). An explicit option must be a
 * non-empty string (`null` means unset); a blank or non-string env value is
 * ignored.
 * @param {{explicit?: unknown, envKey?: string|null, fallback?: string|null, optionName?: string}} [arg0]
 * @returns {string|undefined} The trimmed URL, or the fallback when unset.
 */
export function resolveBaseUrl({ explicit, envKey = null, fallback = null, optionName = 'baseURL' } = {}) {
    if (explicit !== undefined && explicit !== null) {
        const value = typeof explicit === 'string' ? explicit.trim() : '';
        if (value === '') {
            throw new ConfigurationError({ message: `${optionName} must be a non-empty URL string.`, options: { option: optionName } });
        }
        return value;
    }
    if (envKey) {
        const raw = process.env[envKey];
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (value !== '') return value;
    }
    return fallback ?? undefined;
}


/**
 * Resolves a descriptor's endpoint, including its named tiers (opencode:
 * `OPENCODE_TIER=zen`). Precedence: explicit option, trimmed env URL, the tier
 * URL (zen) or the descriptor default (go). No fallback for untiered
 * descriptors, so `loadCredentials` still reports `undefined` when unset.
 * @param {{explicit?: unknown, descriptor: import('../core/constants/providers.mjs').ProviderDescriptor}} arg0
 * @returns {string|undefined}
 */
export function resolveTieredBaseUrl({ explicit, descriptor }) {
    const zen = descriptor.tiers !== null && process.env[EnvKey.OPENCODE_TIER] === 'zen';
    const fallback = descriptor.tiers ? (zen ? descriptor.tiers.zen : descriptor.baseURL) : undefined;
    return resolveBaseUrl({ explicit, envKey: descriptor.baseURLKey, fallback });
}


/**
 * backend; the historical OPENAI_PROTOCOL stays an OPENAI-scoped override.
 * @param {{provider?: string}} arg0 - ProviderType value.
 * @returns {string|undefined}
 */
export function protocolFromEnv({ provider }) {
    if (provider === ProviderType.OPENAI && process.env[EnvKey.OPENAI_PROTOCOL]) {
        return process.env[EnvKey.OPENAI_PROTOCOL];
    }
    return process.env[EnvKey.PROTOCOL] || undefined;
}


/**
 * Resolves the embedding model for a backend from secret.env. The descriptor's
 * `DEFAULT_<BACKEND>_EMBEDDING_MODEL` wins; Gemini tiers fall back to
 * `DEFAULT_GEMINI_EMBEDDING_MODEL`, every other tier to `DEFAULT_EMBEDDING_MODEL`.
 * No model id is hardcoded here — an unset key resolves to '' (empty string).
 *
 * JAI (`jai`) has no configurable embedding model: its embeddings go
 * through the model-less embedding service (fixed Qwen3-Embedding-4B), sized by
 * `DEFAULT_JAI_EMBEDDING_DIMENSIONS`. It therefore resolves to '' here.
 * @param {{provider: string}} arg0 - ProviderType value.
 * @returns {string} The embedding model id, or '' when unconfigured/not applicable.
 */
export function getEmbeddingModel({ provider }) {
    ensureEnvLoaded();
    const descriptor = providerDescriptorFor({ provider });
    if (!descriptor) return process.env[EnvKey.DEFAULT_EMBEDDING_MODEL] || '';
    const embeddingKey = descriptor.models.embedding;
    const fallback = descriptor.embeddingFallbackKey ? process.env[descriptor.embeddingFallbackKey] : '';
    if (embeddingKey === null) return fallback || '';
    return process.env[embeddingKey] || fallback || '';
}


/**
 * Resolves the decision (System One) model for a backend from secret.env. The
 * descriptor's `DEFAULT_<BACKEND>_DECISION_MODEL` is the only source: a decision
 * model id is vendor- and version-specific, so there is no generic fallback and
 * no hardcoded id here. A provider with no decision wire resolves to ''.
 * @param {{provider: string}} arg0 - ProviderType value.
 * @returns {string} The decision model id, or '' when unset/not applicable.
 */
export function getDecisionModel({ provider }) {
    ensureEnvLoaded();
    const decisionKey = providerDescriptorFor({ provider })?.models.decision ?? null;
    return decisionKey === null ? '' : process.env[decisionKey] || '';
}


/**
 * The default model id of a backend — the tier the orchestrator and the judges run on.
 * @param {{provider: string}} arg0 - Concrete ProviderType value.
 * @returns {string} The default model id ('' when unknown).
 */
export function getDefaultModel({ provider }) {
    ensureEnvLoaded();
    const descriptor = providerDescriptorFor({ provider });
    if (!descriptor) return '';
    return (descriptor.models.default ? process.env[descriptor.models.default] : '') || descriptor.modelDefaults?.default || '';
}


/**
 * The default tool model id of a backend — the cheap tier the subagents run on.
 * @param {{provider: string}} arg0 - Concrete ProviderType value.
 * @returns {string} The default tool model id ('' when unknown).
 */
export function getToolModel({ provider }) {
    ensureEnvLoaded();
    const descriptor = providerDescriptorFor({ provider });
    if (!descriptor) return '';
    return (descriptor.models.tool ? process.env[descriptor.models.tool] : '') || descriptor.modelDefaults?.tool || '';
}


/**
 * Resolves one client role to a provider and model. The role's own env key
 * wins; unset, the provider inherits `PROVIDER` and the model falls back to
 * the descriptor's tier (`DEFAULT_<P>_MODEL`, `..._EMBEDDING_MODEL`,
 * `..._DECISION_MODEL`). The provider must support what the role needs before
 * a model is resolved — a decision role on vertex fails on the provider, not
 * on a missing model id.
 * @param {{role: string}} arg0 - A ClientRole value.
 * @returns {{role: string, provider: string, model: string, source: {provider: 'role'|'inherited', model: 'role'|'default'}}}
 */
export function resolveRole({ role }) {
    ensureEnvLoaded();
    const entry = ROLE_REGISTRY[role];
    if (!entry) {
        throw new ConfigurationError({ message: `Unknown client role: "${role}". Valid: ${Object.keys(ROLE_REGISTRY).join(', ')}` });
    }
    // Trimmed and blank-aware, like resolveBaseUrl: a stray `DECISION_PROVIDER=`
    // is unset, never a provider named '   '.
    const roleProvider = (process.env[entry.providerKey] ?? '').trim();
    const rawProvider = roleProvider || (process.env[EnvKey.PROVIDER] ?? '').trim();
    if (!rawProvider) {
        throw new ConfigurationError({ message: `No provider for role '${role}'. Set ${entry.providerKey} or ${entry.inherits} in secret.env.` });
    }
    const provider = rawProvider.toLowerCase().replace(/[^a-z_]/g, '');
    const descriptor = providerDescriptorFor({ provider });
    if (!descriptor) {
        throw new ConfigurationError({ message: `Unknown provider: "${rawProvider}". Valid: ${Object.values(ProviderType).join(', ')}` });
    }
    if (entry.requires === 'embeddings' && !descriptor.capabilities.embeddings) {
        const valid = Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].capabilities.embeddings).join(', ');
        throw new ConfigurationError({ message: `${provider} has no embeddings wire; set ${entry.providerKey} to ${valid}.` });
    }
    if (entry.requires === 'decision' && descriptor.models.decision === null) {
        const valid = Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].models.decision !== null).join(', ');
        throw new ConfigurationError({ message: `${provider} has no decision wire; set ${entry.providerKey} to ${valid}.` });
    }
    const roleModel = (process.env[entry.modelKey] ?? '').trim();
    const model = roleModel || (entry.defaultModel === 'default'
        ? getDefaultModel({ provider })
        : entry.defaultModel === 'embedding' ? getEmbeddingModel({ provider }) : getDecisionModel({ provider }));
    if (model === '') {
        const modelLess = entry.defaultModel === 'embedding' && descriptor.models.embedding === null;
        if (!modelLess) {
            const defaultKey = entry.defaultModel === 'embedding'
                ? (descriptor.models.embedding ?? descriptor.embeddingFallbackKey)
                : entry.defaultModel === 'decision' ? descriptor.models.decision : descriptor.models.default;
            throw new ConfigurationError({ message: `No model for role '${role}' on provider '${provider}': set ${entry.modelKey} or ${defaultKey ?? 'a provider model default'}.` });
        }
    }
    return {
        role,
        provider,
        model,
        source: { provider: roleProvider ? 'role' : 'inherited', model: roleModel ? 'role' : 'default' },
    };
}


/**
 * A derived client view (`Object.create`) names the client whose identity-keyed
 * state — spawn registry, circuit breakers — it shares.
 */
export const CLIENT_VIEW_BASE = Symbol('merci.clientViewBase');


/**
 * The client a view chain bottoms out at. A derived view names the client whose
 * identity-keyed state (spawn registry, circuit breakers) it shares; following
 * the chain lets every view of one transport read the same state. A self-link
 * stops the walk, and a client with no link is returned unchanged.
 * @param {{client?: Object|null}} arg0
 * @returns {Object|null}
 */
export function baseClientOf({ client } = {}) {
    /** @type {Object|null|undefined} */
    let current = client;
    let base = (/** @type {Record<symbol, Object|null|undefined>} */ (/** @type {unknown} */ (current)))?.[CLIENT_VIEW_BASE] ?? null;
    while (base && base !== current) {
        current = base;
        base = (/** @type {Record<symbol, Object|null|undefined>} */ (/** @type {unknown} */ (current)))[CLIENT_VIEW_BASE] ?? null;
    }
    return /** @type {Object|null} */ (current);
}


/**
 * Resolves the JAI embedding output dimensionality from
 * `DEFAULT_JAI_EMBEDDING_DIMENSIONS`, defaulting to 1024. Positive integers
 * only; anything else falls back to the default.
 * @param {{provider: string}} arg0 - ProviderType value.
 * @returns {number}
 */
export function getEmbeddingDimensions({ provider }) {
    ensureEnvLoaded();
    if (provider !== ProviderType.JAI) return 0;
    return LIMITS.default_embedding_dimensions;
}


/**
 * Configures the SDK logger. `level`/`format` also honor the LOG_LEVEL /
 * LOG_FORMAT environment variables when not passed explicitly.
 * @param {{extended?: boolean, quiet?: boolean, level?: string, format?: string, colors?: boolean}} arg0
 */
export function configureSdkLog({ extended = false, quiet = false, level, format, colors } = {}) {
    log.configure({
        extended,
        quiet,
        ...(level !== undefined ? { level } : {}),
        ...(format !== undefined ? { format } : {}),
        ...(colors !== undefined ? { colors } : {}),
    });
}


/**
 * @param {{prefix: string, args?: Array<import('./logger.mjs').LogValue>}} arg0 - Section tag, e.g. 'SDK'.
 */
export function sdkLog({ prefix, args = [] }) {
    log.sdkLog({ prefix, args: [...args] });
}


/**
 * @param {{prefix: string, args?: Array<import('./logger.mjs').LogValue>}} arg0 - Section tag, e.g. 'SDK'.
 */
export function sdkWarn({ prefix, args = [] }) {
    log.sdkWarn({ prefix, args: [...args] });
}


/**
 * @param {{prefix: string, args?: Array<import('./logger.mjs').LogValue>}} arg0 - Section tag, e.g. 'SDK'.
 */
export function sdkError({ prefix, args = [] }) {
    log.sdkError({ prefix, args: [...args] });
}

export { log };


/**
 * references (a node that returns the context itself); a plain stringify throws
 * mid-run. [circular] markers are harmless for prompts/payloads/persistence.
 * Past `safe_stringify_max_nodes` it substitutes `"[truncated]"` and returns,
 * so it is only safe where partial text is acceptable (token estimates, prompt
 * blocks). Durable state uses `strictStringify`.
 * @param {{value: unknown}} arg0 -
 * @returns {string}
 */
export function safeStringify({ value }) {
    return stringifyWithNodeBudget({ value, strict: false });
}


/**
 * The strict twin of `safeStringify`: same circular handling, but exceeding
 * `safe_stringify_max_nodes` throws instead of substituting `"[truncated]"`.
 * A checkpoint, condition payload or fingerprint that lost data is worse than
 * a loud failure (D-3, G1-3).
 * @param {{value: unknown}} arg0 -
 * @returns {string}
 */
export function strictStringify({ value }) {
    return stringifyWithNodeBudget({ value, strict: true });
}


/**
 * @param {{value: unknown, strict: boolean}} arg0 - `strict` throws past the node budget instead of truncating.
 * @returns {string}
 */
function stringifyWithNodeBudget({ value, strict }) {

    /** @type {any[]} */
    const ancestors = [];
    let emitted = 0;
    const maxNodes = LIMITS.safe_stringify_max_nodes;
    return JSON.stringify(value, /** @this {any} @param {string} k @param {*} v */ function (k, v) {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v !== 'object' || v === null) return v;
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(v)) return '[circular]';
        // ponytail: flat node budget. Serializing shared refs in full is correct
        if (++emitted > maxNodes) {
            if (strict) {
                throw new ConfigurationError({
                    message: `strictStringify: value exceeds safe_stringify_max_nodes (${maxNodes}) at key '${k}'; raise MERCI_LIMIT_SAFE_STRINGIFY_MAX_NODES or shrink the value.`,
                    options: { option: 'safe_stringify_max_nodes', nonRetryable: true },
                });
            }
            return '[truncated]';
        }
        ancestors.push(v);
        return v;
    });
}


/**
 * data loss from the model). No-op when the text fits or the cap is not finite.
 * @param {{text: unknown, maxChars: number}} arg0 -
 * @returns {string}
 */
export function truncateForPrompt({ text, maxChars }) {
    const s = String(text ?? '');
    if (!Number.isFinite(maxChars) || maxChars <= 0 || s.length <= maxChars) return s;
    return `${s.slice(0, maxChars)}\n…[truncated ${s.length - maxChars} of ${s.length} chars]`;
}


/**
 * truncation decisions. Arrays of unified messages are summed over their
 * content (String of the whole array would be "[object Object]" per entry).
 * A real tokenizer would need vendor SDKs and adds network-free deps for a
 * heuristic that only needs to be conservative.
 * @param {{text: unknown, charsPerToken?: number}} arg0 -
 * @returns {number}
 */
export function estimateTokens({ text, charsPerToken = LIMITS.estimate_tokens_chars_per_token }) {
    if (Array.isArray(text)) {
        let total = 0;
        for (const m of text) total += estimateTokens({ text: m, charsPerToken });
        return total;
    }
    if (text && typeof text === 'object') {
        const row = /** @type {Record<string, unknown>} */ (text);
        const candidates = [row.content, row.result, row.text, row.thinking, row.input];
        const payload = candidates.find(c => c !== undefined && c !== null && c !== '');
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            return estimateTokens({ text: safeStringify({ value: payload }), charsPerToken });
        }
        if (payload === undefined && typeof row.type !== 'string') {
            return estimateTokens({ text: safeStringify({ value: text }), charsPerToken });
        }
        text = payload ?? '';
    }
    const str = String(text ?? '');
    if (!str) return 0;
    return Math.ceil(str.length / charsPerToken);
}


/**
 * `estimateTokens` reads only `content ?? result`, so GAI rows (`parts`) and
 * merged OAI tool-call rows (`content:''` + `tool_calls`) counted as ZERO —
 * long mixed-backend sessions never hit the compaction threshold and blew the
 * provider context limit. Sum every shape's text-bearing payload.
 * @param {{messages: unknown}} arg0 -
 * @returns {number}
 */
export function estimateMessageTokens({ messages }) {
    const charsPerToken = LIMITS.estimate_tokens_chars_per_token;
    if (!Array.isArray(messages)) return estimateTokens({ text: messages, charsPerToken });
    let total = 0;
    for (const raw of messages) {
        if (!raw || typeof raw !== 'object') { total += estimateTokens({ text: raw, charsPerToken }); continue; }
        const m = /** @type {Record<string, any>} */ (raw);
        if (Array.isArray(m.parts)) {
            for (const p of m.parts) {
                if (typeof p?.text === 'string') total += estimateTokens({ text: p.text, charsPerToken });
                else if (p?.functionCall) total += estimateTokens({ text: p.functionCall.args ?? p.functionCall.name ?? '', charsPerToken });
                else if (p?.functionResponse) total += estimateTokens({ text: p.functionResponse.response ?? '', charsPerToken });
            }
            continue;
        }
        if (m.content != null) total += estimateTokens({ text: m.content, charsPerToken });
        if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                total += estimateTokens({ text: tc.function?.arguments ?? tc.arguments ?? tc.name ?? '', charsPerToken });
            }
        }
        if (m.result != null && m.content == null) total += estimateTokens({ text: m.result, charsPerToken });
    }
    return total;
}


/**
 * (never NaN) so vector-retrieval fallback tiers can rely on the result.
 * @param {{a: Array<number>, b: Array<number>}} arg0 -
 * @returns {number}
 */
export function cosineSimilarity({ a, b }) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
    if (a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}


/**
 * Reads a backend's credentials from the environment into the options `initializeClient` expects.
 * @param {{provider?: string}} arg0 - One of ProviderType values.
 * @returns {Record<string, unknown>} Options object suitable for initializeClient({ provider, options }).
 */
export function loadCredentials({ provider }) {
    _ensureEnvLoaded();
    const protocol = protocolFromEnv({ provider });
    const descriptor = providerDescriptorFor({ provider });
    if (!descriptor) return {};
    // JAI: the bearer token also names the refresh-persistence target in secret.env.
    if (descriptor.tokenKey) {
        return {
            token: process.env[descriptor.tokenKey],
            protocol,
            tokenPersistFile: persistEnvFilePath(),
            tokenPersistKey: descriptor.tokenKey,
        };
    }
    // Vertex: a service-account file resolves to the deep genaiOptions object.
    if (descriptor.credentialsKey) {
        const credsFile = process.env[descriptor.credentialsKey];
        if (!credsFile) {
            throw new ConfigurationError({ message: 'VERTEX_CREDENTIALS env var must point to the Google service-account JSON file.' });
        }
        const envDir = dirname(envFilePath());
        const credentials = JSON.parse(readFileSync(resolve(envDir, credsFile), 'utf8'));
        return {
            protocol,
            genaiOptions: {
                vertexai: true,
                project: credentials.project_id,
                location: (descriptor.locationKey ? process.env[descriptor.locationKey] : undefined) || 'global',
                googleAuthOptions: { credentials }
            }
        };
    }
    /** @type {Record<string, unknown>} */
    const credentials = {};
    if (descriptor.apiKeyKey !== null) credentials.apiKey = process.env[descriptor.apiKeyKey];
    // Trimmed and blank-aware, so a stray `OPENAI_BASE_URL=` never reaches the
    // backend as '' (0.21.0 treated it as unset). The key stays present.
    if (descriptor.baseURLKey !== null) credentials.baseURL = resolveTieredBaseUrl({ descriptor });
    credentials.protocol = protocol;
    return credentials;
}


/**
 * the backend used (`status` / `statusCode`). Single probing point so the
 * whole SDK agrees on error shape instead of each caller guessing.
 * @param {{error: unknown}} arg0 -
 * @returns {number|null}
 */
export function getErrorStatus({ error }) {
    const e = /** @type {{status?: unknown, statusCode?: unknown}} */ (error);
    const status = e?.status ?? e?.statusCode ?? null;
    return typeof status === 'number' ? status : null;
}


/**
 * False only when the process is known to be gone. `EPERM` means it exists but
 * may not be signalled — that is alive.
 * @param {{pid: number}} arg0
 * @returns {boolean}
 */
export function isProcessAlive({ pid }) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return /** @type {any} */ (err)?.code !== 'ESRCH';
    }
}


/**
 * or a 404 that answered with an HTML page (a gateway with no embeddings
 * route, e.g. OPENCODE's SPA). Other 404s (unknown model) stay loud.
 * @param {{status: number|null, message?: string}} arg0 - HTTP status.
 * @returns {boolean}
 */
export function isEmbeddingUnsupportedStatus({ status, message = '' }) {
    if (status === 405 || status === 501) return true;
    if (status === 404) return /<html|<!doctype html/i.test(String(message));
    return false;
}


/**
 * statuses (NOT_FOUND → 404, UNIMPLEMENTED → 501); anything else maps to
 * null (a genuine failure).
 * @param {{code: number|string|undefined}} arg0 - gRPC status code.
 * @returns {number|null}
 */
export function grpcToHttpStatus({ code }) {
    if (code === 5) return 404;
    if (code === 12) return 501;
    return null;
}


/**
 * BackendError. Shared by the oai/gai/aai `getProfiles()` catch blocks.
 * The `.code` contract ('AUTH_FAILURE' / 'NETWORK_FAILURE') is unchanged —
 * only the error type is upgraded so consumers can `instanceof`-branch.
 * @param {{error: Error}} arg0 - The thrown provider error.
 * @returns {never} Always throws; the mapped error carries `.code`.
 */
export function mapProfileListError({ error }) {
    const err =  (error);
    const status = getErrorStatus({ error });
    if (status === 401 || status === 403) {
        throw new BackendError({ message: `Model list fetch failed: invalid or missing API credentials (HTTP ${status})`, options: {
            code: 'AUTH_FAILURE',
            status,
            cause: error
        } });
    }
    if (!status || /** @type {any} */ (err).code === 'ECONNREFUSED' || /** @type {any} */ (err).code === 'ENOTFOUND' || /** @type {any} */ (err).code === 'ETIMEDOUT') {
        throw new BackendError({ message: `Model list fetch failed: provider unreachable (${/** @type {any} */ (err).code || 'no status'})`, options: {
            code: 'NETWORK_FAILURE',
            status: status ?? undefined,
            cause: error
        } });
    }
    throw error;
}


/**
 * envelope). Shared by the backend adapters and search engines — was
 * copy-pasted per module. Null-safe: a missing emitter is a no-op.
 * @param {{emitter: import('node:events').EventEmitter<Record<string, unknown[]>>|null, model?: string, parameter: string, message: string, provider?: string, standard?: string}} arg0 -
 */
export function emitParameterWarning({ emitter, model = '', parameter, message, provider = '', standard = '' }) {
    emitEvent({ emitter, name: EVENTS.CLIENT.PARAMETER_WARNING, payload: {
        model, parameter, message, provider, standard,
    } });
}


/**
 * The refusal of a value `canonicalJson({ strict: true })` cannot key. Two calls
 * whose arguments differ only in such a field must not share an idempotency key,
 * so an unfoldable value is refused loudly instead of silently collapsed.
 * @param {{detail: string}} arg0
 * @returns {ConfigurationError}
 */
function strictKeyRefusal({ detail }) {
    return new ConfigurationError({
        message: `canonicalJson (strict): ${detail} cannot be a stable key; pass plain JSON data.`,
        options: { nonRetryable: true },
    });
}


/**
 * Deterministic JSON with sorted object keys: logically identical values always
 * serialize alike (the journal's idempotency keys, the cassette's request keys).
 * With `plainOnly`, only data is kept: a class instance or a function is
 * omitted (as `undefined` is), so a `RunContext` or a signal riding on a value
 * never changes its key. `omitKeys` drops those object keys at any depth.
 *
 * `strict` is the key mode of `journalKey` and the tool-round occurrence counter.
 * A `Map`, a `Set` or a class instance used to collapse into `{}` — two calls
 * with different arguments shared one idempotency key — and a `BigInt` threw a
 * bare `TypeError` mid-run; strict mode throws a non-retryable
 * `ConfigurationError` instead, and refuses a cycle or a value past
 * `safe_stringify_max_nodes`. A `Date` keeps its JSON text: it has one
 * unambiguous value, and two timestamps must not share a key.
 * @param {{value: unknown, plainOnly?: boolean, omitKeys?: ReadonlySet<string>|null, strict?: boolean}} arg0
 * @returns {string}
 */
export function canonicalJson({ value, plainOnly = false, omitKeys = null, strict = false }) {
    /** @type {unknown[]} */
    const ancestors = [];
    let nodes = 0;
    /** @param {unknown} v */
    const isData = (v) => {
        if (v === undefined || typeof v === 'function') return false;
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return true;
        const proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
    };

    /**
     * @param {{value: unknown, path: string}} arg0
     * @returns {string}
     */
    const walk = ({ value: v, path }) => {
        if (strict) {
            if (typeof v === 'bigint') throw strictKeyRefusal({ detail: `a BigInt at '${path}'` });
            if (typeof v === 'symbol' || typeof v === 'function') throw strictKeyRefusal({ detail: `a ${typeof v} at '${path}'` });
            if (typeof v === 'number' && !Number.isFinite(v)) throw strictKeyRefusal({ detail: `the non-finite number ${String(v)} at '${path}'` });
            if (v instanceof Date) return JSON.stringify(v.toJSON());
        }
        if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
        if (strict) {
            if (ancestors.includes(v)) throw strictKeyRefusal({ detail: `a circular reference at '${path}'` });
            if (++nodes > LIMITS.safe_stringify_max_nodes) {
                throw strictKeyRefusal({ detail: `more than safe_stringify_max_nodes (${LIMITS.safe_stringify_max_nodes}) objects, at '${path}'; raise MERCI_LIMIT_SAFE_STRINGIFY_MAX_NODES or shrink the value` });
            }
            if (!Array.isArray(v)) {
                const proto = Object.getPrototypeOf(v);
                if (proto !== Object.prototype && proto !== null) {
                    const name = (/** @type {{constructor?: {name?: string}}} */ (v))?.constructor?.name ?? 'non-plain';
                    throw strictKeyRefusal({ detail: `the non-plain object '${name}' at '${path}'` });
                }
            }
        }
        ancestors.push(v);
        try {
            if (Array.isArray(v)) {
                return `[${v.map((item, /** @type {number} */ index) => walk({ value: item, path: `${path}[${index}]` })).join(',')}]`;
            }
            const record = /** @type {Record<string, unknown>} */ (v);
            const keys = Object.keys(record).sort().filter((k) => (!plainOnly || isData(record[k])) && !omitKeys?.has(k));
            return `{${keys.map((k) => `${JSON.stringify(k)}:${walk({ value: record[k], path: `${path}.${k}` })}`).join(',')}}`;
        } finally {
            ancestors.pop();
        }
    };
    return walk({ value, path: '$' });
}


/**
 * True when a request's Host header names an allowed host.
 *
 * DNS-rebinding protection compares the Host header, not the socket address.
 * The port is irrelevant to the attack and a server created before `listen()`
 * cannot know it, so only the hostname is compared (brackets and a trailing
 * root label are stripped). An absent or unparseable Host is refused.
 *
 * @param {{req: import('node:http').IncomingMessage, allowedHosts?: string[], allowAnyHost?: boolean}} arg0
 * @returns {boolean}
 */
export function requestHostAllowed({ req, allowedHosts = ['localhost', '127.0.0.1', '::1'], allowAnyHost = false }) {
    if (allowAnyHost) return true;
    const raw = req?.headers?.host;
    if (typeof raw !== 'string' || raw.length === 0) return false;
    let host = raw.trim().toLowerCase();
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end === -1) return false;
        host = host.slice(1, end);
    } else {
        const colon = host.lastIndexOf(':');
        if (colon !== -1 && host.indexOf(':') === colon) host = host.slice(0, colon);
    }
    host = host.replace(/\.$/, '');
    if (!host) return false;
    return allowedHosts.some((allowed) => String(allowed).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') === host);
}


