// @ts-check


/**
 * @file Subagent delegation (task tool).
 * @version 0.12.0
 *
 * @description
 * Client-level subagent registry + a library `task` tool. Every session
 * registers the tool by default (see ChatSessionBuilder), so DAG steps, SM
 * nodes, MAA agents, and the naive agent all get delegation for free. The tool
 * is inert until the client has profiles:
 *
 *   withTaskAgents(client, [
 *     { name: 'explore', model: '...', systemPrompt: '...', tools: [...] },
 *     { name: 'review',  execute: async ({ prompt }) => '...' }   // code agent
 *   ]);
 *
 * Profiles resolve from the spawn registry at call time (lazy), the child is
 * a fresh `client.session(profile.model)` run through the existing agentic
 * loop, and its final text becomes the tool result in the parent. Nesting is
 * depth-capped (maxDepth, default 1) and tree-capped (maxSpawns, default 128).
 * `background:true` returns immediately,
 * runs the child detached, and emits `task:finish`/`task:error` on the client.
 *
 * Transport: a profile may name `client` or `provider`; every delegation path
 * (task tool, MAA subagents, planForEach) resolves it through
 * resolveAgentClient() (the parent client's registry by default). A handoff
 * with `context:'fork'` seeds the child with the parent's real message rows
 * instead of a compacted digest.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createUserMessage, createAssistantMessage } from '../messaging/messages.mjs';
import { normalizeAgentOutput, runDueSteps, assertUsableOutput, forwardToolEvents } from './agentic-core.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { RunContext } from '../core/events.mjs';
import { runStep } from './step.mjs';
import { normalizeHandoff, goalBlockForHandoff, resolveHandoffTools } from './agent-context.mjs';
import { captureSessionPolicy, applySessionPolicy, createSession, adoptSessionId } from './session-policy.mjs';
import { attemptPoolView, ensureBudgetPool } from './budget-pool.mjs';
import { pooledClient, attachSessionPool } from './pooled-client.mjs';
import { normalizeTransfer, renderTransfer, isToolResultRow } from './transfer.mjs';
import { matchesGlob } from './permissions.mjs';
import {
    getSpawnRegistry, openSpawn, adoptSpawnIdentity, finishSpawn, failSpawn, pushAttempt, treeSpawnCount, spawnThreadId,
    setSpawnContinuation,
} from './spawn-registry.mjs';
import { EVENTS, stampEvent } from '../core/events.mjs';
import { isTransientError, getCircuitBreaker, circuitKey, runGuardedStep, BREAKER_OPEN_CODE, EMPTY_OUTPUT_CODE } from '../support/retry-policy.mjs';
import { BudgetExceededError, ConfigurationError } from '../core/errors.mjs';
import { sdkWarn } from '../support/utils.mjs';
/**
 * The emitter a delegation writes to (`task:start`, `task:finish`, `task:error`,
 * the child's forwarded stream events). Structural: the client and a bare
 * emitter both satisfy it.
 * @typedef {Object} TaskEventEmitter
 * @property {(name: string, event: Object) => void} emit
 */

/**
 * The per-run knobs a delegation forwards to its child step. A subset of
 * `runStep`'s deps: the child owns its own session, so only the turn-shaping
 * options travel.
 * @typedef {Object} TaskRunOptions
 * @property {Function} [followUp]
 * @property {boolean} [autoExtend]
 * @property {Function} [errorHandlers]
 * @property {import('./spawn-registry.mjs').SpawnRecord} [spawn]
 */

/**
 * A SessionStore as `forkSpawn` uses it. Structural: the SDK ships
 * `LocalFileSessionStore`, and a host may pass its own (`fork` is the only
 * member the fork path calls).
 * @typedef {Object} TaskSessionStore
 * @property {Function} [fork]
 * @property {Function} [load]
 * @property {Function} [save]
 */

/**
 * @typedef {Object} TaskAgent
 * @property {string} name
 * @property {string} [description] - One line shown in the `task` tool's "Available subagents" roster.
 * @property {string} [model]
 * @property {string} [provider] - Transport for this profile; resolved via the client's registry (or `resolveClient`). Falls back to the parent client when unset or matching.
 * @property {TaskClient} [client] - A ready backend client to run this profile on; wins over `provider`. Its `provider` must match when both are set.
 * @property {string} [systemPrompt] - The role template (shared, cacheable on Anthropic).
 * @property {string} [systemAdaptation] - The per-spawn adaptation (D11): appended after
 *   the template by a granted `system` argument; never replaces it.
 * @property {Array<import('../messaging/unified-parameter.mjs').Tool|string>} [tools] - Tool OBJECTS (the profile's belt); a name string is also accepted and resolved by the session.
 * @property {string[]} [toolNames] - Host-set tool NAME patterns; narrowed as an allowlist layer.
 * @property {string[]} [spawnToolNames] - Per-spawn `tools` patterns; a second allowlist layer.
 * @property {Function} [execute] - Runs the profile instead of a model session: `{ prompt, signal, session, client, budgetPool }` (a frozen view).
 *   `client.session(model)` joins the attempt/tree ledger, so its spend is reported.
 * @property {number} [maxIterations]
 * @property {number} [maxDepth]
 * @property {string} [fallbackModel]
 * @property {number} [hedgeAfterMs]
 * @property {import('../support/retry-policy.mjs').RetryPolicy} [retryPolicy]
 * @property {number} [timeoutMs]
 * @property {number} [maxElapsedMs]
 * @property {import('../support/retry-policy.mjs').CircuitBreaker} [circuitBreaker]
 * @property {{callback: Function, timeoutMs?: number}} [approval]
 * @property {{maxTotalTokens: number}} [budget]
 * @property {string} [inherit]
 * @property {import('./agent-context.mjs').HandoffOptions} [handoff]
 * @property {string|Object} [transfer] - How the parent's real rows reach the child: a preset name or { mode, select, compact, tail }. Unset keeps the legacy `fork`/`inherit:history` behavior; `ledger`* replays the parent run as message rows.
 */

/**
 * The grant state of one delegation dimension: fixed by the host, or open.
 * @typedef {'fixed'|'any'} DelegationMode
 */

/**
 * The grant state of the agent roster: a fixed roster, or any named agent.
 * @typedef {'roster'|'any'} AgentRosterMode
 */

/**
 * `client.withAgentDelegation()`'s declaration: the host's grant envelope. Each
 * dimension is granted independently; the default for every one is the most
 * restrictive, so a host that grants nothing gets a fixed roster and no ad-hoc
 * shape. The task tool's SCHEMA is derived from this, so an ungranted dimension
 * is absent rather than present-and-ignored.
 * @typedef {Object} DelegationEnvelope
 * @property {{mode: AgentRosterMode, names: string[], restricted: boolean}} agents
 * @property {DelegationMode} models
 * @property {DelegationMode} transports
 * @property {DelegationMode} system
 * @property {'fixed'|'inherit'} tools
 * @property {number} maxDepth
 * @property {boolean} maxDepthDeclared - the host named a cap (it is a ceiling).
 * @property {number} maxSpawns - how many spawns one tree may open (D9).
 * @property {boolean} maxSpawnsDeclared
 * @property {boolean} declared - false when the host never called withAgentDelegation.
 */

/**
 * @typedef {Object} TaskArgs
 * @property {string} description
 * @property {string} prompt
 * @property {string} subagent_type
 * @property {string} [objective]
 * @property {string} [context]
 * @property {string} [outputFormat]
 * @property {string} [constraints]
 * @property {boolean} [background]
 * @property {Object} [handoff]
 */

/**
 * The child session a delegation drives. Structural and mostly optional: the
 * four backends implement the full session, while a host/test may pass a
 * session-like stub that only answers the calls the delegation makes.
 * @typedef {Object} TaskChildSession
 * @property {Object|null|undefined} [client]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {TaskEventEmitter|null} [eventEmitter]
 * @property {string|null} [sessionId]
 * @property {number} [_taskDepth]
 * @property {number} [_taskMaxDepth]
 * @property {{runId?: string}} [_sessionRunCtx]
 * @property {Array<import('./chat-session.mjs').ChatRow>} [_lastStepMessages]
 * @property {Object|null} [_sessionStore]
 * @property {string|null} [_threadId]
 * @property {Object|null} [_agentContext]
 * @property {Object|null} [_retryPolicy]
 * @property {number|null} [_headerTimeoutMs]
 * @property {Object|null} [_streamTimeoutPolicy]
 * @property {Object|null} [_approvalPolicy]
 * @property {Object|null} [_budget]
 * @property {Function} [withSystemMessage]
 * @property {Function} [withTools]
 * @property {Function} [withToolAllowlist]
 * @property {Function} [withRetryPolicy]
 * @property {Function} [withStreamTimeout]
 * @property {Function} [withHeaderTimeout]
 * @property {Function} [withApproval]
 * @property {Function} [withBudget]
 * @property {Function} [withCircuitBreaker]
 * @property {Function} [withCapability]
 * @property {Function} [forkCheckpoint]
 * @property {Function} [saveCheckpoint]
 * @property {Function} [run]
 */

/**
 * @typedef {Object} TaskClient
 * The client is a transport (D2/SP5): the roster, the backend→client registry,
 * the resolver, the depth cap, the background counter/map and the delegation
 * envelope live in the spawn registry (`getSpawnRegistry({client})`), NOT here.
 * @property {(model: string) => TaskChildSession} session
 * @property {Function} [sessionWithId] - Constructs a session with the conversation id at construction.
 * @property {string} [provider]
 */

/**
 * @typedef {Object} TaskSession
 * @property {TaskClient} client
 * @property {string} model
 * @property {string} provider
 * @property {TaskEventEmitter} eventEmitter
 * @property {string|null} [sessionId]
 * @property {number} [_taskDepth]
 * @property {Map<string, TaskAgent>} [_taskAgents] - Session-local profile roster (preferred over the client registry).
 * @property {number} [_taskMaxDepth] - Session-local nesting cap. A SESSION may carry
 *   its own roster and cap; the client never does.
 * @property {boolean} [_taskMaxDepthDeclared] - False when `_taskMaxDepth` is the
 *   implicit default rather than a cap the host named; only a named cap is a ceiling (W4-2).
 * @property {{runId?: string}} [_sessionRunCtx]
 * @property {import('./agent-context.mjs').AgentContext|null} [_agentContext]
 * @property {Object|null} [_retryPolicy]
 * @property {number|null} [_headerTimeoutMs]
 * @property {number|null} [_maxElapsedMs]
 * @property {import('./chat-session.mjs').StreamTimeoutPolicyLike|null} [_streamTimeoutPolicy]
 * @property {{callback: Function, timeoutMs?: number}|null} [_approvalPolicy]
 * @property {{maxTotalTokens: number}|null} [_budget]
 * @property {string|null} [_explicitSessionId]
 * @property {Object|null} [_skillsLibrary]
 * @property {boolean} [_skillsPreload]
 * @property {Object|null} [_todoComponent]
 * @property {boolean} [_todoPreload]
 * @property {Object|null} [_memoryComponent]
 * @property {boolean} [_memoryPreload]
 * @property {Object|null} [_webSearchComponent]
 * @property {Object|null} [_webScrapeComponent]
 * @property {Object|null} [_browserComponent]
 * @property {Array<{component?: Object, preload?: boolean, volatile?: boolean, extra?: Object|null}>} [_extraStepComponents]
 * @property {Array<import('./chat-session.mjs').ChatRow>} [_lastStepMessages]
 * @property {(msg: string) => TaskSession} withSystemMessage
 * @property {(tools: Array<import('../messaging/unified-parameter.mjs').Tool|string>|null) => TaskSession} withTools
 * @property {(component: Object, opts?: {preload?: boolean}) => TaskSession} withCapability
 * @property {(p: import('../support/retry-policy.mjs').RetryPolicy) => TaskSession} withRetryPolicy
 * @property {(ms: number) => TaskSession} withHeaderTimeout
 * @property {(ms: number) => TaskSession} withMaxElapsedMs
 * @property {(cb: Function, opts?: {timeoutMs?: number}) => TaskSession} withApproval
 * @property {(budget: {maxTotalTokens: number}) => TaskSession} withBudget
 * @property {(breaker: import('../support/retry-policy.mjs').CircuitBreaker) => TaskSession} withCircuitBreaker
 * @property {(messages: Array<import('./chat-session.mjs').ChatRow>, opts?: import('./chat-session.mjs').StepOptions) => Promise<import('./chat-session.mjs').StepFinalState>} run
 */











/** The `task` tool's wire name. */
export const TASK_TOOL_NAME = 'task';

/**
 * Renders the live delegation roster for the `task` tool description
 * (`withDescriptions`) and for the unknown-subagent error (names only).
 * Profiles register through `withTaskAgents`; null when none are registered.
 * @param {{agents: Map<string, TaskAgent>|undefined|null, withDescriptions?: boolean}} arg0
 * @returns {string|null}
 */
export function renderSubagentRoster({ agents, withDescriptions = false }) {
    const list = [...(agents?.values?.() ?? [])];
    if (list.length === 0) return null;
    return list
        .map((a) => (withDescriptions && a?.description ? `${a.name} — ${a.description}` : String(a?.name ?? '')))
        .filter(Boolean)
        .join(', ');
}


/**
 * Resolves the client that should execute an agent/profile on. This is the one
 * place that turns a profile's `client`/`provider` into a transport, so every
 * delegation path (task tool, MAA subagents, planForEach) agrees.
 *
 * Precedence: an explicit `agent.client` wins; otherwise a registered
 * `agent.provider` (via `withTaskAgents({ options: { clients } })` or
 * `resolveClient`) is used. When no transport is registered and the parent
 * already speaks `agent.provider` (or carries no backend label), the parent is
 * kept — so a profile that merely tags a matching backend is not a routing
 * request and existing call sites keep working. A genuinely different backend
 * with no registered transport is a loud configuration error, never a silent
 * cross-wire.
 * @param {{parent?: {provider?: string, client?: Object|null}|null, agent?: {client?: Object|null, provider?: string, model?: string}|null}} arg0
 * @returns {TaskClient}
 */
export function resolveAgentClient({ parent, agent }) {
    if (agent?.client) {
        const c = /** @type {any} */ (agent.client);
        if (agent.provider && c.provider && agent.provider !== c.provider) {
            throw new ConfigurationError({ message: `agent.provider "${agent.provider}" does not match agent.client.provider "${c.provider}"` });
        }
        return /** @type {any} */ (c);
    }
    if (agent?.provider) {
        const registry = getSpawnRegistry({ client: parent });
        const registered = registry.clients?.get?.(agent.provider);
        if (registered) return /** @type {any} */ (registered);
        if (typeof registry.resolver === 'function') {
            const resolved = registry.resolver(agent.provider);
            if (resolved) return /** @type {any} */ (resolved);
        }
        if (!parent?.provider || parent.provider === agent.provider) return /** @type {any} */ (parent);
        throw new ConfigurationError({ message: `agent.provider "${agent.provider}" has no registered client (parent speaks "${parent.provider}"). Pass options.clients or options.resolveClient to withTaskAgents.` });
    }
    return /** @type {any} */ (parent);
}


/**
 * duplicate name wins) and returns the client for chaining.
 * @param {{client: TaskClient, agents?: Array<TaskAgent>, options?: {maxDepth?: number, clients?: Record<string, TaskClient>, resolveClient?: ((provider: string) => TaskClient|undefined|null)}}} arg0 - The MerciClient (any backend).
 *   Optional per-agent resilience: `retryPolicy` (wins over the parent
 *   session's policy), `timeoutMs` (per-agent JAI header budget),
 *   `maxElapsedMs` (total retry budget for the child's steps),
 *   `fallbackModel` (one-shot re-run of the same brief on a cheaper model
 *   when the primary fails transiently), `hedgeAfterMs` (launch a second
 *   same-brief attempt when the first yields nothing in time; first result
 *   wins — note the trade-off: the losing attempt may already have run tools,
 *   and aborting it does not undo them, so hedge only idempotent/read-only
 *   briefs), `circuitBreaker` (shared breaker; defaults to the client's
 *   per-backend/model registry), `approval` (HITL policy `{callback,timeoutMs}`
 *   overriding the parent's `withApproval` gate), `budget` (`{maxTotalTokens}`
 *   overriding the parent's `withBudget` cap), plus `model`, `description`, `systemPrompt` (the
 *   role template a per-spawn `system` adapts), `tools`,
 *   `execute`, `maxIterations`, `inherit: 'history'`, `maxDepth`.
 * @returns {TaskClient} the client
 */
export function withTaskAgents({ client, agents = [], options = {} }) {
    if (!client) throw new ConfigurationError({ message: 'withTaskAgents: client is required' });
    const registry = getSpawnRegistry({ client });
    const map = registry.agents ?? new Map();
    for (const agent of agents) {
        if (!agent || typeof agent.name !== 'string' || !agent.name) {
            throw new ConfigurationError({ message: 'withTaskAgents: every agent profile needs a string name' });
        }
        map.set(agent.name, agent);
    }
    registry.agents = map;
    if (options.clients) {
        const clients = registry.clients ?? new Map();
        for (const [backend, c] of Object.entries(options.clients)) clients.set(backend, c);
        registry.clients = clients;
    }
    if (options.resolveClient) registry.resolver = options.resolveClient;
    if (options.maxDepth !== undefined) registry.maxDepth = options.maxDepth;
    else registry.maxDepth ??= LIMITS.default_delegation_depth;
    registry.counter ??= 0;
    registry.background ??= new Map();
    return client;
}


/**
 * Declares the host's delegation envelope (D1a). Every dimension is granted
 * independently and every default is the most restrictive one; pass only the
 * dimensions the host actually grants. The task tool's schema is built from the
 * result, so the model never sees a dimension the host withheld.
 * @param {{client: TaskClient, agents?: 'any'|Array<TaskAgent>, models?: DelegationMode, transports?: DelegationMode, system?: DelegationMode, tools?: 'fixed'|'inherit', maxDepth?: number, maxSpawns?: number}} arg0
 * @returns {TaskClient} the client
 */
export function withAgentDelegation({ client, agents = undefined, models = undefined, transports = undefined, system = undefined, tools = undefined, maxDepth = undefined, maxSpawns = undefined } = /** @type {any} */ ({})) {
    if (!client) throw new ConfigurationError({ message: 'withAgentDelegation: client is required' });
    getSpawnRegistry({ client });
    /** @type {Record<string, any>} */
    const declaration = {};
    if (agents !== undefined) {
        if (agents !== 'any' && !Array.isArray(agents)) {
            throw new ConfigurationError({ message: 'withAgentDelegation: agents must be "any" or a roster array', options: { option: 'agents' } });
        }
        if (Array.isArray(agents)) {
            // A roster array registers the profiles too: one call is the whole
            // restricted configuration.
            for (const agent of agents) {
                if (!agent || typeof agent.name !== 'string' || !agent.name) {
                    throw new ConfigurationError({ message: 'withAgentDelegation: every agent profile needs a string name', options: { option: 'agents' } });
                }
            }
            withTaskAgents({ client, agents });
        }
        declaration.agents = agents;
    }
    /** @param {{key: string, value: any, allowed: string[]}} arg0 */
    const pick = ({ key, value, allowed }) => {
        if (value === undefined) return;
        if (!allowed.includes(value)) {
            throw new ConfigurationError({ message: `withAgentDelegation: ${key} must be one of ${allowed.join('|')} (got ${JSON.stringify(value)})`, options: { option: key } });
        }
        declaration[key] = value;
    };
    pick({ key: 'models', value: models, allowed: ['fixed', 'any'] });
    pick({ key: 'transports', value: transports, allowed: ['fixed', 'any'] });
    pick({ key: 'system', value: system, allowed: ['fixed', 'any'] });
    pick({ key: 'tools', value: tools, allowed: ['fixed', 'inherit'] });
    if (maxDepth !== undefined) {
        if (!Number.isFinite(maxDepth) || maxDepth < 0) {
            throw new ConfigurationError({ message: 'withAgentDelegation: maxDepth must be a non-negative number', options: { option: 'maxDepth' } });
        }
        declaration.maxDepth = Math.floor(maxDepth);
    }
    if (maxSpawns !== undefined) {
        if (!Number.isFinite(maxSpawns) || maxSpawns < 0) {
            throw new ConfigurationError({ message: 'withAgentDelegation: maxSpawns must be a non-negative number', options: { option: 'maxSpawns' } });
        }
        declaration.maxSpawns = Math.floor(maxSpawns);
    }
    getSpawnRegistry({ client }).delegation = declaration;
    return client;
}


/**
 * Resolves the effective envelope: the host's declaration over the restrictive
 * defaults. Reads the registry lazily, so a roster registered after the
 * declaration is still the menu.
 * @param {{client?: TaskClient|null, envelope?: Partial<import('./spawn-registry.mjs').SpawnDelegation>|null}} [arg0]
 * @returns {DelegationEnvelope}
 */
export function normalizeDelegationEnvelope({ client = null, envelope = null } = {}) {
    const registry = client ? getSpawnRegistry({ client }) : null;
    const raw = envelope ?? registry?.delegation ?? null;
    const declared = raw !== null && raw !== undefined;
    const declaredAgents = raw?.agents;
    const names = declaredAgents === 'any'
        ? []
        : (Array.isArray(declaredAgents)
            ? declaredAgents.map((a) => /** @type {any} */ (a)?.name ?? a).filter((n) => typeof n === 'string')
            : [...(registry?.agents?.keys?.() ?? [])]);
    return {
        // `restricted` = the host passed an explicit array, which IS the menu. An
        // undeclared envelope keeps today's semantics (the session-local roster
        // wins over the client registry).
        agents: { mode: declaredAgents === 'any' ? 'any' : 'roster', names, restricted: Array.isArray(declaredAgents) },
        models: raw?.models === 'any' ? 'any' : 'fixed',
        transports: raw?.transports === 'any' ? 'any' : 'fixed',
        system: raw?.system === 'any' ? 'any' : 'fixed',
        tools: raw?.tools === 'inherit' ? 'inherit' : 'fixed',
        maxDepth: Number.isFinite(raw?.maxDepth) ? Number(raw?.maxDepth) : (registry?.maxDepth ?? LIMITS.default_delegation_depth),
        maxDepthDeclared: Number.isFinite(raw?.maxDepth),
        // D9: the tree is bounded even when the host declared no envelope. The
        // default is finite so a runaway fan-out stops without host action.
        maxSpawns: Number.isFinite(raw?.maxSpawns) ? Math.floor(Number(raw?.maxSpawns)) : LIMITS.max_spawns,
        maxSpawnsDeclared: Number.isFinite(raw?.maxSpawns),
        declared,
    };
}


/**
 * Refuses a spawn that would exceed its tree's cap (D9). The count is the
 * registry's monotonic per-root counter, so it survives record eviction and is
 * shared by every path (the tool, MAA and a direct `runTaskChild`).
 * @param {{session?: TaskSession|null, client?: TaskClient|null, envelope?: Partial<DelegationEnvelope>|null}} arg0
 */
function assertSpawnTreeBudget({ session = null, client = null, envelope = null }) {
    void client;
    const declaredCap = envelope?.maxSpawns;
    const cap = Number.isFinite(declaredCap) ? Number(declaredCap) : LIMITS.max_spawns;
    const used = treeSpawnCount({ session });
    if (used >= cap) {
        throw new ConfigurationError({
            message: `task: spawn tree limit reached (${cap}). This tree has already opened ${used} subagent(s); raise maxSpawns with withAgentDelegation to allow more.`,
            options: { option: 'maxSpawns' },
        });
    }
}

/**
 * The async frames a code agent opens while it runs (E1). A session is shared by
 * sibling and nested calls, so a scalar on it cannot say which call is asking;
 * the frame can. It also leaves the parent session untouched, so a background
 * code spawn never holds the parent's depth for its whole run.
 */
const spawnFrames = new AsyncLocalStorage();

/**
 * The depth THIS call occupies: the session's own depth for an LLM child, or the
 * code-agent frame's depth when a profile's `execute` is running.
 * @param {{session?: any}} arg0
 * @returns {number}
 */
function currentSpawnDepth({ session = null } = {}) {
    const frame = /** @type {{depth?: number}|undefined} */ (spawnFrames.getStore());
    const framed = frame && Number.isFinite(frame.depth) ? Number(frame.depth) : 0;
    return Math.max(session?._taskDepth ?? 0, framed);
}

/**
 * The one depth cap both the advertisement (`_canDelegate`) and the call use,
 * so a tool that is offered always runs. A depth the host named (an envelope
 * `maxDepth`, or the session's own `options.maxDepth`) is a ceiling; the
 * implicit default a session installs is a fallback a profile's own `maxDepth`
 * may raise, exactly as docs/SPAWNING.md promises. An undeclared envelope keeps
 * that legacy chain (W4-2).
 * @param {{profile?: TaskAgent|null, session?: {_taskMaxDepth?: number, _taskMaxDepthDeclared?: boolean, client?: TaskClient|null}|null, envelope?: Partial<DelegationEnvelope>|null}} arg0
 * @returns {number}
 */
export function resolveDelegationMaxDepth({ profile = null, session = null, envelope = null } = {}) {
    const sessionDepth = session?._taskMaxDepth;
    const sessionCap = typeof sessionDepth === 'number' && Number.isFinite(sessionDepth) ? sessionDepth : null;
    const registryDepth = session?.client ? getSpawnRegistry({ client: session.client }).maxDepth : null;
    const clientCap = typeof registryDepth === 'number' && Number.isFinite(registryDepth) ? registryDepth : null;
    const declared = Boolean(envelope?.maxDepthDeclared);
    const declaredDepth = typeof envelope?.maxDepth === 'number' ? envelope.maxDepth : 0;
    // A session-local cap is a host statement and always applies; the client
    // default is only the implicit fallback, and a declared envelope replaces it.
    // E-8/W4-2: with nothing declared the ceiling is the session cap only when the
    // host named it — a defaulted 1 would otherwise cap every deeper profile.
    const sessionCeiling = session?._taskMaxDepthDeclared === false ? null : sessionCap;
    const ceiling = declared ? Math.min(declaredDepth, sessionCeiling ?? Infinity) : (sessionCeiling ?? Infinity);
    const fallback = declared ? declaredDepth : (clientCap ?? LIMITS.default_delegation_depth);
    const ownDepth = profile?.maxDepth;
    const own = typeof ownDepth === 'number' && Number.isFinite(ownDepth) ? ownDepth : (sessionCap ?? fallback);
    return Math.min(own, ceiling);
}


/**
 * The task tool's JSON schema, derived from the envelope (SP2). A dimension the
 * host did not grant is ABSENT — the model cannot ask for it at all. Built per
 * read so a later `withAgentDelegation` is reflected by the same tool object.
 * @param {{session: TaskSession}} arg0
 * @returns {Record<string, Object>}
 */
function taskParameters({ session }) {
    const env = normalizeDelegationEnvelope({ client: session.client });
    /** @type {Record<string, any>} */
    const properties = {
        description: { type: 'string', description: 'A short (3-5 words) description of the task.' },
        prompt: { type: 'string', description: 'The concrete instruction the subagent must execute.' },
        objective: { type: 'string', description: 'Optional subtask objective (the overall goal is appended automatically).' },
        context: { type: 'string', description: 'Key facts, references, or artifact paths the subagent needs to complete the task. Include everything — the subagent has no other access.' },
        outputFormat: { type: 'string', description: 'The exact shape the subagent must return (e.g. "a JSON array of {city, days} objects").' },
        constraints: { type: 'string', description: 'Boundaries and exclusions (what the subagent must NOT do or touch).' },
        background: {
            type: 'boolean',
            description: 'Run in the background: returns immediately and emits task:finish / task:error on the client when done.',
        },
        handoff: {
            type: 'object',
            description: 'Handoff modes for this delegation: { goal: clean|full|moderated, context: clean|full|moderated|fork, tools: inherit|none }. Goal and context vary independently (default goal full, context clean); tools default to inherit. context:"fork" seeds the subagent with the tail of your real conversation rows (cache-friendly continuation), "full" replays the whole parent conversation, "moderated" carries a compacted digest of recent rows, "clean" carries none.',
            properties: {
                goal: { type: 'string', enum: ['clean', 'full', 'moderated'] },
                context: { type: 'string', enum: ['clean', 'full', 'moderated', 'fork'] },
                tools: { type: 'string', enum: ['inherit', 'none'] },
            },
        },
    };
    if (env.agents.mode === 'any') {
        properties.subagent_type = { type: 'string', description: 'Optional: a registered profile name. Omit to spawn an ad-hoc subagent from the fields below.' };
    } else {
        properties.subagent_type = { type: 'string', description: 'The registered subagent profile name to use.' };
    }
    if (env.models === 'any' && !properties.model) {
        properties.model = { type: 'string', description: 'Optional: the model to run this subagent on.' };
    }
    if (env.transports === 'any') {
        properties.provider = { type: 'string', description: 'Optional: a registered transport to run this subagent on.' };
    }
    if (env.system === 'any') {
        properties.system = { type: 'string', description: 'Optional: adapt the subagent role prompt for THIS spawn (appended after the role template; it never replaces it).' };
    }
    if (env.tools === 'inherit') {
        properties.tools = {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: narrow the tool set for this subagent (never widens what you have).',
        };
    }
    const required = env.agents.mode === 'any' ? ['prompt'] : ['prompt', 'subagent_type'];
    return { type: 'object', properties, required };
}


/**
 * on. Reads the client registry and parent model lazily at call time, so the
 * tool can be registered in the ChatSessionBuilder constructor before the
 * session fields are populated.
 * @param {{session: TaskSession}} arg0 - The ChatSession (must expose client/model/provider/eventEmitter).
 * @returns {Object} a standard Merci SDK tool definition.
 */
export function createTaskTool({ session }) {
    return {
        name: TASK_TOOL_NAME,
        description: [
            'Delegate a task to a subagent and get back its final answer.',
            'Use this for a complex subtask that deserves a fresh context: focused research, an isolated implementation step, or any work that should not pollute this conversation.',
            'Pick subagent_type from the registered profiles (configured with withTaskAgents).',
            'The subagent is a fresh session: it sees ONLY what you write below plus your global objective (auto-appended).',
            'Structure the delegation: prompt (the concrete instruction), context (key facts or artifact references the subagent NEEDS — paste them or reference their paths), outputFormat (the exact return shape you expect), constraints (boundaries, what NOT to do).',
            'Foreground (default) blocks until the subagent finishes and returns its final text as the tool result.',
            'background:true returns immediately so you can keep working — the result arrives as a task:finish event on the client when the subagent completes. Do not wait or poll for it.',
        ].join(' '),
        // Derived per read from the delegation envelope (SP2).
        get parameters() { return taskParameters({ session }); },
        /** @param {{args: *, signal: *, context?: *}} arg0 */
        async execute({ args, signal, context = {} }) {
            const { client, model, eventEmitter } = session;
            const registry = session._taskAgents ?? getSpawnRegistry({ client })?.agents;
            const env = normalizeDelegationEnvelope({ client });
            // The envelope is an authority boundary: a granted dimension is
            // honoured, an ungranted one is refused (the schema hides it, but a
            // caller can still force arguments).
            for (const dimension of ['model', 'provider', 'system', 'tools']) {
                if (args[dimension] === undefined) continue;
                const granted = dimension === 'model' ? env.models === 'any'
                    : dimension === 'provider' ? env.transports === 'any'
                        : dimension === 'system' ? env.system === 'any'
                            : env.tools === 'inherit';
                if (!granted) {
                    throw new ConfigurationError({
                        message: `task: ${dimension} is not granted by the host delegation envelope (withAgentDelegation).`,
                        options: { option: dimension },
                    });
                }
            }
            /** @type {any} */
            let profile = args.subagent_type !== undefined ? registry?.get(args.subagent_type) : null;
            if (profile && env.agents.restricted
                && !env.agents.names.includes(String(args.subagent_type))) {
                // The declared array is the menu, not the whole registry: a host
                // that grants two roles must not silently expose a third.
                profile = null;
            }
            if (args.subagent_type !== undefined && !profile) {
                // The error names the menu the host granted, not the whole registry.
                const menu = env.agents.restricted
                    ? new Map([...((/** @type {any} */ (registry))?.entries?.() ?? [])]
                        .filter(([name]) => env.agents.names.includes(String(name))))
                    : registry;
                const available = renderSubagentRoster({ agents: menu })
                    ?? (env.agents.restricted ? 'none (the host grants no subagent profiles)' : null);
                throw new ConfigurationError({ message: `task: unknown subagent_type "${args.subagent_type}". Available: ${available ?? 'none registered (call withTaskAgents)'}.` });
            }
            if (!profile) {
                if (env.agents.mode !== 'any') {
                    throw new ConfigurationError({ message: 'task: subagent_type is required (the host delegation envelope offers a fixed roster).', options: { option: 'subagent_type' } });
                }
                profile = { name: 'custom' };
            }
            // Per-spawn values ride the profile: the engine already honours
            // model/systemPrompt/tools, so the shape is the only change.
            if (args.model !== undefined || args.system !== undefined || args.provider !== undefined || Array.isArray(args.tools)) {
                // Never mutate the registry object: a per-spawn list must not leak
                // into the next spawn (or a concurrent one).
                profile = { ...profile };
            }
            if (args.model !== undefined) profile.model = args.model;
            if (args.provider !== undefined) profile.provider = args.provider;
            if (args.system !== undefined) profile.systemAdaptation = args.system;
            if (args.tools !== undefined) {
                if (!Array.isArray(args.tools) || args.tools.some((/** @type {any} */ t) => typeof t !== 'string')) {
                    throw new ConfigurationError({ message: 'task: tools must be an array of tool names', options: { option: 'tools' } });
                }
                profile.spawnToolNames = [...args.tools];
            }

            const depth = currentSpawnDepth({ session });
            const maxDepth = resolveDelegationMaxDepth({ profile, session, envelope: env });
            if (depth >= maxDepth) {
                throw new ConfigurationError({ message: `task: subagent depth limit reached (${maxDepth}). Increase maxDepth to allow nested subagents.` });
            }
            assertSpawnTreeBudget({ session, client, envelope: env });

            const stepRun = context?.runContext ?? null;
            const background = args.background === true;
            const counter = getSpawnRegistry({ client });
            const taskId = background ? `task_${(counter.counter = (counter.counter ?? 0) + 1)}` : null;
            eventEmitter.emit(EVENTS.TASK.START, stampEvent({ name: EVENTS.TASK.START, payload: {
                ...(taskId ? { id: taskId } : {}),
                subagent_type: profile.name,
                description: args.description,
                background,
            }, runContext: stepRun }));

            const guardOutput = /** @type {(...args: any[]) => any} */ (( result) => assertUsableOutput({
                text: result,
                what: `Subagent "${profile.name}" returned no usable output.`,
            }));
            // SP1 — the spawn is an identity, not a call: open the record before
            // the work starts so a background caller can hold it.
            const spawnRegistry = getSpawnRegistry({ client });
            const record = openSpawn({
                registry: spawnRegistry,
                parent: session,
                agent: profile.name,
                model: profile.model ?? model ?? null,
                provider: profile.provider ?? session.provider ?? null,
            });
            record.profile = profile;
            record.eventEmitter = eventEmitter;
            record.parentClient = client;
            // N5: a continuation has no step of its own, so it hangs off the step
            // that spawned it — the lineage must not break on a second turn.
            record.runContext = stepRun;
            // E4: a foreground subagent is not a black box. Its text, thoughts and tool
            // calls are re-emitted on the parent emitter, correlated to the spawning step,
            // so a caller watching events sees the child work as it happens (the MAA path
            // already did this).
            const onChildEvent = childEventForwarder({ eventEmitter, stepRun, profile, fallbackId: taskId });
            // `runTaskChild` owns settling; the tool only supplies the identity
            // (opened before the work so a background caller can hold a handle).
            const run = () => runTaskChild({
                session, profile, args, signal, eventEmitter, stepRun, guardOutput, onChildEvent,
                runOptions: { spawn: record },
            });

            if (background) {
                return startBackground({ client, eventEmitter, profile, args, run, signal, taskId, stepRun, spawn: record });
            }

            try {
                const result = await run();
                eventEmitter.emit(EVENTS.TASK.FINISH, stampEvent({ name: EVENTS.TASK.FINISH, payload: {
                    subagent_type: profile.name,
                    description: args.description,
                    result,
                }, runContext: stepRun }));
                return result;
            } catch (err) {
                eventEmitter.emit(EVENTS.TASK.ERROR, stampEvent({ name: EVENTS.TASK.ERROR, payload: {
                    subagent_type: profile.name,
                    description: args.description,
                    error: (/** @type {any} */ (err)).message,
                }, runContext: stepRun }));
                throw err;
            }
        },
    };
}


/**
 * E4/N5: re-emits a child's stream on the parent's emitter. The forwarding is
 * observation, not control flow — a throwing listener is a warning, never a
 * failed child (N3) — and every event names the child and the node it runs for
 * (the spawning step, or the spawn id when a continuation has no step).
 * @param {{eventEmitter: any, stepRun: any, profile: any, fallbackId?: string|null}} arg0
 * @returns {(e: Record<string, any>) => void}
 */
function childEventForwarder({ eventEmitter, stepRun, profile, fallbackId = null }) {
    return forwardToolEvents({
        emit: (/** @type {{name: string, payload: Record<string, any>}} */ { name, payload }) => {
            try {
                eventEmitter?.emit?.(name, stampEvent({ name, payload, runContext: stepRun }));
            } catch (error) {
                sdkWarn({ prefix: 'TASK', args: [`a parent listener threw on forwarded event '${name}': ${/** @type {Error} */ (error).message}`] });
            }
        },
        textEvent: EVENTS.WORKFLOW.STEP_TEXT,
        thoughtEvent: EVENTS.WORKFLOW.STEP_THOUGHT,
        toolStartEvent: EVENTS.WORKFLOW.STEP_TOOL_CALL_START,
        toolEndEvent: EVENTS.WORKFLOW.STEP_TOOL_CALL_END,
        thoughtSignatureEvent: EVENTS.WORKFLOW.STEP_AGENT_THOUGHT_SIGNATURE,
        makePayload: (/** @type {{content: string}} */ { content }) => ({
            stepId: /** @type {any} */ (stepRun)?._stepId ?? fallbackId ?? 'task',
            subagent: profile?.name ?? 'task',
            type: 'task',
            content,
        }),
    });
}

/**
 * A host listener that throws must not break the spawn (nor deadlock the
 * continuation chain); the event is best-effort.
 * @param {{emitter: any, name: string, envelope: {name: string, payload: any, runContext?: any}}} arg0
 */
function safeEmit({ emitter, name, envelope }) {
    try {
        emitter?.emit?.(name, stampEvent(envelope));
    } catch {
        // listener failures are the host's problem, not the delegation's
    }
}

/**
 * A background result must not land in a void: it is queued for the parent's next
 * turn so the next turn sees it. The queue is placement-safe even when the parent's
 * turn ended mid tool round — `interleavePendingRows` closes the round with a
 * synthetic result instead of dropping the notification (N4).
 * @param {{session: any, profile: any, result: any}} arg0
 */
function appendBackgroundResult({ session, profile, result }) {
    if (!session) return;
    // F1: `step()` replaces `_lastStepMessages` when the parent's turn commits,
    // so a row pushed there is lost. The inbox is drained by the next step.
    session._pendingInputRows = [
        ...(Array.isArray(session._pendingInputRows) ? session._pendingInputRows : []),
        createAssistantMessage({
            provider: session.provider,
            content: `[Subagent "${profile.name}" finished]\n${String(result ?? '')}`,
        }),
    ];
}

/**
 * Runs another turn on a live child session (SP3). The child keeps its rows,
 * context and tools; only the prompt and the ledger change.
 * @param {{client: TaskClient, id: string, prompt: string, signal?: AbortSignal|null}} arg0
 * @returns {Promise<Object>}
 */
/**
 * Saves the winning session's checkpoint at settle time. `_runOnce` already saves
 * after a successful turn, but a failed turn and a hedge's winner are not covered
 * there, and a durability write must never turn a delivered answer into a failure.
 * @param {{record: any}} arg0
 * @returns {Promise<void>}
 */
async function saveSpawnCheckpoint({ record }) {
    const session = record?.session;
    if (!session || typeof session.saveCheckpoint !== 'function') return;
    if (!session._sessionStore || !session._threadId) return;
    try {
        await session.saveCheckpoint();
        // "last durability write" means exactly that: a later success clears it.
        record.checkpointError = null;
    } catch (err) {
        record.checkpointError = String((/** @type {any} */ (err))?.message ?? err);
    }
}

/**
 * Branches a durable child's conversation (D10). In-process it forks the spawn's
 * own checkpoint; across processes pass `{ store, threadId }` (the thread id is
 * deterministic: `spawnThreadId({ id })`) and the store forks it directly.
 * @param {{client?: TaskClient|null, id?: string|null, newThreadId: string, overwrite?: boolean, store?: TaskSessionStore|null, threadId?: string|null}} arg0
 * @returns {Promise<import('./sessions.mjs').SessionCheckpoint>}
 */
export async function forkSpawn({ client = null, id = null, newThreadId, overwrite = false, store = null, threadId = null } = /** @type {any} */ ({})) {
    if (!newThreadId) throw new ConfigurationError({ message: 'forkSpawn: newThreadId is required', options: { option: 'newThreadId' } });
    if (!id && threadId && store) {
        if (typeof store.fork !== 'function') throw new ConfigurationError({ message: 'forkSpawn: this SessionStore does not support forking', options: { option: 'store' } });
        return await store.fork({ threadId, newThreadId, overwrite });
    }
    const registry = getSpawnRegistry({ client });
    const record = registry.spawns.get(String(id));
    if (!record) {
        // Cross-process: the record is gone but the host knows the id (or the
        // thread) and holds the store, so fork straight from the store.
        const fallbackThread = threadId ?? (id ? spawnThreadId({ id: String(id) }) : null);
        if (store && fallbackThread && typeof store.fork === 'function') {
            return await store.fork({ threadId: fallbackThread, newThreadId, overwrite });
        }
        throw new ConfigurationError({ message: `task: no spawn with id "${id}"` });
    }
    const session = record.session;
    const resolvedThread = record.threadId ?? session?._threadId ?? null;
    if (!resolvedThread) {
        throw new ConfigurationError({
            message: 'task: this spawn has no conversation to fork (a code-agent spawn has none, and a spawn is only durable when the host attached a SessionStore)',
            options: { option: 'withSessionStore' },
        });
    }
    if (session && typeof session.forkCheckpoint === 'function' && session._sessionStore) {
        return await session.forkCheckpoint({ newThreadId, overwrite });
    }
    const resolvedStore = store ?? session?._sessionStore ?? null;
    if (!resolvedStore || typeof resolvedStore.fork !== 'function') {
        throw new ConfigurationError({ message: 'forkSpawn: the spawn has no SessionStore in memory; pass { store, threadId } to fork it', options: { option: 'store' } });
    }
    return await resolvedStore.fork({ threadId: resolvedThread, newThreadId, overwrite });
}

/**
 * Continues a settled spawn's conversation with one more turn (SP3). The spawn
 * must still be in this process's registry; a durable child resumed in another
 * process is loaded with `withSessionStore` + `loadCheckpoint()` instead.
 * @param {{client: TaskClient|null, id: string, prompt?: string, signal?: AbortSignal|null}} arg0
 * @returns {Promise<Object>}
 */
export async function continueSpawn({ client, id, prompt = '', signal }) {
    const registry = getSpawnRegistry({ client });
    const record = registry.spawns.get(String(id));
    if (!record) throw new ConfigurationError({ message: `task: no spawn with id "${id}"` });
    const session = record.session;
    if (!session) {
        throw new ConfigurationError({ message: 'task: cannot continue a spawn with no session (a code-agent spawn has no conversation)' });
    }
    if (!record.profile) throw new ConfigurationError({ message: 'task: this spawn has no profile to continue with' });
    // One turn at a time per conversation: a promise CHAIN, not a single await,
    // because every waiter on one promise would wake together and interleave.
    // The FIRST turn has no queue yet: chain from its in-flight promise.
    const prior = record.turnQueue
        ?? (record.status === 'running' && record.promise ? record.promise.catch(() => {}) : Promise.resolve());
    let releaseTurn = () => {};
    record.turnQueue = prior.then(() => new Promise((resolve) => { releaseTurn = () => resolve(undefined); }));
    // Wait for the previous turn BEFORE reading its rows, so two continuations
    // chain instead of both extending the same base.
    await prior.catch(() => {});
    // F5: an early failure nulls `_lastStepMessages`; the last input we sent is
    // the conversation the next turn must extend.
    const history = Array.isArray(session._lastStepMessages) && session._lastStepMessages.length > 0
        ? session._lastStepMessages
        : (Array.isArray(record.history) ? record.history : []);
    // The continued session starts a new turn: un-bank it so its fresh usage counts.
    record.bankedSessions?.delete(session);
    record.status = 'running';
    record.error = null;
    const messages = [
        ...history,
        createUserMessage({ provider: /** @type {string} */ (session.provider), content: String(prompt) }),
    ];
    record.history = messages;
    const work = runStep({ step: record.profile, deps: {
        client: session.client ?? /** @type {TaskClient} */ (client),
        model: session.model,
        session,
        configureSession: false,
        messages,
        maxIterations: record.profile.maxIterations,
        signal,
        // N5: a continued turn streams like its first one — the same forwarder,
        // named by the spawn (a continuation has no spawning node).
        onEvent: childEventForwarder({
            eventEmitter: record.eventEmitter,
            stepRun: record.runContext ?? null,
            profile: record.profile,
            fallbackId: record.id,
        }),
        runContext: record.runContext ? RunContext.child(record.runContext) : null,
    } }).then((outcome) => assertUsableOutput({
        text: outcome.result,
        what: `Spawn "${record.agent}" returned no usable output on continuation.`,
    }));
    safeEmit({ emitter: record.eventEmitter, name: EVENTS.TASK.START, envelope: { name: EVENTS.TASK.START, payload: {
        id: record.id, subagent_type: record.agent, description: `continue: ${String(prompt).slice(0, 60)}`, background: false,
    }, runContext: record.runContext ?? null } });
    const promise = Promise.resolve(work).then(async (result) => {
        finishSpawn({ record, result });
        await saveSpawnCheckpoint({ record });
        safeEmit({ emitter: record.eventEmitter, name: EVENTS.TASK.FINISH, envelope: { name: EVENTS.TASK.FINISH, payload: {
            id: record.id, subagent_type: record.agent, result,
        }, runContext: record.runContext ?? null } });
        return result;
    }, async (err) => {
        failSpawn({ record, error: err });
        await saveSpawnCheckpoint({ record });
        safeEmit({ emitter: record.eventEmitter, name: EVENTS.TASK.ERROR, envelope: { name: EVENTS.TASK.ERROR, payload: {
            id: record.id, subagent_type: record.agent, error: (/** @type {any} */ (err))?.message,
        }, runContext: record.runContext ?? null } });
        throw err;
    }).finally(() => releaseTurn());
    record.promise = promise;
    return promise;
}

setSpawnContinuation({ fn: ({ record, prompt, signal }) => continueSpawn({ client: record.parentClient ?? null, id: record.id, prompt, signal }) });

/**
 * `client.send({id, prompt})` — the addressing form of `continueWith`.
 * @param {{client: TaskClient, id: string, prompt: string, signal?: AbortSignal|null}} arg0
 * @returns {Promise<Object>}
 */
export function sendToSpawn({ client, id, prompt, signal }) {
    return continueSpawn({ client, id, prompt, signal });
}

/**
 * Runs one delegation attempt for a profile against a parent session-like.
 * Shared by the `task` tool and the MAA subagent paths (discussion-session) so
 * a profile behaves identically however it is reached: same brief assembly,
 * same capability/objective inheritance, same resilience ladder.
 * @param {{session: TaskSession, profile: TaskAgent, args: TaskArgs, signal?: AbortSignal|null, eventEmitter: TaskEventEmitter, stepRun?: import('../core/events.mjs').RunContext|null, guardOutput?: ((result: Object) => Object)|null, onChildEvent?: Function|null, runOptions?: TaskRunOptions}} arg0
 * @returns {Promise<Object>}
 */
export function runTaskChild({ session, profile, args, signal, eventEmitter, stepRun = null, guardOutput = null, onChildEvent = null, runOptions = {} }) {
    const guard = guardOutput ?? (( r) => r);
    if (profile.transfer != null) normalizeTransfer({ transfer: profile.transfer });
    // A direct call (MAA, a host calling this function) must obey the same two
    // bounds as the tool: the depth cap and the per-tree spawn cap (D9). The
    // tool checks before opening the record; this covers every other path.
    if (!runOptions.spawn) {
        const envelope = normalizeDelegationEnvelope({ client: session?.client ?? null });
        const depth = currentSpawnDepth({ session });
        const maxDepth = resolveDelegationMaxDepth({ profile, session, envelope });
        // A depth-0 direct call is the HOST's own action (the MAA planner, a
        // caller of this function): the envelope bounds the model's delegation,
        // not the host's. Only a nested direct call is capped here.
        if (depth >= 1 && depth >= maxDepth) {
            throw new ConfigurationError({ message: `task: subagent depth limit reached (${maxDepth}). Increase maxDepth to allow nested subagents.` });
        }
        assertSpawnTreeBudget({ session, client: session?.client ?? null, envelope });
    }
    // One spawn record per delegation, settled exactly once, however it was
    // reached (the task tool, the MAA/subagent paths, a direct call).
    const spawn = runOptions.spawn ?? openSpawn({
        registry: getSpawnRegistry({ client: session?.client ?? null }),
        parent: session,
        agent: profile.name,
        model: profile.model ?? session?.model ?? null,
        provider: profile.provider ?? session?.provider ?? null,
    });
    // A continuation must work however the spawn was reached (task tool, MAA,
    // direct call): the profile and the client live on the record.
    spawn.profile ??= profile;
    spawn.parentClient ??= session?.client ?? null;
    spawn.eventEmitter ??= eventEmitter ?? null;
    const work = profile.execute
        ? runCodeAgentHeld({ session, profile, args: { ...args, prompt: buildChildInput({ args, session, profile }) }, signal }).then(guard)
        : runLlmChild({ session, profile, args, signal, eventEmitter, stepRun, guardOutput: guard, onChildEvent, runOptions: { ...runOptions, spawn } });
    const promise = Promise.resolve(work).then(async (result) => {
        finishSpawn({ record: spawn, result });
        await saveSpawnCheckpoint({ record: spawn });
        return result;
    }, async (err) => {
        failSpawn({ record: spawn, error: err });
        // A failed child still did work; its last turn is durable when the host
        // opted into a store.
        await saveSpawnCheckpoint({ record: spawn });
        throw err;
    });
    spawn.promise = promise;
    return promise;
}


/**
 * @param {{session: TaskSession, profile: TaskAgent, args: TaskArgs, depth: number, modelOverride?: string|undefined, spawn?: any}} arg0
 */
function buildLlmChild({ session, profile, args, depth, modelOverride, spawn = null }) {
    const { model } = session;
    const owner = resolveAgentClient({ parent: session.client, agent: profile });
    const inheritedSessionId = session.sessionId ?? session._sessionRunCtx?.runId ?? null;
    const childModel = modelOverride ?? profile.model ?? model;
    // The factory returns the backend's own (open) session object; this path drives
    // it as a task child, so it names that surface at the boundary.
    const child = /** @type {any} */ (createSession({ client: /** @type {import('./session-policy.mjs').SessionClientLike} */ (owner), model: childModel, sessionId: inheritedSessionId }));
    // A budget the child already had is its own cap; one copied from the parent
    // is the tree cap and must stay shared.
    const hadOwnBudget = Boolean(child._budget);
    adoptSessionId({ session: child, sessionId: inheritedSessionId });
    if (spawn) {
        // Remember every attempt's session: a hedge builds the second attempt
        // before the first reports its spend, so usage is read at settle time.
        pushAttempt({ record: spawn, session: child });
        adoptSpawnIdentity({ session: child, record: spawn });
        if (!spawn.model) spawn.model = childModel;
        if (!spawn.provider) spawn.provider = child.provider;
    }
    // Policy travels with the delegation. A child that only copies retry/
    // budget/approval used to expose tools the parent denied and skip the
    // parent's guardrails/hooks. One capture/apply pair keeps every policy
    // surface in sync (and gives profile overrides a base to override).
    applySessionPolicy({ session: child, policy: captureSessionPolicy({ session }) });
    // D10: persistence is opt-in. The host's store travels with the delegation,
    // but the child is stored under its OWN deterministic thread — never the
    // parent's, which the child would otherwise overwrite.
    if (spawn && child._sessionStore) {
        const threadId = spawnThreadId({ id: spawn.id });
        if (typeof child.withSessionStore === 'function') child.withSessionStore({ store: child._sessionStore, threadId });
        else child._threadId = threadId;
        spawn.threadId = threadId;
    }
    child._taskDepth = depth + 1;
    if (session._taskAgents) child._taskAgents = session._taskAgents;
    if (session._taskMaxDepth !== undefined) child._taskMaxDepth = session._taskMaxDepth;
    const handoff = normalizeHandoff({ handoff: args.handoff ?? profile.handoff });
    // The authority boundary lands before inheritance: a child that cannot
    // enforce it must fail with the intended error, not a downstream TypeError.
    applyHandoffToolScope({ session, child, handoff });
    const handoffTools = handoff.tools;
    const childTools = resolveHandoffTools({ handoff, fallback: null });
    if (handoffTools !== 'none') inheritCapabilities({ parent: session, child });
    // `handoff.tools` names tools; `withTools` takes tool objects. Filter the
    // profile belt by those names instead of handing it strings.
    for (const layer of [profile.toolNames, profile.spawnToolNames]) {
        if (!Array.isArray(layer)) continue;
        // The per-spawn `tools` list narrows the child; it never widens, because
        // the allowlist layers compose with the inherited scope (wave 5). An
        // empty list is a real grant meaning "no tools", so it is applied too.
        if (typeof child.withToolAllowlist !== 'function') {
            throw new ConfigurationError({
                message: 'task: tools is set but the child session cannot enforce it (withToolAllowlist is missing)',
                options: { option: 'tools' },
            });
        }
        child.withToolAllowlist({ patterns: layer });
    }
    const explicitTools = Array.isArray(handoffTools)
        ? (Array.isArray(profile.tools) ? profile.tools.filter((t) => handoffTools.some((pattern) => typeof pattern === 'string' && matchesGlob({ name: typeof t === 'string' ? t : (t?.name ?? ''), pattern }))) : [])
        : childTools;
    if (session._agentContext && handoff.goal !== 'clean') child._agentContext = session._agentContext.child();
    // SP6: the role prompt is the shared, cacheable template; the per-spawn
    // objective/handoff block is the adaptation. The session turns this into a
    // split system only on a backend with a per-block cache marker (and only
    // when the host opted into caching); everywhere else it is one joined string,
    // exactly as before.
    const roleTemplate = profile.systemPrompt ?? '';
    // D11: the role template is shared; the per-spawn system is an ADAPTATION
    // appended to it, not a replacement — replacing it would throw away the
    // house style the template exists to keep (and the cacheable prefix).
    const adaptation = [profile.systemAdaptation ?? '', goalBlockForHandoff({ ctx: session._agentContext, handoff })]
        .filter(Boolean).join('\n\n');
    if (roleTemplate || adaptation) {
        child.withSystemMessage([
            ...(roleTemplate ? [{ text: roleTemplate, cache: true }] : []),
            ...(adaptation ? [{ text: adaptation, cache: false }] : []),
        ]);
    }
    if (explicitTools ? explicitTools.length > 0 : profile.tools?.length) child.withTools({ tools: explicitTools ?? profile.tools });
    if (profile.retryPolicy) child.withRetryPolicy?.({ policy: profile.retryPolicy });
    else if (session._retryPolicy) child.withRetryPolicy?.({ policy: session._retryPolicy });
    if (session._streamTimeoutPolicy) child.withStreamTimeout?.({ policy: session._streamTimeoutPolicy });
    if (typeof profile.timeoutMs === 'number' && Number.isFinite(profile.timeoutMs) && profile.timeoutMs > 0) child.withHeaderTimeout?.({ ms: profile.timeoutMs });
    else if (typeof session._headerTimeoutMs === 'number' && Number.isFinite(session._headerTimeoutMs) && session._headerTimeoutMs > 0) child.withHeaderTimeout?.({ ms: session._headerTimeoutMs });
    if (typeof profile.maxElapsedMs === 'number' && Number.isFinite(profile.maxElapsedMs) && profile.maxElapsedMs > 0) child.withMaxElapsedMs?.({ ms: profile.maxElapsedMs });
    else if (typeof session._maxElapsedMs === 'number' && Number.isFinite(session._maxElapsedMs) && session._maxElapsedMs > 0) child.withMaxElapsedMs?.({ ms: session._maxElapsedMs });
    const approval = profile.approval ?? session._approvalPolicy;
    if (approval) child.withApproval?.({ fn: approval.callback, options: { timeoutMs: approval.timeoutMs } });
    const childBudget = profile.budget ?? session._budget;
    if (childBudget) child.withBudget?.({ budget: childBudget });
    // D12: the child draws from the parent's pool (one cap per tree). A child
    // budget above is a tighter LOCAL cap; it never rewrites the tree's. The
    // helper re-links a memoized child and registers it so the attempt's release
    // detaches it; a child live in another attempt is refused.
    const pool = ensureBudgetPool({ session }) ?? null;
    if (pool) attachSessionPool({ session: child, pool, share: true, ownBudget: Boolean(profile.budget) || hadOwnBudget });
    const breakerKey = circuitKey({ provider: child.provider, model: child.model });
    child.withCircuitBreaker?.({ breaker: profile.circuitBreaker ?? getCircuitBreaker({ client: owner, key: breakerKey }) });
    return child;
}


/**
 * @template T
 * @param {{profile: TaskAgent, breaker: import('../support/retry-policy.mjs').CircuitBreaker, provider?: string|undefined, signal?: AbortSignal|null, eventEmitter: TaskEventEmitter, stepRun?: import('../core/events.mjs').RunContext|null, eventMeta?: Object, attempt: (arg0: { modelOverride: string|undefined, runSignal: AbortSignal|null|undefined }) => Promise<T>}} arg0
 * @returns {Promise<T>}
 */
export async function runDelegationLadder({ profile, breaker, provider = undefined, signal, eventEmitter, stepRun = null, eventMeta = {}, attempt }) {
    /** @param {{type: *, extra: *}} arg0 */
    const stamp = ({ type, extra }) => stampEvent({ name: type, payload: { subagent_type: profile.name, ...eventMeta, ...extra }, runContext: stepRun });
    const hedgeMs = profile.hedgeAfterMs;
    const hedged = typeof hedgeMs === 'number' && Number.isFinite(hedgeMs) && hedgeMs > 0;
    /** @param {{fallbackModel: *, error: *, reason: *}} arg0 */
    const fallbackEvent = ({ fallbackModel, error, reason }) => eventEmitter.emit(EVENTS.TASK.FALLBACK, stamp({ type: EVENTS.TASK.FALLBACK, extra: {
        fallbackModel, error, reason,
    } }));

    return runGuardedStep({
        breaker,
        signal,
        run: async () => {
            const [outcome] = await runDueSteps({ steps: [{
                key: profile.name,
                run: () => hedged
                    /** @param {{runSignal: *}} arg0 */
                    ? runHedged({ attempt: /** @type {(...args: any[]) => any} */ (({ runSignal }) => attempt({ modelOverride: undefined, runSignal })), hedgeAfterMs: hedgeMs, parentSignal: signal, onHedge: () =>
                        eventEmitter.emit(EVENTS.TASK.HEDGE, stamp({ type: EVENTS.TASK.HEDGE, extra: { hedgeAfterMs:  (hedgeMs) } })) })
                    : attempt({ modelOverride: undefined, runSignal: signal }),
            }] });
            if (outcome.status === 'rejected') throw outcome.reason;
            return /** @type {Awaited<ReturnType<typeof attempt>>} */ (outcome.value);
        },
        onBreakerOpen: () => {
            if (profile.fallbackModel) {
                fallbackEvent({ fallbackModel: profile.fallbackModel, error: 'circuit breaker open for primary model', reason: 'breaker-open' });
                return attempt({ modelOverride: profile.fallbackModel, runSignal: signal });
            }
            throw exhaustionError({ profile, primaryError: breakerOpenError({ provider: provider ?? '' }), hedged: false });
        },
        /** @param {{err: *}} arg0 */
        onFailure: async ({ err: primaryError }) => {
            if (signal?.aborted) throw primaryError;
            const emptyOutput =  (primaryError)?.code === EMPTY_OUTPUT_CODE;
            if (profile.fallbackModel && (isTransientError({ error: primaryError }) || emptyOutput)) {
                fallbackEvent({ fallbackModel: profile.fallbackModel, error: primaryError?.message ?? String(primaryError), reason: emptyOutput ? 'empty-output' : 'transient' });
                try {
                    return await attempt({ modelOverride: profile.fallbackModel, runSignal: signal });
                } catch (fallbackError) {
                    throw exhaustionError({ profile, primaryError, fallbackError:  (fallbackError), hedged });
                }
            }
            throw exhaustionError({ profile, primaryError, hedged });
        },
    });
}


/**
 * @param {{session: TaskSession, profile: TaskAgent, args: TaskArgs, signal: any, eventEmitter: *, stepRun: any, guardOutput: (result: any) => any, onChildEvent?: Function|null, runOptions?: *}} arg0
 */
async function runLlmChild({ session, profile, args, signal, eventEmitter, stepRun, guardOutput, onChildEvent = null, runOptions = {} }) {
    const depth = currentSpawnDepth({ session });
    const handoff = normalizeHandoff({ handoff: args.handoff ?? profile.handoff });
    const policy = normalizeTransfer({ transfer: profile.transfer ?? null });
    const brief = buildChildInput({ args, session, profile, includeParentBlock: false, transferMode: policy.mode });
    /** @param {{modelOverride?: *, runSignal: *}} arg0 */
    const attempt = async ({ modelOverride, runSignal }) => {
        const child = buildLlmChild({ session, profile, args, depth, modelOverride, spawn: runOptions?.spawn ?? null });
        const parentRows = await parentContextRows({ session, child, handoff, policy, eventEmitter });
        const outcome = await runStep({ step: profile, deps: {
            client: child.client,
            model: child.model,
            session: child,
            configureSession: false,
            journal:  (/** @type {any} */ (session))._journal ?? null,
            journalBoundary: `${ (/** @type {any} */ (session))._journalScope ?? ''}task:${profile.name}:${runOptions?.spawn?.id ?? ''}:`,
            messages: [...parentRows, createUserMessage({ provider: child.provider, content: brief })],
            // E3: the child run hangs off the spawning step, not off a fresh root, so its
            // events carry `parentRunId` and a lineage a reader can follow.
            runContext: stepRun ? RunContext.child(stepRun) : null,
            maxIterations: profile.maxIterations,
            signal: runSignal,
            followUp: runOptions.followUp,
            autoExtend: runOptions.autoExtend,
            errorHandlers: runOptions.errorHandlers,
            onEvent: onChildEvent ?? undefined,
        } });
        // The first attempt to RETURN is the one whose result the ladder keeps
        // (a hedge takes the first winner; a sequential retry only returns on
        // success), so it is the session a later `continueWith` must resume.
        const spawn = runOptions?.spawn ?? null;
        if (spawn && !spawn.winner) spawn.winner = child;
        return guardOutput(outcome.result);
    };
    const primaryModel = profile.model ?? session.model;
    const owner = resolveAgentClient({ parent: session.client, agent: profile });
    const breaker = profile.circuitBreaker ?? getCircuitBreaker({ client: owner, key: circuitKey({ provider: owner.provider ?? session.provider, model: primaryModel }) });
    return runDelegationLadder({ profile, breaker, provider: owner.provider ?? session.provider, signal, eventEmitter, stepRun, eventMeta: { description: args.description }, attempt: /** @type {(arg0: {modelOverride: string | undefined, runSignal: any}) => Promise<any>} */ (attempt) });
}


/**
 * @returns {Promise<any>}
  * @param {{attempt: *, hedgeAfterMs: *, parentSignal: *, onHedge: *}} arg0
 */
function runHedged({ attempt, hedgeAfterMs, parentSignal, onHedge }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let secondStarted = false;
        const controllers = [new AbortController(), new AbortController()];
        const onParentAbort = () => controllers.forEach((c) => c.abort(parentSignal?.reason));
        if (parentSignal) {
            if (parentSignal.aborted) onParentAbort();
            else parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
        
        /** @type {any[]} */
                const errors = [];
        let inFlight = 0;
        /** @param {{fn: *, value: *}} arg0 */
        const finish = ({ fn, value }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            controllers.forEach((c) => { try { c.abort('hedge settled'); } catch {   } });
            parentSignal?.removeEventListener('abort', onParentAbort);
            fn(value);
        };
        /** @param {{index: *}} arg0 */
        const watch = ({ index }) => {
            inFlight++;
            attempt({ modelOverride: undefined, runSignal: controllers[index].signal }).then(
                /** @type {(...args: any[]) => any} */ (( result) => {
                    inFlight--;
                    finish({ fn: resolve, value: result });
                }),
                /** @type {(...args: any[]) => any} */ (( err) => {
                    inFlight--;
                    errors[index] = err;
                    if (settled) return;
                    if (parentSignal?.aborted) {
                        finish({ fn: reject, value: err });
                        return;
                    }
                    if (!secondStarted) {
                        secondStarted = true;
                        clearTimeout(timer);
                        onHedge();
                        watch({ index: 1 });
                    } else if (inFlight === 0) {
                        finish({ fn: reject, value: errors[0] ?? err });
                    }
                }),
            );
        };
        const timer = setTimeout(() => {
            if (settled || secondStarted) return;
            secondStarted = true;
            onHedge();
            watch({ index: 1 });
        }, hedgeAfterMs);
        if (typeof timer.unref === 'function') timer.unref();
        watch({ index: 0 });
    });
}


/**
  * @param {{provider?: *}} arg0
 */
function breakerOpenError({ provider }) {
    const err =  (new Error(`Circuit breaker open for ${provider ?? 'backend'} — the gateway is down, not slow.`));
    /** @type {any} */ (err).code = BREAKER_OPEN_CODE;
    return err;
}


/**
  * @param {{profile: *, primaryError: *, fallbackError?: *, hedged?: *}} arg0
 */
function exhaustionError({ profile, primaryError, fallbackError = null, hedged = false }) {
    const last = fallbackError ?? primaryError;
    // A configuration or budget error is not a retry outcome; returning it keeps
    // its type and avoids re-absorbing usage the failing session already charged.
    if (last instanceof ConfigurationError || last instanceof BudgetExceededError) return last;
    const tried = [
        'primary model',
        hedged ? 'hedged 2nd attempt' : null,
        profile.fallbackModel ? `fallback model ${profile.fallbackModel}` : null,
    ].filter(Boolean).join(' → ');
    const msg = String(last?.message ?? last);
    let hint;
    if (last?.code === 'HEADER_TIMEOUT' || /header timeout/i.test(msg)) {
        hint = 'the gateway queued longer than the header budget — raise JAI_HEADER_TIMEOUT_MS (secret.env) or set a per-agent timeoutMs, then re-run';
    } else if (last?.code === BREAKER_OPEN_CODE || /circuit breaker/i.test(msg)) {
        hint = 'the gateway is failing repeatedly — wait out the breaker cooldown (~30s) or switch profile.model to another provider';
    } else if (last?.status === 429 || /rate limit|429/i.test(msg)) {
        hint = 'the provider is rate-limiting — wait a minute, lower parallel delegations, or set profile.fallbackModel';
    } else if (typeof last?.status === 'number' && last.status >= 500) {
        hint = 'the provider errored server-side — it is usually transient, just re-run';
    } else if (last?.code === EMPTY_OUTPUT_CODE) {
        hint = profile.fallbackModel
            ? 'both the primary and fallback models answered empty — re-run, or raise the profile maxIterations'
            : 'the model answered empty — re-run, or set profile.fallbackModel for automatic degrade on empty output';
    } else {
        hint = 're-run the delegation; set profile.fallbackModel for automatic degrade';
    }
    const err =  (new Error(`Subagent "${profile.name}" failed (${tried}). Last error: ${msg}. Hint: ${hint}.`));
    if (last?.code) /** @type {any} */ (err).code = last.code;
    if (last?.status != null) /** @type {any} */ (err).status = last.status;
    if (last?.option) /** @type {any} */ (err).option = last.option;
    // SP4: a host that catches the wrapped failure must still see WHICH budget
    // ran out and how much the tree had spent — the numbers live on the cause,
    // and a caller should not have to unwrap to log them.
    for (const key of ['usage', 'maxTotalTokens', 'maxBudgetUsd', 'costUsd']) {
        if (last?.[key] !== undefined) /** @type {any} */ (err)[key] = last[key];
    }
    err.cause = last;
    return err;
}


/**
  * @param {{parent: *, child: *}} arg0
 */
function inheritCapabilities({ parent, child }) {
    const seen = new Set();
    /** @param {{component: *, preload: *, volatile?: boolean, extra?: Object|null}} arg0 */
    const inherit = ({ component, preload, volatile = false, extra = null }) => {
        if (!component || seen.has(component)) return;
        seen.add(component);
        // volatile/extra must survive inheritance: a live-state block that lands
        // in a subagent's cached prefix is the same cache bug one level down.
        child.withCapability({ capability: component, preload, ...(volatile ? { volatile: true } : {}), ...(extra ? { extra } : {}) });
    };
    inherit({ component: parent._skillsLibrary, preload: parent._skillsPreload ?? false });
    // The listing is not enough for a script skill: the child must be able to
    // call the skill's own tool, which the parent registered in _skillToolsStore.
    if (Array.isArray(parent._skillToolsStore) && parent._skillToolsStore.length > 0) {
        child._skillToolsStore = [...(child._skillToolsStore ?? []), ...parent._skillToolsStore];
    }
    inherit({ component: parent._todoComponent, preload: parent._todoPreload ?? true });
    inherit({ component: parent._memoryComponent, preload: parent._memoryPreload ?? false });
    inherit({ component: parent._webSearchComponent, preload: true });
    inherit({ component: parent._webScrapeComponent, preload: true });
    inherit({ component: parent._browserComponent, preload: true });
    for (const entry of parent._extraStepComponents ?? []) {
        inherit({ component: entry?.component, preload: entry?.preload ?? false, volatile: entry?.volatile === true, extra: entry?.extra ?? null });
    }
}


/**
 * A cross-backend replay cannot carry a foreign wire verbatim: the renderer
 * degrades units to visible digest rows. Emit the event so a silent loss is
 * impossible (same event for `fork` and `full`).
 * @param {{eventEmitter: any, session: any, child: any, rendered: any}} arg0
 */
function emitDegradedReplay({ eventEmitter, session, child, rendered }) {
    if (!eventEmitter || !rendered) return;
    const crossBackend = child.provider !== session.provider;
    if (!crossBackend && !(rendered.degraded > 0)) return;
    eventEmitter.emit(EVENTS.TASK.FORK_DEGRADED, stampEvent({ name: EVENTS.TASK.FORK_DEGRADED, payload: {
        parentProvider: session.provider ?? null,
        childProvider: child.provider ?? null,
        degraded: rendered.degraded,
        rows: rendered.rows.length,
    } }));
}


/**
 * `handoff.tools` is an authority boundary, not a wire hint. It is applied as a
 * session-local allowlist COMPOSED with the inherited permission rules, so it
 * cannot grant what the parent denied and it never rewrites the parent policy.
 * `'none'` and `[]` deny every tool. Entries are tool names or glob patterns.
 * Fails closed when the child cannot enforce the restriction.
 * @param {{session: any, child: any, handoff: any}} arg0
 */
function applyHandoffToolScope({ session, child, handoff }) {
    const tools = handoff?.tools;
    if (tools !== 'none' && !Array.isArray(tools)) return;
    if (typeof child.withToolAllowlist !== 'function') {
        throw new ConfigurationError({
            message: 'handoff.tools is set but the child session cannot enforce it (withToolAllowlist is missing)',
            options: { option: 'tools' },
        });
    }
    child.withToolAllowlist({ patterns: tools === 'none' ? [] : [...tools] });
}


/**
 * @param {any} m
 */
function compactRow(m) {
    if (!m || typeof m !== 'object') return String(m ?? '');
    const role = m.role || m.type || 'message';
    let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (m.tool_calls?.length) content += ` [tool_calls: ${m.tool_calls.map(/** @type {(...args: any[]) => any} */ (( tc) => tc.function?.name ?? tc.name ?? '?')).join(', ')}]`;
    if (String(content).length > LIMITS.parent_history_row_cap) content = String(content).slice(0, LIMITS.parent_history_row_cap) + '…(truncated)';
    return `${role}: ${content}`;
}


/**
 * Groups a flat parent message run into transfer units at non-tool
 * boundaries, so each unit replays verbatim (roles and tool pairing kept) and
 * windowing never splits a tool call from its result. A dangling leading
 * tool-result keeps its own unit and the renderer degrades it.
 * @param {{rows: any[], provider: string|undefined}} arg0
 * @returns {Array<import('./transfer.mjs').TransferUnit>}
 */
function groupRowsIntoUnits({ rows, provider }) {
    /** @type {Array<import('./transfer.mjs').TransferUnit>} */
    const units = [];
    for (const row of rows) {
        if (!isToolResultRow(row) || units.length === 0) {
            units.push({ id: `parent-${units.length}`, provider, messages: [] });
        }
        /** @type {any[]} */ (units[units.length - 1].messages).push(row);
    }
    for (const unit of units) unit.output = /** @type {any[]} */ (unit.messages).map(compactRow).join('\n');
    return units;
}


/**
 * The parent-side rows a child inherits. `ledger` transfer renders the parent
 * run through the shared renderer (windowed/degraded per the policy);
 * otherwise the legacy `fork` slice applies; `clean` carries nothing.
 * @param {{session: *, child: *, handoff: *, policy: *, eventEmitter?: *}} arg0
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function parentContextRows({ session, child, handoff, policy, eventEmitter = null }) {
    if (handoff.context === 'clean') return [];
    // 'moderated' is delivered as the compacted digest block in buildChildInput,
    // not as replayed rows: a summary is text, not fake wire history.
    if (handoff.context === 'moderated') return [];
    const rows = Array.isArray(session._lastStepMessages) ? session._lastStepMessages : [];
    if (rows.length === 0) return [];
    const units = groupRowsIntoUnits({ rows, provider: session.provider });
    if (handoff.context === 'full') {
        // The model-facing enum wins over the profile's transfer window: "full"
        // means the whole conversation. ponytail: bounded only by the parent run;
        // 'moderated' is the cheap option for long runs.
        const rendered = await renderTransfer({
            units,
            transfer: { mode: 'ledger', select: 'all' },
            targetProvider: child.provider,
        });
        emitDegradedReplay({ eventEmitter, session, child, rendered });
        return rendered.rows;
    }
    if (policy.mode === 'ledger') {
        const rendered = await renderTransfer({ units, transfer: policy, targetProvider: child.provider });
        return rendered.rows;
    }
    if (handoff.context !== 'fork') return [];
    // Fork through the same unit renderer as ledger mode. A raw slice could
    // start on a tool result whose call was just outside the window, producing
    // a malformed child request. Units keep a call/result pair together, and
    // the renderer degrades a dangling unit instead of replaying it.
    const rendered = await renderTransfer({
        units,
        transfer: { mode: 'ledger', select: 'tail', tail: LIMITS.parent_fork_rows },
        targetProvider: child.provider,
    });
    emitDegradedReplay({ eventEmitter, session, child, rendered });
    return rendered.rows;
}


/**
  * @param {{args: *, session: *, profile: *, includeParentBlock?: *, transferMode?: string|null}} arg0
 */
function buildChildInput({ args, session, profile, includeParentBlock = true, transferMode = null }) {
    const handoff = normalizeHandoff({ handoff: args.handoff ?? profile.handoff });
    const parentBlock = includeParentBlock
        ? goalBlockForHandoff({ ctx: session._agentContext, handoff })
        : '';
    const subtaskObjective = args.objective ? `[Subtask Objective]\n${args.objective}` : '';
    const contextBlock = args.context ? `[Context]\n${args.context}` : '';
    const formatBlock = args.outputFormat ? `[Output Format]\n${args.outputFormat}` : '';
    const constraintsBlock = args.constraints ? `[Constraints]\n${args.constraints}` : '';
    let historyBlock = '';
    // The context enum owns the digest: 'moderated' always wants the compacted
    // recent-rows block. An unspecified context keeps the legacy profile switch.
    const contextMode = handoff.context;
    const wantsDigest = contextMode === 'moderated' || (contextMode === undefined && profile.inherit === 'history');
    if ((contextMode === 'moderated' || transferMode !== 'ledger') && wantsDigest
        && Array.isArray(session._lastStepMessages) && session._lastStepMessages.length > 0) {
        const historyRows = LIMITS.parent_history_rows;
        const rows = session._lastStepMessages.slice(-historyRows).map(compactRow).join('\n');
        historyBlock = `[Parent conversation (recent ${Math.min(session._lastStepMessages.length, historyRows)} rows)]\n${rows}`;
    }
    return [parentBlock, subtaskObjective, args.prompt, contextBlock, formatBlock, constraintsBlock, historyBlock]
        .filter(Boolean)
        .join('\n\n');
}



/**
 * E1: a code-agent profile never builds a child session, so it used to leave the
 * depth at the parent's value — a recursive `execute` profile recursed without
 * the cap the LLM path enforces. Run the profile inside a frame at the depth the
 * spawn occupies; the guard the recursive call reaches reads that frame. Sibling
 * and concurrent calls each get their own frame, and the parent session is never
 * mutated (a background code spawn must not hold the parent's depth).
 * @param {{session?: any, profile: any, args: any, signal: any}} arg0
 * @returns {Promise<any>}
 */
async function runCodeAgentHeld({ session, profile, args, signal }) {
    const depth = currentSpawnDepth({ session }) + 1;
    return spawnFrames.run({ depth }, () => runCodeAgent({ session, profile, args, signal }));
}

/**
 * The client an `execute` body may use. A code agent builds no session, so the
 * attempt ledger (or the tree pool) the parent session carries is the only way
 * its own model calls are reported; the view returns sessions that join it.
 * @param {{session?: any}} arg0
 * @returns {{client: any, budgetPool: any}}
 */
function codeAgentClient({ session }) {
    const candidate = session?.client ?? null;
    const base = candidate && typeof candidate.session === 'function'
        ? candidate
        : /** @type {any} */ (getSpawnRegistry({ client: candidate }).client);
    const pool = session?._budgetPool ?? null;
    if (!pool || typeof base?.session !== 'function') return { client: base, budgetPool: pool };
    return { client: pooledClient({ client: base, pool }), budgetPool: pool };
}

/**
 * Detaches the sessions `execute` attached: the runner's own release covers the
 * attempt, but a direct call must not retain them on the pool. The ledger's list
 * is snapshotted first, so a session that joined before the call (the parent,
 * a sibling) keeps its ledger.
 * @param {{pool: any, before: Array<any>}} arg0
 * @returns {void}
 */
function releaseCodeAgentSessions({ pool, before }) {
    if (!pool || !Array.isArray(pool.attached)) return;
    for (const session of [...pool.attached]) {
        if (before.includes(session)) continue;
        if (session?._budgetPool !== pool) continue;
        delete session._budgetPool;
        const index = pool.attached.indexOf(session);
        if (index >= 0) pool.attached.splice(index, 1);
    }
}

/**
 * @param {{session?: any, profile: *, args: *, signal: *}} arg0
 * @returns {Promise<any>}
 */
async function runCodeAgent({ session, profile, args, signal }) {
    const { client, budgetPool } = codeAgentClient({ session });
    const before = Array.isArray(budgetPool?.attached) ? [...budgetPool.attached] : [];
    /** @type {any} */
    let raw;
    try {
        raw = await ( (profile.execute))({ prompt: args.prompt, signal, session, client, budgetPool: attemptPoolView({ pool: budgetPool }) });
    } finally {
        releaseCodeAgentSessions({ pool: budgetPool, before });
    }
    return normalizeAgentOutput({ raw });
}



/**
 *   correlate on one runId (a detached completion used to lose the parent's runId).
  * @param {{client: *, eventEmitter: *, profile: *, args: *, run: *, signal: *, taskId?: *, stepRun?: *, spawn?: any}} arg0
 */
function startBackground({ client, eventEmitter, profile, args, run, signal, taskId = null, stepRun = null, spawn = null }) {
    // SP5: the counter and the in-flight map live in the registry, so a session
    // that was never registered on the client still has both.
    const registry = getSpawnRegistry({ client });
    registry.counter = registry.counter ?? 0;
    registry.background ??= new Map();
    let id = taskId;
    if (!id) {
        registry.counter += 1;
        id = `task_${registry.counter}`;
    }
    eventEmitter.emit(EVENTS.TASK.BACKGROUND_STARTED, stampEvent({ name: EVENTS.TASK.BACKGROUND_STARTED, payload: {
        id,
        subagent_type: profile.name,
        description: args.description,
    }, runContext: stepRun }));
    const promise = run()
        .then(/** @type {(...args: any[]) => any} */ (( result) => {
            appendBackgroundResult({ session: spawn?.parent ?? null, profile, result });
            eventEmitter.emit(EVENTS.TASK.FINISH, stampEvent({ name: EVENTS.TASK.FINISH, payload: {
                id,
                subagent_type: profile.name,
                description: args.description,
                result,
            }, runContext: stepRun }));
            return result;
        }))
        .catch(/** @type {(...args: any[]) => any} */ (( err) => {
            eventEmitter.emit(EVENTS.TASK.ERROR, stampEvent({ name: EVENTS.TASK.ERROR, payload: {
                id,
                subagent_type: profile.name,
                description: args.description,
                error: err.message,
            }, runContext: stepRun }));
        }))
        .finally(() => {
            registry.background.delete(id);
        });
    registry.background.set(id, promise);
    if (spawn) {
        spawn.promise = promise;
        spawn.taskId = id;
    }
    return `Task started in background (id: ${id}). You will be notified via the task:finish event on the client when it completes. Do not wait or poll for its result.`;
}
