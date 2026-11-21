// @ts-check
/**
 * @file createDecisionsClient — the stateless judgment surface.
 * @version 0.23.0
 *
 * @description
 * A decision call is not a session: there is no history, no tools, no streaming
 * and no text. It is one request that returns typed answers with probabilities,
 * so it sits beside `embed()` on a backend client rather than behind
 * `session()`. This module is the generic engine — validate, translate, post,
 * normalize, observe — and the adapters own every provider difference, so no
 * provider branch lives here.
 *
 * Provider support is resolved on first use, not at construction: a chat-only
 * client (`local`, `vertex`, `anthropic`, `jai`) must still construct, and
 * must fail with a named error only if it is asked for a decision.
 */

import { postJson } from '../transport/http.mjs';
import { buildDecisionRequest } from '../../messaging/decision.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import { EVENTS, stampEvent } from '../../core/events.mjs';
import { providerDescriptorFor, ProviderType } from '../../core/constants/index.mjs';
import { getDecisionModel } from '../../support/utils.mjs';
import { runWithRetry } from '../../support/retry-policy.mjs';
import { openaiDecisionsAdapter } from './adapters/openai.mjs';
import { opencodeDecisionsAdapter, openrouterDecisionsAdapter } from './adapters/keyed.mjs';
import { geminiDecisionsAdapter } from './adapters/gemini.mjs';

/**
 * Providers whose wire this SDK can translate, in ProviderType order.
 * @type {Record<string, import('./adapters/decisions-common.mjs').DecisionsAdapter>}
 */
const ADAPTERS = Object.freeze({
    [ProviderType.OPENAI]: openaiDecisionsAdapter,
    [ProviderType.OPENROUTER]: openrouterDecisionsAdapter,
    [ProviderType.OPENCODE]: opencodeDecisionsAdapter,
    [ProviderType.GOOGLE_GENAI]: geminiDecisionsAdapter,
});

/**
 * The client options a backend client hands over: the credentials and
 * transport it already resolved for chat.
 * @typedef {Object} DecisionsClientOptions
 * @property {string} provider - ProviderType value.
 * @property {string|undefined} apiKey
 * @property {string|null} [baseURL] - The client's resolved base URL.
 * @property {Record<string, string|null|undefined>|null} [defaultHeaders]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {import('node:events').EventEmitter|null} [emitter]
 */

/**
 * @typedef {Object} DecisionsClient
 * @property {string} provider
 * @property {(arg0?: {model?: string, state?: string|Record<string, unknown>, questions?: Record<string, import('../../messaging/decision.mjs').DecisionQuestion>, signal?: AbortSignal|null, headers?: Record<string, string|null|undefined>, url?: string|null, retryPolicy?: import('../../support/retry-policy.mjs').RetryPolicy|null}) => Promise<import('../../messaging/decision.mjs').DecisionResult>} ask
 */

/**
 * Creates the decision client for one provider. The provider's adapter is
 * resolved per call, so an unsupported provider fails on first `ask()`, naming
 * the providers that do work.
 * @param {DecisionsClientOptions} arg0
 * @returns {DecisionsClient}
 */
export function createDecisionsClient({ provider, apiKey, baseURL = null, defaultHeaders = null, fetchImpl = undefined, timeoutMs = undefined, emitter = null }) {
    /**
     * One decision request: typed answers, probabilities, usage.
     * @param {{model?: string, state?: string|Record<string, unknown>, questions?: Record<string, import('../../messaging/decision.mjs').DecisionQuestion>, signal?: AbortSignal|null, headers?: Record<string, string|null|undefined>, url?: string|null, retryPolicy?: import('../../support/retry-policy.mjs').RetryPolicy|null}} [arg0]
     * @returns {Promise<import('../../messaging/decision.mjs').DecisionResult>}
     */
    async function ask({ model, state, questions, signal = null, headers, url = null, retryPolicy = null } = {}) {
        const adapter = adapterFor({ provider });
        if (typeof apiKey !== 'string' || apiKey === '') {
            throw new ConfigurationError({ message: `A decision call needs an API key for provider '${provider}'.`, options: { option: 'apiKey' } });
        }
        const modelId = typeof model === 'string' && model.trim() !== '' ? model : getDecisionModel({ provider });
        if (modelId === '') {
            const key = providerDescriptorFor({ provider })?.models.decision;
            throw new ConfigurationError({
                message: key
                    ? `No decision model configured for provider '${provider}': set ${key} in secret.env (or pass ask({ model })).`
                    : `Provider '${provider}' has no decision model. Decisions are supported on openai, openrouter, opencode and google_genai.`,
                options: { option: 'model' },
            });
        }
        const request = buildDecisionRequest({ model: modelId, state, questions });
        const body = adapter.buildBody({ request });
        const target = url ?? adapter.endpoint({ baseURL: baseURL ?? providerDescriptorFor({ provider })?.baseURL ?? adapter.defaultBaseURL });
        const payload = {
            url: target,
            auth: adapter.auth({ apiKey: /** @type {string} */ (apiKey) }),
            body,
            defaultHeaders: defaultHeaders ?? undefined,
            headers,
            signal: signal ?? undefined,
            fetchImpl,
            timeoutMs,
        };
        const questionNames = Object.keys(request.questions);
        const startTs = Date.now();
        emitDecisionEvent({ emitter, name: EVENTS.CLIENT.DECISIONS_START, payload: { model: request.model, provider, questions: questionNames } });
        try {
            const raw = retryPolicy
                ? await runWithRetry({ operation: () => postJson(payload), policy: retryPolicy, signal })
                : await postJson(payload);
            const result = adapter.readAnswers({ body: raw });
            const answered = { model: result.model ?? request.model, answers: result.answers, usage: result.usage };
            emitDecisionEvent({ emitter, name: EVENTS.CLIENT.DECISIONS_FINISH, payload: { model: answered.model, provider, questions: questionNames, answerTypes: Object.fromEntries(Object.entries(result.answers).map(([name, answer]) => [name, answer.type])), usage: result.usage, durationMs: Date.now() - startTs } });
            return answered;
        } catch (error) {
            const shaped = /** @type {{message?: string, status?: number}} */ (error);
            emitDecisionEvent({ emitter, name: EVENTS.CLIENT.DECISIONS_ERROR, payload: { model: request.model, provider, questions: questionNames, durationMs: Date.now() - startTs, status: shaped.status, error: shaped.message ?? String(error) } });
            throw error;
        }
    }

    return { provider, ask };
}

/**
 * @param {{provider: string}} arg0
 * @returns {import('./adapters/decisions-common.mjs').DecisionsAdapter}
 * @throws {ConfigurationError} For a provider with no decision wire.
 */
function adapterFor({ provider }) {
    const adapter = ADAPTERS[provider];
    if (adapter) return adapter;
    // Vertex is a valid chat tier with no decision wire: Gemini Decision 1 is
    // Developer-API only, so the error names the path that does work.
    const vertexNote = provider === ProviderType.VERTEX
        ? ' Gemini Decision 1 runs on the Gemini Developer API (provider google_genai); Google lists Vertex support as coming soon.'
        : '';
    throw new ConfigurationError({
        message: `Decisions are not supported for provider '${provider}'. Supported: ${Object.keys(ADAPTERS).join(', ')}.${vertexNote}`,
        options: { option: 'provider' },
    });
}

/**
 * @param {{emitter: import('node:events').EventEmitter|null, name: string, payload: Record<string, unknown>}} arg0
 * @returns {void}
 */
function emitDecisionEvent({ emitter, name, payload }) {
    if (!emitter) return;
    emitter.emit(name, stampEvent({ name, payload }));
}
