// @ts-check
/**
 * @file Fluent ChatSession builder shared by every backend.
 * @version 0.12.0
 *
 * @description
 * The mutable configuration side of a ChatSession: user directive, system
 * prompt, capabilities (memory, todos, skills, state machine, task agents),
 * plan/execute agents, parameters, retry/timeout policies and durable
 * checkpoints. `run()` hands off to the shared agentic loop
 * (runAgenticLoop). AbstractChatSession extends it to add the step engine.
 */

import { runAgenticLoop, assertNotInFlight } from './agentic-core.mjs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isToolPermitted, matchesGlob, normalizePermissionRules, PERMISSION_MODES } from './permissions.mjs';
import { createGuardrails } from './guardrails.mjs';
import { CompositeApiObserver } from '../support/api-observer.mjs';
import { InactivityTimeoutPolicy } from '../support/stream-timeout.mjs';
import { sdkWarn, sdkError, emitParameterWarning, resolveProtocol } from '../support/utils.mjs';
import { createTaskTool, renderSubagentRoster, resolveDelegationMaxDepth, normalizeDelegationEnvelope, TASK_TOOL_NAME } from './task.mjs';
import { AgentContext } from './agent-context.mjs';
import { normalizeObjectivePolicy } from './objective.mjs';
import { createUserMessage } from '../messaging/messages.mjs';
import { ATTEMPT_LEDGER, ensureBudgetPool, syncBudgetPoolCaps } from './budget-pool.mjs';
import { interleavePendingRows, claimInboxRows, claimInboxTurn, listInboxRows, cancelInboxRow, setInboxRowDelivery, normalizeDelivery, restoreInboxRows } from './pending-inbox.mjs';
import { getSpawnRegistry } from './spawn-registry.mjs';
import { createStateMachineTool } from './state-machine/machine.mjs';
import { MemoryManager } from './memory/manager.mjs';
import { MemoryComponent } from './memory/component.mjs';
import { ProviderMemoryEngine } from './memory/engine.mjs';
import { SkillsLibrary } from '../tools/skills.mjs';
import { TodoComponent } from './todos/component.mjs';
import { KnowledgeComponent } from './knowledge/component.mjs';
import { WebSearchComponent } from './websearch/component.mjs';
import { WebScrapeComponent } from './webscrape/component.mjs';
import { BrowserComponent } from './browser/component.mjs';
import { resolveSearchMode } from './websearch/engines.mjs';
import { resolveScrapeMode } from './webscrape/engines.mjs';
import { resolveBrowserMode } from './browser/engines.mjs';
import { normalizeInject } from './web-shared.mjs';
import { createPlanExitTool, createPlanStageFollowUp, AGENT_PLAN, AGENT_EXECUTE, isToolAllowed } from './plan/component.mjs';
import { createWorkspaceTools } from './workspace/toolbox.mjs';
import { warnRefusedSpecKeys } from '../messaging/unified-parameter.mjs';

/**
 * The client handle the builder holds: a delegation client plus the optional
 * Task API surface the JAI backend exposes.
 * @typedef {import('./task.mjs').TaskClient & {tasks?: Object}} BuilderClient
 */

/** The memory client the builder falls back to; only `embed` is read.
 * @typedef {Object} MemoryClient
 * @property {Function} [embed]
 * @property {string} [provider]
 */

/** A telemetry exporter `withTelemetry()` accepts.
 * @typedef {Object} TelemetryExporter
 * @property {Function} [onRequest]
 * @property {Function} [attach]
 * @property {Function} [detach]
 */

/** One plugin component rendered into the step context.
 * @typedef {Object} StepComponentEntry
 * @property {import('../core/loadable.mjs').LoadableComponent|null} component
 * @property {boolean} preload
 * @property {string} errorLabel
 * @property {boolean} rethrowAbort
 * @property {Object} [extra]
 * @property {boolean} [volatile]
 */

/** The `withWebSearch()` options.
 * @typedef {Object} WebSearchOptions
 * @property {string} [mode]
 * @property {boolean} [force]
 * @property {number} [maxResults]
 * @property {number} [maxUses]
 * @property {string[]} [allowedDomains]
 * @property {string[]} [blockedDomains]
 * @property {Object|null} [location] - Passed through to the engine (neither engine supports it; the component warns).
 * @property {boolean} [includeVendorMetadata]
 * @property {Record<string, unknown>|null} [tavily] - Passed to the Tavily engine (its apiKey plus its own knobs).
 * @property {Object|null} [inject]
 * @property {Object} [component]
 * @property {boolean} [preload]
 */

/** The run knobs `run()` / `stream()` / `runStreamed()` forward — the loop's
 * own option bag, so an editor autocompletes them and a new loop knob is named
 * in one place.
 * @typedef {import('./agentic-core.mjs').LoopOptions} LoopOptions
 */

/** The config bag `_attachWebCap()` normalises and hands to the component.
 * @typedef {Object} WebCapConfig
 * @property {string} [mode]
 * @property {string} [model]
 * @property {boolean} [force]
 * @property {Object|null} [inject]
 */
import { captureSessionPolicy } from './session-policy.mjs';
import { ApprovalCoordinator } from './planning/approval.mjs';
import {
    DEFAULT_SYSTEM_PROMPT,
    SYSTEM_MESSAGE_MERGE_SEPARATOR,
    CAPABILITY,
    CAPABILITY_REGISTRY,
    DEFAULT_PRELOAD,
    WEB_SEARCH_TOOL_NAME,
    WEB_SEARCH_MODES,
    WEB_SCRAPE_TOOL_NAME,
    WEB_SCRAPE_MODES,
    BROWSER_TOOL_NAME,
    BROWSER_MODES,
    TOOL_SEARCH_TOOL_NAME,
    isNativeMode,
    ProviderType
} from '../core/constants/index.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { AbstractMethodError, ConfigurationError } from '../core/errors.mjs';
import { EVENTS, stampEvent, emitEvent } from '../core/events.mjs';
import { toWireToolParameters } from '../support/json.mjs';
import { attachDecisionUsage, mergeDecisionGate } from './decision-usage.mjs';




/**
 * Whether a value is an async iterable — the shape of a **streamed** input.
 * @param {{ value: any }} arg0 -
 * @returns {boolean}
 */
function isAsyncIterable({ value }) {
    return Boolean(value)
        && typeof value !== 'string'
        && typeof value[Symbol.asyncIterator] === 'function';
}


/**
 * Fluent builder for ChatSession configuration. Every `with*` returns the
 * builder for chaining; `run()` executes the agentic loop.
 */
export class ChatSessionBuilder {
    /** @type {boolean} */
    _planHandoff = false;

    constructor() {
        
        /** @type {string|null} */
                this._explicitSessionId = null;
        
        /** @type {import('./journal.mjs').ExecutionJournal|null} */
                this._journal = null;
        
        /** @type {Object|null} */
                this._compaction = null;
        
        /** @type {string|null} */
                this._userSystemMessage = null;
        
        /** @type {string|null} */
                this._sdkDescriptor = null;
        
        /** @type {string[]} */
                this._announcedParts = [];
        
        /** @type {Set<string>} */
                this._activatedCaps = new Set();
        
        /** @type {Record<string, Object|null>|undefined} */
                this._parameters = {};
        this._memoryManager = /** @type {MemoryManager|null} */ (null);
        this._memoryClient = /** @type {MemoryClient|null} */ (null);
        
        /** @type {Array<import('../messaging/unified-parameter.mjs').Tool>} */
                this._toolsStore = [];
        /** The handle bound by `withWorkspace()`, or null. @type {import('./workspace/manager.mjs').WorkspaceHandleLike|null} */
        this._workspace = null;
        /** Names of deferred tools that `tool_search` has activated. @type {Set<string>} */
        this._activatedDeferredTools = new Set();
        /** @type {import('../messaging/unified-parameter.mjs').Tool|null} */
        this._toolSearchTool = null;
        
        /** @type {Array<import('../messaging/unified-parameter.mjs').Tool>} */
                this._skillToolsStore = [];
        this._approvalPolicy = null;
        this._budget = null;
        /** @type {import('./decision-gate.mjs').DecisionGate|null} */
        this._decisionGate = null;

        /** @type {import('./chat-session.mjs').RetryPolicyLike|null} */
        this._retryPolicy = null;

        /** @type {string[][]|undefined} */
        this._toolAllowlists = undefined;

        /** @type {number|undefined} */
        this._totalTimeoutMs = undefined;

        /** @type {import('./chat-session.mjs').ApiObserverLike|undefined} */
        this._apiObserver = undefined;

        /** @type {import('./chat-session.mjs').StreamTimeoutPolicyLike|undefined} */
        this._streamTimeoutPolicy = undefined;

        /** @type {import('../support/retry-policy.mjs').CircuitBreaker|undefined} */
        this._circuitBreaker = undefined;

        /** @type {number|null|undefined} */
        this._headerTimeoutMs = undefined;

        /** @type {number|null} */
        this._toolTimeoutMs = LIMITS.tool_timeout_ms || null;
        /** @type {number|null} */
        this._maxParallelTools = LIMITS.max_parallel_tools || null;

        /** @type {import('./permissions.mjs').PermissionRules} */
        this._permissionRules = { allow: [], deny: [], mode: 'default' };

        /** @type {{rules: Array<import('./guardrails.mjs').GuardrailRule>, check: Function}|null} */
        this._guardrails = null;

        /** @type {TelemetryExporter|null} */
        this._telemetryExporter = null;

        /** @type {(() => void)|null} */
        this._telemetryDetach = null;
        
        /** @type {boolean} */
                this._objectivePassWarned = false;
        
        /** @type {Object|null} */
                this._vendorClient = null;
        
        /** @type {Map<string, Array<import('../messaging/unified-parameter.mjs').Tool>>} */
                this._capabilityTools = new Map();
        this._registerCapabilityTools({ capId: CAPABILITY.TASK, tools: [createTaskTool({ session: /** @type {any} */ (this) })] });
        /** @type {SkillsLibrary|null} */
        this._skillsLibrary = null;
        this._skillsPreload = DEFAULT_PRELOAD;
        this._memoryComponent = null;
        this._memoryPreload = DEFAULT_PRELOAD;
        
        /** @type {Array<StepComponentEntry>} */
                this._extraStepComponents = [];
        /** @type {Array<{name?: string, order: number, process: Function}>} */
                this._contextProcessors = [];
        /** @type {import('../core/hooks.mjs').HookRegistry|null} */
                this._hooks = null;
        this._todoComponent = null;
        this._todoPreload = DEFAULT_PRELOAD;
        this._webSearchComponent = /** @type {import('../core/loadable.mjs').LoadableComponent|null} */ (null);
        this._webScrapeComponent = /** @type {import('../core/loadable.mjs').LoadableComponent|null} */ (null);
        // m18: the web capabilities' per-step block is preload-configurable. The
        // default stays on — that is the documented behaviour — but `preload:
        // false` now keeps the tool and drops the block.
        this._webSearchPreload = true;
        this._webScrapePreload = true;
        this._browserPreload = true;
        this._browserComponent = /** @type {import('../core/loadable.mjs').LoadableComponent|null} */ (null);
        
        /** @type {string|null} */
                this._agent = null;
        
        /** @type {string|null} */
                this._agentPrev = null;
        
        /** @type {Record<string, string>|null} */
                this._agentRules = null;
        
        /** @type {Array<import('../messaging/unified-parameter.mjs').Tool>} */
                this._planTools = [];
        this._planExitTool = /** @type {import('../messaging/unified-parameter.mjs').Tool|null} */ (null);
         /** @type {import('./planning/approval.mjs').ApprovalCoordinator|null} */
                  this._planExitCoordinator = null;
        this._planExitRequested = false;
        
        /** @type {boolean} */
                this._planHandoff = false;
        this._autoContext = null;
         /** @type {import('node:events').EventEmitter|null} */
                  this.eventEmitter = null;
         /** @type {Object|null|undefined} */
                  this.client = undefined;
         /** @type {number|undefined} */
                  this._taskDepth = undefined;
         /** @type {Map<string, import('./task.mjs').TaskAgent>|undefined} */
                  this._taskAgents = undefined;
         /** @type {number|undefined} */
                  this._taskMaxDepth = undefined;
         /** @type {boolean|undefined} True when the host named that cap; false when it is the implicit default (W4-2). */
                  this._taskMaxDepthDeclared = undefined;
         /** @type {string|undefined} */
                  this.provider = undefined;
         /** @type {string|undefined} */
                  this.standard = undefined;
         /** @type {string|undefined} */
                  this.model = undefined;
         /** @type {string|undefined} */
                  this.protocol = undefined;
         /** @type {import('../core/events.mjs').RunContext|undefined} */
                  this._sessionRunCtx = undefined;
         /** @type {Array<import('./chat-session.mjs').ChatRow>|undefined} */
                  this._lastStepMessages = undefined;
         /** @type {AgentContext|null} */
                  this._agentContext = null;
    }

    
    /**
     * Stable conversation id: explicit (withSessionId / inherited / checkpoint)
     * wins, else the auto-minted id carried by this session's RunContext.
     * @type {string|null}
     */
        get sessionId() {
        return this._explicitSessionId ?? this._sessionRunCtx?.sessionId ?? null;
    }

    set sessionId(id) {
        this._explicitSessionId = id;
        if (this._sessionRunCtx) this._sessionRunCtx.sessionId = id;
    }

    
    /**
     * The active agent name (identity): AGENT_EXECUTE by default, AGENT_PLAN
     * after withPlan() until withExecute() overrides it.
     * @returns {string}
     */
        get agent() {
        return this._agent ?? AGENT_EXECUTE;
    }

    /**
     * The workspace handle bound by `withWorkspace()`, or `null`.
     * @returns {import('./workspace/manager.mjs').WorkspaceHandleLike|null}
     */
        get workspace() {
        return this._workspace;
    }

    
    /**
      * @param {{name: string, rules: Record<string, string>}} arg0
     */
        _setAgent({ name, rules }) {
        const prev = this.agent;
        if (prev !== name) {
            this._agentPrev = this._agent;
            this._agent = name;
            if (this.eventEmitter?.emit) {
                this.eventEmitter.emit(EVENTS.CLIENT.AGENT_CHANGED, stampEvent({ name: EVENTS.CLIENT.AGENT_CHANGED, payload: { from: prev, to: name } }));
            }
        }
        this._agentRules = rules;
    }

    
    /**
     * @param {{options?: {store?: Map<string, import('./todos/component.mjs').TodoTask>|null, filePath?: string|null, approvalTimeoutMs?: number, rules?: Record<string, string>}}} arg0 -
     * @returns {this}
     */
        withPlan({ options = {} } = {}) {
        if (!this._todoComponent) {
            this.withTodos({ store: options.store ?? new Map(), options: { filePath: options.filePath ?? null } });
        }
        this._planExitTool = createPlanExitTool({ session: /** @type {import('./plan/component.mjs').PlanSession} */ (this) });
        this._planExitCoordinator = new ApprovalCoordinator({ timeoutMs: options.approvalTimeoutMs });
        this._setAgent({ name: AGENT_PLAN, rules: { ...(options.rules ?? {}) } });
        return this;
    }

    
    /**
     * @param {{options?: {rules?: Record<string, string>}}} arg0 -
     * @returns {this}
     */
        withExecute({ options = {} } = {}) {
        this._setAgent({ name: AGENT_EXECUTE, rules: { '*': 'allow', ...(options.rules ?? {}) } });
        return this;
    }

    
    /**
     * @param {{tools: Array<Object>}} arg0 -
     * @returns {this}
     */
        withPlanTools({ tools }) {
        this._planTools = (Array.isArray(tools) ? tools : []).filter(Boolean);
        return this;
    }

    
    /**
     * @param {{approved?: boolean, details?: Record<string, unknown>}} arg0 -
     * @returns {this}
     */
        approvePlanExit({ approved = true, details = {} } = {}) {
        this._planExitCoordinator?.resolve({ approved, details });
        return this;
    }

    
    /**
     * rendered into the system context each step.
     * @param {{options?: {root?: string, env?: boolean, instructions?: boolean, stopAt?: string}}} arg0 -
     * @returns {this}
     */
        withAutoContext({ options = {} } = {}) {
        this._autoContext = {
            root: options.root ?? process.cwd(),
            env: options.env !== false,
            instructions: options.instructions !== false,
            stopAt: options.stopAt,
        };
        return this;
    }

    
    /**
     * Sets the user's true system content (merged into the system slot each
     * step, right after the SDK descriptor). A string is one block; an array is
     * a split system (SP6) — `{text, cache: true}` blocks are the cacheable
     * role template, `cache: false` blocks are the per-spawn adaptation. The
     * split reaches the wire only on Anthropic with `withPromptCache()`.
     * `{ content }` is accepted as a wrapper for either form; any other object
     * is a `ConfigurationError` instead of rendering "[object Object]".
     * @param {string|null|Array<{text: string, cache?: boolean}>|{content?: string|null|Array<{text: string, cache?: boolean}>}} content
     * @returns {this}
     */
        withSystemMessage(content) {
        if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
            if (!Object.prototype.hasOwnProperty.call(content, 'content')) {
                throw new ConfigurationError({ message: 'withSystemMessage: an object must carry a `content` string or block array.', options: { option: 'withSystemMessage' } });
            }
            const inner = /** @type {{content?: string|null|Array<{text: string, cache?: boolean}>}} */ (content).content;
            if (inner === null) return this.withSystemMessage(null);
            if (typeof inner !== 'string' && !Array.isArray(inner)) {
                throw new ConfigurationError({ message: 'withSystemMessage: `content` must be a string or an array of {text, cache?} blocks.', options: { option: 'withSystemMessage' } });
            }
            if (Array.isArray(inner) && !inner.every((b) => b && typeof b === 'object' && typeof b.text === 'string')) {
                throw new ConfigurationError({ message: 'withSystemMessage: every `content` block must be {text: string, cache?: boolean}.', options: { option: 'withSystemMessage' } });
            }
            return this.withSystemMessage(inner);
        }
        // SP6: `string` keeps the historical behaviour; an array is a split
        // system — a cacheable role template plus a per-spawn adaptation.
        if (Array.isArray(content)) {
            this._userSystemBlocks = content
                .map((/** @type {any} */ b) => ({
                    text: String(b?.text ?? ''),
                    ...(b?.cache === false ? { cache: false } : {}),
                }))
                .filter((/** @type {any} */ b) => b.text.length > 0);
            this._userSystemMessage = null;
            return this;
        }
        this._userSystemBlocks = null;
        this._userSystemMessage = content;
        return this;
    }

    
    /**
     * - Called with **no argument**: injects the default SDK descriptor
     *   (`DEFAULT_SYSTEM_PROMPT`).
     * - Called with a **non-empty string**: injects that string as a
     *   user-provided SDK descriptor.
     * - Called with `null`, `undefined`, or `''`: treated as if the method was
     *   never called (no descriptor) and surfaced loudly — a
     *   `parameter_warning` event plus an SDK error line.
     * Additive and idempotent: the descriptor is prepended to the system
     * prompt and injected only once, no matter how many times this is called
     * (the last non-empty value wins). Call order is irrelevant — the
     * descriptor is always rendered before capability announces and the user
     * system message.
     * @param {{args?: Array<string|null|undefined>}} arg0 - Zero args for the SDK
     *   default, or one non-empty descriptor string.
     * @returns {this}
     */
        withSDKDescriptorMessage({ args = [] } = {}) {
        if (args.length === 0) {
            this._sdkDescriptor = DEFAULT_SYSTEM_PROMPT;
            return this;
        }
        const content = args[0];
        if (content === null || content === undefined || content === '') {
            this._sdkDescriptor = null;
            emitParameterWarning({ emitter: this.eventEmitter, model: this.model, parameter: 'withSDKDescriptorMessage', provider: this.provider, standard: this.standard, message: 'Empty SDK descriptor ignored — no descriptor will be injected. Call with no argument for the default descriptor, or pass a non-empty string.' });
            sdkError({ prefix: 'CHAT-SESSION', args: ['withSDKDescriptorMessage() called with an empty value; no SDK descriptor will be injected.'] });
            return this;
        }
        this._sdkDescriptor = content;
        return this;
    }

    
    /**
     * is automatically re-injected into every delegated subagent's context (the
     * task tool reads `session._agentContext`) and into the executor/DAG step
     * prompts this session drives — the general direction survives every hop.
     * The objective is MUTABLE by default: the run restates it from the work so
     * far on a cadence, so the direction stays current and recent. The value
     * passed here is the initial one (kept on the context as `objectiveInitial`);
     * `adaptable: false` freezes it for the whole run.
     * @param {{ctx: import('./agent-context.mjs').AgentContext|string, options?: Object}} arg0 - A context or a plain objective string.
     */
        withObjective({ ctx, options = {} }) {
        this._agentContext = typeof ctx === 'string' ? AgentContext.fromObjective({ objective: ctx }) : ctx;
        if (this._agentContext) this._agentContext.objectivePolicy = normalizeObjectivePolicy({ opts: options });
        return this;
    }

    
    /**
      * @param {{capId: string, announceOverride?: string|null}} arg0
     */
        _announceCapability({ capId, announceOverride = null }) {
        if (this._activatedCaps.has(capId)) return;
        const announce = announceOverride ?? CAPABILITY_REGISTRY[capId]?.announce;
        if (!announce) return;
        this._activatedCaps.add(capId);
        this._announcedParts.push(announce);
    }

    
    /**
     * The SDK descriptor (only when `withSDKDescriptorMessage` was called)
     * plus capability announcements; override with `withSDKDescriptorMessage`.
     * @returns {string|null}
     */
        getSystemMessage() {
        const parts = [this._sdkDescriptor, ...this._announcedParts].filter(Boolean);
        return parts.length ? parts.join(SYSTEM_MESSAGE_MERGE_SEPARATOR) : null;
    }

    
    /**
     * @param {{tools: Array<import('../messaging/unified-parameter.mjs').Tool|string|null|undefined>|null}} arg0 -
     * @returns {this}
     */
        withTools({ tools }) {
        this._toolsStore = (/** @type {Array<import('../messaging/unified-parameter.mjs').Tool|string>} */ ((Array.isArray(tools) ? tools : []).filter(Boolean))).map((t) => this._toWireTool({ tool: t }));
        // A whole-list replacement drops the workspace binding it was appended to.
        this._workspace = null;
        return this;
    }

    /**
     * Appends tools to the list `withTools()` set, replacing a tool of the same
     * name. This is the seam a loader uses (`applyAgentSpec`, a skill library, a
     * host belt) to add its tools after the host has already set its own; unlike
     * `withTools`, an existing tool survives.
     * @param {{tools: Array<import('../messaging/unified-parameter.mjs').Tool|string|null|undefined>|null, replace?: boolean}} arg0 -
     * @returns {this}
     */
        withAdditionalTools({ tools, replace = true }) {
        return this._appendTools({ tools, replace });
    }

    /**
     * @private
     * Converts each tool at ingestion and appends it; a tool of the same name is
     * replaced in place, so calling twice does not duplicate it.
     * @param {{tools: Array<import('../messaging/unified-parameter.mjs').Tool|string|null|undefined>|null, replace?: boolean}} arg0 -
     * @returns {this}
     */
        _appendTools({ tools, replace = true }) {
        const list = (/** @type {Array<import('../messaging/unified-parameter.mjs').Tool|string>} */ ((Array.isArray(tools) ? tools : []).filter(Boolean)));
        for (const tool of list) {
            const wire = this._toWireTool({ tool });
            const name = wire?.name;
            const at = typeof name === 'string' ? this._toolsStore.findIndex((entry) => entry?.name === name) : -1;
            if (at >= 0) {
                if (!replace) {
                    throw new ConfigurationError({
                        message: `Tool "${String(name)}" is already registered; refusing to replace it.`,
                        options: { option: 'tools' }
                    });
                }
                this._toolsStore[at] = wire;
            } else this._toolsStore.push(wire);
        }
        return this;
    }

    /**
     * Appends the workspace context, shell, and artifact tools to the session's
     * tool list. `read`/`grep`/`glob` stay inside `workspace.path`; a shell
     * operand outside it reaches the approval gate; `save_artifact` writes to
     * the artifact directory (`workspace.root` by default), not
     * `workspace.path`.
     *
     * The shell is bound only when a callback exists or `permissionMode` is
     * `bypassPermissions`; otherwise the call fails closed instead of running
     * an ungated shell. The callback is the explicit argument, else the
     * session's `withApproval()` policy. `permissionMode` follows the session's
     * `withPermissions()` mode unless passed explicitly.
     *
     * Appends to the list `withTools()` set; a tool of the same name is
     * replaced, so calling it twice with the same workspace does not duplicate
     * a tool. A later `withTools()` replaces the whole list.
     *
     * @param {{
     *   workspace: import('./workspace/manager.mjs').WorkspaceHandleLike,
     *   approvalCallback?: Function|{callback: Function, timeoutMs?: number}|{fn: Function, options?: {timeoutMs?: number}}|null,
     *   permissionMode?: import('./permissions.mjs').PermissionMode,
     *   include?: Array<string>,
     *   artifactsDir?: string|null,
     *   context?: Record<string, unknown>,
     *   shell?: Record<string, unknown>
     * }} arg0 -
     * @returns {this}
     */
        withWorkspace(arg0 = /** @type {any} */ ({})) {
        if (arg0 === null || typeof arg0 !== 'object' || Array.isArray(arg0)) {
            throw new ConfigurationError({ message: 'withWorkspace requires an options object with a workspace handle.', options: { option: 'workspace' } });
        }
        const {
            workspace,
            approvalCallback = null,
            permissionMode = this._permissionRules?.mode ?? 'default',
            include = ['context', 'shell', 'artifacts'],
            artifactsDir = null,
            context = {},
            shell = {}
        } = arg0;
        if (!workspace || typeof workspace !== 'object') {
            throw new ConfigurationError({ message: 'withWorkspace requires a workspace handle.', options: { option: 'workspace' } });
        }
        if (!PERMISSION_MODES.includes(/** @type {any} */ (permissionMode))) {
            throw new ConfigurationError({
                message: `withWorkspace: unknown permissionMode "${String(permissionMode)}". Use: ${PERMISSION_MODES.join(', ')}.`,
                options: { option: 'permissionMode' }
            });
        }
        const callback = approvalCallback ?? this._approvalPolicy?.callback ?? null;
        const built = createWorkspaceTools({
            workspace,
            approvalCallback: callback,
            eventEmitter: this.eventEmitter,
            include,
            artifactsDir,
            context,
            shell,
            permissionMode
        });

        /** @type {Array<any>} */
        const added = [...(built.contextTools ?? []), built.shellTool, built.artifactTool].filter((tool) => tool !== null);
        this._appendTools({ tools: added });
        this._workspace = workspace;
        return this;
    }

    
    /**
     * @private
     * Converts a tool's Zod `parameters` to plain JSON Schema at ingestion (see
     * `toWireToolParameters`) and surfaces any problem as a `parameter_warning`.
      * @param {{tool: import('../messaging/unified-parameter.mjs').Tool|string}} arg0
     */
        _toWireTool({ tool }) {
        return toWireToolParameters({ tool: /** @type {import('../messaging/unified-parameter.mjs').Tool} */ (tool), onWarn: ({ message }) => emitParameterWarning({ emitter: this.eventEmitter, model: this.model, parameter: 'tool.parameters', message, provider: this.provider, standard: this.standard }) });
    }

    /** @returns {Array<import('../messaging/unified-parameter.mjs').Tool>} */
    get _tools() {
        const canDelegate = this._canDelegate();
        const { allow, deny } = this._permissionRules;

        /**
         * Applies the session's permission rules to a tool list.
         * @param {Array<any>} list
         * @returns {Array<any>}
         */
        // wave 5 — `handoff.tools` composes ON TOP of the permission rules: the
        // child can never gain what the parent denied, and an empty list denies
        // everything (`[]` is not "unset").
        const allowlists = Array.isArray(this._toolAllowlists) ? this._toolAllowlists : null;
        const permitted = (/** @type {Array<any>} */ list) => this._withTaskRoster({
            list: (allowlists
                // Every layer must admit the tool, so an inherited scope cannot be
                // widened by a later one (wave 5: nested delegation).
                ? list.filter((/** @type {any} */ t) => allowlists.every((/** @type {string[]} */ layer) => layer.some((/** @type {string} */ pattern) => matchesGlob({ name: t?.name, pattern }))))
                : list
            ).filter((/** @type {any} */ t) => isToolPermitted({ name: t?.name, allow, deny }))
        });
        
        /** @param {Array<any>} list */
                /** @param {{list: *}} arg0 */
                const visible = ({ list }) => canDelegate ? list : list.filter(/** @type {(...args: any[]) => any} */ ((t) => t?.name !== TASK_TOOL_NAME));
        if (this._agent === AGENT_PLAN) {
            const caps = [
                ...(this._capabilityTools.get(CAPABILITY.TODOS) ?? []),
                ...(this._capabilityTools.get(CAPABILITY.TASK) ?? []),
                ...(this._planExitTool ? [this._planExitTool] : [])
            ];
            const capNames = new Set(caps.map(( t) => t && t.name).filter(Boolean));
            
            /** @type {Array<any>} */
                        const candidates = [
                ...this._planTools.filter(( t) => !(t && t.name && capNames.has(t.name))),
                ...caps
            ];
            
            /** @type {Record<string, any>} */
                        const rules = { '*': 'deny', ...(this._agentRules ?? {}) };
            for (const t of candidates) {
                if (t && t.name && rules[t.name] === undefined) rules[t.name] = 'allow';
            }
            return this._withToolSearch({ list: permitted(visible({ list: candidates.filter(t => isToolAllowed({ name: t && t.name, rules })) })) });
        }
        if (!this._capabilityTools || this._capabilityTools.size === 0) return this._withToolSearch({ list: permitted([...this._toolsStore, ...this._skillToolsStore]) });
        const names = new Set();
        for (const list of this._capabilityTools.values()) {
            for (const t of list) {
                if (t && t.name) names.add(t.name);
            }
        }
        const all = [
            ...this._toolsStore.filter(t => !(t && t.name && names.has(t.name))),
            ...this._skillToolsStore.filter(t => !(t && t.name && names.has(t.name))),
            ...[...this._capabilityTools.values()].flat(),
        ];
        return this._withToolSearch({ list: permitted(visible({ list: this._agentRules ? all.filter(t => isToolAllowed({ name: typeof t === 'string' ? t : (t?.name ?? null), rules: this._agentRules ?? {} })) : all })) });
    }

    /**
     * Appends `tool_search` when the permitted list carries a deferred tool.
     * It is added after permissions, so a session allowed to use deferred tools
     * can always discover them; with nothing deferred the list is unchanged.
     * @param {{list: Array<import('../messaging/unified-parameter.mjs').Tool>}} arg0
     * @returns {Array<import('../messaging/unified-parameter.mjs').Tool>}
     */
    _withToolSearch({ list }) {
        if (!list.some((t) => t?.deferLoading === true)) return list;
        if (!this._toolSearchTool) {
            this._toolSearchTool = {
                name: TOOL_SEARCH_TOOL_NAME,
                description: 'Search the tools that are not loaded in this request. Call it before using a tool that is not in the current list; matches are loaded for the next turn.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'Words to match against a tool name or description.' } },
                    required: ['query'],
                },
                /** @param {{args: any}} arg0 */
                execute: async ({ args }) => {
                    const terms = String(args?.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
                    // Read the live list: the deferred set can change between turns.
                    const matches = this._tools.filter((t) => typeof t?.name === 'string' && t.deferLoading === true
                        && terms.every((term) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(term)));
                    const found = matches.slice(0, LIMITS.tool_search_max_results);
                    for (const t of found) if (typeof t.name === 'string') this._activatedDeferredTools.add(t.name);
                    return {
                        success: true,
                        result: {
                            tools: found.map((t) => ({ name: t.name, description: t.description ?? '' })),
                            ...(matches.length > found.length ? { note: `Showing ${found.length} of ${matches.length} matches; refine the query.` } : {}),
                            ...(found.length === 0 ? { note: 'No deferred tool matched.' } : {}),
                        },
                    };
                },
            };
        }
        return [...list, this._toolSearchTool];
    }

    /**
     * The tools sent with one request: every permitted tool except a deferred
     * one that `tool_search` has not activated. `_tools` keeps the full list for
     * execution and permissions.
     * @returns {Array<import('../messaging/unified-parameter.mjs').Tool>}
     */
    _requestTools() {
        const all = this._tools;
        if (!all.some((t) => t?.deferLoading === true)) return all;
        return all.filter((t) => t?.deferLoading !== true || (typeof t.name === 'string' && this._activatedDeferredTools.has(t.name)));
    }

    
    /**
     * Annotates the built-in task tool with the live delegation roster so the
     * model can only pick a name that exists (the Claude Code / OpenCode
     * pattern). Recomputed per request from the session-local roster or the
     * client registry; a no-op when no profile is registered or the built-in
     * tool is not in the list.
     * @param {{list: Array<import('../messaging/unified-parameter.mjs').Tool>}} arg0
     * @returns {Array<import('../messaging/unified-parameter.mjs').Tool>}
     */
        _withTaskRoster({ list }) {
        const taskTool = this._capabilityTools?.get(CAPABILITY.TASK)?.[0];
        if (!taskTool || !Array.isArray(list) || !list.includes(taskTool)) return list;
        // 4.5 — the roster rides a TOOL DESCRIPTION, which is cache level 1: a
        // roster that changes mid-run changes the prefix hash from position 0.
        // Snapshot it per session (agents registered later get a new session), but
        // never freeze an EMPTY snapshot: `if (rendered)` keeps a session built
        // before its agents registered from pinning "no agents" forever.
        if (typeof this._taskRosterText !== 'string') {
            const env = normalizeDelegationEnvelope({ client: /** @type {import('./task.mjs').TaskClient|null} */ (this.client) });
            const registry = this._taskAgents ?? (this.client ? getSpawnRegistry({ client: this.client }).agents : null);
            const menu = env.agents.restricted
                ? new Map([...((/** @type {any} */ (registry))?.entries?.() ?? [])]
                    .filter(([name]) => env.agents.names.includes(String(name))))
                : registry;
            const rendered = renderSubagentRoster({ agents: menu, withDescriptions: true }) || '';
            if (rendered) this._taskRosterText = rendered;
        }
        const roster = typeof this._taskRosterText === 'string' ? this._taskRosterText : '';
        if (!roster) return list;
        return list.map((t) => (t === taskTool ? { ...t, description: `${t.description}\n\nAvailable subagents: ${roster}` } : t));
    }

    
    /**
     * True when at least one registered profile could accept a delegation from
     * this session. A child at or beyond every profile's depth cap gets the
     * `task` tool hidden from its toolbelt — an advertised tool that can only
     * throw is a model loop waiting to happen (a planner child burned its whole
     * iteration budget retrying it). With no profiles registered the tool is
     * hidden too: a session that cannot execute a delegation must not tempt
     * the model into requesting one — the tool appears as soon as
     * withTaskAgents registers a profile.
     * @returns {boolean}
     */
        _canDelegate() {
        const envelope = normalizeDelegationEnvelope({ client: /** @type {import('./task.mjs').TaskClient|null} */ (this.client) });
        if (envelope.maxDepthDeclared && envelope.maxDepth <= 0) return false;
        const depth = this._taskDepth ?? 0;
        if (envelope.agents.mode === 'any') {
            return depth < resolveDelegationMaxDepth({ session: /** @type {any} */ (this), envelope });
        }
        const registryAgents = [...((this._taskAgents ?? (this.client ? getSpawnRegistry({ client: this.client }).agents : null))?.values?.() ?? [])];
        // A declared roster array is the menu: an empty one advertises nothing.
        const agents = envelope.agents.restricted
            ? registryAgents.filter((p) => envelope.agents.names.includes(String(p?.name)))
            : registryAgents;
        if (agents.length === 0) return false;
        return agents.some((p) => depth < resolveDelegationMaxDepth({ profile: p, session: /** @type {any} */ (this), envelope }));
    }

    
    /**
      * @param {{capId: string, tools: Array<import('../messaging/unified-parameter.mjs').Tool|null>|null}} arg0
     */
        _registerCapabilityTools({ capId, tools }) {
        const list =  (/** @type {Array<import('../messaging/unified-parameter.mjs').Tool>} */ ((tools || []).filter(Boolean)));
        if (list.length) this._capabilityTools.set(capId, list);
        else this._capabilityTools.delete(capId);
    }

    
    /**
     * The underlying vendor client, if one was set.
     * @returns {Object|null}
     */
        getVendorClient() { return this._vendorClient; }

    
    /**
     * @param {{policy: import('./chat-session.mjs').RetryPolicyLike}} arg0 -
     * @returns {this}
     */
        withRetryPolicy({ policy }) {
        this._retryPolicy = policy;
        return this;
    }

    
    /**
     * session's requests (ms). Honored by the JAI transport only; other
     * backends ignore it. Unset (null) keeps the global `JAI_HEADER_TIMEOUT_MS`.
     * @param {{ms: number|null}} arg0 -
     * @returns {this}
     */
        withHeaderTimeout({ ms }) {
        this._headerTimeoutMs = ms;
        return this;
    }

    
    /**
     * fail-fasts the step (coded BREAKER_OPEN, never retried) instead of
     * burning a full header-timeout wait against a downed backend.
     * @param {{breaker: import('../support/retry-policy.mjs').CircuitBreaker}} arg0 - A CircuitBreaker instance.
     * @returns {this}
     */
        withCircuitBreaker({ breaker }) {
        this._circuitBreaker = breaker;
        return this;
    }

    
    /**
     * (ms, 0 = unbounded). A backoff that would overshoot the deadline
     * surfaces the last error instead of hanging past the caller's patience.
     * @param {{ms: number}} arg0 -
     * @returns {this}
     */
        withMaxElapsedMs({ ms }) {
        this._maxElapsedMs = ms;
        return this;
    }

    
    /**
     * Sets the run budget.
     *
     * `maxTotalTokens` caps the tokens one run may spend — it always works.
     * `maxBudgetUsd` caps what the run may cost, **as the backend reports it**:
     * the SDK never estimates a price, so the cap is enforced only when the
     * backend's own response carries a cost (a gateway that answers
     * `usage.cost`, for example). When it reports none, the cap cannot be
     * enforced, the SDK says so (`run:budget_unreported`) and the token budget
     * governs.
     *
     * The budget is a **session-lifetime** cap, not a per-run one: a session
     * that shares its budget pool with subagents binds the pool for the whole
     * session, so consecutive runs on one session draw down the same total.
     * @param {{budget?: {maxTotalTokens?: number, maxBudgetUsd?: number}|null}} arg0
     */
    withBudget({ budget } = {}) {
        const maxTotalTokens = Number(budget?.maxTotalTokens);
        const maxBudgetUsd = Number(budget?.maxBudgetUsd);
        const tokens = Number.isFinite(maxTotalTokens) && maxTotalTokens > 0 ? { maxTotalTokens } : null;
        const usd = Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 ? { maxBudgetUsd } : null;
        this._budget = tokens || usd ? { ...(tokens ?? {}), ...(usd ?? {}) } : null;
        const borrowed = /** @type {any} */ (this)._budgetPool;
        if (this._budget && borrowed?.[ATTEMPT_LEDGER]) {
            // A budget applied after joining must bound this unit's subtree; the
            // attempt ledger itself stays cap-less.
            delete /** @type {any} */ (this)._budgetPool;
            ensureBudgetPool({ session: this, parent: borrowed });
        } else {
            // D12: only the pool's owner may move the tree's cap.
            syncBudgetPoolCaps({ session: this });
        }
        return this;
    }

    /**
     * Installs the System One gate for this session's agentic loop. The loop may
     * take one bounded extra round when the gate is certain one more round
     * finishes; decision usage is charged to this session's budget pool. An
     * explicit `run({ options: { decisionGate } })` still wins for one call.
     * @param {{gate?: import('./decision-gate.mjs').DecisionGate|null}} [arg0]
     * @returns {this}
     */
    withDecisionGate({ gate = null } = {}) {
        this._decisionGate = gate ? attachDecisionUsage({ session: this, gate }) : null;
        return this;
    }

    /**
     * Installs the guardrails for the session: the tripwire that watches what
     * goes into the model (`phase: 'input'`) and what comes out of it
     * (`phase: 'output'`).
     *
     * A rule is `{ name?, phase?, pattern | test, action?, message? }` — a
     * `RegExp`, a case-insensitive substring, or a predicate
     * `test: (text) => boolean | Promise<boolean>`. `action: 'block'` (the
     * default) refuses the run with a `GuardrailViolationError`; `action: 'warn'`
     * reports the match and lets the run continue. The tool phases watch tool
     * calls: a blocking `tool_input` rule stops the tool before it runs, a
     * blocking `tool_output` rule withholds its result from the model. An
     * `output` rule is judged on every assistant text row the run appends, and
     * streamed deltas reach `onEvent` before that check — a blocked answer may
     * already have been streamed, but it never reaches memory or a checkpoint.
     *
     * @param {{rules?: Array<import('./guardrails.mjs').GuardrailRule>}} arg0
     */
    withGuardrails({ rules = [] } = {}) {
        this._guardrails = createGuardrails({ rules });
        return this;
    }

    /**
     * Sets the tool permission policy for the session.
     *
     * - `allow` — tool names or globs (`read_*`). An argument pattern such as
     *   `Bash(rm:*)` throws `ConfigurationError`. An empty list means no
     *   restriction; a non-empty list means only the matching tools are
     *   exposed to the model.
     * - `deny` — tool names or globs that are never exposed. The deny list
     *   always wins over the allow list.
     * - `mode` — how a *gated* tool (one that declares `requiresApproval`) is
     *   treated: `default` asks every time, `acceptEdits` approves only a tool
     *   that carries the `editsFiles: true` brand (and never one that also
     *   declares `runsCode`), `bypassPermissions` approves everything (an
     *   explicit, dangerous opt-in). The brand, not the tool name, is the
     *   gate: a host's own editor sets `editsFiles: true` on its definition to
     *   be auto-approved. `save_artifact` is the SDK's branded writer; a tool
     *   loaded from an MCP server never carries the brand.
     *
     * @param {{allow?: string[], deny?: string[], mode?: 'default'|'acceptEdits'|'bypassPermissions'}} arg0
     */
    withPermissions({ allow = [], deny = [], mode = 'default' } = {}) {
        this._permissionRules = normalizePermissionRules({ rules: { allow, deny, mode } });
        if (this._permissionRules.mode === 'bypassPermissions') {
            const message = 'bypassPermissions approves every gated tool without asking — use it only in a trusted environment.';
            sdkWarn({ prefix: 'PERMISSIONS', args: [message] });
            emitEvent({ emitter: this.eventEmitter, name: EVENTS.PERMISSIONS.BYPASS, payload: { mode: 'bypassPermissions' } });
        }
        return this;
    }

    /**
     * Session-local tool allowlist composed ON TOP of the permission rules
     * (wave 5: `handoff.tools`). Entries are exact tool names or glob patterns.
     * Each call adds a LAYER; a tool must match every layer, so a delegated
     * child can narrow but never widen an inherited scope. `patterns: null` is
     * a no-op; an empty array (or no argument) denies every tool.
     * @param {{patterns?: string[]|null}} [arg0]
     * @returns {this}
     */
    withToolAllowlist({ patterns = [] } = {}) {
        if (patterns == null) return this;
        const layer = Array.isArray(patterns) ? patterns.filter((p) => typeof p === 'string') : [];
        this._toolAllowlists = [...(Array.isArray(this._toolAllowlists) ? this._toolAllowlists : []), layer];
        return this;
    }

    /**
     * Sets the default per-tool timeout for a run. A tool that hangs must not
     * stall the whole agent turn: the round unblocks with a timeout error and
     * the turn continues. A tool may override the default with its own
     * `timeoutMs`.
     * @param {{ms?: number}} [arg0]
     */
    withToolTimeout({ ms = LIMITS.tool_timeout_ms } = {}) {
        const value = Number(ms);
        this._toolTimeoutMs = Number.isFinite(value) && value > 0 ? value : null;
        return this;
    }

    /**
     * Caps how many tool calls from one model turn run at once. The rest queue;
     * the results keep the model's call order. `0` or `null` removes the cap.
     * @param {{max: number|null}} arg0
     * @returns {this}
     */
    withMaxParallelTools({ max }) {
        const value = Number(max);
        this._maxParallelTools = Number.isInteger(value) && value > 0 ? value : null;
        return this;
    }

    
    /**
     * @param {{policy: import('./chat-session.mjs').StreamTimeoutPolicyLike}} arg0 -
     * @returns {this}
     */
        withStreamTimeout({ policy }) {
        this._streamTimeoutPolicy = policy;
        return this;
    }

    
    /** @param {{timeout: number|{chunkMs?: number, firstChunkMs?: number, totalMs?: number}}} arg0 */
    withTimeout({ timeout }) {
        const spec = typeof timeout === 'number' ? { chunkMs: timeout } : (timeout ?? {});
        const chunkRaw = Number(spec.chunkMs);
        const chunkMs = Number.isFinite(chunkRaw) && chunkRaw > 0 ? chunkRaw : undefined;
        const firstRaw = Number(spec.firstChunkMs);
        const firstChunkMs = Number.isFinite(firstRaw) && firstRaw > 0 ? firstRaw : 0;
        this._streamTimeoutPolicy = new InactivityTimeoutPolicy({
            ...(chunkMs !== undefined ? { timeoutMs: chunkMs } : {}),
            firstChunkMs,
        });
        const totalRaw = Number(spec.totalMs);
        this._totalTimeoutMs = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : 0;
        if (firstChunkMs > 0) this._headerTimeoutMs = firstChunkMs;
        return this;
    }

    
    /**
     * @param {{observer: import('./chat-session.mjs').ApiObserverLike}} arg0 -
     * @returns {this}
     */
        withApiObserver({ observer }) {
        this._apiObserver = observer;
        return this;
    }

    /**
     * Ships the session's events and vendor calls to an OTLP endpoint.
     *
     * The exporter is attached to the session's event emitter and — unless
     * `observer: false` — runs next to the default API observer through a
     * `CompositeApiObserver`, so the `api_request` / `api_response` events
     * keep working while the exporter also sees the calls.
     *
     * @param {{exporter: TelemetryExporter, observer?: boolean}} arg0
     * @returns {this}
     */
        withTelemetry({ exporter, observer = true }) {
        if (!exporter) return this;
        this._telemetryExporter = exporter;
        if (observer && typeof exporter.onRequest === 'function') {
            // The composite takes the observer contract; the session's own view and a telemetry
            // exporter are structural (`onRequest` as a plain Function), so they meet here.
            // The exporter goes first: it must be observing before the default observer emits
            // api_request, or that event would land on the run instead of the call.
            this._apiObserver = new CompositeApiObserver({ observers: /** @type {any} */ ([exporter, this._apiObserver].filter(Boolean)) });
        }
        if (typeof exporter.attach === 'function' && this.eventEmitter) {
            this._telemetryDetach = exporter.attach({ emitter: this.eventEmitter });
        }
        return this;
    }

    /**
     * Registers a user context processor, run in `_prepareStepMessages` after the
     * built-in context blocks are assembled and ordered by `order` (ascending).
     * Receives `{ session, messages, contextParts }`; may return
     * `{ contextParts?, messages? }`. Zero processors is identical to the default
     * assembly. A processor exception propagates (fail-loud).
     * @param {{name?: string, order?: number, process: Function}} arg0
     * @returns {this}
     */
        withContextProcessor({ name, order = 0, process }) {
        if (typeof process !== 'function') {
            throw new ConfigurationError({ message: 'withContextProcessor: process must be a function', options: { option: 'process' } });
        }
        this._contextProcessors.push({ name, order: Number(order) || 0, process });
        return this;
    }

    /**
     * Attaches an ordered async hook registry (from `createHooks()`), enabling
     * the intervene layer: request and tool middleware registered by hook name
     * (`request:before`, `tool:before` / `tool:after` / `tool:error`). Hooks may
     * transform a value (return the next one; `undefined` means unchanged),
     * mutate their `ctx`, and veto a tool call by returning `STOP`. One registry
     * per session; calling again replaces it.
     * @param {{hooks: import('../core/hooks.mjs').HookRegistry}} arg0
     * @returns {this}
     */
        withHooks({ hooks }) {
        if (!hooks || typeof hooks.runWaterfall !== 'function' || typeof hooks.runSerial !== 'function') {
            throw new ConfigurationError({ message: 'withHooks: hooks must be a HookRegistry (from createHooks())', options: { option: 'hooks' } });
        }
        this._hooks = hooks;
        return this;
    }

    /**
     * Registers task-agent profiles on THIS session, preferred over the client
     * registry, so a session/graph can carry its own roster without mutating a
     * shared client. Same profile shape as the module-level withTaskAgents().
     * `options.maxDepth` is a cap the host names; without it the session carries
     * the implicit default, which a profile's own `maxDepth` may raise (W4-2).
     * @param {{agents?: Array<import('./task.mjs').TaskAgent>, options?: {maxDepth?: number}}} arg0
     * @returns {this}
     */
        withTaskAgents({ agents = [], options = {} } = {}) {
        const map = this._taskAgents ?? new Map();
        for (const a of agents) {
            if (!a || typeof a.name !== 'string' || !a.name) {
                throw new ConfigurationError({ message: 'withTaskAgents: every agent profile needs a string name' });
            }
            map.set(a.name, a);
        }
        this._taskAgents = map;
        // W4-2: remember which of the two this is. A depth the host named is a
        // ceiling over a profile's own; the implicit default is only the fallback
        // a profile without one inherits (docs/SPAWNING.md §6).
        if (options.maxDepth !== undefined) {
            this._taskMaxDepth = options.maxDepth;
            this._taskMaxDepthDeclared = true;
        } else if (this._taskMaxDepth === undefined) {
            this._taskMaxDepth = LIMITS.default_delegation_depth;
            this._taskMaxDepthDeclared = false;
        }
        return this;
    }

    
    /**
     * backend's supported set (ProtocolType). Tiers (Gemini vs Vertex, OpenCode
     * zen/go) are NOT protocols — they stay on the backend/tier selectors.
     * Transport-only protocols (the JAI Task API) are rejected here.
     * @param {{protocol: string}} arg0 - e.g. 'chat'|'responses' (JAI), 'completions'|'responses' (OpenAI-compatible), 'messages' (Anthropic), 'generateContent' (Google).
     * @returns {this}
     */
        withProtocol({ protocol }) {
        this.protocol = resolveProtocol({ provider: this.provider, protocol, session: true });
        return this;
    }

    
    /**
     * tool whose definition sets `requiresApproval` (shell tools keep their own
     * gate). `fn(name, args, ctx)` returns boolean|Promise<boolean> (or
     * `{approved, reason}`). Timeout/abort semantics come from
     * ApprovalCoordinator; passing a non-function clears the policy.
     * @param {{fn: Function|null, options?: {timeoutMs?: number}}} arg0 -
     * @returns {this}
     */
        withApproval({ fn, options = {} }) {
        this._approvalPolicy = typeof fn === 'function'
            ? { callback: fn, timeoutMs: options.timeoutMs }
            : null;
        return this;
    }

    
    /**
     * form, which requires a backend override).
     * @param {{params: Object|Function}} arg0 -
     * @returns {this}
     */
        withParameters({ params }) {
        if (typeof params === 'function') {
            throw new AbstractMethodError({ message: 'AbstractChatSession.withParameters: function form requires a standard override.' });
        }
        if (params && typeof params === 'object') {
            // No translator runs here, so a key this standard refuses would be
            // stored silently; warn like the fluent builder does.
            warnRefusedSpecKeys({ standard: this.standard, spec: /** @type {Record<string, unknown>} */ (params), eventEmitter: this.eventEmitter, model: this.model, provider: this.provider });
            this._parameters = { ...this._parameters, ...params };
        }
        return this;
    }

    /**
     * Enables prompt caching for this session (wave 4, 4.4). Backend-neutral
     * entry point: the Anthropic adapter turns it into `cache_control`
     * breakpoints on the stable prefix; OpenAI/Gemini cache the same prefix
     * automatically, so the call is a no-op there (and never leaks a private
     * parameter into their bodies). Backends without caching ignore it.
     * @param {{points?: number, type?: string, ttl?: string}} [arg0] - `points`
     *   is the breakpoint budget (0–4, clamped); `ttl` is `'5m'` (default) or
     *   `'1h'` for the extended Anthropic cache.
     * @returns {this}
     */
    withPromptCache({ points = LIMITS.prompt_cache_points, type = 'ephemeral', ttl } = {}) {
        const count = Number.isFinite(points) ? Math.max(1, Math.min(LIMITS.prompt_cache_points_max, Math.floor(points))) : LIMITS.prompt_cache_points;
        this._promptCache = {
            points: count,
            type: typeof type === 'string' && type ? type : 'ephemeral',
            ...(ttl ? { ttl: String(ttl) } : {}),
        };
        return this;
    }

    
    /**
     * @param {{provider: Object, options?: {syncInterval?: number, distillationModel?: string, embedder?: Function|null, engine?: Object, preload?: boolean, client?: Object, sessionId?: string|(() => string|null|undefined), admissionGate?: import('./decision-gate.mjs').DecisionGate|null}, admissionGate?: import('./decision-gate.mjs').DecisionGate|null}} arg0 - A MemoryProvider (or provider-contract object). Pass `embedder: null` to force lexical-only recall even on an embedding-capable backend. `sessionId` names the conversations facts dedupe against; the default is the session's own id. `admissionGate` (top-level or inside `options`) is the System One filter before a distilled fact is stored.
     * @returns {this}
     */
        withMemory({ provider, options = {}, admissionGate = undefined }) {
        // A top-level gate is an accepted alias: a typo that silently disabled
        // admission was a real footgun.
        if (admissionGate !== undefined && options.admissionGate === undefined) options = { ...options, admissionGate };
        const memoryClient = /** @type {MemoryClient} */ (options.client || this.client || this);
        this._memoryClient = memoryClient;
        // Bind the method: `embed` reads `this.provider` / `this.transport`, and an
        // unbound call threw `Cannot read properties of undefined (reading
        // 'provider')`. `safeEmbed` in the provider swallows that, so the vector
        // tier silently degraded to lexical on every provider.
        const embed = typeof memoryClient.embed === 'function' ? memoryClient.embed.bind(memoryClient) : null;
        
        /** @type {Function|null} */
                const embedder = options.embedder !== undefined
            ? options.embedder
            : (embed && memoryClient.provider !== ProviderType.OPENCODE
                ? /** @type {(...args: any[]) => any} */ (( text) => embed({ input: text }))
                : null);
        this._memoryManager = new MemoryManager({ provider: /** @type {import('./memory/manager.mjs').ManagerProvider} */ (provider), options: {
            syncInterval: options.syncInterval ?? LIMITS.memory_sync_interval,
            distillationModel: options.distillationModel || this.model,
            // B4: facts dedupe against the conversation, not a per-manager UUID. A thunk so
            // a session id set after `withMemory()` still applies, and so a resumed session
            // keeps its identity.
            ...options,
            // After the spread: an explicit `sessionId: null` must not throw the default away.
            sessionId: options.sessionId ?? (() => this.sessionId),
            embedder:  (embedder),
        } });
        const engine = options.engine || new ProviderMemoryEngine({ provider: /** @type {import('./memory/engine.mjs').EngineProvider} */ (provider), embedder:  (embedder) });
        this._memoryComponent = new MemoryComponent({
            engine: /** @type {import('./memory/component.mjs').MemoryEngine} */ (engine),
            manager: this._memoryManager,
            eventEmitter: this.eventEmitter ?? null
        });
        this._announceCapability({ capId: CAPABILITY.MEMORY, announceOverride: this._memoryComponent.startupAnnounce() });
        this._memoryPreload = options.preload ?? DEFAULT_PRELOAD;
        this._registerCapabilityTools({ capId: CAPABILITY.MEMORY, tools: [
            this._memoryComponent.toLoadTool(),
            this._memoryComponent.toSaveTool()
        ] });
        return this;
    }

    
    
    /**
 * @param {{capability: string, toolName: string, legNoun: string, param: string, resolveMode: Function, cfg: WebCapConfig, injected: Object|null|undefined, existing: Object|null|undefined, make: Function, toTool: Function, store: Function, noNativeWire?: boolean}} arg0
 */
        _attachWebCap({ capability, toolName, legNoun, param, resolveMode, cfg, injected, existing, make, toTool, store, noNativeWire = false }) {
        cfg.inject = normalizeInject({ inject: cfg.inject, label: param });
        const hasNativeLeg = this.provider != null
            && resolveMode({ sessionProvider: this.provider, mode: 'native' }) === 'native'
            && !noNativeWire;
        if (this.provider != null && this.provider !== ProviderType.JAI && !hasNativeLeg
            && isNativeMode({ mode: cfg.mode })) {
            cfg.mode = 'tavily';
            emitParameterWarning({ emitter: this.eventEmitter, model: cfg.model, parameter: param, message: `Backend '${this.provider}' has no native ${legNoun} leg — using the Tavily tool.`, provider: this.provider, standard: this.standard });
        }
        if (cfg.force && resolveMode({ sessionProvider: this.provider, mode: cfg.mode }) === 'tool') {
            this.withParameters({ params: { toolChoice: { type: 'named', name: toolName } } });
        }
        const component = injected ?? existing ?? make();
        if (component && !injected) component.config = cfg;
        store(component);
        this._announceCapability({ capId: capability, announceOverride: component.startupAnnounce?.() ?? null });
        if (resolveMode({ sessionProvider: this.provider, mode: cfg.mode }) === 'tool') {
            this._registerCapabilityTools({ capId: capability, tools: [toTool({ c: component })] });
        } else {
            this._capabilityTools.delete(capability);
            this._toolsStore = this._toolsStore.filter((t) => t?.name !== toolName);
        }
        return this;
    }

    
    /**
     * @returns {this}
      * @param {{options?: WebSearchOptions}} arg0
     */
        withWebSearch({ options = {} } = {}) {
        /** @type {WebSearchOptions} */ const o = options ?? {};
        const mode = o.mode ?? 'native_with_tavily_fallback';
        if (!WEB_SEARCH_MODES.includes(mode)) {
            throw new ConfigurationError({ message: `withWebSearch: unknown mode "${mode}". Expected one of ${WEB_SEARCH_MODES.join(', ')}.`, options: { option: 'mode' } });
        }
        const inject = o.inject ?? null;
        this._webSearchPreload = o.preload !== false;
        this._webSearch = {
            mode,
            force: !!o.force,
            model: this.model ?? '',
            maxResults: o.maxResults ?? LIMITS.web_search_max_results,
            maxUses: o.maxUses,
            allowedDomains: Array.isArray(o.allowedDomains) ? o.allowedDomains : [],
            blockedDomains: Array.isArray(o.blockedDomains) ? o.blockedDomains : [],
            location: o.location ?? null,
            includeVendorMetadata: !!o.includeVendorMetadata,
            tavily: o.tavily ?? null,
            inject: /** @type {import('../agentic/web-shared.mjs').WebInjectOptions|null} */ (inject),
            preload: o.preload !== false
        };
        const noNativeWire = this.provider === ProviderType.OPENAI && this.protocol !== 'responses';
        return this._attachWebCap({
            capability: CAPABILITY.WEB_SEARCH, toolName: WEB_SEARCH_TOOL_NAME,
            legNoun: 'search', param: WEB_SEARCH_TOOL_NAME, resolveMode: resolveSearchMode,
            cfg: this._webSearch, injected: o.component, existing: this._webSearchComponent,
            make: () => new WebSearchComponent({
                provider: this.provider,
                config: this._webSearch,
                taskApi: /** @type {{executeJson: Function}|null} */ (/** @type {BuilderClient} */ (this.client)?.tasks ?? null),
                eventEmitter: this.eventEmitter ?? null,
            }),
            /** @param {{c: *}} arg0 */
            toTool: ({ c }) => c.toWebSearchTool(),
            store: /** @type {(...args: any[]) => any} */ (( c) => { this._webSearchComponent = c; }),
            noNativeWire,
        });
    }

    
    /**
     * The `web_scrape` function tool is registered whenever the resolved mode
     * needs the tool leg ('tavily', 'curl', or a native_*_fallback as the
     * fallback); pure 'native' relies on server-side injection in the adapters.
     * Backends with no native scrape leg (openai, local, opencode) are
     * downgraded to 'tavily' with a parameter_warning. JAI-native IS the tool
     * leg (Task API); explicit `tavily` opts force the Tavily engine (incl. on
     * JAI); explicit `curl` opts force the curl engine.
     * @param {{options?: {mode?: string, force?: boolean, maxChars?: number, maxUrls?: number, maxUses?: number, format?: 'text'|'markdown', timeoutMs?: number, allowedDomains?: string[], blockedDomains?: string[], allowPrivateNetwork?: boolean, includeVendorMetadata?: boolean, tavily?: Object|null, curl?: Object|null, component?: Object, inject?: Object|null, preload?: boolean}}} arg0 -
     * @returns {this}
     */
        withWebScrape({ options = {} } = {}) {
        const o = options || {};
        const mode = o.mode ?? 'native_with_tavily_fallback';
        if (!WEB_SCRAPE_MODES.includes(mode)) {
            throw new ConfigurationError({ message: `withWebScrape: unknown mode "${mode}". Expected one of ${WEB_SCRAPE_MODES.join(', ')}.`, options: { option: 'mode' } });
        }
        const maxUrls = o.maxUrls ?? LIMITS.scrape_max_urls;
        if (!Number.isInteger(maxUrls) || maxUrls < 1) {
            throw new ConfigurationError({ message: 'withWebScrape: maxUrls must be a positive integer.', options: { option: 'maxUrls' } });
        }
        const maxUses = o.maxUses;
        if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1)) {
            throw new ConfigurationError({ message: 'withWebScrape: maxUses must be a positive integer.', options: { option: 'maxUses' } });
        }
        const format = o.format ?? 'text';
        if (format !== 'text' && format !== 'markdown') {
            throw new ConfigurationError({ message: 'withWebScrape: format must be "text" or "markdown".', options: { option: 'format' } });
        }
        this._webScrapePreload = o.preload !== false;
        this._webScrape = {
            mode,
            force: !!o.force,
            model: this.model ?? '',
            maxChars: o.maxChars ?? LIMITS.scrape_content_max_chars,
            maxUrls,
            maxUses,
            timeoutMs: o.timeoutMs,
            allowedDomains: Array.isArray(o.allowedDomains) ? o.allowedDomains : [],
            blockedDomains: Array.isArray(o.blockedDomains) ? o.blockedDomains : [],
            allowPrivateNetwork: o.allowPrivateNetwork === true,
            includeVendorMetadata: !!o.includeVendorMetadata,
            format,
            tavily: o.tavily ?? null,
            curl: o.curl ?? null,
            inject: /** @type {Record<string, unknown>|null} */ (o.inject ?? null),
            preload: o.preload !== false
        };
        return this._attachWebCap({
            capability: CAPABILITY.WEB_SCRAPE, toolName: WEB_SCRAPE_TOOL_NAME,
            legNoun: 'scrape', param: WEB_SCRAPE_TOOL_NAME, resolveMode: resolveScrapeMode,
            cfg: this._webScrape, injected: o.component, existing: this._webScrapeComponent,
            make: () => new WebScrapeComponent({
                provider: this.provider,
                config: this._webScrape,
                taskApi: /** @type {{executeJson: Function}|null} */ (/** @type {BuilderClient} */ (this.client)?.tasks ?? null),
                eventEmitter: this.eventEmitter ?? null,
            }),
            /** @param {{c: *}} arg0 */
            toTool: ({ c }) => ( (c)).toWebScrapeTool(),
            store: /** @type {(...args: any[]) => any} */ (( c) => { this._webScrapeComponent = c; }),
        });
    }

    
    /**
     * The `browser` function tool is registered whenever the resolved mode needs
     * the tool leg ('obscura', 'curl', 'tool'); 'off' registers nothing.
     * Obscura drives the standalone `obscura fetch` binary (no Playwright);
     * explicit `curl` opts force the curl engine.
     * @param {{options?: {mode?: string, force?: boolean, binaryPath?: string, maxChars?: number, maxUrls?: number, format?: 'text'|'markdown', timeoutMs?: number, allowedDomains?: string[], blockedDomains?: string[], allowPrivateNetwork?: boolean, allowUnpolicedObscura?: boolean, includeVendorMetadata?: boolean, curl?: Object|null, obscura?: Object|null, endpointURL?: string, screenshotDir?: string, playwright?: Object|null, component?: Object, inject?: Object|null, preload?: boolean}}} arg0 -
     * @returns {this}
     */
        withBrowser({ options = {} } = {}) {
        const o = options || {};
        const mode = o.mode ?? 'obscura';
        if (!BROWSER_MODES.includes(mode)) {
            throw new ConfigurationError({ message: `withBrowser: unknown mode "${mode}". Expected one of ${BROWSER_MODES.join(', ')}.`, options: { option: 'mode' } });
        }
        const maxUrls = o.maxUrls ?? LIMITS.browser_max_urls;
        if (!Number.isInteger(maxUrls) || maxUrls < 1) {
            throw new ConfigurationError({ message: 'withBrowser: maxUrls must be a positive integer.', options: { option: 'maxUrls' } });
        }
        const format = o.format ?? 'text';
        if (format !== 'text' && format !== 'markdown') {
            throw new ConfigurationError({ message: 'withBrowser: format must be "text" or "markdown".', options: { option: 'format' } });
        }
        this._browserPreload = o.preload !== false;
        this._browser = {
            mode,
            force: !!o.force,
            model: this.model ?? '',
            binaryPath: o.binaryPath ?? null,
            maxChars: o.maxChars ?? LIMITS.browser_content_max_chars,
            maxUrls,
            timeoutMs: o.timeoutMs,
            allowedDomains: Array.isArray(o.allowedDomains) ? o.allowedDomains : [],
            blockedDomains: Array.isArray(o.blockedDomains) ? o.blockedDomains : [],
            allowPrivateNetwork: o.allowPrivateNetwork === true,
            includeVendorMetadata: !!o.includeVendorMetadata,
            format,
            // A1-F3: the obscura read leg follows redirects and reports no final
            // URL, so it cannot be held to a domain policy. Unpoliced reads go
            // through curl by default; this flag is the explicit acceptance.
            allowUnpolicedObscura: o.allowUnpolicedObscura === true,
            curl: o.curl ?? null,
            obscura: o.obscura ?? null,
            endpointURL: o.endpointURL ?? null,
            screenshotDir: o.screenshotDir ?? null,
            playwright: o.playwright ?? null,
            inject: /** @type {Record<string, unknown>|null} */ (o.inject ?? null),
            preload: o.preload !== false
        };
        return this._attachWebCap({
            capability: CAPABILITY.BROWSER, toolName: BROWSER_TOOL_NAME,
            legNoun: 'browser', param: BROWSER_TOOL_NAME, resolveMode: resolveBrowserMode,
            cfg: this._browser, injected: o.component, existing: this._browserComponent,
            make: () => new BrowserComponent({
                provider: this.provider,
                config: this._browser,
                eventEmitter: this.eventEmitter ?? null,
            }),
            /** @param {{c: *}} arg0 */
            toTool: ({ c }) => ( (c)).toBrowserTool(),
            store: /** @type {(...args: any[]) => any} */ (( c) => { this._browserComponent = c; }),
        });
    }

    
    /**
     * Attaches the knowledge capability: one canonical typed graph (the ASG)
     * plus a generated wiki view of it.
     *
     * The graph is a *capability*, not a memory feature: memory stores flat facts
     * with no relations, and adding edges to `MemoryFact` would break three
     * shipped providers. Instead the `memory` surface indexes bank facts as
     * `fact` nodes, so memory and the graph compose without either changing.
     *
     * The per-step block is **volatile** on purpose — it is keyed on the last
     * user turn, so it must ride the trailing row rather than enter the cached
     * prompt prefix.
     * @param {{dir?: string, profile?: string|object|null, preload?: boolean, embedder?: Function|null, gate?: import('./decision-gate.mjs').DecisionGate|null, gatePolicy?: 'closed'|'open', ontology?: 'auto'|'adopted'|null, surfaces?: Array<string>, seed?: Record<string, unknown>|null, graph?: import('./knowledge/model.mjs').KnowledgeGraph|null, sources?: Record<string, string>|null, view?: 'asg'|'wiki', access?: 'read-only'|'read-write', persist?: boolean, scorer?: import('./knowledge/query.mjs').KnowledgeScorer|null, edgeFilter?: import('./knowledge/query.mjs').KnowledgeEdgeFilter|null, direction?: 'both'|'outgoing'|'incoming', hubDamping?: boolean}} [arg0] -
     *   `dir` is where `graph.json`, `ontology.json`, `validate.json` and
     *   `wiki/` live. `profile` is `'generic'` (default) or `'legal'`, or a
     *   custom `{kinds, relations}`; a stored graph's own profile wins when this
     *   is omitted. `surfaces` names the read-only adapters to run, and `seed`
     *   gives each one its input: `{ document: { paths }, wiki: { dir },
     *   memory: { facts }, todos: { store }, plan: { plan } }`. A surface with no
     *   seed is skipped, so `surfaces` alone changes nothing. `gate` defaults to
     *   the session's decision gate and gates semantic edges only;
     *   `gatePolicy: 'closed'` (default) admits an edge only on an explicit
     *   `verdict: true`, so an uncalibrated gate does not read as approval.
     *   `ontology: 'auto'` measures the seeded corpus and derives the shape for
     *   this run (recorded as `graph.ontology.status: 'proposed'`);
     *   `'adopted'` validates against `ontology.json` written by
     *   `adoptOntology()`. Adoption is always a separate, versioned act.
     *   `view: 'wiki'` is a read-only compatibility alias. `access` controls mutation independently; `persist: false` disables store reads/writes. `scorer`, `edgeFilter`, `direction`, and `hubDamping` configure retrieval.
     * @returns {this}
     */
        withKnowledge({ dir = '.knowledge', profile = null, preload = false, embedder = null, gate = this._decisionGate ?? null, gatePolicy = 'closed', ontology = null, surfaces = ['document'], seed = null, graph = null, sources = null, view = 'asg', access = 'read-write', persist = true, scorer = null, edgeFilter = null, direction = 'both', hubDamping = true } = {}) {
        this._knowledgeComponent = new KnowledgeComponent({
            dir,
            profile,
            preload: preload === true,
            embedder: embedder ?? null,
            // Knowledge asks a plain-text question — a narrower shape than the
            // gate's canonical one; the gate forwards it untouched.
            gate: /** @type {import('./knowledge/component.mjs').KnowledgeGate|null} */ (/** @type {unknown} */ (gate ?? null)),
            gatePolicy,
            ontology,
            surfaces,
            seed,
            graph,
            sources,
            view,
            access,
            persist,
            scorer,
            edgeFilter,
            direction,
            hubDamping,
            eventEmitter: this.eventEmitter ?? null
        });
        this.withCapability({ capability: this._knowledgeComponent, preload: preload === true, volatile: true });
        return this;
    }

    
    /**
     * @param {{store: Map<string, import('./todos/component.mjs').TodoTask>, options?: {filePath?: string|null, preload?: boolean}}} arg0 - Shared task store.
     * @returns {this}
     */
        withTodos({ store, options = {} }) {
        this._todoComponent = new TodoComponent({ store, filePath: options.filePath || null, eventEmitter: this.eventEmitter ?? null });
        this._announceCapability({ capId: CAPABILITY.TODOS, announceOverride: this._todoComponent.startupAnnounce() });
        this._todoPreload = options.preload ?? true;
        this._registerCapabilityTools({ capId: CAPABILITY.TODOS, tools: [
            this._todoComponent.toLoadTool(),
            this._todoComponent.toSaveTool()
        ] });
        return this;
    }

    
    /**
     * registers its load/save tool surfaces, and subscribes its per-step block
     * to the session loop. This is how future extensions (including
     * ExternalToolCapability / AcpCapability) plug in without core changes.
     * @param {{capability: import('../core/loadable.mjs').LoadableComponent, preload?: boolean, extraTools?: Array<Object>, volatile?: boolean, extra?: Object|null}} arg0 - A LoadableComponent
     *   (optionally with shouldInjectStep/stepBlock overrides and a tools() array).
     *   `volatile: true` puts the block in the trailing uncached row instead of
     *   the cached system prefix — required for any block keyed on live state;
     *   `extra` is merged into the step ctx the component reads.
     * @returns {this}
     */
        withCapability({ capability, preload = DEFAULT_PRELOAD, extraTools = [], volatile = false, extra = null }) {
        if (!capability || !capability.id) {
            throw new ConfigurationError({ message: 'withCapability: a LoadableComponent with an id is required.', options: { option: 'capability' } });
        }
        this._announceCapability({ capId: capability.id, announceOverride: capability.startupAnnounce?.() ?? null });
        this._registerCapabilityTools({ capId: capability.id, tools: [
            capability.toLoadTool?.() ?? null,
            capability.toSaveTool?.() ?? null,
            ...(Array.isArray(extraTools) ? extraTools : [])
        ] });
        this._extraStepComponents.push({
            component: capability,
            preload,
            errorLabel: `${capability.id} block failed`,
            rethrowAbort: false,
            volatile: volatile === true,
            ...(extra && typeof extra === 'object' ? { extra } : {})
        });
        return this;
    }

    
    /**
     * @param {{graph: Object, options?: Object}} arg0 - { entry, nodes, edges }.
     * @returns {this}
     */
        withStateMachine({ graph, options = {} }) {
        this._announceCapability({ capId: CAPABILITY.STATE_MACHINE });
        this._registerCapabilityTools({ capId: CAPABILITY.STATE_MACHINE, tools: [
            createStateMachineTool({ graph, options: {
                client: this.client || this,
                objective: () => this._agentContext?.objective ?? null,
                // These are lazy: a caller may chain .withStateMachine(...)
                // before .withPermissions/.withSkills/.withObjective, and the
                // tool executes later. Snapshotting here silently ignored the
                // late policy and skills.
                agentContext: () => this._agentContext ?? null,
                sessionPolicy: () => captureSessionPolicy({ session: this }),
                skills: () => (this._skillToolsStore.length > 0 ? this._skillToolsStore : null),
                skillsPreload: () => this._skillsPreload,
                ...options,
            } })
        ] });
        return this;
    }

    
    /**
     * @param {{skills: Array<Object>, options?: {preload?: boolean}}} arg0 -
     * @returns {this}
     */
        withSkills({ skills, options = {} }) {
        const list = (Array.isArray(skills) ? skills : []).filter(Boolean);
        this._skillToolsStore = [...this._skillToolsStore, ...list];
        /** @type {any[]} */
        const existing = this._skillsLibrary?.skills ?? [];
        this._skillsLibrary = new SkillsLibrary({ skills: [...existing, ...list], eventEmitter: this.eventEmitter ?? null });
        this._announceCapability({ capId: CAPABILITY.SKILLS, announceOverride: this._skillsLibrary.startupAnnounce() });
        this._skillsPreload = options.preload ?? DEFAULT_PRELOAD;
        this._registerCapabilityTools({ capId: CAPABILITY.SKILLS, tools: [this._skillsLibrary.toLoadTool()] });
        return this;
    }

    
    /**
     * (task tool, DAG steps, discussion agents) inherit it so the whole tree
     * shares one conversation id; the parent constructor prefers it over the
     * auto-minted id (fallback: this session's run-id).
     * @param {{id?: string, sessionId?: string}} arg0 -
     * @returns {this}
     */
        withSessionId({ id, sessionId }) {
        this._explicitSessionId = id ?? sessionId ?? null;
        if (this._sessionRunCtx) this._sessionRunCtx.sessionId = this._explicitSessionId;
        return this;
    }

    
    /**
     * the conversation row + AgentContext are persisted under `threadId`, so
     * a later session can resume with loadCheckpoint() (fault tolerance, HITL
     * pauses, plan→execute handoffs).
     * Any `SessionStore` works (`LocalFileSessionStore`, `InMemorySessionStore`, or a
     * host's own); saves are last-write-wins.
     * @param {{store: import('./sessions.mjs').SessionStore, threadId: string}} arg0 -
     */
        withSessionStore({ store, threadId }) {
        this._sessionStore = store;
        this._threadId = threadId;
        return this;
    }

    /**
     * Makes the session inbox durable. The rows `enqueueInput` accepted are
     * written after every change and loaded before the first turn, so a host
     * that restarts does not strand what the user sent. Any `InboxStore` works
     * (`InMemoryInboxStore`, `LocalFileInboxStore`, or a host's own).
     *
     * The key is the conversation: an explicit `threadId`, else the one
     * `withSessionStore()` set, else this session's id. Pass it explicitly when
     * the session id is minted per process and the queue must follow the thread.
     * @param {{store: import('./inbox-store.mjs').InboxStore, threadId?: string}} arg0
     * @returns {this}
     */
        withInboxStore({ store, threadId } = /** @type {any} */ ({})) {
        if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.clear !== 'function') {
            throw new ConfigurationError({
                message: 'withInboxStore requires a store with load/save/clear (InMemoryInboxStore or LocalFileInboxStore).',
                options: { option: 'withInboxStore' }
            });
        }
        this._inboxStore = store;
        this._inboxThreadId = threadId ?? null;
        return this;
    }

    
    /**
     * replayed instead of re-executed across retries, and (with a session
     * store) the journal survives a process restart via saveCheckpoint().
     * @param {{journal: import('./journal.mjs').ExecutionJournal}} arg0 -
     */
        withExecutionJournal({ journal }) {
        this._journal = journal;
        return this;
    }

    
    /**
     * threshold; an object forwards `{ thresholdTokens, summarize }`.
     * @param {{options?: boolean|Object}} arg0 -
     */
        withCompaction({ options = true } = {}) {
        this._compaction = options === true ? {} : (options || null);
        return this;
    }

    
    /**
     * Persists the current conversation row + AgentContext. No-op when no
     * store is attached.
     */
        async saveCheckpoint() {
        if (this._sessionStore && this._threadId) {
            // A turn that failed before its first transcript snapshot has no rows
            // to write. Saving the empty list would CLOBBER the good checkpoint
            // (a failed continuation used to erase the previous turns); keep the
            // stored conversation instead.
            /** @type {any} */
            let messages = this._lastStepMessages ?? (/** @type {any} */ (this)).getMessages?.() ?? [];
            if ((!Array.isArray(messages) || messages.length === 0) && typeof this._sessionStore.load === 'function') {
                // A third-party store may implement `load` synchronously, hence the
                // Promise.resolve. A failed read (EACCES, a broken store) propagates:
                // treating it as "nothing stored" would save the empty list over the
                // good checkpoint. A missing thread already loads as null.
                const existing = await Promise.resolve(this._sessionStore.load(this._threadId));
                if (Array.isArray(existing?.messages) && existing.messages.length > 0) messages = existing.messages;
            }
            const path = await this._sessionStore.save({ threadId: this._threadId, data: {
                messages,
                agentContext: this._agentContext,
                sessionId: this.sessionId ?? this._sessionRunCtx?.runId,
                ...(this._journal ? { journal: this._journal.toJSON() } : {}),
            } });
            this._sessionRunCtx?.emit({ emitter: this.eventEmitter, name: EVENTS.SESSION.CHECKPOINT_SAVED, payload: {
                threadId: this._threadId,
                ...(path ? { path } : {})
            } });
        }
        return this;
    }

    
    /**
     * Branches the current thread: the stored checkpoint is copied under a new
     * thread id, leaving this thread untouched. The branch can be loaded (or
     * continued) like any other checkpoint.
     *
     * @param {{newThreadId: string, overwrite?: boolean}} arg0
     * @returns {Promise<Object|null>} the forked checkpoint.
     */
        async forkCheckpoint({ newThreadId, overwrite = false }) {
        if (!this._sessionStore || !this._threadId) return null;
        if (typeof this._sessionStore.fork !== 'function') {
            throw new ConfigurationError({ message: 'The configured session store does not support forking.', options: { option: 'withSessionStore' } });
        }
        return await this._sessionStore.fork({ threadId: this._threadId, newThreadId, overwrite });
    }

    /**
     * Loads the checkpoint and restores it onto this session (messages land
     * in `_lastStepMessages` so inherit:'history' delegation sees them; the
     * AgentContext is REHYDRATED — a raw JSON restore would break every
     * toModelBlock() consumer).
     * @returns {Promise<{messages?: Array<Object>, agentContext?: Object, journal?: Object, sessionId?: string}|null>} the checkpoint, or null when absent.
     */
        async loadCheckpoint() {
        if (!this._sessionStore || !this._threadId) return null;
        const saved = await this._sessionStore.load(this._threadId);
        if (!saved) return null;
        if (Array.isArray(saved.messages)) this._lastStepMessages = saved.messages;
        if (saved.agentContext) this._agentContext = AgentContext.fromJSON(saved.agentContext);
        if (saved.journal) {
            const { ExecutionJournal } = await import('./journal.mjs');
            this._journal = ExecutionJournal.fromJSON(saved.journal);
        }
        if (saved.sessionId) {
            this._explicitSessionId = saved.sessionId;
            try {
                this.sessionId = saved.sessionId;
            } catch {   }
        }
        this._sessionRunCtx?.emit({ emitter: this.eventEmitter, name: EVENTS.SESSION.CHECKPOINT_LOADED, payload: {
            threadId: this._threadId,
            messageCount: Array.isArray(saved.messages) ? saved.messages.length : 0
        } });
        return saved;
    }

    
    /**
     * Puts a message into the session's inbox from outside the run — typically
     * a host injecting a user message while a turn is already in flight.
     *
     * `delivery: 'steer'` (the default here) reaches the model at the next step
     * boundary of the running turn. `delivery: 'queue'` does not interrupt the
     * step that is running, but it DOES become the next turn of the same run, so
     * `run()` answers it before returning — a one-shot caller never has to call
     * `run()` again for a message the user already sent. A row enqueued without
     * a delivery (a background delegation result) is the one that waits for the
     * next run. A steer claimed by a turn that then fails is put back, so
     * delivery is at-least-once.
     *
     * Enqueueing the same row twice is a no-op: a host that retries a request
     * must not turn one message into two.
     * @param {{input: string|Object, delivery?: 'steer'|'queue'}} arg0 - the text or an already-built row, and its urgency
     * @returns {Object|null} the row that was enqueued, or null when `input` is not a row
     */
    enqueueInput({ input, delivery = 'steer' }) {
        const mode = normalizeDelivery({ delivery });
        /** @type {Record<string, unknown>|null} */
        let row = null;
        if (typeof input === 'string') {
            row = /** @type {Record<string, unknown>} */ (createUserMessage({ provider: /** @type {string} */ (this.provider), content: input }));
        } else if (input && typeof input === 'object') {
            row = /** @type {Record<string, unknown>} */ (input);
        }
        if (!row) return null;
        row.delivery = mode;
        const self = /** @type {any} */ (this);
        if (!Array.isArray(self._pendingInputRows)) self._pendingInputRows = [];
        if (!self._pendingInputRows.includes(row)) {
            self._pendingInputRows.push(row);
            this._emitInboxEvent({ name: EVENTS.SESSION.INPUT_ENQUEUED, payload: { inboxId: row.merciId ?? null, delivery: mode } });
            // A send into an idle session that has never run still belongs in the
            // durable queue: load first, which merges and then writes.
            if (self._inboxStore && self._inboxLoaded !== true) {
                void this.loadInbox().catch((/** @type {any} */ err) => {
                    sdkWarn({ prefix: 'INBOX', args: [`Inbox load failed: ${err?.message ?? String(err)}`] });
                });
            }
            this._scheduleInboxPersist();
        }
        return row;
    }

    /**
     * The messages still waiting on the inbox, in delivery order: what a host
     * renders as the pending queue beside the composer. A turn in flight has
     * already claimed its steers, so they are not here.
     * @returns {Array<Object>} a snapshot; mutating it does not change the queue
     */
    getPendingInputs() {
        return listInboxRows({ session: this });
    }

    /**
     * Withdraws one pending message before a turn claims it. Pass the row
     * `enqueueInput` returned, or its `merciId`. Returns null when the message is
     * not pending any more (already claimed, delivered, or never queued).
     * @param {{input: Object|string}} arg0
     * @returns {Object|null} the removed row
     */
    cancelInput({ input }) {
        const removed = cancelInboxRow({ session: this, input });
        if (removed) {
            this._emitInboxEvent({ name: EVENTS.SESSION.INPUT_CANCELLED, payload: { inboxId: removed.merciId ?? null } });
            this._scheduleInboxPersist();
        }
        return removed;
    }

    /**
     * Switches a pending message between `steer` (deliver inside the running
     * turn) and `queue` (deliver at the next turn) — the toggle a queue panel
     * offers. Returns null when the message is no longer pending.
     * @param {{input: Object|string, delivery: 'steer'|'queue'}} arg0
     * @returns {Object|null} the pending row
     */
    setInputDelivery({ input, delivery }) {
        const row = setInboxRowDelivery({ session: this, input, delivery });
        if (row) {
            this._emitInboxEvent({ name: EVENTS.SESSION.INPUT_DELIVERY_CHANGED, payload: { inboxId: row.merciId ?? null, delivery: /** @type {any} */ (row).delivery } });
            this._scheduleInboxPersist();
        }
        return row;
    }

    /**
     * Whether a `run()`/`drainInbox()` is in flight on this session. A host uses
     * it to choose between running now and enqueueing; `run()` itself refuses a
     * second concurrent run with `MERCI-ERR-CONCURRENT_RUN`.
     * @returns {boolean}
     */
    isRunning() {
        return /** @type {any} */ (this)._runInFlight === true;
    }

    /**
     * Runs the queue without inventing a prompt, the way a host's idle
     * dispatcher does: every message the user submitted is answered, one queued
     * message per turn (any steers ride that turn), until the inbox is empty or
     * `maxInboxTurns` is spent. A background delegation result waiting on the
     * inbox rides the turn too — a drain IS the "next turn" SP3 promises it.
     *
     * Returns null when there is nothing to run (no model call, no events), so a
     * host can call it on every idle transition. A message that lands while the
     * drain is working is picked up by the next iteration, so the returned
     * `answers` is per turn, in delivery order.
     *
     * It is safe to call from several workers: when an inbox store is configured,
     * the drain leases the thread (the scheduler's O_EXCL claim file, stale
     * reclaim and heartbeat) and returns `{ skipped: 'lease' }` instead of racing
     * another drainer. With live background subagents it waits (bounded by
     * `backgroundTimeoutMs`) and returns `{ skipped: 'background' }` rather than
     * answering the queue into a tree that is still working.
     * @param {{options?: LoopOptions}} [arg0]
     * @returns {Promise<{answers: Array<{inboxId: string|null, text: string}>, text: string, skipped?: 'background'|'lease'}|null>}
     */
    async drainInbox({ options = {} } = {}) {
        assertNotInFlight({ flag: this.isRunning(), label: 'drainInbox() cannot run while a run is in flight on this session; that run is already draining the inbox.' });
        await this.loadInbox();
        if (this.getPendingInputs().length === 0) return null;

        // The idle gate: a parent that still waits on a background subagent must
        // not answer its queue into the middle of that tree. OpenChamber holds the
        // queue until `hasWorkingDescendants` is false; the SDK waits here (or
        // leaves the queue for the next call when the deadline passes).
        const gateTimeout = Number(options.backgroundTimeoutMs ?? LIMITS.inbox_background_wait_ms);
        const idle = await this.waitForBackgroundWork({ timeoutMs: options.waitForBackground === false ? 0 : gateTimeout });
        if (!idle) return { answers: [], text: '', skipped: /** @type {'background'} */ ('background') };

        // One drainer per thread, across processes: the built-in stores lease the
        // key through the scheduler's claim store (O_EXCL file, stale reclaim,
        // heartbeat). Without a store — or with a store that has no lease — the
        // in-process `isRunning()` guard is the only serializer, which is correct
        // for one process.
        const store = /** @type {any} */ (this)._inboxStore;
        const key = this._inboxKey();
        const owner = this._inboxLeaseOwner();
        const lease = store?.lease && key ? store.lease : null;
        if (lease) {
            const acquired = await lease.acquire({ threadId: key, owner });
            if (!acquired) return { answers: [], text: '', skipped: /** @type {'lease'} */ ('lease') };
        }
        // Renew well inside the store's own expiry, and never faster than 1 ms:
        // the registry's interval is the ceiling, the store's TTL sets the floor.
        const renewMs = lease
            ? Math.min(LIMITS.inbox_lease_renew_ms, Math.max(1, Math.floor(Number(lease.ttlMs ?? LIMITS.inbox_lease_stale_ms) / 3)))
            : 0;
        /** @type {ReturnType<typeof setInterval>|null} */
        let heartbeat = null;
        if (lease) {
            heartbeat = setInterval(() => {
                lease.refresh({ threadId: key, owner }).catch(() => {});
            }, renewMs);
            heartbeat.unref?.();
        }

        const budget = { left: Number(options.maxInboxTurns ?? LIMITS.max_inbox_turns) };
        // `caller`: the loop answers exactly one turn per iteration, so each
        // queued message comes back with its own answer.
        const opts = { ...options, __inboxBudget: budget, __inboxTurns: /** @type {'caller'} */ ('caller') };
        /** @type {Array<{inboxId: string|null, text: string}>} */
        const answers = [];
        /** @type {'background'|'lease'|null} */
        let skipped = null;
        const onClaim = (/** @type {any} */ row) => this._emitInboxEvent({
            name: EVENTS.SESSION.INPUT_DELIVERED,
            payload: { inboxId: row?.merciId ?? null, delivery: row?.delivery ?? null }
        });
        try {
            while (true) {
                // A subagent may start (or a stale result land) mid-drain: the gate
                // is re-read before every turn, not only once.
                if (this.hasLiveBackgroundWork()) { skipped = 'background'; break; }
                // The heartbeat answers whether this drainer still holds the key. A
                // lost lease is reported, not fatal: the turn already in flight must
                // finish, and the duplicate risk is the at-least-once contract.
                if (lease && renewMs > 0) {
                    const held = await lease.refresh({ threadId: key, owner });
                    if (!held) {
                        this._emitInboxEvent({ name: EVENTS.CLIENT.WARNING, payload: {
                            code: 'INBOX_LEASE_LOST',
                            message: `The inbox lease for "${key}" was lost mid-drain; the current turn finishes and another drainer may now take the queue.`
                        } });
                    }
                }
                const rows = claimInboxTurn({
                    session: this,
                    budget,
                    includeBackground: true,
                    onClaim,
                    onExhausted: ({ pending }) => this._warnInboxExhausted({ pending })
                });
                if (rows.length === 0) break;
                // The same placement rule every other entry point uses: with no prompt
                // to fold into, the batch becomes the turn's user rows, so a request
                // never starts with an assistant row and a tool round is never split.
                const turn = interleavePendingRows({ rows: [], pending: /** @type {any} */ (rows) });
                /** @type {string} */
                let text;
                try {
                    text = await this._runOnce({ initialInput: /** @type {any} */ (turn), options: opts });
                } catch (err) {
                    restoreInboxRows({ session: this, rows });
                    this._scheduleInboxPersist();
                    throw err;
                }
                // The turn committed: its rows leave the durable copy with it.
                await this._flushInbox();
                // The queued row that opened the turn is what a UI labels; a
                // steer-only batch is labelled by its first row.
                const head = /** @type {any} */ (rows.find((row) => row?.delivery === 'queue') ?? rows[0]);
                answers.push({ inboxId: head?.merciId ?? null, text });
            }
            await this._flushInbox();
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            if (lease) await lease.release({ threadId: key, owner }).catch(() => {});
        }
        if (answers.length === 0 && skipped === null) return null;
        return {
            answers,
            text: answers.length > 0 ? answers[answers.length - 1].text : '',
            ...(skipped ? { skipped } : {})
        };
    }

    /**
     * Whether a background subagent THIS session started is still running.
     *
     * A foreground delegation blocks the run itself (`isRunning()`), so only the
     * detached ones matter here: the spawn registry deletes a background task
     * from its live map the moment it settles, and the spawn record names the
     * session that started it. A descendant's work implies a live top-level
     * background record, so the chain is covered without walking it.
     * @returns {boolean}
     */
    hasLiveBackgroundWork() {
        const self = /** @type {any} */ (this);
        if (!self.client) return false;
        const registry = getSpawnRegistry({ client: self.client });
        const background = /** @type {Map<string, Promise<unknown>>|undefined} */ (registry?.background);
        if (!(background instanceof Map) || background.size === 0) return false;
        const sessionId = this.sessionId ?? null;
        for (const record of /** @type {Map<string, any>} */ (registry?.spawns ?? new Map()).values()) {
            if (!record?.taskId || !background.has(record.taskId)) continue;
            if (record.parent === self) return true;
            const parentSessionId = record.parent?.sessionId ?? null;
            if (parentSessionId && sessionId && parentSessionId === sessionId) return true;
        }
        return false;
    }

    /**
     * Waits until every background subagent this session started has settled.
     * The drain calls this so a queued message is not answered into a parent that
     * is still waiting on its own children (OpenChamber's rule: the turn is only
     * over once no subagent runs).
     * @param {{timeoutMs?: number, recheckMs?: number}} [arg0] - `0` checks once and returns immediately
     * @returns {Promise<boolean>} true when nothing is running, false when the deadline passed first
     */
    async waitForBackgroundWork({ timeoutMs = LIMITS.inbox_background_wait_ms, recheckMs = LIMITS.inbox_background_recheck_ms } = {}) {
        if (!this.hasLiveBackgroundWork()) return true;
        if (!(timeoutMs > 0)) return false;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const wait = Math.max(1, Math.min(recheckMs, deadline - Date.now()));
            await new Promise((resolve) => setTimeout(resolve, wait));
            if (!this.hasLiveBackgroundWork()) return true;
        }
        return false;
    }

    /**
     * The one process-unique lease owner token, shaped like the scheduler's.
     * @returns {string}
     */
    _inboxLeaseOwner() {
        return `${hostname()}:${process.pid}:${randomUUID()}`;
    }

    /**
     * The one place an inbox lifecycle event leaves the session. A host with no
     * emitter attached pays nothing.
     * @param {{name: string, payload: Record<string, unknown>}} arg0
     */
    _emitInboxEvent({ name, payload }) {
        emitEvent({ emitter: this.eventEmitter ?? null, name, payload, runContext: this._sessionRunCtx ?? null });
    }

    /**
     * The key the inbox is persisted under: the conversation, not the process.
     * A `SessionStore` thread id is the durable identity, so the queue survives
     * a restart next to the checkpoint it belongs to.
     * @returns {string|null}
     */
    _inboxKey() {
        const self = /** @type {any} */ (this);
        const key = self._inboxThreadId ?? self._threadId ?? this.sessionId ?? null;
        return typeof key === 'string' && key !== '' ? key : null;
    }

    /**
     * Loads the durable inbox once. Stored rows go BEFORE anything enqueued
     * while the load was in flight (they are older), and a row already in
     * memory is not duplicated by its `merciId`.
     * @returns {Promise<Array<Object>>} the pending rows after the merge
     */
    async loadInbox() {
        const self = /** @type {any} */ (this);
        if (!self._inboxStore) return this.getPendingInputs();
        if (self._inboxLoaded === true) {
            // Already loaded: settling the scheduled writes is the documented way
            // to know the durable copy matches memory (the example's "graceful
            // stop" and a test's restart point).
            await this._flushInbox();
            return this.getPendingInputs();
        }
        if (self._inboxLoadPromise) {
            await self._inboxLoadPromise;
            return this.getPendingInputs();
        }
        const key = this._inboxKey();
        if (!key) return this.getPendingInputs();
        self._inboxLoadPromise = (async () => {
            const stored = await self._inboxStore.load({ threadId: key });
            self._inboxLoaded = true;
            if (Array.isArray(stored) && stored.length > 0) {
                const current = this.getPendingInputs();
                const known = new Set(current.map((/** @type {any} */ row) => row?.merciId));
                const older = stored.filter((/** @type {any} */ row) => !known.has(row?.merciId));
                if (older.length > 0) self._pendingInputRows = [...older, ...current];
            }
        })();
        try {
            await self._inboxLoadPromise;
        } finally {
            self._inboxLoadPromise = null;
        }
        await this._flushInbox();
        return this.getPendingInputs();
    }

    /**
     * Writes the pending rows behind any write already in flight. Fire-and-forget:
     * a failed write is reported, never thrown into a host's send handler (the
     * row stays in memory and the next write retries it).
     * @returns {void}
     */
    _scheduleInboxPersist() {
        const self = /** @type {any} */ (this);
        if (!self._inboxStore || self._inboxLoaded !== true) return;
        const key = this._inboxKey();
        if (!key) return;
        const rows = this.getPendingInputs();
        self._inboxSaveTail = (self._inboxSaveTail ?? Promise.resolve())
            .then(() => self._inboxStore.save({ threadId: key, rows }))
            .catch((/** @type {any} */ err) => {
                sdkWarn({ prefix: 'INBOX', args: [`Inbox save failed for "${key}": ${err?.message ?? String(err)}`] });
            });
    }

    /**
     * Waits until every scheduled write has landed. A no-op without a store, so
     * the in-memory contract stays the default.
     * @returns {Promise<void>}
     */
    async _flushInbox() {
        const self = /** @type {any} */ (this);
        if (!self._inboxStore) return;
        this._scheduleInboxPersist();
        await (self._inboxSaveTail ?? Promise.resolve());
    }

    /**
     * Runs the agent once, or over a streamed input.
     *
     * `initialInput` is a prompt string, a message history, or an **async
     * iterable**: every chunk of the iterable becomes the next user turn of the
     * same conversation, so the caller can feed the agent while it is already
     * working, and the answer of the last turn is returned.
     *
     * A `steer` or `queue` row a host enqueued with `enqueueInput` while this run
     * was working becomes another turn of this SAME run (never a promise that
     * waits for a call that may never come), so the returned string is the answer
     * to the last of them. That holds for a message that lands between the loop's
     * last turn boundary and this promise resolving too: the run claims it before
     * returning. `maxInboxTurns` caps how many such turns one run may add
     * (default `MERCI_LIMIT_MAX_INBOX_TURNS`); past the cap the rows stay pending
     * and visible, and the run returns the answer it has.
     *
     * `options` carries the run knobs (`maxIterations`, `signal`, `onEvent`,
     * `followUp`, `compaction`, `retryPolicy`, …). `retryPolicy` enables a
     * run-level retry on mid-run failures, resuming from the last
     * completed step; defaults to the session's withRetryPolicy policy (no retry by default).
     * @param {{initialInput: string|Array<Object>|AsyncIterable<string|Object>, options?: LoopOptions}} arg0
     * @returns {Promise<string>}
     */
        async run({ initialInput, options = {} }) {
        // The durable queue is loaded before the first turn of this process; a
        // no-op without `withInboxStore()`.
        await this.loadInbox();
        // A streamed input is an async iterable: each chunk is one user turn and
        // the conversation accumulates, so the caller can feed the agent while it
        // is already working. Each chunk drains the inbox (`_runStreamed`).
        if (isAsyncIterable({ value: initialInput })) {
            return await this._runStreamed({ input: /** @type {any} */ (initialInput), options });
        }
        const self = /** @type {any} */ (this);
        const inboxBudget = { left: Number(options.maxInboxTurns ?? LIMITS.max_inbox_turns) };
        const opts = { ...options, __inboxBudget: inboxBudget };
        /** @param {any} row */
        const onClaim = (row) => this._emitInboxEvent({
            name: EVENTS.SESSION.INPUT_DELIVERED,
            payload: { inboxId: row?.merciId ?? null, delivery: row?.delivery ?? null }
        });
        /** @type {any} */
        let input = Array.isArray(initialInput)
            ? initialInput
            : [createUserMessage({ provider: /** @type {string} */ (this.provider), content: String(initialInput ?? '') })];
        /** @type {Array<Object>} rows a previous turn claimed for THIS one */
        let carried = [];
        while (true) {
            // Claim BEFORE the turn (`runStep`'s protocol): the loop must not see
            // a row twice, and a failed turn puts it back, so delivery is
            // at-least-once. Only rows that arrive DURING the turn are the loop's.
            const peeked = listInboxRows({ session: self });
            if (peeked.length > 0) claimInboxRows({ session: self, rows: peeked, onClaim });
            // `carried` is already interleaved into `input`; only the newcomers are.
            const turn = peeked.length > 0
                ? interleavePendingRows({ rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (input), pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (peeked) })
                : input;
            /** @type {string} */
            let result;
            try {
                result = await this._runOnce({ initialInput: /** @type {string|Array<Object>} */ (turn), options: opts });
            } catch (err) {
                // The turn never answered anything: put back every row it was
                // assembled with, not only the ones claimed this iteration.
                restoreInboxRows({ session: self, rows: [...carried, ...peeked] });
                this._scheduleInboxPersist();
                throw err;
            }
            // The turn committed: the rows it carried have left the inbox, so the
            // durable copy must drop them before the next turn can claim more.
            await this._flushInbox();
            // A message that landed after the loop's last turn boundary (during an
            // output guardrail or the checkpoint write) must not be stranded: the
            // run answers it before this promise resolves.
            const slipped = claimInboxTurn({ session: self, budget: inboxBudget, onClaim, onExhausted: ({ pending }) => this._warnInboxExhausted({ pending }) });
            if (slipped.length === 0) return result;
            carried = slipped;
            input = interleavePendingRows({
                rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (Array.isArray(self._lastStepMessages) ? self._lastStepMessages : turn),
                pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (slipped)
            });
        }
    }

    /**
     * The one notice for a spent inbox-turn budget: the rows are still on the
     * inbox, so a host can render or re-submit them.
     * @param {{pending: number}} arg0
     */
    _warnInboxExhausted({ pending }) {
        this._emitInboxEvent({ name: EVENTS.CLIENT.WARNING, payload: {
            code: 'INBOX_TURNS_EXHAUSTED',
            message: `The run's inbox-turn cap (${LIMITS.max_inbox_turns}) is spent; ${pending} submitted message(s) stay pending on the session inbox.`
        } });
    }

    /**
     * The last attempted run in one object: the deliverable `run()` returned,
     * the final message rows, the usage, citations, and sources the `RUN_END`
     * event carries, and the run's outcome.
     *
     * `run()` keeps its string return for compatibility, so the outcome is read
     * here: `finishReason` (`stop` / `length` / `premature_end` / `empty` /
     * `schema` / `content_filtered` / `max_turns` / `budget` / `error` /
     * `aborted`), `truncated` + `truncatedBy`, `contentFiltered`, and
     * `fallbackKind` (`max_iterations` / `empty` / `schema` / `filtered`, or
     * null) for an answer that is an SDK sentinel rather than model text.
     *
     * This is the supported way to read what a run produced: the rows used to
     * be reachable only through the internal `_lastStepMessages`, and the
     * metadata only through `onEvent`, so a host that needed both read a
     * private field.
     * @returns {{
     *   text: string,
     *   messages: Array<Object>,
     *   usage: Object|null,
     *   citations: Array<unknown>,
     *   sources: Array<unknown>,
     *   finishReason: string|null,
     *   truncated: boolean,
     *   truncatedBy: 'length'|'premature_end'|null,
     *   contentFiltered: boolean,
     *   fallbackKind: 'max_iterations'|'empty'|'schema'|'filtered'|null
     * }}
     */
    getLastRun() {
        const self = /** @type {any} */ (this);
        return {
            text: typeof self._lastRunText === 'string' ? self._lastRunText : '',
            messages: Array.isArray(self._lastStepMessages) ? [...self._lastStepMessages] : [],
            usage: self._lastRunUsage ?? null,
            citations: Array.isArray(self._lastRunCitations) ? [...self._lastRunCitations] : [],
            sources: Array.isArray(self._lastRunSources) ? [...self._lastRunSources] : [],
            finishReason: typeof self._lastRunFinishReason === 'string' ? self._lastRunFinishReason : null,
            truncated: self._lastRunTruncated === true,
            truncatedBy: self._lastRunTruncatedBy ?? null,
            contentFiltered: self._lastRunContentFiltered === true,
            fallbackKind: typeof self._lastRunFallbackKind === 'string' ? self._lastRunFallbackKind : null
        };
    }

    /**
     * Runs the agent once for a single (non-streamed) input.
     * @param {{initialInput: string|Array<Object>, options?: LoopOptions}} arg0
     * @returns {Promise<string>}
     */
        async _runOnce({ initialInput, options = {} }) {
        // Every field describes THIS attempt; a failed attempt leaves no stale
        // deliverable or metadata from the previous run. `step()` clears the
        // same state before its own turn.
        const self = /** @type {any} */ (this);
        self._lastRunText = '';
        self._lastStepMessages = [];
        self._lastRunUsage = null;
        self._lastRunCitations = [];
        self._lastRunSources = [];
        self._lastRunFinishReason = null;
        self._lastRunTruncated = false;
        self._lastRunTruncatedBy = null;
        self._lastRunContentFiltered = false;
        self._lastRunFallbackKind = null;
        this._planHandoff = this._agent === AGENT_EXECUTE && this._agentPrev === AGENT_PLAN;
        if (this._planHandoff) this._agentPrev = null;
        this._planExitRequested = false;
        if (this._agent === AGENT_PLAN && typeof options.followUp !== 'function') {
            options = { ...options, followUp: createPlanStageFollowUp({ session: /** @type {import('./plan/component.mjs').PlanSession} */ (this) }) };
        }
        const messages = Array.isArray(initialInput)
            ? [...initialInput]
            : [createUserMessage({ provider: /** @type {string} */ (this.provider), content: initialInput })];
        if (this._compaction && /** @type {any} */ (options).compaction === undefined) {
            options = { ...options, compaction: this._compaction };
        }
        // The session-level gate is the default; an explicit per-run one wins.
        options = /** @type {any} */ (mergeDecisionGate({ options, gate: this._decisionGate }));
        // A failed run must still persist what it committed: a throw after a
        // tool round used to discard the journal rows, and a resume replayed
        // the side effects. `_runStreamed` delegates here per chunk, so this
        // one fix covers both paths.
        // G1-1: the journal persists its INTENT row before a tool runs. The
        // sibling file is written mid-run; the checkpoint still carries the
        // journal for the graceful-stop path.
        if (this._sessionStore && this._threadId) {
            const { ExecutionJournal, attachJournalSink, restoreJournalSibling } = await import('./journal.mjs');
            const journal = this._journal ?? (this._journal = new ExecutionJournal({ runId: this._sessionRunCtx?.runId ?? null }));
            await restoreJournalSibling({ journal, store: this._sessionStore, threadId: this._threadId });
            attachJournalSink({ journal, store: this._sessionStore, threadId: this._threadId });
        }
        try {
            return await runAgenticLoop({ session: /** @type {import('./agentic-core.mjs').Session} */ (/** @type {unknown} */ (this)), messages, opts: options });
        } catch (error) {
            self._lastRunFinishReason = 'error';
            throw error;
        } finally {
            if (this._sessionStore && this._threadId) {
                try {
                    await this.saveCheckpoint();
                } catch (err) {
                    sdkWarn({ prefix: 'CHAT-SESSION', args: [`Checkpoint save failed for thread "${this._threadId}": ${(/** @type {any} */ (err)).message}`] });
                }
            }
        }
    }

    /**
     * Runs the agent over a **streamed** input: every chunk of the async
     * iterable becomes the next user turn of the same conversation, and the
     * answer of the last turn is returned.
     *
     * @param {{input: AsyncIterable<string|Object>, options?: LoopOptions}} arg0
     * @returns {Promise<string>}
     */
        async _runStreamed({ input, options = {} }) {
        const self = /** @type {any} */ (this);
        const inboxBudget = { left: Number(options.maxInboxTurns ?? LIMITS.max_inbox_turns) };
        const opts = { ...options, __inboxBudget: inboxBudget };
        /** @param {any} row */
        const onClaim = (row) => this._emitInboxEvent({
            name: EVENTS.SESSION.INPUT_DELIVERED,
            payload: { inboxId: row?.merciId ?? null, delivery: row?.delivery ?? null }
        });
        /** @type {Array<Object>} */
        let messages = [];
        /** @type {string} */
        let answer = '';
        for await (const chunk of input) {
            const row = typeof chunk === 'string'
                ? createUserMessage({ provider: /** @type {string} */ (this.provider), content: chunk })
                : chunk;
            if (!row) continue;
            messages = [...messages, row];
            // The stream's next turn drains the inbox exactly like a plain run():
            // a message that arrived while the previous chunk's turn was working is
            // answered by this chunk's turn, not left for a run that may never come.
            const peeked = listInboxRows({ session: self });
            if (peeked.length > 0) claimInboxRows({ session: self, rows: peeked, onClaim });
            const turn = peeked.length > 0
                ? interleavePendingRows({ rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (messages), pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (peeked) })
                : [...messages];
            try {
                answer = await this._runOnce({ initialInput: /** @type {string|Array<Object>} */ (turn), options: opts });
            } catch (err) {
                restoreInboxRows({ session: self, rows: peeked });
                this._scheduleInboxPersist();
                throw err;
            }
            await this._flushInbox();
            // The conversation keeps the agent's OWN turns: without them the
            // model never sees what it answered in the previous turn.
            const produced = Array.isArray(this._lastStepMessages) ? this._lastStepMessages : null;
            if (produced && produced.length > messages.length) messages = [...produced];
        }
        // The stream ended, but a message sent during its last turn (or that
        // turn's checkpoint write) is still pending: it gets a turn of its own,
        // bounded by the same budget, so `run()` never resolves stranding it.
        while (true) {
            const slipped = claimInboxTurn({ session: self, budget: inboxBudget, onClaim, onExhausted: ({ pending }) => this._warnInboxExhausted({ pending }) });
            if (slipped.length === 0) break;
            const turn = interleavePendingRows({
                rows: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (messages),
                pending: /** @type {Array<import('../messaging/unified-message.mjs').MessageRow>} */ (slipped)
            });
            try {
                answer = await this._runOnce({ initialInput: /** @type {string|Array<Object>} */ (turn), options: opts });
            } catch (err) {
                restoreInboxRows({ session: self, rows: slipped });
                this._scheduleInboxPersist();
                throw err;
            }
            await this._flushInbox();
            const produced = Array.isArray(this._lastStepMessages) ? this._lastStepMessages : null;
            if (produced && produced.length > messages.length) messages = [...produced];
        }
        return answer;
    }
}
