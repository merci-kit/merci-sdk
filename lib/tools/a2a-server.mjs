// @ts-check


/**
 * @file A2A (Agent-to-Agent) server — A2A v1.0.0 peer.
 * @version 0.12.0
 *
 * @description
 * Exposes a Merci agent as an A2A peer: it publishes an agent card, answers the
 * A2A JSON-RPC method set (`SendMessage`, `SendStreamingMessage`, `GetTask`,
 * `ListTasks`, `CancelTask`) and keeps the task lifecycle the specification
 * defines (`submitted` → `working` → `completed` / `failed` / `canceled` /
 * `rejected`, plus the interrupted states `input-required` and `auth-required`).
 *
 * Both wire dialects are accepted: the v1.0 proto method names with protobuf-JSON
 * parts, and the v0.3 slash method names with `{"kind":"text"}` parts. The
 * response dialect follows the dialect of the request.
 *
 * Tenancy: `handle` takes the `principal` the HTTP layer resolved. A task
 * belongs to the principal that created it, `tasks/list` shows only that
 * principal's tasks, and a foreign task id reads as unknown (`-32001`). A send
 * that reuses an id answers `-32003` (another principal) or `-32002` (a run
 * still in flight); the owner may reuse a finished id, and continue an
 * interrupted one. Without a principal every task belongs to `null`, which is
 * the single-tenant peer.
 *
 * `-32003` is deliberately not `-32001`: the conflict tells the caller its own
 * id is taken, and a guessed id answers "in use" rather than "unknown", which
 * is a weak existence oracle for ids that are otherwise unguessable UUIDs. In
 * exchange, a finished id stays reserved to its tenant for the retention
 * window, so it cannot be recycled by anyone else until it expires.
 */
import { randomUUID } from 'node:crypto';
import { contextFromMerciEnvelope } from '../agentic/agent-context.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import {
    A2A_CONTENT_TYPE,
    A2A_METHODS,
    A2A_PROTOCOL_VERSION,
    A2A_ROLES,
    A2A_SSE_HEADERS,
    A2A_TASK_STATES,
    A2A_TERMINAL_STATES,
    A2A_VERSION_HEADER,
    SDK_VERSION,
    WELL_KNOWN_AGENT_CARD_PATH
} from '../core/constants/index.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { requestHostAllowed } from '../support/utils.mjs';
import { legacyState, partText, resolveDialect, rpcError, rpcResult } from './a2a-dialect.mjs';
/**
 * @typedef {Object} A2ASkill
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} [tags]
 * @property {string[]} [examples]
 * @property {Object} [inputSchema]
 * @property {(args: Record<string, unknown>, ctx: { signal?: AbortSignal|null, taskId?: string, contextId?: string, agentContext?: import('../agentic/agent-context.mjs').AgentContext|null }) => Promise<unknown>} execute
 */


/**
 * Reads the structured arguments a skill was called with, plus the skill
 * selector when the peer sent one. The first data part wins; otherwise the
 * text part is parsed as JSON.
 * @param {any} message
 * @returns {{ args: Record<string, any>, skillId: string }}
 */
function messageArgs({ message }) {
    /** @type {any[]} */
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const part of parts) {
        if (part && typeof part === 'object' && part.data !== undefined && part.kind !== 'text') {
            const data = typeof part.data === 'object' && part.data !== null ? part.data : { value: part.data };
            return { args: stripSkillId({ data }), skillId: String(data?.skillId ?? '') };
        }
        if (part && typeof part === 'object' && part.content && part.content.data !== undefined) {
            const data = typeof part.content.data === 'object' && part.content.data !== null ? part.content.data : { value: part.content.data };
            return { args: stripSkillId({ data }), skillId: String(data?.skillId ?? '') };
        }
    }
    const text = parts.map((p) => partText({ part: p })).filter(Boolean).join('\n');
    if (!text) return { args: {}, skillId: '' };
    try {
        const parsed = JSON.parse(text);
        return { args: stripSkillId({ data: parsed }), skillId: String(parsed?.skillId ?? '') };
    } catch {
        return { args: { value: text }, skillId: '' };
    }
}


/**
 * Removes the skill selector from the call arguments.
 * @param {{data: any}} arg0
 * @returns {Record<string, any>}
 */
function stripSkillId({ data }) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const { skillId, ...rest } = /** @type {Record<string, any>} */ (data);
    void skillId;
    return rest;
}


/**
 * Builds a message in the requested dialect.
 * @param {{ text: string, dialect: 'v1'|'legacy', messageId?: string, taskId?: string, contextId?: string }} arg0
 * @returns {Record<string, any>}
 */
function buildMessage({ text, dialect, messageId = randomUUID(), taskId = '', contextId = '' }) {
    const parts = dialect === 'legacy' ? [{ kind: 'text', text }] : [{ text }];
    return {
        messageId,
        contextId,
        taskId,
        role: dialect === 'legacy' ? 'agent' : A2A_ROLES.AGENT,
        parts
    };
}


/**
 * Creates an A2A server exposing the given skills.
 *
 * A skill's `execute` receives the call arguments and returns either a string
 * (the reply text) or `{ text, artifacts, state }` to control the task outcome.
 *
 * `maxTerminalTasks` bounds two different things: how many settled rows
 * (finished or `input-required`) are retained, and how many runs may be
 * admitted at once. A parked row therefore never denies a slot to other
 * callers.
 *
 * @param {{ name?: string, description?: string, version?: string, skills?: A2ASkill[], documentationUrl?: string, provider?: Object, inputModes?: string[], outputModes?: string[], now?: () => number, maxTerminalTasks?: number, taskRetentionMs?: number }} arg0
 * @returns {{ agentCard: (opts?: { baseUrl?: string }) => Record<string, unknown>, handle: (opts: { method: string, params?: unknown, id?: string|number|null, headers?: Record<string, string>, principal?: unknown }) => Promise<Record<string, unknown>|null>, listTasks: () => Array<Record<string, unknown>>, getTask: (opts: { id: string }) => Record<string, unknown>|null }}
 */
export function createA2AServer({
    name = 'merci-sdk',
    description = 'Merci SDK agent exposed over the Agent-to-Agent protocol.',
    version = SDK_VERSION,
    skills = [],
    documentationUrl = undefined,
    provider = undefined,
    inputModes = ['text/plain'],
    outputModes = ['text/plain'],
    now = () => Date.now(),
    maxTerminalTasks = LIMITS.a2a_terminal_tasks_max,
    taskRetentionMs = LIMITS.a2a_task_retention_ms
} = {}) {
    /** @type {Map<string, any>} */
    const tasks = new Map();
    /** @type {Map<string, AbortController>} */
    const controllers = new Map();
    /** @type {Map<string, number>} */
    const terminalAt = new Map();
    /**
     * The principal that created each task, in a side map so a serialized task
     * can never carry it. An absent entry and `null` are the same owner.
     * @type {Map<string, unknown>}
     */
    const owners = new Map();
    /** @type {Map<string, A2ASkill>} */
    const byId = new Map();
    for (const skill of skills) {
        const s = /** @type {Record<string, unknown>} */ (skill);
        byId.set(String(s.id ?? s.name ?? ''), skill);
    }

    /** @param {string|undefined} state */
    const isTerminalState = (state) => A2A_TERMINAL_STATES.includes(/** @type {any} */ (state));

    /**
     * The states that own a task id: a run is queued or executing. The
     * interrupted states (`input-required`, `auth-required`) are the protocol's
     * continuation handshake, not a live run, so the owner may take the id over.
     */
    const liveStates = [A2A_TASK_STATES.SUBMITTED, A2A_TASK_STATES.WORKING];

    /**
     * The states whose run is over: terminal, plus the interrupted ones, whose
     * skill returned and whose record is only kept so the client can continue
     * or read it. Settled rows are retention, so the same age/count prune
     * bounds both — a parked task cannot outlive its retention window.
     * @param {string|undefined} state
     * @returns {boolean}
     */
    const isSettledState = (state) => isTerminalState(state)
        || (state === A2A_TASK_STATES.INPUT_REQUIRED || state === A2A_TASK_STATES.AUTH_REQUIRED);

    /**
     * Drops every record of one task: the task, its owner, its terminal stamp
     * and its abort handle.
     * @param {string} taskId
     * @returns {void}
     */
    const forgetTask = (taskId) => {
        tasks.delete(taskId);
        owners.delete(taskId);
        terminalAt.delete(taskId);
        controllers.delete(taskId);
    };

    /**
     * Whether the caller may see or act on a task. A missing-and-foreign task
     * is the caller's problem to tell apart, so callers answer `-32001` for
     * both rather than disclosing that the id exists.
     * @param {{ taskId: string, principal: unknown }} arg0
     * @returns {boolean}
     */
    const ownsTask = ({ taskId, principal }) => (owners.get(taskId) ?? null) === (principal ?? null);

    /**
     * Drops expired settled tasks, then the oldest settled tasks above the
     * cap. A running task is never evicted, and a stale timestamp (an id the
     * client continued after it finished) is not a licence to evict.
     * @returns {void}
     */
    const pruneTasks = () => {
        const cutoff = now() - taskRetentionMs;
        for (const [id, at] of [...terminalAt]) {
            const task = tasks.get(id);
            if (!task) { terminalAt.delete(id); owners.delete(id); continue; }
            if (!isSettledState(task.status?.state)) { terminalAt.delete(id); continue; }
            if (at <= cutoff) {
                forgetTask(id);
            }
        }
        if (terminalAt.size <= maxTerminalTasks) return;
        const oldest = [...terminalAt.entries()].sort((a, b) => a[1] - b[1]);
        let excess = terminalAt.size - maxTerminalTasks;
        for (const [id] of oldest) {
            if (excess <= 0) break;
            forgetTask(id);
            excess -= 1;
        }
    };

    /**
     * Records a terminal transition and prunes.
     * @param {{id: string}} task
     * @returns {void}
     */
    const markTerminal = (task) => {
        terminalAt.set(task.id, now());
        pruneTasks();
    };

    /**
     * How many tasks are actually running. Only these count toward admission:
     * a finished or parked row is retention, kept for reading and continuing,
     * not a slot in use.
     * @returns {number}
     */
    const runningCount = () => {
        let running = 0;
        for (const task of tasks.values()) if (liveStates.includes(task.status?.state)) running += 1;
        return running;
    };

    /**
     * Makes room for one new task. The cap is on running work, so a store of
     * settled rows does not block a new run; when every slot is running, new
     * work is refused instead of growing without bound. Settled rows are bounded
     * by `pruneTasks`, not by admission.
     * @returns {boolean}
     */
    const hasCapacity = () => {
        pruneTasks();
        return runningCount() < maxTerminalTasks;
    };

    /**
     * @param {{ id: string, contextId: string, state: string, message: any, artifacts: any[], history: any[], skillId: string }} arg0
     * @returns {any}
     */
    const toTask = ({ id, contextId, state, message, artifacts, history, skillId }) => ({
        id,
        contextId,
        status: {
            state,
            message,
            timestamp: new Date().toISOString()
        },
        artifacts,
        history,
        metadata: skillId ? { skillId } : undefined
    });

    /**
     * Serializes a task in the dialect of the request.
     *
     * v1.0 returns the proto-JSON task (`status.state` is the uppercase proto
     * name). v0.3 returns the legacy task object (`kind: 'task'`, lowercase
     * state, `kind`-tagged parts).
     * @param {{ task: any, dialect: 'v1'|'legacy' }} arg0
     * @returns {any}
     */
    const serializeTask = ({ task, dialect }) => {
        if (dialect !== 'legacy') return task;
        /** @type {any[]} */
        const rawParts = task.status?.message?.parts ?? [];
        /** @type {any[]} */
        const rawArtifacts = task.artifacts ?? [];
        /** @type {any[]} */
        const rawHistory = task.history ?? [];
        return {
            kind: 'task',
            id: task.id,
            contextId: task.contextId,
            status: {
                state: legacyState({ state: task.status.state }),
                message: task.status.message
                    ? { ...task.status.message, role: 'agent', parts: rawParts.map((p) => ({ kind: 'text', text: p.text ?? '' })) }
                    : undefined,
                timestamp: task.status.timestamp
            },
            artifacts: rawArtifacts.map((a) => ({
                artifactId: a.artifactId,
                name: a.name,
                parts: /** @type {any[]} */ (a.parts ?? []).map((p) => ({ kind: 'text', text: p.text ?? '' }))
            })),
            history: rawHistory.map((m) => ({
                ...m,
                role: m.role === A2A_ROLES.USER ? 'user' : 'agent',
                parts: /** @type {any[]} */ (m.parts ?? []).map((p) => ({ kind: 'text', text: p.text ?? '' }))
            }))
        };
    };

    /**
     * @param {{ baseUrl?: string }} arg0
     * @returns {Record<string, any>}
     */
    const agentCard = ({ baseUrl = '' } = {}) => ({
        name,
        description,
        version,
        supportedInterfaces: [{
            url: `${baseUrl.replace(/\/$/, '')}/a2a`,
            protocolBinding: 'JSONRPC',
            protocolVersion: A2A_PROTOCOL_VERSION
        }],
        provider,
        documentationUrl,
        capabilities: { streaming: true, pushNotifications: false },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: inputModes,
        defaultOutputModes: outputModes,
        skills: skills.map((s) => ({
            id: s.id ?? s.name,
            name: s.name ?? s.id,
            description: s.description ?? '',
            tags: s.tags ?? [],
            examples: s.examples ?? [],
            inputModes,
            outputModes,
            securityRequirements: [],
            // The A2A AgentSkill has no input schema; publishing one as an
            // extension lets a client materialize a precise tool signature.
            ...(s.inputSchema ? { inputSchema: s.inputSchema } : {})
        })),
        signatures: []
    });

    /**
     * Runs one skill and completes the task.
     * @param {{ task: any, skill: A2ASkill, args: Record<string, any>, dialect: 'v1'|'legacy', agentContext?: any }} arg0
     * @returns {Promise<any>}
     */
    const runSkill = async ({ task, skill, args, dialect, agentContext = null }) => {
        const controller = new AbortController();
        // One controller per task id: the send path refuses a task id that is
        // still running, so this never replaces another run's abort handle.
        controllers.set(task.id, controller);
        try {
            const outcome = await skill.execute(args, { signal: controller.signal, taskId: task.id, contextId: task.contextId, agentContext });
            // A cancel that landed while the skill ran wins: the skill's own
            // result must not overwrite the terminal state.
            if (isTerminalState(task.status?.state)) return task;
            /** @type {{text?: unknown, state?: string, artifacts?: Array<Record<string, unknown>>}} */
            const envelope = /** @type {any} */ (outcome);
            const text = typeof outcome === 'string' ? outcome : String(envelope?.text ?? '');
            const state = envelope?.state ?? A2A_TASK_STATES.COMPLETED;
            task.status = {
                state,
                message: buildMessage({ text, dialect, taskId: task.id, contextId: task.contextId }),
                timestamp: new Date().toISOString()
            };
            if (Array.isArray(envelope?.artifacts)) {
                task.artifacts = envelope.artifacts.map((a, index) => ({
                    artifactId: a?.artifactId ?? `artifact-${index}`,
                    name: a?.name ?? `artifact-${index}`,
                    description: a?.description ?? '',
                    parts: [{ text: String(a?.text ?? '') }]
                }));
            }
        } catch (err) {
            if (isTerminalState(task.status?.state)) return task;
            task.status = {
                state: A2A_TASK_STATES.FAILED,
                message: buildMessage({ text: (/** @type {any} */ (err))?.message ?? String(err), dialect, taskId: task.id, contextId: task.contextId }),
                timestamp: new Date().toISOString()
            };
        } finally {
            controllers.delete(task.id);
        }
        tasks.set(task.id, task);
        if (isSettledState(task.status?.state)) markTerminal(task);
        return task;
    };

    /**
     * Handles one A2A JSON-RPC request.
     * @param {{ method: string, params?: any, id?: any, headers?: Record<string, any>, principal?: unknown }} arg0
     * @returns {Promise<any>}
     */
    const handle = async ({ method, params = {}, id = null, headers = {}, principal = null }) => {
        const caller = principal ?? null;
        const { dialect, op } = resolveDialect({ method });
        const message = params?.message ?? params;
        const { args, skillId: messageSkillId } = messageArgs({ message });
        // The client sends the merci envelope in `metadata.merci` (and `_merci`
        // for legacy peers); dropping it left the skill blind to the run's
        // objective/directive/refs. A malformed envelope is a client error, not
        // a crash: reject the request instead of rejecting the handler.
        let agentContext = null;
        try {
            agentContext = contextFromMerciEnvelope({ env: params?.metadata?.merci ?? params?._merci ?? null });
        } catch (err) {
            return rpcError({ id, code: -32602, message: `Invalid params: ${(/** @type {any} */ (err))?.message ?? String(err)}` });
        }
        // The skill selector travels in `metadata` (the A2A message itself has
        // no skill field); the first advertised skill is the fallback.
        const requestedSkill = String(params?.metadata?.skillId ?? params?.skillId ?? messageSkillId ?? '');

        if (op === A2A_METHODS.SEND_MESSAGE || op === A2A_METHODS.STREAM_MESSAGE) {
            const skill = byId.get(requestedSkill) ?? skills[0];
            if (!skill) {
                return rpcError({ id, code: -32601, message: 'This agent exposes no skills.' });
            }
            const taskId = String(message?.taskId ?? randomUUID());
            const contextId = String(message?.contextId ?? randomUUID());
            // A task id names one task of one principal. A stranger's id is a
            // conflict the caller must not resolve by guessing a new one, and a
            // live run is never overwritten by its own owner either: that would
            // drop the controller the run still needs to be cancelled with.
            const previous = tasks.get(taskId);
            if (previous) {
                if (!ownsTask({ taskId, principal: caller })) {
                    return rpcError({ id, code: -32003, message: `Task id already in use: ${taskId}` });
                }
                // A run in flight owns its id. The interrupted states are the
                // protocol's own continuation handshake (`needsInput` hands the
                // id back, the client answers it), so the owner may take those
                // over; it starts a fresh run for the same id.
                if (liveStates.includes(previous.status?.state)) {
                    return rpcError({ id, code: -32002, message: `Task ${taskId} is still running.` });
                }
            }
            // Capacity applies to every send that STARTS a run, including the
            // owner continuing a settled id: a parked row is retention, not a
            // slot, so continuing it must still find a free slot.
            if (!hasCapacity()) {
                return rpcError({ id, code: -32000, message: `Server is at capacity: ${runningCount()} tasks are running (max ${maxTerminalTasks}).` });
            }
            const task = toTask({
                id: taskId,
                contextId,
                state: A2A_TASK_STATES.WORKING,
                message: buildMessage({ text: '', dialect, taskId, contextId }),
                artifacts: [],
                history: message?.parts ? [message] : [],
                skillId: skill.id ?? skill.name
            });
            // Continuing an id that finished makes it live again: the old
            // terminal timestamp must not evict (and uncancel) the new run.
            terminalAt.delete(taskId);
            tasks.set(taskId, task);
            owners.set(taskId, caller);
            await runSkill({ task, skill, args, dialect, agentContext });
            if (op === A2A_METHODS.STREAM_MESSAGE) {
                // The A2A v1.0 event stream carries JSON-RPC responses whose
                // result is a `statusUpdate` (or `artifactUpdate`) event.
                const serialized = serializeTask({ task, dialect });
                return {
                    stream: true,
                    dialect,
                    taskId,
                    contextId,
                    events: [
                        rpcResult({
                            id,
                            result: {
                                statusUpdate: {
                                    taskId,
                                    contextId,
                                    status: dialect === 'legacy'
                                        ? { state: serialized.status.state, message: serialized.status.message, timestamp: serialized.status.timestamp }
                                        : task.status
                                }
                            }
                        }),
                        rpcResult({ id, result: { task: serialized } })
                    ]
                };
            }
            const serialized = serializeTask({ task, dialect });
            // v1.0 wraps the payload (`{ task }`); v0.3 returns the task object.
            return dialect === 'legacy' ? rpcResult({ id, result: serialized }) : rpcResult({ id, result: { task: serialized } });
        }

        if (op === A2A_METHODS.GET_TASK) {
            const taskId = String(params?.id ?? params?.taskId ?? '');
            const task = tasks.get(taskId);
            if (!task || !ownsTask({ taskId, principal: caller })) {
                return rpcError({ id, code: -32001, message: `Unknown task: ${taskId}` });
            }
            return rpcResult({ id, result: serializeTask({ task, dialect }) });
        }

        if (op === A2A_METHODS.LIST_TASKS) {
            pruneTasks();
            const all = [...tasks.values()].filter((t) => ownsTask({ taskId: t.id, principal: caller }));
            const filtered = params?.contextId ? all.filter((t) => t.contextId === params.contextId) : all;
            const rawPageSize = params?.pageSize;
            let pageSize = LIMITS.a2a_page_size;
            if (rawPageSize !== undefined && rawPageSize !== null && String(rawPageSize) !== '') {
                const parsedSize = Number(rawPageSize);
                if (!Number.isInteger(parsedSize) || parsedSize < 1) {
                    return rpcError({ id, code: -32602, message: `Invalid params: pageSize must be a positive integer, got "${rawPageSize}".` });
                }
                pageSize = Math.min(LIMITS.a2a_page_size_max, parsedSize);
            }
            let offset = 0;
            const rawToken = params?.pageToken;
            if (rawToken !== undefined && rawToken !== null && String(rawToken) !== '') {
                const parsed = Number(rawToken);
                if (!Number.isInteger(parsed) || parsed < 0) {
                    return rpcError({ id, code: -32602, message: `Invalid params: pageToken must be a non-negative integer, got "${rawToken}".` });
                }
                offset = parsed;
            }
            const page = filtered.slice(offset, offset + pageSize);
            return rpcResult({
                id,
                result: {
                    tasks: page.map((t) => serializeTask({ task: t, dialect })),
                    nextPageToken: offset + pageSize < filtered.length ? String(offset + pageSize) : ''
                }
            });
        }

        if (op === A2A_METHODS.CANCEL_TASK) {
            const taskId = String(params?.id ?? params?.taskId ?? '');
            const task = tasks.get(taskId);
            if (!task || !ownsTask({ taskId, principal: caller })) {
                return rpcError({ id, code: -32001, message: `Unknown task: ${taskId}` });
            }
            if (isTerminalState(task.status.state)) {
                return rpcError({ id, code: -32002, message: `Task ${taskId} already finished.` });
            }
            controllers.get(taskId)?.abort(new Error(`Task ${taskId} canceled.`));
            task.status = {
                state: A2A_TASK_STATES.CANCELED,
                message: task.status.message,
                timestamp: new Date().toISOString()
            };
            tasks.set(taskId, task);
            markTerminal(task);
            return rpcResult({ id, result: serializeTask({ task, dialect }) });
        }

        return rpcError({ id, code: -32601, message: `Method not found: ${method}` });
    };

    return {
        agentCard,
        handle,
        listTasks: () => [...tasks.values()],
        getTask: ({ id }) => tasks.get(String(id))
    };
}


/**
 * The headers an A2A JSON-RPC endpoint must answer with.
 * @type {Record<string, string>}
 */
export const A2A_RESPONSE_HEADERS = Object.freeze({
    'Content-Type': A2A_CONTENT_TYPE,
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION
});


/**
 * The headers an A2A streaming endpoint must answer with.
 * @type {Record<string, string>}
 */
export const A2A_STREAM_RESPONSE_HEADERS = Object.freeze({ ...A2A_SSE_HEADERS, [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION });


/**
 * The principal key the tenancy hook must produce.
 *
 * A task is matched to its owner by this value, so it has to be a key, not an
 * object: a decoded-claims object is a new value on every request and would
 * make a caller a stranger to its own tasks. A string is the contract; a number
 * is accepted and stringified. Anything else is a misconfigured hook, not a
 * tenant, and is reported as such rather than silently isolating every request.
 * @param {unknown} value
 * @returns {string}
 */
function principalKey(value) {
    const key = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof key !== 'string' || key.trim() === '') {
        throw new ConfigurationError({
            message: 'authorize must return a stable non-empty string principal; an object, a boolean or an empty value cannot be matched to a task.',
            options: { option: 'authorize' }
        });
    }
    return key;
}


/**
 * Mounts an A2A server on a `node:http` server.
 *
 * The handler answers:
 *   - `GET  /.well-known/agent-card.json` → the agent card of the given server
 *   - `POST <path>`                       → the A2A JSON-RPC method set; a
 *     streaming request is answered with an SSE stream of task updates
 *
 * `authorize({ req })` is the tenancy hook: it runs once per JSON-RPC request,
 * and its answer is the caller's principal key, which the server uses to own
 * and filter tasks. The key must be a non-empty string (a number is accepted and
 * stringified) and stable per caller — a decoded-claims object is rejected as a
 * misconfigured hook, because a fresh object on every request would make every
 * caller a stranger to its own tasks. A hook that throws is an authentication
 * refusal (`403`); a hook that answers no usable key is answered as a `500`
 * carrying the `ConfigurationError` message.
 *
 * @param {{ server: ReturnType<typeof createA2AServer>, path?: string, cardPath?: string, allowedHosts?: string[], allowAnyHost?: boolean, authorize?: ((arg0: { req: import('node:http').IncomingMessage }) => unknown|Promise<unknown>)|null }} arg0
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createA2AHttpHandler({ server, path = '/a2a', cardPath = WELL_KNOWN_AGENT_CARD_PATH, allowedHosts, allowAnyHost = false, authorize = null } = /** @type {{server: ReturnType<typeof createA2AServer>, path?: string, cardPath?: string, allowedHosts?: string[], allowAnyHost?: boolean, authorize?: ((arg0: { req: import('node:http').IncomingMessage }) => unknown|Promise<unknown>)|null}} */ ({})) {
    return async (/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res) => {
        const maxBodyBytes = LIMITS.a2a_request_max_body_bytes;
        if (!requestHostAllowed({ req, allowedHosts, allowAnyHost })) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rpcError({ id: null, code: -32000, message: 'Forbidden host.' })));
            return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === cardPath) {
            const host = req.headers?.host ?? '127.0.0.1';
            const card = server.agentCard({ baseUrl: `http://${host}` });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(card));
            return;
        }
        if (req.method !== 'POST' || url.pathname !== path) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rpcError({ id: null, code: -32601, message: 'Not found' })));
            return;
        }
        // The tenant boundary runs before the body is read: one call per
        // request, and a hook that throws is an authentication refusal (never a
        // rejected handler). A hook that answers something that cannot be a key
        // is a programming error in the host, answered as a 500 so it is not
        // mistaken for "this caller owns nothing".
        /** @type {string|null} */
        let principal = null;
        if (typeof authorize === 'function') {
            /** @type {unknown} */
            let answer;
            let denied = false;
            try {
                answer = await authorize({ req });
            } catch {
                denied = true;
            }
            if (denied) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(rpcError({ id: null, code: -32000, message: 'Forbidden.' })));
                return;
            }
            try {
                principal = principalKey(answer);
            } catch (err) {
                if (!(err instanceof ConfigurationError)) throw err;
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(rpcError({ id: null, code: -32603, message: err.message })));
                return;
            }
        }
        /** @type {any} */
        let rpc = {};
        try {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > maxBodyBytes) {
                    res.writeHead(413, A2A_RESPONSE_HEADERS);
                    res.end(JSON.stringify(rpcError({ id: null, code: -32000, message: `Payload Too Large: request body exceeds ${maxBodyBytes} bytes` })));
                    return;
                }
                chunks.push(chunk);
            }
            rpc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
            res.writeHead(200, A2A_RESPONSE_HEADERS);
            res.end(JSON.stringify(rpcError({ id: null, code: -32700, message: 'Parse error' })));
            return;
        }
        const result = await server.handle({ method: rpc.method, params: rpc.params, id: rpc.id, principal });
        /** @type {{stream?: boolean, events?: Array<Record<string, unknown>>}} */
        const streamed = /** @type {any} */ (result);
        if (streamed?.stream) {
            res.writeHead(200, A2A_STREAM_RESPONSE_HEADERS);
            for (const event of streamed.events ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
            res.end();
            return;
        }
        res.writeHead(200, A2A_RESPONSE_HEADERS);
        res.end(JSON.stringify(result));
    };
}
