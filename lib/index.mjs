// @ts-check


/**
 * @file Merci SDK entry point.
 * @version 0.12.0
 *
 * @description
 * The public export surface. Owns backend client lifecycle (resolveProvider,
 * initializeClient, default/tool model resolution), the unified message
 * factories and normalizers, resilience primitives (retry/backoff policies),
 * the shared logger, and the agentic orchestrators (AgentLauncher,
 * DiscussionSession, StateMachine, memory, loops, plan/task components).
 */
import { loadCredentials, configureSdkLog, ensureEnvLoaded, sdkLog, sdkError, resolveProtocol, resolveBaseUrl, resolveTieredBaseUrl, getEmbeddingModel, getEmbeddingDimensions, getDecisionModel, getDefaultModel, getToolModel, resolveRole, log } from './support/utils.mjs';
import { ExponentialBackoffPolicy, NoRetryPolicy, createStreamingRetryPolicy, CircuitBreaker, getCircuitBreaker, runGuardedStep, isTransientError, HEADER_TIMEOUT_CODE, BODY_TIMEOUT_CODE, BREAKER_OPEN_CODE, hasTimeoutCode } from './support/retry-policy.mjs';
import { ProtocolType, EnvKey, CAPABILITY, REVIEW_STAGE_REMINDER, ERROR_CODES, TIMEOUT_CODES, FALLBACK_MESSAGE, ProviderType, StandardType, PROVIDERS, STANDARDS, standardFor, isStandard, providersForStandard, providerDescriptorFor, ClientRole, ROLE_REGISTRY } from './core/constants/index.mjs';
import {
    createUserMessage,
    createSystemMessage,
    createAssistantMessage,
    createToolCallMessage,
    createToolCallMessages,
    createToolResultMessage,
    PDF_MEDIA_PROVIDERS,
    normalizeHistory,
    getToolCallName,
    getToolCallArguments
} from './messaging/messages.mjs';
import { createUnifiedMediaMessages } from './backends/media.mjs';
import { createDecisionGate } from './agentic/decision-gate.mjs';
import { decisionTest } from './agentic/guardrails.mjs';
import { createDecisionReranker } from './agentic/memory/rerank.mjs';
import { EVAL_SCORERS } from './agentic/evals.mjs';
import { AgentLauncher } from './agentic/cli/launcher.mjs';
import { DiscussionSession } from './agentic/discussion-session.mjs';
import { StateMachine } from './agentic/state-machine/index.mjs';
import { defaultDisplay, compactHistory, runDueSteps, fallbackKind, isSdkFallbackOutput, isTransientFallbackKind } from './agentic/agentic-core.mjs';
import { ConfigurationError } from './core/errors.mjs';

/**
 * One resolved client role: the client, its provider and model, and the
 * surface the role is called through.
 * @typedef {{role: string, client: unknown, provider: string, model: string, session?: Function, embed?: Function, ask?: Function}} RoleClient
 */

/**
 * The composition root's product: the role clients, one gate per seam, and the
 * option fragments the flows already accept.
 * @typedef {{roles: Record<string, RoleClient>, decision: RoleClient|null, gate: import('./agentic/decision-gate.mjs').DecisionGate, gates: Record<string, import('./agentic/decision-gate.mjs').DecisionGate>, gateFor: (arg0: {seam?: string}) => import('./agentic/decision-gate.mjs').DecisionGate, sessionOptions: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}, dag: {evaluatorOptions: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}, executorOptions: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}}, sm: {options: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}}, discussion: {options: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}}, guardrails: {decisionTest: Function}, memory: {reranker: Function|null}, evals: {scorer: Function}}} AgenticRuntime
 */

export { WebSearchComponent } from './agentic/websearch/component.mjs';
export { TavilyEngine, JaiEngine, resolveSearchMode, toUnified } from './agentic/websearch/engines.mjs';

export { WebScrapeComponent } from './agentic/webscrape/component.mjs';
export { TavilyExtractEngine, JaiScrapeEngine, CurlEngine, resolveScrapeMode, toUnifiedScrape } from './agentic/webscrape/engines.mjs';

export { BrowserComponent } from './agentic/browser/component.mjs';
export { INTERACTIVE_ACTIONS } from './agentic/browser/component.mjs';
export { ObscuraEngine, PlaywrightSession, resolveBrowserMode, MAX_BROWSER_URLS } from './agentic/browser/engines.mjs';

export {
    loadCredentials, configureSdkLog, ProtocolType,
    ProviderType, StandardType, PROVIDERS, STANDARDS, standardFor, isStandard, providersForStandard, providerDescriptorFor,
    CAPABILITY, REVIEW_STAGE_REMINDER, ERROR_CODES, TIMEOUT_CODES, FALLBACK_MESSAGE, getEmbeddingModel, getEmbeddingDimensions, getDecisionModel,
    getDefaultModel, getToolModel, resolveRole, ClientRole, ROLE_REGISTRY,
    createUserMessage, createSystemMessage, createAssistantMessage,
    createToolCallMessage, createToolCallMessages, createToolResultMessage,
    createUnifiedMediaMessages, PDF_MEDIA_PROVIDERS, normalizeHistory,
    getToolCallName, getToolCallArguments,
    ExponentialBackoffPolicy, NoRetryPolicy, createStreamingRetryPolicy,
    CircuitBreaker, getCircuitBreaker, runGuardedStep, isTransientError,
    HEADER_TIMEOUT_CODE, BODY_TIMEOUT_CODE, BREAKER_OPEN_CODE, hasTimeoutCode,
    log,
    defaultDisplay,
    compactHistory,
    runDueSteps,
    fallbackKind,
    isSdkFallbackOutput,
    isTransientFallbackKind,
    AgentLauncher,
    DiscussionSession,
    StateMachine
};

export { foldContext } from './agentic/context-fold.mjs';
export {
    AgentContext, normalizeHandoff, goalBlockForHandoff, merciEnvelope, contextFromMerciEnvelope,
    HANDOFF_MODERATED_MARKER, HANDOFF_GOAL_MODES, HANDOFF_CONTEXT_MODES
} from './agentic/agent-context.mjs';
export { InactivityTimeoutPolicy } from './support/stream-timeout.mjs';
export { createLimiter, runBatch } from './support/limiter.mjs';
export { EventEmitterApiObserver, CompositeApiObserver } from './support/api-observer.mjs';
export { createOtlpExporter, otelAttribute } from './support/otel-exporter.mjs';
export { createCassette, cassetteKey, CASSETTE_MODES } from './support/cassette.mjs';
export { runEvals, EVAL_SCORERS } from './agentic/evals.mjs';
export { attachEventLogger, createStreamLogger, canonicalEventNames } from './support/event-logger.mjs';
export { createSaveArtifactTool } from './agentic/artifacts.mjs';
export { ExecutionJournal, JOURNAL_STATUS, toolJournalKey, journalKey } from './agentic/journal.mjs';
export { runStep } from './agentic/step.mjs';
export { ingestDocument } from './agentic/ingest.mjs';

export {
    MemoryManager,
    MemoryProvider,
    LocalFileMemoryProvider,
    SqliteMemoryProvider,
    CompositeMemoryProvider,
    ProviderMemoryEngine,
    MemoryComponent
} from './agentic/memory/index.mjs';
export {
    FailureClass,
    failureFingerprint,
    RetryLedger,
    classifyFailure,
    claimReplan,
    stateFingerprint,
    compareProgress,
    createLlmJudge,
    createScoredJudge
} from './agentic/loops/index.mjs';
export { LoadableComponent } from './core/loadable.mjs';
export { ChatSessionBuilder } from './agentic/chat-session-builder.mjs';
export { BaseChatSession } from './agentic/chat-session.mjs';
export { TodoComponent } from './agentic/todos/component.mjs';
export { createPlanStageFollowUp, AGENT_PLAN, AGENT_EXECUTE } from './agentic/plan/component.mjs';
export { buildEnvironmentBlock, discoverInstructions } from './agentic/context.mjs';
export { withTaskAgents, withAgentDelegation, createTaskTool, normalizeDelegationEnvelope, TASK_TOOL_NAME, resolveAgentClient } from './agentic/task.mjs';
export { getBudgetPool } from './agentic/budget-pool.mjs';
export { getSpawnRegistry, listSpawns, getSpawn, sumSpawnUsage, spawnThreadId } from './agentic/spawn-registry.mjs';
export { continueSpawn, sendToSpawn, forkSpawn } from './agentic/task.mjs';
export { PERMISSION_MODES, isToolPermitted, isEditTool, stillRequiresApproval, normalizePermissionRules } from './agentic/permissions.mjs';
export { createGuardrails, extractUserText, decisionTest } from './agentic/guardrails.mjs';
export { noulQuestion, choiceQuestion, scoreQuestion, buildDecisionRequest, readDecisionAnswer, DECISION_QUESTION_TYPE } from './messaging/decision.mjs';
export { createDecisionsClient } from './backends/decisions/index.mjs';
export { createDecisionGate, certaintyOf } from './agentic/decision-gate.mjs';
export { createDecisionReranker } from './agentic/memory/rerank.mjs';
export { decisionCalibration } from './agentic/decision-calibration.mjs';
export {
    countConversationTurns,
    isInjection,
    stripInjectionMeta,
    dedupeMessages
} from './messaging/unified-message.mjs';
export {
    MerciError,
    BackendError,
    ConfigurationError,
    MemoryError,
    AbortedError,
    BudgetExceededError,
    MaxTurnsExceededError,
    AbstractMethodError,
    OrchestrationError,
    VerificationError,
    OrchestrationExhaustedError,
    GraphError,
    OrchestrationFailedError,
    GuardrailViolationError,
    WorkspaceError,
    WorkSourceError,
    SchedulerError,
    PolicyError,
    AgentFileError,
    isAbortError,
    wrapError
} from './core/errors.mjs';

export {
    EVENTS,
    RunContext,
    stampEvent,
    stampStreamEvent,
    emitEvent,
    runWithRunContext,
    currentRunContext
} from './core/events.mjs';

export { getLimits, setLimits, resetLimits, reloadLimits, LIMITS, resolveLimit } from './core/limit-config.mjs';
export { LIMIT_DEFAULTS, LIMIT_REGISTRY } from './core/constants/limits.mjs';
export { MerciEventEmitter } from './core/emitter.mjs';
export { createHooks, HookRegistry, STOP, HOOKS } from './core/hooks.mjs';
export { PHASES, enterPhase } from './core/lifecycle.mjs';


/**
 * Resolves the active provider: the argument when given, otherwise
 * `PROVIDER` from secret.env (renamed from BACKEND in 0.20).
 * @param {{provider?: string}} [arg0] - A ProviderType value.
 * @returns {string} The concrete provider key.
 */
export function resolveProvider({ provider } = {}) {
  ensureEnvLoaded();
  if (typeof provider === 'string' && provider.length > 0) return provider;
  const raw = process.env[EnvKey.PROVIDER];
  if (!raw) throw new ConfigurationError({ message: 'No provider selected. Set PROVIDER in secret.env (BACKEND was renamed to PROVIDER in 0.20).' });
  const key = raw.toLowerCase().replace(/[^a-z_]/g, '');
  if (!providerDescriptorFor({ provider: key })) {
    throw new ConfigurationError({ message: `Unknown provider: "${raw}". Valid: ${Object.values(ProviderType).join(', ')}` });
  }
  return key;
}


/**
 * The concrete client a backend builds. A union, not an index-signature record:
 * the four implementations share no base class, and a consumer that types against
 * this gets the real members (`session`, `sessionWithId`, `backend`, …) instead
 * of a bag that accepts every call.
 * @typedef {import('./backends/jai.mjs').MerciClient|import('./backends/oai.mjs').MerciClient|import('./backends/gai.mjs').MerciClient|import('./backends/aai.mjs').MerciClient} MerciClientInstance
 */

/**
 * Dynamic backend modules keyed by wire standard. The specifiers stay literal
 * so bundlers can resolve them statically; the `await import` spelling is
 * asserted by test/cold-start.test.mjs.
 * @type {Record<string, () => Promise<any>>}
 */
const CLIENT_MODULES = {
    [StandardType.OAI]: async () => await import('./backends/oai.mjs'),
    [StandardType.AAI]: async () => await import('./backends/aai.mjs'),
    [StandardType.GAI]: async () => await import('./backends/gai.mjs'),
    [StandardType.JAI]: async () => await import('./backends/jai.mjs'),
};

/**
 * Key-presence log labels kept verbatim for log-level parity. They are message
 * text, not provider facts, so they stay out of the registry.
 * @type {Record<string, string>}
 */
const CREDENTIAL_LOG_LABEL = {
    [ProviderType.OPENROUTER]: 'OpenRouter',
    [ProviderType.OPENAI]: 'OpenAI',
    [ProviderType.GOOGLE_GENAI]: 'Gemini API',
    [ProviderType.ANTHROPIC]: 'Anthropic API',
};

/**
 * Construction hooks for the three providers the generic descriptor path cannot
 * express: JAI's bearer-token refresh target, Vertex's deep `genaiOptions`, and
 * opencode's session-id wiring. Every other provider uses the generic path.
 * @type {Record<string, (arg0: {options: any}) => Record<string, any>>}
 */
const CLIENT_OPTION_BUILDERS = {
    [ProviderType.JAI]: ({ options }) => {
        if (!options.token) {
            sdkError({ prefix: 'SDK', args: ['JAI token is missing!'] });
            throw new ConfigurationError({ message: 'JAI token is missing.' });
        }
        // No endpoint ships with the package: it is configuration.
        const endpoint = options.endpoint ?? process.env.JAI_BASE_URL;
        if (!endpoint) {
            throw new ConfigurationError({ message: 'JAI endpoint is not configured: set JAI_BASE_URL or pass options.endpoint.' });
        }
        return {
            token: options.token,
            endpoint,
            authType: options.authType,
            tokenPersistFile: options.tokenPersistFile,
            tokenPersistKey: options.tokenPersistKey,
        };
    },
    // The Vertex tier is selected by the deep genaiOptions object, not a flat field.
    [ProviderType.VERTEX]: ({ options }) => ({ ...options }),
    // opencode carries the backend label and a per-session id the OAI client reads.
    [ProviderType.OPENCODE]: ({ options }) => {
        const descriptor = /** @type {import('./core/constants/index.mjs').ProviderDescriptor} */ (providerDescriptorFor({ provider: ProviderType.OPENCODE }));
        return {
            apiKey: options.apiKey || process.env[EnvKey.OPENCODE_API_KEY],
            // The shared tier resolver keeps this path identical to loadCredentials.
            baseURL: resolveTieredBaseUrl({ explicit: options.baseURL, descriptor }),
            provider: ProviderType.OPENCODE,
            opencodeSessionId: options.opencodeSessionId ?? options.sessionId,
            sessionId: options.sessionId,
        };
    },
};

/**
 * Builds one backend client. The caller's options reach the backend constructor,
 * so its `transportOptions` bag and its closed-bag refusals apply; the resolved
 * `built` fields win on `apiKey`/`baseURL`/`provider`. Resolves to
 * `{ client, provider }`.
 * @param {{provider: string, options?: {token?: string, apiKey?: string, baseURL?: string, protocol?: string, authType?: string, endpoint?: string, tokenPersistFile?: string, tokenPersistKey?: string, opencodeSessionId?: string, sessionId?: string, genaiOptions?: Record<string, unknown>, transportOptions?: Record<string, unknown>, anthropicOptions?: unknown, openaiOptions?: unknown, responsesAssistantPartType?: string, embedRetryPolicy?: unknown, embedMaxRetries?: number, embedInitialDelay?: number}}} arg0 - Concrete ProviderType value.
 * @returns {Promise<{client: MerciClientInstance, provider: string}>}
 */
export async function initializeClient({ provider, options = {} }) {
    ensureEnvLoaded();
    sdkLog({ prefix: 'SDK', args: [`initializing client for provider: ${provider}`] });
    const descriptor = providerDescriptorFor({ provider });
    if (!descriptor) throw new ConfigurationError({ message: `Unsupported provider: ${provider}` });
    // Vertex is a tier of the GAI standard selected by genaiOptions, not by the id alone.
    // `enterprise` is the historical spelling of `vertexai`, as in lib/backends/gai.mjs.
    const genaiOptions = options.genaiOptions;
    if (provider === ProviderType.VERTEX && !(genaiOptions?.vertexai === true || genaiOptions?.enterprise === true)) {
        throw new ConfigurationError({ message: 'Vertex requires genaiOptions from loadCredentials({ provider: "vertex" }) (VERTEX_CREDENTIALS).', options: { option: 'genaiOptions' } });
    }
    const protocol = options.protocol !== undefined && options.protocol !== null
        ? resolveProtocol({ provider, protocol: options.protocol })
        : undefined;
    const logLabel = CREDENTIAL_LOG_LABEL[provider];
    if (logLabel) {
        sdkLog({ prefix: 'SDK', args: [`${logLabel} Key: ${options.apiKey ? 'present' : 'MISSING'}`] });
        if (provider === ProviderType.OPENROUTER) {
            sdkLog({ prefix: 'SDK', args: [`OpenRouter URL: ${options.baseURL || 'default'}`] });
        }
    }
    const build = CLIENT_OPTION_BUILDERS[provider];
    const built = build
        ? build({ options })
        : {
            apiKey: options.apiKey || descriptor.apiKeyPlaceholder || undefined,
            baseURL: resolveBaseUrl({ explicit: options.baseURL, envKey: descriptor.baseURLKey, fallback: descriptor.baseURL }),
            // The OAI-standard client labels its session with this id; without it every
            // OpenAI-compatible provider reported itself as 'openai'.
            provider: descriptor.id,
        };
    const { MerciClient } = await CLIENT_MODULES[descriptor.standard]();
    // `...options` first: the constructor owns `transportOptions` and its refusals,
    // while `built` keeps the last word on the credential fields it resolves.
    const client = new MerciClient({ options: { ...options, ...built, protocol } });
    return { client, provider };
}


/**
 * Refuses a client that does not expose the surface its role needs. The
 * resolver already checked the provider descriptor; this checks the client a
 * backend actually built, because a backend can advertise a wire it lacks.
 * @param {{role: string, provider: string, client: any}} arg0
 */
function assertRoleSurface({ role, provider, client }) {
    if (role === ClientRole.GENERATIVE && typeof client?.session !== 'function') {
        throw new ConfigurationError({ message: `The '${provider}' client exposes no session() surface, so it cannot serve the generative role.` });
    }
    if (role === ClientRole.DECISION && !(client?.decisions && typeof client.decisions.ask === 'function')) {
        throw new ConfigurationError({ message: `The '${provider}' client exposes no decisions.ask surface, so it cannot serve the decision role.` });
    }
    if (role === ClientRole.EMBEDDING && typeof client?.embed !== 'function') {
        throw new ConfigurationError({ message: `The '${provider}' client exposes no embed() surface, so it cannot serve the embedding role.` });
    }
}


/**
 * Binds a role's one surface function to its client and resolved model.
 * @param {{role: string, client: any, model: string}} arg0
 * @returns {Record<string, Function>}
 */
function bindRoleSurface({ role, client, model: entryModel }) {
    if (role === ClientRole.EMBEDDING) {
        /** @param {{input: any, model?: string, signal?: AbortSignal|null}} arg0 */
        const embed = ({ input, model = entryModel, signal = null }) => client.embed({ input, model, signal });
        return { embed };
    }
    if (role === ClientRole.DECISION) {
        /** @param {{state: any, questions: Record<string, any>, signal?: AbortSignal|null}} arg0 */
        const ask = ({ state, questions, signal = null }) => client.decisions.ask({ model: entryModel, state, questions, signal });
        return { ask };
    }
    // Defaulting to the role model keeps the surface symmetric with embed/ask:
    // `roles.generative.session()` runs on GENERATIVE_MODEL, not on the backend default.
    return { session: (modelOrOptions = entryModel) => client.session(modelOrOptions) };
}


/**
 * Builds one client per distinct provider + per-role options pair and returns
 * one entry per role: the client, its provider and model, and the role's bound
 * surface (`session`, `embed`, or `ask`). Each role resolves independently, so
 * chat, embeddings and decisions may each live on a different provider.
 * @param {{roles?: Array<string>, options?: Record<string, Record<string, unknown>>, clientFactory?: (arg0: {provider: string, options: Record<string, unknown>}) => Promise<{client: unknown}>}} [arg0]
 * @returns {Promise<Record<string, RoleClient>>}
 */
export async function createRoleClients({ roles = [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION], options = {}, clientFactory = initializeClient } = {}) {
    for (const role of roles) {
        if (!ROLE_REGISTRY[role]) {
            throw new ConfigurationError({ message: `Unknown client role: "${role}". Valid: ${Object.keys(ROLE_REGISTRY).join(', ')}` });
        }
    }
    /** @type {Map<string, any>} */
    const clients = new Map();
    /** @type {Record<string, RoleClient>} */
    const out = {};
    for (const entry of roles.map((role) => resolveRole({ role }))) {
        const roleOptions = options[entry.role] ?? {};
        // Reuse only when both roles carry no per-role options. Options may hold
        // functions or circular values that no safe key can express, so a role
        // that customizes anything gets its own client instead of a collision.
        const key = Object.keys(roleOptions).length === 0 ? entry.provider : `${entry.provider}#${entry.role}`;
        let client = clients.get(key);
        if (!client) {
            client = (await clientFactory({ provider: entry.provider, options: { ...loadCredentials({ provider: entry.provider }), ...roleOptions } })).client;
            clients.set(key, client);
        }
        // Per role, not per build: a reused client must still expose this role's surface.
        assertRoleSurface({ role: entry.role, provider: entry.provider, client });
        out[entry.role] = { role: entry.role, client, provider: entry.provider, model: entry.model, ...bindRoleSurface({ role: entry.role, client, model: entry.model }) };
    }
    return out;
}


/**
 * The composition root for the decision layer: resolve the three client roles,
 * then hand back one gate (and a per-seam gate factory) plus the option
 * fragments every flow already accepts. This adds no automatic wiring — a flow
 * is only gated when you pass its fragment — so a runtime with no decision role
 * still constructs and every seam stays inert.
 * @param {{roles?: Array<string>, options?: Record<string, Record<string, unknown>>, clientFactory?: (arg0: {provider: string, options: Record<string, unknown>}) => Promise<{client: unknown}>, seams?: Array<string>|null, onDecisionUsage?: ((arg0: {usage: import('./agentic/decision-gate.mjs').DecisionUsage|null, seam: string}) => void)|null}} [arg0]
 *   `seams` pre-builds named gates for the labels you want to tell apart.
 * @returns {Promise<AgenticRuntime>}
 */
export async function createAgenticRuntime({ roles = [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION], options = {}, clientFactory = initializeClient, seams = null, onDecisionUsage = null } = {}) {
    const clients = await createRoleClients({ roles, options, clientFactory });
    const decision = clients.decision ?? null;
    // `createRoleClients` types every surface as optional (roles are dynamic);
    // the decision entry it returns carries the bound `ask`.
    const ask = /** @type {any} */ (decision?.ask ?? null);
    /** @type {Map<string, import('./agentic/decision-gate.mjs').DecisionGate>} */
    const cache = new Map();
    /**
     * @param {{seam?: string}} [arg0]
     * @returns {import('./agentic/decision-gate.mjs').DecisionGate}
     */
    const gateFor = ({ seam = 'agentic' } = {}) => {
        const key = typeof seam === 'string' && seam !== '' ? seam : 'agentic';
        if (!cache.has(key)) cache.set(key, createDecisionGate({ ask, seam: key, onUsage: onDecisionUsage }));
        return /** @type {import('./agentic/decision-gate.mjs').DecisionGate} */ (cache.get(key));
    };
    const gate = gateFor({ seam: 'agentic' });
    /** @type {Record<string, import('./agentic/decision-gate.mjs').DecisionGate>} */
    const gates = {};
    for (const seam of Array.isArray(seams) ? seams : []) gates[seam] = gateFor({ seam });
    return {
        roles: clients,
        decision,
        gate,
        gates,
        gateFor,
        sessionOptions: { decisionGate: gate },
        dag: { evaluatorOptions: { decisionGate: gate }, executorOptions: { decisionGate: gate } },
        sm: { options: { decisionGate: gate } },
        discussion: { options: { decisionGate: gate } },
        // Without a decision role these two stay inert instead of throwing: a
        // rule that never trips and a scorer that always skips.
        guardrails: { decisionTest: (/** @type {Record<string, any>} */ args = {}) => (ask ? decisionTest({ ask, ...args }) : async () => false) },
        memory: { reranker: decision ? createDecisionReranker({ ask }) : null },
        evals: { scorer: (/** @type {Record<string, any>} */ args = {}) => (ask ? EVAL_SCORERS.decision({ ask, ...args }) : () => ({ name: 'decision', passed: true, skipped: true, evidence: 'no decision role configured' })) },
    };
}


/**
 * The models a backend can currently serve. The parameter is structural: only
 * `getProfiles` is read, so a caller may pass its own client-shaped object
 * without satisfying the whole union.
 * @param {{client: {getProfiles?: () => Promise<Array<{id: string, name: string}>>}, provider: string}} arg0 - A backend client instance.
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getAvailableModels({ client, provider }) {
    const c =  (client);
    if (typeof c.getProfiles === 'function') {
        const profiles = await c.getProfiles();
        return profiles.map((p) => ({ id: p.id, name: p.name || p.id }));
    }
    return [];
}
