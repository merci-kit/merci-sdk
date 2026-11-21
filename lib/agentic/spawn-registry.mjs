// @ts-check

/**
 * The spawn registry (wave 6 / SP1).
 *
 * A spawn is a **session with an identity**, not a call: it has an id, a parent,
 * a lineage, a status, the session it runs in and its own usage ledger. The
 * client owns transport only — the roster, the backend→client registry, the
 * resolver, the depth cap, the counter, the in-flight background map and the spawn
 * records all live here (keyed by the transport client, so two clients never
 * share orchestration state).
 *
 * The client is a transport (D2, SP5): it carries NO orchestration field. The
 * seven legacy fields (`_taskAgents`, `_taskClients`, `_taskClientResolver`,
 * `_taskMaxDepth`, `_taskCounter`, `_backgroundTasks`, `_agentDelegation`) are
 * adopted ONCE if a host preset them before the first SDK call, then deleted from
 * the client. A write after that is a plain property the registry never reads —
 * the deprecation notice says so.
 */

import { log, baseClientOf } from '../support/utils.mjs';
import { sumNumericUsage } from './budget-accounting.mjs';
import { threadIdFor } from './thread-ids.mjs';
import { LIMITS } from '../core/limit-config.mjs';

/** @type {WeakMap<object, SpawnRegistry>} */
const REGISTRIES = new WeakMap();

/** The legacy client fields and the registry slot each feeds. */
const LEGACY_FIELDS = [
    ['_taskAgents', 'agents'],
    ['_taskClients', 'clients'],
    ['_taskClientResolver', 'resolver'],
    ['_taskMaxDepth', 'maxDepth'],
    ['_taskCounter', 'counter'],
    ['_backgroundTasks', 'background'],
    ['_agentDelegation', 'delegation'],
];

/** @type {SpawnContinuation|null} */
let CONTINUE_IMPL = null;

/**
 * Continues one spawn's conversation with another turn. Registered by task.mjs
 * (which owns the step engine) so this module does not import it and cycle.
 * @typedef {(arg0: {record: SpawnRecord, prompt: string, signal?: AbortSignal|null}) => Promise<Object>} SpawnContinuation
 */

/**
 * The shared tree counter a spawn tree carries.
 * @typedef {Object} SpawnTree
 * @property {string|null} root
 * @property {number} count
 */

/**
 * The child session a spawn runs in. Structural: the registry reads its spawn
 * stamps, its durable thread and the usage its last turn reported.
 * @typedef {Object} SpawnSession
 * @property {string|null} [sessionId]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [_spawnId]
 * @property {string|null} [_spawnParentId]
 * @property {string[]} [_spawnLineage]
 * @property {SpawnTree} [_spawnTree]
 * @property {SpawnUsage|null} [_lastRunUsage]
 * @property {{fork?: Function}|null} [_sessionStore]
 * @property {string|null} [_threadId]
 * @property {Function} [forkCheckpoint]
 * @property {Object|null} [client]
 * @property {Array<Object>} [_lastStepMessages]
 * @property {import('../core/events.mjs').RunContext|null} [lastRunContext]
 * @property {Function} [run]
 */

/**
 * The host's delegation declaration (`withAgentDelegation`), before it is
 * normalised into a `DelegationEnvelope`.
 * @typedef {Object} SpawnDelegation
 * @property {'any'|Array<Object|string>} [agents]
 * @property {'fixed'|'any'} [models]
 * @property {'fixed'|'any'} [transports]
 * @property {'fixed'|'any'} [system]
 * @property {'fixed'|'inherit'} [tools]
 * @property {number} [maxDepth]
 * @property {number} [maxSpawns]
 */

/**
 * The registry for one transport client (created once).
 * @typedef {Object} SpawnRegistry
 * @property {Object} client
 * @property {Map<string, import('./task.mjs').TaskAgent>} agents
 * @property {Map<string, Object>} clients
 * @property {((provider: string) => import('./task.mjs').TaskClient|null|undefined)|null} resolver
 * @property {number} maxDepth
 * @property {number} counter
 * @property {number} spawnSeq
 * @property {Map<string, Promise<unknown>>} background
 * @property {SpawnDelegation|null} delegation
 * @property {string[]} legacyAdopted
 * @property {Map<string, SpawnRecord>} spawns
 */

/**
 * Registers the continuation implementation (task.mjs owns the step engine, so
 * the registry does not import it and create a cycle).
 * @param {{fn: SpawnContinuation}} arg0
 */
export function setSpawnContinuation({ fn }) {
    CONTINUE_IMPL = fn;
}

/**
 * A spawn's own spend, summed over its turns and attempts. The keys are the
 * ones the engine reports (`budgetUsage`), so a record reads like a run usage:
 * `prompt_tokens`, `completion_tokens`, `total_tokens`, the cache counters,
 * `cost_usd` when the backend reported one, and `estimated` when any turn had
 * to be estimated. SP4's tree pool (`getBudgetPool`) is the other half: this is
 * the child's ledger, the pool is the tree's.
 * @typedef {Object} SpawnUsage
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]
 * @property {number} [total_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [reasoning_tokens]
 * @property {number|null} [cost_usd]
 * @property {number} [estimated_tokens]
 * @property {boolean} [estimated]
 */

/**
 * @typedef {Object} SpawnRecord
 * @property {string} id
 * @property {string|null} parentId
 * @property {string[]} lineage
 * @property {string|null} treeRoot - The root id of the spawn tree (D9).
 * @property {number|null} treeIndex - This spawn's ordinal in its tree.
 * @property {{root: string|null, count: number}} tree - The shared tree counter.
 * @property {string|null} [threadId] - The durable thread when the host opted into
 *   a SessionStore (D10); null for an in-memory spawn or a code agent.
 * @property {string} [checkpointError] - Why the last durability write failed, if
 *   it did. A failed write never fails the spawn; the host reads this instead.
 * @property {string} agent
 * @property {string|null} model
 * @property {string|null} provider
 * @property {'running'|'done'|'error'} status
 * @property {unknown} result
 * @property {string|null} error
 * @property {SpawnUsage|null} usage
 * @property {SpawnSession|null} session
 * @property {string} createdAt
 * @property {string|null} finishedAt
 * @property {Promise<unknown>|null} promise
 * @property {Array<SpawnUsage>} [attempts] - One usage entry per attempt (a failed primary still spent).
 * @property {Array<SpawnSession>} [sessions] - Every child session an attempt built (hedge-safe usage).
 * @property {SpawnSession|null} [winner] - The attempt whose result the ladder kept.
 * @property {SpawnUsage|null} banked - Usage of closed turns.
 * @property {Set<SpawnSession>} bankedSessions - Sessions whose usage is already banked.
 * @property {import('./task.mjs').TaskAgent} [profile] - The profile a continuation re-runs with.
 * @property {import('./task.mjs').TaskEventEmitter|null} [eventEmitter] - Where continuation events are emitted.
 * @property {import('../core/events.mjs').RunContext|null} [runContext] - The spawning step's context; a continuation hangs off it (N5).
 * @property {SpawnSession|null} [parent] - The spawning session (for a background result row).
 * @property {number} [settles] - How many turns settled on this record.
 * @property {import('./task.mjs').TaskClient|null} [parentClient] - The transport client the spawn belongs to.
 * @property {Promise<unknown>} [turnQueue] - Continuation chain: one turn at a time per conversation.
 * @property {Array<Object>} [history] - The rows the last continuation sent.
 */

/**
 * @param {Object} client
 * @returns {SpawnRegistry}
 */
function makeRegistry(client) {
    /** @type {Map<string, SpawnRecord>} */
    const spawns = new Map();
    /** @type {SpawnRegistry} */
    const registry = {
        client,
        agents: new Map(),
        clients: new Map(),
        resolver: null,
        maxDepth: LIMITS.default_delegation_depth,
        counter: 0,
        // Spawn ids and background task ids are different sequences: a spawn id
        // names a record, a task id names an in-flight background call.
        spawnSeq: 0,
        /** @type {Map<string, Promise<any>>} */
        background: new Map(),
        delegation: null,
        /** @type {string[]} */
        legacyAdopted: [],
        spawns,
    };
    // SP5: the client holds no orchestration state. A host that preset a legacy
    // field before the registry existed keeps its data (adopted once), and the
    // field is deleted so the client goes back to being a transport.
    /** @type {string[]} */
    const adopted = [];
    for (const [name, field] of LEGACY_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(client, name);
        if (!descriptor) continue;
        const value = 'value' in descriptor ? descriptor.value : descriptor.get?.();
        if (value !== undefined) {
            /** @type {any} */ (registry)[field] = value;
            adopted.push(name);
        }
        try {
            delete /** @type {any} */ (client)[name];
        } catch {
            // A frozen/sealed client cannot be cleaned; the registry still is.
        }
    }
    registry.legacyAdopted = adopted;
    if (adopted.length > 0) {
        // A deprecation notice must be visible without `extended` logging.
        log.warn({ m: `[SDK] ${adopted.join(', ')} on the client is deprecated: it has been adopted into the spawn registry and removed from the client. `
            + 'The client is a transport — use withTaskAgents/withAgentDelegation, and getSpawnRegistry({client}) to read the state.' });
    }
    return registry;
}

/**
 * The registry for a client (created once). Accepts `{client}` or the client
 * itself — a bare client used to silently get a throwaway registry, which made
 * every read look empty.
 * @param {{client?: Object|null}|Object} [arg0]
 * @returns {SpawnRegistry}
 */
export function getSpawnRegistry(arg0 = {}) {
    const arg = /** @type {{client?: Object|null, session?: Function}} */ (arg0);
    const bare = arg && typeof arg === 'object' && typeof arg.session === 'function' && !('client' in arg);
    const client = bare ? arg : (arg?.client ?? null);
    if (!client || (typeof client !== 'object' && typeof client !== 'function')) return makeRegistry({});
    // A view shares the registry of the client it wraps: one roster per transport.
    const owner = baseClientOf({ client });
    if (owner !== client) return getSpawnRegistry({ client: owner });
    let registry = REGISTRIES.get(client);
    if (!registry) {
        registry = makeRegistry(client);
        REGISTRIES.set(client, registry);
    }
    return registry;
}

/** @param {{registry: any, prefix?: string}} arg0 */
function nextId({ registry, prefix = 'sub' }) {
    registry.spawnSeq = (registry.spawnSeq ?? 0) + 1;
    return `${prefix}_${registry.spawnSeq.toString(36).padStart(4, '0')}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Opens a spawn record. `parent` is the spawning session; its spawn id (or
 * session id) becomes `parentId`, and its lineage is extended by one.
 * @param {{registry: SpawnRegistry, parent?: SpawnSession|null, agent?: string, model?: string|null, provider?: string|null, prefix?: string}} arg0
 * @returns {SpawnRecord}
 */
export function openSpawn({ registry, parent = null, agent = 'custom', model = null, provider = null, prefix = 'sub' }) {
    const parentId = parent?._spawnId ?? parent?.sessionId ?? null;
    // A spawned parent already carries its own id at the end of its lineage; a
    // plain session contributes its conversation id exactly once.
    const parentLineage = parent?._spawnLineage;
    const lineage = (Array.isArray(parentLineage) && parentLineage.length > 0)
        ? [...parentLineage]
        : (parentId ? [String(parentId)] : []);
    // D9: the TREE is bounded, not just the depth. The counter is a shared object
    // carried by the sessions and the records of one tree, not a registry map: a
    // grandchild routed to another transport client still counts against the same
    // tree (a per-client map counted it twice), it survives settled-record
    // eviction, and it disappears with the tree instead of growing forever.
    /** @type {SpawnTree|null} */
    let tree = parent?._spawnTree ?? null;
    if (!tree) {
        tree = { root: lineage.length > 0 ? lineage[0] : null, count: 0 };
        // Stamp the root session too, so its next sibling joins the same tree.
        if (parent) parent._spawnTree = tree;
    }
    tree.count += 1;
    /** @type {SpawnRecord} */
    const record = {
        id: nextId({ registry, prefix }),
        parentId: parentId ? String(parentId) : null,
        lineage,
        treeRoot: tree.root,
        treeIndex: tree.count,
        tree: /** @type {SpawnTree} */ (tree),
        agent: String(agent),
        model: model ?? null,
        provider: provider ?? null,
        status: 'running',
        result: null,
        error: null,
        usage: null,
        session: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        settles: 0,
        promise: null,
        attempts: [],
        sessions: [],
        banked: null,
        bankedSessions: new Set(),
    };
    // `usage` is computed on read: a hedged loser reports its spend after the
    // winner settles, and a snapshot would lose it.
    /** @type {any} */
    let usageSnapshot = null;
    Object.defineProperty(record, 'usage', {
        get: () => settleUsage({ record }) ?? usageSnapshot,
        set: (/** @type {any} */ value) => { usageSnapshot = value; },
        enumerable: true,
        configurable: true,
    });
    // The parent session is needed to deliver a background result, but it must not
    // be enumerable: `listSpawns` must not expose the parent's conversation.
    Object.defineProperty(record, 'parent', { value: parent, writable: true, configurable: true, enumerable: false });
    registry.spawns.set(record.id, record);
    // Retention: a long-lived client must not accumulate child sessions forever.
    const retention = LIMITS.spawn_retention;
    if (registry.spawns.size > retention) {
        for (const [id, old] of registry.spawns) {
            if (registry.spawns.size <= retention) break;
            if (old.status !== 'running') registry.spawns.delete(id);
        }
    }
    return record;
}

/**
 * How many spawns this session's tree has already opened. The counter lives on a
 * shared tree object (see `openSpawn`), so every path and every transport sees
 * the same number.
 * @param {{session?: SpawnSession|null}} arg0
 * @returns {number}
 */
export function treeSpawnCount({ session = null } = {}) {
    return session?._spawnTree?.count ?? 0;
}

/**
 * Stamps a child session with its spawn identity, so a nested spawn knows its
 * parent and the lineage grows instead of restarting.
 * @template {SpawnSession} S
 * @param {{session: S, record: SpawnRecord}} arg0
 * @returns {S} the session
 */
export function adoptSpawnIdentity({ session, record }) {
    if (!session) return session;
    session._spawnId = record.id;
    session._spawnParentId = record.parentId;
    session._spawnLineage = [...record.lineage, record.id];
    session._spawnTree = record.tree;
    // The spawn owns its session (SP3 continues this exact session).
    record.session = session;
    return session;
}

/**
 * Sums the numeric usage fields of every attempt. A primary that spent tokens and
 * then failed still cost money, so a fallback's ledger is the sum, not the last.
 * @param {Array<SpawnUsage|null|undefined>} list
 * @returns {SpawnUsage|null}
 */
export function sumSpawnUsage(list) {
    const entries = /** @type {Array<SpawnUsage>} */ ((Array.isArray(list) ? list : []).filter((u) => u && typeof u === 'object'));
    if (entries.length === 0) return null;
    /** @type {Record<string, any>} */
    const total = {};
    let estimated = false;
    for (const usage of entries) {
        sumNumericUsage({ usage, into: total });
        if (usage.estimated === true || (usage.estimated_tokens ?? 0) > 0) estimated = true;
    }
    // The flag is a property of the sum, not a numeric field: a child whose
    // backend reported no usage must not read as exact just because the numbers
    // were summed.
    if (estimated) total.estimated = true;
    return Object.keys(total).length > 0 ? total : null;
}

/**
 * Remembers an attempt's session. Usage is read at settle time, not now: a
 * hedge builds the second attempt before the first reports its spend.
 * @param {{record: SpawnRecord, session?: SpawnSession|null}} arg0
 */
export function pushAttempt({ record, session }) {
    if (!session) return;
    const list = record.sessions ?? [];
    if (list.includes(session)) return;
    record.sessions = [...list, session];
}

/** @param {{record: SpawnRecord}} arg0 @returns {SpawnUsage|null} */
function settleUsage({ record }) {
    // Banked turns are closed; the rest are live (a hedged loser reports late, and
    // a continued session starts a new turn with fresh usage).
    /** @type {any[]} */
    const parts = record.banked ? [record.banked] : [];
    const banked = record.bankedSessions ?? new Set();
    for (const session of [...(record.sessions ?? []), record.session]) {
        if (!session || banked.has(session)) continue;
        if (session._lastRunUsage) parts.push(session._lastRunUsage);
    }
    return sumSpawnUsage(parts);
}

/** @param {{record: SpawnRecord}} arg0 */
function bankCurrentTurn({ record }) {
    const banked = record.bankedSessions ?? new Set();
    for (const session of record.sessions ?? []) {
        if (!session || banked.has(session) || !session._lastRunUsage) continue;
        record.banked = sumSpawnUsage([record.banked, session._lastRunUsage]);
        banked.add(session);
    }
    record.bankedSessions = banked;
}

/** @param {{record: SpawnRecord, result?: unknown, usage?: SpawnUsage|null}} arg0 */
export function finishSpawn({ record, result = null, usage = null }) {
    record.status = 'done';
    record.result = result;
    if (usage) record.attempts = [...(record.attempts ?? []), usage];
    // The record's session is the WINNING attempt, not the last one built: a
    // hedge builds both, and SP3 continues the winner.
    if (record.winner) record.session = record.winner;
    bankCurrentTurn({ record });
    record.usage = settleUsage({ record });
    record.finishedAt = new Date().toISOString();
    record.settles = (record.settles ?? 0) + 1;
    return record;
}

/** @param {{record: SpawnRecord, error: unknown}} arg0 */
export function failSpawn({ record, error }) {
    record.status = 'error';
    record.error = String((/** @type {any} */ (error))?.message ?? error);
    bankCurrentTurn({ record });
    record.usage = settleUsage({ record });
    record.finishedAt = new Date().toISOString();
    record.settles = (record.settles ?? 0) + 1;
    return record;
}

/**
 * The deterministic thread id a durable child is stored under (D10). A host can
 * rebuild it from the spawn id to resume in another process.
 * @param {{id: string}} arg0
 * @returns {string}
 */
export function spawnThreadId({ id }) {
    return threadIdFor({ kind: 'spawn', id });
}

/**
 * The handle a caller (or the model) receives: the identity plus a way to wait.
 * `continueWith` is SP3; the field is absent until then rather than a stub that
 * silently does nothing.
 * @typedef {Object} SpawnHandle
 * @property {string} id
 * @property {string|null} parentId
 * @property {string[]} lineage
 * @property {string} agent
 * @property {string|null} model
 * @property {string|null} provider
 * @property {'running'|'done'|'error'} status
 * @property {unknown} result
 * @property {string|null} error
 * @property {SpawnUsage|null} usage
 * @property {string} createdAt
 * @property {string|null} finishedAt
 * @property {number} settles
 * @property {string|null} threadId
 * @property {string|null} checkpointError
 * @property {SpawnSession|null} session
 * @property {() => Promise<unknown>} wait
 * @property {(arg0?: string|{prompt?: string, signal?: AbortSignal}) => Promise<Object>} continueWith
 */

/**
 * The handle a caller (or the model) receives: the identity plus a way to wait.
 * `continueWith` is SP3; the field is absent until then rather than a stub that
 * silently does nothing.
 * @param {{record: SpawnRecord, wait?: (() => Promise<unknown>)|null}} arg0
 * @returns {SpawnHandle}
 */
export function spawnHandle({ record, wait = null }) {
    /** @type {SpawnHandle} */
    const handle = {
        id: record.id,
        parentId: record.parentId,
        lineage: [...record.lineage, record.id],
        agent: record.agent,
        model: record.model,
        provider: record.provider,
        get status() { return record.status; },
        get result() { return record.result; },
        get error() { return record.error; },
        get usage() { return record.usage; },
        get createdAt() { return record.createdAt; },
        get finishedAt() { return record.finishedAt; },
        get settles() { return record.settles ?? 0; },
        get threadId() { return record.threadId ?? null; },
        get checkpointError() { return record.checkpointError ?? null; },
        get session() { return record.session; },
        wait: wait ?? (() => record.promise ?? Promise.resolve(record.result)),
        /** @param {string|{prompt?: string, signal?: any}} [arg0] */
        continueWith: (arg0 = {}) => {
            if (!CONTINUE_IMPL) throw new Error('spawn continuation is not wired');
            // Parity §3.2 documents the string form; both are accepted.
            const { prompt = '', signal = undefined } = typeof arg0 === 'string' ? { prompt: arg0 } : (arg0 ?? {});
            return CONTINUE_IMPL({ record, prompt: String(prompt), signal });
        },
    };
    return handle;
}

/**
 * Lists the spawns of a client, newest first.
 * @param {{client?: Object|null, status?: string, parentId?: string}} [arg0]
 * @returns {Array<SpawnHandle>}
 */
export function listSpawns({ client = null, status = undefined, parentId = undefined } = {}) {
    const registry = getSpawnRegistry({ client });
    return [...registry.spawns.values()]
        .filter((r) => (status === undefined || r.status === status))
        .filter((r) => (parentId === undefined || r.parentId === parentId))
        .map((r) => spawnHandle({ record: r }))
        .reverse();
}

/**
 * One spawn by id.
 * @param {{client?: Object|null, id: string}} arg0
 * @returns {SpawnHandle|null}
 */
export function getSpawn({ client = null, id }) {
    const record = getSpawnRegistry({ client }).spawns.get(String(id));
    return record ? spawnHandle({ record }) : null;
}
