// @ts-check


/**
 * @file ACP (Agent Client Protocol) adapter — merci as the AGENT side.
 * @version 0.12.0
 *
 * @description
 * Exposes a merci ChatSession over the Agent Client Protocol so a code editor
 * (the ACP *client*) can drive it. Built on @agentclientprotocol/sdk (v1
 * schema; `session/fork` lives in the package's `/unstable` entry point).
 *
 * The agent side of ACP v1 is implemented in full:
 *
 *   - `initialize` and `authenticate` negotiate the protocol.
 *   - `session/new`, `session/load`, `session/list`, `session/delete` and
 *     `session/fork` manage sessions. With `createSession` every ACP id gets its
 *     own merci session (a fork passes `parentSessionId`, so the factory decides
 *     what the branch inherits); with a single `session` every id shares it and
 *     prompts run one at a time. `loadSession` is advertised **false** either
 *     way: the agent keeps no transcript to replay on a load.
 *   - `session/prompt` runs a turn and reports every delta as a
 *     `session/update` notification (message chunks, thought chunks, tool
 *     calls and plan entries).
 *   - `session/cancel` interrupts the running turn.
 *
 * The client side of ACP is reachable through the hooks the caller supplies:
 * `permissions` (a tool asks the user), `elicit` (structured user input),
 * `readFile` / `writeFile` (the editor's filesystem) and `createTerminal` /
 * `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal`
 * (the editor's terminal: `terminal/create|output|wait_for_exit|kill|release`).
 * Every hook is optional: a capability the client did not advertise is never
 * called. The terminal methods do not implement a shell tool themselves — they
 * are the bridge a caller's tools use, so a session that needs a shell runs it
 * on the editor's side when the editor offers one.
 */
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable';
import { ConfigurationError } from '../core/errors.mjs';
import { SDK_VERSION } from '../core/constants/index.mjs';
import { fallbackKind } from './agentic-core.mjs';
import { contextFromMerciEnvelope } from './agent-context.mjs';
/**
 * A permission request the agent sends the client.
 * @typedef {Object} AcpPermissionRequest
 * @property {Object} [toolCall] - The ACP tool call the permission is for.
 * @property {unknown} [input] - Shorthand for the tool call's raw input.
 * @property {Array<Object>} [options] - The choices the client may pick.
 */

/**
 * An elicitation (structured user input) request.
 * @typedef {Object} AcpElicitRequest
 * @property {string} [message]
 * @property {Object} [schema] - The requested answer shape.
 */

/**
 * A terminal-create request (the editor runs the command).
 * @typedef {Object} AcpTerminalCreateRequest
 * @property {string} command
 * @property {string[]} [args]
 * @property {Array<{name: string, value: string}>} [env]
 * @property {string|null} [cwd]
 * @property {number|null} [outputByteLimit]
 */

/**
 * The client-side methods an ACP turn may call: permission, elicitation, the
 * editor's filesystem and terminal. Each takes the protocol's own params.
 * @typedef {Object} AcpClientBridge
 * @property {string} sessionId
 * @property {Object} client - The connected ACP client.
 * @property {(opts: AcpPermissionRequest) => Promise<unknown>} requestPermission
 * @property {(opts: AcpElicitRequest) => Promise<unknown>} elicit
 * @property {(opts: Object) => Promise<unknown>} readFile
 * @property {(opts: Object) => Promise<unknown>} writeFile
 * @property {(opts: AcpTerminalCreateRequest) => Promise<unknown>} createTerminal
 * @property {(opts: {terminalId: string}) => Promise<unknown>} terminalOutput
 * @property {(opts: {terminalId: string}) => Promise<unknown>} waitForTerminalExit
 * @property {(opts: {terminalId: string}) => Promise<unknown>} killTerminal
 * @property {(opts: {terminalId: string}) => Promise<unknown>} releaseTerminal
 */

/**
 * The merci session an ACP agent drives.
 * @typedef {Object} MerciAcpSession
 * @property {(arg0: {initialInput: string, options?: {signal?: AbortSignal, onEvent?: ((e: Object) => void)|null}}) => Promise<unknown>} run
 * @property {Object|null} [_agentContext] - The context an ACP prompt carries in its `_meta.merci` envelope.
 */

/**
 * Builds the merci session one ACP id drives: tools, model, memory and
 * policy are the factory's to choose (a fork passes the ACP id it branches
 * from as `parentSessionId`, and is built when `session/fork` is answered).
 * @typedef {(arg0: {sessionId: string, cwd: string, parentSessionId: string|null}) => MerciAcpSession|Promise<MerciAcpSession>} AcpSessionFactory
 */

/**
 * The per-turn client bridge hook. It may return a cleanup function, called
 * when the turn ends, so a caller that installs the bridge globally can
 * restore what it replaced.
 * @typedef {(opts: AcpClientBridge) => (void|(() => void))} AcpTurnContextHook
 */



/** merci version advertised in the ACP initialize handshake. */
export const ACP_AGENT_VERSION = SDK_VERSION;

/** The ACP prompt stop reasons. */
export const ACP_STOP_REASONS = Object.freeze({
    END_TURN: 'end_turn',
    MAX_TOKENS: 'max_tokens',
    REFUSAL: 'refusal',
    CANCELLED: 'cancelled'
});


/**
 * Decides whether an ACP `session/request_permission` response grants the
 * permission. The client selects one of the options the agent offered (or
 * cancels), so the granted kind is the kind of the selected option.
 *
 * @param {{response?: {outcome?: {outcome?: string, optionId?: string}}|null, options?: Array<{optionId?: string, kind?: string}>}} arg0
 * @returns {boolean}
 */
export function permissionAllowed({ response, options = [] } = {}) {
    const decision = response?.outcome;
    if (!decision) return false;
    if (decision.outcome === 'cancelled') return false;
    if (decision.outcome !== 'selected') return false;
    // The selected option must be one the agent actually offered: an unknown
    // option id is a refusal, never an allowance.
    const selected = options.find((o) => o?.optionId === decision.optionId);
    if (!selected) return false;
    const kind = String(selected.kind ?? '');
    return kind === '' ? false : kind.startsWith('allow');
}


/** @param {{blocks: *}} arg0 */
function promptText({ blocks }) {
    if (!Array.isArray(blocks)) return '';
    return blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}


/**
 * Turns the session's stream events into ACP `session/update` notifications.
 *
 * @param {{ ctx: any, sessionId: string, messageId: string, toolCallIds: Map<string, string> }} arg0
 * @returns {(event: any) => void}
 */
function createUpdateEmitter({ ctx, sessionId, messageId, toolCallIds }) {
    /** @type {Array<Promise<any>>} */
    const pending = [];
    /**
     * @param {any} update
     * @returns {void}
     */
    const notify = (update) => {
        pending.push(ctx.client.notify(methods.client.session.update, { sessionId, update }));
    };

    return (event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'text' && event.content) {
            notify({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: event.content },
                messageId
            });
            return;
        }
        if ((event.type === 'thought' || event.type === 'reasoning') && event.content) {
            notify({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: event.content },
                messageId
            });
            return;
        }
        if (event.type === 'tool_call' || event.type === 'tool_call_start') {
            const toolCallId = String(event.tool_call_id ?? event.id ?? `tool_${pending.length}`);
            toolCallIds.set(toolCallId, String(event.name ?? 'tool'));
            notify({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: String(event.name ?? 'tool'),
                kind: event.kind ?? 'other',
                status: 'pending',
                rawInput: event.args ?? event.input ?? {}
            });
            return;
        }
        if (event.type === 'tool_call_end' || event.type === 'tool_result') {
            const toolCallId = String(event.tool_call_id ?? event.id ?? '');
            notify({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: event.success === false ? 'failed' : 'completed',
                content: [{ type: 'content', content: { type: 'text', text: String(event.content ?? event.result ?? '') } }]
            });
            return;
        }
        if (event.type === 'plan' && Array.isArray(event.entries)) {
            for (const entry of event.entries) {
                notify({
                    sessionUpdate: 'plan',
                    entries: [{
                        content: String(entry?.content ?? entry?.title ?? ''),
                        priority: entry?.priority ?? 'medium',
                        status: entry?.status ?? 'pending'
                    }]
                });
            }
        }
    };
}


/**
 * Wraps a merci ChatSession as an ACP agent app.
 *
 * `createSession` gives each ACP id its own merci session, so concurrent
 * prompts on different ids run in parallel and never share a context. A
 * single `session` is shared by every id: its prompts are queued and run one
 * at a time. Either way a prompt's `_meta.merci` context and its `onTurnContext`
 * bridge are scoped to that prompt and restored when it ends.
 *
 * @param {{session?: MerciAcpSession, createSession?: AcpSessionFactory|null, name?: string, version?: string, onTurnContext?: AcpTurnContextHook|null}} arg0
 * @returns {import('@agentclientprotocol/sdk/unstable').AgentApp}
 */
export function createAcpAgent({
    session,
    createSession = null,
    name = 'merci-sdk',
    version = ACP_AGENT_VERSION,
    onTurnContext = null
} = {}) {
    if (typeof createSession !== 'function' && (!session || typeof session.run !== 'function')) {
        throw new ConfigurationError({ message: 'createAcpAgent requires a merci ChatSession (an object exposing run()) or a createSession factory.' });
    }
    const app = agent({ name });

    /** @typedef {{id: string, aborts: Set<AbortController>, parent: string|null, cwd: string, session: Promise<MerciAcpSession>|null, tail: Promise<unknown>}} AcpSessionState */
    /** @type {Map<string, AcpSessionState>} */
    const sessions = new Map();
    /** The queue of the shared session: one run at a time, whichever ACP id asked. */
    const shared = { tail: /** @type {Promise<unknown>} */ (Promise.resolve()) };

    /**
     * The merci session an ACP id drives; a factory failure is not cached, so the next prompt retries it.
     * @param {{state: AcpSessionState}} arg0
     * @returns {Promise<MerciAcpSession>}
     */
    const sessionFor = ({ state }) => {
        if (typeof createSession !== 'function') return Promise.resolve(/** @type {MerciAcpSession} */ (session));
        state.session ??= Promise.resolve(createSession({ sessionId: state.id, cwd: state.cwd, parentSessionId: state.parent }))
            .then((created) => {
                if (!created || typeof created.run !== 'function') {
                    throw new ConfigurationError({ message: 'createAcpAgent: createSession must return a merci ChatSession (an object exposing run()).' });
                }
                return created;
            })
            .catch((err) => { state.session = null; throw err; });
        return state.session;
    };
    /** @type {string} */
    const defaultCwd = process.cwd();

    /**
     * Cancels every in-flight turn of a session and forgets it.
     * `session/delete` and `session/close` share this: dropping the record
     * without aborting left a turn writing into a session nobody owns.
     * @param {string} id
     * @returns {void}
     */
    const dropSession = (id) => {
        const state = sessions.get(id);
        for (const abort of state?.aborts ?? []) abort.abort(new Error('Cancelled by the ACP client.'));
        state?.aborts.clear();
        sessions.delete(id);
    };

    /** The capabilities the connected client announced at initialize. */
    /** @type {{fs?: {readTextFile?: boolean, writeTextFile?: boolean}, terminal?: boolean, elicitation?: {form?: any}|null}} */
    let clientCapabilities = {};

    app.onRequest(methods.agent.initialize, (ctx) => {
        clientCapabilities = /** @type {any} */ (ctx.params?.clientCapabilities ?? {});
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
                // E8: advertised FALSE on purpose. Whether the ids share one session or
                // each gets its own from `createSession`, the agent keeps no transcript,
                // so it cannot replay a conversation on `session/load`. The handler stays (it validates the
                // id and answers) but the capability must not promise a replay the
                // implementation cannot deliver.
                loadSession: false,
                // ACP 1.9.0 lifecycle. The schema treats `{}` as "supported";
                // a boolean would be silently dropped by ZodCatch.
                sessionCapabilities: { list: {}, delete: {}, close: {}, fork: {} }
            },
            agentInfo: { name, version }
        };
    });

    app.onRequest(methods.agent.authenticate, async () => ({}));

    app.onRequest(methods.agent.session.new, (ctx) => {
        const sessionId = `merci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        sessions.set(sessionId, { id: sessionId, aborts: new Set(), parent: null, cwd: String(ctx.params?.cwd ?? defaultCwd), session: null, tail: Promise.resolve() });
        return { sessionId };
    });

    app.onRequest(methods.agent.session.load, (ctx) => {
        const requested = String(ctx.params?.sessionId ?? '');
        if (!sessions.has(requested)) {
            throw RequestError.invalidParams({ sessionId: requested }, 'Unknown ACP session.');
        }
    });

    app.onRequest(methods.agent.session.list, () => ({
        sessions: [...sessions.values()].map((s) => ({ sessionId: s.id, cwd: s.cwd }))
    }));

    app.onRequest(methods.agent.session.delete, (ctx) => {
        dropSession(String(ctx.params?.sessionId ?? ''));
        return {};
    });

    app.onRequest(methods.agent.session.close, (ctx) => {
        dropSession(String(ctx.params?.sessionId ?? ''));
        return {};
    });

    app.onRequest(methods.agent.session.fork, async (ctx) => {
        const requested = String(ctx.params?.sessionId ?? '');
        const source = sessions.get(requested);
        if (!source) {
            throw RequestError.invalidParams({ sessionId: requested }, 'Unknown ACP session.');
        }
        const sessionId = `merci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        /** @type {AcpSessionState} */
        const state = { id: sessionId, aborts: new Set(), parent: source.id, cwd: source.cwd, session: null, tail: Promise.resolve() };
        sessions.set(sessionId, state);
        // A branch is the parent as of the fork, not as of the branch's first prompt.
        if (typeof createSession === 'function') await sessionFor({ state });
        return { sessionId };
    });

    app.onNotification(methods.agent.session.cancel, (ctx) => {
        const requested = String(ctx.params?.sessionId ?? '');
        const state = sessions.get(requested);
        // Every turn of the id: the running one and any still queued behind it.
        for (const abort of state?.aborts ?? []) abort.abort(new Error('Cancelled by the ACP client.'));
        state?.aborts.clear();
    });

    app.onRequest(methods.agent.session.prompt, async (ctx) => {
        const requested = String(ctx.params?.sessionId ?? '');
        const state = sessions.get(requested);
        if (!state) {
            throw RequestError.invalidParams({ sessionId: requested }, 'Unknown ACP session.');
        }
        const messageId = `msg-${requested}`;
        // ACP's extension slot is `_meta`: the SDK strips any other unknown field, so a
        // top-level `_merci` only survives a hand-rolled transport (kept as the fallback).
        const params = /** @type {any} */ (ctx.params);
        const env = params?._meta?.merci ?? params?._merci;
        let incoming;
        try {
            incoming = contextFromMerciEnvelope({ env });
        } catch (err) {
            throw RequestError.invalidParams({ _merci: env }, /** @type {any} */ ((/** @type {any} */ (err)).message));
        }

        const toolCallIds = new Map();
        const emit = createUpdateEmitter({ ctx, sessionId: requested, messageId, toolCallIds });
        // The controller exists before the turn is queued, so a cancel reaches a waiting prompt too.
        const abort = new AbortController();
        state.aborts.add(abort);
        const onExternalAbort = () => abort.abort(ctx.signal?.reason ?? new Error('Aborted'));
        if (ctx.signal) {
            if (ctx.signal.aborted) onExternalAbort();
            else ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        const turn = async () => {
            if (abort.signal.aborted) return { stopReason: ACP_STOP_REASONS.CANCELLED };
            /** @type {MerciAcpSession} */
            let target;
            try {
                target = await sessionFor({ state });
            } catch (err) {
                if (abort.signal.aborted) return { stopReason: ACP_STOP_REASONS.CANCELLED };
                throw err;
            }
            // A cancel that landed while the factory ran.
            if (abort.signal.aborted) return { stopReason: ACP_STOP_REASONS.CANCELLED };
            const previousContext = target._agentContext;
            if (incoming) target._agentContext = incoming;
            /** @type {void|(() => void)} */
            let cleanup = undefined;
            try {
                cleanup = onTurnContext ? onTurnContext(clientBridge({ ctx, sessionId: requested })) : undefined;
                const answer = await target.run({ initialInput: promptText({ blocks: ctx.params.prompt }), options: {
                    signal: abort.signal,
                    onEvent:
                        /** @param {any} e */
                        (e) => { emit(e); }
                } });
                // A fallback sentinel is not an answer: fail the prompt request
                // instead of reporting a successful end_turn.
                const kind = fallbackKind({ text: typeof answer === 'string' ? answer : '' });
                if (kind !== null) throw new Error(`The model produced no usable answer (${kind} fallback).`);
                return { stopReason: ACP_STOP_REASONS.END_TURN };
            } catch (err) {
                if (abort.signal.aborted) return { stopReason: ACP_STOP_REASONS.CANCELLED };
                throw err;
            } finally {
                if (incoming) target._agentContext = previousContext;
                if (typeof cleanup === 'function') cleanup();
            }
        };

        // One run at a time per merci session: its own lane with a factory, the shared lane without.
        const lane = typeof createSession === 'function' ? state : shared;
        const result = lane.tail.then(turn);
        lane.tail = result.catch(() => {});
        try {
            return await result;
        } finally {
            state.aborts.delete(abort);
            if (ctx.signal) ctx.signal.removeEventListener('abort', onExternalAbort);
        }
    });

    // ── The client side of ACP ─────────────────────────────────────────────
    // The client context only exists for the duration of a request, so the
    // agent hands the caller the client-side methods it can call: permission
    // requests, elicitation and the editor's filesystem. A caller wires them
    // into its own tool layer (for example a shell tool's approval callback).

    /**
     * @param {{ctx: any, sessionId: string}} arg0
     * @returns {AcpClientBridge}
     */
    const clientBridge = ({ ctx, sessionId }) => {
        /**
         * @param {any} opts
         * @returns {Promise<any>}
         */
        const requestPermission = async (opts) => ctx.client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: opts?.toolCall ?? { toolCallId: `call_${Date.now().toString(36)}`, title: 'tool', kind: 'other', status: 'pending', rawInput: opts?.input ?? {} },
            options: opts?.options ?? []
        });
        /**
         * @param {any} opts
         * @returns {Promise<any>}
         */
        const elicit = async (opts) => {
            // A capability the client never announced is never called.
            if (!clientCapabilities?.elicitation?.form) {
                throw new Error('The connected ACP client does not offer elicitation/form.');
            }
            return ctx.client.request(methods.client.elicitation.create, {
                // ACP v1.9: an elicitation is a FORM-mode request tied to a
                // scope. Without `mode` and the session scope a strict client
                // rejects the params (-32602) and the editor never sees the
                // question.
                mode: 'form',
                sessionId,
                message: opts?.message ?? '',
                requestedSchema: opts?.schema ?? { type: 'object', properties: {} }
            });
        };
        /**
         * A capability the client did not announce is never called.
         * @param {any} opts
         * @returns {Promise<any>}
         */
        const readFile = async (opts) => {
            if (!clientCapabilities?.fs?.readTextFile) {
                throw new Error('The connected ACP client does not offer fs/read_text_file.');
            }
            return ctx.client.request(methods.client.fs.readTextFile, opts);
        };
        /**
         * @param {any} opts
         * @returns {Promise<any>}
         */
        const writeFile = async (opts) => {
            if (!clientCapabilities?.fs?.writeTextFile) {
                throw new Error('The connected ACP client does not offer fs/write_text_file.');
            }
            return ctx.client.request(methods.client.fs.writeTextFile, opts);
        };
        /**
         * The editor's terminal. ACP's `terminal/*` is a client-side capability:
         * the agent asks the editor to run the command, then polls/kills/releases
         * the handle. Every method refuses when the client did not announce
         * `terminal: true` — an unadvertised capability is never called.
         * @param {{method: string, params: Record<string, any>}} arg0
         * @returns {Promise<any>}
         */
        const terminalRequest = async ({ method, params }) => {
            if (!clientCapabilities?.terminal) {
                throw new Error(`The connected ACP client does not offer ${method}.`);
            }
            return ctx.client.request(method, params);
        };
        /**
         * @param {{command: string, args?: string[], env?: Array<{name: string, value: string}>, cwd?: string|null, outputByteLimit?: number|null}} opts
         * @returns {Promise<any>} `{ terminalId }`
         */
        const createTerminal = async (opts) => terminalRequest({ method: methods.client.terminal.create, params: {
            sessionId,
            command: opts?.command,
            args: opts?.args ?? [],
            ...(opts?.env ? { env: opts.env } : {}),
            ...(opts?.cwd != null ? { cwd: opts.cwd } : {}),
            ...(opts?.outputByteLimit != null ? { outputByteLimit: opts.outputByteLimit } : {}),
        } });
        /**
         * @param {{terminalId: string}} opts
         * @returns {Promise<any>} `{ output, truncated, exitStatus? }`
         */
        const terminalOutput = async (opts) => terminalRequest({ method: methods.client.terminal.output, params: { sessionId, terminalId: opts?.terminalId } });
        /**
         * @param {{terminalId: string}} opts
         * @returns {Promise<any>} `{ exitCode?, signal? }`
         */
        const waitForTerminalExit = async (opts) => terminalRequest({ method: methods.client.terminal.waitForExit, params: { sessionId, terminalId: opts?.terminalId } });
        /**
         * @param {{terminalId: string}} opts
         * @returns {Promise<any>}
         */
        const killTerminal = async (opts) => terminalRequest({ method: methods.client.terminal.kill, params: { sessionId, terminalId: opts?.terminalId } });
        /**
         * @param {{terminalId: string}} opts
         * @returns {Promise<any>}
         */
        const releaseTerminal = async (opts) => terminalRequest({ method: methods.client.terminal.release, params: { sessionId, terminalId: opts?.terminalId } });
        return { sessionId, client: ctx.client, requestPermission, elicit, readFile, writeFile, createTerminal, terminalOutput, waitForTerminalExit, killTerminal, releaseTerminal };
    };

    return app;
}
