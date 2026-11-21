// @ts-check


/**
 * @file `createOrchestration`: the composition root for the coordination layer.
 * @version 0.12.0
 *
 * @description
 * The four coordination modules are primitives: the policy parses and renders a
 * repo-owned contract, the scheduler claims and dispatches work items, the
 * workspace isolates one item, and the operator projects the scheduler. This
 * module is the one place that binds them, so a host does not re-derive the
 * five couplings — and cannot get one of them subtly wrong:
 *
 *   policy → scheduler   `policyToSchedulerOptions` at construction, and again
 *                        whenever the policy reports a healthy reload. Applying
 *                        is not gated on `changed`: the built-in watcher reloads
 *                        the policy itself, so an edit can be healthy-and-
 *                        unchanged by the time the host asks. `applyConfig` is
 *                        a no-op when nothing differs.
 *   policy → workspace   `policyToWorkspaceOptions` at construction. The
 *                        workspace layer is construction-bound by design.
 *   scheduler → workspace the real `WorkspaceManager` satisfies the scheduler's
 *                        duck-typed contract, so it is passed as-is.
 *   scheduler → operator `snapshot()`/`refresh()` feed the handler; one
 *                        `MerciEventEmitter` feeds the ring, so `recentEvents`
 *                        and every other consumer see the same records.
 *   approval → both      one approval function is the session gate **and** the
 *                        workspace shell gate. Without one, the shell tool is
 *                        not bound at all (no ungated shell), and the
 *                        context/artifact tools still are.
 *
 * The two gates call the one callback with **different arguments**: the session
 * gate passes `(toolName, argsObject, { tool, id })`, the workspace shell gate
 * passes `(commandString, argvArray)`. A callback that must tell them apart
 * branches on the third argument or on the shape of the second.
 *
 * The model is never taken from `WORKFLOW.md`. The file may name a model, but
 * the host passes `model` explicitly — nothing switches the model implicitly.
 * The engine *kind* may default from the file, because it selects an existing
 * engine rather than a provider; `dag`, `stateMachine`, and `discussion` still
 * need their own `runner` options (`planFor`, `graphFor`, `agents`).
 *
 * Boot is strict: a `WORKFLOW.md` that cannot load fails `createOrchestration`
 * with the `PolicyError` and its reasons, because there is no last good config
 * to serve yet. A **live** break is not strict: `reload()` returns
 * `{ healthy: false, reasons }`, applies nothing, and the operator reports it.
 * A rejected construction stops a policy the facade created, and leaves an
 * injected one running; the injected policy's event sink is borrowed for the
 * lifetime of the orchestration and handed back by `stop()`, which never ends a
 * lifecycle the host started.
 *
 * This module adds no run loop, no engine, and no dependency. Every primitive
 * stays public and separately usable.
 */

import { isDeepStrictEqual } from 'node:util';

import { configurationError } from '../../core/errors.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { MerciEventEmitter } from '../../core/emitter.mjs';
import { isRecordObject } from '../../support/validation.mjs';
import { normalizeApproval } from '../approval.mjs';
import { WorkScheduler, MANAGED_KEYS as MANAGED_SCHEDULER_KEYS } from '../scheduler/scheduler.mjs';
import { createEngineRunner } from '../scheduler/runner.mjs';
import { errorFields } from '../scheduler/retry.mjs';
import { WorkspaceManager } from '../workspace/manager.mjs';
import { createWorkspaceTools } from '../workspace/toolbox.mjs';
import { createEventRing } from '../operator/ring.mjs';
import { createOperatorHttpHandler } from '../operator/http.mjs';
import { WorkflowPolicy } from '../workflow-policy/policy.mjs';
import {
    createPolicyRenderer,
    policyToSchedulerOptions,
    policyToWorkspaceOptions
} from '../workflow-policy/integrate.mjs';

/**
 * One engine attempt's tool binder, as `createEngineRunner` accepts it.
 * @typedef {(arg0: {item: unknown, attempt: number|null, workspace: Record<string, unknown>|null}) => Array<Record<string, unknown>>} ItemToolBinder
 */

/**
 * What an approval callback may return: a boolean, or a reasoned decision.
 * @typedef {boolean|{approved: boolean, reason?: string}|Promise<boolean>|Promise<{approved: boolean, reason?: string}>} ApprovalDecision
 */

/**
 * One gate for both layers. The session gate calls `(toolName, argsObject,
 * {tool, id})`; the workspace shell gate calls `(commandString, argvArray)`.
 * @typedef {(target: string, args: Record<string, unknown>|Array<string>, meta?: Record<string, unknown>) => ApprovalDecision} ApprovalCallback
 */

/**
 * The scheduler's own construction options, matched structurally.
 * @typedef {NonNullable<ConstructorParameters<typeof WorkScheduler>[0]>} SchedulerConstructionOptions
 */

/**
 * @typedef {Object} OrchestrationOptions
 * @property {{session: (model: string) => unknown}} client - An initialized backend client.
 * @property {string} model - The model the engine runs on. Always supplied by the host.
 * @property {{fetchByStates: Function, fetchByIds: Function}} workSource - A read-only board adapter.
 * @property {WorkflowPolicy|null} [policy] - A pre-built policy; started if it is not, and pointed at the facade's emitter until `stop()` hands it back. Its lifecycle stays the host's when the host started it.
 * @property {string} [workflowFile] - Shorthand for `policyOptions.path`.
 * @property {Record<string, unknown>} [policyOptions] - Extra `WorkflowPolicy` options.
 * @property {string|null} [engine] - `agentic` (default), `dag`, `stateMachine`, `discussion`.
 * @property {WorkspaceManager|null|undefined} [workspace] - `undefined` builds it from the policy; `null` runs without one.
 * @property {import('../scheduler/claims.mjs').ClaimStore|'memory'|null} [claims] - A claim store, or `'memory'`.
 * @property {import('../scheduler/attempt-store.mjs').AttemptStore|'memory'|null} [attemptStore] - Where attempt counts and parking survive a restart; default is in-process.
 * @property {Record<string, unknown>|null} [store] - A `{ load, save }` checkpoint store.
 * @property {Record<string, unknown>|null} [budget] - `{ maxTotalTokens, maxBudgetUsd }` for one attempt.
 * @property {ApprovalCallback|{callback: ApprovalCallback, timeoutMs?: number}|{fn: ApprovalCallback, options?: {timeoutMs?: number}}|null} [approval] - One approval for the session **and** the workspace shell.
 * @property {import('../permissions.mjs').PermissionMode} [permissionMode] - How the workspace shell gate treats `bypassPermissions`; default `'default'` asks.
 * @property {ItemToolBinder|Array<Record<string, unknown>>|null} [tools] - Overrides the default binder.
 * @property {MerciEventEmitter|null} [emitter] - Defaults to a new `MerciEventEmitter`.
 * @property {boolean|Record<string, unknown>} [operator] - `true`, options, or `false` (default).
 * @property {{limit?: number, prefixes?: string[]}} [ring] - The event ring's bound and prefixes; supplying it wires the ring even without the operator handler.
 * @property {Record<string, unknown>} [scheduler] - Extra `WorkScheduler` options; the bound ones are refused.
 * @property {Record<string, unknown>} [runner] - Extra `createEngineRunner` options; the owned ones are refused.
 */

/**
 * @typedef {Object} Orchestration
 * @property {WorkflowPolicy} policy
 * @property {WorkspaceManager|null} workspace
 * @property {WorkScheduler} scheduler - The live instance; read it after `start()` (it is rebuilt if the file changed before the first tick).
 * @property {ReturnType<typeof createEngineRunner>} runner
 * @property {MerciEventEmitter} emitter
 * @property {ReturnType<typeof createEventRing>|null} ring
 * @property {Function|null} handler
 * @property {() => Promise<{changed: boolean, healthy: boolean, reasons: string[], applied: Record<string, unknown>|null}>} reload
 * @property {() => Promise<void>} start
 * @property {() => Promise<{drained: boolean, running: number, retrying: number, parked: number}>} stop
 * @property {(arg0?: {port?: number, host?: string}) => Promise<{server: import('node:http').Server, url: string}>} listen
 * @property {() => Promise<void>} close
 */

/** Collaborators the facade owns; a pass-through option may not replace them. */
const BOUND_SCHEDULER_KEYS = Object.freeze(['workSource', 'workflow', 'workspace', 'eventEmitter', 'claims', 'attemptStore', 'preflight']);

/** The runner options the facade builds from the policy; a pass-through may not shadow them. */
const OWNED_RUNNER_KEYS = Object.freeze(['engine', 'client', 'model', 'prompt', 'tools', 'approval', 'store', 'budget']);

/**
 * Managed keys whose value is an object a host may override in part
 * (`limits: { maxTotalUsd: 1 }` is the shape ORCHESTRATION §5 documents).
 * A shallow spread replaces the whole object, so the policy's remaining
 * values vanish from the patch and `applyConfig` refuses it.
 */
const PARTIAL_OBJECT_KEYS = Object.freeze(['concurrency', 'retry', 'continuation', 'limits']);

/** The top-level ring option's only keys. */
const RING_KEYS = Object.freeze(['limit', 'prefixes']);

/**
 * Fail before construction instead of producing a half-wired system.
 * @param {{options: OrchestrationOptions}} arg0
 * @returns {{client: {session: (model: string) => unknown}, model: string, workSource: {fetchByStates: Function, fetchByIds: Function}}}
 */
function assertRequired({ options }) {
    const client = options.client;
    if (!client || typeof client !== 'object' || typeof client.session !== 'function') {
        throw configurationError({
            option: 'client',
            message: 'createOrchestration requires an initialized client with session(model).'
        });
    }
    if (typeof options.model !== 'string' || options.model.trim() === '') {
        throw configurationError({
            option: 'model',
            message: 'createOrchestration requires a non-empty model; the model is never taken from WORKFLOW.md.'
        });
    }
    const source = options.workSource;
    if (!source || typeof source !== 'object'
        || typeof source.fetchByStates !== 'function' || typeof source.fetchByIds !== 'function') {
        throw configurationError({
            option: 'workSource',
            message: 'createOrchestration requires a work source with fetchByStates() and fetchByIds().'
        });
    }
    return { client, model: options.model, workSource: source };
}

/**
 * The default per-item tool binder. With an approval callback the shell tool is
 * bound too; without one it is omitted rather than run ungated.
 * @param {{approval?: ApprovalCallback|{callback: ApprovalCallback, timeoutMs?: number}|{fn: ApprovalCallback, options?: {timeoutMs?: number}}|null, eventEmitter?: import('node:events').EventEmitter|null, permissionMode?: import('../permissions.mjs').PermissionMode}} [arg0]
 * @returns {ItemToolBinder}
 */
export function createItemTools({ approval = null, eventEmitter = null, permissionMode = 'default' } = {}) {
    const normalized = normalizeApproval({ value: approval, origin: 'createItemTools', option: 'approval' });
    const callback = normalized === null ? null : /** @type {ApprovalCallback} */ (normalized.callback);
    const include = callback === null
        ? ['context', 'artifacts']
        : ['context', 'shell', 'artifacts'];
    return ({ workspace }) => {
        if (!workspace) return [];
        const built = createWorkspaceTools({
            workspace,
            approvalCallback: callback,
            eventEmitter,
            include,
            permissionMode
        });
        // `createWorkspaceTools` groups the tools; the engine takes one flat list.
        return /** @type {Array<Record<string, unknown>>} */ (
            [...(built.contextTools ?? []), built.shellTool, built.artifactTool].filter(Boolean)
        );
    };
}

/**
 * Build the coordination layer around one client, one board, and one
 * `WORKFLOW.md`.
 * @param {OrchestrationOptions} [options]
 * @returns {Promise<Orchestration>}
 */
export async function createOrchestration(options = /** @type {never} */ ({})) {
    const { client, model, workSource } = assertRequired({ options });

    const strategy = isRecordObject(options.scheduler) ? /** @type {Record<string, unknown>} */ (options.scheduler) : {};
    const refusedScheduler = BOUND_SCHEDULER_KEYS.filter((key) => Object.hasOwn(strategy, key));
    if (refusedScheduler.length > 0) {
        throw configurationError({
            option: 'scheduler',
            message: `createOrchestration owns these scheduler options: ${refusedScheduler.join(', ')}. `
                + 'A host preflight can be composed with scheduler.applyConfig() after start().'
        });
    }
    const runnerExtras = isRecordObject(options.runner) ? /** @type {Record<string, unknown>} */ (options.runner) : {};
    const refusedRunner = OWNED_RUNNER_KEYS.filter((key) => Object.hasOwn(runnerExtras, key));
    if (refusedRunner.length > 0) {
        throw configurationError({
            option: 'runner',
            message: `createOrchestration builds these runner options from the policy: ${refusedRunner.join(', ')}.`
        });
    }

    if (options.ring !== undefined) {
        if (!isRecordObject(options.ring)) {
            throw configurationError({
                option: 'ring',
                message: 'createOrchestration requires ring to be an object with limit and/or prefixes.'
            });
        }
        const unknownRingKeys = Object.keys(/** @type {Record<string, unknown>} */ (options.ring))
            .filter((key) => !RING_KEYS.includes(key));
        if (unknownRingKeys.length > 0) {
            throw configurationError({
                option: 'ring',
                message: `createOrchestration ring does not accept: ${unknownRingKeys.join(', ')}.`
            });
        }
    }

    const emitter = options.emitter ?? new MerciEventEmitter();
    if (!emitter || typeof (/** @type {{onAny?: unknown}} */ (emitter)).onAny !== 'function') {
        throw configurationError({
            option: 'emitter',
            message: 'createOrchestration requires a MerciEventEmitter; the operator ring subscribes through onAny().'
        });
    }
    if (options.policy !== null && options.policy !== undefined && typeof options.policy.start !== 'function') {
        throw configurationError({ option: 'policy', message: 'createOrchestration policy must be a WorkflowPolicy.' });
    }
    if (typeof options.workflowFile === 'string' && isRecordObject(options.policyOptions)
        && Object.hasOwn(/** @type {Record<string, unknown>} */ (options.policyOptions), 'path')) {
        throw configurationError({
            option: 'workflowFile',
            message: 'createOrchestration: pass workflowFile or policyOptions.path, not both.'
        });
    }

    // Validate the approval before starting the policy: a bad gate must not
    // leave a live file watcher behind.
    const approval = normalizeApproval({ value: options.approval, origin: 'createOrchestration', option: 'approval' });
    const permissionMode = options.permissionMode ?? 'default';

    const injectedPolicy = options.policy ?? null;
    const policy = injectedPolicy ?? new WorkflowPolicy({
        ...(isRecordObject(options.policyOptions) ? /** @type {Record<string, unknown>} */ (options.policyOptions) : {}),
        ...(typeof options.workflowFile === 'string' ? { path: options.workflowFile } : {}),
        eventEmitter: emitter
    });
    // The policy must have a resolved config before the mapping helpers accept
    // it; an injected instance may already be started by its host.
    const policyStarted = policy.snapshot().started === true;
    if (!policyStarted) await policy.start();
    // An injected policy was built with its own emitter (or none). The ring and
    // the facade's reload subscription need this one, so it is borrowed — and
    // handed back on stop(), because the policy stays the host's (F1-6).
    /** @type {import('node:events').EventEmitter|null} */
    const priorEmitter = injectedPolicy === null ? null : /** @type {import('node:events').EventEmitter|null} */ (policy.eventEmitter);
    if (injectedPolicy !== null) policy.withEventEmitter({ eventEmitter: emitter });

    /**
     * Undo the emitter takeover. Only an injected policy had one to give back.
     * @returns {void}
     */
    function restorePolicyEmitter() {
        if (injectedPolicy !== null) policy.withEventEmitter({ eventEmitter: priorEmitter });
    }

    const engine = typeof options.engine === 'string' && options.engine !== ''
        ? options.engine
        : policy.getConfig()?.engine.kind ?? 'agentic';

    /** @type {WorkspaceManager|null} */
    let workspace = null;
    /** @type {ReturnType<typeof createEngineRunner>|null} */
    let runner = null;
    /** @type {ReturnType<typeof createEventRing>|null} */
    let ring = null;
    /** @type {Function|null} */
    let handler = null;
    /** @type {WorkScheduler|null} */
    let scheduler = null;
    /** The policy mapping the live scheduler was built from (pre-start check). */
    /** @type {SchedulerConstructionOptions|null} */
    let builtFrom = null;
    try {
        workspace = options.workspace === undefined
            ? new WorkspaceManager({ ...policyToWorkspaceOptions({ policy }), eventEmitter: emitter })
            : options.workspace;

        const tools = options.tools ?? createItemTools({
            approval: approval === null ? null : /** @type {ApprovalCallback} */ (approval.callback),
            eventEmitter: emitter,
            permissionMode
        });
        runner = createEngineRunner({
            ...runnerExtras,
            engine,
            client,
            model,
            prompt: createPolicyRenderer({ policy, eventEmitter: emitter }),
            tools,
            approval,
            store: options.store ?? null,
            budget: options.budget ?? null
        });

        scheduler = buildScheduler({ mapped: policyToSchedulerOptions({ policy }) });

        const operator = options.operator ?? false;
        const ringOptions = isRecordObject(options.ring)
            ? /** @type {{limit?: number, prefixes?: string[]}} */ (options.ring)
            : {};
        const ringRequested = operator !== false || options.ring !== undefined;
        ring = ringRequested
            ? createEventRing({
                emitter,
                limit: ringOptions.limit
                    ?? (isRecordObject(operator) && typeof /** @type {Record<string, unknown>} */ (operator).ringLimit === 'number'
                        ? /** @type {number} */ (/** @type {Record<string, unknown>} */ (operator).ringLimit)
                        : LIMITS.orchestration_ring_fallback),
                prefixes: /** @type {ReadonlyArray<string>|undefined} */ (ringOptions.prefixes)
            })
            : null;
        const operatorOptions = isRecordObject(operator) ? { .../** @type {Record<string, unknown>} */ (operator) } : {};
        delete operatorOptions.ringLimit;
        handler = operator === false || ring === null
            ? null
            : createOperatorHttpHandler({
                ...operatorOptions,
                getSnapshot: () => currentScheduler().snapshot(),
                getPolicySnapshot: () => policy.snapshot(),
                refresh: () => currentScheduler().refresh(),
                recentEvents: ({ identifier, limit }) => /** @type {{list: Function}} */ (ring).list({ identifier, limit })
            });
    } catch (error) {
        // A rejected construction must not leave a subscribed ring emitting into
        // the host's emitter. Ownership decides the lifecycle: a policy this
        // facade started (created or injected-unstarted) is stopped with the
        // rest, and one the host had already started is left running (W1-5).
        if (ring !== null) /** @type {{stop: Function}} */ (ring).stop();
        restorePolicyEmitter();
        if (!policyStarted && policy.snapshot().started === true) policy.stop();
        throw error;
    }

    /** @type {import('node:http').Server|null} */
    let openServer = null;
    let stopped = false;
    /** The policy's own `reload()` is in flight; the event handler defers to it. */
    let reloading = false;

    /**
     * @returns {WorkScheduler}
     */
    function currentScheduler() {
        if (scheduler === null) throw configurationError({ option: 'scheduler', message: 'createOrchestration: no scheduler.' });
        return scheduler;
    }

    /**
     * One mapping for construction, the start() comparison and every reload.
     * The host's pass-through options win over the file (documented in
     * ORCHESTRATION §5), so a cap set in code is not silently dropped when
     * `applyIfHealthy` re-applies the policy mapping (F1-2).
     * @param {{mapped: SchedulerConstructionOptions}} arg0
     * @returns {SchedulerConstructionOptions}
     */
    function effectiveSchedulerOptions({ mapped }) {
        /** @type {Record<string, unknown>} */
        const merged = /** @type {Record<string, unknown>} */ ({ ...mapped, ...strategy });
        for (const key of PARTIAL_OBJECT_KEYS) {
            const base = /** @type {Record<string, unknown>} */ (mapped)[key];
            const override = strategy[key];
            if (isRecordObject(base) && isRecordObject(override)) {
                merged[key] = { ...base, .../** @type {Record<string, unknown>} */ (override) };
            }
        }
        return /** @type {SchedulerConstructionOptions} */ (merged);
    }

    /**
     * The reload patch: the merged mapping restricted to the keys `applyConfig`
     * manages. A bound collaborator (`clock`, `workSource`, …) in the host's
     * pass-through options is construction-only and is refused by a patch.
     * @param {{mapped: SchedulerConstructionOptions}} arg0
     * @returns {Record<string, unknown>}
     */
    function reloadSchedulerOptions({ mapped }) {
        const merged = /** @type {Record<string, unknown>} */ (effectiveSchedulerOptions({ mapped }));
        return Object.fromEntries(Object.entries(merged).filter(([key]) => MANAGED_SCHEDULER_KEYS.includes(key)));
    }

    /**
     * Build the scheduler from one mapping plus the host's pass-through options.
     * @param {{mapped: SchedulerConstructionOptions}} arg0
     * @returns {WorkScheduler}
     */
    function buildScheduler({ mapped }) {
        const effective = effectiveSchedulerOptions({ mapped });
        builtFrom = effective;
        return new WorkScheduler({
            ...effective,
            workSource: /** @type {SchedulerConstructionOptions['workSource']} */ (workSource),
            workflow: /** @type {SchedulerConstructionOptions['workflow']} */ (runner),
            workspace,
            claims: options.claims ?? null,
            attemptStore: options.attemptStore,
            eventEmitter: emitter
        });
    }

    /**
     * Apply the live policy to the scheduler. Never gated on `changed`: the
     * watcher may already have consumed the edit. `applyConfig` reports
     * `applied: false` when nothing differs.
     * @returns {Promise<Record<string, unknown>|null>}
     */
    async function applyIfHealthy() {
        if (stopped || policy.snapshot().healthy !== true) return null;
        // Before start() there is nothing to patch: start() rebuilds from the
        // current mapping, so the first tick already sees this contract.
        if (currentScheduler().snapshot().started !== true) return null;
        const applied = await currentScheduler().applyConfig({
            options: reloadSchedulerOptions({ mapped: policyToSchedulerOptions({ policy }) }),
        });
        return applied;
    }

    /** A watcher-driven reload, not the host's own `reload()` call. */
    function onPolicyReloaded() {
        if (reloading) return;
        void applyIfHealthy().catch((error) => {
            // This path has no caller to receive a rejected patch, so without
            // this the scheduler stays on its old config while the operator
            // reports a healthy policy (F1-4). The ring records the notice.
            emitEvent({
                emitter,
                name: EVENTS.SCHEDULER.INTERNAL_ERROR,
                payload: { op: 'apply_config', ...errorFields({ error }) }
            });
        });
    }
    emitter.on(EVENTS.WORKFLOW_POLICY.RELOADED, onPolicyReloaded);

    /**
     * Close the operator server if `listen()` opened one. Idempotent.
     * @returns {Promise<void>}
     */
    async function close() {
        const server = openServer;
        openServer = null;
        if (server === null) return;
        await new Promise((resolve) => {
            server.close(() => resolve(undefined));
            // An idle keep-alive socket would otherwise hold the close open.
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        });
    }

    /**
     * Reload `WORKFLOW.md` and apply the scheduler-facing settings when the
     * reload is healthy. A broken edit keeps the last good config, applies
     * nothing, and blocks new dispatch through `preflight()`.
     * @returns {Promise<{changed: boolean, healthy: boolean, reasons: string[], applied: Record<string, unknown>|null}>}
     */
    async function reload() {
        if (stopped) return { changed: false, healthy: false, reasons: ['stopped'], applied: null };
        reloading = true;
        let result;
        try {
            result = await policy.reload();
        } finally {
            reloading = false;
        }
        const applied = await applyIfHealthy();
        return { ...result, applied };
    }

    /** @returns {Promise<void>} */
    async function start() {
        if (stopped) throw configurationError({ option: 'start', message: 'createOrchestration: this orchestration was stopped.' });
        // An edit made after construction but before the first tick would
        // otherwise run one tick on stale settings. Rebuild from the current
        // policy rather than applying after that tick.
        const current = policyToSchedulerOptions({ policy });
        if (!isDeepStrictEqual(effectiveSchedulerOptions({ mapped: current }), builtFrom)) {
            scheduler = buildScheduler({ mapped: current });
        }
        await currentScheduler().start();
    }

    /**
     * Stop in the order the system depends on: traffic, work, history, config.
     * @returns {Promise<{drained: boolean, running: number, retrying: number, parked: number}>}
     */
    async function stop() {
        stopped = true;
        emitter.off(EVENTS.WORKFLOW_POLICY.RELOADED, onPolicyReloaded);
        await close();
        const counts = await currentScheduler().stop();
        if (ring !== null) /** @type {{stop: Function}} */ (ring).stop();
        // Who started it decides who stops it: the facade stops a policy it
        // started (created, or injected-unstarted) and leaves a host-started
        // one running with its emitter handed back (F1-6 / W1-5).
        restorePolicyEmitter();
        if (policy.snapshot().stopped !== true && !policyStarted) policy.stop();
        return counts;
    }

    /**
     * Serve the operator handler on a loopback server the facade owns. Requires
     * `operator`, one live server at a time, and a system that has not stopped.
     * @param {{port?: number, host?: string}} [arg0]
     * @returns {Promise<{server: import('node:http').Server, url: string}>}
     */
    async function listen({ port = 0, host = '127.0.0.1' } = {}) {
        if (handler === null) {
            throw configurationError({
                option: 'operator',
                message: 'createOrchestration: operator is disabled; create it with operator: true to listen.'
            });
        }
        if (stopped) throw configurationError({ option: 'stopped', message: 'createOrchestration: a stopped system cannot listen.' });
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
            throw configurationError({ option: 'port', message: 'listen port must be an integer in 0..65535.' });
        }
        if (typeof host !== 'string' || host.trim() === '') {
            throw configurationError({ option: 'host', message: 'listen host must be a non-empty string.' });
        }
        // One server per orchestration: a second listen would orphan the first.
        await close();
        const { createServer } = await import('node:http');
        const server = createServer((req, res) => { void /** @type {Function} */ (handler)(req, res); });
        await new Promise((resolve, reject) => {
            /** @param {Error} error */
            const onError = (error) => reject(error);
            server.once('error', onError);
            server.listen(port, host, () => {
                server.off('error', onError);
                resolve(undefined);
            });
        });
        openServer = server;
        const address = server.address();
        const bound = typeof address === 'object' && address !== null ? address.port : port;
        return { server, url: `http://${host}:${bound}` };
    }

    const orchestration = {
        policy,
        workspace,
        get scheduler() { return currentScheduler(); },
        runner,
        emitter,
        ring,
        handler,
        reload,
        start,
        stop,
        listen,
        close
    };
    return /** @type {Orchestration} */ (orchestration);
}
