// @ts-check


/**
 * @file `WorkScheduler`: single-flight tick, dispatch, caps, settle, snapshot.
 * @version 0.12.0
 *
 * @description
 * The scheduler holds one claim for the whole continuous active life of an
 * item: retries, continuations, and parking never release it (AC7). The tick
 * is single-flight, reserves a slot synchronously before the awaited claim
 * (SCH-09), skips a full lane but stops the scan on a full global pool
 * (SCH-11), fails duplicate identifiers closed for the tick (AC19), and emits
 * `scheduler:tick` on every path with live `retrying`/`parked` counts (AC8).
 *
 * Stage 5 adds the settle dispositions: failure retries with capped backoff
 * (AC9), bounded continuation retries (AC10), reconciliation and the stall
 * watchdog (AC11/AC12), and parking (AC20). Stage 6 adds the duck-typed
 * workspace lifecycle: `ensure`/`beforeRun`/`afterRun` around one attempt,
 * terminal cleanup under the release disposition, and startup terminal
 * cleanup. Stage 8 adds the aggregate budget guard (§3.11/AC14).
 *
 * The budget is a **stop-new-work threshold**, not a reservation: an attempt
 * that was already running when the limit was crossed keeps running and its
 * spend still lands in the totals, so the aggregate can overshoot by that
 * attempt's own usage. `maxTotalUsd` is enforced only while every settled
 * attempt reported a finite cost (`costComplete`); `maxTotalTokens` is the
 * reliable guard because the runner always reports tokens. The guard is
 * checked only after an item is otherwise dispatchable and a slot is free, so
 * a full pool or an ineligible item never trips it. `scheduler:budget_exhausted`
 * is emitted **once per scheduler lifetime**: raising a limit later resumes
 * dispatch without a second event, because the operator already has the fact.
 * The scheduler never imports `lib/agentic/workspace/*`.
 *
 * Stage P3b adds the attempt store: `start()` hydrates `#attempts`,
 * `#continuations`, and `#parked` from it, and every state change that matters
 * persists the record. A queued retry is never persisted (it is transient by
 * design), so a crash mid-retry re-queues the item with its failure count
 * intact. An attempt writes an `inFlight` marker before it starts, and a marker
 * left behind at hydration counts as one consumed `unknown` failure, so a
 * process that dies mid-attempt cannot reset the retry budget (F2-2). Each tick
 * also heartbeats every claim this scheduler holds — running, retrying, or
 * parked — so a claim outlives `claim_stale_ms` only when its owner stopped
 * (F2-7).
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { ConfigurationError, SchedulerError } from '../../core/errors.mjs';
import { EVENTS, RunContext, emitEvent, runWithRunContext } from '../../core/events.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { FailureClass, classifyFailure } from '../loops/index.mjs';
import { ATTEMPT_RECORD_VERSION, createMemoryAttemptStore } from './attempt-store.mjs';
import { activateClaimOwner, createMemoryClaimStore, deactivateClaimOwner } from './claims.mjs';
import { sortForDispatch } from './normalize.mjs';
import { classifyRefresh } from './reconcile.mjs';
import { accumulateUsage, buildSnapshot, createTotals, projectUsage, SCHEDULER_DEFAULTS, workThreadId } from './state.mjs';
import { failureEvidence, normalizeRunResult, retryDelayMs, errorFields } from './retry.mjs';
import { collectDuplicateIdentifiers, validateSchedulerConfig } from './validate.mjs';
import { isRecordObject } from '../../support/validation.mjs';
import {
    MANAGED_KEYS,
    changedSchedulerKeys,
    hasGlobalSlot,
    hasLaneSlot,
    isSchedulerItemRoutable,
    mergeSchedulerConfig,
    schedulerBudgetLimit,
    schedulerBudgetTotals,
    shouldDispatchSchedulerItem
} from './policy.mjs';

export { MANAGED_KEYS } from './policy.mjs';

/** @typedef {import('./normalize.mjs').WorkItem} WorkItem */
/** @typedef {import('./claims.mjs').ClaimStore} ClaimStore */
/** @typedef {import('./attempt-store.mjs').AttemptStore} AttemptStore */
/** @typedef {import('./state.mjs').Totals} Totals */
/** @typedef {import('./retry.mjs').NormalizedRunResult} NormalizedRunResult */

/**
 * @typedef {Object} SchedulerClock
 * @property {() => number} now
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/**
 * A minimal emitter shape `emitEvent` accepts (it only needs `emit`).
 * @typedef {Object} SchedulerEmitter
 * @property {(name: string, payload: Record<string, unknown>) => void} emit
 */

/**
 * The read-only work-source contract (§3.4). The adapters may return
 * synchronously or as a promise; the scheduler awaits both.
 * @typedef {Object} SchedulerWorkSource
 * @property {(arg0: {states: string[], signal?: AbortSignal}) => ReadonlyArray<WorkItem>|Promise<ReadonlyArray<WorkItem>>} fetchByStates
 * @property {(arg0: {ids: string[], signal?: AbortSignal}) => ReadonlyArray<WorkItem>|Promise<ReadonlyArray<WorkItem>>} fetchByIds
 */

/**
 * The one-attempt workflow runner.
 * @typedef {Object} SchedulerWorkflow
 * @property {(arg0: {
 *   item: WorkItem,
 *   attempt: number,
 *   continuation?: boolean,
 *   workspace: Record<string, unknown>|null,
 *   signal: AbortSignal,
 *   runContext: RunContext,
 *   reportProgress: () => void,
 *   threadId: string
 * }) => unknown} run
 */

/**
 * The duck-typed workspace contract (§3.9). The scheduler never imports the
 * workspace module; a test or a host passes the real manager. `ownerId` is the
 * real item id: the key derives from the identifier, which a tracker can
 * recycle, so the workspace marker needs the provider id to tell two items
 * apart (W1-2).
 * @typedef {Object} SchedulerWorkspaceManager
 * @property {(arg0: {workItemId: string, identifier?: string, ownerId?: string|number, signal?: AbortSignal}) => Promise<Record<string, unknown>>} ensure
 * @property {(arg0: {workspace: Record<string, unknown>, signal?: AbortSignal}) => Promise<unknown>} beforeRun
 * @property {(arg0: {workspace: Record<string, unknown>, outcome: string, signal?: AbortSignal}) => Promise<unknown>} afterRun
 * @property {(arg0: {workspace: Record<string, unknown>, force?: boolean}) => Promise<{removed?: boolean, reason?: string}|null|undefined>} remove
 * @property {(arg0: {workItemId: string, identifier?: string}) => Record<string, unknown>} handleFor
 */

/**
 * @typedef {Object} SchedulerConfig
 * @property {SchedulerWorkSource} workSource
 * @property {SchedulerWorkflow} workflow
 * @property {SchedulerWorkspaceManager|null} workspace
 * @property {ClaimStore} claims
 * @property {AttemptStore|null} attemptStore
 * @property {SchedulerClock} clock
 * @property {SchedulerEmitter|null} eventEmitter
 * @property {AbortSignal|null} signal
 * @property {string[]} activeStates
 * @property {string[]} terminalStates
 * @property {string[]} requiredLabels
 * @property {Function|null} filter
 * @property {Function|null} preflight
 * @property {{global: number, byLane?: Record<string, number>}} concurrency
 * @property {{baseMs: number, maxMs: number}} retry
 * @property {{delayMs: number, max: number}} continuation
 * @property {{maxAttemptsPerItem: number, maxDispatches?: number|null, maxTotalTokens?: number|null, maxTotalUsd?: number|null}} limits
 * @property {number} pollIntervalMs
 * @property {number} stallTimeoutMs
 * @property {boolean} startupCleanup
 * @property {boolean} allowSharedWorkspace
 * @property {string} hostId
 */

/**
 * One running attempt. The scheduler keys its running map by `identifier`, the
 * stable external key, while events also carry the provider's `item.id`.
 * @typedef {Object} SchedulerEntry
 * @property {string} id
 * @property {string} identifier
 * @property {WorkItem} item
 * @property {number} attempt
 * @property {'failure'|'continuation'|null} kind
 * @property {string} lane
 * @property {number} startedAt
 * @property {number} lastProgressAt
 * @property {AbortController} controller
 * @property {RunContext} runContext
 * @property {Disposition|null} disposition
 * @property {Record<string, unknown>|null} workspace
 * @property {boolean} prepared
 * @property {string} threadId
 * @property {Promise<void>|null} promise
 */

/**
 * The settle decision written before an abort so `onSettled` honors it: a
 * stall retries, a reconciliation releases, and a stop never retries.
 * @typedef {{type: 'retry', reason: string}|{type: 'release', reason: string, cleanup: boolean}|{type: 'park', reason: string}|{type: 'stop'}} Disposition
 */

/**
 * One queued retry, keyed by `identifier`. `attempt` is the attempt number the
 * retried run receives; `kind` distinguishes a failure retry from a
 * continuation. A source-error or no-slot re-queue keeps the same `attempt`.
 * @typedef {Object} RetryEntry
 * @property {string} identifier
 * @property {WorkItem} item
 * @property {number} attempt
 * @property {number} dueAtMs
 * @property {number} delayMs
 * @property {'failure'|'continuation'} kind
 * @property {string|null} errorName
 * @property {string|null} errorCode
 */

/**
 * One parked item. It keeps its claim until reconciliation, `resetItem()`, or
 * `stop()`; each due check extends `nextCheckAt`.
 * @typedef {Object} ParkedEntry
 * @property {string} identifier
 * @property {WorkItem} item
 * @property {string} reason
 * @property {number} since
 * @property {number} nextCheckAt
 * @property {number} checks
 * @property {number} attempts
 * @property {number} continuations
 */

/**
 * The construction options from §3.1. Every field is optional except the two
 * bound collaborators; validation happens in `start()`, not here.
 * @typedef {Object} SchedulerOptions
 * @property {SchedulerWorkSource} [workSource]
 * @property {SchedulerWorkflow} [workflow]
 * @property {SchedulerWorkspaceManager|null} [workspace]
 * @property {ClaimStore|'memory'|null} [claims]
 * @property {AttemptStore|'memory'|null} [attemptStore]
 * @property {SchedulerClock|null} [clock]
 * @property {SchedulerEmitter|null} [eventEmitter]
 * @property {AbortSignal|null} [signal]
 * @property {string[]} [activeStates]
 * @property {string[]} [terminalStates]
 * @property {string[]} [requiredLabels]
 * @property {Function|null} [filter]
 * @property {Function|null} [preflight]
 * @property {{global?: number, byLane?: Record<string, number>}|null} [concurrency]
 * @property {{baseMs?: number, maxMs?: number}|null} [retry]
 * @property {{delayMs?: number, max?: number}|null} [continuation]
 * @property {{maxAttemptsPerItem?: number, maxDispatches?: number|null, maxTotalTokens?: number|null, maxTotalUsd?: number|null}|null} [limits]
 * @property {number} [pollIntervalMs]
 * @property {number} [stallTimeoutMs]
 * @property {boolean} [startupCleanup]
 * @property {boolean} [allowSharedWorkspace]
 * @property {string} [hostId]
 */

/** @type {ReadonlyArray<string>} */
const BOUND_KEYS = Object.freeze([
    'workSource',
    'workflow',
    'workspace',
    'claims',
    'attemptStore',
    'clock',
    'eventEmitter',
    'signal'
]);

/** Failure classes the scheduler never retries: they park on the first failure. @type {Set<string>} */
const NON_RETRYABLE_FAILURE_CLASSES = new Set([
    FailureClass.PERMISSION_BLOCK,
    FailureClass.ENVIRONMENT_MISMATCH,
    FailureClass.INVALID_WORKFLOW
]);

/**
 * The `category` of a work-source failure, or null when the throw is not a
 * typed source error. Only the category string is diagnostic.
 * @param {{error: unknown}} arg0 -
 * @returns {string|null}
 */
function workSourceCategory({ error }) {
    if (!isRecordObject(error)) return null;
    const record = /** @type {Record<string, unknown>} */ (error);
    try {
        return typeof record.category === 'string' ? record.category : null;
    } catch {
        return null;
    }
}

/**
 * Project usage to its numeric fields through the one usage reader, so an event
 * payload and the totals agree on both spellings. Event payloads carry numbers
 * only, and a hostile getter is skipped instead of rejecting the settle.
 * @param {{usage: unknown}} arg0 -
 * @returns {Record<string, number>|null}
 */
function numericUsage({ usage }) {
    const projected = projectUsage({ usage });
    if (projected === null) return null;
    /** @type {Record<string, number>} */
    const out = {};
    if (projected.tokensReported) out.total_tokens = projected.totalTokens;
    if (projected.inputTokens !== null) out.input_tokens = projected.inputTokens;
    if (projected.outputTokens !== null) out.output_tokens = projected.outputTokens;
    if (projected.costUsd !== null) out.cost_usd = projected.costUsd;
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * The work-item scheduler: claims, dispatch, retries, parking, and a
 * single-flight tick. One claim is held for an item's continuous active life;
 * construction stores the options and `start()` validates and arms the loop.
 */
export class WorkScheduler {
    /** @type {SchedulerConfig} */
    #config;
    /** @type {ClaimStore} */
    #claims;
    #owner;
    #runCtx = new RunContext();

    /**
     * The outcome of the most recent tick (`ok`, `validation_error`, …). It is
     * in the snapshot so an operator can tell an idle scheduler from one that
     * is blocked — a policy-blocked system and a quiet system otherwise look
     * identical.
     * @type {string|null}
     */
    #lastOutcome = null;
    /** @type {Map<string, SchedulerEntry>} */
    #running = new Map();
    /** @type {Map<string, string>} */
    #claiming = new Map();
    /** @type {Set<string>} */
    #claimed = new Set();
    /** Identifiers cancelled during a dispatch/retry-refresh window, applied before the attempt starts. */
    #cancelRequested = new Set();
    /** Identifiers whose due retry is being refreshed; a cancel here is deferred, not refused. */
    #refreshing = new Set();
    /** @type {Map<string, WorkItem>} */
    #claimItems = new Map();
    /** @type {Map<string, RetryEntry>} */
    #retries = new Map();
    /** @type {Map<string, number>} Failures in the current claim lifetime. */
    #attempts = new Map();
    /** @type {Map<string, number>} Continuations in the current claim lifetime. */
    #continuations = new Map();
    /** @type {Map<string, ParkedEntry>} */
    #parked = new Map();
    /** In-flight attempt-store writes, one tail per identifier. @type {Map<string, Promise<void>>} */
    #pendingWrites = new Map();
    /** In-flight hydration per identifier, so a host reset can serialize behind it. @type {Map<string, Promise<void>>} */
    #hydrating = new Map();
    /** Identifiers a host reset touched while hydration could still adopt them. @type {Set<string>} */
    #hostTouched = new Set();
    /** Hydration passes in flight; the last one out clears the touched markers. */
    #hydrationPasses = 0;
    /** @type {Set<string>} */
    #completed = new Set();
    /** @type {Totals} */
    #totals = createTotals();
    /** @type {unknown} */
    #tickTimer = null;
    #ticking = false;
    #starting = false;
    #started = false;
    #stopped = false;
    #stopReason = 'stopped';
    /** Once per scheduler lifetime (§3.11): raising a limit does not re-emit. */
    #budgetEmitted = false;
    #tickCount = 0;
    /** @type {number|null} */
    #lastTickAt = null;
    /** @type {Record<string, unknown>|null} */
    #pendingConfig = null;

    /**
     * Construct only; `start()` validates and arms the loop. Construction never
     * touches the work source, the claim store, or a timer.
     * @param {SchedulerOptions} [arg0] -
     */
    constructor({
        workSource,
        workflow,
        workspace = null,
        claims = null,
        attemptStore = createMemoryAttemptStore(),
        clock = null,
        eventEmitter = null,
        signal = null,
        activeStates = [],
        terminalStates = [],
        requiredLabels = [],
        filter = null,
        preflight = null,
        concurrency = null,
        retry = null,
        continuation = null,
        limits = null,
        pollIntervalMs = SCHEDULER_DEFAULTS.pollIntervalMs,
        stallTimeoutMs = SCHEDULER_DEFAULTS.stallTimeoutMs,
        startupCleanup = true,
        allowSharedWorkspace = false,
        hostId = hostname()
    } = {}) {
        this.#claims = claims === null || claims === undefined || claims === 'memory' ? createMemoryClaimStore() : claims;
        const resolvedClock = clock ?? /** @type {SchedulerClock} */ ({
            now: () => Date.now(),
            setTimeout: (/** @type {[() => void, number]} */ ...args) => setTimeout(...args),
            clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle))
        });
        this.#owner = `${hostId}:${process.pid}:${randomUUID()}`;
        this.#config = {
            workSource: /** @type {SchedulerWorkSource} */ (workSource),
            workflow: /** @type {SchedulerWorkflow} */ (workflow),
            workspace,
            claims: this.#claims,
            attemptStore: attemptStore === 'memory' ? createMemoryAttemptStore() : attemptStore,
            clock: resolvedClock,
            eventEmitter,
            signal,
            activeStates,
            terminalStates,
            requiredLabels,
            filter,
            preflight,
            concurrency: {
                global: SCHEDULER_DEFAULTS.concurrency.global,
                ...(concurrency ?? {})
            },
            retry: { ...SCHEDULER_DEFAULTS.retry, ...(retry ?? {}) },
            continuation: { ...SCHEDULER_DEFAULTS.continuation, ...(continuation ?? {}) },
            limits: { ...SCHEDULER_DEFAULTS.limits, ...(limits ?? {}) },
            pollIntervalMs,
            stallTimeoutMs,
            startupCleanup,
            allowSharedWorkspace,
            hostId
        };
    }

    /**
     * Emit one scheduler/domain event through the configured emitter.
     * @param {{name: string, payload: Record<string, unknown>, runContext?: RunContext}} arg0 -
     * @returns {void}
     */
    #emit({ name, payload, runContext = this.#runCtx }) {
        emitEvent({
            emitter: /** @type {import('node:events').EventEmitter|null} */ (/** @type {unknown} */ (this.#config.eventEmitter)),
            name,
            payload,
            runContext
        });
    }

    /**
     * @param {{op: string, error: unknown}} arg0 -
     * @returns {void}
     */
    #emitInternalError({ op, error }) {
        const { errorName, errorCode } = errorFields({ error });
        this.#emit({ name: EVENTS.SCHEDULER.INTERNAL_ERROR, payload: { op, errorName, errorCode } });
    }

    /**
     * Persist the counters, park row, and crash marker for one identifier. A
     * store failure is diagnostic: the in-memory scheduler keeps running on its
     * own state. `inFlight` is written as given and defaults to null, so any
     * persist without a marker also clears one a crash could leave behind.
     * @param {{identifier: string, id: string, inFlight?: {attemptId: string, startedAt: number}|null}} arg0 -
     * @returns {Promise<void>}
     */
    async #persistAttempt({ identifier, id, inFlight = null }) {
        const store = this.#config.attemptStore;
        if (store === null) return;
        const parked = this.#parked.get(identifier);
        await this.#enqueueAttemptWrite({
            identifier,
            op: 'persist_attempt',
            run: () => store.save({
                record: {
                    version: ATTEMPT_RECORD_VERSION,
                    identifier,
                    id,
                    attempts: this.#attempts.get(identifier) ?? 0,
                    continuations: this.#continuations.get(identifier) ?? 0,
                    parked: parked === undefined
                        ? null
                        : { reason: parked.reason, at: parked.since, nextCheckAt: parked.nextCheckAt },
                    inFlight: inFlight ?? null,
                    updatedAt: this.#now()
                }
            })
        });
    }

    /**
     * Drop one identifier's persisted state. Same failure policy as
     * `#persistAttempt`: diagnostics never fail the lifecycle step.
     * @param {{identifier: string}} arg0 -
     * @returns {Promise<void>}
     */
    async #clearAttempt({ identifier }) {
        const store = this.#config.attemptStore;
        if (store === null) return;
        // Chained after any in-flight save for this identifier, so a clear can
        // never be overtaken and resurrect a park.
        await this.#enqueueAttemptWrite({
            identifier,
            op: 'clear_attempt',
            run: () => store.clear({ identifier })
        });
    }

    /**
     * The per-identifier write chain. `stop()` flushes every tail, and a
     * `resetItem` clear is ordered behind a save that is still in flight.
     * A write error is an event, never a thrown tick.
     * @param {{identifier: string, op: string, run: () => Promise<void>}} arg0 -
     * @returns {Promise<void>}
     */
    async #enqueueAttemptWrite({ identifier, op, run }) {
        const previous = this.#pendingWrites.get(identifier) ?? Promise.resolve();
        const current = previous
            .then(run, run)
            .catch((error) => {
                try {
                    this.#emitInternalError({ op, error });
                } catch {
                    // A hostile emitter must not reject the write chain.
                }
            })
            .finally(() => {
                if (this.#pendingWrites.get(identifier) === current) this.#pendingWrites.delete(identifier);
            });
        this.#pendingWrites.set(identifier, current);
        await current;
    }

    /**
     * Wait for every in-flight attempt-store write. Stop calls this after the
     * attempt drain, so a caller may safely exit the process once `stop()`
     * resolves.
     * @returns {Promise<void>}
     */
    async #flushAttemptWrites() {
        while (this.#pendingWrites.size > 0) {
            await Promise.allSettled([...this.#pendingWrites.values()]);
        }
    }

    /**
     * Emit one tick event. Every path carries live counts: `fetched` and
     * `dispatched` belong to this tick, while `running`, `retrying`, `parked`,
     * and `claimed` are current at emission time.
     * @param {{outcome: string, fetched?: number, dispatched?: number}} arg0 -
     * @returns {void}
     */
    #emitTick({ outcome, fetched = 0, dispatched = 0 }) {
        this.#lastOutcome = outcome;
        this.#emit({
            name: EVENTS.SCHEDULER.TICK,
            payload: {
                outcome,
                fetched,
                dispatched,
                running: this.#running.size,
                retrying: this.#retries.size,
                parked: this.#parked.size,
                claimed: this.#claimed.size
            }
        });
    }

    /** @returns {number} */
    #now() {
        return this.#config.clock.now();
    }

    /**
     * Recent completed-item bookkeeping only; `#completed` never gates
     * dispatch (Q3). Bounded so a long-lived process cannot grow the set
     * without limit: the oldest identifier by insertion order is dropped.
     * @param {{identifier: string}} arg0 -
     * @returns {void}
     */
    #rememberCompleted({ identifier }) {
        this.#completed.add(identifier);
        while (this.#completed.size > LIMITS.scheduler_completed_history_limit) {
            const oldest = this.#completed.values().next().value;
            if (oldest === undefined) break;
            this.#completed.delete(oldest);
        }
    }

    /**
     * The merged `applyConfig` patch is applied at the start of a tick, never
     * mid-tick (AC23). A patch that no longer validates is dropped with a typed
     * event instead of poisoning the loop.
     * @returns {void}
     */
    #applyPendingConfig() {
        if (this.#pendingConfig === null) return;
        const patch = this.#pendingConfig;
        this.#pendingConfig = null;
        const merged = this.#mergeConfig({ current: this.#config, patch });
        const errors = validateSchedulerConfig({ options: /** @type {Record<string, unknown>} */ (merged) });
        if (errors.length > 0) {
            this.#emitInternalError({ op: 'apply_config', error: { name: 'ConfigurationError' } });
            return;
        }
        const changed = this.#changedKeys({ current: this.#config, patch, merged });
        this.#config = merged;
        if (changed.length > 0) {
            this.#emit({ name: EVENTS.SCHEDULER.CONFIGURED, payload: { source: 'reload', changed } });
        }
    }

    /**
     * @param {{current: SchedulerConfig, patch: Record<string, unknown>}} arg0 -
     * @returns {SchedulerConfig}
     */
    #mergeConfig({ current, patch }) {
        return /** @type {SchedulerConfig} */ (mergeSchedulerConfig({ current: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (current)), patch }));
    }

    /**
     * @param {{current: SchedulerConfig, patch: Record<string, unknown>, merged: SchedulerConfig}} arg0 -
     * @returns {string[]}
     */
    #changedKeys({ current, patch, merged }) {
        return changedSchedulerKeys({
            current: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (current)),
            patch,
            merged: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (merged))
        });
    }

    /**
     * Clear and re-arm the poll timer. Only the tick `finally` and `applyConfig`
     * call this; a stopped scheduler is a no-op.
     * @returns {void}
     */
    #scheduleNext() {
        if (this.#tickTimer !== null) {
            this.#config.clock.clearTimeout(this.#tickTimer);
            this.#tickTimer = null;
        }
        if (this.#stopped) return;
        const handle = this.#config.clock.setTimeout(() => {
            this.tick().catch(() => {});
        }, this.#config.pollIntervalMs);
        if (isRecordObject(handle) && typeof (/** @type {Record<string, unknown>} */ (handle)).unref === 'function') {
            (/** @type {{unref: () => void}} */ (handle)).unref();
        }
        this.#tickTimer = handle;
    }

    /**
     * @param {{timeoutMs: number, promise: Promise<boolean>}} arg0 -
     * @returns {Promise<boolean>}
     */
    async #raceTimeout({ timeoutMs, promise }) {
        /** @type {unknown} */
        let handle = null;
        const timeout = new Promise((resolve) => {
            handle = this.#config.clock.setTimeout(() => resolve(false), timeoutMs);
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (handle !== null) this.#config.clock.clearTimeout(handle);
        }
    }

    /**
     * Whether the global pool has a free slot. `#claiming` is reserved before
     * the claim await, so no concurrent item can overshoot.
     * @returns {boolean}
     */
    #globalSlot() {
        return hasGlobalSlot({ running: this.#running.size, claiming: this.#claiming.size, limit: this.#config.concurrency.global });
    }

    /**
     * Whether the lane has a free slot. An unlisted lane is governed by the
     * global pool only.
     * @param {{lane: string}} arg0 -
     * @returns {boolean}
     */
    #laneSlot({ lane }) {
        return hasLaneSlot({ lane, running: this.#running, claiming: this.#claiming, byLane: this.#config.concurrency.byLane });
    }

    /**
     * The budget limit that blocks a new dispatch, or null (§3.11). `dispatches`
     * counts every successful start, retries and continuations included.
     * `maxTotalTokens` is the reliable guard and does not depend on
     * `usageComplete`; `maxTotalUsd` is inert until every settled attempt
     * reported a finite cost, because a partial sum cannot prove the limit.
     * @returns {'maxDispatches'|'maxTotalTokens'|'maxTotalUsd'|null}
     */
    #budgetLimit() {
        return schedulerBudgetLimit({ limits: this.#config.limits, totals: this.#totals });
    }

    /** The budget payload's totals: a plain copy without `secondsRunning`. */
    #budgetTotals() {
        return schedulerBudgetTotals({ totals: this.#totals });
    }

    /**
     * Whether the aggregate budget blocks a dispatch that would otherwise
     * happen. Emits `scheduler:budget_exhausted` at most once per scheduler
     * lifetime; never aborts a running attempt and never stops reconciliation,
     * parked re-checks, or retry fetching, because reaping spends nothing.
     * @returns {boolean} True when new dispatch must stop.
     */
    #budgetExhausted() {
        const limit = this.#budgetLimit();
        if (limit === null) return false;
        if (!this.#budgetEmitted) {
            this.#budgetEmitted = true;
            this.#emit({
                name: EVENTS.SCHEDULER.BUDGET_EXHAUSTED,
                payload: { limit, totals: this.#budgetTotals() }
            });
        }
        return true;
    }

    /**
     * The base queue delay, used wherever a retry is re-queued without
     * consuming the item's attempt budget (a source error, a full pool, or the
     * budget guard). Keeping one function is what makes those paths agree.
     * @returns {number}
     */
    #baseRetryDelay() {
        return retryDelayMs({ attempt: 1, baseMs: this.#config.retry.baseMs, maxMs: this.#config.retry.maxMs });
    }

    /**
     * Whether the item passes the dispatch-facing guards: `dispatchable`,
     * required labels, and the host filter. Deliberately ignores claims, caps,
     * running state, and the item's state so reconciliation can ask "would the
     * scan dispatch this if a slot were free?" (§3.8).
     * @param {{item: WorkItem}} arg0 -
     * @returns {boolean}
     */
    #isRoutable({ item }) {
        return isSchedulerItemRoutable({ item, requiredLabels: this.#config.requiredLabels, filter: this.#config.filter, filterReceiver: this.#config });
    }

    /**
     * The eligibility matrix from AC5. Caps are checked here as well as in the
     * scan, because a caller-side item could otherwise bypass them.
     * @param {{item: WorkItem}} arg0 -
     * @returns {boolean}
     */
    #shouldDispatch({ item }) {
        return shouldDispatchSchedulerItem({
            item,
            activeStates: this.#config.activeStates,
            terminalStates: this.#config.terminalStates,
            requiredLabels: this.#config.requiredLabels,
            filter: this.#config.filter,
            filterReceiver: this.#config,
            running: this.#running,
            claiming: this.#claiming,
            claimed: this.#claimed,
            parked: this.#parked,
            attempts: this.#attempts,
            maxAttemptsPerItem: this.#config.limits.maxAttemptsPerItem,
            concurrency: this.#config.concurrency
        });
    }

    /**
     * Claim the item and start one attempt. The slot is reserved synchronously;
     * a failed or throwing claim skips the item for this tick. Policy health is
     * re-read here, not only at the top of the tick: an edit that breaks
     * `preflight()` mid-tick must not dispatch an attempt that renders the new
     * prompt under the old config (F1-3).
     *
     * The three outcomes are distinct on purpose: a retry that is refused must
     * not be mistaken for a lost claim (W1-9) — no claim was taken, so nothing
     * is released and the attempt keeps its number.
     * @param {{item: WorkItem, attempt: number|null, lane: string, kind?: 'failure'|'continuation'|null}} arg0 -
     * @returns {Promise<'started'|'preflight'|'failed'>} How the claim ended.
     */
    async #claimAndStart({ item, attempt, lane, kind = null }) {
        const identifier = item.identifier;
        let preflightErrors;
        try {
            preflightErrors = this.#preflightErrors();
        } catch (error) {
            this.#emitInternalError({ op: 'preflight', error });
            this.#emit({
                name: EVENTS.WORK_ITEM.CLAIM_FAILED,
                payload: { workItemId: item.id, identifier, reason: 'preflight' }
            });
            return 'preflight';
        }
        if (preflightErrors.length > 0) {
            this.#emit({
                name: EVENTS.WORK_ITEM.CLAIM_FAILED,
                payload: { workItemId: item.id, identifier, reason: 'preflight' }
            });
            return 'preflight';
        }
        this.#claiming.set(identifier, lane);
        let acquired = false;
        try {
            acquired = await this.#claims.acquire({
                workItemId: identifier,
                owner: this.#owner,
                now: this.#now()
            });
        } catch {
            this.#claiming.delete(identifier);
            this.#emit({
                name: EVENTS.WORK_ITEM.CLAIM_FAILED,
                payload: { workItemId: item.id, identifier, reason: 'error' }
            });
            return 'failed';
        }
        if (acquired !== true) {
            this.#claiming.delete(identifier);
            this.#emit({
                name: EVENTS.WORK_ITEM.CLAIM_FAILED,
                payload: { workItemId: item.id, identifier, reason: 'not_acquired' }
            });
            return 'failed';
        }
        this.#claiming.delete(identifier);
        // Register before the stop check so the acquired claim has exactly one
        // owner for its release; nothing awaits between here and the stop test.
        const newlyClaimed = !this.#claimed.has(identifier);
        if (newlyClaimed) {
            this.#claimed.add(identifier);
            this.#claimItems.set(identifier, item);
        }
        if (this.#stopped) {
            await this.#releaseClaim({ identifier, reason: this.#stopReason, keepAttempt: true });
            return 'failed';
        }
        if (this.#cancelRequested.delete(identifier)) {
            await this.#park({ entry: { identifier, item }, reason: 'canceled' });
            return 'failed';
        }
        const now = this.#now();
        // The marker is durable before the effect: a process that dies mid-attempt
        // leaves it behind, and the next start counts it as one failure (F2-2).
        await this.#persistAttempt({
            identifier,
            id: item.id,
            inFlight: { attemptId: randomUUID(), startedAt: now }
        });
        /** @type {SchedulerEntry} */
        const entry = {
            id: identifier,
            identifier,
            item,
            attempt: attempt ?? 1,
            kind,
            lane,
            startedAt: now,
            lastProgressAt: now,
            controller: new AbortController(),
            runContext: RunContext.child(this.#runCtx),
            disposition: null,
            workspace: null,
            prepared: false,
            threadId: workThreadId({ identifier }),
            promise: null
        };
        this.#running.set(identifier, entry);
        // Start the attempt before the dispatch events: a host emitter that
        // throws can then never leave a claimed, running entry with no promise
        // to settle it. The settle runs in a later microtask, so the events
        // still precede it.
        entry.promise = Promise.resolve(this.#runAttempt({ entry })).then(
            (result) => this.#onSettled({ entry, result }),
            (error) => this.#onSettled({ entry, result: normalizeRunResult({ error, signal: entry.controller.signal }) })
        );
        if (newlyClaimed) {
            this.#emit({
                name: EVENTS.WORK_ITEM.CLAIMED,
                payload: { workItemId: item.id, identifier, attempt: entry.attempt, owner: this.#owner }
            });
        }
        this.#totals.dispatches += 1;
        this.#emit({
            name: EVENTS.WORK_ITEM.DISPATCHED,
            runContext: entry.runContext,
            payload: {
                workItemId: item.id,
                identifier,
                attempt: entry.attempt,
                lane,
                state: item.state,
                priority: item.priority,
                runId: entry.runContext.runId
            }
        });
        return 'started';
    }

    /**
     * One attempt (§3.7/§3.9). `ensure` and `beforeRun` precede the workflow;
     * `afterRun` runs only when `beforeRun` succeeded, always after the
     * workflow, and its failure never fails the attempt (SCH-24). An `ensure`
     * or `beforeRun` throw is an ordinary attempt failure, so it retries.
     * @param {{entry: SchedulerEntry}} arg0 -
     * @returns {Promise<NormalizedRunResult>}
     */
    async #runAttempt({ entry }) {
        const reportProgress = () => {
            entry.lastProgressAt = this.#now();
        };
        const workspace = this.#config.workspace;
        const signal = entry.controller.signal;
        /** @type {string} */
        let outcome = 'failed';
        try {
            if (workspace !== null && workspace !== undefined) {
                // The workspace emits its own events; running them under this
                // attempt's context is what joins `workspace:*` to the
                // `work_item:dispatched` that caused it.
                entry.workspace = /** @type {Record<string, unknown>} */ (await runWithRunContext({
                    runContext: entry.runContext,
                    // The key is the identifier, but the owner is the item: a
                    // recycled identifier must not inherit the old workspace.
                    fn: () => workspace.ensure({
                        workItemId: entry.identifier,
                        identifier: entry.identifier,
                        ownerId: entry.item.id,
                        signal
                    })
                }));
                await runWithRunContext({
                    runContext: entry.runContext,
                    fn: () => workspace.beforeRun({
                        workspace: /** @type {Record<string, unknown>} */ (entry.workspace),
                        signal
                    })
                });
                entry.prepared = true;
            }
            const result = normalizeRunResult({
                result: /** @type {Record<string, unknown>|null} */ (await this.#config.workflow.run({
                    item: entry.item,
                    attempt: entry.attempt,
                    // The prompt maps this to its retry index: a continuation runs
                    // as attempt 1 but is not a first run (F1-5/F2-8).
                    continuation: entry.kind === 'continuation',
                    workspace: entry.workspace,
                    signal,
                    runContext: entry.runContext,
                    reportProgress,
                    threadId: /** @type {string} */ (entry.threadId)
                })),
                signal
            });
            outcome = result.status;
            return result;
        } catch (error) {
            const result = normalizeRunResult({ error, signal });
            outcome = result.status;
            return result;
        } finally {
            if (workspace !== null && workspace !== undefined && entry.prepared) {
                try {
                    await runWithRunContext({
                        runContext: entry.runContext,
                        fn: () => workspace.afterRun({
                            workspace: /** @type {Record<string, unknown>} */ (entry.workspace),
                            outcome,
                            signal
                        })
                    });
                } catch {
                    // SCH-24: afterRun failures never fail the attempt.
                }
            }
        }
    }

    /**
     * The one refusal rule shared by settle cleanup and startup cleanup: only
     * `removed === false` with a string reason other than `missing` counts; an
     * absent path is not a refusal (§3.9).
     * @param {{result: {removed?: boolean, reason?: string}|null|undefined, workItemId: string, identifier: string, runContext?: RunContext}} arg0 -
     * @returns {void}
     */
    #emitCleanupRefusal({ result, workItemId, identifier, runContext }) {
        const reason = result?.reason;
        if (result?.removed !== false || typeof reason !== 'string' || reason === 'missing') return;
        this.#emit({
            name: EVENTS.WORK_ITEM.WORKSPACE_CLEANUP_REFUSED,
            runContext,
            payload: { workItemId, identifier, reason }
        });
    }

    /**
     * Best-effort terminal cleanup (§3.9): `force: false`, never retried. A
     * refusal other than `missing` is reported; an absent path is not a
     * refusal. `workspace` is the running entry's handle when one exists;
     * `handleFor` is the pure fallback for an item this process never ensured
     * (a retry fire, a parked check, or startup cleanup).
     * @param {{identifier: string, item: WorkItem, workspace?: Record<string, unknown>|null, runContext?: RunContext}} arg0 -
     * @returns {Promise<void>}
     */
    async #cleanupWorkspace({ identifier, item, workspace = null, runContext = undefined }) {
        const manager = this.#config.workspace;
        if (manager === null || manager === undefined) return;
        /** @type {Record<string, unknown>} */
        let handle;
        try {
            handle = workspace ?? manager.handleFor({ workItemId: identifier, identifier });
        } catch (error) {
            this.#emitInternalError({ op: 'cleanup', error });
            return;
        }
        /** @type {{removed?: boolean, reason?: string}|null|undefined} */
        let result;
        try {
            result = await runWithRunContext({
                runContext: runContext ?? this.#runCtx,
                fn: () => manager.remove({ workspace: handle, force: false })
            });
        } catch (error) {
            this.#emitInternalError({ op: 'cleanup', error });
            return;
        }
        this.#emitCleanupRefusal({
            result,
            workItemId: item.id,
            identifier,
            runContext
        });
    }

    /**
     * Release one claim exactly once, ignoring the store's boolean. The
     * identifier is removed from the in-process set before the claim-store
     * await, so a `stop()` racing a settle cannot release the same claim twice.
     * A release for an identifier this scheduler does not own is a no-op unless
     * `forceClear` names a lifetime end with no claim (a hydrated parked row or
     * `resetItem`). `keepAttempt` is for a stop, which releases the claim but
     * must leave the persisted counters and park row for the next process.
     * @param {{identifier: string, reason: string, runContext?: RunContext, keepAttempt?: boolean, forceClear?: boolean}} arg0 -
     * @returns {Promise<void>}
     */
    async #releaseClaim({ identifier, reason, runContext = this.#runCtx, keepAttempt = false, forceClear = false }) {
        if (!this.#claimed.delete(identifier)) {
            if (forceClear && !keepAttempt) await this.#clearAttempt({ identifier });
            return;
        }
        const item = this.#claimItems.get(identifier);
        this.#claimItems.delete(identifier);
        // A release ends the claim lifetime: the counters and any queued retry
        // or parked row cannot outlive the claim (Q6).
        this.#attempts.delete(identifier);
        this.#continuations.delete(identifier);
        this.#retries.delete(identifier);
        this.#parked.delete(identifier);
        if (!keepAttempt) await this.#clearAttempt({ identifier });
        try {
            await this.#claims.release({ workItemId: identifier, owner: this.#owner });
        } catch {
            // A claim-store failure at release is diagnostic; the attempt has
            // already settled and must not be retried from here.
        }
        this.#emit({
            name: EVENTS.WORK_ITEM.RELEASED,
            runContext,
            payload: { workItemId: item?.id ?? identifier, identifier, reason }
        });
    }

    /**
     * End one item's claim lifetime outside a running attempt: remove its
     * workspace, then clear the claim and the persisted counters.
     * @param {{identifier: string, item: WorkItem, reason: string}} arg0 -
     * @returns {Promise<void>}
     */
    async #retireEntry({ identifier, item, reason }) {
        await this.#cleanupWorkspace({ identifier, item });
        await this.#releaseClaim({ identifier, reason, forceClear: true });
    }

    /**
     * Bump one parked entry's re-check time without releasing it (AC20).
     * @param {{entry: ParkedEntry, now: number}} arg0 -
     * @returns {Promise<void>}
     */
    async #extendParked({ entry, now }) {
        entry.checks += 1;
        // The capped parked re-check delay: `min(retry.maxMs * 2^checks, 6h)`.
        entry.nextCheckAt = now + retryDelayMs({
            attempt: entry.checks + 1,
            baseMs: this.#config.retry.maxMs,
            maxMs: LIMITS.scheduler_park_backoff_cap_ms
        });
        await this.#persistAttempt({ identifier: entry.identifier, id: entry.item.id });
    }

    /**
     * Queue a failure or stall retry. `attempt` is the number the retried run
     * receives, so the first failure retries as attempt 2; the delay exponent is
     * the failure ordinal (`attempt - 1`), which keeps the documented
     * `10s/20s/40s` backoff. A continuation is not scheduled here: it always
     * runs as attempt 1, so the dispatched ordinals of one claim lifetime can
     * read `[1, 2, 1]` (initial attempt, failure retry, continuation), per §3.7.
     * @param {{entry: SchedulerEntry, item: WorkItem, attempt: number, failureClass: string, errorName: string|null, errorCode: string|null}} arg0 -
     * @returns {void}
     */
    #scheduleFailureRetry({ entry, item, attempt, failureClass, errorName, errorCode }) {
        const delayMs = retryDelayMs({
            attempt: Math.max(1, attempt - 1),
            baseMs: this.#config.retry.baseMs,
            maxMs: this.#config.retry.maxMs
        });
        const dueAtMs = this.#now() + delayMs;
        this.#retries.set(entry.identifier, {
            identifier: entry.identifier,
            item,
            attempt,
            dueAtMs,
            delayMs,
            kind: 'failure',
            errorName,
            errorCode
        });
        this.#emit({
            name: EVENTS.WORK_ITEM.RETRY_SCHEDULED,
            runContext: entry.runContext,
            payload: {
                workItemId: item.id,
                identifier: entry.identifier,
                attempt,
                delayMs,
                dueAtMs,
                failureClass
            }
        });
    }

    /**
     * The one failure decision shared by an ordinary failed attempt and a stall
     * retry disposition. `#attempts` is incremented here, so `nextAttempt`
     * counts this failure: a non-retryable class parks immediately, reaching
     * `maxAttemptsPerItem` parks, and anything else gets one queued retry.
     *
     * A stall disposition forces `timedOut` for the retry decision, but only
     * after the base evidence is classified: a permission, environment, or
     * workflow code still parks on the first attempt (a stall while `ENOENT`
     * is an unreachable workspace, not a transient timeout). A plain canceled
     * attempt with no disposition and no evidence classifies as `unknown`; a
     * canceled result that still carries an error code keeps it, so a
     * permission block delivered as `canceled` parks instead of retrying.
     * A result flagged `nonRetryable` parks on its first failure, whatever the
     * taxonomy says.
     * @param {{entry: SchedulerEntry, item: WorkItem, result: NormalizedRunResult, extraEvidence?: Record<string, unknown>|null}} arg0 -
     * @returns {Promise<void>}
     */
    async #settleFailure({ entry, item, result, extraEvidence = null }) {
        const identifier = entry.identifier;
        const nextAttempt = (this.#attempts.get(identifier) ?? 0) + 1;
        this.#attempts.set(identifier, nextAttempt);
        // The count is persisted before any retry can dispatch, so a crash
        // mid-retry re-queues at the same failure count.
        await this.#persistAttempt({ identifier, id: item.id });
        const evidence = {
            ...failureEvidence({ result }),
            errorCode: result.errorCode ?? undefined
        };
        let failureClass = result.status === 'canceled' && extraEvidence === null
            && result.errorCode === null && result.errorName === null && result.timedOut !== true
            ? FailureClass.UNKNOWN
            : classifyFailure({ evidence });
        if (extraEvidence !== null && !NON_RETRYABLE_FAILURE_CLASSES.has(failureClass)) {
            failureClass = classifyFailure({ evidence: { ...evidence, ...extraEvidence } });
        }
        if (result.nonRetryable === true || NON_RETRYABLE_FAILURE_CLASSES.has(failureClass)) {
            this.#emit({
                name: EVENTS.WORK_ITEM.FAILED,
                runContext: entry.runContext,
                payload: {
                    workItemId: item.id,
                    identifier,
                    attempt: entry.attempt,
                    failureClass,
                    errorName: result.errorName,
                    errorCode: result.errorCode
                }
            });
            await this.#park({ entry, reason: 'non_retryable' });
            return;
        }
        if (nextAttempt >= this.#config.limits.maxAttemptsPerItem) {
            this.#emit({
                name: EVENTS.WORK_ITEM.FAILED,
                runContext: entry.runContext,
                payload: {
                    workItemId: item.id,
                    identifier,
                    attempt: entry.attempt,
                    failureClass,
                    errorName: result.errorName,
                    errorCode: result.errorCode
                }
            });
            await this.#park({ entry, reason: 'attempts_exhausted' });
            return;
        }
        this.#scheduleFailureRetry({
            entry,
            item,
            attempt: nextAttempt + 1,
            failureClass,
            errorName: result.errorName,
            errorCode: result.errorCode
        });
    }

    /**
     * Re-queue a due retry at the same attempt after a source error or a full
     * pool. The attempt budget does not move (AC9).
     * @param {{entry: RetryEntry, now: number, delayMs: number, failureClass: string|null}} arg0 -
     * @returns {void}
     */
    #requeueRetry({ entry, now, delayMs, failureClass }) {
        const dueAtMs = now + delayMs;
        this.#retries.set(entry.identifier, { ...entry, dueAtMs, delayMs });
        this.#emit({
            name: EVENTS.WORK_ITEM.RETRY_SCHEDULED,
            payload: {
                workItemId: entry.item.id,
                identifier: entry.identifier,
                attempt: entry.attempt,
                delayMs,
                dueAtMs,
                failureClass
            }
        });
    }

    /**
     * Park an item and keep its claim. Parking is what prevents a bound from
     * resetting into an unbounded re-dispatch loop (SCH-01).
     * @param {{entry: {identifier: string, item: WorkItem, runContext?: RunContext}, reason: string}} arg0 -
     * @returns {Promise<void>}
     */
    async #park({ entry, reason }) {
        const identifier = entry.identifier;
        const now = this.#now();
        const checks = 0;
        /** @type {ParkedEntry} */
        const parked = {
            identifier,
            item: entry.item,
            reason,
            since: now,
            nextCheckAt: now + retryDelayMs({
                attempt: checks + 1,
                baseMs: this.#config.retry.maxMs,
                maxMs: LIMITS.scheduler_park_backoff_cap_ms
            }),
            checks,
            attempts: this.#attempts.get(identifier) ?? 0,
            continuations: this.#continuations.get(identifier) ?? 0
        };
        this.#retries.delete(identifier);
        this.#parked.set(identifier, parked);
        // Persist before the event: a throwing host emitter must not leave a
        // parked item unrecorded after it was reported as parked.
        await this.#persistAttempt({ identifier, id: entry.item.id });
        this.#emit({
            name: EVENTS.WORK_ITEM.PARKED,
            runContext: entry.runContext,
            payload: {
                workItemId: entry.item.id,
                identifier,
                reason,
                attempts: parked.attempts,
                continuations: parked.continuations,
                nextCheckAt: parked.nextCheckAt
            }
        });
    }

    /**
     * Write the release disposition BEFORE the abort so `onSettled` can never
     * schedule a retry for a reconciled item (AC11, §5.9 mutation 1). `cleanup`
     * is the terminal-workspace intent; `onSettled` performs the actual
     * `remove({ force: false })` under the release branch.
     * @param {{entry: SchedulerEntry, reason: string, cleanup: boolean}} arg0 -
     * @returns {void}
     */
    #terminate({ entry, reason, cleanup }) {
        const current = entry.disposition;
        // A stop is final, and so is a terminal release: a later inactive or
        // unroutable tick must not downgrade it and lose `cleanup`. Otherwise
        // the release is idempotent per reason, so a repeated tick emits once,
        // while a genuinely new fact (inactive -> terminal) upgrades and emits.
        if (current?.type === 'stop') return;
        if (current?.type === 'release'
            && (current.reason === 'terminal' || current.reason === reason)) return;
        entry.disposition = { type: 'release', reason, cleanup };
        entry.controller.abort(reason);
        this.#emit({
            name: EVENTS.WORK_ITEM.RECONCILED,
            runContext: entry.runContext,
            payload: { workItemId: entry.item.id, identifier: entry.identifier, reason, cleanup }
        });
    }

    /**
     * Refresh the claim of every item this scheduler still owns — a running
     * attempt, a queued retry or continuation, and a parked row — so it never
     * ages past `claim_stale_ms` on a directory another host shares (F2-7,
     * W2D-1). `refresh` never creates or steals a claim, so a release that
     * raced the heartbeat wins (W2D-3). A store without `refresh` cannot be
     * heartbeated; a failed heartbeat is diagnostic and the next tick retries.
     * @returns {Promise<void>}
     */
    async #heartbeatClaims() {
        if (this.#claimed.size === 0) return;
        const refresh = this.#claims.refresh;
        if (typeof refresh !== 'function') return;
        const now = this.#now();
        for (const identifier of [...this.#claimed]) {
            try {
                await refresh.call(this.#claims, { workItemId: identifier, owner: this.#owner, now });
            } catch {
                // The claim stays ours in memory; a failed heartbeat is not a
                // lost claim, and the item is not released from here.
            }
        }
    }

    /**
     * The stall pass then the tracker refresh pass (§3.8). A stall retries; a
     * refresh decides terminal/inactive/unroutable/missing or updates the item.
     * A refresh throw keeps every worker running.
     * @returns {Promise<void>}
     */
    async #reconcile() {
        // Before the early return: a parked item holds its claim with no worker.
        await this.#heartbeatClaims();
        const now = this.#now();
        if (this.#config.stallTimeoutMs > 0) {
            for (const entry of [...this.#running.values()]) {
                if (entry.disposition !== null) continue;
                const idleMs = now - entry.lastProgressAt;
                if (idleMs > this.#config.stallTimeoutMs) {
                    this.#emit({
                        name: EVENTS.WORK_ITEM.STALLED,
                        runContext: entry.runContext,
                        payload: {
                            workItemId: entry.item.id,
                            identifier: entry.identifier,
                            attempt: entry.attempt,
                            idleMs
                        }
                    });
                    entry.disposition = { type: 'retry', reason: 'stalled' };
                    entry.controller.abort('stalled');
                }
            }
        }
        if (this.#running.size === 0) return;
        /** @type {WorkItem[]} */
        let fresh;
        try {
            const result = await this.#config.workSource.fetchByIds({
                ids: [...this.#running.values()].map((entry) => entry.item.id),
                signal: this.#config.signal ?? undefined
            });
            fresh = Array.isArray(result) ? [...result] : [];
        } catch (error) {
            this.#emit({
                name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR,
                payload: { op: 'fetchByIds', category: workSourceCategory({ error }) }
            });
            return;
        }
        if (this.#stopped) return;
        /** @type {Map<string, WorkItem>} */
        const freshById = new Map();
        for (const item of fresh) freshById.set(item.id, item);
        for (const entry of [...this.#running.values()]) {
            const item = freshById.get(entry.item.id);
            const outcome = classifyRefresh({
                item,
                terminalStates: this.#config.terminalStates,
                activeStates: this.#config.activeStates
            });
            if (outcome === 'missing') {
                this.#terminate({ entry, reason: 'missing', cleanup: false });
                continue;
            }
            // `missing` is the only outcome without a refreshed record.
            const liveItem = /** @type {WorkItem} */ (item);
            if (outcome === 'terminal') {
                this.#terminate({ entry, reason: 'terminal', cleanup: true });
                continue;
            }
            if (outcome === 'inactive') {
                this.#terminate({ entry, reason: 'inactive', cleanup: false });
                continue;
            }
            if (this.#isRoutable({ item: liveItem })) {
                entry.item = liveItem;
                continue;
            }
            this.#terminate({ entry, reason: 'unroutable', cleanup: false });
        }
    }

    /**
     * Re-check due parked items in one batch. Still active extends the backoff
     * and keeps the claim; anything else releases it (AC20).
     * @returns {Promise<void>}
     */
    async #checkParked() {
        const now = this.#now();
        const due = [...this.#parked.values()].filter((entry) => now >= entry.nextCheckAt);
        if (due.length === 0) return;
        /** @type {WorkItem[]} */
        let fresh;
        try {
            const result = await this.#config.workSource.fetchByIds({
                ids: due.map((entry) => entry.item.id),
                signal: this.#config.signal ?? undefined
            });
            fresh = Array.isArray(result) ? [...result] : [];
        } catch (error) {
            this.#emit({
                name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR,
                payload: { op: 'checkParked', category: workSourceCategory({ error }) }
            });
            const retryNow = this.#now();
            for (const entry of due) await this.#extendParked({ entry, now: retryNow });
            return;
        }
        if (this.#stopped) return;
        /** @type {Map<string, WorkItem>} */
        const freshById = new Map();
        for (const item of fresh) freshById.set(item.id, item);
        for (const entry of due) {
            const item = freshById.get(entry.item.id);
            const outcome = classifyRefresh({
                item,
                terminalStates: this.#config.terminalStates,
                activeStates: this.#config.activeStates
            });
            if (outcome === 'missing') {
                await this.#releaseClaim({ identifier: entry.identifier, reason: 'missing', forceClear: true });
                continue;
            }
            // `missing` is the only outcome without a refreshed record.
            const liveItem = /** @type {WorkItem} */ (item);
            if (outcome === 'terminal') {
                await this.#retireEntry({ identifier: entry.identifier, item: liveItem, reason: 'terminal' });
                continue;
            }
            if (outcome === 'inactive') {
                await this.#releaseClaim({ identifier: entry.identifier, reason: 'inactive', forceClear: true });
                continue;
            }
            entry.item = liveItem;
            await this.#extendParked({ entry, now });
        }
    }

    /**
     * Dispatch every due retry after one batched refresh. A source failure or a
     * full pool re-queues the same attempt; a state change releases the claim.
     * @returns {Promise<number>} The number of retry dispatches.
     */
    async #processDueRetries() {
        const now = this.#now();
        const due = [...this.#retries.values()].filter((entry) => entry.dueAtMs <= now);
        if (due.length === 0) return 0;
        for (const entry of due) this.#retries.delete(entry.identifier);
        for (const entry of due) this.#refreshing.add(entry.identifier);
        /** @type {WorkItem[]} */
        let fresh;
        try {
            const result = await this.#config.workSource.fetchByIds({
                ids: due.map((entry) => entry.item.id),
                signal: this.#config.signal ?? undefined
            });
            fresh = Array.isArray(result) ? [...result] : [];
        } catch (error) {
            for (const entry of due) this.#refreshing.delete(entry.identifier);
            this.#emit({
                name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR,
                payload: { op: 'processRetries', category: workSourceCategory({ error }) }
            });
            const requeueAt = this.#now();
            const delayMs = this.#baseRetryDelay();
            for (const entry of due) {
                this.#requeueRetry({ entry, now: requeueAt, delayMs, failureClass: null });
            }
            return 0;
        }
        for (const entry of due) this.#refreshing.delete(entry.identifier);
        if (this.#stopped) {
            for (const entry of due) {
                await this.#releaseClaim({ identifier: entry.identifier, reason: this.#stopReason, keepAttempt: true });
            }
            return 0;
        }
        /** @type {Map<string, WorkItem>} */
        const freshById = new Map();
        for (const item of fresh) freshById.set(item.id, item);
        let dispatched = 0;
        for (let index = 0; index < due.length; index += 1) {
            const entry = due[index];
            if (this.#cancelRequested.delete(entry.identifier)) {
                await this.#park({ entry: { identifier: entry.identifier, item: entry.item }, reason: 'canceled' });
                continue;
            }
            const item = freshById.get(entry.item.id);
            const outcome = classifyRefresh({
                item,
                terminalStates: this.#config.terminalStates,
                activeStates: this.#config.activeStates
            });
            if (outcome === 'missing') {
                await this.#releaseClaim({ identifier: entry.identifier, reason: 'missing', forceClear: true });
                continue;
            }
            // `missing` is the only outcome without a refreshed record.
            const liveItem = /** @type {WorkItem} */ (item);
            if (outcome === 'terminal') {
                await this.#retireEntry({ identifier: entry.identifier, item: liveItem, reason: 'terminal' });
                continue;
            }
            if (outcome === 'inactive') {
                await this.#releaseClaim({ identifier: entry.identifier, reason: 'inactive', forceClear: true });
                continue;
            }
            if (!this.#isRoutable({ item: liveItem })) {
                await this.#releaseClaim({ identifier: entry.identifier, reason: 'unroutable', forceClear: true });
                continue;
            }
            if (!this.#globalSlot() || !this.#laneSlot({ lane: liveItem.lane })) {
                this.#requeueRetry({ entry, now: this.#now(), delayMs: this.#baseRetryDelay(), failureClass: null });
                continue;
            }
            // AC14: a budget hit at a retry fire re-queues this attempt and every
            // due entry after it at the same attempt number, with the base delay
            // and no failure class, so raising the limit through `applyConfig`
            // resumes them on a later tick without consuming the attempt budget.
            if (this.#budgetExhausted()) {
                const requeueAt = this.#now();
                const delayMs = this.#baseRetryDelay();
                for (const pending of due.slice(index)) {
                    this.#requeueRetry({ entry: pending, now: requeueAt, delayMs, failureClass: null });
                }
                break;
            }
            const started = await this.#claimAndStart({
                item: liveItem,
                attempt: entry.attempt,
                lane: liveItem.lane,
                kind: entry.kind
            });
            if (started === 'started') {
                dispatched += 1;
                continue;
            }
            if (started === 'preflight') {
                // No claim was taken, so nothing is released and the attempt
                // keeps its number: the item is refused, not refunded. It is
                // re-queued like a busy slot, and the next tick tries again
                // once the contract is healthy (W1-9).
                this.#requeueRetry({ entry, now: this.#now(), delayMs: this.#baseRetryDelay(), failureClass: null });
                continue;
            }
            // The claim is provably lost, so drop the lifetime bookkeeping and
            // let the next list fetch re-claim it. A stop during the fire has
            // already released it, so this call is a no-op there.
            await this.#releaseClaim({ identifier: entry.identifier, reason: 'claim_failed', forceClear: true });
        }
        return dispatched;
    }

    /**
     * Settle one attempt under its disposition. Never rejects (SCH-10). The
     * claim is released only for a stop, a reconciliation, or a throw before a
     * terminal decision; a deliberate retry/continuation/park keeps it (AC7).
     * @param {{entry: SchedulerEntry, result: NormalizedRunResult}} arg0 -
     * @returns {Promise<void>}
     */
    async #onSettled({ entry, result }) {
        /** @type {string|null} */
        let releaseReason = null;
        let finished = false;
        try {
            // The attempt settled, so its crash marker must not outlive it; this
            // write is ordered ahead of every branch's own persist (F2-2).
            await this.#persistAttempt({ identifier: entry.identifier, id: entry.item.id });
            this.#running.delete(entry.identifier);
            const endedAt = this.#now();
            const durationMs = Math.max(0, endedAt - entry.startedAt);
            this.#totals.secondsRunning += durationMs / 1000;
            this.#totals.attempts += 1;
            accumulateUsage({ totals: this.#totals, usage: result.usage });
            const disposition = entry.disposition;
            // A canceled attempt with error evidence is a failure the host sees,
            // but a host stop or cancel is not a failure.
            const hostCanceled = disposition?.type === 'park' && disposition.reason === 'canceled';
            const hostEnded = this.#stopped || disposition?.type === 'stop' || hostCanceled;
            if (result.status === 'failed'
                || (result.status === 'canceled' && !hostEnded && (result.errorCode !== null || result.errorName !== null))) {
                this.#totals.failures += 1;
            }

            const identifier = entry.identifier;
            const item = entry.item;

            if (this.#stopped || disposition?.type === 'stop') {
                releaseReason = 'stopped';
                finished = true;
                return;
            }
            if (disposition?.type === 'release') {
                if (disposition.cleanup === true) {
                    try {
                        await this.#cleanupWorkspace({
                            identifier: entry.identifier,
                            item: entry.item,
                            workspace: entry.workspace,
                            runContext: entry.runContext
                        });
                    } catch {
                        // SCH-10: a cleanup failure (including a throwing host
                        // emitter) must never reject the settle or change the
                        // release that follows.
                    }
                }
                releaseReason = disposition.reason;
                finished = true;
                return;
            }
            if (disposition?.type === 'retry') {
                // A stall is a watchdog timeout: classify it (a permission or
                // policy code still parks) and honor the per-item attempt cap.
                await this.#settleFailure({ entry, item, result, extraEvidence: { timedOut: true } });
                finished = true;
                return;
            }
            if (disposition?.type === 'park') {
                // A host cancel: keep the claim and do not redispatch an active
                // tracker item on the next scan. `resetItem()` releases it.
                await this.#park({ entry, reason: disposition.reason });
                finished = true;
                return;
            }
            if (result.status === 'completed') {
                const scheduled = this.#continuations.get(identifier) ?? 0;
                const continuation = this.#config.continuation;
                // `continuation.max` counts continuation retries, so max 3 runs
                // three more attempts after the first one; max 0 disables them.
                // Only a scheduled continuation increments the counter, so a
                // parked row reports the number of continuations that actually
                // ran, not the number of completions.
                if (continuation.max > 0 && scheduled + 1 <= continuation.max && result.progress !== false) {
                    this.#continuations.set(identifier, scheduled + 1);
                    // The continuation budget is part of what survives: persist
                    // it before the retry can be lost.
                    await this.#persistAttempt({ identifier, id: item.id });
                    const delayMs = continuation.delayMs;
                    const dueAtMs = this.#now() + delayMs;
                    this.#retries.set(identifier, {
                        identifier,
                        item,
                        // A continuation always runs as attempt 1, so the
                        // dispatched ordinals of one claim lifetime can read
                        // `[1, 2, 1]` (an initial attempt, one failure retry,
                        // then a continuation), per §3.7.
                        attempt: 1,
                        dueAtMs,
                        delayMs,
                        kind: 'continuation',
                        errorName: null,
                        errorCode: null
                    });
                    this.#emit({
                        name: EVENTS.WORK_ITEM.CONTINUED,
                        runContext: entry.runContext,
                        payload: { workItemId: item.id, identifier, attempt: 1, delayMs }
                    });
                    finished = true;
                    return;
                }
                this.#rememberCompleted({ identifier });
                this.#emit({
                    name: EVENTS.WORK_ITEM.COMPLETED,
                    runContext: entry.runContext,
                    payload: {
                        workItemId: item.id,
                        identifier,
                        attempt: entry.attempt,
                        durationMs,
                        usage: numericUsage({ usage: result.usage })
                    }
                });
                const reason = result.progress === false
                    ? 'no_progress'
                    : continuation.max === 0 ? 'continuations_disabled' : 'continuations_exhausted';
                await this.#park({ entry, reason });
                finished = true;
                return;
            }
            await this.#settleFailure({ entry, item, result });
            finished = true;
        } catch (error) {
            try {
                this.#emitInternalError({ op: 'settle', error });
            } catch {
                // A host emitter that throws on every event must not reject the
                // settle promise (SCH-10).
            }
            if (!finished && releaseReason === null) releaseReason = 'settle_error';
        } finally {
            // Runs even when a branch above returned, so a stop/release
            // disposition or a throw-before-decision always frees the claim.
            if (releaseReason !== null) {
                try {
                    await this.#releaseClaim({
                        identifier: entry.identifier,
                        reason: releaseReason,
                        runContext: entry.runContext,
                        keepAttempt: releaseReason === 'stopped'
                    });
                } catch (error) {
                    try {
                        this.#emitInternalError({ op: 'settle', error });
                    } catch {
                        // The claim was already removed from the in-process set.
                    }
                }
            }
        }
    }

    /**
     * One preflight read: the config validation plus the host closure. Throws
     * when the closure throws, so each caller can report that as its own
     * `internal_error` instead of as a validation failure.
     * @returns {string[]} Reasons that block new work; `[]` means healthy.
     */
    #preflightErrors() {
        const errors = validateSchedulerConfig({
            options: /** @type {Record<string, unknown>} */ (this.#config)
        });
        if (this.#config.preflight !== null) {
            const extra = this.#config.preflight();
            if (Array.isArray(extra)) {
                for (const entry of extra) {
                    if (typeof entry === 'string') errors.push(entry);
                }
            } else {
                errors.push('preflight must return an array of strings');
            }
        }
        return errors;
    }

    /**
     * Run one tick body. The caller owns `#ticking` and the next timer.
     * @returns {Promise<void>}
     */
    async #tickInternal() {
        this.#tickCount += 1;
        this.#lastTickAt = this.#now();
        // AC23: a queued patch is applied before reconcile (§3.15 rule 4).
        this.#applyPendingConfig();
        if (this.#stopped) {
            this.#emitTick({ outcome: 'stopped' });
            return;
        }

        // AC21: reconciliation and parked re-checks run even when validation
        // will fail. Budget enforcement never stops those passes: they reap
        // claims and workspaces, they do not spend.
        await this.#reconcile();
        await this.#checkParked();
        if (this.#stopped) {
            this.#emitTick({ outcome: 'stopped' });
            return;
        }

        /** @type {string[]} */
        let errors;
        try {
            errors = this.#preflightErrors();
        } catch (error) {
            this.#emitInternalError({ op: 'preflight', error });
            this.#emitTick({ outcome: 'validation_error' });
            return;
        }
        if (errors.length > 0) {
            this.#emit({ name: EVENTS.SCHEDULER.VALIDATION_ERROR, payload: { errors } });
            this.#emitTick({ outcome: 'validation_error' });
            return;
        }

        // Due retries are dispatched before the scan; their dispatches count
        // toward this tick's `dispatched`. The budget guard sits at each fire,
        // so a blocked retry is re-queued instead of dropped.
        const retryDispatches = await this.#processDueRetries();
        if (this.#stopped) {
            this.#emitTick({ outcome: 'stopped' });
            return;
        }

        let items;
        try {
            items = await this.#config.workSource.fetchByStates({
                states: this.#config.activeStates,
                signal: this.#config.signal ?? undefined
            });
        } catch (error) {
            this.#emit({
                name: EVENTS.SCHEDULER.WORK_SOURCE_ERROR,
                payload: { op: 'fetchByStates', category: workSourceCategory({ error }) }
            });
            this.#emitTick({ outcome: 'source_error' });
            return;
        }
        if (this.#stopped) {
            this.#emitTick({ outcome: 'stopped' });
            return;
        }

        const fetched = Array.isArray(items) ? items : [];
        const duplicates = collectDuplicateIdentifiers({ items: fetched });
        let dispatchable = fetched;
        if (duplicates.length > 0) {
            const duplicateKeys = new Set(duplicates.map((identifier) => identifier.trim().toLowerCase()));
            dispatchable = fetched.filter((item) => !duplicateKeys.has(item.identifier.trim().toLowerCase()));
            this.#emit({
                name: EVENTS.SCHEDULER.VALIDATION_ERROR,
                payload: { errors: duplicates.map((identifier) => `duplicate_identifier: ${identifier}`) }
            });
        }

        let dispatched = retryDispatches;
        for (const item of sortForDispatch({ items: dispatchable })) {
            if (this.#stopped) break;
            if (!this.#globalSlot()) break;
            if (!this.#laneSlot({ lane: item.lane })) continue;
            if (!this.#shouldDispatch({ item })) continue;
            // AC14: the guard runs only once the item is otherwise dispatchable
            // and a slot exists; a hit ends the scan, because no further item
            // can dispatch under the same aggregate limit.
            if (this.#budgetExhausted()) break;
            if (await this.#claimAndStart({ item, attempt: null, lane: item.lane }) === 'started') dispatched += 1;
            if (this.#stopped) {
                this.#emitTick({ outcome: 'stopped' });
                return;
            }
        }
        if (this.#stopped) {
            this.#emitTick({ outcome: 'stopped' });
            return;
        }

        this.#emitTick({ outcome: 'ok', fetched: fetched.length, dispatched });
    }

    /**
     * Startup terminal cleanup (§3.8/AC13): one fetch of the terminal states,
     * then `handleFor` + `remove({ force: false })` per item. No claims, no
     * dispatch, no `reconciled` events, no retries. A failure is contained so
     * `start()` never rejects for cleanup.
     * @returns {Promise<void>}
     */
    async #startupCleanup() {
        if (this.#config.startupCleanup !== true) return;
        const workspace = this.#config.workspace;
        if (workspace === null || workspace === undefined) return;
        const states = this.#config.terminalStates;
        if (states.length === 0) return;
        /** @type {WorkItem[]} */
        let items;
        try {
            const result = await this.#config.workSource.fetchByStates({
                states: [...states],
                signal: this.#config.signal ?? undefined
            });
            items = Array.isArray(result) ? [...result] : [];
        } catch (error) {
            try {
                this.#emitInternalError({ op: 'startup_cleanup', error });
            } catch {
                // A hostile emitter must not reject start() for cleanup.
            }
            return;
        }
        for (const item of items) {
            try {
                const handle = workspace.handleFor({ workItemId: item.identifier, identifier: item.identifier });
                const result = await runWithRunContext({
                    runContext: this.#runCtx,
                    fn: () => workspace.remove({ workspace: handle, force: false })
                });
                this.#emitCleanupRefusal({ result, workItemId: item.id, identifier: item.identifier });
            } catch (error) {
                try {
                    this.#emitInternalError({ op: 'startup_cleanup', error });
                } catch {
                    // A hostile emitter must not reject start() for cleanup.
                }
            }
        }
    }

    /**
     * Hydrate the counters and park rows a previous process persisted. Only
     * active items are adopted, and a record for a re-created item (a different
     * source `id`) is cleared. A source failure skips hydration rather than
     * failing `start()`: the next tick reports the board error. Records for
     * items that are no longer active are left for an existing release path;
     * hydration itself never deletes them.
     * @returns {Promise<void>}
     */
    async #hydrateAttempts() {
        const store = this.#config.attemptStore;
        if (store === null) return;
        /** @type {import('./attempt-store.mjs').AttemptRecord[]} */
        let records = [];
        try {
            records = await store.list();
        } catch {
            // A store that cannot be listed leaves its files for the next
            // start; dispatch is unaffected.
        }
        // Nothing to resume: skip the extra source read on a fresh process.
        if (records.length === 0) return;
        /** @type {WorkItem[]} */
        let items;
        try {
            const result = await this.#config.workSource.fetchByStates({
                states: [...this.#config.activeStates],
                signal: this.#config.signal ?? undefined
            });
            items = Array.isArray(result) ? [...result] : [];
        } catch {
            return;
        }
        this.#hydrationPasses += 1;
        try {
            for (const item of items) {
                const identifier = item.identifier;
                if (typeof identifier !== 'string' || identifier === '') continue;
                const hydration = this.#hydrateAttempt({ item });
                this.#hydrating.set(identifier, hydration);
                try {
                    await hydration;
                } finally {
                    this.#hydrating.delete(identifier);
                    this.#hostTouched.delete(identifier);
                }
            }
        } finally {
            this.#hydrationPasses -= 1;
            // No hydration can observe a touched marker after the last pass.
            if (this.#hydrationPasses === 0) this.#hostTouched.clear();
        }
    }

    /**
     * Adopt one persisted record, or do nothing. A host reset that ran during
     * the load wins: the record is cleared and never adopted, so a slow load
     * cannot save a park back over `resetItem`.
     * @param {{item: WorkItem}} arg0 -
     * @returns {Promise<void>}
     */
    async #hydrateAttempt({ item }) {
        const store = this.#config.attemptStore;
        const identifier = item.identifier;
        if (store === null) return;
        /** @type {import('./attempt-store.mjs').AttemptRecord|null} */
        let record = null;
        try {
            record = await store.load({ identifier });
        } catch {
            // A custom store that throws on load is skipped silently: the store
            // owns its own diagnostics, and start() must not fail over it.
        }
        if (record === null) return;
        if (this.#hostTouched.has(identifier)) {
            await this.#clearAttempt({ identifier });
            return;
        }
        // A re-created item under the same identifier is different work:
        // its old counters must not bound the new item.
        if (record.id !== item.id) {
            await this.#clearAttempt({ identifier });
            return;
        }
        // A leftover in-flight marker is an attempt whose process died. It is
        // one `unknown` failure — counted, never emitted — so a crash consumes
        // the same budget a failed attempt does (F2-2).
        const crashed = record.inFlight !== null && record.inFlight !== undefined;
        const attempts = crashed ? record.attempts + 1 : record.attempts;
        this.#attempts.set(identifier, attempts);
        this.#continuations.set(identifier, record.continuations);
        if (record.parked !== null) {
            this.#parked.set(identifier, {
                identifier,
                item,
                reason: record.parked.reason,
                since: record.parked.at,
                nextCheckAt: record.parked.nextCheckAt,
                // The re-check counter is not persisted; the due time is
                // what a restart honors, and the first extension starts over.
                checks: 0,
                attempts,
                continuations: record.continuations
            });
            // A counted crash is persisted here too, so the marker cannot be
            // counted again on the next restart (W2D-11).
            if (crashed) await this.#persistAttempt({ identifier, id: item.id });
        } else if (attempts >= this.#config.limits.maxAttemptsPerItem) {
            // A crash can land between the count write and the park write.
            // Park at hydration so the exhausted item is visible, not
            // silently skipped by the dispatch cap.
            const now = this.#now();
            this.#parked.set(identifier, {
                identifier,
                item,
                reason: 'attempts_exhausted',
                since: now,
                nextCheckAt: now + retryDelayMs({
                    attempt: 1,
                    baseMs: this.#config.retry.maxMs,
                    maxMs: LIMITS.scheduler_park_backoff_cap_ms
                }),
                checks: 0,
                attempts,
                continuations: record.continuations
            });
            await this.#persistAttempt({ identifier, id: item.id });
        } else if (crashed) {
            // The crash is counted; drop the marker so no restart counts it again.
            await this.#persistAttempt({ identifier, id: item.id });
        }
    }

    /**
     * Validate, set `#started` before the first await, hydrate the persisted
     * attempt state, run the startup workspace cleanup, emit `scheduler:start`,
     * and run the immediate tick.
     * The tick's `finally` arms the loop. Calling it after `stop()` resumes the
     * same instance; calling it on a running one throws `already_started`.
     * @returns {Promise<void>}
     */
    async start() {
        const restartAfterStop = this.#started && this.#stopped;
        if ((this.#started && !restartAfterStop) || this.#starting) {
            throw new SchedulerError({ message: 'scheduler is already started', options: { reason: 'already_started' } });
        }
        this.#starting = true;
        try {
            const errors = validateSchedulerConfig({
                options: /** @type {Record<string, unknown>} */ (this.#config)
            });
            if (this.#config.preflight !== null) {
                try {
                    const extra = this.#config.preflight();
                    if (Array.isArray(extra)) {
                        for (const entry of extra) {
                            if (typeof entry === 'string') errors.push(entry);
                        }
                    } else {
                        errors.push('preflight must return an array of strings');
                    }
                } catch (error) {
                    const { errorName } = errorFields({ error });
                    errors.push(`preflight failed: ${errorName ?? 'unknown'}`);
                }
            }
            if (errors.length > 0) {
                throw new ConfigurationError({
                    message: `invalid scheduler configuration: ${errors.join('; ')}`,
                    options: { option: 'config' }
                });
            }
            this.#runCtx = new RunContext();
            // `stop()` ends the attempts, not the instance: clearing the flag
            // here (only after validation passed) lets a host resume, and a
            // failed resume leaves the instance stopped, not wedged.
            if (restartAfterStop) this.#stopped = false;
            this.#started = true;
            // The token is a live owner again: a claim file it still names must
            // not be reclaimed while this instance runs (W2D-2).
            activateClaimOwner({ owner: this.#owner });
            await this.#hydrateAttempts();
            if (this.#stopped) {
                this.#starting = false;
                return;
            }
            await this.#startupCleanup();
            // A stop during startup cleanup wins: no start event, no first tick.
            if (this.#stopped) {
                this.#starting = false;
                return;
            }
            this.#emit({
                name: EVENTS.SCHEDULER.START,
                payload: {
                    pollIntervalMs: this.#config.pollIntervalMs,
                    concurrency: { ...this.#config.concurrency },
                    activeStates: [...this.#config.activeStates],
                    terminalStates: [...this.#config.terminalStates]
                }
            });
            // Startup is done; only now may a host tick. The outer `finally`
            // still resets the flag when validation or cleanup throws.
            this.#starting = false;
            await this.tick();
        } finally {
            this.#starting = false;
        }
    }

    /**
     * Stop dispatching, abort running attempts, drain within `timeoutMs`, release
     * queued retries, parked items, and claims that have no running attempt, then
     * report the counts. `retrying` and `parked` are the queued entries this
     * stop released (so they describe what was abandoned, not the post-stop
     * maps, which are empty); `running` is the count that remains after the
     * drain, which is non-zero only for an attempt that ignored the abort.
     * @param {{reason?: string, timeoutMs?: number}} [arg0] -
     * @returns {Promise<{drained: boolean, running: number, retrying: number, parked: number}>}
     */
    async stop({ reason = 'stopped', timeoutMs = LIMITS.scheduler_stop_drain_ms } = {}) {
        if (!this.#started) {
            return { drained: true, running: 0, retrying: 0, parked: 0 };
        }
        this.#stopped = true;
        this.#stopReason = reason;
        this.#cancelRequested.clear();
        this.#refreshing.clear();
        if (this.#tickTimer !== null) {
            this.#config.clock.clearTimeout(this.#tickTimer);
            this.#tickTimer = null;
        }
        // Step 3: a queued retry or a parked item has no running attempt, so
        // its claim is free to release now. Capture the sizes so the reported
        // counts say how many of each this stop actually released.
        const retryingBefore = this.#retries.size;
        const parkedBefore = this.#parked.size;
        const queued = new Set([...this.#retries.keys(), ...this.#parked.keys()]);
        for (const identifier of queued) {
            // The stop ends the process, not the item's lifetime: the persisted
            // attempt count and park row are what the next start resumes from.
            await this.#releaseClaim({ identifier, reason, keepAttempt: true });
        }
        const entries = [...this.#running.values()];
        for (const entry of entries) {
            entry.disposition = { type: 'stop' };
            entry.controller.abort();
        }
        let drained = true;
        const promises = entries
            .map((entry) => entry.promise)
            .filter((promise) => promise !== null);
        if (promises.length > 0) {
            drained = await this.#raceTimeout({
                timeoutMs,
                promise: Promise.allSettled(promises).then(() => true)
            });
        }
        // Step 6: release only claims with no running attempt (SCH-08). A claim
        // for a still-running attempt is left; its later settle releases it.
        for (const identifier of [...this.#claimed]) {
            if (this.#running.has(identifier)) continue;
            await this.#releaseClaim({ identifier, reason, keepAttempt: true });
        }
        // A park or attempt-count write can still be in flight for an item
        // whose settle resolved before this stop; flushing here is what makes
        // `await stop()` a safe point to exit the process.
        await this.#flushAttemptWrites();
        // The instance is done: its token is no longer a live owner, so a claim
        // file it left behind (a stuck attempt keeps one, SCH-08) is reclaimable
        // at once instead of after `claim_stale_ms` (W2D-2), and the token set
        // stays bounded by live instances (W2D-10).
        deactivateClaimOwner({ owner: this.#owner });
        const counts = {
            drained,
            running: this.#running.size,
            retrying: retryingBefore - this.#retries.size,
            parked: parkedBefore - this.#parked.size
        };
        this.#emit({ name: EVENTS.SCHEDULER.STOP, payload: { reason, ...counts } });
        return counts;
    }

    /**
     * Revalidate and tick immediately.
     * @returns {Promise<void>}
     */
    async refresh() {
        const errors = validateSchedulerConfig({
            options: /** @type {Record<string, unknown>} */ (this.#config)
        });
        if (errors.length > 0) {
            throw new ConfigurationError({
                message: `invalid scheduler configuration: ${errors.join('; ')}`,
                options: { option: 'config' }
            });
        }
        await this.tick();
    }

    /**
     * Cancel one active item without stopping the scheduler. A running attempt
     * is aborted and parked under reason `canceled`; a queued retry is parked;
     * an already parked item keeps its reason. The claim is kept, so an active
     * tracker item is not redispatched on the next scan — `resetItem()` un-parks
     * it, and `stop()` remains the only way to abort every attempt.
     * @param {{identifier?: string}} [arg0] -
     * @returns {Promise<{canceled: true, status: 'running'|'retrying'|'parked'|'pending'}>}
     */
    async cancelItem({ identifier } = {}) {
        if (!this.#started) {
            throw new SchedulerError({ message: 'scheduler is not started', options: { reason: 'not_started' } });
        }
        if (this.#stopped) {
            throw new SchedulerError({ message: 'scheduler is stopped', options: { reason: 'stopped' } });
        }
        if (typeof identifier !== 'string' || identifier.trim() === '') {
            throw new SchedulerError({ message: 'cancelItem requires an identifier', options: { reason: 'invalid_identifier' } });
        }
        const entry = this.#running.get(identifier);
        if (entry) {
            entry.disposition = { type: 'park', reason: 'canceled' };
            entry.controller.abort(new Error('canceled'));
            return { canceled: true, status: 'running' };
        }
        const retry = this.#retries.get(identifier);
        if (retry) {
            this.#retries.delete(identifier);
            await this.#park({ entry: { identifier, item: retry.item }, reason: 'canceled' });
            return { canceled: true, status: 'retrying' };
        }
        if (this.#parked.has(identifier)) {
            return { canceled: true, status: 'parked' };
        }
        if (this.#claiming.has(identifier) || this.#refreshing.has(identifier)) {
            // The item is between the queue and a running attempt: record the
            // request and park it before it starts. A refusal here would let
            // work the operator cancelled run anyway.
            this.#cancelRequested.add(identifier);
            return { canceled: true, status: 'pending' };
        }
        throw new SchedulerError({
            message: 'no running, retrying or parked item to cancel',
            options: { reason: 'not_active' }
        });
    }

    /**
     * Clear an item's counters, queued retry, and parking, then release its
     * claim so a host can retry after fixing the item (AC20). Requires
     * `start()` and refuses a running attempt (`invalid_attempt`); it is a
     * cleanup operation, so it remains available after `stop()`. A reset that
     * races `start()`'s hydration is serialized behind that identifier's load,
     * so a slow load cannot adopt and save the record back over the reset.
     * @param {{identifier: string}} arg0 -
     * @returns {Promise<void>}
     */
    async resetItem({ identifier }) {
        if (!this.#started) {
            throw new SchedulerError({ message: 'scheduler is not started', options: { reason: 'not_started' } });
        }
        if (this.#running.has(identifier)) {
            throw new SchedulerError({
                message: 'a running work item cannot be reset',
                options: { reason: 'invalid_attempt' }
            });
        }
        // Set the host intent before any await: hydration re-checks it after
        // its load and must adopt nothing once it is set.
        this.#hostTouched.add(identifier);
        const hydrating = this.#hydrating.get(identifier);
        if (hydrating !== undefined) await hydrating;
        this.#attempts.delete(identifier);
        this.#continuations.delete(identifier);
        this.#parked.delete(identifier);
        this.#retries.delete(identifier);
        this.#cancelRequested.delete(identifier);
        await this.#releaseClaim({ identifier, reason: 'reset', forceClear: true });
        if (this.#hydrationPasses === 0) this.#hostTouched.delete(identifier);
    }

    /**
     * Apply a partial dispatch-facing patch. A patch during a tick is deferred
     * to the next tick's start and emits when it is applied (AC23).
     * @param {{options?: Record<string, unknown>}} [arg0] -
     * @returns {Promise<{applied: boolean, deferred: boolean, changed: string[]}>}
     */
    async applyConfig({ options = {} } = {}) {
        if (!this.#started) {
            throw new SchedulerError({ message: 'scheduler is not started', options: { reason: 'not_started' } });
        }
        if (this.#stopped) {
            throw new SchedulerError({ message: 'scheduler is stopped', options: { reason: 'stopped' } });
        }
        const patch = isRecordObject(options) ? options : {};
        if (BOUND_KEYS.some((key) => Object.hasOwn(patch, key))) {
            throw new SchedulerError({
                message: 'a bound scheduler option cannot be changed by applyConfig',
                options: { reason: 'bound_option' }
            });
        }
        /** @type {Record<string, unknown>} */
        const managedPatch = {};
        for (const key of MANAGED_KEYS) {
            if (Object.hasOwn(patch, key)) managedPatch[key] = patch[key];
        }
        const merged = this.#mergeConfig({ current: this.#config, patch: managedPatch });
        const errors = validateSchedulerConfig({ options: /** @type {Record<string, unknown>} */ (merged) });
        if (errors.length > 0) {
            throw new ConfigurationError({
                message: `invalid scheduler configuration: ${errors.join('; ')}`,
                options: { option: 'config' }
            });
        }
        const changed = this.#changedKeys({ current: this.#config, patch: managedPatch, merged });
        if (changed.length === 0) {
            return { applied: false, deferred: false, changed: [] };
        }
        if (this.#ticking) {
            // Two individually valid patches must not merge into one that the
            // next tick silently drops: validate the queued merge now.
            const pending = { ...(this.#pendingConfig ?? {}), ...managedPatch };
            const deferredMerged = this.#mergeConfig({ current: this.#config, patch: pending });
            const deferredErrors = validateSchedulerConfig({
                options: /** @type {Record<string, unknown>} */ (deferredMerged)
            });
            if (deferredErrors.length > 0) {
                throw new ConfigurationError({
                    message: `invalid scheduler configuration: ${deferredErrors.join('; ')}`,
                    options: { option: 'config' }
                });
            }
            this.#pendingConfig = pending;
            return { applied: false, deferred: true, changed };
        }
        this.#config = merged;
        this.#scheduleNext();
        this.#emit({ name: EVENTS.SCHEDULER.CONFIGURED, payload: { source: 'reload', changed } });
        return { applied: true, deferred: false, changed };
    }

    /**
     * Run one tick. Requires `start()`; single-flight; the only path that arms
     * the next poll timer.
     * @returns {Promise<void>}
     */
    async tick() {
        if (this.#starting) {
            throw new SchedulerError({ message: 'scheduler is not started', options: { reason: 'not_started' } });
        }
        if (!this.#started) {
            throw new SchedulerError({ message: 'scheduler is not started', options: { reason: 'not_started' } });
        }
        if (this.#stopped) {
            this.#emitTick({ outcome: 'stopped' });
            return;
        }
        if (this.#ticking) {
            this.#emitTick({ outcome: 'in_flight' });
            return;
        }
        this.#ticking = true;
        try {
            await this.#tickInternal();
        } catch (error) {
            // AC8: every path emits a tick. A hostile work source can make the
            // tick body throw; contain it as a typed internal error instead of
            // rejecting the public method.
            try {
                this.#emitInternalError({ op: 'tick', error });
                this.#emitTick({ outcome: 'internal_error' });
            } catch {
                // A host emitter that throws must not reject tick() either.
            }
        } finally {
            this.#ticking = false;
            this.#scheduleNext();
        }
    }

    /**
     * The synchronous operator view (§3.13). No description, no provider
     * payload; `url` is the tracker URL or null.
     * @returns {ReturnType<typeof buildSnapshot>}
     */
    snapshot() {
        return buildSnapshot({
            started: this.#started,
            stopped: this.#stopped,
            tickCount: this.#tickCount,
            lastTickAt: this.#lastTickAt,
            lastOutcome: this.#lastOutcome,
            pollIntervalMs: this.#config.pollIntervalMs,
            running: this.#running,
            retrying: [...this.#retries.values()].map((entry) => ({
                workItemId: entry.item.id,
                identifier: entry.identifier,
                url: entry.item.url ?? null,
                attempt: entry.attempt,
                kind: entry.kind,
                dueAtMs: entry.dueAtMs,
                delayMs: entry.delayMs,
                errorName: entry.errorName,
                errorCode: entry.errorCode
            })),
            parked: [...this.#parked.values()].map((entry) => ({
                workItemId: entry.item.id,
                identifier: entry.identifier,
                url: entry.item.url ?? null,
                reason: entry.reason,
                since: entry.since,
                nextCheckAt: entry.nextCheckAt,
                attempts: entry.attempts,
                continuations: entry.continuations
            })),
            claimed: [...this.#claimed],
            completed: [...this.#completed],
            totals: this.#totals,
            limits: this.#config.limits,
            activeStates: this.#config.activeStates,
            terminalStates: this.#config.terminalStates,
            now: this.#now()
        });
    }
}
