// @ts-check


/**
 * @file A2A (Agent-to-Agent) remote tool loader — A2A v1.0.0 client.
 * @version 0.12.0
 *
 * @description
 * Loads a remote A2A agent's skills as SDK tool definitions and calls them over
 * the A2A JSON-RPC binding.
 *
 * Two wire dialects are supported, selected from the agent card:
 *
 *   - **v1.0** (the current spec): JSON-RPC methods are the proto names
 *     (`SendMessage`, `GetTask`, …), roles are `ROLE_USER`, task states are
 *     `TASK_STATE_COMPLETED`, and a message part is `{"text":"…"}`.
 *   - **v0.3** (still widely deployed): JSON-RPC methods are the slash names
 *     (`message/send`, `tasks/get`, …) and a message part is
 *     `{"kind":"text","text":"…"}`.
 *
 * The endpoint is pinned to the agent card's origin (SSRF guard, redirects
 * refused), every call is bounded by a timeout, and the response body is
 * read under a hard size ceiling.
 */
import { randomUUID } from 'node:crypto';
import {
    A2A_METHODS,
    A2A_PROTOCOL_VERSION,
    A2A_ROLES,
    A2A_TASK_STATES,
    A2A_TERMINAL_STATES,
    A2A_VERSION_HEADER,
    WELL_KNOWN_AGENT_CARD_PATH,
    JSON_RPC_VERSION
} from '../core/constants/index.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { A2A_RPC_METHODS, canonicalState, messageText } from './a2a-dialect.mjs';
import { flattenContent } from './tool-execution.mjs';
import { capToolOutput } from './external-capability.mjs';
import { merciEnvelope } from '../agentic/agent-context.mjs';
import { sdkWarn } from '../support/utils.mjs';
/**
 * @typedef {import('./tool-execution.mjs').ReadyTool} A2AToolDef
 * An A2A tool is a ready tool definition: name, description, JSON-Schema
 * parameters and an `execute` the loop can call.
 */


/**
 * Task states that mean "the peer is waiting for something from us".
 * @type {string[]}
 */
const A2A_INTERRUPTED_STATES = [A2A_TASK_STATES.INPUT_REQUIRED, A2A_TASK_STATES.AUTH_REQUIRED];


/**
 * Reads a response body under a hard size ceiling, without buffering an
 * oversized body: the stream is cancelled as soon as the cap is exceeded (a
 * missing or lying `content-length` cannot be used to force a full buffer).
 * @param {{response: Response, maxBytes?: number}} arg0 - Object containing the fetch Response.
 * @returns {Promise<any>}
 */
async function boundedJson({ response, maxBytes = LIMITS.a2a_max_body_bytes }) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`A2A response body exceeds ${maxBytes} bytes.`);
    }
    const body = /** @type {any} */ (response.body);
    if (!body || typeof body.getReader !== 'function') {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`A2A response body exceeds ${maxBytes} bytes.`);
        return JSON.parse(text);
    }
    const reader = body.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = /** @type {Uint8Array} */ (value);
            total += chunk.length;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {   });
                throw new Error(`A2A response body exceeds ${maxBytes} bytes.`);
            }
            chunks.push(chunk);
        }
    } finally {
        try { reader.releaseLock(); } catch {   }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(merged));
}


/**
 * Normalizes a raw task into the shape the SDK works with.
 * @param {{task: any, dialect: 'v1'|'legacy'}} arg0
 * @returns {{ state: string, taskId: string, contextId: string, text: string, artifacts: string[], raw: any }}
 */
function normalizeTask({ task, dialect }) {
    // Tolerant reader: a peer that answers with a bare payload instead of a
    // Task is treated as a completed task carrying that payload. Real A2A
    // peers always answer with a Task, so this only rescues sloppy peers.
    const looksLikeTask = Boolean(task && typeof task === 'object' && (task.status || task.kind === 'task' || task.id));
    if (!looksLikeTask) {
        const flat = flattenContent({ result: task });
        return {
            state: A2A_TASK_STATES.COMPLETED,
            taskId: '',
            contextId: '',
            text: typeof flat === 'string' ? flat : JSON.stringify(flat ?? ''),
            artifacts: [],
            raw: task
        };
    }
    const rawState = String(task?.status?.state ?? '');
    const state = canonicalState({ rawState });
    /** @type {any[]} */
    const rawArtifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
    const artifacts = rawArtifacts.map((a) => messageText({ message: { parts: a?.parts ?? [] } })).filter(Boolean);
    const text = [messageText({ message: task?.status?.message }), ...artifacts].filter(Boolean).join('\n');
    return {
        state,
        taskId: String(task?.id ?? ''),
        contextId: String(task?.contextId ?? ''),
        text,
        artifacts,
        raw: task
    };
}


/**
 * Unwraps the task from a JSON-RPC result.
 *
 * The v1.0 binding wraps the payload (`{ task }` or `{ message }`); the v0.3
 * binding returns the task object itself (tagged `kind: 'task'`).
 * @param {{ result: any, dialect: 'v1'|'legacy' }} arg0
 * @returns {any}
 */
function readTaskResult({ result, dialect }) {
    if (!result || typeof result !== 'object') return result;
    if (result.task) return result.task;
    if (result.message) {
        const message = result.message;
        return {
            id: String(message.taskId ?? ''),
            contextId: String(message.contextId ?? ''),
            status: { state: A2A_TASK_STATES.COMPLETED, message },
            artifacts: [],
            history: []
        };
    }
    return result;
}


/**
 * Resolves the RPC endpoint and the wire dialect from an agent card.
 * @param {{card: any, trustedOrigin: string}} arg0
 * @returns {{ url: string, dialect: 'v1'|'legacy' }}
 */
function resolveInterface({ card, trustedOrigin }) {
    /** @type {any[]} */
    const interfaces = Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : [];
    const jsonRpc = interfaces.find((i) => String(i?.protocolBinding ?? '').toUpperCase().includes('JSONRPC'))
        ?? interfaces[0];
    const declared = String(jsonRpc?.protocolVersion ?? card?.protocolVersion ?? '');
    // A v1.0 card declares its interfaces and their protocol version. A v0.3
    // card has no `supportedInterfaces` and only the flat `url` field.
    const dialect = declared.startsWith('0.')
        ? 'legacy'
        : (declared ? 'v1' : (interfaces.length === 0 && (card?.url || card?.endpoint) ? 'legacy' : 'v1'));
    const raw = jsonRpc?.url ?? card?.url ?? card?.endpoint ?? '';
    let url;
    try {
        url = new URL(raw, trustedOrigin);
    } catch {
        throw new Error(`A2A agent card advertises an invalid endpoint: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`A2A delegation endpoint must be an http(s) URL: ${raw}`);
    }
    if (url.origin !== trustedOrigin) {
        throw new Error(`A2A delegation endpoint ${url.origin} does not match the agent origin ${trustedOrigin}`);
    }
    return { url: url.href, dialect };
}


/**
 * Performs one A2A JSON-RPC call.
 * @param {{ url: string, dialect: 'v1'|'legacy', method: string, params: any, headers: Record<string, string>, signal: AbortSignal|null, timeoutMs: number, id?: string }} arg0
 * @returns {Promise<any>}
 */
async function a2aRpc({ url, dialect, method, params, headers, signal, timeoutMs, id = randomUUID() }) {
    const rpcMethod = A2A_RPC_METHODS[dialect][method] ?? method;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`A2A call timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
                ...headers
            },
            body: JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method: rpcMethod, params }),
            signal: controller.signal,
            redirect: 'error'
        });
        if (!response.ok) throw new Error(`A2A call failed: HTTP ${response.status}`);
        const payload = await boundedJson({ response });
        if (payload?.error) {
            const err = /** @type {any} */ (new Error(String(payload.error?.message ?? 'A2A remote error')));
            err.code = payload.error?.code;
            err.data = payload.error?.data;
            throw err;
        }
        return payload?.result;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}


/**
 * Reads an SSE stream of A2A events and returns the final task.
 * @param {{ response: Response, dialect: 'v1'|'legacy', onUpdate?: ((task: any) => void)|null }} arg0
 * @returns {Promise<any>}
 */
async function readA2AStream({ response, dialect, onUpdate = null }) {
    const body = /** @type {any} */ (response.body);
    if (!body || typeof body.getReader !== 'function') {
        const text = await response.text();
        throw new Error('A2A streaming response has no readable body.');
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** @type {any} */
    let lastTask = null;
    /** @type {string[]} */
    const artifactText = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    let event;
                    try { event = JSON.parse(data); } catch { continue; }
                    // The A2A v1.0 event stream carries JSON-RPC responses whose
                    // result is a `statusUpdate`, an `artifactUpdate` or a final
                    // `task`. The legacy (v0.3) stream carries the event fields
                    // at the top level.
                    const result = event?.result;
                    const statusUpdate = result?.statusUpdate ?? result?.status_update;
                    const artifactUpdate = result?.artifactUpdate ?? result?.artifact_update;
                    const finalTask = result?.task;
                    const params = result ?? event?.params ?? event;
                    const status = statusUpdate?.status ?? params?.status;
                    if (status) {
                        lastTask = {
                            id: statusUpdate?.taskId ?? params?.taskId ?? lastTask?.id ?? '',
                            contextId: statusUpdate?.contextId ?? params?.contextId ?? lastTask?.contextId ?? '',
                            status,
                            artifacts: lastTask?.artifacts ?? []
                        };
                    }
                    const artifact = artifactUpdate?.artifact ?? params?.artifact;
                    if (artifact) {
                        artifactText.push(messageText({ message: { parts: artifact.parts ?? [] } }));
                        lastTask = { ...(lastTask ?? {}), artifacts: [...(lastTask?.artifacts ?? []), artifact] };
                    }
                    if (finalTask) {
                        lastTask = { ...finalTask, artifacts: [...(finalTask.artifacts ?? []), ...(lastTask?.artifacts ?? [])] };
                    }
                    if (onUpdate && lastTask) onUpdate(lastTask);
                }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch {   }
    }
    if (lastTask && artifactText.length) {
        lastTask.artifacts = [...(lastTask.artifacts ?? []), { parts: [{ text: artifactText.join('\n') }] }];
    }
    return lastTask;
}


/**
 * Adds the two continuation fields to a skill's advertised input schema, so a
 * caller can pass back the `taskId`/`contextId` a `needsInput` result returned.
 * A non-object schema is left untouched.
 * @param {{schema: any}} arg0
 * @returns {any}
 */
function withContinuationFields({ schema }) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
    if (schema.type !== 'object' && !schema.properties) return schema;
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    return {
        ...schema,
        properties: {
            ...properties,
            ...(properties.taskId ? {} : { taskId: { type: 'string', description: 'Continue an existing task id (from a needsInput result).' } }),
            ...(properties.contextId ? {} : { contextId: { type: 'string', description: 'The context id of the task being continued.' } }),
        },
    };
}

/**
 * (returns []) when the agent card cannot be loaded or the URL is invalid.
 * @param {{agentUrl: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, agentContext?: Object|null, headers?: Object|null, timeoutMs?: number}} arg0 - Base agent URL, or a direct card URL ending in .json.
 *   inline as `params._merci` (unknown-field-tolerant peers ignore it).
 *   sent on the card fetch and every RPC POST (e.g. `{ Authorization: 'Bearer …' }`).
 * @returns {Promise<A2AToolDef[]>}
 */
export async function loadA2ATool({ agentUrl, eventEmitter = null, agentContext = null, headers = null, timeoutMs = LIMITS.a2a_timeout_ms }) {
    const ee =  (eventEmitter);
    
    /** @type {(name: string, payload: any, runContext?: any) => void} */
        /** @param {{name: *, payload: *, runContext?: *}} arg0 */
        /** @param {{name: *, payload: *, runContext?: *}} arg0 */
        const emit = ({ name, payload, runContext = null }) => {
        emitEvent({ emitter: /** @type {any} */ (ee), name, payload, runContext });
    };
    // `headers` may be a plain map or a `Headers`-like object (its `entries()` is
    // what gets normalized); neither shape is published, so it stays `Object`.
    const headerBag = /** @type {{entries?: () => Iterable<[string, string]>}} */ (headers ?? {});
    const normalizedHeaders = headers && typeof headerBag.entries === 'function'
        ? Object.fromEntries(headerBag.entries())
        : /** @type {Record<string, string>|null} */ (headers ?? null);
    try {
        const cardUrl = agentUrl.endsWith('.json') ? agentUrl : `${agentUrl.replace(/\/$/, '')}${WELL_KNOWN_AGENT_CARD_PATH}`;
        const response = await fetch(cardUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', ...(normalizedHeaders ? { headers: normalizedHeaders } : {}) });
        if (!response.ok) throw new Error(`Failed to load A2A card: ${response.status}`);
        const card =  (await boundedJson({ response }));
        
        const capabilities =  (Array.isArray(card.skills) ? card.skills
            : (Array.isArray(card.capabilities) ? card.capabilities : []));
        let trustedOrigin;
        try {
            trustedOrigin = new URL(agentUrl).origin;
        } catch {
            throw new Error(`A2A agent URL is not a valid URL: ${agentUrl}`);
        }
        const { url: rpcUrl, dialect } = resolveInterface({ card, trustedOrigin });
        const supportsStreaming = Boolean(card?.capabilities?.streaming ?? card?.capabilities?.streaming === true);
        emit({ name: EVENTS.A2A.CARD_LOADED, payload: { url: cardUrl, toolCount: capabilities.length, dialect } });
        return capabilities.map(/** @type {(...args: any[]) => any} */ ((cap) => ( ({
            name: cap.id ?? cap.name,
            description: cap.description || `Delegates task '${cap.id ?? cap.name}' to remote A2A agent.`,
            parameters: withContinuationFields({ schema: cap.inputSchema ?? cap.parameters ?? { type: 'object', properties: {}, additionalProperties: true } }),
            /** @param {{args: *, signal: *, context?: *}} arg0 */
            execute: async ({ args, signal, context = {} }) => {
                const rc = context?.runContext ?? null;
                const env = merciEnvelope({ ctx: context?.agentContext ?? agentContext });
                /** @type {Record<string, any>} */
                                if (context?.idempotencyKey)  (env).idempotencyKey = context.idempotencyKey;
                // The call arguments travel in the message; the envelope travels
                // alongside them (see the request params below).
                const params = args ?? {};
                // A `needsInput` result hands back a taskId/contextId: passing
                // them again continues that task instead of opening a new one.
                const continueTaskId = typeof params.taskId === 'string' && params.taskId.length > 0 ? params.taskId : undefined;
                const continueContextId = typeof params.contextId === 'string' && params.contextId.length > 0 ? params.contextId : undefined;
                /** @type {string|null} */
                let knownTaskId = continueTaskId ?? null;
                const id = randomUUID();
                const skillId = String(cap.id ?? cap.name ?? '');
                const method = A2A_METHODS.SEND_MESSAGE;
                emit({ name: EVENTS.A2A.DELEGATE_START, payload: { url: agentUrl, method, id }, runContext: rc });
                const timeoutController = new AbortController();
                const timeoutId = setTimeout(() => timeoutController.abort(new Error(`A2A delegation timed out after ${timeoutMs}ms`)), timeoutMs);
                const toAbortError = () => {
                    if (signal?.reason instanceof Error) {
                        if (signal.reason.name === 'AbortError') return signal.reason;
                        const wrapped = new Error(signal.reason.message || 'Aborted');
                        wrapped.name = 'AbortError';
                        wrapped.cause = signal.reason;
                        return wrapped;
                    }
                    const fallback = new Error(typeof signal?.reason === 'string' ? signal.reason : 'Aborted');
                    fallback.name = 'AbortError';
                    return fallback;
                };
                const onSignalAbort = () => timeoutController.abort(toAbortError());
                if (signal) {
                    if (signal.aborted) onSignalAbort();
                    else signal.addEventListener('abort', onSignalAbort, { once: true });
                }
                try {
                    const parts = dialect === 'legacy'
                        ? (params && typeof params === 'object'
                            ? [{ kind: 'text', text: JSON.stringify(params) }, { kind: 'data', data: params }]
                            : [{ kind: 'text', text: String(params ?? '') }])
                        : (params && typeof params === 'object'
                            ? [{ text: JSON.stringify(params) }, { data: params }]
                            : [{ text: String(params ?? '') }]);
                    const message = {
                        messageId: randomUUID(),
                        role: dialect === 'legacy' ? 'user' : A2A_ROLES.USER,
                        parts,
                        ...(continueTaskId ? { taskId: continueTaskId } : {}),
                        ...(continueContextId ? { contextId: continueContextId } : {})
                    };
                    const envelope = Object.keys(env).length > 0 ? env : null;
                    // One request shape for both the blocking and the streaming
                    // call, so the skill selector and the envelope cannot drift.
                    const requestParams = {
                        message,
                        // v1.0 spells "wait for the task" as `returnImmediately:
                        // false`; v0.3 spells it `blocking: true`.
                        configuration: dialect === 'legacy' ? { blocking: true } : { returnImmediately: false },
                        // `metadata` carries the skill selector (A2A has no skill
                        // field) and the merci envelope; `_merci` keeps the
                        // envelope readable for legacy peers.
                        metadata: { ...(envelope ? { merci: envelope } : {}), skillId },
                        ...(envelope ? { _merci: envelope } : {})
                    };
                    let rawTask;
                    if (supportsStreaming) {
                        const response = await fetch(rpcUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Accept: 'text/event-stream',
                                [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
                                ...(normalizedHeaders ?? {})
                            },
                            body: JSON.stringify({
                                jsonrpc: JSON_RPC_VERSION,
                                id,
                                method: A2A_RPC_METHODS[dialect][A2A_METHODS.STREAM_MESSAGE],
                                params: requestParams
                            }),
                            signal: timeoutController.signal,
                            redirect: 'error'
                        });
                        if (!response.ok) throw new Error(`A2A delegation failed: HTTP ${response.status}`);
                        rawTask = await readA2AStream({
                            response,
                            dialect,
                            onUpdate: (task) => {
                                if (task?.id) knownTaskId = task.id;
                                emit({ name: EVENTS.A2A.STREAM_UPDATE, payload: { url: agentUrl, id, state: task?.status?.state }, runContext: rc });
                            }
                        });
                    }
                    if (!rawTask) {
                        const raw = await a2aRpc({
                            url: rpcUrl,
                            dialect,
                            method,
                            params: requestParams,
                            headers: normalizedHeaders ?? {},
                            signal: timeoutController.signal,
                            timeoutMs,
                            id
                        });
                        rawTask = readTaskResult({ result: raw, dialect });
                    }
                    let normalized = normalizeTask({ task: rawTask, dialect });
                    if (normalized.taskId) knownTaskId = normalized.taskId;
                    if (normalized.state === A2A_TASK_STATES.SUBMITTED || normalized.state === A2A_TASK_STATES.WORKING) {
                        normalized = await pollTask({ rpcUrl, dialect, taskId: normalized.taskId, headers: normalizedHeaders ?? {}, signal: timeoutController.signal, timeoutMs, deadline: Date.now() + timeoutMs });
                    }
                    emit({ name: EVENTS.A2A.DELEGATE_END, payload: { url: agentUrl, method, id, ok: true, state: normalized.state }, runContext: rc });
                    if (A2A_INTERRUPTED_STATES.includes(normalized.state)) {
                        return {
                            success: false,
                            error: normalized.state === A2A_TASK_STATES.AUTH_REQUIRED
                                ? 'The remote A2A agent requires authentication before it can continue.'
                                : 'The remote A2A agent requires additional input before it can continue.',
                            needsInput: normalized.state === A2A_TASK_STATES.INPUT_REQUIRED,
                            needsAuth: normalized.state === A2A_TASK_STATES.AUTH_REQUIRED,
                            taskId: normalized.taskId,
                            contextId: normalized.contextId,
                            prompt: normalized.text
                        };
                    }
                    if (normalized.state !== A2A_TASK_STATES.COMPLETED) {
                        const reason = normalized.text || `the remote A2A task ended in state ${normalized.state}`;
                        throw new Error(`A2A task ${normalized.taskId || '(unknown)'} did not complete: ${reason}`);
                    }
                    const flat = flattenContent({ result: normalized.text });
                    return capToolOutput({ text: typeof flat === 'string' ? flat : JSON.stringify(flat), maxLength: LIMITS.a2a_output_max_chars });
                } catch (err) {
                    const timedOut = timeoutController.signal.aborted && !signal?.aborted;
                    // A cancellation or deadline leaves the remote task running:
                    // tell the peer to stop, best effort, so it is not orphaned.
                    if (timeoutController.signal.aborted && knownTaskId) {
                        try {
                            await cancelA2ATask({ agentUrl, taskId: knownTaskId, headers: normalizedHeaders ?? {}, timeoutMs: Math.min(timeoutMs, LIMITS.a2a_cancel_budget_ms), dialect });
                        } catch {   }
                    }
                    if (timedOut) emit({ name: EVENTS.A2A.DELEGATE_TIMEOUT, payload: { url: agentUrl, method, id }, runContext: rc });
                    else emit({ name: EVENTS.A2A.DELEGATE_ERROR, payload: { url: agentUrl, method, id, error: ( (/** @type {any} */ (err)))?.message ?? String(err) }, runContext: rc });
                    throw err;
                } finally {
                    clearTimeout(timeoutId);
                    if (signal) signal.removeEventListener('abort', onSignalAbort);
                }
            }
        }))));
    } catch (e) {
        sdkWarn({ prefix: 'A2A', args: [`Failed to load agent card from ${agentUrl}: ${( (/** @type {any} */ (e)))?.message ?? String(e)}`] });
        emit({ name: EVENTS.A2A.CARD_ERROR, payload: { url: agentUrl, error: ( (/** @type {any} */ (e)))?.message ?? String(e) } });
        return [];
    }
}


/**
 * Polls a task until it leaves the submitted/working states.
 * @param {{ rpcUrl: string, dialect: 'v1'|'legacy', taskId: string, headers: Record<string, string>, signal: AbortSignal, timeoutMs: number, deadline: number }} arg0
 * @returns {Promise<{ state: string, taskId: string, contextId: string, text: string, artifacts: string[], raw: any }>}
 */
async function pollTask({ rpcUrl, dialect, taskId, headers, signal, timeoutMs, deadline }) {
    /** @type {any} */
    let last = { state: A2A_TASK_STATES.WORKING, taskId, contextId: '', text: '', artifacts: [], raw: null };
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(LIMITS.a2a_poll_max_ms, Math.max(LIMITS.a2a_poll_min_ms, deadline - Date.now()))));
        if (signal?.aborted) break;
        const raw = await a2aRpc({
            url: rpcUrl,
            dialect,
            method: A2A_METHODS.GET_TASK,
            params: { id: taskId },
            headers,
            signal,
            timeoutMs: Math.max(1000, deadline - Date.now())
        });
        last = normalizeTask({ task: readTaskResult({ result: raw, dialect }), dialect });
        if (last.state !== A2A_TASK_STATES.SUBMITTED && last.state !== A2A_TASK_STATES.WORKING) return last;
    }
    // A cancelled poll is a cancellation, not a task that ended in WORKING:
    // the caller must see the abort (and may then cancel the remote task).
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
    return last;
}


/**
 * Cancels a remote A2A task.
 * @param {{ agentUrl: string, taskId: string, headers?: Record<string, string>, timeoutMs?: number, dialect?: 'v1'|'legacy' }} arg0
 * @returns {Promise<boolean>} true when the peer acknowledged the cancellation.
 */
export async function cancelA2ATask({ agentUrl, taskId, headers = {}, timeoutMs = LIMITS.a2a_timeout_ms, dialect = undefined }) {
    const cardUrl = agentUrl.endsWith('.json') ? agentUrl : `${agentUrl.replace(/\/$/, '')}${WELL_KNOWN_AGENT_CARD_PATH}`;
    const response = await fetch(cardUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', ...(headers ? { headers } : {}) });
    if (!response.ok) throw new Error(`Failed to load A2A card: ${response.status}`);
    const card = await boundedJson({ response });
    const trustedOrigin = new URL(agentUrl).origin;
    const { url: rpcUrl, dialect: detected } = resolveInterface({ card, trustedOrigin });
    const result = await a2aRpc({
        url: rpcUrl,
        dialect: detected,
        method: A2A_METHODS.CANCEL_TASK,
        params: { id: taskId },
        headers,
        signal: null,
        timeoutMs
    });
    const normalized = normalizeTask({ task: readTaskResult({ result, dialect: detected }), dialect: detected });
    return normalized.state === A2A_TASK_STATES.CANCELED;
}


/**
 * Reads a remote A2A task by id.
 * @param {{ agentUrl: string, taskId: string, headers?: Record<string, string>, timeoutMs?: number }} arg0
 * @returns {Promise<{ state: string, taskId: string, contextId: string, text: string, artifacts: string[] }>}
 */
export async function getA2ATask({ agentUrl, taskId, headers = {}, timeoutMs = LIMITS.a2a_timeout_ms }) {
    const cardUrl = agentUrl.endsWith('.json') ? agentUrl : `${agentUrl.replace(/\/$/, '')}${WELL_KNOWN_AGENT_CARD_PATH}`;
    const response = await fetch(cardUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', ...(headers ? { headers } : {}) });
    if (!response.ok) throw new Error(`Failed to load A2A card: ${response.status}`);
    const card = await boundedJson({ response });
    const trustedOrigin = new URL(agentUrl).origin;
    const { url: rpcUrl, dialect } = resolveInterface({ card, trustedOrigin });
    const raw = await a2aRpc({
        url: rpcUrl,
        dialect,
        method: A2A_METHODS.GET_TASK,
        params: { id: taskId },
        headers,
        signal: null,
        timeoutMs
    });
    return normalizeTask({ task: readTaskResult({ result: raw, dialect }), dialect });
}


/**
 * The A2A task states that mean the task has ended, whichever dialect spelled it.
 *
 * Frozen: it is a shared export, and a consumer that mutated it would change
 * the answer for every other consumer in the process.
 * @type {readonly string[]}
 */
export const A2A_COMPLETED_STATES = Object.freeze([...A2A_TERMINAL_STATES]);
